// Web Worker for translation (Firefox).
// Runs on its own thread, so the network I/O and response processing are not
// blocked when the main thread is hogged by WASM inpaint.
import { translateBlocks } from './translators.js';

self.onmessage = async (e) => {
  const { blocks, settings } = e.data;
  // Deadline signal: the worker used to pass null, so Google/Azure fetch
  // had no abort signal and no timeout — a stalled backend hung the pill
  // forever. Abort at 30s, matching the Chrome path's abortController.
  // The abort is a failover trigger now, not a kill: translateBlocks
  // rescues onto a fresh signal when the abort wasn't a user cancel.
  // The deadlineMs arg only caps LM Studio; this signal caps Google/Azure
  // too. The message below derives from DEADLINE_MS so it can't drift
  // from the value again.
  // 30s is an app-chosen stall budget, not a server/API limit: it matches
  // the Chrome path's abortController and the 30s deadlineMs passed by
  // the service worker, and it is sized so stall (30s) + rescue failover
  // (20s, inside translateBlocks) still fits under the caller's 60s
  // backstop (TRANSLATE_BACKSTOP_MS in service-worker.js). fetch() has
  // no built-in timeout, so a timer + AbortController is the only way
  // to bound a hung backend here — no event fires when a backend stalls.
  const DEADLINE_MS = 30000;
  const ctrl = new AbortController();
  const deadlineId = setTimeout(() => ctrl.abort(), DEADLINE_MS);
  try {
    // Forward failover notices so the SW can show a pill and log the line.
    const onProgress = (p) => {
      if (p && p.failoverFrom && p.failoverTo) {
        self.postMessage({ type: 'failover-notice', failoverFrom: p.failoverFrom, failoverTo: p.failoverTo, failoverWhy: p.failoverWhy || '', failoverSource: p.failoverSource || '' });
      }
    };
    const translated = await translateBlocks(blocks, settings, onProgress, ctrl.signal, DEADLINE_MS);
    clearTimeout(deadlineId);
    self.postMessage({ ok: true, translated, backendUsed: blocks[0]?.backendUsed });
  } catch (err) {
    clearTimeout(deadlineId);
    // Prefer the real error: translateBlocks already produces a specific
    // failover error (primary + fallback causes). Use the generic
    // timeout wording only when the error really is a bare abort — a
    // message of exactly 'cancelled' (or no message at all) with the
    // deadline signal fired. Otherwise the specific cause is lost.
    const msg = (err && err.message && err.message !== 'cancelled')
      ? err.message
      : ctrl.signal.aborted
        ? `translate timed out after ${DEADLINE_MS / 1000}s — the translation backend may be stuck`
        : (err.message || String(err));
    self.postMessage({ ok: false, error: msg });
  }
};
