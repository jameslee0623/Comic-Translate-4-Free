// Model inventory: exact HuggingFace artifacts (verified 2026-09-27).
// Downloaded on first use into IndexedDB ('ct-db'/'models'), never bundled.
import { openDb, idbGet, idbPut, idbDel, idbKeys, MSG } from './contracts.js';

const hf = (repo, file) => `https://huggingface.co/${repo}/resolve/main/${file}`;

export const MODEL_GROUPS = [
  {
    id: 'detector', labelKey: 'model_detector', label: 'Text detector', required: true,
    files: [
      { id: 'detector', file: 'detector-v4-s_int8.onnx', bytes: 11120765,
        url: hf('ogkalu/comic-text-and-bubble-detector', 'detector-v4-s_int8.onnx') },
    ],
  },
  {
    id: 'inpaint', labelKey: 'model_inpaint', label: 'Manga inpainter', required: true,
    files: [
      { id: 'inpaint', file: 'lama-manga-dynamic.onnx', bytes: 206291843,
        url: hf('ogkalu/lama-manga-onnx-dynamic', 'lama-manga-dynamic.onnx') },
    ],
  },
  {
    id: 'ocr-baberu', labelKey: 'model_baberu', label: 'OCR (manga-trained)',
    files: [
      // v1.2 (2026-10-26): retrained with Manga109-s human labels (sound
      // effects 50%->74%, handwriting 60%->67%). All three files change,
      // but sizes are IDENTICAL to v1.1 (quantization fixes them) — so the
      // IDs bump (-v12): the downloader skips files whose cached size
      // matches, and same IDs would silently keep v1.1 weights.
      { id: 'ocr-baberu-vision-v12', file: 'vision_int4.onnx', bytes: 52293486,
        url: hf('genshiai-daichi/baberu-ocr', 'onnx/vision_int4.onnx') },
      { id: 'ocr-baberu-prefill-v12', file: 'decoder_prefill_int8.onnx', bytes: 35133596,
        url: hf('genshiai-daichi/baberu-ocr', 'onnx/decoder_prefill_int8.onnx') },
      { id: 'ocr-baberu-step-v12', file: 'decoder_step_int8.onnx', bytes: 34715466,
        url: hf('genshiai-daichi/baberu-ocr', 'onnx/decoder_step_int8.onnx') },
    ],
  },
  {
    // Distil OCR test (2026-11-25): manga-ocr-nar-small-distil, Japanese
    // only, one forward pass per box (non-autoregressive) — the phone
    // speed test against Baberu. u8s8 is the ARM + x86-with-VNNI int8
    // encoding (phones are ARM, so this is the right one for the test;
    // x86 without VNNI would want u8u8). Optional, like Baberu: only
    // downloaded when the user enables the distil test.
    id: 'ocr-distil', labelKey: 'model_distil', label: 'OCR distil (Japanese test)',
    files: [
      { id: 'ocr-distil-u8s8', file: 'manga_ocr_nar_small_distil_int8_u8s8.onnx', bytes: 31397540,
        url: hf('muscgab/manga-ocr-nar-small-distil', 'onnx/manga_ocr_nar_small_distil_int8_u8s8.onnx') },
    ],
  },
];

// OCR engine routing by source language (LANGS in shared/settings.js):
//   ja/en/zh-CN/zh-TW -> Baberu ('ocr-baberu' group; manga-trained)
// (manga-ocr removed 2026-09-29: superseded by Baberu for Japanese.
// Pororo + PP-OCRv5 en/chinese models removed 2026-09-28: superseded.
// PP-OCRv6 small removed 2026-09-29: Baberu covers Traditional Chinese.
// PP-OCRv5 Korean removed 2026-09-29: OCR quality too low for translation.)
export function ocrEngineForLang(lang) {
  return 'ocr-baberu'; // all source languages use Baberu
}

// Baberu character vocab, bundled (JSON array; id>=4 -> charset[id-4]).
// From genshiai-daichi/baberu-ocr tokenizer/vocab.json.
export const BABERU_VOCAB_ASSET = 'src/offscreen/ml/dicts/baberu-vocab.json';

// Distil character vocab, bundled (JSON {characters: [...]}; id 6817 is
// end of text). From muscgab/manga-ocr-nar-small-distil
// nar_vocabulary_6817.json.
export const DISTIL_VOCAB_ASSET = 'src/offscreen/ml/dicts/distil-vocab.json';

