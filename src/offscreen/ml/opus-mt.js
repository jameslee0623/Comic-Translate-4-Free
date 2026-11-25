// Local translation with Opus-MT (ONNX) + OpenCC.
//
// Two directions (weights Apache-2.0):
//   opus-mt-ja-zh  — Japanese -> Chinese, DIRECT one hop. There is no
//                    Xenova ONNX ja-zh; the PyTorch model is
//                    shun89/opus-mt-ja-zh (the re-host of the delisted
//                    Helsinki-NLP opus-mt-ja-zh), converted to ONNX here
//                    with optimum and quantized to uint8 (see
//                    ~/workspace/.opus-test/). It is a BPE model, so it
//                    uses BPETokenizer below, not UnigramTokenizer.
//   opus-mt-en-zh  — English -> Simplified Chinese (Xenova ONNX).
// Opus-MT outputs Simplified Chinese, so the result is converted to
// Traditional (Taiwan) with the vendored opencc-js (s2twp) — see
// opencc.js. Source languages supported: ja, en. Target: zh-TW only.
//
// Each direction is three quantized ONNX files (encoder, decoder,
// decoder_with_past) — ja-zh ~235MB, en-zh ~169MB, downloaded on first
// use into IndexedDB like the other models (model-specs.js groups
// 'mt-ja-zh' / 'mt-en-zh'). Only ONE direction is loaded at a time
// (RAM on the phone is the constraint, not storage). The tokenizer
// vocab is bundled as JSON in dicts/ (opus-mt-*-vocab.json) because the
// tokenizer is needed for every call and the vocab is only ~2MB.
//
// Tokenizer: the en-zh model is SentencePiece Unigram, ported from the
// Xenova tokenizer.json and verified against the reference `tokenizers`
// library in Python on 2026-11-25 (20/20 sentences match, including
// fullwidth punctuation):
//   WhitespaceSplit -> Metaspace (prepend U+2581 to each word)
//   -> Unigram Viterbi over the vocab (log-prob scores), unknown runs
//      merged into a single unk token (unk_id from the file, 2)
//   -> post-process appends </s> (id 0).
//   The ja-zh model is SentencePiece BPE (see BPETokenizer below).
//   Decode joins the pieces, skips EOS/pad/unk, turns U+2581 into a
//   space and strips the leading space.
//
// Decoding: greedy argmax, one token at a time. Step 1 uses the decoder
// model (which also produces the encoder cross-attention KV); later steps
// use decoder_with_past. The encoder KV is constant across steps —
// decoder_with_past does not return it, so it is kept from step 1 and
// only the decoder KV is updated. Beam search (num_beams 4/6 in the
// configs) is a possible later improvement; greedy is the v1.
export const OPUS_EOS = 0;
export const OPUS_MAX_NEW_TOKENS = 128; // a manga bubble is at most a few
// dozen tokens; 128 covers it with headroom and bounds the worst-case
// decode loop (128 steps) on a slow device.

const SPACE_MARK = '\u2581'; // U+2581 LOWER ONE EIGHTH BLOCK (SentencePiece word marker)

// SentencePiece Unigram tokenizer over a Xenova tokenizer.json vocab.
// vocabJson: { vocab: [[piece, score], ...] (index == id), unk_id }.
export class UnigramTokenizer {
  constructor() {
    this.pieces = null; // id -> piece string
    this.scores = null; // id -> log-prob score
    this.pieceToId = null; // piece -> id
    this.maxLen = 0; // longest piece, in characters
    this.unkId = 1;
    this.padId = -1;
  }

  get loaded() { return !!this.pieces; }

