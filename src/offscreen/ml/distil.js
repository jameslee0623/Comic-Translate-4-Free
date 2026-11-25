// Distil OCR (test) via the int8 ONNX export in
// muscgab/manga-ocr-nar-small-distil (weights CC BY-NC-SA 4.0,
// https://huggingface.co/muscgab/manga-ocr-nar-small-distil).
//
// Japanese-only, non-autoregressive: one cropped text box in, the whole
// text out in a single forward pass (65 token ids). That is why it should
// be faster than Baberu on the phone — Baberu decodes one character at a
// time (up to 256 steps), this does one pass. 29.8M params, int8, ~30MB.
// Accuracy is a little lower than the full model (Read v1.3 EM 88.83% vs
// 91.09%), and a box holds at most 65 characters — longer text is
// truncated, so the caller falls back to Baberu for those boxes.
//
// Faithful port of the repo's preprocess.py + backends/onnx.py, verified
// against them in Python on 2026-11-25 (4 rendered Japanese sentences
// read back exactly):
//
//   crop -> resize with aspect kept (PIL bicubic) to fit a grid of at
//           most 324 patches of 14x14 px
//        -> place at the top-left of the grid canvas, the rest filled
//           with the median colour of the resized image's border
//        -> (x/255 - mean) / std, CLIP mean/std, cut into 14x14 patches
//        -> P [n, 588] float32, R/C [n] int32 (patch row/col),
//           H/W [1] int32 (grid size); only the n valid patches are fed
//           (the distil graph has no V valid-mask input)
//        -> output ids [65] int32 -> decode, cut at EOS (id 6817)
import { resizeBicubicRGBA } from './baberu.js';

export const DISTIL_BUDGET = 324;
export const DISTIL_PATCH = 14;
export const DISTIL_FEAT = 588; // 14 * 14 * 3
export const DISTIL_MAX_CHARS = 65;
export const DISTIL_EOS = 6817;

const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];

// Largest uniform scale s with ceil(H*s/14) * ceil(W*s/14) <= 324.
// Binary search, 60 iterations, exactly as the reference pad_grid.
function padGrid(height, width) {
  let lo = 1e-4, hi = 1000.0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (Math.ceil(height * mid / DISTIL_PATCH) * Math.ceil(width * mid / DISTIL_PATCH) <= DISTIL_BUDGET) lo = mid;
    else hi = mid;
  }
  return { s: lo, gh: Math.ceil(height * lo / DISTIL_PATCH), gw: Math.ceil(width * lo / DISTIL_PATCH) };
}

function resizedSize(height, width) {
  const { s, gh, gw } = padGrid(height, width);
  const rw = Math.max(1, Math.min(gw * DISTIL_PATCH, Math.round(width * s)));
  const rh = Math.max(1, Math.min(gh * DISTIL_PATCH, Math.round(height * s)));
  return { gh, gw, rw, rh };
}

// Median of a numeric array (numpy median: for an even count, the mean
// of the two middle values). The reference casts the result to uint8,
// which truncates — same as Math.floor for these non-negative values.
function median(values) {
  const a = Array.from(values).sort((x, y) => x - y);
  const n = a.length;
  if (!n) return 0;
  const mid = Math.floor(n / 2);
  const m = n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  return Math.floor(m);
}