export const ALL_FILES = MODEL_GROUPS.flatMap(g =>
  g.files.map(f => ({ ...f, group: g.id, groupLabel: g.label })));

export async function getModelStatus() {
  const db = await openDb();
  const keys = await idbKeys(db).catch(() => []);
  const chunkCount = (fileId) => {
    let n = 0;
    for (const k of keys) {
      if (typeof k === 'string' && k.startsWith(fileId + '#')) n++;
    }
    return n;
  };
  const out = [];
  for (const g of MODEL_GROUPS) {
    const files = [];
    let done = true, sizeMismatch = false;
    for (const f of g.files) {
      const rec = await idbGet(db, f.id);
      // 2.2.12: "downloaded" requires the chunks to actually be present —
      // a manifest with correct bytes but missing chunks is an orphaned
      // manifest, not a usable model. Without this the UI shows "✓
      // downloaded" for a model that fails at run time.
      let downloaded = false;
      const bytesOk = !!rec && rec.bytes === f.bytes;
      if (rec && bytesOk) {
        if (rec.data) downloaded = true;
        else if (typeof rec.chunks === 'number') downloaded = chunkCount(f.id) >= rec.chunks;
        else downloaded = false;
      }
      files.push({
        id: f.id, file: f.file, bytes: rec ? rec.bytes : 0,
        expectedBytes: f.bytes, downloaded, bytesOk,
      });
      if (!downloaded) { done = false; continue; }
      if (!bytesOk) { done = false; sizeMismatch = true; }
    }
    out.push({ id: g.id, label: g.label, labelKey: g.labelKey, required: !!g.required, downloaded: done, sizeMismatch, files });
  }
  return out;
}

// Download state for auto-download (2.2.2): per-file progress, including
// in-progress files whose manifest is not written yet. A file with chunk
// records but no manifest is mid-download; loaded is estimated from the
// 8MB chunk count, capped at the expected size. A manifest with the wrong
// byte count is stale (a newer file version), not done — it needs a full
// re-download, so loaded is 0 for it.
// 2.2.12: totalBytes/loadedBytes cover ALL files, not just the missing
// ones — the old missing-only sums made the pill percent go BACKWARDS
// each time a file completed (a finished file dropped out of both sums).
// 2.2.12: a manifest claiming "done" is only trusted when its chunks are
// actually present — an orphaned manifest (correct bytes, missing chunks)
// is treated as not done so it re-downloads instead of failing at run
// time with "missing chunk".
export async function getModelDownloadState() {
  const db = await openDb();
  const keys = await idbKeys(db).catch(() => []);
  const chunkCount = (fileId) => {
    let n = 0;
    for (const k of keys) {
      if (typeof k === 'string' && k.startsWith(fileId + '#')) n++;
    }
    return n;
  };
  const files = [];
  for (const f of ALL_FILES) {
    const rec = await idbGet(db, f.id).catch(() => null);
    let done = false, loaded = 0, started = false;
    if (rec && rec.bytes === f.bytes) {
      if (rec.data) {
        done = true; // legacy single-record format: the data is the file
        loaded = f.bytes;
      } else if (typeof rec.chunks === 'number') {
        // Chunked format: trust "done" only when every chunk is present.
        if (chunkCount(f.id) >= rec.chunks) {
          done = true;
          loaded = f.bytes;
        } else {
          started = true;
          loaded = Math.min(chunkCount(f.id) * IDB_CHUNK, f.bytes);
        }
      } else {
        // Manifest with no chunk count and no data: cannot verify — re-download.
        started = true;
      }
    } else {
      const n = chunkCount(f.id);
      if (n > 0) {
        started = true;
        loaded = Math.min(n * IDB_CHUNK, f.bytes);
      }
    }
    files.push({ id: f.id, group: f.group, file: f.file, bytes: f.bytes, loaded, done, started });
  }
  const missing = files.filter(f => !f.done);
  return {
    files,
    missing,
    totalBytes: files.reduce((a, f) => a + f.bytes, 0),
    loadedBytes: files.reduce((a, f) => a + f.loaded, 0),
  };
}