  setVocab(vocabJson) {
    const parsed = typeof vocabJson === 'string' ? JSON.parse(vocabJson) : vocabJson;
    const vocab = parsed.vocab;
    if (!Array.isArray(vocab) || !vocab.length) throw new Error('opus vocab is empty');
    this.pieces = new Array(vocab.length);
    this.scores = new Float64Array(vocab.length);
    this.pieceToId = new Map();
    for (let i = 0; i < vocab.length; i++) {
      const [piece, score] = vocab[i];
      this.pieces[i] = piece;
      this.scores[i] = score;
      if (!this.pieceToId.has(piece)) this.pieceToId.set(piece, i);
      if (piece.length > this.maxLen) this.maxLen = piece.length;
    }
    this.unkId = typeof parsed.unk_id === 'number' ? parsed.unk_id : 1;
    this.padId = this.pieceToId.get('<pad>') ?? -1;
  }

  // Does any vocab piece start at word[k]? (for the unknown-run merge.)
  _hasPieceAt(word, k) {
    const n = word.length;
    for (let j = Math.min(n, k + this.maxLen); j > k; j--) {
      if (this.pieceToId.has(word.slice(k, j))) return true;
    }
    return false;
  }

  // Unigram Viterbi over one Metaspace word (starts with U+2581).
  // Best total score wins; a position with no vocab piece starting there
  // emits one unk token for the maximal run of such characters.
  _viterbi(word) {
    const n = word.length;
    const NEG = -Infinity;
    const bestScore = new Float64Array(n + 1).fill(NEG);
    const bestPrev = new Int32Array(n + 1).fill(-1);
    const bestId = new Int32Array(n + 1).fill(-1);
    bestScore[0] = 0;
    for (let i = 0; i < n; i++) {
      const sc = bestScore[i];
      if (sc === NEG) continue;
      let matched = false;
      for (let j = Math.min(n, i + this.maxLen); j > i; j--) {
        const id = this.pieceToId.get(word.slice(i, j));
        if (id === undefined) continue;
        matched = true;
        const ns = sc + this.scores[id];
        if (ns > bestScore[j]) { bestScore[j] = ns; bestPrev[j] = i; bestId[j] = id; }
      }
      if (!matched) {
        // One unk token for the whole run of unknown characters.
        let j = i + 1;
        while (j < n && !this._hasPieceAt(word, j)) j++;
        if (sc > bestScore[j]) { bestScore[j] = sc; bestPrev[j] = i; bestId[j] = this.unkId; }
      }
    }
    const ids = [];
    let i = n;
    while (i > 0) {
      const id = bestId[i];
      if (id < 0) throw new Error('opus tokenizer: no path through ' + JSON.stringify(word));
      ids.push(id);
      i = bestPrev[i];
    }
    ids.reverse();
    return ids;
  }

  // Text -> ids, with </s> (id 0) appended (the post-processor rule).
  encode(text) {
    if (!this.loaded) throw new Error('opus tokenizer vocab not set');
    const ids = [];
    // WhitespaceSplit (drop the whitespace) + Metaspace add_prefix_space.
    for (const w of String(text).split(/\s+/)) {
      if (!w) continue;
      ids.push(...this._viterbi(SPACE_MARK + w));
    }
    ids.push(OPUS_EOS);
    return ids;
  }

  // Generated ids -> text. Stops at EOS, skips pad/unk pieces.
  decode(ids) {
    if (!this.loaded) throw new Error('opus tokenizer vocab not set');
    let text = '';
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      if (id === OPUS_EOS) break;
      if (id === this.padId || id === 1) continue; // <pad>, <unk>
      const piece = (id >= 0 && id < this.pieces.length) ? this.pieces[id] : '';
      if (piece) text += piece;
    }
    // Metaspace decode: U+2581 -> space, strip the leading space.
    text = text.split(SPACE_MARK).join(' ');
    if (text.startsWith(' ')) text = text.slice(1);
    return text;
  }
}