// Build the model inputs for one crop. rgba is Uint8ClampedArray (w*h*4).
// Returns { P: Float32Array(n*588), R: Int32Array(n), C: Int32Array(n),
// H: Int32Array([gh]), W: Int32Array([gw]), n }.
// Exported for the Node-side port check (compares these tensors against
// the Python reference on the same crop).
export function preprocess(rgba, w, h) {
  const { gh, gw, rw, rh } = resizedSize(h, w);
  // Bicubic resize (Catmull-Rom, like PIL BICUBIC) to rw x rh, then round
  // to uint8 exactly as PIL does.
  const smallF = resizeBicubicRGBA(rgba, w, h, rw, rh);
  const small = new Uint8Array(rw * rh * 3);
  for (let i = 0; i < rw * rh; i++) {
    for (let c = 0; c < 3; c++) {
      const v = Math.round(smallF[i * 4 + c]);
      small[i * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  // Median colour of the resized image's border (top row, bottom row,
  // left column, right column), per channel.
  const borderR = [], borderG = [], borderB = [];
  for (let x = 0; x < rw; x++) {
    borderR.push(small[x * 3], small[(rh - 1) * rw * 3 + x * 3]);
    borderG.push(small[x * 3 + 1], small[(rh - 1) * rw * 3 + x * 3 + 1]);
    borderB.push(small[x * 3 + 2], small[(rh - 1) * rw * 3 + x * 3 + 2]);
  }
  for (let y = 0; y < rh; y++) {
    borderR.push(small[y * rw * 3], small[y * rw * 3 + (rw - 1) * 3]);
    borderG.push(small[y * rw * 3 + 1], small[y * rw * 3 + (rw - 1) * 3 + 1]);
    borderB.push(small[y * rw * 3 + 2], small[y * rw * 3 + (rw - 1) * 3 + 2]);
  }
  const fill = [median(borderR), median(borderG), median(borderB)];
  // Canvas (gh*14 x gw*14), filled with the median colour, resized image
  // at the top-left, normalised with the CLIP mean/std.
  const cw = gw * DISTIL_PATCH, ch = gh * DISTIL_PATCH;
  const canvas = new Float32Array(cw * ch * 3);
  for (let c = 0; c < 3; c++) {
    const fv = (fill[c] / 255 - MEAN[c]) / STD[c];
    for (let i = 0; i < cw * ch; i++) canvas[i * 3 + c] = fv;
  }
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      for (let c = 0; c < 3; c++) {
        canvas[(y * cw + x) * 3 + c] = (small[(y * rw + x) * 3 + c] / 255 - MEAN[c]) / STD[c];
      }
    }
  }
  // Cut into 14x14 patches. Within a patch the 588 floats are channel
  // first (R 14x14, then G, then B), matching the reference reshape +
  // transpose. Patches are row-major by grid position.
  const n = gh * gw;
  const P = new Float32Array(n * DISTIL_FEAT);
  const R = new Int32Array(n);
  const C = new Int32Array(n);
  for (let pr = 0; pr < gh; pr++) {
    for (let pc = 0; pc < gw; pc++) {
      const p = pr * gw + pc;
      R[p] = pr; C[p] = pc;
      for (let c = 0; c < 3; c++) {
        for (let y = 0; y < DISTIL_PATCH; y++) {
          for (let x = 0; x < DISTIL_PATCH; x++) {
            P[p * DISTIL_FEAT + c * 196 + y * DISTIL_PATCH + x] =
              canvas[((pr * DISTIL_PATCH + y) * cw + pc * DISTIL_PATCH + x) * 3 + c];
          }
        }
      }
    }
  }
  return { P, R, C, H: new Int32Array([gh]), W: new Int32Array([gw]), n };
}

export class DistilOCR {
  constructor() {
    this.sess = null;
    this.chars = null;
  }

  get loaded() { return !!this.sess; }

  async reset() {
    try { await this.sess?.release?.(); } catch {}
    this.sess = null;
  }

  async load(onnxBytes, executionProviders = ['wasm']) {
    if (this.sess) return;
    const u8 = onnxBytes instanceof Uint8Array ? onnxBytes : new Uint8Array(onnxBytes);
    this.sess = await ort.InferenceSession.create(u8, { executionProviders });
  }

  setVocab(vocabJson) {
    const parsed = JSON.parse(vocabJson);
    this.chars = parsed.characters || parsed;
  }

  decode(ids) {
    let text = '';
    let truncated = true;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (id === DISTIL_EOS) { truncated = false; break; }
      if (id >= 0 && id < DISTIL_EOS) text += this.chars[id];
    }
    return { text, truncated };
  }

  // One crop -> { text, truncated }. truncated means no EOS in the 65
  // ids, so the text may be cut off at 65 chars — the caller falls back
  // to Baberu for the full text.
  async ocr(rgba, w, h, opts = {}) {
    if (!this.sess) throw new Error('distil OCR session not loaded');
    if (!this.chars) throw new Error('distil vocab not set');
    const { P, R, C, H, W, n } = preprocess(rgba, w, h);
    const feeds = {
      P: new ort.Tensor('float32', P, [n, DISTIL_FEAT]),
      R: new ort.Tensor('int32', R, [n]),
      C: new ort.Tensor('int32', C, [n]),
      H: new ort.Tensor('int32', H, [1]),
      W: new ort.Tensor('int32', W, [1]),
    };
    if (opts.shouldAbort && opts.shouldAbort()) throw new Error('cancelled');
    const out = await this.sess.run(feeds);
    const ids = out.ids ? out.ids.data : out[Object.keys(out)[0]].data;
    return this.decode(ids);
  }
}