export async function deleteModelGroup(groupId) {
  const db = await openDb();
  const g = MODEL_GROUPS.find(x => x.id === groupId);
  if (!g) return;
  for (const f of g.files) {
    // 2.2.12: delete chunks by key prefix even when there is no manifest
    // (a mid-download file has chunks but no manifest — the old code left
    // them behind forever).
    await deleteChunksByPrefix(db, f.id);
    await idbDel(db, f.id);
  }
}

// One-time cleanup for model files whose groups were removed from
// MODEL_GROUPS (Latin/Russian PP-OCRv5, 2026-09-28; Pororo + PP-OCRv5
// en/chinese, superseded 2026-09-28; manga-ocr encoder/decoder, superseded
// 2026-09-29 by Baberu): with no group row left in the UI
// there'd be no way to delete them otherwise.
// Baberu v1.0 decoders (2026-10-06): superseded by v1.1 (-v11 IDs); pruned
// before the v1.1 download so users don't carry ~70MB of stale weights.
// Baberu v1.1 files (2026-10-26): superseded by v1.2 (-v12 IDs); pruned
// before the v1.2 download so users don't carry ~122MB of stale weights.
const PRUNED_MODEL_IDS = ['ocr-ppocr-latin', 'ocr-ppocr-eslav', 'ocr-pororo', 'ocr-ppocr-en', 'ocr-ppocr-chinese', 'ocr-ppocrv6', 'ocr-ppocr-ko', 'ocr-encoder', 'ocr-decoder-init', 'ocr-decoder-step', 'ocr-baberu-prefill', 'ocr-baberu-step', 'ocr-baberu-vision', 'ocr-baberu-prefill-v11', 'ocr-baberu-step-v11'];
export { PRUNED_MODEL_IDS };
// Fingerprint of the model list (group + file IDs + expected sizes).
// URLs are excluded on purpose: a URL-only change needs no re-download
// (the downloader skips on matching size), while an ID or size change
// means a new or changed file must be downloaded. Used by the SW's
// onInstalled handler to lead the user to the models section only when
// an update actually makes a download necessary.
export function computeModelFingerprint() {
  return JSON.stringify(MODEL_GROUPS.map(g => [g.id, g.files.map(f => [f.id, f.file, f.bytes])]));
}
export async function pruneModelIds(ids) {
  const db = await openDb();
  for (const id of ids) {
    try {
      // 2.2.12: delete the chunks by key prefix even when there is no
      // manifest — a mid-download file has chunk records but no manifest
      // (it is written last), and the old `if (!rec) continue` deleted
      // zero chunks, so the stall "prune and restart" was a no-op.
      await deleteChunksByPrefix(db, id);
      await idbDel(db, id);
    } catch { /* best effort */ }
  }
}

// ---- chunked model storage ----
// A model file is stored as N fixed-size IDB records plus a small manifest:
//   { id: fileId, bytes, chunks, downloadedAt }   <- manifest (written last)
//   { id: `${fileId}#${i}`, data: ArrayBuffer }    <- chunk i (8 MB each)
// A single IDB value as large as a model file (200+ MB) fails: the put
// throws UnknownError in a page and kills an offscreen document outright.
// Single-record files written by older builds ({ id, data, bytes }) are
// still read and deleted, so already-downloaded models keep working.
const IDB_CHUNK = 8 * 1024 * 1024;
const chunkKey = (fileId, i) => `${fileId}#${i}`;

async function deleteChunks(db, fileId, n) {
  for (let i = 0; i < n; i++) {
    try { await idbDel(db, chunkKey(fileId, i)); } catch { /* already gone */ }
  }
}

// Delete every chunk record for a file by key prefix, whether or not a
// manifest exists. Used by prune/delete so a mid-download file (chunks
// but no manifest) is actually cleaned up.
async function deleteChunksByPrefix(db, fileId) {
  let keys = [];
  try { keys = await idbKeys(db); } catch { /* best effort */ }
  const prefix = fileId + '#';
  for (const k of keys) {
    if (typeof k === 'string' && k.startsWith(prefix)) {
      try { await idbDel(db, k); } catch { /* already gone */ }
    }
  }
}

export async function readChunked(db, fileId, manifest) {
  const buf = new Uint8Array(manifest.bytes);
  let off = 0;
  for (let i = 0; i < manifest.chunks; i++) {
    const rec = await idbGet(db, chunkKey(fileId, i));
    if (!rec || !rec.data) {
      throw new Error(`model "${fileId}" is missing chunk ${i} of ${manifest.chunks} — delete it in the popup and download again`);
    }
    const u8 = new Uint8Array(rec.data);
    buf.set(u8, off);
    off += u8.length;
  }
  if (off !== manifest.bytes) {
    throw new Error(`model "${fileId}" reassembled to ${off} bytes but should be ${manifest.bytes} — delete it in the popup and download again`);
  }
  return buf.buffer;
}