// SentencePiece BPE tokenizer over a vocab JSON.
// Used by the ja-zh direction: that model (shun89/opus-mt-ja-zh, the
// re-host of the delisted Helsinki-NLP opus-mt-ja-zh) is a BPE model
// (SentencePiece model_type 2), not Unigram — its scores are the
// negative piece rank, so Unigram Viterbi cannot use them. BPE merges
// the adjacent pair whose concatenation has the lowest piece id
// (earliest merge = highest priority). Verified against the reference
// MarianTokenizer in Python on 2026-11-25 (11/11 sentences match).
// The Marian normalizer is NFKC: fullwidth ？/！ become ASCII ?/! before
// tokenizing (they are not in the vocab as fullwidth). JS has NFKC
// built in (String.prototype.normalize). Decode is identical to
// Unigram (join pieces, U+2581 -> space).
export class BPETokenizer {
  constructor() {
    this.pieces = null;
    this.pieceToId = null;
    this.unkId = 1;
    this.padId = -1;
  }

  get loaded() { return !!this.pieces; }

  setVocab(vocabJson) {
    const parsed = typeof vocabJson === 'string' ? JSON.parse(vocabJson) : vocabJson;
    const vocab = parsed.vocab;
    if (!Array.isArray(vocab) || !vocab.length) throw new Error('opus vocab is empty');
    this.pieces = new Array(vocab.length);
    this.pieceToId = new Map();
    for (let i = 0; i < vocab.length; i++) {
      const piece = vocab[i][0];
      this.pieces[i] = piece;
      if (!this.pieceToId.has(piece)) this.pieceToId.set(piece, i);
    }
    this.unkId = typeof parsed.unk_id === 'number' ? parsed.unk_id : 1;
    this.padId = this.pieceToId.get('<pad>') ?? -1;
  }

  // BPE-merge one Metaspace word (starts with U+2581) into ids.
  _bpe(word) {
    let symbols = [...word]; // code points, not UTF-16 units
    if (!symbols.length) return [];
    for (;;) {
      let bestId = -1, bestPos = -1;
      for (let i = 0; i < symbols.length - 1; i++) {
        const id = this.pieceToId.get(symbols[i] + symbols[i + 1]);
        if (id !== undefined && (bestId < 0 || id < bestId)) { bestId = id; bestPos = i; }
      }
      if (bestId < 0) break;
      symbols.splice(bestPos, 2, symbols[bestPos] + symbols[bestPos + 1]);
    }
    return symbols.map((s) => this.pieceToId.get(s) ?? this.unkId);
  }

  // Text -> ids, with </s> (id 0) appended. NFKC first (Marian normalizer).
  encode(text) {
    if (!this.loaded) throw new Error('opus tokenizer vocab not set');
    const ids = [];
    for (const w of String(text).normalize('NFKC').split(/\s+/)) {
      if (!w) continue;
      ids.push(...this._bpe(SPACE_MARK + w));
    }
    ids.push(OPUS_EOS);
    return ids;
  }

  // Generated ids -> text. Stops at EOS, skips pad/unk pieces.
  decode(ids) {
    if (!this.loaded) throw new Error('opus tokenizer vocab not set');
    let text = '';
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      if (id === OPUS_EOS) break;
      if (id === this.padId || id === 1) continue;
      const piece = (id >= 0 && id < this.pieces.length) ? this.pieces[id] : '';
      if (piece) text += piece;
    }
    text = text.split(SPACE_MARK).join(' ');
    if (text.startsWith(' ')) text = text.slice(1);
    return text;
  }
}

// One Opus-MT direction (ja-en or en-zh): encoder + decoder +
// decoder_with_past, greedy decode.
export class OpusMT {
  // decoderStartId: the id the decoder starts from (the <pad> id:
  // 65000 for en-zh, 60715 for ja-en — the config's
  // decoder_start_token_id).
  // tokenizer: a UnigramTokenizer (default, Xenova models) or a
  // BPETokenizer (the ja-zh model, which is BPE).
  constructor(decoderStartId, tokenizer = null) {
    this.decoderStartId = decoderStartId;
    this.encSess = null;
    this.decSess = null;
    this.decPastSess = null;
    this.tokenizer = tokenizer || new UnigramTokenizer();
  }

