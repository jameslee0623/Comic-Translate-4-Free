// Firefox ML worker — CLASSIC worker (not module), see ml-bridge.js.
// Runs ALL ML compute (detect, OCR, inpaint, ensure, cancel) on its own
// thread so the background page (main thread) stays free to monitor,
// time, and restart it. Reuses the offscreen handlers verbatim: same
// module, same IDB pixel bus and models, only the thread changes.
//
// Why classic: ort.min.js is UMD, and its top-level `var ort` only
// becomes a global via a classic script load. A module worker kept `ort`
// module-scoped, so offscreen.js threw at import and the worker never
// started (1018p bug). importScripts gives the worker a real `self.ort`
// global; the ESM handler module then loads via dynamic import.
// Relative URLs resolve against this worker's own URL.
//
// Firefox workers have no `chrome` global, but the handler module loads
// model assets (Baberu vocab) via chrome.runtime.getURL — without this
// shim every OCR load fails with "chrome is not defined". Provide the
// minimal equivalent: getURL takes an extension-root-relative path, so
// resolve it against this worker's own origin (moz-extension://<id>/).
// The wasmPaths use and the message listener are already guarded, and
// downloads (the only sendMessage user) never run on the worker, so
// getURL is the only piece the worker needs.
if (typeof chrome === 'undefined') {
  globalThis.chrome = {
    runtime: {
      getURL: (path) => new URL(path, new URL('/', self.location.href)).href,
    },
  };
}

importScripts('../offscreen/vendor/ort.min.js');

Promise.all([
  import('../offscreen/offscreen.js'),
  import('../shared/contracts.js'),
]).then(([offscreen, contracts]) => {
  const mlHandlers = offscreen.mlHandlers;
  const MSG = contracts.MSG;
  // The inpaint handler reports progress through this hook — forward it
  // to the page (only inpaint reports progress; other handlers never call it).
  globalThis.__ctInpaintProgress = (runId, frac) => {
    try { self.postMessage({ type: 'inpaint-progress', runId, frac }); } catch {}
  };
  // Serialize ML compute: ORT's WASM backend runs one inference at a
  // time. Two concurrent session.run() calls trip ORT's own guard — the
  // second throws "Session already started" and its finally clears the
  // first's session, so the first throws "Session mismatch" too. Both
  // runs fail. Queueing here makes concurrent runs wait their turn
  // instead of killing each other. ML_CANCEL bypasses the queue: it must
  // run at once to stop the in-flight work, not wait behind it.
  const ML_COMPUTE = new Set(['ml/ensure', 'ml/detect', 'ml/ocr', 'ml/inpaint', 'ml/translate']);
  let mlQueue = Promise.resolve();
  const runMl = async (msg) => {
    try {
      const fn = mlHandlers[msg.type];
      if (!fn) throw new Error('ML worker has no handler for ' + msg.type);
      const res = await fn(msg);
      self.postMessage({ callId: msg.callId, runId: msg.runId, ok: true, res });
    } catch (err) {
      self.postMessage({ callId: msg.callId, runId: msg.runId, ok: false, error: String((err && err.message) || err) });
    }
  };
  self.onmessage = (e) => {
    const msg = e.data;
    if (!msg || !msg.type) return;
    if (ML_COMPUTE.has(msg.type)) {
      mlQueue = mlQueue.then(() => runMl(msg)).catch(() => {});
    } else {
      runMl(msg);
    }
  };
  // DIAGNOSTIC (temporary): log errors that escape the handler
  // try/catch (async callbacks, device callbacks) as plain text, so
  // the message survives even when the thrown value is an object the
  // console cannot expand.
  self.addEventListener('error', (ev) => {
    try { console.error('[ct-worker] uncaught error:', String((ev && ev.message) || ev || '')); } catch {}
  });
  self.addEventListener('unhandledrejection', (ev) => {
    try { console.error('[ct-worker] unhandled rejection:', String(((ev && ev.reason && ev.reason.message) || (ev && ev.reason) || ev || ''))); } catch {}
  });
  self.postMessage({ type: 'ml-ready' });
}).catch(() => {
  // Import failed (e.g. dynamic import unsupported): the page side falls
  // back to in-process compute on the ready timeout. Nothing else to do —
  // without the handlers this worker cannot run jobs.
});