// ---- download retry / resume helpers (audit 3c, 2026-11-26) ----
// Hugging Face behaviour proven live in the audit: the resolver answers
// 302 to a signed CloudFront URL; the CDN serves 200
// application/octet-stream with Accept-Ranges: bytes and honours Range
// with 206 + Content-Range; RateLimit-Policy says 3000 req / 5 min on
// the resolver; error bodies are plain text; the file SHA-256 is exposed
// as X-Linked-ETag. No Retry-After was observed on any response, so the
// 3-minute minimum wait below is UNVERIFIED — it is a deliberate floor,
// not a measured server value; do not tune it from testing alone.

const DOWNLOAD_MAX_ATTEMPTS = 3; // attempts per file per call, then give up
// Minimum wait before retrying a 429/5xx when the server sends neither
// Retry-After nor a RateLimit reset. UNVERIFIED (see above): HF never
// sent Retry-After in the audit, so this floor is a guess that a rate
// limit needs minutes, not seconds, to clear — not a server fact.
const DOWNLOAD_MIN_RATE_WAIT_MS = 3 * 60 * 1000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Wait before retrying a 429/5xx, in ms, from the response headers:
// Retry-After first (seconds, or an HTTP-date), else the RateLimit
// reset (the `t=` / `reset=` seconds until the window resets), else the
// 3-minute floor. Exported so the retry timing is unit-testable.
export function parseRetryWaitMs(headers) {
  const retryAfter = headers && headers.get && headers.get('retry-after');
  if (retryAfter != null) {
    const s = String(retryAfter).trim();
    if (/^\d+$/.test(s)) return Number(s) * 1000;
    const when = Date.parse(s);
    if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  }
  const rateLimit = headers && headers.get && headers.get('ratelimit');
  if (rateLimit != null) {
    const m = String(rateLimit).match(/(?:^|[,\s])t=(\d+)/) ||
      String(rateLimit).match(/(?:^|[,\s])reset=(\d+)/);
    if (m) return Number(m[1]) * 1000;
  }
  return DOWNLOAD_MIN_RATE_WAIT_MS;
}

// Log the HF rate-limit headers when present. There is no diagnostic-log
// path reachable from this shared module (diagPush is owned by the SW;
// the offscreen doc reaches it only via bench messages), so the values
// go to the context console and, on a 429, into the thrown error —
// that is what lands in Settings via the offscreen error broadcast.
function logRateLimit(fileId, headers) {
  try {
    const rl = headers && headers.get && headers.get('ratelimit');
    const policy = headers && headers.get && headers.get('ratelimit-policy');
    if (rl != null || policy != null) {
      console.warn(`[ct-dl] ${fileId} rate-limit: RateLimit=${rl == null ? '(absent)' : rl} RateLimit-Policy=${policy == null ? '(absent)' : policy}`);
    }
  } catch { /* logging must never break a download */ }
}

// How many contiguous chunk records (0..n-1) exist for a file, and how
// many bytes they hold. Chunk records are written in order and each IDB
// put is atomic, so the records form a trustworthy byte prefix — except
// the LAST one, whose completeness cannot be verified without a hash
// (see the resume rule in downloadFileToIdb). lastBytes is that last
// chunk's size, so the caller can discard it.
async function contiguousChunks(db, fileId) {
  let count = 0, bytes = 0, lastBytes = 0;
  for (;;) {
    if (count > 4096) break; // safety bound, not a real limit (~26 max)
    const rec = await idbGet(db, chunkKey(fileId, count)).catch(() => null);
    if (!rec || !rec.data) break;
    lastBytes = rec.data.byteLength;
    bytes += lastBytes;
    count++;
  }
  return { count, bytes, lastBytes };
}