  get loaded() { return !!(this.encSess && this.decSess && this.decPastSess); }

  async reset() {
    for (const s of [this.encSess, this.decSess, this.decPastSess]) {
      try { await s?.release?.(); } catch {}
    }
    this.encSess = null; this.decSess = null; this.decPastSess = null;
  }

  async load(encoderBytes, decoderBytes, decoderPastBytes, executionProviders = ['wasm']) {
    if (this.loaded) return;
    const toU8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
    this.encSess = await ort.InferenceSession.create(toU8(encoderBytes), { executionProviders });
    this.decSess = await ort.InferenceSession.create(toU8(decoderBytes), { executionProviders });
    this.decPastSess = await ort.InferenceSession.create(toU8(decoderPastBytes), { executionProviders });
  }

  setVocab(vocabJson) { this.tokenizer.setVocab(vocabJson); }

  // One sentence -> translated text (in the model's target language).
  // opts.shouldAbort() is checked between decode steps.
  async translate(text, opts = {}) {
    if (!this.loaded) throw new Error('opus-mt session not loaded');
    if (!this.tokenizer.loaded) throw new Error('opus-mt tokenizer vocab not set');
    const ids = this.tokenizer.encode(text);
    const n = ids.length;
    const ids64 = new BigInt64Array(n);
    for (let i = 0; i < n; i++) ids64[i] = BigInt(ids[i]);
    const attn64 = new BigInt64Array(n).fill(1n);
    const encOut = await this.encSess.run({
      input_ids: new ort.Tensor('int64', ids64, [1, n]),
      attention_mask: new ort.Tensor('int64', attn64, [1, n]),
    });
    const hidden = encOut.last_hidden_state;
    if (opts.shouldAbort && opts.shouldAbort()) throw new Error('cancelled');
    // Step 1: decoder model from the start token. It also produces the
    // encoder cross-attention KV (present.*.encoder.*), which the
    // decoder_with_past model does not return — keep it for all steps.
    let past = {};
    const step1 = await this.decSess.run({
      input_ids: new ort.Tensor('int64', new BigInt64Array([BigInt(this.decoderStartId)]), [1, 1]),
      encoder_hidden_states: hidden,
      encoder_attention_mask: new ort.Tensor('int64', attn64, [1, n]),
    });
    for (const k of Object.keys(step1)) {
      if (k === 'logits') continue;
      past[k.replace('present.', 'past_key_values.')] = step1[k];
    }
    let tokId = argmax(step1.logits.data, step1.logits.dims[2]);
    const gen = [];
    let steps = 0;
    while (tokId !== OPUS_EOS && steps < OPUS_MAX_NEW_TOKENS) {
      gen.push(tokId);
      steps++;
      if (opts.shouldAbort && opts.shouldAbort()) throw new Error('cancelled');
      const feeds = {
        input_ids: new ort.Tensor('int64', new BigInt64Array([BigInt(tokId)]), [1, 1]),
        encoder_attention_mask: new ort.Tensor('int64', attn64, [1, n]),
        ...past,
      };
      const out = await this.decPastSess.run(feeds);
      // Only the decoder KV comes back; the encoder KV in `past` is
      // unchanged, so update just the decoder entries.
      for (const k of Object.keys(out)) {
        if (k === 'logits') continue;
        past[k.replace('present.', 'past_key_values.')] = out[k];
      }
      tokId = argmax(out.logits.data, out.logits.dims[2]);
    }
    return { text: this.tokenizer.decode(gen), tokens: gen.length };
  }
}

// Index of the largest value in a flat float array of length vocabSize.
// The logits tensor is [1, 1, vocab], so the last position is the whole array.
function argmax(data, vocabSize) {
  let best = -Infinity, bestI = 0;
  for (let i = 0; i < vocabSize; i++) {
    const v = data[i];
    if (v > best) { best = v; bestI = i; }
  }
  return bestI;
}