// Verify reassembled bytes against the X-Linked-ETag SHA-256 from the
// download response. Returns true (match), false (mismatch), or null
// (no usable hash — header absent/malformed, or crypto.subtle missing —
// so the caller proceeds with the size check only). The reassembly holds
// the whole file in memory once (up to 206 MB); model loading already
// does exactly that in readChunked, so this adds no new allocation shape.
async function verifyFileHash(db, fileId, chunkCount, totalBytes, etag) {
  const clean = String(etag == null ? '' : etag).replace(/["\s]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    try { console.warn(`[ct-dl] ${fileId}: X-Linked-ETag absent or not a SHA-256 (${String(etag).slice(0, 40)}), skipping integrity check (size check only)`); } catch {}
    return null;
  }
  if (typeof crypto === 'undefined' || !crypto.subtle || !crypto.subtle.digest) {
    try { console.warn(`[ct-dl] ${fileId}: crypto.subtle unavailable, skipping integrity check (size check only)`); } catch {}
    return null;
  }
  const buf = await readChunked(db, fileId, { bytes: totalBytes, chunks: chunkCount });
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === clean;
}

// Download one file with progress. Runs in the offscreen document (a service
// worker can be killed mid-download); progress is broadcast to the UI.
// Bytes stream straight into 8 MB IDB chunks — the file is never held whole
// in memory and no single IDB value is large. The byte size is verified
// against the spec — a truncated or wrong file is rejected instead of being
// cached silently.
//
// Audit 3c (2026-11-26): resume + per-status retries. A failed download
// KEEPS its chunks and the next attempt resumes with
// `Range: bytes=<loaded>-`, expecting 206 + Content-Range; a 200 answer
// to a Range request means the server ignored Range, so the partial is
// discarded and the file restarts from 0. Up to 3 attempts per file per
// call. Permanent errors (401/403/404, Content-Length/Content-Type
// mismatch) throw at once; 429/5xx wait out Retry-After / the RateLimit
// reset (3-minute floor when neither is sent) before retrying. A present
// X-Linked-ETag is verified against the reassembled bytes before the
// manifest is written. The SW-level unbounded retries are NOT touched
// here — they are a follow-up (see the audit fix report).
export async function downloadFileToIdb(fileId, url, onProgress) {
  const spec = ALL_FILES.find(f => f.id === fileId);
  const db = await openDb();
  // Already cached (either storage format) with the right size? Skip —
  // but only when the chunks are actually present. An orphaned manifest
  // (correct bytes, missing chunks) must NOT short-circuit: it would
  // report success while the model still fails at load time (2.2.12).
  const existing = await idbGet(db, fileId);
  if (existing && spec && spec.bytes && existing.bytes === spec.bytes) {
    let intact = true;
    if (existing.data) {
      intact = true; // legacy single-record: the data is the file
    } else if (typeof existing.chunks === 'number') {
      const keys = await idbKeys(db).catch(() => []);
      let n = 0;
      for (const k of keys) {
        if (typeof k === 'string' && k.startsWith(fileId + '#')) n++;
      }
      intact = n >= existing.chunks;
    } else {
      intact = false; // manifest with no chunk count and no data: unverifiable
    }
    if (intact) return existing.bytes;
    // Orphaned manifest for the SAME file version: fall through and
    // resume from the chunks that are present (kept, not deleted).
  } else if (existing) {
    // Stale or wrong-version records: the file changed, so the old
    // chunks belong to another version — clear before writing.
    if (existing.chunks) await deleteChunks(db, fileId, existing.chunks);
    await deleteChunksByPrefix(db, fileId);
    await idbDel(db, fileId);
  }
  // 2.2.12: fetch with an inactivity timeout. A server that accepts the
  // connection but never sends data (or stalls mid-stream) used to hang
  // the download forever — the 90s callMl timeout only rejects the
  // service-worker side while the host-side fetch keeps running. Abort
  // after 60s with no bytes received; a slow-but-progressing download
  // keeps resetting the timer, so it is never cut off for being slow.
  const DOWNLOAD_INACTIVITY_MS = 60000;
  const progressTotal = (spec && spec.bytes) || 0;
  let lastError = null;
  let streamFailures = 0; // consecutive attempts ending in a stream error
  let restartFromZero = false; // set after a 2nd consecutive stream error
  // Bytes of stored chunks already proven complete. Only the LAST chunk
  // is ever unverified (see below), so once it is discarded the rest of
  // the prefix is trusted — and a later attempt in this call that wrote
  // nothing new must NOT discard another chunk, or repeated failures
  // would drain the whole prefix one chunk per attempt. Any path that
  // deletes chunks resets this to 0 (a new generation is unproven).
  let trustedBytes = 0;

  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
    // Resume point: the contiguous chunks already stored. A restart
    // requested by the expired-link path deletes them first.
    if (restartFromZero) {
      await deleteChunksByPrefix(db, fileId);
      await idbDel(db, fileId);
      trustedBytes = 0;
      restartFromZero = false;
    }
    const kept = await contiguousChunks(db, fileId);
    let resumeFrom = kept.bytes;
    let idx = kept.count;
    if (spec && spec.bytes && resumeFrom > spec.bytes) {
      // Stored chunks hold MORE than the file should be: wrong file.
      await deleteChunksByPrefix(db, fileId);
      await idbDel(db, fileId);
      trustedBytes = 0;
      resumeFrom = 0; idx = 0;
    } else if (resumeFrom > 0) {
      // Discard the LAST chunk — but only when the stored prefix grew
      // since the last discard. It is the only chunk whose completeness
      // cannot be proven: the download may have died while it was
      // being written, and a short chunk is indistinguishable from a
      // complete one without a hash. Every earlier chunk is a complete
      // prefix slice (IDB puts are atomic, and a chunk is only followed
      // by another chunk when more data arrived after it was flushed),
      // so resuming after it is safe. Cost: at most one chunk is
      // re-downloaded per generation of the prefix. If the stored
      // prefix SHRANK since the last discard (another path deleted
      // chunks), the old trust is void and the last chunk is discarded
      // again.
      if (kept.bytes < trustedBytes) trustedBytes = 0;
      if (kept.bytes > trustedBytes) {
        await idbDel(db, chunkKey(fileId, idx - 1));
        resumeFrom -= kept.lastBytes;
        idx -= 1;
        trustedBytes = resumeFrom;
      }
    }
    if (resumeFrom > 0) onProgress && onProgress(resumeFrom, progressTotal);
    // Per-attempt controller: a previous attempt may have aborted its own.
    const ctrl = new AbortController();
    let inactivityTimer = null;
    const armInactivity = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        try { ctrl.abort(); } catch { /* already settled */ }
      }, DOWNLOAD_INACTIVITY_MS);
    };
    const stopInactivity = () => {
      if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
    };

    // One attempt may fetch twice: with Range first, and — only if the
    // server answers 200 to the Range request (Range ignored) or a 206
    // whose Content-Range does not match the request — again from byte 0
    // after discarding the partial. That is not a retry, it is the same
    // attempt falling back to a full download.
    let resp = null;
    let etag = null;
    let loaded = resumeFrom;
    let attemptTotal = 0; // Content-Length of this attempt's response
    for (let fetchNo = 0; fetchNo < 2; fetchNo++) {
      const wantRange = resumeFrom > 0 && fetchNo === 0;
      try {
        armInactivity();
        resp = await fetch(url, wantRange
          ? { signal: ctrl.signal, headers: { Range: `bytes=${resumeFrom}-` } }
          : { signal: ctrl.signal });
      } catch (e) {
        stopInactivity();
        if (e && e.name === 'AbortError') {
          lastError = new Error(`download timed out (no data for ${DOWNLOAD_INACTIVITY_MS / 1000}s) for ${fileId}`);
        } else if (e && e.name === 'TypeError') {
          // Network error (DNS, offline, reset, TLS) or CORS rejection:
          // fetch gives no status, so the class is the diagnosis. Fetch
          // options are NOT changed here — CORS behaviour must be
          // verified in the real extension context first.
          lastError = new Error(`download failed (network/CORS error — ${String((e && e.message) || e).slice(0, 120)}) for ${fileId}`);
        } else {
          lastError = e;
        }
        resp = null;
        break;
      }
      if (!resp.ok) break; // status branching below (timer stopped there)
      if (wantRange && resp.status === 200) {
        // Server ignored Range: discard the partial and restart from 0
        // inside this same attempt.
        stopInactivity();
        try { if (resp.body) await resp.body.cancel(); } catch { /* already closed */ }
        await deleteChunksByPrefix(db, fileId);
        await idbDel(db, fileId);
        trustedBytes = 0;
        resumeFrom = 0; idx = 0; loaded = 0;
        resp = null;
        continue;
      }
      if (wantRange && resp.status === 206) {
        const cr = resp.headers.get('content-range');
        if (cr == null) {
          try { console.warn(`[ct-dl] ${fileId}: 206 without Content-Range, proceeding (size check still applies)`); } catch {}
        } else {
          const m = /bytes\s+(\d+)-\d+\/(\d+|\*)/.exec(String(cr).trim());
          const badRange = !m || Number(m[1]) !== resumeFrom ||
            (m[2] !== '*' && spec && spec.bytes && Number(m[2]) !== spec.bytes);
          if (badRange) {
            // Server's range does not match the request: discard and
            // restart from 0 inside this same attempt.
            stopInactivity();
            try { if (resp.body) await resp.body.cancel(); } catch { /* already closed */ }
            await deleteChunksByPrefix(db, fileId);
            await idbDel(db, fileId);
            trustedBytes = 0;
            resumeFrom = 0; idx = 0; loaded = 0;
            resp = null;
            continue;
          }
        }
      }
      break; // usable response (200 full, or a matching 206 resume)
    }
    if (!resp) {
      // Fetch threw (lastError set above). Retry with resume while
      // attempts remain.
      if (attempt >= DOWNLOAD_MAX_ATTEMPTS) throw lastError;
      continue;
    }
    logRateLimit(fileId, resp.headers);
    if (!resp.ok) {
      stopInactivity();
      const status = resp.status;
      if (status === 404 || status === 401 || status === 403) {
        // Permanent: the file is gone / forbidden under this URL. No
        // retry loop — a later extension update may fix the URL.
        throw new Error(`model file not found on Hugging Face (HTTP ${status}) — the extension may need an update`);
      }
      if (status === 429 || status >= 500) {
        streamFailures = 0; // not a stream failure; a fresh attempt starts clean
        const waitMs = parseRetryWaitMs(resp.headers);
        if (attempt >= DOWNLOAD_MAX_ATTEMPTS) {
          if (status === 429) {
            throw new Error(`rate-limited, retry later (HTTP 429 for ${fileId} after ${DOWNLOAD_MAX_ATTEMPTS} attempts; RateLimit=${String(resp.headers.get('ratelimit') || 'absent')})`);
          }
          throw new Error(`download failed (HTTP ${status}) for ${fileId} after ${DOWNLOAD_MAX_ATTEMPTS} attempts`);
        }
        // Wait out the server's asked-for delay (or the 3-minute floor)
        // BEFORE the next attempt — restarting immediately would retry
        // straight into the same limit.
        await sleep(waitMs);
        continue;
      }
      // Any other 4xx: permanent, same as before, with the status kept.
      throw new Error(`download failed (HTTP ${status}) for ${fileId}`);
    }
    if (!resp.body) {
      stopInactivity();
      lastError = new Error(`download failed (empty response body) for ${fileId}`);
      if (attempt >= DOWNLOAD_MAX_ATTEMPTS) throw lastError;
      continue;
    }
    const contentLengthRaw = resp.headers.get('content-length');
    const contentLength = contentLengthRaw != null ? parseInt(String(contentLengthRaw), 10) : NaN;
    const hasLength = !Number.isNaN(contentLength);
    if (hasLength && spec && spec.bytes) {
      // A 206 answers with the REMAINING length, a 200 with the full
      // file; either way resumeFrom + length must be the spec size.
      if (resumeFrom + contentLength !== spec.bytes) {
        stopInactivity();
        throw new Error(`server says this file is ${resumeFrom + contentLength} bytes, expected ${spec.bytes} — the model may have been updated`);
      }
    } else if (!hasLength) {
      try { console.warn(`[ct-dl] ${fileId}: no content-length on download response, proceeding`); } catch {}
    }
    const contentType = resp.headers.get('content-type');
    if (contentType != null) {
      const mediaType = String(contentType).split(';')[0].trim().toLowerCase();
      if (mediaType !== 'application/octet-stream') {
        stopInactivity();
        throw new Error(`unexpected response from Hugging Face (got ${mediaType})`);
      }
    } else {
      try { console.warn(`[ct-dl] ${fileId}: no content-type on download response, proceeding`); } catch {}
    }
    etag = resp.headers.get('x-linked-etag');
    attemptTotal = hasLength ? contentLength : 0;

    const reader = resp.body.getReader();
    let pending = [], pendingLen = 0;
    const flushChunk = async () => {
      if (!pendingLen) return;
      const buf = new Uint8Array(pendingLen);
      let off = 0;
      for (const c of pending) { buf.set(c, off); off += c.length; }
      pending = []; pendingLen = 0;
      await idbPut(db, { id: chunkKey(fileId, idx++), data: buf.buffer });
    };
    let streamError = null;
    for (;;) {
      let readResult;
      try {
        readResult = await reader.read();
      } catch (e) {
        stopInactivity();
        if (e && e.name === 'AbortError') {
          streamError = new Error(`download timed out (no data for ${DOWNLOAD_INACTIVITY_MS / 1000}s) for ${fileId}`);
        } else {
          streamError = e;
        }
        break;
      }
      const { done, value } = readResult;
      if (done) break;
      armInactivity(); // bytes arrived — the connection is alive, reset the timer
      pending.push(value);
      pendingLen += value.length;
      loaded += value.length;
      onProgress && onProgress(loaded, progressTotal || attemptTotal);
      if (pendingLen >= IDB_CHUNK) await flushChunk();
      // Some proxies/middleboxes deliver every byte but never terminate the
      // stream — without this, the download hangs at 100% forever. Once we
      // hold the advertised content-length, stop waiting for {done: true}.
      // With a resume, attemptTotal is the REMAINING length, so the break
      // is at resumeFrom + attemptTotal.
      if (attemptTotal > 0 && loaded >= resumeFrom + attemptTotal) break;
      // yield so progress messages flush
      await new Promise(r => setTimeout(r, 0));
    }
    stopInactivity();
    try { await reader.cancel(); } catch { /* stream already closed */ }
    if (streamError) {
      // A stream error after bytes arrived is usually the signed CDN URL
      // expiring mid-download (a 403 surfaces as a stream error, with no
      // status). Re-fetching the resolver URL gives a fresh signed URL.
      streamFailures += 1;
      if (streamFailures >= 2) {
        restartFromZero = true;
        lastError = new Error(`download link expired, retrying ${fileId} from the start`);
        try { console.warn('[ct-dl] ' + lastError.message); } catch {}
      } else {
        lastError = streamError;
      }
      if (attempt >= DOWNLOAD_MAX_ATTEMPTS) throw lastError;
      continue;
    }
    streamFailures = 0;
    await flushChunk();
    if (spec && spec.bytes && loaded !== spec.bytes) {
      if (loaded > spec.bytes) {
        // More bytes than the file should be: wrong file, not resumable.
        await deleteChunks(db, fileId, idx);
        throw new Error(
          `downloaded ${fileId} is ${loaded} bytes but should be ${spec.bytes} — ` +
          `the download was truncated or is the wrong file. Please try again.`);
      }
      // Truncated: the stream ended early. Keep the chunks and resume.
      lastError = new Error(
        `downloaded ${fileId} is ${loaded} bytes but should be ${spec.bytes} — ` +
        `the download was truncated or is the wrong file. Please try again.`);
      if (attempt >= DOWNLOAD_MAX_ATTEMPTS) throw lastError;
      continue;
    }
    // Integrity: verify the reassembled bytes against the SHA-256 the
    // server exposed as X-Linked-ETag, BEFORE the manifest is written.
    if (etag != null && spec && spec.bytes) {
      let hashOk;
      try {
        hashOk = await verifyFileHash(db, fileId, idx, loaded, etag);
      } catch (e) {
        // Reassembly failed (a chunk went missing): the stored bytes
        // are not trustworthy — drop them and try again.
        await deleteChunksByPrefix(db, fileId);
        await idbDel(db, fileId);
        trustedBytes = 0;
        lastError = e;
        if (attempt >= DOWNLOAD_MAX_ATTEMPTS) throw lastError;
        continue;
      }
      if (hashOk === false) {
        await deleteChunksByPrefix(db, fileId);
        await idbDel(db, fileId);
        trustedBytes = 0;
        lastError = new Error(`downloaded file failed integrity check, retrying ${fileId}`);
        if (attempt >= DOWNLOAD_MAX_ATTEMPTS) throw lastError;
        continue;
      }
      // hashOk null = no usable hash (absent/malformed/unavailable):
      // size check only, already passed. Logged inside verifyFileHash.
    }
    await idbPut(db, { id: fileId, bytes: loaded, chunks: idx, downloadedAt: Date.now() });
    return loaded;
  }
  throw lastError || new Error(`download failed for ${fileId}`);
}

export { MSG };
