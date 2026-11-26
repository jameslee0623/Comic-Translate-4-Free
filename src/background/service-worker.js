// Background service worker: pipeline orchestration, model management,
// translation APIs, capture, debug emission. ML inference itself lives in
// the offscreen document; pure-JS stages (blocks, mask) run here.
import { MSG, STORE_URLS, FEEDBACK_MAILTO } from '../shared/contracts.js';
import { MODEL_GROUPS, getModelStatus, getModelDownloadState, deleteModelGroup, computeModelFingerprint } from '../shared/model-specs.js';
import { getSettings, updateSettingsField } from '../shared/settings.js';
import { canAutoOrPre, addProUsageForImages, anyProFeatureOn, proIsActive, proCheckDue, validateProLicense, DODO_CHECKOUT_URL, dateStr } from '../shared/pro.js';
import { recordBenchRun } from '../shared/bench.js';
import {
  makeTextBlock, mergeOverlappingBoxes, sortBlocks,
  boxIoU, clampBox, dedupAndMergeSeams, mergeBoxesByCost,
  INPAINT_COST, INPAINT_COST_SPREAD, patchCostMs, TILE_MAX,
} from '../shared/textblock.js';
import { toGrayU8, meanBrightness, renderScale, resizeBilinearRGBA } from '../shared/image-ops.js';
import { pixelPut, pixelTake, pixelDrop, pixelPruneRun } from '../shared/pixel-bus.js';
import { generateMask, detectContentMaskInBbox } from '../shared/mask.js';
import { translateBlocks, checkAzure, checkLmStudio, checkGemini, BACKEND_LABEL, BACKEND_SHORT_LABEL, setTranslateLogger } from './translators.js';
import { detectPageLang } from '../shared/lang-detect.js';
import { mlHostAlive, ensureMlHost, callMl, cancelMlForRun, runGpuInpaint, cancelGpuInpaint, runChromeGpuInpaint, cancelChromeGpuInpaint, notifyChromeGpuProgress, makeCanvas, canvasToBlob, directHandlers, WEBP_TYPE, WEBP_QUALITY, setMlAlarmRecoveryHook, warmUpMlWorker, setMlWorkerDiagHook } from './ml-bridge.js';
import {
  initPageCache, buildCacheKey, buildCacheKeyTier1, buildCacheKeyTier2,
  pageCacheGet, pageCachePut,
  pageCacheStats, clearPageCache,
} from '../shared/page-cache.js';
import { baseDomain, displayHost, hostOf, isSiteAllowed, imageHostOrigins, originAccessPatterns } from '../shared/site-access.js';
import { urlShape, applyPattern, patternNumber, observeRules, observeLinkRules, observePicLinkRules, activeRuleFor, activeLinkTexts, activePicLinkRule, noteLearnResult } from '../shared/next-page-learn.js';

// Skip-inpaint is a Debug setting now (settings.bypassInpaint), not a
// build flag. When on, LaMa never loads and the translated text renders
// over the original image. Default false.

// Translated-page cache is session-scoped: initPageCache() wipes the store on
// every browser startup (via a chrome.storage.session marker) and the
// get/put/stats helpers await that check before touching the store.
// DIAGNOSTIC: panel log buffer. The console does not work for this user
// (pastes are samples, Objects cannot be opened), so the log goes only
// to our own buffer + the persisted trace, shown in Settings where it
// can be copied in full. diagPush does NOT write to the console (James,
// 2026-11-26: the console log is never used) and adds no '[ct-diag] '
// tag (every line in the Settings text box is already a diag line, so
// the tag was 9 useless characters per line). Cap 2000.
// Defined here (before any use) so top-level calls cannot hit TDZ.
const diagLogBuf = [];
function diagPush(line) {
  try {
    // No console writes, no prefix (James, 2026-11-26): the log is never
    // read from the console — the user copies it from Settings on the
    // phone — so every line goes only to the buffer + the persisted
    // trace, as the plain line.
    const s = String(line);
    diagLogBuf.push(s);
    // 2.1.55: persist the line (last 2000) so a background restart does
    // not wipe the log orphan recovery needs. Fire-and-forget, chained.
    try { diagTracePersist(s); } catch {}
    // 2.1.49: keep 2000 lines, not 200. A multi-pic run makes ~3-4 lines
    // per picture (measured 2026-11-26), so a 50-picture run is ~150-200
    // lines; the cap is headroom plus multi-run accumulation. The
    // run-end missed accounting is written last, so it survives regardless.
    if (diagLogBuf.length > 2000) diagLogBuf.shift();
  } catch {}
}

// Human-readable log format (James, 2026-11-26): plain words, no repeats,
// no noise. One run header, one block per picture, one run footer.
// These helpers keep every call site producing the same shape.
function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
// Short plain reason for a failed capture tier, from the raw error text.
// Browser messages ("Tainted canvases may not be exported", "Failed to
// fetch") mean nothing to a human — map them to what actually happened.
function shortCaptureWhy(err) {
  const s = String(err || '');
  if (/Tainted canvases/i.test(s)) return 'blocked';
  if (/timed out after/i.test(s)) return 'timed out';
  if (/skipped \(host failed recently\)/i.test(s)) return 'skipped (host failed recently)';
  if (/skipped \(overall capture budget/i.test(s)) return 'skipped (capture budget exhausted)';
  if (/HTTP 403/i.test(s)) return 'blocked (HTTP 403)';
  if (/HTTP 429/i.test(s)) return 'rate-limited (HTTP 429)';
  if (/HTTP 404/i.test(s)) return 'not found (HTTP 404)';
  if (/HTTP 5\d\d/i.test(s)) return 'server error';
  if (/Failed to fetch/i.test(s)) return 'failed';
  if (/blank/i.test(s)) return 'blank';
  if (/no pixels/i.test(s)) return 'no pixels';
  if (/different image than the page shows/i.test(s)) return 'wrong image from server';
  return (s.replace(/^(page canvas|page download|download):\s*/i, '').slice(0, 60) || 'failed');
}
// Plain name for a capture tier, for the per-picture capture line.
function plainTierName(tier) {
  if (tier === 'page-canvas') return 'page canvas';
  if (tier === 'page-fetch') return 'page fetch';
  if (tier === 'fallback-tab') return 'background tab';
  return tier || 'worker-fetch';
}
// One failover log line (James, 2026-11-26): the guard line and the
// failover line are the same event, so they are one line —
// "<Engine> returned untranslated text (source: ...). Trying Google
// instead." or "<Engine> failed (<reason>). Trying Google instead."
// `prefix` is for the pre-translate flow ("Pre-translate:"); the main
// run uses the 2-space picture-block indent instead.
function logFailoverLine(p, prefix) {
  if (!p || !p.failoverFrom || !p.failoverTo) return;
  const from = BACKEND_SHORT_LABEL[p.failoverFrom] || p.failoverFrom;
  const to = BACKEND_SHORT_LABEL[p.failoverTo] || p.failoverTo;
  const head = prefix ? prefix + ' ' : '  ';
  if (p.failoverWhy === 'untranslated text') {
    diagPush(`${head}${from} returned untranslated text${p.failoverSource ? ' (source: ' + p.failoverSource + ')' : ''}. Trying ${to} instead.`);
  } else {
    const why = String(p.failoverWhy || 'failed');
    // The reason often already names the engine ("Gemini returned no text
    // (PROHIBITED_CONTENT)") — use it as the sentence instead of repeating
    // the engine ("Gemini failed (Gemini returned ...)").
    if (why.toLowerCase().startsWith(from.toLowerCase())) {
      const sentence = why.charAt(0).toUpperCase() + why.slice(1);
      diagPush(`${head}${sentence}${sentence.endsWith('.') ? '' : '.'} Trying ${to} instead.`);
    } else {
      diagPush(`${head}${from} failed (${why}). Trying ${to} instead.`);
    }
  }
}
// Translate retries log to the Diagnostic log (so a slow translate shows
// its retries, not just one slow call). translators.js is a module — it
// cannot see diagPush directly, so the logger is injected here.
setTranslateLogger(diagPush);

// 2.1.20: bench trace — every bench line, persisted. diagPush alone is
// in-memory, so a worker restart wipes the bench lines before the next
// run's log can show them. benchTracePush appends the line to
// storage.local 'benchTrace' (last 100 lines), so the next run can show
// the full trace even after a restart. Writes are chained so they land
// in order. Fire-and-forget: never blocks the pipeline.
// Human-readable log (James, 2026-11-26): bench chatter (thread-bench
// trigger, keepalive pings) no longer goes to the diagnostic log — it is
// noise James never reads there. It still lands in benchTrace storage,
// where the benchmark UI reads it.
let benchTraceChain = Promise.resolve();
function benchTracePush(line) {
  benchTraceChain = benchTraceChain.then(async () => {
    try {
      const saved = await chrome.storage.local.get('benchTrace');
      const arr = (saved && Array.isArray(saved.benchTrace)) ? saved.benchTrace : [];
      arr.push({ line: String(line), at: new Date().toISOString() });
      await chrome.storage.local.set({ benchTrace: arr.slice(-100) });
    } catch {}
  }).catch(() => {});
}

// 2.1.55: persisted diag log. diagPush alone is in-memory, so when the
// background restarts mid-run the log is wiped and orphan recovery can
// only say the log "is lost" — the one time the log matters most. Every
// diag line is also appended to storage.local 'diagTrace' (last 2000
// lines, chained and fire-and-forget like benchTrace, so it never blocks
// the pipeline). Orphan/alarm recovery replays those lines into the
// panel log, so the user sees what the background was doing before it
// died. 2000 lines matches the in-memory buffer, so the Settings copy
// gets a full run (~1700 lines worst case), not just the last 13 pictures.
const DIAG_TRACE_KEY = 'diagTrace';
let diagTraceChain = Promise.resolve();
function diagTracePersist(line) {
  diagTraceChain = diagTraceChain.then(async () => {
    try {
      const saved = await chrome.storage.local.get(DIAG_TRACE_KEY);
      const arr = (saved && Array.isArray(saved[DIAG_TRACE_KEY])) ? saved[DIAG_TRACE_KEY] : [];
      arr.push(String(line));
      await chrome.storage.local.set({ [DIAG_TRACE_KEY]: arr.slice(-2000) });
    } catch {}
  }).catch(() => {});
}
async function readDiagTrace() {
  try {
    const saved = await chrome.storage.local.get(DIAG_TRACE_KEY);
    const arr = (saved && Array.isArray(saved[DIAG_TRACE_KEY])) ? saved[DIAG_TRACE_KEY] : [];
    return arr.filter((l) => typeof l === 'string');
  } catch { return []; }
}
// Print a line only once across background restarts. The version header,
// device line, and gpu-disabled line re-print on every background start
// (Firefox restarts the background often), filling the log with repeats.
// This checks the persisted trace first and skips the line if it is
// already there. Old repeats already in the trace age out (last 2000).
async function diagPushOnce(line) {
  const s = String(line);
  try {
    const arr = await readDiagTrace();
    // Old stored lines still carry the '[ct-diag] ' prefix until they
    // age out, so strip it when comparing.
    if (arr.some((l) => l.replace(/^\[ct-diag\] /, '') === s)) return;
  } catch {}
  diagPush(line);
}
// Replay the persisted pre-restart log into the in-memory buffer (direct
// buffer push, NOT diagPush, so the replayed lines are not persisted
// again). Returns how many lines were replayed.
// 2.2.11: also runs once on background load (below), not only in
// orphan/alarm recovery. The diag log is global across tabs (2.2.10), so
// a background restart must not wipe it — the buffer starts empty on
// load, and without this replay the Copy button only shows the lines
// since the restart. Idempotent per background lifetime: once lines were
// restored, later calls return that count without adding duplicates, so
// orphan recovery still gets the right count for its message.
let diagTraceReplayedCount = 0;
async function replayDiagTrace() {
  try {
    if (diagTraceReplayedCount > 0) return diagTraceReplayedCount;
    const recovered = await readDiagTrace();
    if (!recovered.length) return 0;
    diagLogBuf.push('--- log from before the restart (recovered) ---');
    for (const l of recovered) diagLogBuf.push(l);
    diagTraceReplayedCount = recovered.length;
    return recovered.length;
  } catch { return 0; }
}
// Restore the pre-restart log on load so the global log survives a
// background restart. Fire-and-forget: the buffer fills asynchronously
// and is ready well before the next run's sendDiagLog.
replayDiagTrace().catch(() => {});

// 2.3.12/1.7.12: stamp the version into the diag log at background start,
// so a pasted log says which build it came from — no need to ask the user.
// diagPush persists the line (diagTrace, last 200), so it survives a
// restart and shows in the recovered log too. The Firefox build's manifest
// carries browser_specific_settings; Chrome's does not. Wrapped: a
// missing getManifest must never break background load.
try {
  const _m = chrome.runtime.getManifest();
  diagPushOnce('Comic Translate 4 Free ' + _m.version + ' (' + (_m.browser_specific_settings ? 'Firefox' : 'Chrome') + ')').catch(() => {});
} catch {}
// GPU inpaint kill-switch (2.3.27): once WebGPU inpaint fails, it is a
// deterministic failure on this setup (e.g. a Metal shader that never
// compiles), so retrying it on every page only wastes time and spams
// the log. Remember the failure in storage.local (survives a background
// restart) and skip GPU for inpaint from then on, going straight to
// WASM. A new extension version clears the flag, so a fixed driver or
// a new onnxruntime gets one retry.
let gpuInpaintDead = false;
let gpuInpaintDeadLogged = false;
function gpuInpaintAllowed() { return !gpuInpaintDead; }
async function markGpuInpaintDead() {
  if (gpuInpaintDead) return;
  gpuInpaintDead = true;
  try {
    const v = (() => { try { return chrome.runtime.getManifest().version; } catch { return ''; } })();
    await chrome.storage.local.set({ gpuInpaintDead: { version: v, at: new Date().toISOString() } });
  } catch {}
}
async function loadGpuInpaintDead() {
  try {
    const saved = await chrome.storage.local.get('gpuInpaintDead');
    const rec = saved && saved.gpuInpaintDead;
    if (!rec) return;
    const cur = (() => { try { return chrome.runtime.getManifest().version; } catch { return ''; } })();
    if (rec.version && cur && rec.version !== cur) {
      // New extension version: give GPU one retry.
      try { await chrome.storage.local.remove('gpuInpaintDead'); } catch {}
      return;
    }
    gpuInpaintDead = true;
    if (!gpuInpaintDeadLogged) {
      gpuInpaintDeadLogged = true;
      diagPushOnce('Inpaint GPU is off (known failure — using WASM).').catch(() => {});
    }
  } catch {}
}
loadGpuInpaintDead().catch(() => {});
// Skip-inpaint marker (Debug setting): the pasted log must say when the
// bypass is on, so a log with un-inpainted text is not misread as a bug.
// Settings are read at run time — the switch can be toggled in Settings
// without reloading the background, so no module-level constant may
// cache it.
getSettings().then(s => { if (s && s.bypassInpaint) diagPush('Skip inpaint is on — text renders over the original picture.'); }).catch(() => {});

// 2.3.15/1.7.15: device + browser line in the diag log, so a pasted log
// says which device and browser it came from — no need to ask the user
// (many devices now). Best-effort and async: the phone model comes from
// userAgentData on Chromium (a promise); the UA string is the fallback.
// iPhone/iPad means Orion — the only iOS browser that runs this
// extension. Firefox Android cannot report the phone model (no
// userAgentData, no model in its UA), so it says Android. Never breaks
// background load: every step is guarded.
async function logDeviceLine() {
  try {
    if (typeof navigator === 'undefined') return;
    const ua = String((navigator && navigator.userAgent) || '');
    const platform = String((navigator && navigator.platform) || '');
    let model = '';
    try {
      const uad = navigator.userAgentData;
      if (uad && typeof uad.getHighEntropyValues === 'function') {
        const hv = await uad.getHighEntropyValues(['model']);
        if (hv && hv.model) model = String(hv.model);
      }
    } catch {}
    let os = '';
    const am = ua.match(/Android\s+([\d.]+);\s*([^;)]+)/);
    if (am) {
      os = 'Android ' + am[1];
      if (!model && am[2]) model = am[2].split(' Build/')[0].trim();
      if (model === 'Mobile') model = '';
    } else if (/iPhone|iPad/.test(ua) || /^iP/.test(platform)) {
      const ios = ua.match(/OS\s+([\d_]+)/);
      os = 'iOS ' + (ios ? ios[1].replace(/_/g, '.') : '');
      if (!model) model = (/iPad/.test(ua) || platform === 'iPad') ? 'iPad' : 'iPhone';
    } else if (/Mac/.test(platform) || /Macintosh/.test(ua)) {
      os = 'macOS';
      if (!model) model = 'Mac';
    } else if (/Win/.test(platform)) {
      os = 'Windows';
      if (!model) model = 'Windows PC';
    } else if (/Linux/.test(platform)) {
      os = 'Linux';
      if (!model) model = 'Linux';
    }
    let app = '';
    if (/iPhone|iPad/.test(ua) || /^iP/.test(platform)) {
      app = 'Orion';
    } else {
      const vm = ua.match(/Vivaldi\/([\d.]+)/);
      const fm = ua.match(/Firefox\/([\d.]+)/);
      const em = ua.match(/Edg\/([\d.]+)/);
      const om = ua.match(/OPR\/([\d.]+)/);
      const cm = ua.match(/Chrome\/([\d.]+)/);
      const sm = ua.match(/Version\/([\d.]+).*Safari/);
      if (vm) app = 'Vivaldi ' + vm[1];
      else if (fm) app = 'Firefox ' + fm[1];
      else if (em) app = 'Edge ' + em[1];
      else if (om) app = 'Opera ' + om[1];
      else if (cm) app = 'Chrome ' + cm[1];
      else if (sm) app = 'Safari ' + sm[1];
      else {
        let isFF = false;
        try { isFF = !!chrome.runtime.getManifest().browser_specific_settings; } catch {}
        app = isFF ? 'Firefox' : 'Chrome';
      }
    }
    const where = model ? model + (os && os !== model ? ' (' + os + ')' : '') : (os || 'unknown device');
    diagPushOnce('Device: ' + where + ' - ' + (app || 'unknown browser')).catch(() => {});
  } catch {}
}
logDeviceLine().catch(() => {});
// Also refresh the auto-start registrations at background load, so a
// restart picks up any grant made while the worker was down.
try { syncAutoStartRegistrations(); } catch {}

// 2.1.29: retired bench lines. 2.1.25 removed these from live code, but
// they live on in the persisted benchTrace and replay into every run's
// log. Filter them out of the replay (and purge them at run start).
// Fresh live lines still show when they actually happen: pings only
// start when the bench is not done, and a fresh "bench done, stopping
// pings" is pushed live when pings stop. Real events are kept: bench
// started, per-count timings, saves, "bench done best N", trigger
// delivered/failed, errors.
const BENCH_TRACE_RETIRED = [
  'already measured',
  'run ok, checking saved count',
  'pings starting',
  'bench done, stopping pings',
];
function benchTraceIsRetired(line) {
  const s = String(line || '');
  for (const p of BENCH_TRACE_RETIRED) { if (s.indexOf(p) !== -1) return true; }
  return false;
}

// 2.0.27: LEARNED inpaint merge spread. The merge charges a merged
// patch at perPxMs * spread (textblock.js) — the spread is how much
// more a big tile costs per pixel than a small one. It was a fixed
// 1.3, measured once on one M4 GPU and applied to every path, which
// is a guess, not a measurement. Now each path (gpu / wasm / wasm1)
// starts at 1.3 and learns its own value from real runs: after an
// inpaint run, every merged patch compares its actual ms against the
// base-model prediction (no spread); the per-pixel part of the ratio
// is the measured spread for that patch. The stored spread moves 10%
// toward the median ratio of the run's merged patches (damping), so
// one noisy run cannot swing it — that is the overfitting guard, along
// with the [1.0, 2.0] clamp and keeping the three paths separate.
// Stored in chrome.storage.local (mirrored to sync, like the thread
// bench) so it survives restarts; a missing value means 1.3.
const INPAINT_SPREAD_KEY = 'inpaintSpread';
const INPAINT_SPREAD_MIN = 1.0;
const INPAINT_SPREAD_MAX = 2.0;
const INPAINT_SPREAD_LEARN = 0.1;
let inpaintSpreadCache = null;
async function readInpaintSpread() {
  if (inpaintSpreadCache) return inpaintSpreadCache;
  const d = { gpu: INPAINT_COST_SPREAD, wasm: INPAINT_COST_SPREAD, wasm1: INPAINT_COST_SPREAD };
  try {
    const got = await chrome.storage.local.get(INPAINT_SPREAD_KEY);
    const s = got && got[INPAINT_SPREAD_KEY];
    if (s && typeof s === 'object') {
      for (const k of ['gpu', 'wasm', 'wasm1']) {
        const v = Number(s[k]);
        if (Number.isFinite(v)) d[k] = Math.min(INPAINT_SPREAD_MAX, Math.max(INPAINT_SPREAD_MIN, v));
      }
    }
  } catch {}
  inpaintSpreadCache = d;
  return d;
}
async function saveInpaintSpread(map) {
  inpaintSpreadCache = { ...map };
  try { await chrome.storage.local.set({ [INPAINT_SPREAD_KEY]: { ...map, updatedAt: new Date().toISOString() } }); } catch {}
  try { await chrome.storage.sync.set({ [INPAINT_SPREAD_KEY]: { ...map, updatedAt: new Date().toISOString() } }); } catch {}
}
// 1.4.0 (m6): each run's (and each recovery's) panel log is its own.
// 2.2.10: the diag log is now global across tabs and runs — it is never
// cleared at run/recovery start, so the debug panel shows content from
// all tabs (including pre-translate jobs) instead of only this run's
// lines. diagLogBuf caps at 2000 lines (shift), so it stays bounded.
initPageCache();

// DIAGNOSTIC (temporary): proves this build loaded, so a paste without
// this line means the old build ran, not this diagnostic.

// Content script path for scripting.executeScript.
// Chrome: service worker, paths relative to extension root.
// Firefox: background page at src/background/, Firefox resolves `files`
//   relative to the calling page (not the extension root), so we go up one.
const CONTENT_SCRIPT_FILES = (typeof window !== 'undefined' && window.document)
  ? ['../content/content.js']
  : ['src/content/content.js'];

// Timeout for a content-script round trip. emitDebug already races its
// sendMessage against 5s because "on some browsers tabs.sendMessage can
// hang (neither resolve nor reject), which would stall the pipeline" —
// the same hang applies to executeScript and every other content-script
// call, so they all race against the same 5s. Data calls (list-images,
// RENDER, get-image-pixels) carry a bigger payload and get 30s, the same
// as the fetch-image-bytes download race.
// Neither value comes from a measured latency in the code — both are
// judgment calls from the observed hang. If 5s ever false-fires on a slow
// page, the number to revisit is here, not at each call site. Per-call-site
// comments below are only added where a call waits for something specific
// (a tab load, a render); plain message calls rely on this comment.
const MSG_TIMEOUT_MS = 5000;
const DATA_TIMEOUT_MS = 30000;

// Capture timeouts are 10x the tier's measured normal time (James, 2026-11-26):
// if a tier does not respond within 10x its normal time it is assumed down
// and the pipeline moves to the next tier. Normals measured on AsuraScans
// ch.14 (long strip, 18 images, 9 at 900x16000, total 11.9 MB): long-strip
// download median 1,073ms; page-canvas ~50ms (local read, no download);
// fallback tab ~2s (estimated — tab overhead unmeasured). Worst case per
// image: 0.5 + 11 + 22 + 41 ≈ 75s (down from ~180s; the 120s overall cap
// in loadPipelineImagePixels is now non-binding, kept as a safety net).
const CAPTURE_TIMEOUT_MULTIPLIER = 10;
const CAPTURE_CANVAS_NORMAL_MS = 50;
const CAPTURE_FETCH_NORMAL_MS = 1100;
const CAPTURE_TAB_NORMAL_MS = 2000;
const CAPTURE_CANVAS_TIMEOUT_MS = CAPTURE_CANVAS_NORMAL_MS * CAPTURE_TIMEOUT_MULTIPLIER; // 500
const CAPTURE_FETCH_TIMEOUT_MS = CAPTURE_FETCH_NORMAL_MS * CAPTURE_TIMEOUT_MULTIPLIER; // 11000
const CAPTURE_TAB_TIMEOUT_MS = CAPTURE_TAB_NORMAL_MS * CAPTURE_TIMEOUT_MULTIPLIER; // 20000

// Race a promise against a timeout so a hung browser API can never stall
// a run silently. The timeout rejection flows into the caller's existing
// error handling, so a hang becomes a loud failure, not a stuck run.
// Callers pass MSG_TIMEOUT_MS (5s) for control messages (ping, inject,
// show-support) and DATA_TIMEOUT_MS (30s) for calls that move image bytes
// (list-images, RENDER, get-image-pixels) — see the constants above for
// why those two values. A timeout here is the only guard because
// tabs.sendMessage / executeScript have no cancellation and can hang
// without ever settling; there is no event to wait on instead.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timed out after ' + (ms / 1000) + 's')), ms)),
  ]);
}

// ---------------------------------------------------------------- site access

// scripting.executeScript needs a host permission for the tab's origin. That
// permission is only granted when the user adds the site through the popup
// (a click = the user gesture permissions.request requires) — a site typed
// into Settings never gets it. Without it every run dies here, silently as far
// as the page is concerned (nothing can be injected to show an error).
// NOTE: this checks the PAGE host. For the image-host grant patterns see
// originAccessPatterns() in shared/site-access.js — keep the two in sync
// conceptually (page host = exact, image host = base domain).
async function hasPageHostAccess(host) {
  try {
    // permissions.contains needs a granted SUPERSET of the queried pattern:
    // a manifest-baked `http://127.0.0.1/*` grant does NOT satisfy a
    // `*://127.0.0.1/*` query, so also accept the scheme-specific grants.
    if (await chrome.permissions.contains({ origins: [`*://${host}/*`] })) return true;
    if (await chrome.permissions.contains({ origins: [`http://${host}/*`] })) return true;
    return await chrome.permissions.contains({ origins: [`https://${host}/*`] });
  } catch { return true; } // check unavailable: let the injection attempt decide
}

function hostAccessError(host) {
  return new Error(
    `"${host}" is allowed but the extension has no access to it, so nothing can be translated. ` +
    `Open the extension popup on this site and click "Grant access".`);
}

// 2.3.15/1.7.15: Vivaldi auto-translate. The worker can miss
// tabs.onUpdated 'complete' on Vivaldi (it wakes after the page loaded),
// so the page-load listener alone never fires auto there. Fix: register
// the content script for the sites the user already allowed, so the
// browser injects it on page load by itself — the script then wakes the
// worker with ct/auto-start. Registration uses only origins the user
// granted (whitelist hosts, or <all_urls> when allow-all is on): no new
// permission is requested, and a site typed into Settings without a
// grant is skipped (registration needs the host permission).
// registerContentScripts persists across restarts. Sync runs at
// background load, on settings changes, and when the popup/Settings ask
// for it (ct/sync-auto-start) right after a grant, so a reload after
// allowing a site already has the script. Guarded: old Firefox (<128)
// has no registerContentScripts and Orion's layer may not — a missing
// API just means the old behavior. Always unregister-then-register, so
// a removed site or a toggled allow-all cannot leave a stale script.
const AUTO_START_SCRIPT_ID = 'ct-auto-start';
async function syncAutoStartRegistrations() {
  try {
    const sc = chrome.scripting;
    if (!sc || typeof sc.registerContentScripts !== 'function') return;
    const settings = await getSettings();
    const matches = [];
    if (settings.allowAllSites) {
      let ok = false;
      try { ok = await chrome.permissions.contains({ origins: ['<all_urls>'] }); } catch {}
      if (ok) matches.push('<all_urls>');
    } else {
      for (const host of (settings.siteWhitelist || [])) {
        if (!host) continue;
        let ok = false;
        try { ok = await chrome.permissions.contains({ origins: [`*://${host}/*`] }); } catch {}
        if (ok) matches.push(`*://${host}/*`, `*://*.${host}/*`);
      }
    }
    try { await sc.unregisterContentScripts({ ids: [AUTO_START_SCRIPT_ID] }); } catch {}
    if (!matches.length) return;
    // Paths are extension-root-relative for registerContentScripts (unlike
    // executeScript on Firefox, which resolves relative to the calling
    // page — hence the two CONTENT_SCRIPT_FILES variants).
    await sc.registerContentScripts([{
      id: AUTO_START_SCRIPT_ID,
      matches,
      js: ['src/content/content.js'],
      // document_end, not document_idle: the auto-start must fire as soon
      // as the DOM is parsed, not after the browser goes idle (on an
      // image-heavy reader page 'idle' can be seconds after the main
      // picture is visible). The pipeline force-loads images itself, so
      // starting early is safe.
      runAt: 'document_end',
    }]);
  } catch {}
}

// ---------------------------------------------------------------- state
const runs = new Map();          // runId -> {cancelled, tabId, stage}
let currentRun = null;           // {runId, stage, progress} | null
let runSeq = 0;                  // ensures runId uniqueness within the same millisecond

const isCancelled = runId => runs.get(runId)?.cancelled;
function checkCancelled(runId) {
  if (isCancelled(runId)) throw Object.assign(new Error('cancelled'), { cancelled: true });
}

// Long tiled inpaints report per-tile progress straight into the run's
// progress bar. Firefox runs the ML host in-process in this same page
// (background-ff.js); Chrome's offscreen document forwards its reports here
// via ML_INPAINT_PROGRESS (see offscreen-progress.js). Each run registers
// its own updater below.
globalThis.__ctInpaintProgress = (runId, frac) => {
  try {
    const r = runs.get(runId);
    if (r && typeof r.onInpaintProgress === 'function') r.onInpaintProgress(frac);
  } catch { /* progress must never break the pipeline */ }
};

// ML call that honours cancellation: if the ML host aborted the work because
// the run was cancelled (ML_CANCEL), surface the quiet 'cancelled' shape
// instead of a scary host error.
async function callMlChecked(runId, msg) {
  try {
    // tabId rides along so the alarm backup (ml-bridge.js) can tell the
    // tab's pill the run failed even if this worker died mid-call.
    return await callMl(msg, { tabId: runs.get(runId)?.tabId });
  } catch (e) {
    checkCancelled(runId);
    // Retry once on an ML timeout: the host was restarted automatically,
    // so a transient stall (hung WASM session) can succeed on a second
    // attempt. The retry gets attempt 2, so its output keys are namespaced
    // and cannot clobber the timed-out call's late completion. Other
    // errors are not retried — they are likely persistent, and a retry
    // would only double the wait.
    if (e && e.mlTimeout) {
      diagPush(`ML call timed out (${msg.type}) — retrying once.`);
      try {
        return await callMl(msg, { tabId: runs.get(runId)?.tabId });
      } catch (e2) {
        checkCancelled(runId);
        throw e2;
      }
    }
    throw e;
  }
}

// Shared abort sequence for a single run: mark cancelled, abort in-flight
// translation network requests, and kill the Firefox translate worker.
// cancelRunsForTab (tab-scoped, below) and the CANCEL_RUN handler (popup
// Cancel button) both use this so cancellation is complete on every path.
function abortRunResources(id, r) {
  r.cancelled = true;
  // Deliberate drop (Cancel button or superseded run): its later errors
  // must stay quiet. Distinct from the branch-dead abort below, whose
  // original failure must still surface (see branchError).
  r.userCancelled = true;
  // Abort in-flight translation network requests immediately instead of
  // waiting for the stage boundary.
  try { r.abortController?.abort(); } catch {}
  // Firefox: translation runs on a Web Worker — terminate it now instead
  // of waiting for completion or the 60s backstop. The stored killer
  // also rejects the pending promise so `await translateP` doesn't hang.
  try { r.killTranslateWorker?.(Object.assign(new Error('cancelled'), { cancelled: true })); } catch {}
  try { r.translateWorker?.terminate(); } catch {}
  // Also stop in-flight ML work now instead of waiting for the stage to
  // finish (up to 120s for inpaint). See ml-bridge cancelMlForRun: the
  // flag is broadcast to every host, and the worker is terminated when
  // no other run shares it.
  try { cancelMlForRun(id); } catch {}
  // GPU1: the GPU worker is likewise a separate Worker instance, not
  // covered by cancelMlForRun's shared-worker broadcast — terminate
  // it too (reclaims GPU buffers; cancel never falls back to WASM).
  try { cancelGpuInpaint(id); } catch {}
  // GPU1-Chrome: the Chrome GPU worker is owned by the offscreen
  // document, not by this worker — cancel it too (ML_CANCEL to the
  // doc stops the run's GPU loop but keeps the shared worker alive
  // for the next run; the ML_CANCEL broadcast below does the same;
  // both are idempotent).
  try { cancelChromeGpuInpaint(id); } catch {}
}

async function cancelRunsWhere(pred) {
  const ids = [];
  for (const [id, r] of runs) {
    if (pred(r)) {
      abortRunResources(id, r);
      ids.push(id);
    }
  }
  for (const id of ids) {
    try { await callMl({ type: MSG.ML_CANCEL, runId: id }); } catch { /* host may be down */ }
  }
  return ids.length;
}

async function cancelRunsForTab(tabId) {
  return cancelRunsWhere(r => r.tabId === tabId);
}

// One tab at a time (2.3.85, James): cancel the foreground runs on every
// tab except this one. The pre-translate job is never touched — its runs
// entry carries tabId null on purpose, and this predicate skips null.
async function cancelRunsForOtherTabs(tabId) {
  return cancelRunsWhere(r => r.tabId !== null && r.tabId !== undefined && r.tabId !== tabId);
}

// One tab at a time (2.3.85, James): is a foreground run in flight on this
// tab / on another tab? A run counts as foreground when it has a real tab
// id — the pre-translate job's runs entry carries tabId null, so it never
// counts here (it is a background job, not a pipeline the user is
// watching). Cancelled runs stay in the map until their finally deletes
// them, so they are excluded. Finished runs are already deleted by their
// finally. When tabId is unknown (null), any foreground run counts as this
// tab's — the old behaviour, fail open.
function foregroundRunState(tabId) {
  let own = false, other = false;
  for (const [, r] of runs) {
    if (r.cancelled || r.tabId === null || r.tabId === undefined) continue;
    if (tabId == null) own = true;
    else if (r.tabId === tabId) own = true;
    else other = true;
  }
  return { own, other };
}

// ---------------------------------------------------------------- ML host (see ml-bridge.js)
// Chrome runs inference in an offscreen document; Firefox runs it in-process
// in the background page (no offscreen API there).

// ---------------------------------------------------------------- capture
// Capture resolution budget: scale by AREA, not max dimension. A maxDim cap
// crushes long strips (413x15402 -> 69x2560: text becomes undetectable mush
// and the re-render is blurry). 6.5MP keeps strips at full res while still
// bounding huge squares (8000x8000 -> 2560x2560, as before).
const CAPTURE_MAX_PIXELS = 2560 * 2560;
function bitmapToRGBA(bmp, maxPixels = CAPTURE_MAX_PIXELS) {
  const scale = Math.min(1, Math.sqrt(maxPixels / (bmp.width * bmp.height)));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const img = ctx.getImageData(0, 0, w, h);
  return { rgba: img.data, w, h };
}

// Decode a data-URL image into RGBA pixels. The content script transports
// binary as data URL strings because raw ArrayBuffers are silently emptied
// by extension messaging (verified in both directions).
async function dataUrlToRGBA(dataUrl, maxPixels = CAPTURE_MAX_PIXELS) {
  const blob = await (await fetch(dataUrl)).blob();
  return bitmapToRGBA(await createImageBitmap(blob), maxPixels);
}

// Parse a Retry-After header value (seconds or HTTP-date) into ms, or
// null when absent/unparseable. Local copy of the translators.js
// retryAfterMs logic: that helper is not exported, and translators.js
// belongs to another worker — do not import it here. Used for image-host
// 429s only.
function parseRetryAfterMs(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const v = headers.get('Retry-After');
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const secs = Number(s);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  return null;
}

// Image hosts that answered 429, in memory only: hostname -> timestamp ms
// until which the host is rate-limited. Set only from a real 429 (until
// its Retry-After, or the 5 s backoff when none was sent). Never set for
// 5xx, timeouts or decode failures.
const imageHostRateLimited = new Map();

// Name a fetch TypeError (no HTTP status exists): offline is offline, the
// rest is a network/CORS failure — never a grant problem, and never a
// server refusal.
function networkOrCorsError(e) {
  const offline = (typeof navigator !== 'undefined' && navigator.onLine === false);
  const msg = offline
    ? 'could not reach the image host — check the connection'
    : 'network/CORS failure (no HTTP status)';
  const err = new Error(msg + (e && e.message ? ': ' + String(e.message).slice(0, 60) : ''));
  err.isNetworkError = true;
  return err;
}

// Build the error for a non-2xx image response, with the HTTP status on
// it (.status) so callers can branch on 404/429 without parsing text.
// Reads a bounded slice of the error body (first 200 chars, tags
// stripped) into the DIAG log only — never shown to the user, and never
// the full page. A Cloudflare challenge page, a JSON error and a plain
// 404 page then read differently in the log instead of all being bare
// "HTTP <n>".
async function imageHttpError(res) {
  const st = res.status;
  let snippet = '';
  try {
    const text = await res.text();
    if (text) {
      const isHtml = /<!doctype html|<html/i.test(text.slice(0, 200));
      snippet = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (st >= 500 && st < 600 && isHtml) snippet = 'server error page: ' + snippet;
    }
  } catch { /* body unreadable — status alone is enough */ }
  const cfRay = res.headers.get('cf-ray') || '';
  const ra = res.headers.get('retry-after');

  let msg;
  if (st === 404) msg = 'this image link no longer exists on the server (HTTP 404) — reload the page for a fresh link';
  else if (st === 429) msg = 'image host is rate-limiting (HTTP 429), retry later';
  else if (st === 401 || st === 403) msg = 'image download failed: HTTP ' + st;
  else if (st >= 400 && st < 500) msg = `server rejected this image URL (HTTP ${st})`;
  else msg = 'image download failed: HTTP ' + st;
  const e = new Error(msg);
  e.status = st;
  return e;
}

// Direct download of the page image (needs the host permission the popup
// requests on click). Full resolution, no viewport limits.
// Referrer strategy: try WITHOUT a Referer first, then with the page origin.
// Pages with `Referrer-Policy: same-origin` load their cross-origin images
// with NO Referer, and some hosts/WAFs 403 anything else; hosts with
// hotlink protection 403 requests with NO Referer. Trying both covers both
// kinds; only a 403 falls through to the next attempt.
async function fetchImagePixels(url, referrer) {
  // Cookie policy: never send the user's cookies to an arbitrary image host
  // (the 403-retry path can hit attacker-controlled URLs). `credentials:
  // 'include'` is only used when the image host is same-site with the page
  // (same eTLD+1 via baseDomain — covers the page's own CDN subdomains);
  // otherwise default to 'omit'. The request still mimics the page's <img>
  // via the image Accept header and referrer strategy, just without cookies.
  const imgHost = hostOf(url) || '';
  const pageHost = hostOf(referrer) || '';
  const sameSite = !!imgHost && !!pageHost &&
    (imgHost === pageHost || baseDomain(imgHost) === baseDomain(pageHost));
  // Mimic the page's <img> load: image Accept header and the Priority
  // header browsers send on subresource image loads. (Sec-Fetch-Dest can't
  // be forged — fetch always sends `empty`, never `image` — so a strict bot
  // filter can still tell us apart.)
  const base = {
    credentials: sameSite ? 'include' : 'omit',
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      Priority: 'i',
    },
  };
  const tries = [{ ...base, referrerPolicy: 'no-referrer' }];
  if (referrer) tries.push({ ...base, referrer, referrerPolicy: 'strict-origin-when-cross-origin' });
  // 2.2.12: each attempt has an 11s timeout (10x the measured normal
  // download, see CAPTURE_FETCH_TIMEOUT_MS). A server that accepts the
  // connection but never responds used to hang the run at "capture"
  // forever — and user Cancel could not interrupt it, because the hung
  // `await fetch` never resolves and `checkCancelled` is never reached.
  // No event exists: fetch has no progress or stall signal, so an
  // AbortController timer is the only way to bound it.
  // 429 in-run wait cap (5 s): a Retry-After at or under this is waited
  // out once, then the same attempt is retried once. A longer Retry-After
  // fails fast instead of stalling the run — the host is marked
  // rate-limited until that time. With no Retry-After, one 5 s backoff
  // then fail (no retry). 5 s is unverified (audit proposal), not a
  // measured recovery time.
  const RATE_LIMIT_WAIT_CAP_MS = 5000;
  // 5xx/408 retry wait (2 s — inside the audit's 2–5 s range; the exact
  // value is unverified, not measured).
  const TRANSIENT_RETRY_WAIT_MS = 2000;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let lastErr = new Error('image download failed');
  // A host that rate-limited us recently fails fast without another
  // request — retrying into a 429 makes the limit worse.
  const rateHost = hostOf(url) || '';
  const limitedUntil = rateHost ? imageHostRateLimited.get(rateHost) : 0;
  if (limitedUntil && Date.now() < limitedUntil) {
    throw Object.assign(new Error('image host is rate-limiting (HTTP 429), retry later'), { status: 429 });
  }
  for (let vi = 0; vi < tries.length; vi++) {
    const init = tries[vi];
    // One same-variant retry for transient failures (5xx/408, a 429 with
    // a short Retry-After, a truncated body, a network TypeError). The
    // flag is per referrer variant: the with-Referer variant is a
    // different request, not a retry of the no-Referer one.
    let retried = false;
    let fatal = null;
    while (true) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, CAPTURE_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, { ...init, signal: ctrl.signal });
        // Redirect: log only. Real reader CDNs redirect across
        // subdomains, so a cross-origin redirect is not refused here
        // (unverified whether any host needs blocking — log, do not block).

        if (!res.ok) {
          lastErr = await imageHttpError(res);
          const st = res.status;
          if (st === 429) {
            const ra = parseRetryAfterMs(res.headers);
            if (ra != null && ra <= RATE_LIMIT_WAIT_CAP_MS && !retried) {
              retried = true;
              diagPush(`  Download rate-limited (HTTP 429) — waiting ${Math.round(ra / 1000)}s, then retrying once.`);
              await wait(ra);
              continue;
            }
            if (ra != null) {
              if (rateHost) imageHostRateLimited.set(rateHost, Date.now() + ra);
              diagPush(`  Download rate-limited (HTTP 429), wait ${Math.round(ra / 1000)}s is too long — failing fast.`);
            } else {
              diagPush('  Download rate-limited (HTTP 429), no wait time given — one 5s backoff, then failing.');
              await wait(5000);
              if (rateHost) imageHostRateLimited.set(rateHost, Date.now() + 5000);
            }
            fatal = lastErr;
            break;
          }
          if (st === 408 || (st >= 500 && st < 600)) {
            if (!retried) {
              retried = true;
              diagPush(`  Download failed (HTTP ${st}) — retrying once after ${TRANSIENT_RETRY_WAIT_MS / 1000}s.`);
              await wait(TRANSIENT_RETRY_WAIT_MS);
              continue;
            }
            // Retried once already: fall through to the next tier (the
            // error path / fallback tab), not the other referrer variant
            // — a server error will not clear with a different Referer.
            fatal = lastErr;
            break;
          }
          // 401 gets the same second referrer attempt as 403 (a
          // missing/incorrect Referer or cookie can cause 401 on some
          // hosts — unverified, so the attempt is cheap and safe).
          if (st === 401 || st === 403) break;
          // Permanent 4xx (400/404/414/...) and anything else: no retry,
          // no second referrer attempt.
          fatal = lastErr;
          break;
        }
        // 2xx: check Content-Type before spending the decode budget — an
        // HTML/JSON error page served as 200 fails here, not at decode.
        const ctype = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (ctype && !/^image\//.test(ctype) && ctype !== 'application/octet-stream') {
          fatal = Object.assign(new Error(`server returned ${ctype}, not an image`), { status: res.status });
          break;
        }
        const expectedLen = Number(res.headers.get('content-length') || 0) || null;
        // The body read shares the same 11s timeout: a server that sends
        // headers then stalls mid-body used to hang the run at
        // "capture-worker-fetch" forever — the old code cleared the timer
        // as soon as headers arrived, so res.blob() had no timeout at all.
        // Aborting the signal rejects the in-flight blob() read.
        const blob = await res.blob();
        if (!blob.size) {
          fatal = Object.assign(new Error('empty response body'), { status: res.status });
          break;
        }
        if (expectedLen && blob.size < expectedLen) {
          diagPush(`  Download cut off early (expected ${expectedLen} bytes, got ${blob.size}).`);
          if (!retried) { retried = true; continue; }
          fatal = Object.assign(new Error(`truncated response body (expected ${expectedLen} got ${blob.size})`), { status: res.status });
          break;
        }
        return { ...bitmapToRGBA(await createImageBitmap(blob)), bytes: blob.size };
      } catch (e) {
        if (e && e.name === 'AbortError') {
          // Timeout of try 1 must NOT forfeit try 2 (a stalled
          // no-Referer request must not lose the with-Referer attempt):
          // break to the next referrer variant instead of throwing.
          lastErr = Object.assign(new Error('image download timed out after ' + (CAPTURE_FETCH_TIMEOUT_MS / 1000) + 's'), { timedOut: true });
          break;
        }
        // A fetch TypeError is a network/CORS failure (no HTTP status).
        // Guard on the message so a TypeError from decode is not
        // misread as a network failure: Chrome says "Failed to fetch",
        // Firefox "NetworkError when attempting to fetch resource.",
        // Safari "Load failed".
        if (e instanceof TypeError && /failed to fetch|networkerror|network error|load failed/i.test(String((e && e.message) || ''))) {
          if (!retried) {
            retried = true;
            diagPush('  Download failed (network/CORS) — retrying once after 1s.');
            await wait(1000);
            continue;
          }
          // Retried once already: fail. The other referrer variant
          // would hit the same network/CORS failure, so it is not tried.
          lastErr = networkOrCorsError(e);
          fatal = lastErr;
          break;
        }
        // Anything else (decode failure, or a terminal error thrown
        // above): fail the fetch. A decode/empty-body failure after
        // bytes arrived never marks the host dead.
        lastErr = e;
        fatal = e;
        break;
      } finally {
        clearTimeout(timer);
      }
    }
    if (fatal) throw fatal;
    // 401/403 only: wait 1 s before the second (with-Referer) attempt —
    // a WAF that just refused the no-Referer request may still be
    // deciding. This wait sits AFTER try 1 already failed, so the common
    // path (try 1 succeeds) never reaches it and is not slowed.
    if (vi + 1 < tries.length && lastErr && (lastErr.status === 401 || lastErr.status === 403)) {
      await wait(1000);
    }
  }
  throw lastErr;
}

// Pipeline input: the page's own picture — never a screenshot of the page.
// Tier 1a: pixels straight from the page canvas (works when the image host
// sends CORS headers). Tier 1b: download inside the page (content script),
// so the request carries the page's real referrer policy and cookies —
// exactly like the page's own <img> load. Tier 1c: background fetch of the
// image URL (needs the host permission the popup requests on click). If none
// can read the picture we throw an actionable error; there is no screenshot
// fallback.
// Multi-pic: at most this many pictures per run (James's old design used 50).
const MAX_IMAGES_PER_PAGE = 50;

// Inventory: every picture on the page worth translating, top to bottom.
// Manual send (right-click): this exact image, bypassing the minimum size.
// Otherwise the page's own inventory (ct/list-images), filtered by the
// minimum image size (displayed, the default — 500 — everywhere, James's
// order), capped at MAX_IMAGES_PER_PAGE. Returns {images, skipped, ignored}.
async function getPipelineImages(tabId, settings, tabUrl, opts = {}) {
  const manualSrc = opts.srcUrl || null;
  const minSize = settings.minImageSize || 460;
  if (manualSrc) {
    let info = null;
    try { info = (await withTimeout(chrome.tabs.sendMessage(tabId, { type: 'ct/find-image-by-src', srcUrl: manualSrc }), MSG_TIMEOUT_MS, 'find-image-by-src'))?.image || null; }
    catch { info = null; }
    if (!info || !info.src) {
      throw new Error('could not find that image on the page anymore — it may have been removed or the page reloaded');
    }
    return { images: [info], skipped: [], ignored: 0 };
  }
  let list = [], total = 0;
  // Hosts of every big picture (for the run header) and any of them
  // missing host permission. Computed here, logged once in the run
  // header — not as a separate inventory line.
  let inventoryHosts = [], inventoryMissing = [];
  try {
    const r = await withTimeout(chrome.tabs.sendMessage(tabId, { type: 'ct/list-images' }), DATA_TIMEOUT_MS, 'list-images');
    list = r?.images || [];
    total = r?.total || list.length;
    // Content-script inventory note: only present when big pictures were
    // left out of the inventory (e.g. still loading). Plain, one line.
    if (!opts.quiet && r?.diag) {
      const d = String(r.diag).trim();
      if (d) diagPush(d);
    }
    // Permission for EVERY big picture's host — including the ones that did
    // not make the inventory — so a missing grant on a 403 CDN host is
    // visible in the same log, not just the gate's view of the listed ones.
    // Skipped on quiet (pipelined) polls: the run polls every ~500ms while
    // pictures load, and repeating the full diag + host check each time
    // would flood the log buffer. The full inventory diag runs once, on
    // the run's inventory call below.
    if (!opts.quiet && Array.isArray(r?.bigSrcs) && r.bigSrcs.length) {
      try {
        inventoryMissing = await checkImageHostPermissions(r.bigSrcs.map(src => ({ src })));
        inventoryHosts = [...new Set(r.bigSrcs.map(s => { try { return new URL(s).hostname.toLowerCase(); } catch { return ''; } }).filter(Boolean))];
      } catch (e) { diagPush('Host permission check failed: ' + String((e && e.message) || e).slice(0, 80)); }
    }
  } catch { list = []; }
  if (!list.length) {
    throw new Error('no pictures found on this page — the extension translates the page\'s own pictures, not a screenshot of the page');
  }
  // The minimum-size gate uses the DISPLAYED size (what the user sees) —
  // collectPageImages returns the on-screen w/h. A big file shown small does
  // not run. This is the only size gate: the capture tiers do not re-check
  // the file size, so a picture that displays big runs even if its file is small.
  const eligible = list.filter(im => Math.max(im.w || 0, im.h || 0) >= minSize);
  const skipped = [];
  // Per-picture skip detail (not just the aggregate count): the run-end
  // accounting lists EVERY picture not translated, with its size, host and
  // reason — so a run that misses 6 of 30 names all 6, not just the ones
  // that failed capture. Written at the end of the run, so it can never be
  // pushed out of the log buffer.
  const skippedDetail = [];
  for (const im of list) {
    if (Math.max(im.w || 0, im.h || 0) < minSize) skippedDetail.push({ w: im.w || 0, h: im.h || 0, src: im.src || '', reason: `below min size ${minSize}px` });
  }
  if (list.length - eligible.length) skipped.push(`${list.length - eligible.length} below the minimum image size of ${minSize}px (change it in Settings)`);
  const picked = eligible.slice(0, MAX_IMAGES_PER_PAGE);
  for (const im of eligible.slice(MAX_IMAGES_PER_PAGE)) skippedDetail.push({ w: im.w || 0, h: im.h || 0, src: im.src || '', reason: `over ${MAX_IMAGES_PER_PAGE}-image per-run cap` });
  if (eligible.length - picked.length) skipped.push(`${eligible.length - picked.length} over the ${MAX_IMAGES_PER_PAGE}-image per-run cap`);
  if (!picked.length) throw new Error(`no usable pictures on this page (${skipped.join('; ')}).`);
  // Pictures the inventory never considered (icons, spacers, hidden or
  // still-loading <img>) — reported so untranslated ones are accounted for.
  return { images: picked, skipped, skippedDetail, ignored: Math.max(0, total - list.length), inventoryHosts, inventoryMissing, inventoryTotal: total };
}

// One picture's pixels, loaded just before its stages run and released after.
// Tier 1a: pixels straight from the page canvas by uid. Skipped when the page
// already shows our translated render (info.translated): the canvas would hand
// back the translated pixels, so the pipeline would translate the translation
// and the page-cache key would never match. The download tiers below fetch the
// ORIGINAL url the content script reported, so pixels and cache key stay
// correct and revisits hit the cache.
// Tier 1b: download inside the PAGE (content script) — the browser applies the
// page's real referrer policy and cookies, exactly like the page's own <img>
// load. Some image hosts / WAFs (e.g. Cloudflare) 403 the service worker's
// fetch because its Referer and Sec-Fetch-* headers don't match what the page
// itself sends; this tier is indistinguishable from the page loading the image
// itself. The extension's host permissions let the content script read the
// cross-origin response bytes.
// Tier 1c: background fetch of the image URL (for an already-translated page
// this is the ORIGINAL url, so the pixels — and the cache key — are the
// originals, not the render).
// Capture diagnostic: one entry per tier attempted ({tier, ms, ok, bytes?, error?}).
// Returned to the caller, which logs it — the log then names the path
// (page-canvas = local, page/worker-fetch = network download) and how long
// each attempt took, so a slow capture can be read as internet or local
// without a debug-mode run.
// Page-fetch failures, per image host: the page's fetch is blocked by
// CORS on that host, so it fails the same way every time (~800ms wasted
// per capture on nhentai before worker-fetch succeeds). Remember a
// failure for 30 min, then retry in case the site changed. In-memory
// only — a background restart clears it, which is fine (one slow
// capture re-learns it).
const pageFetchDead = new Map(); // hostname -> timestamp ms of last page-fetch failure
const PAGE_FETCH_DEAD_MS = 30 * 60 * 1000;
// Short skip (5 min) for transient page-fetch failures (429/5xx/timeout).
// 5 min is unverified — a judgment call, not a measured recovery time —
// so it is short on purpose: a transient failure must not poison the
// host for 30 min.
const pageFetchDeadShort = new Map(); // hostname -> timestamp ms
const PAGE_FETCH_DEAD_SHORT_MS = 5 * 60 * 1000;
// Consecutive same-status streak per host: one 404 does not poison the
// host, two in a row does (the "repeated same-status failure" rule).
const pageFetchFailStreak = new Map(); // hostname -> { status, n }

// Classify a page-fetch failure before deciding whether the host is
// skipped next time. Only a CORS/TypeError failure (the expected
// signature of a CORS-blocked host) or a repeated same-status failure
// earns the 30-min skip; transient 429/5xx/timeout earns a short 5-min
// skip; a decode/empty-body/wrong-type failure after bytes arrived never
// marks the host dead. Logs the reason either way.
function markPageFetchDead(host, errText) {
  const text = String(errText || '');
  const m = /HTTP (\d{3})/.exec(text);
  const status = m ? Number(m[1]) : 0;
  if (/could not reach the image host/i.test(text)) {
    diagPush(`Page fetch on ${host} failed (offline/network) — host not blocked.`);
    return;
  }
  if (/Failed to fetch|network\/CORS failure|TypeError/i.test(text)) {
    pageFetchDead.set(host, Date.now());
    diagPush(`Page fetch on ${host} blocked (CORS) — skipping it for 30 min.`);
    return;
  }
  if (status === 429 || (status >= 500 && status < 600) || /timed out after 11s/.test(text)) {
    pageFetchDeadShort.set(host, Date.now());
    diagPush(`Page fetch on ${host} skipped for 5 min (${status || 'timeout'}).`);
    return;
  }
  if (status) {
    const prev = pageFetchFailStreak.get(host);
    const n = (prev && prev.status === status) ? prev.n + 1 : 1;
    pageFetchFailStreak.set(host, { status, n });
    if (n >= 2) {
      pageFetchDead.set(host, Date.now());
      diagPush(`Page fetch on ${host} keeps failing (HTTP ${status}) — skipping it for 30 min.`);
    }
    return;
  }
  // Decode / empty-body / wrong-type failures after bytes arrived: never
  // mark the host dead.
  diagPush(`Page fetch on ${host} failed — host not blocked (${text.slice(0, 60)}).`);
}

// Per-image overall cap across capture tiers (120 s). 120 s is
// unverified — a judgment call, not a measured latency — it bounds the
// worst case (30 s page-canvas + 30 s page-fetch + 60 s worker-fetch)
// so one picture cannot stall the run for ~250 s. Checked between tiers
// only; an in-flight tier is not aborted by it. The 30 s per-attempt
// timers are unchanged (James's design).
const LOAD_IMAGE_OVERALL_CAP_MS = 120000;

// Decoded-dimension sanity: after a network decode, reject a picture
// whose decoded size disagrees wildly with the size the page reported
// for it (e.g. a 1x1 tracking pixel served instead of the large picture
// the page shows). Only applies when the page reported a real (non-zero)
// size. Bitmaps are downscaled to 6.5 MP first, so the comparison uses
// ratios, not absolute pixels: a huge original legitimately decodes
// smaller. No SVG special case (unverified — see audit). Returns an
// error string, or null when the sizes agree.
function decodedSizeMismatch(w, h, info) {
  const ew = (info && (info.nw || info.w)) || 0;
  const eh = (info && (info.nh || info.h)) || 0;
  if (!ew || !eh) return null;
  const expMax = Math.max(ew, eh);
  const decMax = Math.max(w, h);
  if (expMax < 120 || decMax === 0) return null;
  const areaRatio = (w * h) / (ew * eh);
  if (decMax <= 2 || (decMax < expMax * 0.1 && areaRatio < 0.001)) {
    return `server returned a different image than the page shows (decoded ${w}x${h}, page shows ${ew}x${eh})`;
  }
  return null;
}

async function loadPipelineImagePixels(tabId, info, settings, tabUrl, opts = {}) {
  const failures = [];
  const attempts = [];
  const capStart = performance.now();
  const capExceeded = () => (performance.now() - capStart) >= LOAD_IMAGE_OVERALL_CAP_MS;
  // Name the tier that consumed the budget, for the log.
  const capFailure = () => {
    const worst = attempts.reduce((a, b) => ((b.ms || 0) > (a.ms || 0) ? b : a), { tier: 'page-canvas', ms: 0 });
    return `overall 120s capture budget exhausted (consumed mostly by ${worst.tier}, ${worst.ms}ms)`;
  };
  if (!info.translated) {
    const a0 = performance.now();
    if (opts.runId) persistDiagStage(opts.runId, 'capture-page-canvas');
    try {
      // 2.2.12: race the content-script round trip against a 500ms timeout
      // (10x the ~50ms normal local read, see CAPTURE_CANVAS_TIMEOUT_MS) —
      // a hung content script used to hang the run at "capture" forever.
      // The wait is for the content script to read the page canvas and
      // reply with pixels; sendMessage is the only channel and it can hang
      // without settling, so a race is the only guard — there is no
      // canvas-ready event.
      const p = await Promise.race([
        chrome.tabs.sendMessage(tabId,
          info.uid ? { type: 'ct/get-image-pixels-by-uid', uid: info.uid } : { type: 'ct/get-image-pixels', srcUrl: info.src }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('page canvas timed out after ' + CAPTURE_CANVAS_TIMEOUT_MS + 'ms')), CAPTURE_CANVAS_TIMEOUT_MS)),
      ]);
      if (p && p.ok && typeof p.dataUrl === 'string') {
        const { rgba, w, h } = await dataUrlToRGBA(p.dataUrl);
        // A blank (all-black) capture fed to the detector yields 2 bogus
        // full-page boxes, so validate the pixels before accepting them.
        if (meanBrightness(rgba) >= 0.004) {
          attempts.push({ tier: 'page-canvas', ms: Math.round(performance.now() - a0), ok: true });
          return { rgba, w, h, mode: 'replace', tier: 'page-canvas', attempts };
        }
        failures.push('page canvas returned blank pixels');
      } else {
        failures.push('page canvas: ' + String((p && p.error) || 'no pixels').slice(0, 100));
      }
    } catch (e) { failures.push('page canvas: ' + String((e && e.message) || e).slice(0, 100)); }
    attempts.push({ tier: 'page-canvas', ms: Math.round(performance.now() - a0), ok: false, error: failures[failures.length - 1] });
  } else {
    failures.push('page canvas skipped (already showing the translated render)');
  }
  const b0 = performance.now();
  // Skip page-fetch for a host that failed it recently (see pageFetchDead
  // above): the page's fetch is CORS-blocked there, so it always fails
  // after ~800ms. Go straight to worker-fetch instead.
  let fetchHost = '';
  try { fetchHost = new URL(info.src).hostname.toLowerCase(); } catch {}
  const deadSince = fetchHost ? pageFetchDead.get(fetchHost) : 0;
  const deadShortSince = fetchHost ? pageFetchDeadShort.get(fetchHost) : 0;
  const skipPageFetch = !!(deadSince && (Date.now() - deadSince) < PAGE_FETCH_DEAD_MS) ||
    !!(deadShortSince && (Date.now() - deadShortSince) < PAGE_FETCH_DEAD_SHORT_MS);
  if (capExceeded()) {
    failures.push('page download skipped (' + capFailure() + ')');
    attempts.push({ tier: 'page-fetch', ms: 0, ok: false, error: 'page download skipped (overall capture budget exhausted)' });
  } else if (skipPageFetch) {
    failures.push('page download skipped (host failed recently)');
    attempts.push({ tier: 'page-fetch', ms: 0, ok: false, error: 'page download skipped (host failed recently)' });
  } else {
  if (opts.runId) persistDiagStage(opts.runId, 'capture-page-fetch');
  try {
    // 2.2.12: race the content-script round trip against an 11s timeout
    // (10x the ~1.1s normal download, see CAPTURE_FETCH_TIMEOUT_MS). The
    // wait is for the page to download the image bytes and reply with a
    // data URL; the page fetch is the only way to get the page's real
    // referrer/cookies, and sendMessage can hang without settling, so a
    // race is the only guard.
    const f = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'ct/fetch-image-bytes', srcUrl: info.src }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('page download timed out after ' + (CAPTURE_FETCH_TIMEOUT_MS / 1000) + 's')), CAPTURE_FETCH_TIMEOUT_MS)),
    ]);
    if (f && f.ok && typeof f.dataUrl === 'string' && f.dataUrl.startsWith('data:')) {
      const { rgba, w, h } = await dataUrlToRGBA(f.dataUrl);
      const mismatch = decodedSizeMismatch(w, h, info);
      if (mismatch) {
        failures.push('page download: ' + mismatch);
        diagPush('  ' + mismatch + ' (page fetch).');
      } else {
        const b64 = f.dataUrl.split(',')[1] || '';
        // The host works now — clear any earlier failure so it is not skipped.
        if (fetchHost) { pageFetchDead.delete(fetchHost); pageFetchDeadShort.delete(fetchHost); pageFetchFailStreak.delete(fetchHost); }
        attempts.push({ tier: 'page-fetch', ms: Math.round(performance.now() - b0), ok: true, bytes: Math.round(b64.length * 3 / 4) });
        return { rgba, w, h, mode: 'replace', tier: 'page-fetch', attempts };
      }
    } else {
      failures.push('page download: ' + String((f && f.error) || 'no bytes').slice(0, 100));
    }
  } catch (e) { failures.push('page download: ' + String((e && e.message) || e).slice(0, 100)); }
  attempts.push({ tier: 'page-fetch', ms: Math.round(performance.now() - b0), ok: false, error: failures[failures.length - 1] });
  // Remember the failure so the next capture from this host skips it —
  // but only for the failures that justify a skip (see markPageFetchDead):
  // a CORS/TypeError failure, a repeated same-status failure, or (short)
  // a transient 429/5xx/timeout. Never a decode/empty-body failure.
  if (fetchHost) markPageFetchDead(fetchHost, failures[failures.length - 1]);
  }
  const c0 = performance.now();
  if (opts.runId) persistDiagStage(opts.runId, 'capture-worker-fetch');
  if (capExceeded()) {
    failures.push('download skipped (' + capFailure() + ')');
    attempts.push({ tier: 'worker-fetch', ms: 0, ok: false, error: 'download skipped (overall capture budget exhausted)' });
  } else {
  try {
    const { rgba, w, h, bytes } = await fetchImagePixels(info.src, tabUrl);
    const mismatch = decodedSizeMismatch(w, h, info);
    if (mismatch) {
      failures.push('download: ' + mismatch);
      diagPush('  ' + mismatch + ' (download).');
    } else {
      attempts.push({ tier: 'worker-fetch', ms: Math.round(performance.now() - c0), ok: true, bytes });
      return { rgba, w, h, mode: 'replace', tier: 'worker-fetch', attempts };
    }
  } catch (e) { failures.push('download: ' + String((e && e.message) || e).slice(0, 120)); }
  attempts.push({ tier: 'worker-fetch', ms: Math.round(performance.now() - c0), ok: false, error: failures[failures.length - 1] });
  }
  let imgHost = '';
  try { imgHost = new URL(info.src).hostname; } catch { /* keep it empty */ }
  // Name the base domain, not the exact host: on sites with random per-visit
  // image subdomains the exact hostname is meaningless to the user, and the
  // grant the popup requests covers the base.
  const imgHostLabel = imgHost ? displayHost(imgHost) : '';
  // An HTTP status means the request went out — access was granted and the
  // SERVER refused it. Don't send the user on another grant-access errand.
  const failText = failures.join('; ');
  const serverRefused = /HTTP (401|403)/.test(failText);
  // Distinct failures that are NOT permission problems, so no grant
  // prompt: a dead link (404), a rate limit (429), a permanent rejection
  // (400/413/414/418/...), a CORS/network failure with no HTTP status, or
  // being offline. A 5xx or a timeout is not a permission problem either.
  const notFound = /HTTP 404/.test(failText);
  const rateLimited = /HTTP 429/.test(failText);
  const permanent4xx = /HTTP (400|405|413|414|418)/.test(failText);
  const corsFailure = /network\/CORS failure|Failed to fetch/i.test(failText);
  const offlineFailure = /could not reach the image host/i.test(failText);
  const serverError = /HTTP 5\d\d/.test(failText);
  const timedOut = /timed out after (500ms|11s)/.test(failText);
  // A revisit of an already-translated page downloads the ORIGINAL url the
  // content script stashed. Some hosts hand out expiring image links
  // (keystamp=...), so on revisit that saved link is dead — the fix is a
  // page reload for a fresh link, not another access grant.
  const staleOriginal = !!info.translated;
  const grantable = !serverRefused && !notFound && !rateLimited && !permanent4xx && !corsFailure && !offlineFailure && !serverError && !timedOut && !!imgHost && !staleOriginal;
  // For auto-translate 403s (not manual sends — those trigger the automatic
  // background-tab fallback), lead with the bypass: right-click the picture
  // and use "Send to Comic Translate 4 Free". Localized via i18n (the menu
  // label itself is localized), with a blank line after the tip.
  const bypassTip = (serverRefused && !opts.srcUrl)
    ? (chrome.i18n.getMessage('err_bypass_tip',
        [chrome.i18n.getMessage('ctx_send_image') || 'Send to Comic Translate 4 Free'])
        || 'Tip: right-click the picture and choose "Send to Comic Translate 4 Free" to bypass this block.')
      + '\n\n'
    : '';
  const explanation =
    notFound
      ? `This image link no longer exists on the server (HTTP 404) — reload the page for a fresh link.`
      : rateLimited
        ? `The image host is rate-limiting downloads (HTTP 429) — wait a bit and retry later.`
        : permanent4xx
          ? `The image server rejected this image URL — reload the page for a fresh link and try again.`
          : offlineFailure
            ? `Could not reach the image host — check the connection and try again.`
            : corsFailure
              ? `The download was blocked before it got an answer (cross-origin restrictions or a network failure), not by a missing permission. Reload the page and try again; if it persists, the host may block automated downloads.`
              : serverError
                ? `The image server returned an error — wait a bit and retry later.`
                : timedOut
                  ? `The image download timed out — the server may be slow; wait a bit and retry.`
                  : serverRefused
                    ? `The image server${imgHostLabel ? ' (' + imgHostLabel + ')' : ''} refused the download${staleOriginal ? ' — the saved image link has likely expired' : ' even though access was granted'}. The page's own download attempt was blocked before it got an answer (cross-origin restrictions), and the background download got an HTTP refusal — this points to bot protection (e.g. Cloudflare) telling our automated download apart from the page's own image load, rather than a permission problem. This can be intermittent (works sometimes, blocked other times). Reload the page and try again; if it persists, wait a bit and retry — repeated attempts can trigger rate limiting.`
                    : imgHost
                      ? staleOriginal
                        ? `The picture lives on ${imgHostLabel} but its saved image link no longer loads (these links expire, or the access grant was revoked) — reload the page for a fresh link and translate again; if the popup offers it, grant access to ${imgHostLabel} first.`
                        : `The picture is hosted on ${imgHostLabel} — click "Allow ${imgHostLabel}" in the notice on the page, or grant it from the extension popup ("Grant access to ${imgHostLabel}").`
                      : `If the picture is hosted on another site, open the extension popup on this page and click "Grant access".`;
  const err = new Error(
    bypassTip +
    `couldn't read the page's picture (${failures.join('; ')}). ` +
    explanation);
  // The pill renders an "Allow <host>" button for this case (see broadcastError).
  if (grantable) err.grantHost = imgHost;
  // A server refusal (401/403) can be worked around by opening the image URL
  // directly in a tab: there it's same-origin, so the canvas tier reads it
  // with no download. The manual-send handler uses this for an automatic
  // background-tab fallback. A timeout of both worker-fetch attempts, or a
  // 5xx after its retry, falls through to the tab the same way (a tab load
  // uses a different network path). Never for 404 (dead link) or 429
  // (the tab would hit the same rate limit).
  const workerTimedOut = /download: image download timed out after 11s/.test(failText);
  const workerServerError = /download: image download failed: HTTP 5\d\d/.test(failText);
  if ((serverRefused || workerTimedOut || workerServerError) && info.src) err.fallbackUrl = info.src;
  throw err;
}

// ---------------------------------------------------------------- pixel helpers
function cropRGBA(src, sw, x1, y1, x2, y2) {
  const w = x2 - x1, h = y2 - y1;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    out.set(src.subarray(((y1 + y) * sw + x1) * 4, ((y1 + y) * sw + x2) * 4), y * w * 4);
  }
  return { data: out, w, h };
}

function cropMask1(src, sw, x1, y1, x2, y2) {
  const w = x2 - x1, h = y2 - y1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(src.subarray((y1 + y) * sw + x1, (y1 + y) * sw + x2), y * w);
  return out;
}

function pasteRGBA(dst, dw, src, x, y) {
  const w = src.w, h = src.h;
  for (let r = 0; r < h; r++) {
    dst.set(src.data.subarray(r * w * 4, (r + 1) * w * 4), ((y + r) * dw + x) * 4);
  }
}

// Mask-aware paste: only copies pixels where mask is non-zero.
// Used for inpaint compositing to avoid LaMa's slight alterations to
// unmasked areas (which cause visible blur when the whole patch is pasted).
function pasteMaskedRGBA(dst, dw, src, mask, x, y) {
  const w = src.w, h = src.h;
  for (let r = 0; r < h; r++) {
    const dstRow = (y + r) * dw;
    const srcRow = r * w;
    for (let c = 0; c < w; c++) {
      if (mask.data[srcRow + c]) {
        const di = (dstRow + x + c) * 4, si = (srcRow + c) * 4;
        dst[di] = src.data[si];
        dst[di + 1] = src.data[si + 1];
        dst[di + 2] = src.data[si + 2];
        dst[di + 3] = src.data[si + 3];
      }
    }
  }
}

function cssColor(r, g, b) {
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

// Foreground (text) color: mean color of the minority-polarity pixels in the box.
function extractFgColor(rgba, w, xyxy) {
  const [x1, y1, x2, y2] = xyxy.map(v => Math.max(0, Math.round(v)));
  let dark = 0, light = 0, dr = 0, dg = 0, db = 0, lr = 0, lg = 0, lb = 0;
  for (let y = y1; y < y2; y += 2) {
    for (let x = x1; x < x2; x += 2) {
      const o = (y * w + x) * 4;
      const lum = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
      if (lum < 128) { dark++; dr += rgba[o]; dg += rgba[o + 1]; db += rgba[o + 2]; }
      else { light++; lr += rgba[o]; lg += rgba[o + 1]; lb += rgba[o + 2]; }
    }
  }
  if (dark === 0 && light === 0) return '#000000';
  // text is usually the minority polarity
  if (dark <= light && dark > 0) return cssColor(dr / dark, dg / dark, db / dark);
  if (light > 0) return cssColor(lr / light, lg / light, lb / light);
  return cssColor(dr / dark, dg / dark, db / dark);
}

// Crop bounds for OCR: text box expanded 5%, bubble fallback (port of the
// Python adjust_text_line_coordinates usage in the OCR stage of
// ogkalu2/comic-translate, Apache License 2.0).
function cropForBlock(rgba, pw, ph, xyxy, bubbleXyxy) {
  const box = xyxy || bubbleXyxy;
  if (!box) return null;
  const [x1, y1, x2, y2] = box;
  const ex = ((x2 - x1) * 5) / 100, ey = ((y2 - y1) * 5) / 100;
  const cx1 = Math.max(0, Math.floor(x1 - ex)), cy1 = Math.max(0, Math.floor(y1 - ey));
  const cx2 = Math.min(pw, Math.ceil(x2 + ex)), cy2 = Math.min(ph, Math.ceil(y2 + ey));
  if (cx2 <= cx1 || cy2 <= cy1) return null;
  return { ...cropRGBA(rgba, pw, cx1, cy1, cx2, cy2), x: cx1, y: cy1 };
}

// ---------------------------------------------------------------- blocks
function buildBlocks(detections, w, h, rgba, settings) {
  const bubbles = detections.filter(d => d.label === 0).map(d => d.xyxy);
  const textBoxes = detections.filter(d => d.label !== 0).map(d => d.xyxy);
  const merged = mergeOverlappingBoxes(textBoxes, 0.3);
  const blocks = merged.map(xyxy => {
    const b = makeTextBlock({ xyxy: clampBox(xyxy, w, h) });
    const cx = (xyxy[0] + xyxy[2]) / 2, cy = (xyxy[1] + xyxy[3]) / 2;
    let best = null, bestScore = 0;
    for (const bb of bubbles) {
      const inside = cx >= bb[0] && cx <= bb[2] && cy >= bb[1] && cy <= bb[3];
      const score = (inside ? 1 : 0) + boxIoU(xyxy, bb);
      if (score > bestScore) { bestScore = score; best = bb; }
    }
    if (best && bestScore > 0.05) {
      b.text_class = 'text_bubble';
      b.bubble_xyxy = best;
    }
    b.font_color = extractFgColor(rgba, w, b.xyxy);
    b.source_lang = settings.sourceLang;
    b.target_lang = settings.targetLang;
    return b;
  });
  // Bubbles whose text the detector missed: a bubble with no text box
  // inside it still contains words (the detector found the outline but
  // missed the text). Without this, that text is never translated — on
  // image 18/18 the detector found 21 boxes (12 bubbles + 9 texts) but
  // only 9 blocks, because 6 bubbles had no text box inside them.
  // Promote each such bubble to a text_bubble block. The OCR crop must
  // be tight around the WORDS, not the whole bubble: the full bubble
  // box is mostly empty space and border, so Baberu sees the text
  // small and misreads it (low-score text already reads poorly, and a
  // loose crop makes it worse — misread words cannot be translated, so
  // the output comes out mixed English and Chinese). Tighten the block
  // to the text content inside the bubble (mask.js content detection,
  // which already excludes the bubble outline); fall back to the full
  // bubble box if no content is found. A bubble that already has a
  // text box is skipped, so its text is not duplicated. If OCR finds
  // no text in a promoted bubble (false-positive outline), the block
  // is skipped downstream by the empty-text guard.
  let promotedCount = 0;
  for (const bb of bubbles) {
    const covered = blocks.some(b => {
      const [x1, y1, x2, y2] = b.xyxy;
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      return cx >= bb[0] && cx <= bb[2] && cy >= bb[1] && cy <= bb[3];
    });
    if (covered) continue;
    const tight = tightenBubbleToText(rgba, w, h, bb);
    const b = makeTextBlock({ xyxy: clampBox(tight || bb, w, h) });
    b.text_class = 'text_bubble';
    b.bubble_xyxy = bb;
    b.font_color = extractFgColor(rgba, w, b.xyxy);
    b.source_lang = settings.sourceLang;
    b.target_lang = settings.targetLang;
    blocks.push(b);
    promotedCount++;
  }
  const out = sortBlocks(blocks, true);
  // How many blocks came from bubbles with no text box (0 on a page
  // where detection is already good — the promotion is a no-op there).
  // The run logs it so over-firing on other pages is visible, not silent.
  out.promotedCount = promotedCount;
  return out;
}

// Tighten a bubble box to the words inside it (page coords), for the
// OCR crop of a promoted bubble. Uses the mask module's content
// detection (Otsu + connected components), which drops the bubble
// outline (it touches the crop edge and is one large component) and
// keeps the text. Returns null when no content is found.
function tightenBubbleToText(rgba, w, h, bubbleXyxy) {
  const [bx1, by1, bx2, by2] = bubbleXyxy.map(v => Math.round(v));
  const cx1 = Math.max(0, bx1), cy1 = Math.max(0, by1);
  const cx2 = Math.min(w, bx2), cy2 = Math.min(h, by2);
  if (cx2 <= cx1 || cy2 <= cy1) return null;
  const crop = cropRGBA(rgba, w, cx1, cy1, cx2, cy2);
  const mask = detectContentMaskInBbox(crop.data, crop.w, crop.h);
  let x1 = crop.w, y1 = crop.h, x2 = -1, y2 = -1;
  for (let y = 0; y < crop.h; y++) {
    for (let x = 0; x < crop.w; x++) {
      if (!mask[y * crop.w + x]) continue;
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
    }
  }
  if (x2 < 0) return null;
  return [cx1 + x1, cy1 + y1, cx1 + x2 + 1, cy1 + y2 + 1];
}

// ---------------------------------------------------------------- debug helpers
async function rgbaToDataURL(rgba, w, h, maxDim = 420) {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const dw = Math.max(1, Math.round(w * scale)), dh = Math.max(1, Math.round(h * scale));
  // Canvas guard: the full-res src canvas can exceed browser limits on long
  // strips (e.g. 413x15402) even when the output is small. Downscale the
  // working buffer first if needed.
  const gs = renderScale(w, h);
  let gw = w, gh = h, grasp = rgba;
  if (gs < 1) {
    gw = Math.max(1, Math.round(w * gs)); gh = Math.max(1, Math.round(h * gs));
    grasp = resizeBilinearRGBA(rgba, w, h, gw, gh);
  }
  const src = makeCanvas(gw, gh);
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(grasp), gw, gh), 0, 0);
  const c = makeCanvas(dw, dh);
  c.getContext('2d').drawImage(src, 0, 0, dw, dh);
  const blob = await canvasToBlob(c, WEBP_TYPE, WEBP_QUALITY);
  const buf = await blob.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return 'data:image/webp;base64,' + btoa(bin);
}

function maskToRGBA(mask, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = mask[i] ? 255 : 0;
    out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
  }
  return out;
}

async function emitDebug(runId, tabId, settings, stage, payload) {
  if (!settings.debugMode) return;
  try {
    // Race against a timeout: on some browsers tabs.sendMessage can hang
    // (neither resolve nor reject), which would stall the pipeline — the
    // mask branch must resolve so inpaint can start.
    // 5s is the MSG_TIMEOUT_MS value, inlined here instead of using
    // withTimeout (same hang, same guard, older code). No event exists —
    // the reply is the only signal the panel got the stage.
    await Promise.race([
      chrome.tabs.sendMessage(tabId, {
        type: MSG.DEBUG_STAGE, runId, stage, payload, debug: true,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('emitDebug timeout')), 5000)),
    ]);
  } catch { /* content script not there yet or send hung */ }
}

// DIAGNOSTIC (temporary): send the panel log WITHOUT the debugMode
// gate (emitDebug returns early when debugMode is off, so the user
// would never see it). Same 5s race + swallow as emitDebug, plus
// debug:true so the panel auto-shows and renders this tab at once.
// This function itself stays ungated: failure and recovery paths call
// it precisely because the user needs the log then. The SUCCESS path
// gates before calling (see there, 1.4.0 M1), so non-debug users do
// not get a panel pop on every good run.
async function sendDiagLog(tabId, runId) {
  try {
    // Same 5s race as emitDebug (the MSG_TIMEOUT_MS value, inlined): a
    // hung sendMessage must not stall the failure/recovery path that calls
    // this. No event exists — the reply is the only signal.
    await Promise.race([
      chrome.tabs.sendMessage(tabId, {
        type: MSG.DEBUG_STAGE, runId, stage: 'diaglog',
        payload: { title: 'Diagnostic log', log: diagLogBuf.join('\n') },
        debug: true,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('sendDiagLog timeout')), 5000)),
    ]);
  } catch { /* content script not there yet or send hung */ }
}

// FIX1: persisted run records (Firefox background-death recovery).
// The in-memory runs map dies with the background page, so a run in flight
// when the background died would leave its pill frozen forever. A minimal
// record per run lives in storage.local (already permitted; storage.session
// availability on Firefox 115 is uncertain, so local is the safe choice).
// Written on run start + on stage change only (not on every progress tick,
// so a 100-tile inpaint costs ~8 writes, not 100+). Removed on run end
// (finally) and by the alarm/orphan recovery paths. Best-effort: every
// call is fire-and-forget and never throws into the pipeline. Single-run
// assumption: concurrent runs share one map key, so two runs starting in
// the same instant could clobber each other (read-modify-write); the
// common case (one run at a time) is exact.
const ACTIVE_RUNS_KEY = 'ct-active-runs';
const persistedStageByRun = new Map(); // runId -> last stage written
// 2.1.58: serialize ALL run-record writes through one promise chain.
// persistRunRecord / clearRunRecord read the whole ct-active-runs object,
// change one run, and write it back — fire-and-forget, with no lock. Two
// writes overlapping lose one update. The 2.1.57 line that re-stores the
// page address passes a url but NO resume count: if it read before the
// run-start write landed, it wrote the count back as 0 while keeping the
// page, so the max-2 loop guard never tripped and the run resumed forever.
// Queued writes run one at a time, in call order, so a later write always
// sees the earlier write's result.
let recordQueue = Promise.resolve();
function queueRecordOp(op) {
  const p = recordQueue.then(op, op);
  recordQueue = p.catch(() => {});
  return p;
}
// extra carries auto-resume info at run start ({ resumes, url }); later
// stage updates preserve it from the previous record so it is not lost.
// resumes = how many times this run has already been auto-resumed (loop
// guard); url = the tab's address at run start (same-page check).
async function persistRunRecord(runId, tabId, stage, extra) {
  return queueRecordOp(async () => {
    try {
      const all = (await chrome.storage.local.get(ACTIVE_RUNS_KEY))[ACTIVE_RUNS_KEY] || {};
      const prev = all[runId];
      all[runId] = {
        tabId, stage,
        startedAt: (prev && prev.startedAt) || Date.now(),
        updatedAt: Date.now(),
        resumes: (extra && extra.resumes != null) ? extra.resumes : ((prev && prev.resumes) || 0),
        url: (extra && extra.url) || (prev && prev.url) || '',
      };
      await chrome.storage.local.set({ [ACTIVE_RUNS_KEY]: all });
      persistedStageByRun.set(runId, stage);
    } catch {}
  });
}
async function clearRunRecord(runId) {
  return queueRecordOp(async () => {
    try {
      const all = (await chrome.storage.local.get(ACTIVE_RUNS_KEY))[ACTIVE_RUNS_KEY] || {};
      if (all[runId]) {
        delete all[runId];
        await chrome.storage.local.set({ [ACTIVE_RUNS_KEY]: all });
      }
      persistedStageByRun.delete(runId);
    } catch {}
  });
}

// Crash-stage diagnostic (2.3.11): record the fine stage in the persisted
// run record (chrome.storage.local survives a process kill) WITHOUT
// touching the pill — setProgress would also send a pill update, and these
// micro-stages are for the orphan-recovery "died at stage X" line only.
// Called before each heavy step in runPipeline and before each capture
// attempt, so a death leaves the exact step instead of the run-start
// default 'capture'. Fire-and-forget, deduped like setProgress.
function persistDiagStage(runId, stage) {
  const t = runs.get(runId)?.tabId;
  if (t != null && persistedStageByRun.get(runId) !== stage) persistRunRecord(runId, t, stage);
}

// FIX2: run-scoped keep-alive. Firefox MV3 background.page is a
// non-persistent event page (MDN: `persistent` defaults to false in
// MV3 and setting it true is an error; the page may be unloaded when
// idle). Two runs in a row died mid-inpaint (~24s in) and were only
// recovered by FIX1 — prevention is needed, with recovery staying as
// backup. Two mechanisms, both opened on run start and closed in
// runPipeline finally (success, failure, cancel), so they never hold
// the background alive forever:
// (1) A long-lived runtime Port held open for the run. An open port is
// the standard event-page keep-alive: the page counts as active while
// any port is open. Self-connect (background connects to itself) with
// a top-level onConnect listener that accepts the keepalive name —
// without a listener the port is invalid immediately.
// (2) A periodic alarm (1 min) named ct-keepalive:<runId>. Each fire
// dispatches an event (activity) and, if the page was unloaded anyway,
// wakes a fresh page (which then runs FIX1 recovery instead of
// freezing). ml-bridge's onAlarm ignores non-ct-ml: names, and this
// listener ignores ct-ml: names, so neither interferes with ML alarms.
// Neither mechanism touches ML, timers, or recovery paths.
const keepAlivePorts = new Map(); // runId -> Port (outgoing end)
const keepAliveIncoming = new Set(); // incoming ends, held so they are not GC'd
function keepAliveStart(runId) {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.connect) {
      const port = chrome.runtime.connect({ name: 'ct-keepalive' });
      port.onDisconnect.addListener(() => {
        keepAlivePorts.delete(runId);
      });
      keepAlivePorts.set(runId, port);
    }
  } catch {}
  try {
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      const p = chrome.alarms.create('ct-keepalive:' + runId, { periodInMinutes: 1 });
      if (p && p.catch) p.catch(() => {});
    }
  } catch {}
}
function keepAliveStop(runId) {
  try {
    const port = keepAlivePorts.get(runId);
    if (port) { try { port.disconnect(); } catch {} keepAlivePorts.delete(runId); }
  } catch {}
  try {
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      const p = chrome.alarms.clear('ct-keepalive:' + runId);
      if (p && p.catch) p.catch(() => {});
    }
  } catch {}
}
// FIX3: also accept the content-script-held keep-alive Port
// (ct-keepalive-tab). FIX2's self-connect Port (both ends in the
// background) did not prevent a third mid-inpaint death, so the hold
// must come from a DIFFERENT context: the tab's content script, which
// opens it on run-started and heartbeats every 20s. An open channel to
// another context, with messages across it, is the documented activity
// that keeps an event page / worker alive; a silent self-connect is
// not. Held in keepAliveIncoming so it is not GC'd. Heartbeats are
// activity only — never logged per-beat (that would flood the panel
// log) and never touch runs or ML.
// 2.0.24: also accept the benchmark keep-alive Port
// (ct-bench-keepalive). The offscreen doc opens it only while the
// thread benchmark measures and heartbeats every 20s, so the doc is
// not frozen/throttled mid-measurement; it disconnects when the bench
// ends or is cancelled. Same rule as the run keep-alive: a Port from a
// different context, with messages across it.
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onConnect) {
  chrome.runtime.onConnect.addListener((port) => {
    if (!port || (port.name !== 'ct-keepalive' && port.name !== 'ct-keepalive-tab' && port.name !== 'ct-bench-keepalive')) return;
    keepAliveIncoming.add(port);
    port.onDisconnect.addListener(() => { keepAliveIncoming.delete(port); });
    try { port.onMessage.addListener(() => { /* heartbeat activity only */ }); } catch {}
  });
}
if (typeof chrome !== 'undefined' && chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || !alarm.name) return;
    if (alarm.name === MODEL_WATCHDOG_ALARM) {
      // Model-download watchdog (2.3.2): restart a download that died
      // outside a run. Fire-and-forget; the tick guards itself.
      try { const p = modelWatchdogTick(); if (p && p.catch) p.catch(() => {}); } catch {}
      return;
    }
    if (!alarm.name.startsWith('ct-keepalive:')) return;
    // No-op: the dispatch itself is the activity signal. Never touch
    // runs, ML, or recovery here.
  });
}

// DIAGNOSTIC (temporary): count every failed progress send to the tab,
// so the log shows the TRUE total (not a pasted sample) plus when the
// tab last responded. Broadcast failures are not logged: the popup is
// normally closed, so those failures are expected, not a signal.
let diagProgressFails = 0;
let diagProgressLastOk = 0;
let lastProgressFailRunId = null;
function setProgress(runId, stage, progress, extra = {}) {
  currentRun = { runId, stage, progress };
  // FIX1: persist stage changes only (not every progress tick, and never
  // 'done'/'cancelled' — the finally below clears the record anyway).
  // Fire-and-forget: never blocks progress updates.
  if (stage !== 'done' && stage !== 'cancelled' && persistedStageByRun.get(runId) !== stage) {
    const t = runs.get(runId)?.tabId;
    if (t != null) persistRunRecord(runId, t, stage);
  }
  // 2.3.85 (one tab at a time): the run's tab rides along so the popup can
  // tell "my tab's run" from "another tab's run" without a round-trip.
  const tabId = runs.get(runId)?.tabId;
  const payload = { type: MSG.RUN_PROGRESS, runId, stage, progress, ...extra,
    ...(tabId != null ? { tabId } : {}) };
  chrome.runtime.sendMessage(payload).catch(() => {});
  // Targeted copy for the tab's status pill (broadcasts reach every tab).
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, { ...payload, direct: true }).then(
      () => { diagProgressLastOk = Date.now(); },
      () => {
        diagProgressFails++;
        // One line per run: a dead content script fails EVERY progress
        // tick (~7 stages x N pictures of the same line). The first
        // failure is the actionable fact ("progress sends are failing
        // for this run"); the total is in the run-end line. Log only
        // the first failure of each run.
        if (lastProgressFailRunId !== runId) {
          lastProgressFailRunId = runId;
          diagPush('Progress update could not be sent (content script unreachable) — first failure this run, stage ' + stage + '.');
        }
      }
    );
  }
}

function broadcastError(runId, error, grant) {
  // The failed run's image hosts are kept on currentRun so the popup can
  // offer a one-click grant for ALL of them at once (ct/get-status ->
  // refreshSite). One ask, every pic: the grant must cover every host the
  // run needs, not just the first one, or the user has to grant again for
  // the next host. grant.hosts is the full list; grant.host is the first
  // (kept for the single-host fallback and the label).
  currentRun = { runId, stage: 'error', progress: 0, error,
    ...(grant && grant.host ? { grantHost: grant.host, grantLabel: grant.label || grant.host } : {}),
    ...(grant && Array.isArray(grant.hosts) && grant.hosts.length ? { grantHosts: grant.hosts } : {}) };
  const payload = { type: MSG.RUN_PROGRESS, runId, stage: 'error', error };
  if (grant && grant.host) { payload.grantHost = grant.host; payload.grantLabel = grant.label || grant.host; }
  if (grant && Array.isArray(grant.hosts) && grant.hosts.length) payload.grantHosts = grant.hosts;
  // 2.3.85 (one tab at a time): the run's tab rides along, same as setProgress.
  const errTabId = runs.get(runId)?.tabId;
  if (errTabId != null) payload.tabId = errTabId;
  chrome.runtime.sendMessage(payload).catch(() => {});
  const tabId = errTabId;
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, { ...payload, direct: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- page cache
// Incognito tabs never touch the page cache — no reads, no writes. When the
// tab can't be inspected we err on the side of not caching.
async function isIncognitoTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!tab.incognito;
  } catch {
    return true;
  }
}

// Send the render payload to the page and verify it landed. Shared by the
// live pipeline and the page-cache hit path (which re-sends a stored entry).
// extra.srcUrl names the exact <img> by URL; extra.uid names it by uid.
// The render tries uid first, then srcUrl — the uid is a DOM attribute
// lost if the site swaps the <img> between inventory and render, but the
// src survives the swap. The no-uid/no-src auto path replaces the
// detected main image.
async function sendRender(tabId, runId, mode, imageDataUrl, w, h, blocks, timings, debug, extra = {}) {
  // DIAGNOSTIC (temporary): delivery is the decisive step — log the
  // attempt, any send failure, and the reply, so the log shows whether
  // the run finished inpaint and failed only at delivery.
  let renderRes;
  try {
    renderRes = await withTimeout(chrome.tabs.sendMessage(tabId, {
      type: MSG.RENDER, runId, mode,
      imageDataUrl, width: w, height: h,
      blocks, timings, debug,
      ...(extra.srcUrl ? { srcUrl: extra.srcUrl } : {}),
      ...(extra.uid ? { uid: extra.uid } : {}),
    }), DATA_TIMEOUT_MS, 'render');
  } catch (e) {
    diagPush('Could not send the finished picture to the page: ' + String((e && e.message) || e).slice(0, 120));
    throw e;
  }
  // Surface a content-side render failure instead of silently reporting
  // "done" while the original image is still on the page.
  if (!renderRes || renderRes.ok === false) {
    throw new Error('render failed: ' + String((renderRes && renderRes.error) || 'no response from page'));
  }
  if (renderRes.replaced === false) {
    // 2.2.18: the page says why the put-back missed (uid asked for, page
    // URL, pictures on the page now, their uids) — log it before throwing,
    // so the next failure explains itself in the diag log.
    if (renderRes.diag) diagPush(String(renderRes.diag).slice(0, 800));
    throw new Error('render failed: could not find the page image to replace');
  }
  return renderRes;
}

// Cache hit: re-send the stored translated page. The runId is the one the
// page already knows (RUN_STARTED went out before capture), and the message
// shape is identical to the live pipeline's — the content script can't tell
// the difference, and re-composites the text with the CURRENT font settings.
// Tier-1 hit with a new targetLang: translate the OCR'd blocks only,
// skipping detect/OCR/inpaint entirely. Stores the Tier-2 entry for next time.
// uid names the <img> for the multi-pic render; onProgress maps the stage
// onto this image's slice of the run (defaults to the whole run).
async function renderFromTier1(tabId, runId, tier1Entry, tier2Key, settings, timings, srcUrl, rgba, w, h, mode, tier, uid, onProgress) {
  checkCancelled(runId);
  const progress = onProgress || ((stage, frac, extra) => setProgress(runId, stage, frac, extra || {}));
  progress('translate', 0.5);
  const t0 = performance.now();
  // Blocks from Tier-1 have OCR text but no translations.
  const blocks = tier1Entry.blocks.map(b => ({ ...b }));
  // Source language was resolved at Tier-1 write time — reuse it verbatim
  // instead of re-detecting (G10). Entries written before this field existed
  // fall back to detection.
  let effSettings = settings;
  if (settings.sourceLang === 'auto') {
    const resolved = tier1Entry.sourceLang || detectPageLang(blocks.map(b => b.text));
    effSettings = { ...settings, sourceLang: resolved || 'ja' };
  }
  // Failover is free, not a Pro feature (2026-11-26): never gated by
  // the daily limit, so a Gemini failure always falls over to Google.
  const runController = runs.get(runId)?.abortController || new AbortController();
  // Tier-1 translate needs its own 30s abort (the full pipeline has one;
  // this path had none, so a stalled backend hung forever). Local
  // controller: aborting the run's controller would trip the
  // checkCancelled below even after a rescued translation.
  const translateController = new AbortController();
  if (runController.signal?.aborted) { try { translateController.abort(); } catch {} }
  else runController.signal?.addEventListener('abort', () => { try { translateController.abort(); } catch {} }, { once: true });
  // 30s aborts the CURRENT translate attempt so translateBlocks can fail
  // over to the next backend — it matches the deadlineMs=30000 argument
  // passed to translateBlocks below (translators.js), so the abort and the
  // callee's own deadline agree. No event exists: a stalled backend gives
  // no signal, so an AbortController timer is the only way to bound it.
  const tier1TimeoutId = setTimeout(() => { try { translateController.abort(); } catch {} }, 30000);
  const failoverNotice = (p) => {
    if (p && p.failoverFrom && p.failoverTo) {
      logFailoverLine(p);
      chrome.tabs.sendMessage(tabId, {
        type: MSG.PILL_NOTICE,
        text: `Engine ${p.failoverFrom} failed — retrying with ${p.failoverTo}`,
        sticky: false,
      }).catch(() => {});
    }
  };
  let translated;
  try {
    translated = await translateBlocks(blocks, effSettings, failoverNotice, translateController.signal, 30000, () => runs.get(runId)?.cancelled === true);
  } finally {
    clearTimeout(tier1TimeoutId);
  }
  checkCancelled(runId);
  blocks.forEach((b, i) => { b.translation = translated[i]; });
  const translateMs = Math.round(performance.now() - t0);
  timings.translate = translateMs;
  // Store Tier-2 entry for next time.
  try {
    if (!(await isIncognitoTab(tabId))) {
      // 2.3.6: never store an all-empty tier-2 entry — it would count
      // as a hit (an empty array is truthy) and re-render the original.
      if (Array.isArray(translated) && translated.some(t => typeof t === 'string' && t.trim())) {
        await pageCachePut(tier2Key, {
          translations: translated,
          targetLang: settings.targetLang,
          backend: settings.translationBackend,
        });
      }
    }
  } catch (e) {
    console.warn('[ct] tier-2 cache write failed:', String((e && e.message) || e).slice(0, 120));
  }
  // Render with the translated blocks.
  const entry = { ...tier1Entry, blocks };
  return await renderFromPageCache(tabId, runId, entry, settings, timings, srcUrl, { uid, onProgress: progress });
}

async function renderFromPageCache(tabId, runId, entry, settings, timings, srcUrl, opts = {}) {
  checkCancelled(runId);
  // Multi-pic: the per-image loop owns progress (including the final
  // 'done'), so this only reports its own stage. The doneExtra is returned
  // for the loop to use on the final 'done'.
  const progress = opts.onProgress || ((stage, frac, extra) => setProgress(runId, stage, frac, extra || {}));
  progress('render', 0.96);
  const t0 = performance.now();
  await sendRender(tabId, runId, entry.mode || 'replace',
    entry.imageDataUrl, entry.width, entry.height, entry.blocks,
    { ...timings, cacheHit: Math.round(performance.now() - t0) },
    settings.debugMode, { srcUrl, uid: opts.uid });
  // Label the pill so a cache serve never looks like a fresh translate:
  // full hits say "from cache"; Tier-1-after-translate says which backend
  // actually translated (its blocks carry backendUsed from translateBlocks).
  // Without this, a cached run with Google blocked looked exactly like
  // Google working despite the block.
  const doneExtra = opts.fromCache
    ? { cached: true }
    : { backendLabel: BACKEND_SHORT_LABEL[entry.blocks?.[0]?.backendUsed || settings.translationBackend] || settings.translationBackend };
  return { runId, ok: true, cached: !!opts.fromCache, doneExtra };
}

// ---------------------------------------------------------------- pipeline
// opts.srcUrl: manual send (right-click) — translate this exact image,
// bypassing the minimum image size. Otherwise the auto path.
// ---------------------------------------------------------------- auto-download models (2.2.2)
// Models (~350MB) download themselves: once right after install (and
// after an update that changes them), and again at run start if they are
// still missing — the run waits with progress in the pill instead of
// failing. The Settings "Download all models" button stays as a manual
// fallback. Downloads run in the ML host (offscreen doc on Chrome,
// background page on Firefox), so a service-worker shutdown can't kill
// them mid-stream. Completion is read from IndexedDB, which is the
// source of truth — never the callMl result, whose 90s timeout fires
// on slow downloads that are still progressing.
const modelDownloadInflight = new Map(); // fileId -> { startedAt }
// TODO: 15 min overall cap / 3 min stall have no measured basis in the
// code — no download-time data for slow connections is recorded anywhere.
// If a legitimately slow download ever hits the 15-min cap, the number to
// revisit is here. The 3-min stall used to assume a healthy download
// writes a chunk at least that often (also unmeasured); it now applies to
// live byte progress (ct/model-progress broadcasts), not chunk flushes.
const MODEL_DOWNLOAD_WAIT_MS = 15 * 60 * 1000; // overall cap for one run's wait
const MODEL_DOWNLOAD_STALL_MS = 3 * 60 * 1000; // no progress for this long = dead download, restart it

// Phase-2 (internet audit 3c): live byte progress + restart/give-up state.
// The offscreen doc broadcasts ct/model-progress {loaded, total} on every
// read, {error} on failure and {done:true} on completion (offscreen.js
// ML_DOWNLOAD), and the SW listens for it below (MODEL_PROGRESS branch in
// the runtime.onMessage listener). Chunk counts in IndexedDB only move
// every 8 MB, so they cannot tell a slow download from a dead one — the
// live byte counts can. modelDownloadErrors records the last hard failure
// per file, so a permanent 404 is never retried in a loop and a 429/5xx
// backs off instead of restarting at once.
const modelByteProgress = new Map(); // fileId -> { loaded, at } (live bytes)
const modelDownloadErrors = new Map(); // fileId -> { error, at } (last hard failure)
const modelDownloadGaveUp = new Map(); // fileId -> { reason, at } (watchdog gave up this lifetime)
const modelWatchdogRestarts = new Map(); // fileId -> consecutive restarts without progress
const MODEL_MAX_RESTARTS = 3; // restarts per file per run, then give up
const MODEL_TRANSIENT_BACKOFF_MS = MODEL_DOWNLOAD_STALL_MS; // 3-min floor after a 429/5xx

// Permanent download failures (model-specs.js throws these verbatim):
// the file is gone from Hugging Face, so no retry in this run will help.
function isPermanentModelDownloadError(text) {
  return typeof text === 'string' && text.includes('model file not found on Hugging Face');
}
// Transient server-side failures: 429 (rate-limited) or 5xx. The
// in-function wait already ran inside downloadFileToIdb; the SW must not
// restart into the same limit at once.
function isTransientModelDownloadError(text) {
  if (typeof text !== 'string') return false;
  if (text.includes('rate-limited, retry later')) return true;
  return /download failed \(HTTP 5\d\d\)/.test(text);
}
function recordModelDownloadError(fileId, err) {
  const text = String((err && err.message) || err || '').slice(0, 300);
  if (!fileId || !text) return;
  const prev = modelDownloadErrors.get(fileId);
  // Log a failure once per distinct text — a retry that fails the same way
  // updates the timestamp (which drives the back-off) without spamming.
  if (!prev || prev.error !== text) diagPush('Model download failed (' + fileId + '): ' + text);
  modelDownloadErrors.set(fileId, { error: text, at: Date.now() });
}
// Shared restart/give-up decision for waitForModels (counts: its own
// per-run map) and the watchdog (counts: modelWatchdogRestarts, gaveUp:
// modelDownloadGaveUp). Returns 'restart' when the caller should trigger
// a fresh download, 'backoff' when a 429/5xx failure is too recent to
// retry yet (not counted as a restart), 'gaveup' when the file must not
// be restarted again in this run.
function modelRestartDecision(fileId, counts, gaveUp) {
  if (gaveUp.has(fileId)) return 'gaveup';
  const err = modelDownloadErrors.get(fileId);
  if (err && err.error) {
    if (isPermanentModelDownloadError(err.error)) {
      gaveUp.set(fileId, { reason: err.error, permanent: true, at: Date.now() });
      return 'gaveup';
    }
    if (isTransientModelDownloadError(err.error) && Date.now() - err.at < MODEL_TRANSIENT_BACKOFF_MS) return 'backoff';
  }
  const n = (counts.get(fileId) || 0) + 1;
  if (n > MODEL_MAX_RESTARTS) {
    gaveUp.set(fileId, { reason: 'model download failed after 3 restarts — check the connection', at: Date.now() });
    return 'gaveup';
  }
  counts.set(fileId, n);
  return 'restart';
}
// What waitForModels throws when a file may not be restarted again: the
// permanent error text when that is the cause, else the 3-restart text.
function modelWaitGiveUpMessage(fileId, gaveUp) {
  const rec = gaveUp.get(fileId) || {};
  if (rec.permanent && rec.reason) return rec.reason;
  return 'model download failed after 3 restarts — check the connection (' + fileId + ')';
}
// Live bytes for a file: the broadcast byte count when it is ahead of the
// IndexedDB chunk count, else the chunk count. A stale broadcast (download
// died before its next progress event) cannot hide a real stall for more
// than one window — it stops advancing, and the stall timer fires.
function modelLiveLoaded(fileId, chunkLoaded) {
  const live = modelByteProgress.get(fileId);
  if (live && typeof live.loaded === 'number') return Math.max(chunkLoaded, live.loaded);
  return chunkLoaded;
}

// Phase-2 (audit 3c): the in-flight mark is in-memory only, so a
// service-worker restart loses it and a second download can start for
// the same file. Persist it in chrome.storage.local — NOT the ct-db
// models store: getModelDownloadState counts chunk keys by prefix, and a
// new record type in that store would risk confusing that count. The
// in-function resume makes a duplicate start non-corrupting (same chunk
// keys, same bytes), so a stale mark only costs bandwidth — and every
// stale mark self-heals: the stall branches restart a file whose mark is
// older than 3 min. Restore keeps the original startedAt, so the 3-min
// window is measured from the real start, not the restart.
const MODEL_DL_INFLIGHT_KEY = 'ctModelDlInflight'; // chrome.storage.local: { fileId: startedAt }
async function persistModelDownloadInflight() {
  try {
    const rec = {};
    for (const [id, v] of modelDownloadInflight) rec[id] = (v && v.startedAt) || Date.now();
    if (Object.keys(rec).length) await chrome.storage.local.set({ [MODEL_DL_INFLIGHT_KEY]: rec });
    else await chrome.storage.local.remove(MODEL_DL_INFLIGHT_KEY);
  } catch { /* storage write failed — the in-memory mark still guards this lifetime */ }
}
async function restoreModelDownloadInflight() {
  try {
    const saved = await chrome.storage.local.get(MODEL_DL_INFLIGHT_KEY);
    const rec = (saved && saved[MODEL_DL_INFLIGHT_KEY]) || {};
    // Only restore marks for files still missing — a completed file's
    // stale mark must not linger.
    let state = null;
    try { state = await getModelDownloadState(); } catch { /* restore without the filter */ }
    const missing = new Set(((state && state.missing) || []).map(f => f.id));
    for (const [id, startedAt] of Object.entries(rec)) {
      if (state && !missing.has(id)) continue;
      if (!modelDownloadInflight.has(id)) modelDownloadInflight.set(id, { startedAt: Number(startedAt) || Date.now() });
    }
  } catch { /* a failed restore just means the first tick may duplicate a download; resume makes that safe */ }
}

// Fire-and-forget one file's download. Returns the host call's promise,
// or null if it is already going (same SW lifetime) — a duplicate start
// would write the same chunk keys twice and corrupt the file. The
// promise's rejection is swallowed here on purpose: callMl times out at
// 90s on slow downloads that are still progressing in the ML host, so a
// rejection must NOT always clear the in-flight mark. But a failure before
// the first chunk is written does clear it (see below) — otherwise the
// wait loop skips the file forever and no retry ever starts.
function triggerModelDownload(fileId) {
  // The watchdog alarm lives as long as any download is outstanding, so
  // a download that dies later still gets retried (2.3.2).
  ensureModelWatchdog();
  if (modelDownloadInflight.has(fileId)) return null;
  modelDownloadInflight.set(fileId, { startedAt: Date.now() });
  persistModelDownloadInflight();
  const p = ensureMlHost().then(
    () => callMl({ type: MSG.ML_DOWNLOAD, fileId }),
    (e) => { modelDownloadInflight.delete(fileId); persistModelDownloadInflight(); throw e; },
  );
  p.then(() => { modelDownloadInflight.delete(fileId); persistModelDownloadInflight(); }, (e) => {
    // 2.3.4: a hard failure (the worker replied with an error) means the
    // download is really dead — clear the mark at once so the next run
    // start or watchdog tick restarts it immediately. The old code only
    // cleared when nothing was written, so a file that died after writing
    // chunks kept its mark and no retry ever started in this lifetime —
    // the Firefox test showed only 1 of 3 model groups auto-downloaded
    // after a cancelled run. Only a timeout keeps the mark: the worker
    // may still be progressing past the SW-side timer (callMl sets
    // e.mlTimeout), and the stall branches — not this handler — own
    // restarting those. A duplicate start is harmless: both fetch the
    // same bytes and write the same chunk keys, and the state check
    // re-downloads a manifest whose chunks are missing.
    if (!e || !e.mlTimeout) { modelDownloadInflight.delete(fileId); recordModelDownloadError(fileId, e); persistModelDownloadInflight(); return; }
    getModelDownloadState().then(state => {
      const f = state.files.find(x => x.id === fileId);
      if (f && !f.done && !f.started) { modelDownloadInflight.delete(fileId); persistModelDownloadInflight(); }
    }).catch(() => {});
  });
  return p;
}

// Start downloads for every missing file that is not already in flight.
// 2.3.4: a file with chunks but no live download is dead (its run was
// cancelled, or the background died) — restart it at once instead of
// leaving it for the 3-minute stall branches. triggerModelDownload
// no-ops when the file is already in flight, so a live download is
// never duplicated.
async function autoDownloadMissingModels() {
  let state;
  try { state = await getModelDownloadState(); } catch { return; }
  for (const f of state.missing) {
    if (f.started && modelDownloadInflight.has(f.id)) continue;
    try { triggerModelDownload(f.id); } catch {}
  }
}

// Wait until all models are downloaded, showing progress in the pill.
// Throws if the wait is cancelled, stalls, or hits the overall cap.
async function waitForModels(runId) {
  await autoDownloadMissingModels();
  const t0 = Date.now();
  // 2.2.12: stall is tracked PER FILE, not on the aggregate byte sum.
  // The old aggregate check false-fired on a healthy slow file (its own
  // bytes grew, but slower than the 3-min window) and masked a genuinely
  // stalled file when another file was still progressing. A file is
  // stalled only when its OWN loaded bytes have not changed for 3 min.
  const perFileProgress = new Map(); // fileId -> { loaded, at }
  const restartCounts = new Map(); // fileId -> restarts this wait (fresh per run)
  const gaveUp = new Map(); // fileId -> { reason, at } (permanent / capped this wait)
  for (;;) {
    if (runs.get(runId)?.cancelled) throw new Error('cancelled');
    let state;
    try { state = await getModelDownloadState(); } catch (e) {
      throw new Error('could not check downloaded models: ' + String((e && e.message) || e).slice(0, 100));
    }
    if (!state.missing.length) {
      for (const f of state.files) modelDownloadInflight.delete(f.id);
      persistModelDownloadInflight();
      return;
    }
    // A file that finished clears its per-run state, so a later stall of
    // another file never inherits a stale error or count.
    for (const f of state.files) {
      if (f.done) {
        restartCounts.delete(f.id);
        gaveUp.delete(f.id);
        modelDownloadErrors.delete(f.id);
        modelByteProgress.delete(f.id);
      }
    }
    // Start anything not downloading yet (covers a failed ensureMlHost
    // at the top, and a download that died before writing a chunk).
    // 2.2.19: a file that never started can stall too — its trigger may
    // have died silently before the first chunk (host failed, promise
    // never settled). The old code only restarted STARTED files, so an
    // unstarted file spun until the 15-minute timeout. Restart it after
    // the same stall window (startedAt is when this attempt began); a
    // duplicate start is harmless (same chunk keys).
    for (const f of state.missing) {
      if (f.started) continue;
      const inflight = modelDownloadInflight.get(f.id);
      if (!inflight) {
        // A file with a recorded hard failure is a re-trigger, not a first
        // attempt: a 404 used to re-trigger every second until the 15-min
        // cap. Gate it — permanent gives up at once, 429/5xx backs off.
        if (modelDownloadErrors.has(f.id)) {
          const decision = modelRestartDecision(f.id, restartCounts, gaveUp);
          if (decision === 'gaveup') throw new Error(modelWaitGiveUpMessage(f.id, gaveUp));
          if (decision === 'backoff') continue;
        }
        triggerModelDownload(f.id); continue;
      }
      if (Date.now() - (inflight.startedAt || 0) > MODEL_DOWNLOAD_STALL_MS) {
        const decision = modelRestartDecision(f.id, restartCounts, gaveUp);
        if (decision === 'gaveup') throw new Error(modelWaitGiveUpMessage(f.id, gaveUp));
        if (decision === 'backoff') continue;
        diagPush('Model download never started, restarting: ' + f.id);
        modelDownloadInflight.delete(f.id);
        triggerModelDownload(f.id);
      }
    }
    const frac = state.totalBytes ? state.loadedBytes / state.totalBytes : 0;
    setProgress(runId, 'downloading', frac);
    const now = Date.now();
    const stalled = [];
    for (const f of state.missing) {
      if (!f.started) continue;
      // Live bytes, not chunk counts: a healthy download slower than
      // ~45 KB/s writes no 8 MB chunk inside the 3-min window, but its
      // byte count still grows — that is progress, not a stall.
      const loaded = modelLiveLoaded(f.id, f.loaded);
      const prev = perFileProgress.get(f.id);
      if (!prev || prev.loaded !== loaded) {
        perFileProgress.set(f.id, { loaded, at: now });
      } else if (now - prev.at > MODEL_DOWNLOAD_STALL_MS) {
        stalled.push(f);
      }
    }
    if (stalled.length) {
      // Stalled: a partial file whose bytes stopped growing belongs to a
      // dead download (host died, network dropped). Restart it so the wait
      // can make progress instead of hanging — but do NOT prune the kept
      // chunks: the next attempt resumes from them (downloadFileToIdb
      // resumes from kept chunks). Pruning here used to throw away good
      // bytes and restart from 0, and it undercut the in-function 429
      // wait, which can run 3 min while this branch fired at the same
      // 3 min. Only the files that are actually stalled are restarted —
      // a slow file that is still progressing is left alone.
      for (const f of stalled) {
        const decision = modelRestartDecision(f.id, restartCounts, gaveUp);
        if (decision === 'gaveup') throw new Error(modelWaitGiveUpMessage(f.id, gaveUp));
        if (decision === 'backoff') continue; // keep perFileProgress: restart promptly once the back-off expires
        diagPush('Model download stalled, restarting: ' + f.id);
        modelDownloadInflight.delete(f.id);
        perFileProgress.delete(f.id);
        triggerModelDownload(f.id);
      }
    }
    if (Date.now() - t0 > MODEL_DOWNLOAD_WAIT_MS) {
      throw new Error('model download timed out after 15 minutes — check the connection, or open Settings → Models and tap "Download all models".');
    }
    // 1s poll: the only way to observe download completion. Live byte
    // progress arrives via ct/model-progress broadcasts (see the
    // MODEL_PROGRESS branch), so a slow download that has not flushed an
    // 8 MB chunk in 3 min is no longer mistaken for stalled; the chunk
    // counts are only the fallback when no broadcast arrived. 1s keeps
    // the pill percent fresh without hammering IndexedDB; the stall/cap
    // checks above, not the poll interval, decide when to restart or give up.
    await new Promise(r => setTimeout(r, 1000));
  }
}

// Model-download watchdog (2.3.2): a download that dies OUTSIDE a run
// never retries by itself — autoDownloadMissingModels only runs at
// install/update and inside waitForModels, and it skips files that
// already wrote chunks. On a phone the ML host (offscreen document) is
// killed when the browser is backgrounded, so a big file can die
// mid-download and sit partial forever — the Vivaldi test showed a
// download stalled at 43% for ~3 minutes with no retry until a run
// started. A 1-minute alarm re-checks: a missing file that never
// started (or whose trigger died) is started, and a started file whose
// bytes stopped growing for 3 minutes is restarted (chunks kept, so it
// resumes). While a run is active the watchdog stays out of the way —
// waitForModels owns restarts then. When nothing is missing the alarm
// clears itself, so it costs nothing on a healthy install. A file that
// fails permanently (404) or hits 3 restarts without progress is given up
// on (modelDownloadGaveUp) until a run starts again or the file completes
// — it is not retried every minute forever.
const MODEL_WATCHDOG_ALARM = 'ct-model-watchdog';
const modelWatchdogProgress = new Map(); // fileId -> { loaded, at }
function ensureModelWatchdog() {
  try {
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      const p = chrome.alarms.create(MODEL_WATCHDOG_ALARM, { periodInMinutes: 1 });
      if (p && p.catch) p.catch(() => {});
    }
  } catch {}
}
function clearModelWatchdog() {
  try {
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      const p = chrome.alarms.clear(MODEL_WATCHDOG_ALARM);
      if (p && p.catch) p.catch(() => {});
    }
  } catch {}
}
async function modelWatchdogTick() {
  // A run's wait loop owns restarts while it is active.
  if (runs.size > 0) return;
  let state;
  try { state = await getModelDownloadState(); } catch { return; }
  if (!state.missing.length) {
    modelWatchdogProgress.clear();
    clearModelWatchdog();
    return;
  }
  // Files that completed since the last tick reset their counters — a
  // later re-download (after a delete) starts from zero restarts.
  for (const f of state.files) {
    if (f.done) {
      modelWatchdogRestarts.delete(f.id);
      modelDownloadGaveUp.delete(f.id);
      modelDownloadErrors.delete(f.id);
      modelByteProgress.delete(f.id);
    }
  }
  for (const f of state.missing) {
    if (!f.started) {
      const inflight = modelDownloadInflight.get(f.id);
      if (!inflight) {
        // A file with a recorded hard failure is a re-trigger, not a
        // first attempt — gate it the same way as the stall branch.
        if (modelDownloadErrors.has(f.id)) {
          if (modelDownloadGaveUp.has(f.id)) continue;
          const decision = modelRestartDecision(f.id, modelWatchdogRestarts, modelDownloadGaveUp);
          if (decision === 'gaveup') { diagPush('Model download gave up (' + f.id + '): ' + ((modelDownloadGaveUp.get(f.id) || {}).reason || 'too many restarts')); continue; }
          if (decision === 'backoff') continue;
        }
        triggerModelDownload(f.id); continue;
      }
      if (Date.now() - (inflight.startedAt || 0) > MODEL_DOWNLOAD_STALL_MS) {
        if (modelDownloadGaveUp.has(f.id)) continue;
        const decision = modelRestartDecision(f.id, modelWatchdogRestarts, modelDownloadGaveUp);
        if (decision === 'gaveup') { diagPush('Model download gave up (' + f.id + '): ' + ((modelDownloadGaveUp.get(f.id) || {}).reason || 'too many restarts')); continue; }
        if (decision === 'backoff') continue;
        diagPush('Model download never started, restarting: ' + f.id);
        modelDownloadInflight.delete(f.id);
        triggerModelDownload(f.id);
      }
      continue;
    }
    // 2.3.4: no live download for a started file means it died (cancel,
    // background restart) — restart it at once, no 3-minute wait. The
    // stall window below only applies to files that ARE in flight.
    if (!modelDownloadInflight.has(f.id)) {
      if (modelDownloadGaveUp.has(f.id)) continue;
      if (modelDownloadErrors.has(f.id)) {
        const decision = modelRestartDecision(f.id, modelWatchdogRestarts, modelDownloadGaveUp);
        if (decision === 'gaveup') { diagPush('Model download gave up (' + f.id + '): ' + ((modelDownloadGaveUp.get(f.id) || {}).reason || 'too many restarts')); continue; }
        if (decision === 'backoff') continue;
      }
      diagPush('Model download not in flight, restarting: ' + f.id);
      modelWatchdogProgress.delete(f.id);
      triggerModelDownload(f.id);
      continue;
    }
    const prev = modelWatchdogProgress.get(f.id);
    // Live bytes, not chunk counts — same slow-download fix as waitForModels.
    const loaded = modelLiveLoaded(f.id, f.loaded);
    if (!prev || prev.loaded !== loaded) {
      // Real progress resets the consecutive-restart count: the watchdog
      // ticks for hours, so 3 stalls spread over a day with progress
      // between them must not strand the file. Only consecutive restarts
      // with no progress in between count toward the cap.
      if (prev && loaded > prev.loaded) modelWatchdogRestarts.delete(f.id);
      modelWatchdogProgress.set(f.id, { loaded, at: Date.now() });
    } else if (Date.now() - prev.at > MODEL_DOWNLOAD_STALL_MS) {
      if (modelDownloadGaveUp.has(f.id)) continue;
      const decision = modelRestartDecision(f.id, modelWatchdogRestarts, modelDownloadGaveUp);
      if (decision === 'gaveup') { diagPush('Model download gave up (' + f.id + '): ' + ((modelDownloadGaveUp.get(f.id) || {}).reason || 'too many restarts')); continue; }
      if (decision === 'backoff') continue; // keep modelWatchdogProgress: restart promptly once the back-off expires
      diagPush('Model download stalled, restarting: ' + f.id);
      modelDownloadInflight.delete(f.id);
      modelWatchdogProgress.delete(f.id);
      triggerModelDownload(f.id);
    }
  }
}

// 2.3.4: the watchdog alarm must exist from background load, not only
// after a download starts. A background restart with only partial files
// left triggers nothing (their files are started, and the old code only
// ensured the alarm inside triggerModelDownload) — so the watchdog never
// ran and the partial files sat forever. Creating it here costs one tick
// on a healthy install: the tick clears the alarm when nothing is missing.
ensureModelWatchdog();
// Same reason for the persisted in-flight marks: a background restart must
// re-read them before the first tick/run, or a still-running download gets
// a duplicate start.
restoreModelDownloadInflight();

// Daily support popup: the first time the user hits the 50/day free limit
// ON EACH DAY, remind them the free auto-translate limit is reached and
// offer Get Pro / the store rating / free trial / feedback once, in the
// middle of the page. Once per day — the shown date is stored, so a second
// limit hit the same day does not show it again, but tomorrow it shows
// again — until the user clicks "Do not show again" in the modal, which
// sets ctSupportPopupDismissed and the popup never shows again. The flag
// is set only when the content script confirms the modal actually rendered
// (it returns ok:true), so a render failure does not lose the popup for
// that day (2.2.12). Old installs may still carry
// { translatedTotal, shown } from the old 50-lifetime trigger, or
// { shown: true } with no date — a flag with no date is treated as shown on
// an unknown past day, so the popup can show again today.
const SUPPORT_POPUP_KEY = 'ctSupportPopup';
let supportPopupSendInFlight = false; // one send at a time — two tabs hitting the limit together must not both render
async function maybeShowSupportPopupAtLimit(tabId) {
  if (supportPopupSendInFlight) return;
  try {
    // "Do not show again": a permanent dismiss. The content script sets
    // ctSupportPopupDismissed when the user clicks the link in the modal;
    // once set, the popup never shows again (overrides the daily rule).
    // Its own key, separate from the ctSupportPopup record, so the
    // whole-record shownDate write below can never clobber it.
    const dis = await chrome.storage.local.get('ctSupportPopupDismissed');
    if (dis && dis.ctSupportPopupDismissed) return;
    const saved = await chrome.storage.local.get(SUPPORT_POPUP_KEY);
    const rec = (saved && saved[SUPPORT_POPUP_KEY]) || {};
    if (rec.shownDate === dateStr()) return; // already shown today
  } catch { /* storage read failed — try again at the next limit hit */ return; }
  supportPopupSendInFlight = true;
  let shown = false;
  try {
    // Resolves only if the tab's content script is listening. If the tab
    // is gone, shown stays false and the next limit hit tries again — the
    // user must actually see the popup once a day. The checkout URL rides along
    // so the content script (a classic script, no imports) can render the
    // Get Pro button without a second source of truth.
    const resp = await withTimeout(chrome.tabs.sendMessage(tabId, { type: MSG.SHOW_SUPPORT, checkoutUrl: DODO_CHECKOUT_URL }), MSG_TIMEOUT_MS, 'show support');
    if (resp && resp.ok) shown = true;
  } catch { /* tab gone / no content script — retry at the next limit hit */ }
  finally { supportPopupSendInFlight = false; }
  if (!shown) return;
  try { await chrome.storage.local.set({ [SUPPORT_POPUP_KEY]: { shown: true, shownDate: dateStr() } }); } catch {}
}

// Shared page-cache lookup (normal runs + pre-translation): Tier 1 first,
// then Tier 2; legacy v1 as fallback. Same shapes the callers already use:
// a full hit returns the entry (blocks with translations), a Tier-1-only
// hit returns {tier1Only, entry, tier2Key}, a legacy hit returns the entry,
// a miss returns null. `tier` is only for the diag lines.
async function lookupPageCache(rgba, w, h, settings, tabId, tier) {
  try {
    if (await isIncognitoTab(tabId)) return null;
    // Two-tier lookup: Tier 1 (target-independent) first, then Tier 2
    // (targetLang + backend). A Tier-1 hit with a new targetLang
    // translates only — skipping detect/OCR/inpaint.
    const tier1Key = await buildCacheKeyTier1(rgba, w, h, settings);
    let tier1Entry = await pageCacheGet(tier1Key);
    // Dimension guard: the entry must match the CURRENT (scaled) capture
    // dims. A mismatch means the entry was stored at different dims
    // (e.g. before the R3 normalization) — treat as miss and overwrite.
    if (tier1Entry && (tier1Entry.width !== w || tier1Entry.height !== h)) {
      tier1Entry = null;
    }
    if (tier1Entry) {
      const tier2Key = buildCacheKeyTier2(tier1Key, settings);
      const tier2Entry = await pageCacheGet(tier2Key);
      const translations = tier2Entry && tier2Entry.translations;
      // 2.3.6: an entry is only a full hit when it has a usable
      // translation — at least one non-empty string — and Tier-1
      // actually has blocks. An empty array is truthy, and all-empty
      // translations render as the original, so both used to count as
      // a hit and the page looked untranslated forever (a transient
      // OCR/translate failure saved as "no text").
      const usableTranslations = Array.isArray(translations) &&
        translations.some(t => typeof t === 'string' && t.trim());
      const hasBlocks = Array.isArray(tier1Entry.blocks) && tier1Entry.blocks.length > 0;
      if (usableTranslations && hasBlocks) {
        // Full hit: apply cached translations to the Tier-1 blocks.
        const blocks = tier1Entry.blocks.map((b, i) => ({
          ...b, translation: tier2Entry.translations[i] || '',
        }));
        return { ...tier1Entry, blocks };
      }
      // Tier-1 hit, Tier-2 miss (or unusable): translate the OCR'd
      // blocks only — but only when Tier-1 actually has blocks. A
      // Tier-1 entry with no blocks is the same poison; fall through
      // to a full miss so the pipeline re-detects instead of
      // re-rendering the original forever.
      if (hasBlocks) {
        return { tier1Only: true, entry: tier1Entry, tier2Key };
      }
      // Poisoned entry (a transient failure saved as "no text") — worth
      // one line, so a picture that keeps re-running the full pipeline
      // shows why the cache did not hit. A normal miss (no entry at all)
      // stays silent.
      diagPush('  Cached entry is empty (no text blocks) — running the full pipeline instead.');
      tier1Entry = null;
    }
    // No Tier 1: try the legacy v1 key for backward compatibility.
    const legacy = await pageCacheGet(await buildCacheKey(rgba, w, h, settings));
    // 2.3.6: same usable check for legacy entries — blocks with no
    // non-empty translation render as the original.
    if (legacy && Array.isArray(legacy.blocks) &&
        legacy.blocks.some(b => b && typeof b.translation === 'string' && b.translation.trim())) {
      return legacy;
    }
    if (legacy) diagPush('  Cached entry is empty (no usable translation) — running the full pipeline instead.');
    return null;
  } catch (e) {
    console.warn('[ct] page-cache lookup failed:', String((e && e.message) || e).slice(0, 120));
    diagPush('Cache lookup failed: ' + String((e && e.message) || e).slice(0, 120));
    return null;
  }
}

// Shared page-cache write (normal runs + pre-translation): Tier 1 stores
// the inpainted base + OCR'd blocks (translations stripped); Tier 2 stores
// the translations for this targetLang/backend. Best-effort — a cache
// failure must never fail the run. Skipped in incognito.
async function writePageCache(rgba, w, h, finalDataUrl, blocks, effSettings, settings, tabId, mode) {
  try {
    if (await isIncognitoTab(tabId)) return;
    // 2.3.6: never cache an empty result. Zero blocks (a transient
    // detect failure saved as "no text") writes nothing at all, so the
    // next visit re-detects. Blocks with all-empty translations keep
    // Tier-1 (blocks + base are valid) but skip Tier-2, so the next
    // visit re-translates only instead of re-rendering the original.
    if (!Array.isArray(blocks) || !blocks.length) return;
    const t1Key = await buildCacheKeyTier1(rgba, w, h, settings);
    const blocksNoTrans = blocks.map(b => {
      const { translation, ...rest } = b;
      return rest;
    });
    await pageCachePut(t1Key, {
      imageDataUrl: finalDataUrl, width: w, height: h,
      blocks: blocksNoTrans, mode,
      // Resolved source language ('auto' already detected above) — reused
      // verbatim on Tier-1 hits instead of re-detecting (G10).
      sourceLang: effSettings.sourceLang,
    });
    const translations = blocks.map(b => b.translation || '');
    if (!translations.some(t => t.trim())) return;
    const t2Key = buildCacheKeyTier2(t1Key, settings);
    await pageCachePut(t2Key, {
      translations,
      targetLang: settings.targetLang,
      backend: settings.translationBackend,
    });
    // No legacy v1 write: the v1 backfill duplicated the image a third
    // time and counted as a second image in stats (its key shape differs
    // from Tier-1's, so the distinct-image collapse missed it). The v1
    // READ fallback stays, so entries written by older builds still serve.
  } catch (e) {
    console.warn('[ct] page-cache write failed:', String((e && e.message) || e).slice(0, 120));
    diagPush('Cache write failed: ' + String((e && e.message) || e).slice(0, 120));
  }
}

// ---------------------------------------------------------------- pre-translate the next page (2.2.5)
// After a run finishes, translate the next page's single picture in the
// background and write it to the page cache, so opening it is instant.
// Best-effort only: any failure just means the next page translates
// normally when visited. Never opens a tab (a 403 picture is skipped);
// never chains (one page ahead only); only runs when the next page has
// exactly one picture above the size limit.
// The job's runs entry carries tabId null on purpose: cancelRunsForTab
// (new-page navigation drops the tab's old run) must not kill a job for
// the page the user just opened — joinOrCancelPretranslate decides that
// instead, by URL.
let pretranslateJob = null; // {url, runId, done} | null
const pretranslateDoneUrls = new Set(); // session: URLs already pre-translated

// Learned next-page rules (URL-only learning, part of pre-translate; no
// toggle). nextPageRules: { [shape]: { pattern, count, misses } }, kept in
// chrome.storage.local under NEXT_PAGE_RULES_KEY so it survives restarts.
// lastTabUrl tracks the previous URL per tab for learning observations;
// predictedNext remembers what a learned rule predicted for a tab, so the
// next navigation can score it (opened it = success, jumped forward past
// it = miss, went back = no signal).
const NEXT_PAGE_RULES_KEY = 'ctNextPageRules';
let nextPageRules = null; // null until loaded
let nextPageRulesLoad = null;
let lastTabUrl = new Map();
let predictedNext = new Map();
let lastLinkClick = new Map(); // tabId -> {text, href, at} (last link click, for learning link text)
function ensureNextPageRulesLoaded() {
  if (nextPageRules !== null) return Promise.resolve();
  if (!nextPageRulesLoad) {
    nextPageRulesLoad = chrome.storage.local.get(NEXT_PAGE_RULES_KEY).then(saved => {
      nextPageRules = (saved && saved[NEXT_PAGE_RULES_KEY]) || {};
    }).catch(() => { nextPageRules = {}; });
  }
  return nextPageRulesLoad;
}
function saveNextPageRules() {
  try { chrome.storage.local.set({ [NEXT_PAGE_RULES_KEY]: nextPageRules || {} }); } catch {}
}
// Score one outcome for a learned rule (ok = the predicted page exists /
// the user opened it). A miss streak of 10 drops the rule (see
// next-page-learn.js); any success resets the streak.
function noteLearnOutcome(key, ok) {
  if (!key) return;
  nextPageRules = noteLearnResult(nextPageRules || {}, key, ok);
  saveNextPageRules();
}
// Learn from one real navigation. Runs on every URL change (changeInfo.url),
// before the auto-translate handler below.
async function observeNextPageChange(tabId, oldUrl, newUrl) {
  try {
    await ensureNextPageRulesLoaded();
    const pred = predictedNext.get(tabId);
    if (pred) {
      predictedNext.delete(tabId);
      if (newUrl === pred.url) {
        noteLearnOutcome(pred.key, true);
      } else if (pred.pattern.kind === 'link-text' || pred.pattern.kind === 'pic-link') {
        // A text or picture prediction has no number to judge direction
        // by: any other page on the same site right after it is a miss.
        try {
          if (new URL(newUrl).origin === new URL(pred.url).origin) noteLearnOutcome(pred.key, false);
        } catch {}
      } else if (urlShape(newUrl) === urlShape(pred.url)) {
        // Same series, different page: a forward jump past the prediction
        // is a miss; going back (or staying) is no signal either way.
        const fromN = patternNumber(pred.pattern, pred.sourceUrl);
        const toN = patternNumber(pred.pattern, newUrl);
        if (fromN !== null && toN !== null && toN > fromN) noteLearnOutcome(pred.key, false);
      }
    }
    const before = JSON.stringify(nextPageRules || {});
    nextPageRules = observeRules(nextPageRules || {}, oldUrl, newUrl);
    if (JSON.stringify(nextPageRules) !== before) saveNextPageRules();
    // Learn the site's "next" wording from the click that caused this
    // navigation (the click must match the new URL and be recent).
    try {
      const click = lastLinkClick.get(tabId);
      lastLinkClick.delete(tabId);
      if (click && click.href === newUrl && Date.now() - click.at <= 2000) {
        const origin = new URL(newUrl).origin;
        const beforeL = JSON.stringify(nextPageRules || {});
        nextPageRules = observeLinkRules(nextPageRules || {}, origin, click.text, oldUrl, newUrl);
        // A picture click (no text needed) teaches the picture-link rule:
        // on this site, the link around the main picture goes next.
        if (click.hasImage) {
          nextPageRules = observePicLinkRules(nextPageRules || {}, origin, oldUrl, newUrl);
        }
        if (JSON.stringify(nextPageRules) !== beforeL) saveNextPageRules();
      }
    } catch {}
  } catch {}
}

// Extract <img> URLs from a page's HTML: src / data-src / data-original /
// data-lazy-src, plus the first srcset candidate. Relative URLs resolve
// against the page. SVGs are UI, not content. Pure (tested).
function extractNextPageImages(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const tagRe = /<img\b[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[0];
    const attr = (name) => {
      const r = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
      const a = r.exec(tag);
      return a ? (a[2] || a[3] || a[4] || '') : '';
    };
    let src = attr('data-src') || attr('data-original') || attr('data-lazy-src') || attr('src');
    if (!src) {
      const srcset = attr('srcset');
      if (srcset) src = srcset.split(',')[0].trim().split(/\s+/)[0];
    }
    if (!src || /^data:/i.test(src)) continue;
    let abs;
    try { abs = new URL(src, baseUrl).href; } catch { continue; }
    if (/\.svg(\?|#|$)/i.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ url: abs, w: parseInt(attr('width'), 10) || 0, h: parseInt(attr('height'), 10) || 0 });
  }
  return out;
}

// Same page, ignoring the fragment: the next-page URL vs the tab's URL.
function samePageUrl(a, b) {
  try {
    const ua = new URL(a), ub = new URL(b);
    ua.hash = ''; ub.hash = '';
    return ua.href === ub.href;
  } catch { return a === b; }
}

// Exactly one qualifying picture -> translate it; zero or more than one
// -> do nothing. Pure (tested).
function pickSingleQualifying(withSize, minSize) {
  const qualifying = withSize.filter(x => Math.max(x.w || 0, x.h || 0) >= minSize);
  return qualifying.length === 1 ? qualifying[0] : null;
}

function cancelPretranslate() {
  const job = pretranslateJob;
  if (!job) return;
  const r = runs.get(job.runId);
  if (r && !r.cancelled) {
    try { abortRunResources(job.runId, r); } catch { /* already gone */ }
  }
  // The job's own finally clears the slot when it settles; a new job
  // replaces the slot first, so this never clears a newer job.
}

// Persisted pre-translate job (2.3.19): the job lived only in memory, so
// a background restart killed it silently with no retry. The pending
// record is one slot in storage (a job is a singleton): the next page
// URL, the source tab + URL, the learned rule key, and how many times it
// has already been resumed. The page cache is the progress record —
// pictures already translated are cache hits, so a resumed job only
// does the rest.
const PRETRANSLATE_PENDING_KEY = 'ct-pretranslate-pending';
const MAX_PRETRANSLATE_RESUMES = 2; // same bound as orphan auto-resume
async function persistPretranslateJob(rec) {
  try { await chrome.storage.local.set({ [PRETRANSLATE_PENDING_KEY]: rec }); } catch {}
}
async function clearPretranslateJob(nextUrl) {
  try {
    const rec = (await chrome.storage.local.get(PRETRANSLATE_PENDING_KEY))[PRETRANSLATE_PENDING_KEY];
    if (rec && (!nextUrl || rec.nextUrl === nextUrl)) await chrome.storage.local.remove(PRETRANSLATE_PENDING_KEY);
  } catch {}
}
// Pure decision for recoverPretranslateJob (tested): 'resume' when the job
// is still wanted and the source tab is still on the source page; 'drop'
// otherwise, with the reason in the second element.
function pretranslateResumeDecision(rec, tab, settingsOn) {
  if (!rec || !rec.nextUrl) return ['drop', 'no pending job'];
  if (!settingsOn) return ['drop', 'pre-translate off'];
  if ((rec.attempts || 0) >= MAX_PRETRANSLATE_RESUMES) return ['drop', 'attempts ' + (rec.attempts || 0) + ' of ' + MAX_PRETRANSLATE_RESUMES];
  if (!tab || tab.url !== rec.sourceUrl) return ['drop', 'source tab gone or page changed'];
  return ['resume', ''];
}
// Start one pre-translate job for a known next page: fresh runId, runs
// entry (tabId null, like before), keep-alive, and the done promise that
// clears the pending record when it settles. Both the fresh trigger
// (pretranslateNextPage) and the restart resume (recoverPretranslateJob)
// start jobs here, so there is one copy of the lifecycle.
function startPretranslateJob(nextUrl, sourceTabId, sourceUrl, settings, learnedKey, attempts = 0, startedAt = Date.now()) {
  const runId = 'pre-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const job = { url: nextUrl, runId, done: null, learnedKey: learnedKey || null };
  pretranslateJob = job;
  const abortController = new AbortController();
  runs.set(runId, { cancelled: false, tabId: null, stage: 'pretranslate', abortController });
  keepAliveStart(runId);
  persistPretranslateJob({ nextUrl, sourceUrl, sourceTabId, learnedKey: job.learnedKey, startedAt, attempts });
  job.done = (async () => {
    try {
      await runPretranslate(job, sourceTabId, settings);
      pretranslateDoneUrls.add(nextUrl);
      if (pretranslateDoneUrls.size > 20) pretranslateDoneUrls.delete(pretranslateDoneUrls.values().next().value);
    } catch (e) {
      if (e && e.cancelled) diagPush('Pre-translate cancelled for ' + nextUrl);
      else diagPush('Pre-translate skipped ' + nextUrl + ': ' + String((e && e.message) || e).slice(0, 120));
    } finally {
      runs.delete(runId);
      keepAliveStop(runId);
      if (pretranslateJob === job) pretranslateJob = null;
      clearPretranslateJob(nextUrl);
    }
  })();
  return job;
}

// Pure decision for joinOrCancelPretranslate (tested): 'join' when a
// background job is already translating this page, 'cancel' when an AUTO
// run starts for another page (the user navigated away), 'keep' when a
// MANUAL run starts for another page (right-click / popup on the source
// page — the user never navigated, so the job keeps running), 'none'
// when there is no job. isAuto defaults to true for old callers.
function joinOrCancelDecision(jobUrl, tabUrl, isAuto = true) {
  if (!jobUrl) return 'none';
  if (jobUrl && tabUrl && samePageUrl(jobUrl, tabUrl)) return 'join';
  if (isAuto === false) return 'keep';
  return 'cancel';
}

// A normal run starting for the page a background job is already
// translating: keep the job and wait for it — its cache write makes this
// run a cache hit. An auto run for another page cancels the job (the user
// went elsewhere); a manual run for another page leaves it alone.
async function joinOrCancelPretranslate(runId, tabUrl, isAuto = true) {
  const job = pretranslateJob;
  if (!job) return;
  const decision = joinOrCancelDecision(job.url, tabUrl, isAuto);
  if (decision === 'join') {
    try { setProgress(runId, 'capture', 0.01); } catch { /* pill is best-effort */ }
    try { await job.done; } catch { /* a failed job just means this run does the work */ }
    // 2.2.12: a run cancelled while waiting for the job must stop here,
    // not do the injection + inventory work and abort later.
    checkCancelled(runId);
    return;
  }
  if (decision === 'keep') return; // manual run on the source page: job keeps running
  cancelPretranslate();
}

// Fire-and-forget entry: called after a run finishes. Starts a background
// job for the next page, or does nothing (setting off, no next page,
// incognito, already done).
async function pretranslateNextPage(sourceTabId, sourceUrl, settings) {
  if (!settings || settings.pretranslateNextPage === false) return;
  // Freemium gate: pre-translate counts against the 50/day free limit
  // unless Pro is active. A stale Pro validation re-checks in the background.
  {
    const gate = await canAutoOrPre(settings);
    if (!gate.ok) { diagPush('Pre-translate skipped — free limit reached (' + gate.used + '/' + gate.limit + ' images today).'); return; }
    if (gate.pro && proCheckDue(settings)) validateProLicense(settings).then(r => { if (r && r.ok === false) diagPush('Pro license check failed: ' + (r.error || 'unknown') + ' — keeping Pro state.'); }).catch(() => {});
  }
  try { if (await isIncognitoTab(sourceTabId)) return; } catch { /* proceed */ }
  cancelPretranslate();
  // Learned rule first: if this site has an active learned rule, build the
  // next URL from it directly — no link needed. Otherwise ask the page
  // (built-in rules: rel=next, link text, +1, dash+1, ?page=).
  let nextUrl = null;
  let learned = null;
  try {
    await ensureNextPageRulesLoaded();
    const active = activeRuleFor(nextPageRules || {}, sourceUrl || '');
    if (active) {
      const cand = applyPattern(active.pattern, sourceUrl);
      if (cand && cand !== sourceUrl) { nextUrl = cand; learned = active; }
    }
  } catch {}
  if (!nextUrl) {
    try {
      // Learned link text for this site (its own "next" wording, e.g.
      // Romanian "următorul") goes to the page first; the page falls back
      // to the built-in rules when nothing matches. picLinkActive tells
      // the page whether the learned picture-link rule applies here.
      let linkRules = [];
      let picLinkActive = false;
      try {
        const origin = new URL(sourceUrl || '').origin;
        linkRules = activeLinkTexts(nextPageRules || {}, origin);
        picLinkActive = activePicLinkRule(nextPageRules || {}, origin) !== null;
      } catch {}
      const r = await withTimeout(chrome.tabs.sendMessage(sourceTabId, { type: MSG.NEXT_PAGE_URL, learnedTexts: linkRules.map(x => x.text), picLinkActive }), MSG_TIMEOUT_MS, 'next page url');
      nextUrl = r && r.url;
      if (r && r.learnedText) {
        const hit = linkRules.find(x => x.text === r.learnedText);
        if (hit) {
          try {
            const origin = new URL(sourceUrl || '').origin;
            learned = { pattern: { kind: 'link-text', origin, text: r.learnedText }, key: hit.key };
          } catch {}
        }
      } else if (r && r.picLink) {
        try {
          const origin = new URL(sourceUrl || '').origin;
          const pic = activePicLinkRule(nextPageRules || {}, origin);
          if (pic) learned = pic;
        } catch {}
      }
    } catch {
      diagPush('Pre-translate: tab gone, cannot ask for the next page.');
      return; /* tab gone / no content script */
    }
  }
  // Log the miss: a silent return here left no trace in the diag log,
  // so a "pre-translate does not work" report had nothing to check.
  if (!nextUrl) {
    diagPush('Pre-translate: no next page found from ' + (sourceUrl || ''));
    return;
  }
  if (pretranslateDoneUrls.has(nextUrl)) return;
  // Remember the prediction so the next navigation can score it.
  if (learned) predictedNext.set(sourceTabId, { url: nextUrl, key: learned.key, sourceUrl, pattern: learned.pattern });
  startPretranslateJob(nextUrl, sourceTabId, sourceUrl, settings, learned ? learned.key : null);
}

// Resume a pre-translate job the background restart killed (2.3.19).
// Runs once at background load, next to recoverOrphanedRuns. Same guards
// as orphan auto-resume: at most 2 resumes, and the source tab must still
// be open on the source page. A settings read failure leaves the record
// for the next load instead of dropping the job.
async function recoverPretranslateJob() {
  try {
    const rec = (await chrome.storage.local.get(PRETRANSLATE_PENDING_KEY))[PRETRANSLATE_PENDING_KEY];
    if (!rec || !rec.nextUrl) return;
    const settings = await getSettings().catch(() => null);
    if (!settings) return;
    const tab = await chrome.tabs.get(rec.sourceTabId).catch(() => null);
    const [decision, reason] = pretranslateResumeDecision(rec, tab, settings.pretranslateNextPage !== false);
    if (decision !== 'resume') {
      diagPush('Pre-translate: resume skipped ' + rec.nextUrl + ': ' + reason);
      await clearPretranslateJob(rec.nextUrl);
      return;
    }
    const attempts = (rec.attempts || 0) + 1;
    diagPush('Pre-translate: resuming ' + rec.nextUrl + ' after background restart (attempt ' + attempts + ' of ' + MAX_PRETRANSLATE_RESUMES + ').');
    startPretranslateJob(rec.nextUrl, rec.sourceTabId, rec.sourceUrl, settings, rec.learnedKey, attempts, rec.startedAt);
  } catch (e) {
    diagPush('Pre-translate: resume failed: ' + String((e && e.message) || e).slice(0, 120));
  }
}

async function runPretranslate(job, sourceTabId, settings) {
  const runId = job.runId;
  const nextUrl = job.url;
  // ---- fetch the next page (15s cap; credentials 'include' so the
  // site's cookies ride along — the fetch runs from the extension origin,
  // so 'same-origin' would send none cross-origin).
  let html;
  {
    // TODO: why 15s here, when image downloads elsewhere get 11s? No
    // origin for 15s in the code — verify against real next-page fetch
    // times on slow connections before trusting it. The wait itself is
    // justified: fetch has no stall signal, so an AbortController timer
    // is the only bound; only the duration is unproven.
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(nextUrl, { credentials: 'include', signal: ctrl.signal, headers: { Accept: 'text/html,*/*' } });
      if (!res.ok) {
        // 429: read Retry-After and score the learned rule as a miss
        // WITHOUT retrying immediately — the catch below scores the miss;
        // retrying into a rate limit now would make it worse.
        if (res.status === 429) {
          const ra = parseRetryAfterMs(res.headers);
          diagPush(`Pre-translate: next page rate-limited (HTTP 429)${ra != null ? ', retry after ' + Math.round(ra / 1000) + 's' : ', no wait time given'} — not retrying.`);
          throw new Error('next page fetch rate-limited: HTTP 429');
        }
        // 404/410: the next page does not exist — a miss for the learned
        // rule, not a generic failure.
        if (res.status === 404 || res.status === 410) {
          diagPush(`Pre-translate: next page does not exist (HTTP ${res.status}).`);
          throw new Error('next page does not exist: HTTP ' + res.status);
        }
        throw new Error('next page fetch failed: HTTP ' + res.status);
      }
      // Content-Type: an HTML error page served as 200 must not be
      // parsed as the next page.
      const pageCtype = (res.headers.get('content-type') || '').toLowerCase();
      if (pageCtype && !pageCtype.includes('text/html')) throw new Error('next page returned ' + pageCtype.split(';')[0].trim() + ', not HTML');
      const len = Number(res.headers.get('content-length') || 0);
      if (len > 5 * 1024 * 1024) throw new Error('next page too big');
      html = await res.text();
      // NOTE: a successful fetch is NOT scored — the URL merely exists,
      // which says nothing about whether it is the right next page. Only
      // the user's next navigation scores success (they opened the
      // predicted page); a fetch failure scores a miss below.
    } catch (e) {
      // The predicted page failed to load: the learned rule missed.
      if (job.learnedKey) noteLearnOutcome(job.learnedKey, false);
      throw e;
    } finally { clearTimeout(to); }
  }
  checkCancelled(runId);
  // ---- find the one picture. A next link that IS an image counts directly.
  let candidates = extractNextPageImages(html, nextUrl);
  if (!candidates.length && /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i.test(nextUrl)) {
    candidates = [{ url: nextUrl, w: 0, h: 0 }];
  }
  if (!candidates.length) { diagPush('Pre-translate: no pictures on ' + nextUrl); return; }
  // ---- resolve sizes: declared dims first; download the rest (cap 8) until
  // 2 qualify — then there is no single picture to translate, stop early.
  const minSize = settings.minImageSize || 460;
  const withSize = [];
  let downloads = 0;
  const ordered = [...candidates].sort((a, b) => Math.max(b.w || 0, b.h || 0) - Math.max(a.w || 0, a.h || 0));
  for (const c of ordered) {
    let w = c.w || 0, h = c.h || 0;
    if ((!w || !h) && downloads < 8) {
      // No declared size: download to learn it. A 403 here just skips
      // this picture (the size probe never opens a fallback tab — the
      // full capture in pretranslateImage does that if it gets this far).
      try {
        const px = await fetchImagePixels(c.url, nextUrl);
        downloads++;
        w = px.w; h = px.h;
      } catch (e) {
        diagPush('Pre-translate: size check failed, skipping ' + c.url.slice(0, 80) + ': ' + String((e && e.message) || e).slice(0, 80));
        continue;
      }
      checkCancelled(runId);
    }
    withSize.push({ url: c.url, w, h });
    if (withSize.filter(x => Math.max(x.w, x.h) >= minSize).length >= 2) break;
  }
  const target = pickSingleQualifying(withSize, minSize);
  if (!target) {
    diagPush(`Pre-translate: ${withSize.filter(x => Math.max(x.w, x.h) >= minSize).length} qualifying pictures on ${nextUrl} (need exactly 1) — skipping.`);
    return;
  }
  await pretranslateImage(job, target.url, nextUrl, sourceTabId, settings);
}

// Translate one picture headlessly into the page cache: no tab, no pill,
// no render. Mirrors runOneImage's stages (capture -> cache -> detect ->
// blocks -> OCR -> translate + mask/inpaint -> cache write) with the
// tab-bound steps removed.
async function pretranslateImage(job, imageUrl, pageUrl, sourceTabId, settings) {
  const runId = job.runId;
  const pxKeys = [];
  try {
    // ---- capture: worker-fetch first, background tab on 403/blocked.
    // The background tab is a real tab the host serves, so it reads
    // pictures worker-fetch cannot. Quiet: pre-translate runs in the
    // background, so no pill notice on the user's current page.
    let rgba, w, h;
    try {
      ({ rgba, w, h } = await fetchImagePixels(imageUrl, pageUrl));
    } catch (e) {
      // A dead link (404) or a rate-limited host (429) must not open a
      // background tab: the tab would hit the same dead/rate-limited URL.
      // Skip the candidate instead.
      if (e && (e.status === 404 || e.status === 429)) {
        diagPush('Pre-translate: picture download failed, skipping (' + (e.status === 404 ? 'image link no longer exists, HTTP 404' : 'image host rate-limiting, HTTP 429') + '): ' + imageUrl.slice(0, 80));
        return;
      }
      try {
        ({ rgba, w, h } = await fallbackCaptureViaTab(sourceTabId, imageUrl, true));
        diagPush('Pre-translate: download blocked, read via background tab.');
      } catch (e2) {
        diagPush('Pre-translate: picture download failed, skipping: ' + String((e2 && e2.message) || e2).slice(0, 120));
        return;
      }
    }
    checkCancelled(runId);
    if (meanBrightness(rgba) < 0.004) { diagPush('Pre-translate: blank picture, skipping.'); return; }
    {
      const cs = renderScale(w, h);
      if (cs < 1) {
        const sw = Math.max(1, Math.round(w * cs)), sh = Math.max(1, Math.round(h * cs));
        rgba = resizeBilinearRGBA(rgba, w, h, sw, sh);
        w = sw; h = sh;
      }
    }
    // ---- cache lookup: a hit means there is nothing to do.
    const cacheHit = await lookupPageCache(rgba, w, h, settings, sourceTabId, 'pretranslate');
    if (cacheHit) {
      if (cacheHit.tier1Only) await pretranslateTier1Only(job, cacheHit.entry, cacheHit.tier2Key, settings);
      diagPush('Pre-translate: already cached ' + imageUrl.slice(0, 80));
      return;
    }
    checkCancelled(runId);
    // ---- detection (+ tall-image slicing)
    let detections;
    if (h / w > 3.5) {
      detections = await detectSliced(rgba, w, h, settings.detectionThreshold, runId, pxKeys);
    } else {
      const pxKey = `detect:${runId}`;
      pxKeys.push(pxKey);
      await pixelPut(pxKey, rgba.buffer);
      const r = await callMlChecked(runId, { type: MSG.ML_DETECT, key: pxKey, width: w, height: h, threshold: settings.detectionThreshold, runId });
      detections = r.boxes;
    }
    checkCancelled(runId);
    // ---- text blocks
    const blocks = buildBlocks(detections, w, h, rgba, settings);
    // No text: nothing to translate or cache (writePageCache refuses
    // empty blocks), and nothing to count toward the free quota.
    if (!blocks.length) { diagPush('Pre-translate: no text in ' + imageUrl.slice(0, 80)); return; }
    // ---- OCR
    const crops = [];
    for (const [i, b] of blocks.entries()) {
      const c = cropForBlock(rgba, w, h, b.xyxy, b.bubble_xyxy);
      if (!c) continue;
      const pxKey = `ocr:${runId}:${i}`;
      pxKeys.push(pxKey);
      await pixelPut(pxKey, c.data.buffer);
      crops.push({ id: i, key: pxKey, width: c.w, height: c.h });
    }
    if (crops.length) {
      const r = await callMlChecked(runId, {
        type: MSG.ML_OCR, runId, sourceLang: settings.sourceLang, useDistil: settings.ocrDistilTest,
        crops: crops.map(({ id, key, width, height }) => ({ id, key, width, height })),
      });
      for (const res of r.results) blocks[res.id].text = res.text;
    }
    checkCancelled(runId);
    // ---- source language
    let effSettings = settings;
    if (settings.sourceLang === 'auto') {
      const detected = detectPageLang(blocks.map(b => b.text));
      effSettings = { ...settings, sourceLang: detected || 'ja' };
      for (const b of blocks) b.source_lang = effSettings.sourceLang;
    }
    // Failover is free, not a Pro feature (2026-11-26): never gated by
    // the daily limit, so a Gemini failure always falls over to Google.
    // ---- translate + mask/inpaint in parallel; render waits for both.
    const entry = runs.get(runId);
    const abortController = (entry && entry.abortController) || new AbortController();
    const runTranslate = async () => {
      // 30s aborts the CURRENT attempt so translateBlocks can fail over;
      // the 60s backstop kills a run wedged past stall (30s) + rescue
      // (20s) — the same pattern as runOneImage and pretranslateTier1Only,
      // so a hung translate cannot leave the pre-translate job unsettled
      // forever. 30s also matches the deadlineMs=30000 passed to
      // translateBlocks below.
      const TRANSLATE_TIMEOUT_MS = 30000;
      const TRANSLATE_BACKSTOP_MS = 60000;
      let timeoutId = null, backstopId = null;
      timeoutId = setTimeout(() => { try { abortController.abort(); } catch {} }, TRANSLATE_TIMEOUT_MS);
      const backstopP = new Promise((_, reject) => {
        backstopId = setTimeout(() => {
          reject(new Error('translate timed out — the translation backend may be stuck'));
        }, TRANSLATE_BACKSTOP_MS);
      });
      // Pre-translate runs in the background — log the failover to the
      // diag log, but show no pill (the user is not on this page).
      const failoverNotice = (p) => {
        if (p && p.failoverFrom && p.failoverTo) {
          logFailoverLine(p, 'Pre-translate:');
        }
      };
      let translated;
      try {
        translated = await Promise.race([
          translateBlocks(blocks, effSettings, failoverNotice, abortController.signal, 30000, () => runs.get(runId)?.cancelled === true),
          backstopP,
        ]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (backstopId) clearTimeout(backstopId);
      }
      checkCancelled(runId);
      blocks.forEach((b, i) => { b.translation = translated[i]; });
    };
    const runMaskInpaint = async () => {
      checkCancelled(runId);
      // Skip-inpaint (Debug setting): skip LaMa entirely — the page cache gets
      // the original image, and the text renders over it.
      if (settings.bypassInpaint) return new Uint8ClampedArray(rgba);
      const pageGray = toGrayU8(rgba, w, h);
      const { mask: fullMask, entries } = generateMask(rgba, w, h, pageGray, blocks, 5);
      const spreadMap = await readInpaintSpread();
      const mergeKey = directHandlers() ? 'wasm1' : 'gpu';
      const mergeSpread = spreadMap[mergeKey] || INPAINT_COST_SPREAD;
      const { boxes: patchBoxes } = mergeBoxesByCost(entries, {
        tileMax: directHandlers() ? TILE_MAX : 1024,
        ...(directHandlers() ? INPAINT_COST.wasm1 : INPAINT_COST.gpu),
        spread: mergeSpread,
      });
      const patches = [];
      for (const [i, pb] of patchBoxes.entries()) {
        checkCancelled(runId);
        const [x1, y1, x2, y2] = pb.map(Math.round);
        const pxKey = `inpaint:${runId}:${i}`;
        const maskKey = `inpaint-mask:${runId}:${i}`;
        pxKeys.push(pxKey, maskKey);
        await pixelPut(pxKey, cropRGBA(rgba, w, x1, y1, x2, y2).data.buffer);
        const maskData = cropMask1(fullMask, w, x1, y1, x2, y2);
        await pixelPut(maskKey, maskData.buffer);
        patches.push({ id: i, x: x1, y: y1, key: pxKey, maskKey, maskData, width: x2 - x1, height: y2 - y1 });
      }
      const inpainted = new Uint8ClampedArray(rgba);
      if (patches.length) {
        const wirePatches = patches.map(({ id, key, maskKey, width, height }) => ({ id, key, maskKey, width, height }));
        let r;
        let gpuDowngraded = false;
        if (directHandlers() && !gpuDowngraded && gpuInpaintAllowed() && typeof navigator !== 'undefined' && navigator.gpu) {
          try {
            r = await runGpuInpaint({
              runId, patches: wirePatches,
              onProgress: () => {},
              diag: diagPush,
              isCancelled: () => runs.get(runId)?.cancelled === true,
            });
          } catch (e) {
            checkCancelled(runId);
            gpuDowngraded = true;
            diagPush('Pre-translate: Inpaint fell back to WASM (GPU failed: ' + String((e && e.message) || e).slice(0, 80) + ').');
            markGpuInpaintDead().catch(() => {});
            r = await callMlChecked(runId, { type: MSG.ML_INPAINT, runId, patches: wirePatches });
          }
        } else if (!directHandlers() && !gpuDowngraded && gpuInpaintAllowed()) {
          try {
            r = await runChromeGpuInpaint({
              runId, patches: wirePatches,
              onProgress: () => {},
              diag: diagPush,
              isCancelled: () => runs.get(runId)?.cancelled === true,
            });
          } catch (e) {
            checkCancelled(runId);
            if (e && e.gpuSkipped) {
              diagPush('Pre-translate: Inpaint skipped GPU (' + String((e && e.message) || e).slice(0, 80) + '), using WASM.');
              r = await callMlChecked(runId, { type: MSG.ML_INPAINT, runId, patches: wirePatches });
            } else {
              gpuDowngraded = true;
              diagPush('Pre-translate: Inpaint fell back to WASM (GPU failed: ' + String((e && e.message) || e).slice(0, 80) + ').');
              markGpuInpaintDead().catch(() => {});
              r = await callMlChecked(runId, { type: MSG.ML_INPAINT, runId, patches: wirePatches });
            }
          }
        } else {
          r = await callMlChecked(runId, {
            type: MSG.ML_INPAINT, runId,
            patches: wirePatches,
          });
        }
        for (const res of r.results) {
          const p = patches[res.id];
          pxKeys.push(res.key);
          const buf = await pixelTake(res.key);
          pasteMaskedRGBA(inpainted, w,
            { data: new Uint8ClampedArray(buf), w: p.width, h: p.height },
            { data: p.maskData, w: p.width, h: p.height },
            p.x, p.y);
        }
      }
      return inpainted;
    };
    const [, inpainted] = await Promise.all([runTranslate(), runMaskInpaint()]);
    checkCancelled(runId);
    // ---- cache write (no render — the next visit renders from this entry).
    const finalDataUrl = await rgbaToDataURL(inpainted, w, h, Math.max(w, h));
    await writePageCache(rgba, w, h, finalDataUrl, blocks, effSettings, settings, sourceTabId, 'replace');
    diagPush('Pre-translate: done ' + imageUrl.slice(0, 80));
    // Freemium: one newly translated image against the free daily limit.
    // Pro users are not counted. Distinct images only — a re-translation
    // of the same URL is free. One image counts as one, whatever its
    // height (long strips are 1:1). Pre-translate only runs when it is
    // on, so a Pro feature is always on here, but the gate keeps the
    // rule in one place (anyProFeatureOn).
    if (!proIsActive(settings) && anyProFeatureOn(settings)) await addProUsageForImages([{ key: imageUrl, w, h }]);
  } finally {
    for (const k of pxKeys.splice(0)) await pixelDrop(k);
  }
}

// Tier-1 hit, Tier-2 miss: translate the OCR'd blocks only, store Tier-2.
async function pretranslateTier1Only(job, tier1Entry, tier2Key, settings) {
  const runId = job.runId;
  checkCancelled(runId);
  const blocks = tier1Entry.blocks.map(b => ({ ...b }));
  let effSettings = settings;
  if (settings.sourceLang === 'auto') {
    const resolved = tier1Entry.sourceLang || detectPageLang(blocks.map(b => b.text));
    effSettings = { ...settings, sourceLang: resolved || 'ja' };
  }
  // Failover is free, not a Pro feature (2026-11-26): never gated by
  // the daily limit, so a Gemini failure always falls over to Google.
  const entry = runs.get(runId);
  const abortController = (entry && entry.abortController) || new AbortController();
  // 30s aborts the current attempt so translateBlocks can fail over; the
  // 60s backstop kills a run wedged past stall (30s) + rescue (20s) — the
  // same pattern as runOneImage and pretranslateImage, so a hung translate
  // cannot leave the pre-translate job unsettled forever.
  const TRANSLATE_TIMEOUT_MS = 30000;
  const TRANSLATE_BACKSTOP_MS = 60000;
  let timeoutId = null, backstopId = null;
  timeoutId = setTimeout(() => { try { abortController.abort(); } catch {} }, TRANSLATE_TIMEOUT_MS);
  const backstopP = new Promise((_, reject) => {
    backstopId = setTimeout(() => {
      reject(new Error('translate timed out — the translation backend may be stuck'));
    }, TRANSLATE_BACKSTOP_MS);
  });
  // Pre-translate runs in the background — log the failover to the diag
  // log, but show no pill (the user is not on this page).
  const failoverNotice = (p) => {
    if (p && p.failoverFrom && p.failoverTo) {
      logFailoverLine(p, 'Pre-translate:');
    }
  };
  let translated;
  try {
    translated = await Promise.race([
      translateBlocks(blocks, effSettings, failoverNotice, abortController.signal, 30000, () => runs.get(runId)?.cancelled === true),
      backstopP,
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (backstopId) clearTimeout(backstopId);
  }
  checkCancelled(runId);
  try {
    // 2.3.6: never store an all-empty tier-2 entry — it would count as
    // a hit (an empty array is truthy) and re-render the original.
    if (Array.isArray(translated) && translated.some(t => typeof t === 'string' && t.trim())) {
      await pageCachePut(tier2Key, {
        translations: translated,
        targetLang: settings.targetLang,
        backend: settings.translationBackend,
      });
    }
  } catch (e) {
    console.warn('[ct] pre-translate tier-2 cache write failed:', String((e && e.message) || e).slice(0, 120));
  }
}

async function runPipeline(tabId, opts = {}) {
  const manualSrc = opts.srcUrl || null;
  const runId = 'run-' + Date.now().toString(36) + '-' + (runSeq++) + '-' + Math.random().toString(36).slice(2, 8);
  // AbortController for in-flight translation fetches — aborted on cancel so
  // a 50-block translate doesn't keep burning quota after the user cancelled.
  const abortController = new AbortController();
  runs.set(runId, { cancelled: false, tabId, abortController });
  // Run footer numbers — function scope, so the catch block can log the
  // run footer on failure/cancel too. A let/const declared inside the try
  // is invisible to the catch (that was a ReferenceError: the footer
  // crashed instead of logging). runTotal/runAlreadyDone match the run
  // header; doneImgs counts the pictures translated in this run.
  let runTotal = 0, runAlreadyDone = 0;
  const doneImgs = [];
  // 2.1.20: show the persisted bench trace at the top of this run's log,
  // so one paste shows the full bench history (trigger, start, saves)
  // even after a worker restart wiped the in-memory lines.
  // 2.1.29: replay only the last 10 real lines (was 30), filter out the
  // retired lines, and trim the stored list to the last 5 real lines at
  // run start so the old noise is purged from storage, not just hidden.
  try {
    chrome.storage.local.get('benchTrace').then((saved) => {
      const arr = (saved && Array.isArray(saved.benchTrace)) ? saved.benchTrace : [];
      const kept = arr.filter((e) => e && !benchTraceIsRetired(e.line));
      const trimmed = kept.slice(-5);
      if (trimmed.length !== arr.length) {
        try { chrome.storage.local.set({ benchTrace: trimmed }); } catch {}
      }
    }).catch(() => {});
  } catch {}
  // Auto-resume needs the page address (same-page check) and the resume
  // count (loop guard) in the run record. Read the tab URL now, at run start.
  let runTabUrl = '';
  try { const t0 = await chrome.tabs.get(tabId).catch(() => null); runTabUrl = (t0 && t0.url) || ''; } catch {}
  persistRunRecord(runId, tabId, 'capture', {
    resumes: opts.resume ? (opts.resumeCount || 0) + 1 : 0,
    url: runTabUrl,
  }); // FIX1: see helpers above.
  const timings = {};
  const pipelineT0 = performance.now(); // overall wall-clock for this run
  const pxKeys = []; // IDB pixel-bus keys created this run; dropped in finally
  let result;
  // Settings for this run. Declared here (not inside the try) so the
  // catch below can read it: a const inside try is block-scoped to try
  // and referencing it in catch throws 'settings is not defined'.
  let settings = null;
  try {
    // 2.2.12: getSettings() lives inside the try now. It used to run before
    // the try, so a throw leaked the run record (persisted above) and the
    // runs-map entry — orphan recovery could later auto-resume a run that
    // never started.
    settings = await getSettings();
    keepAliveStart(runId); // FIX2: hold the background alive for this run only; released in finally.
    // ML worker warm-up (item 6, 2026-11-26 — James: start it from the
    // beginning of the whole pipeline): on Firefox the ML worker is only
    // started lazily at the first ML call (the LaMa preload below), and
    // its 5s ready wait can kill a slow worker before it finishes
    // loading. Start it here, at run start, so it warms up during the
    // model wait + capture + inventory instead. Fire-and-forget — the run
    // never waits for it; the first ML call still waits up to 5s for
    // ready as before. No-op on Chrome (no worker there).
    warmUpMlWorker();
    // Show the pill at once (1%): before this, a cache-hit run showed
    // nothing for seconds (waitForModels + capture) and then jumped
    // 2% -> 100%, so the user thought it was stuck. The pill must
    // appear the moment the run starts.
    try { setProgress(runId, 'capture', 0.01); } catch { /* pill is best-effort */ }
    // Auto-download (2.2.2): if the models are not here yet (install
    // download still going, or it never ran), fetch them now and wait,
    // showing progress in the pill, instead of failing the run.
    // 2.2.19: the wait is the gate for EVERY run — manual Translate,
    // right-click Send, auto, resume. No ML call runs before it (the
    // Chrome LaMa preload below moved after it), so a run can never
    // reach "model not in local cache" mid-pipeline.
    persistDiagStage(runId, 'models-wait');
    await waitForModels(runId);
    // 2.2.19: never start ML with a model still missing — if the wait
    // ever returns early, fail here with a clear error instead of
    // hitting "model not in local cache" at detect/OCR/inpaint.
    {
      const st = await getModelDownloadState().catch(() => null);
      if (st && st.missing.length) {
        throw new Error('models are not ready (' + st.missing.map(f => f.id).join(', ') + ' still missing) — the download did not finish; open Settings → Models and tap "Download all models".');
      }
    }
    // Firefox: pre-load the 206MB LaMa first, before detector/OCR fragment the
    // WASM heap. A fragmented heap can't provide the contiguous block LaMa needs.
    // (2.2.19: moved after the model gate — the preload is an ML call, and
    // no ML runs before the models are ready.)
    // Skip-inpaint (Debug setting): never load LaMa at all.
    if (directHandlers() && !settings.bypassInpaint) {
      persistDiagStage(runId, 'lama-preload');
      try { await callMl({ type: MSG.ML_ENSURE, model: 'inpaint' }); } catch (e) { diagPush('Inpaint preload failed, loading on demand: ' + String((e && e.message) || e).slice(0, 120)); }
    }
    // MEASURE1: thread-info diagnostic (best-effort, never fails the run).
    // Served by the same ML host as compute (worker on Firefox, offscreen
    // doc on Chrome — see ML_WORKER_TYPES in ml-bridge.js), so the numbers
    // describe the realm actually running WASM, not the background page.
    try {
      const d = await callMl({ type: MSG.ML_DIAG, runId }, { tabId });
      // First-startup detection, ML-realm number: if onInstalled missed
      // it (or the SW number differed), this first run saves it. Only
      // saves when missing or changed, never blocks the run.
      saveDetectedCores(d && d.hardwareConcurrency, 'thread-info');
    } catch (e) {
      diagPush('Could not read thread info: ' + String((e && e.message) || e).slice(0, 120));
    }
    // Chrome GPU1 (2.0.7): warm the shared GPU worker NOW, at pipeline
    // start, so the ~6s LaMa load overlaps detect/OCR/translate instead
    // of blocking the inpaint stage. Fire and forget — the run never
    // waits for it. If the worker is already warm this is ~free; if
    // warmup fails the normal GPU path still falls back to WASM.
    // Placed after ML_DIAG, so the offscreen doc is proven alive and
    // listening. Firefox already preloads above (awaited, for heap
    // reasons), so this is Chrome-only.
    if (!directHandlers()) {
      try {
        const p = chrome.runtime.sendMessage({ type: MSG.ML_GPU_WARMUP, runId });
        if (p && p.catch) p.catch(() => {});
      } catch {}
    }
    // Inject the overlay early so debug-stage payloads have a panel to land in.
    // content.js guards against double-injection; the canvas stays empty until render.
    // Gate on the host permission first: without it injection always fails, and
    // the error below names the fix instead of a cryptic browser message.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const tabUrl = (tab && tab.url) || '';
    const tabHost = hostOf(tabUrl);
    // 2.1.57: store the page address again now that it is known for sure.
    // The run-start read can miss (tab still restoring after a background
    // restart), and a record without it can never auto-resume.
    if (tabUrl) persistRunRecord(runId, tabId, persistedStageByRun.get(runId) || 'capture', { url: tabUrl });
    if (tabHost && !(await hasPageHostAccess(tabHost))) {
      throw settings.allowAllSites
        ? new Error('"Allow all sites" is on, but the extension no longer has access to all sites (the permission may have been revoked) — reopen Settings → Site access and turn it back on.')
        : hostAccessError(tabHost);
    }
    // Pre-translation join-or-cancel: if a background job is already
    // translating THIS page, wait for it (its cache write makes this run
    // a cache hit); an auto run for another page cancels the job (the user
    // went elsewhere); a manual run for another page leaves it alone.
    persistDiagStage(runId, 'pretranslate-join');
    await joinOrCancelPretranslate(runId, tabUrl, !!opts.auto);
    // Ping the content script first: if it answers, it is already in the
    // page and the injection is skipped — on Orion the injection can hang
    // forever (neither resolve nor reject), so a run must never wait on it
    // when the script is already there. The ping IS the RUN_STARTED message
    // (it replies {ok:true}), so a successful ping has already told the
    // page this run is the current one.
    let contentScriptReady = false;
    try {
      await withTimeout(chrome.tabs.sendMessage(tabId, { type: MSG.RUN_STARTED, runId }), MSG_TIMEOUT_MS, 'content script ping');
      contentScriptReady = true;
    } catch { /* no content script yet — inject it below */ }
    if (!contentScriptReady) {
      // Injection has no completion event beyond its own promise, and on
      // Orion that promise can hang forever (neither resolve nor reject)
      // — the 5s MSG_TIMEOUT_MS race is the only guard. The ping above
      // already proved the script is absent, so waiting here is correct.
      try {
        await withTimeout(chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES }), MSG_TIMEOUT_MS, 'content script injection');
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/host permission/i.test(msg) && tabHost) throw hostAccessError(tabHost);
        throw new Error('could not access this tab (extension pages and some sites block injection): ' + msg.slice(0, 100));
      }
      // Tell the page this run is the current one. A render from any older run
      // (e.g. a page the user already left) is ignored by the content script.
      // (2.1.60: the run-start marker clear now keeps markers on pictures
      // still showing a data URL, so no resume flag is needed here.)
      try {
        await withTimeout(chrome.tabs.sendMessage(tabId, { type: MSG.RUN_STARTED, runId }), MSG_TIMEOUT_MS, 'content script ping');
      } catch { /* content script not there yet */ }
    }
    persistDiagStage(runId, 'inventory');
    // Auto-translate only: lazy pictures below the fold have not loaded
    // yet, so the inventory would skip them. Force the page to load
    // every picture first (content script scrolls through the page, then
    // jumps back). Best-effort with a timeout — a failure or timeout
    // must never block the run; translate whatever loaded.
    // Pipelined auto (James's order: "wait only for the pictures that
    // will be translated ... as soon as first qualified pic is loaded,
    // it can start translating the first. do not wait everything to
    // start"): force-load runs in the BACKGROUND — the run does not await
    // the whole load before starting. It polls ct/list-images until the
    // first qualifying picture appears, translates pictures from a work
    // queue as they load (see refillPipelineQueue, called from the
    // per-image loop), and ends when force-load has settled AND the queue
    // is empty AND a final poll finds nothing new. Manual runs do not
    // force-load at all and are untouched by everything below.
    const isPipelined = !!(opts.auto && !manualSrc);
    let forceLoadSettled = false;
    // Queue state for the pipelined auto run (null on the manual path).
    // pickedCount counts every eligible picture ever picked (including
    // already-translated ones — the per-run cap is applied before that
    // skip, as getPipelineImages does); alreadyDone counts the
    // already-translated pictures dropped per batch; lastProgress is the
    // progress high-water mark (the pill never goes backwards as the
    // total grows); gatedCount is how many pictures the initial
    // permission gate covered (later pictures are checked per image).
    let pipe = null;
    let refillPipelineQueue = null;
    if (isPipelined) {
      pipe = { seen: new Set(), pickedCount: 0, skippedDetail: [], skippedSeen: new Set(), alreadyDone: 0, ignored: 0, lastProgress: 0, gatedCount: 0, pillSent: false };
    }
    if (opts.auto && !manualSrc) {
      // TODO: the 20s cap has no measured origin in the code — scroll time
      // grows with page length, so a very long chapter may always time out
      // here. Best-effort only (a timeout never blocks the run), so the
      // cost is a slow start, not a failure. No event exists — the content
      // script's reply is the only completion signal. The 20s cap stays:
      // the race below settles the run's completion signal at 20s even if
      // the content script is still scrolling.
      // A synchronous throw from sendMessage (dead tab) must not fail the
      // run — force-load is best-effort, as the old awaited version's
      // try/catch was. Mark it settled so the wait loop below does not
      // spin forever on a signal that will never come.
      let forceLoadPromise;
      try {
        forceLoadPromise = Promise.race([
          chrome.tabs.sendMessage(tabId, { type: 'ct/force-load-images' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('force-load timeout')), 20000)),
        ]);
      } catch (e) {
        diagPush('Force-load skipped: ' + String((e && e.message) || e).slice(0, 80));
        forceLoadSettled = true;
        forceLoadPromise = Promise.reject(e);
        forceLoadPromise.catch(() => {});
      }
      forceLoadPromise.then(
        r => {
          diagPush('Force-load: ' + (r && r.ok ? (r.loaded + '/' + r.total + ' pictures loaded in ' + r.ms + 'ms' + (r.scrolled ? ' (' + r.steps + ' scroll steps)' : '') + ((r.filterSkipped || 0) ? ', ' + r.filterSkipped + ' skipped' : '')) : 'failed: ' + String((r && r.error) || 'no reply').slice(0, 80)));
          forceLoadSettled = true;
        },
        e => {
          diagPush('Force-load skipped: ' + String((e && e.message) || e).slice(0, 80));
          forceLoadSettled = true;
        },
      );
    }
    // Pipelined inventory helpers. pollPipelineImages is the non-throwing
    // wrapper around getPipelineImages: while force-load is still running
    // an empty inventory only means "not loaded yet", so it returns null
    // instead of throwing; once force-load has settled it rethrows the
    // original "no pictures" error, so a truly empty page fails exactly
    // as before. takeNewPipelineImages absorbs one poll into the queue
    // state: dedupes by uid (falling back to src), enforces the cumulative
    // 50-image cap across polls (pictures past the cap go to
    // skippedDetail with the over-cap reason, as getPipelineImages does),
    // accumulates skippedDetail (deduped by src+reason), drops
    // already-translated pictures (counted in pipe.alreadyDone), and
    // removes a stale skip entry when a picture qualifies after all
    // (e.g. its displayed size grew once loaded).
    const pollPipelineImages = async () => {
      try {
        return await getPipelineImages(tabId, settings, tabUrl, { srcUrl: manualSrc, quiet: true });
      } catch (e) {
        if (!forceLoadSettled) return null;
        throw e;
      }
    };
    const takeNewPipelineImages = (r, target) => {
      if (!pipe || !r) return;
      if (Array.isArray(r.skippedDetail)) {
        for (const d of r.skippedDetail) {
          const key = (d.src || '') + '|' + (d.reason || '');
          if (!pipe.skippedSeen.has(key)) { pipe.skippedSeen.add(key); pipe.skippedDetail.push(d); }
        }
      }
      if (typeof r.ignored === 'number') pipe.ignored = r.ignored;
      for (const im of r.images || []) {
        const key = im.uid ? 'uid:' + im.uid : 'src:' + (im.src || '');
        if (pipe.seen.has(key)) continue;
        pipe.seen.add(key);
        if (pipe.pickedCount >= MAX_IMAGES_PER_PAGE) {
          const d = { w: im.w || 0, h: im.h || 0, src: im.src || '', reason: `over ${MAX_IMAGES_PER_PAGE}-image per-run cap` };
          const k2 = (d.src || '') + '|' + d.reason;
          if (!pipe.skippedSeen.has(k2)) { pipe.skippedSeen.add(k2); pipe.skippedDetail.push(d); }
          continue;
        }
        pipe.pickedCount++;
        if (im.translated) { pipe.alreadyDone++; continue; }
        const si = pipe.skippedDetail.findIndex(d => d.src && d.src === im.src);
        if (si >= 0) { pipe.skippedSeen.delete(pipe.skippedDetail[si].src + '|' + pipe.skippedDetail[si].reason); pipe.skippedDetail.splice(si, 1); }
        target.push(im);
      }
    };
    // Wait for the first qualifying picture before taking the inventory
    // below — the inventory throws on an empty page, and while force-load
    // is still running "empty" only means "not loaded yet". Polls every
    // ~500ms. If force-load settles with nothing, the inventory below
    // throws the original error, exactly as before.
    if (isPipelined) {
      for (;;) {
        checkCancelled(runId);
        let r = null;
        try { r = await pollPipelineImages(); } catch (e) { throw e; }
        if (r && (r.images || []).length) break;
        if (forceLoadSettled) break;
        await new Promise(res => setTimeout(res, 500));
      }
    }
    // ---- 1. inventory: every qualifying picture on the page (multi-pic).
    // Each one then runs the full pipeline; per-image stage progress maps onto
    // its slice of the overall run, debug titles carry the image index, and one
    // bad picture never kills the rest of the run.
    let { images, skipped, skippedDetail, ignored, inventoryHosts, inventoryMissing, inventoryTotal } = await getPipelineImages(tabId, settings, tabUrl, { srcUrl: manualSrc });
    if (isPipelined) {
      // First batch through the queue state: already-translated pictures
      // are dropped here (counted in pipe.alreadyDone) instead of by the
      // shared skip below, and the per-poll skip strings are deferred —
      // the cumulative strings are built after the loop, once the total
      // is known. skippedDetail here IS pipe.skippedDetail (same array),
      // so later polls keep accumulating into it.
      const firstBatch = [];
      takeNewPipelineImages({ images, skippedDetail, ignored }, firstBatch);
      images = firstBatch;
      skipped = [];
      skippedDetail = pipe.skippedDetail;
      ignored = pipe.ignored;
      // Refill the work queue from later polls. Appends newly loaded
      // pictures straight onto `images` — the per-image loop below
      // iterates that same array, so appended pictures are picked up in
      // order. Called at the end of each picture: a quick poll when more
      // pictures are already queued, and a ~500ms poll loop (until new
      // pictures arrive or force-load settles) when the queue is empty.
      // Ends when force-load has settled AND the queue is empty AND a
      // final poll finds nothing new.
      refillPipelineQueue = async (waitForMore) => {
        for (;;) {
          checkCancelled(runId);
          let r = null;
          try { r = await pollPipelineImages(); } catch { r = null; }
          if (r) {
            const before = images.length;
            takeNewPipelineImages(r, images);
            if (images.length > before) return;
          }
          if (forceLoadSettled) {
            let extra = null;
            try { extra = await getPipelineImages(tabId, settings, tabUrl, { srcUrl: manualSrc, quiet: true }); } catch { extra = null; }
            if (extra) takeNewPipelineImages(extra, images);
            return;
          }
          if (!waitForMore) return;
          await new Promise(res => setTimeout(res, 500));
        }
      };
    }
    // Skip pictures already translated (they show the translated render).
    // Resumed runs: the dead run already finished them, so the resumed run
    // finishes from where the old one left instead of redoing the page.
    // Auto runs: a late page-load signal can fire after the page is already
    // translated (the 2-min dedupe has expired), and re-translating them
    // wastes time and API calls. Manual runs never skip — the user tapped
    // Translate, so they want a fresh translation (e.g. after changing the
    // target language).
    let alreadyDone = 0;
    if ((opts.resume || opts.auto) && !manualSrc) {
      if (pipe) {
        // Pipelined: takeNewPipelineImages already dropped the
        // already-translated pictures (counted in pipe.alreadyDone), so
        // `images` holds only pictures left to translate.
        alreadyDone = pipe.alreadyDone;
        if (!images.length) {
          if (!forceLoadSettled) {
            // Nothing to translate YET — more pictures may still load.
            // The per-image loop below cannot run on an empty list, so
            // wait here for new pictures (or force-load settling) before
            // the gate; the loop's refill then keeps polling.
            await refillPipelineQueue(true);
            alreadyDone = pipe.alreadyDone;
          }
          if (!images.length && forceLoadSettled) {
            // Everything is already translated — nothing left to do.
            // (Refill above already ran the final poll, so this is final.)
            diagPush(`All ${pipe.pickedCount} picture${pipe.pickedCount === 1 ? '' : 's'} already translated — nothing to do.`);
            ignored = pipe.ignored;
            timings.total = Math.round(performance.now() - pipelineT0);
            setProgress(runId, 'done', 1, { backendLabel: settings.translationBackend });
            try {
              await withTimeout(chrome.tabs.sendMessage(tabId, {
                type: 'ct/run-summary', runId, images: 0, failed: [], ignored,
                resumed: !!opts.resume, alreadyDone,
              }), MSG_TIMEOUT_MS, 'run summary');
            } catch {}
            if (settings.debugMode) await sendDiagLog(tabId, runId);
            result = { runId, ok: true, images: 0, imageSrcs: [], failed: [], resumed: !!opts.resume, alreadyDone };
            return result;
          }
          // Fresh pictures arrived while waiting — fall through to the
          // gate and the queue loop with them.
        }
      } else {
      alreadyDone = images.filter(im => im.translated).length;
      // 2.1.57: always count, even when 0 — a resumed run that finds
      // nothing already done is the clue that the inventory disagrees
      // with the recovery check (e.g. the page reloaded between the two).
      // The count goes in the run header below, not its own line.
      if (alreadyDone) {
        images = images.filter(im => !im.translated);
      }
      if (!images.length) {
        // Everything is already translated — nothing left to do.
        diagPush(`All ${alreadyDone} picture${alreadyDone === 1 ? '' : 's'} already translated — nothing to do.`);
        timings.total = Math.round(performance.now() - pipelineT0);
        setProgress(runId, 'done', 1, { backendLabel: settings.translationBackend });
        try {
          await withTimeout(chrome.tabs.sendMessage(tabId, {
            type: 'ct/run-summary', runId, images: 0, failed: [], ignored,
            resumed: !!opts.resume, alreadyDone,
          }), MSG_TIMEOUT_MS, 'run summary');
        } catch {}
        if (settings.debugMode) await sendDiagLog(tabId, runId);
        result = { runId, ok: true, images: 0, imageSrcs: [], failed: [], resumed: !!opts.resume, alreadyDone };
        return result;
      }
      }
    }
    // Run header numbers (logged once, after the permission gate below):
    // total pictures found and how many were already translated. Pipelined
    // counts from the queue state; otherwise the filtered list plus the
    // already-done count. Skipped (below-min / over-cap) pictures are not
    // listed here — the run-end footer names them.
    runTotal = pipe ? pipe.pickedCount : images.length + alreadyDone;
    runAlreadyDone = alreadyDone;
    // Permission gate: ask for ALL possible permissions ONCE, BEFORE the run
    // starts — the page host and every picture host (exact + wildcard), in a
    // single permissions.request. Do not rely on the contains check to decide
    // what is missing: it said i4 was permitted, yet the fallback tab still
    // failed there with "Missing host permission". permissions.request only
    // prompts for what is not yet granted, so if everything is already
    // allowed it resolves at once and the run proceeds. If the prompt cannot
    // show or the user denies it, re-check and fall back to the gate error
    // so the popup still offers the grant button.
    const pageHost = hostOf(tabUrl) || '';
    const allOrigins = new Set();
    if (pageHost) for (const o of imageHostOrigins(pageHost)) allOrigins.add(o);
    for (const im of images || []) {
      try {
        const h = new URL(im.src).hostname.toLowerCase();
        if (h) for (const o of imageHostOrigins(h)) allOrigins.add(o);
      } catch { /* unparsable src — skipped by the contains check below */ }
    }
    let promptGranted = false;
    // Only prompt from a user gesture (manual Translate). On an auto run
    // permissions.request always fails ("may only be called from a user
    // input handler"), so calling it there is a wasted round-trip and a
    // "prompt failed" line in every run's log. Auto runs skip straight
    // to the contains check below; if a host is missing, the gate error
    // tells the user to open the popup and tap Grant (a real gesture).
    if (!opts.auto) {
      try {
        promptGranted = await chrome.permissions.request({ origins: [...allOrigins] });
      } catch (e) { /* prompt failure is covered by the contains check below */ }
    }
    const missingHosts = await checkImageHostPermissions(images);
    if (missingHosts.length) {
      for (const h of missingHosts) await recordMissingHost('https://' + h + '/');
      diagPush('Host permission missing for ' + missingHosts.join(', ') + ' — open the popup and tap Grant access.');
      const label = displayHost(missingHosts[0]);
      try {
        await withTimeout(chrome.tabs.sendMessage(tabId, {
          type: MSG.PILL_NOTICE,
          text: `Pictures on ${label} need permission — open the popup and tap Grant access, then run translate again.`,
          sticky: true,
        }), MSG_TIMEOUT_MS, 'pill notice');
      } catch { /* pill is best-effort */ }
      const gateErr = new Error(
        `Pictures on ${label} need permission — open the extension popup and tap "Grant access", then run translate again. (${missingHosts.length} host${missingHosts.length > 1 ? 's' : ''} missing permission)`,
      );
      gateErr.grantHost = missingHosts[0];
      gateErr.grantHosts = missingHosts;
      throw gateErr;
    } else {
      // Gate passed — log which hosts were checked, so a pass is visible
      // in the log too (not only a block). Without this, a run that
      // translates 8 of 30 shows no gate line at all, and permission for
      // the listed hosts cannot be confirmed from the log.
      const gateHosts = [...new Set((images || []).map(im => { try { return new URL(im.src).hostname.toLowerCase(); } catch { return ''; } }).filter(Boolean))];
      // Run header — one line: how many pictures, on which hosts, how
      // many already translated. (Human-readable log, James, 2026-11-26.)
      const headerHosts = (inventoryHosts && inventoryHosts.length ? inventoryHosts : gateHosts).join(', ') || 'this page';
      // A missing grant on a big picture that did NOT make the inventory
      // (e.g. still loading) does not block this run — it is not being
      // translated — but it is logged, so the reason it never appears is
      // visible. (The old "inventory-diag big-pic hosts" line did this.)
      if (inventoryMissing && inventoryMissing.length) diagPush('Host permission missing for ' + inventoryMissing.join(', ') + ' (pictures not in this run).');
      diagPush(`Run: ${runTotal} picture${runTotal === 1 ? '' : 's'} on ${headerHosts}, ${runAlreadyDone} already translated, all hosts allowed`);
    }
    // Pipelined: the gate above covered exactly these pictures. Pictures
    // appended to `images` later were never seen by it, so the loop
    // checks each of them per image instead (see below).
    if (pipe) pipe.gatedCount = images.length;
    const failedImgs = [];
    // URLs of the finished images, for the free daily quota — the quota
    // counts distinct images only, so a re-translation of the same URL
    // is free (see addProUsageForImages).
    const doneSrcs = [];
    // Same finished images with their size, for the quota count — one
    // image counts as one, whatever its height (long strips are 1:1).
    const doneCountEntries = [];
    // Per-picture failure detail for the run-end missed accounting (size,
    // host, reason) — failedImgs only carries the message string.
    const missedDetail = [];
    // Skipped pictures (below min size, over the cap) count as "not
    // translated" in the run summary, so the user knows why some pictures
    // on the page did not change.
    if (skipped.length) failedImgs.push(...skipped);
    let fallbackUrl = null;
    let lastDoneExtra = null;
    let multi = images.length > 1;
    // GPU1 per-run downgrade: set on any GPU failure (error or hang),
    // so GPU is never retried again in THIS run. Next run tries GPU
    // fresh (per-run stick only, per spec). Shared across images in
    // this run; dies with the run in finally (runs.delete(runId)).
    let gpuDowngradedThisRun = false;
    // Per-image worker (nested: closes over runId, settings, tabId, tabUrl,
    // manualSrc, abortController, gpuDowngradedThisRun, opts). One image's
    // pixels are loaded just before its stages run; its pixel-bus keys are
    // dropped by the caller after each image, so only one image's bytes are
    // ever live alongside the WASM sessions.
    async function runOneImage(img, imgSetProgress, imgEmitDebug, imgTimings, imgPxKeys, imgT0, preCaptured, imgNo) {
      // ---- 1. capture: the page's own picture (min-size gated), else viewport
      imgSetProgress('capture', 0.02);
      let t0 = performance.now();
      let rgba, w, h, mode, tier, attempts;
      // Per-image preCaptured wins (auto 403 fallback, one image at a time);
      // the run-level opts.preCaptured is the manual-send fallback for the
      // whole run. Either way the pixels were read from a background tab
      // where the image is same-origin, so skip the download tiers.
      const pre = preCaptured || opts.preCaptured;
      if (pre) {
        // 403 fallback: pixels were read from a background tab where the image
        // is same-origin. Skip the download tiers entirely; the rest of the
        // pipeline (detect → OCR → translate → inpaint → render) runs normally
        // on the original tab, replacing the picture in place.
        ({ rgba, w, h } = pre);
        mode = 'replace';
        tier = 'fallback-tab';
      } else {
        ({ rgba, w, h, mode, tier, attempts } = await loadPipelineImagePixels(tabId, img, settings, tabUrl, { srcUrl: manualSrc, runId }));
      }
      imgTimings.capture = Math.round(performance.now() - t0);
      imgTimings.tier = tier;
      // Human-readable capture: one picture line (size, download bytes)
      // and one capture line (which tier won, how long, what the failed
      // tiers hit — plain words, not browser errors). The log answers
      // "internet or local?" on its own: page canvas is local (the picture
      // was already in the page); page/worker-fetch download it, so a slow
      // fetch with a big byte count is the server or the connection.
      const capAttempts = attempts || [];
      const capWin = capAttempts.find(a => a.ok);
      diagPush(`Picture ${imgNo || '?'}: ${w}x${h}${capWin && capWin.bytes != null ? ', ' + fmtBytes(capWin.bytes) : ''}`);
      const capFails = capAttempts.filter(a => !a.ok);
      let capLine = `  Captured by ${plainTierName(tier)} in ${imgTimings.capture} ms`;
      if (capFails.length) {
        const whys = capFails.map(a => {
          const t = a.tier === 'page-canvas' ? 'Page canvas' : a.tier === 'page-fetch' ? 'page fetch' : plainTierName(a.tier);
          return t + ' ' + shortCaptureWhy(a.error);
        });
        capLine += '. ' + whys.join(', ');
      }
      diagPush(capLine + '.');
      // Single source of truth for dimensions: normalize ALL capture tiers to
      // renderScale dims HERE, once. Tier 1a (page canvas) already downscales,
      // but tiers 1b/1c (fetches) return full-res — without this, detector
      // boxes, cache keys, and Tier-1 entries disagree on the coordinate system.
      // Everything downstream (detect, OCR, inpaint, cache) uses these scaled w/h.
      {
        const cs = renderScale(w, h);
        if (cs < 1) {
          const sw = Math.max(1, Math.round(w * cs)), sh = Math.max(1, Math.round(h * cs));
          rgba = resizeBilinearRGBA(rgba, w, h, sw, sh);
          w = sw; h = sh;
        }
      }
      const capMean = meanBrightness(rgba);
      if (capMean < 0.004) {
        throw new Error(
          `captured image came back blank (all pixels black) via "${tier}" — ` +
          `the page's picture could not be read. Reload the page and try again; ` +
          `if it persists, the site may be blocking pixel access.`);
      }
      // The data-URL image is only built in debug mode — in normal runs this
      // PNG encode of the full page is pure overhead.
      await imgEmitDebug('capture',
        { title: `Captured page — ${tier}, mean brightness ${capMean.toFixed(3)}`, image: settings.debugMode ? await rgbaToDataURL(rgba, w, h) : null, w, h, bytes: (capWin && capWin.bytes != null ? capWin.bytes : null), ms: imgTimings.capture });

      // ---- 1b. page cache: a page translated earlier in this session renders
      // instantly — no detection, OCR, inpaint, or translation. The stored entry
      // is re-sent as ct/render, so the content script re-composites the text
      // with the CURRENT font settings; font-size tweaks never invalidate it.
      // An early return inside try still runs the finally below (runs.delete +
      // dropping staged pixel payloads), so cleanup is unchanged.
      checkCancelled(runId);
      const cacheHit = await lookupPageCache(rgba, w, h, settings, tabId, tier);
      if (cacheHit) {
        if (cacheHit.tier1Only) {
          // Translate-only path: Tier-1 gave us inpainted base + OCR blocks.
          // Translate to the new targetLang, store Tier-2, render.
          const tier1Res = await renderFromTier1(tabId, runId, cacheHit.entry, cacheHit.tier2Key,
            settings, imgTimings, manualSrc || img.src, rgba, w, h, mode, tier, img.uid, imgSetProgress);
          if (tier1Res && tier1Res.ok && Number.isFinite(imgTimings.translate)) {
            diagPush(`  Translated by ${tier1Res.doneExtra?.backendLabel || settings.translationBackend} in ${imgTimings.translate} ms.`);
          }
          return tier1Res;
        }
        diagPush('  Served from cache.');
        return await renderFromPageCache(tabId, runId, cacheHit, settings, imgTimings, manualSrc || img.src, { fromCache: true, uid: img.uid, onProgress: imgSetProgress });
      }

      // ---- 2. detection (+ tall-image slicing)
      checkCancelled(runId);
      imgSetProgress('detect', 0.1);
      t0 = performance.now();
      let detections, detectInputMean = null;
      if (h / w > 3.5) {
        detections = await detectSliced(rgba, w, h, settings.detectionThreshold, runId, imgPxKeys);
      } else {
        // NOTE: pixel bytes go through the IDB pixel bus — chrome.runtime
        // messaging drops ArrayBuffers sent from the service worker.
        const pxKey = `detect:${runId}`;
        imgPxKeys.push(pxKey);
        await pixelPut(pxKey, rgba.buffer);
        const r = await callMlChecked(runId, { type: MSG.ML_DETECT, key: pxKey, width: w, height: h, threshold: settings.detectionThreshold, runId });
        detections = r.boxes;
        imgTimings.detect = r.ms;
        detectInputMean = r.inputMean;
        if (detectInputMean != null && detectInputMean < 0.004) {
          throw new Error(`the detector received a blank image (input mean ${detectInputMean}) ` +
            `although the capture looked fine (mean ${capMean.toFixed(3)}) — pixel data was lost ` +
            `between capture and detection. Reload the page and try again.`);
        }
      }
      if (!imgTimings.detect) imgTimings.detect = Math.round(performance.now() - t0);
      imgSetProgress('detect', 0.25);
      await imgEmitDebug('detect', {
        title: `Detection — ${detections.length} boxes @ ≥${settings.detectionThreshold}` +
          (detectInputMean != null ? ` (detector input mean ${detectInputMean})` : ''),
        boxes: detections, w, h, threshold: settings.detectionThreshold, ms: imgTimings.detect,
        image: settings.debugMode ? await rgbaToDataURL(rgba, w, h) : null,
      });

      // ---- 3. text blocks
      checkCancelled(runId);
      t0 = performance.now();
      const blocks = buildBlocks(detections, w, h, rgba, settings);
      imgTimings.blocks = Math.round(performance.now() - t0);
      imgTimings.blockCount = blocks.length;
      imgSetProgress('blocks', 0.3);
      // Promotion visibility: how many blocks came from bubbles with no
      // text box. 0 on a page where detection is already good (no-op).
      // A large number here on other pages would mean over-firing.
      if (blocks.promotedCount) diagPush(`  ${blocks.promotedCount} text block${blocks.promotedCount === 1 ? '' : 's'} came from bubbles with no text box.`);
      await imgEmitDebug('blocks', {
        title: `Text blocks — ${blocks.length}` + (blocks.promotedCount ? ` (${blocks.promotedCount} promoted from bubbles)` : ''),
        blocks: blocks.map((b, i) => ({
          i, text_class: b.text_class,
          xyxy: b.xyxy.map(v => Math.round(v)),
          bubble_xyxy: b.bubble_xyxy ? b.bubble_xyxy.map(v => Math.round(v)) : null,
          font_color: b.font_color,
        })),
        ms: imgTimings.blocks,
      });
      // No text found: nothing to translate, inpaint, render, or cache
      // (writePageCache refuses empty blocks, so the next visit
      // re-detects). Return early so the picture is NOT counted toward
      // the free quota either — counting it would charge the user for
      // nothing, and again on every revisit. The caller skips it in
      // doneImgs/doneCountEntries when r.noText is set.
      if (!blocks.length) { diagPush('  No text in this picture.'); return { ok: true, noText: true }; }

      // ---- 4. OCR (sequential — the mask stage needs blk.text, so it must
      // wait for OCR; see buildBlockMaskData's `if (!blk.text ...)` guard).
      checkCancelled(runId);
      imgSetProgress('ocr', 0.38);
      {
        // DIAG (2.0.9): prep = crop building + pixelPut (SW side, invisible
        // in r.ms); call = the ML round trip; load rides on r.loadMs.
        const ocrPrepT0 = performance.now();
        const crops = [];
        for (const [i, b] of blocks.entries()) {
          const c = cropForBlock(rgba, w, h, b.xyxy, b.bubble_xyxy);
          if (!c) continue;
          const pxKey = `ocr:${runId}:${i}`;
          imgPxKeys.push(pxKey);
          await pixelPut(pxKey, c.data.buffer);
          crops.push({ id: i, key: pxKey, data: c.data, width: c.w, height: c.h, x: c.x, y: c.y, bw: b.xyxy[2] - b.xyxy[0], bh: b.xyxy[3] - b.xyxy[1] });
        }
        const ocrPrepMs = Math.round(performance.now() - ocrPrepT0);
        let ocrMs = 0, ocrEngineLabel = '', ocrCallMs = 0;
        // Per-crop OCR diagnostics for the debug panel: char count and whether
        // this crop needed the Baberu chunked re-OCR (v1.1: >256 chars, rare).
        const ocrStats = new Map();
        if (crops.length) {
          const ocrCallT0 = performance.now();
          // OCR is single-worker (2.1.26): the 2-worker pool (2.1.10-2.1.25)
          // was removed — it never beat single on any page (standard page
          // pool 4,932ms vs single 4,920ms; dense page pool 8,121ms vs
          // single 7,961ms). Single uses the measured best thread count
          // (4 on the M4) via threadsReady() in the doc. The thread bench
          // itself stays: it measures and saves the best count, and single
          // OCR reads it on every run.
          const r = await callMlChecked(runId, {
            type: MSG.ML_OCR, runId, sourceLang: settings.sourceLang, useDistil: settings.ocrDistilTest,
            crops: crops.map(({ id, key, width, height }) => ({ id, key, width, height })),
          });
          ocrCallMs = Math.round(performance.now() - ocrCallT0);
          ocrMs = r.ms;
          ocrEngineLabel = (MODEL_GROUPS.find(g => g.id === r.engine) || {}).label || r.engine || '';
          imgTimings.ocrEngine = r.engine || '';
          for (const res of r.results) {
            blocks[res.id].text = res.text;
            ocrStats.set(res.id, { chars: res.chars, chunks: res.chunks, hitCeiling: res.hitCeiling, stopped: res.stopped, skipped: !!res.skipped });
          }
          // DIAG (2.0.9): OCR split + slowest crops, so one Mac run shows
          // whether OCR time is one long crop, even per-crop cost, or the
          // Baberu load — the fix depends on which it is.
          const cropById = new Map(crops.map(c => [c.id, c]));
          let ocrChars = 0, ocrSkipped = 0;
          const ocrSlow = [];
          for (const res of r.results) {
            ocrChars += res.chars || 0;
            if (res.skipped) ocrSkipped++;
            const cc = cropById.get(res.id);
            ocrSlow.push({ id: res.id, w: cc ? cc.width : 0, h: cc ? cc.height : 0, chars: res.chars || 0, chunks: res.chunks || 0, skipped: !!res.skipped, ms: res.ms || 0 });
          }
          ocrSlow.sort((a, b) => b.ms - a.ms);
        }
        imgTimings.ocr = ocrMs;
        imgSetProgress('ocr', 0.55);
        const ocrThumbs = [];
        // Thumbnails are debug-panel only — skip the 40 canvas encodes in normal runs.
        if (settings.debugMode) {
          for (const c of crops.slice(0, 40)) {
            ocrThumbs.push({
              id: c.id, text: blocks[c.id].text,
              ...(ocrStats.get(c.id) || {}),
              thumb: await rgbaToDataURL(c.data, c.width, c.height, 200),
            });
          }
        }
        const ocrTextCount = blocks.filter(b => b.text && b.text.trim()).length;
        const clippedCount = [...ocrStats.values()].filter(s => s.hitCeiling).length;
        await imgEmitDebug('ocr', {
          title: `OCR — ${crops.length} crops, ${ocrTextCount} with text${ocrEngineLabel ? ` (${ocrEngineLabel})` : ''}` +
            (clippedCount ? `, ${clippedCount} hit the 256-char model cap (re-OCR'd in chunks)` : ''),
          crops: ocrThumbs, ms: ocrMs,
        });
      }

      // Auto-detect source language: Baberu reads all four scripts, so vote
      // across the OCR'd blocks. Undetectable -> 'ja', the old default.
      let effSettings = settings;
      if (settings.sourceLang === 'auto') {
        const detected = detectPageLang(blocks.map(b => b.text));
        effSettings = { ...settings, sourceLang: detected || 'ja' };
        for (const b of blocks) b.source_lang = effSettings.sourceLang;
      }
      // Failover is free, not a Pro feature (2026-11-26): never gated by
      // the daily limit, so a Gemini failure always falls over to Google.

      // ---- 5+6+7. translate || (mask -> inpaint). Translate and mask both need
      // only the OCR text and are independent of each other (translate: network
      // I/O here; mask: CPU here). Inpaint needs the mask, so it chains off the
      // mask promise and starts as soon as the mask is done — it does not wait
      // for translate. Render waits for both translate and inpaint.
      checkCancelled(runId);
      const par = { translate: 0, mask: 0, inpaint: 0 };
      let parMax = 0.58;
      const parProgress = (branch, frac) => {
        par[branch] = frac;
        parMax = Math.max(parMax, 0.58 + 0.32 * (par.translate + par.mask + par.inpaint) / 3);
        imgSetProgress(branch, parMax);
      };
      // Long tiled inpaints feed per-tile progress through this (Firefox: the
      // ML host shares this page; Chrome: forwarded from the offscreen doc).
      // The pill keeps moving instead of looking stalled at one percentage
      // for minutes.
      runs.get(runId).onInpaintProgress = (frac) => parProgress('inpaint', frac);
      const runTranslate = async () => {
        parProgress('translate', 0);
        const t0t = performance.now();
        // 30s aborts the CURRENT attempt so translateBlocks can fail over:
        // rejecting the race directly used to bypass failover entirely, so a
        // stalled backend never switched to Azure. The 60s backstop kills a
        // run wedged past stall (30s) + rescue (20s).
        const TRANSLATE_TIMEOUT_MS = 30000;
        const TRANSLATE_BACKSTOP_MS = 60000;
        let timeoutId = null, backstopId = null;
        timeoutId = setTimeout(() => {
          try { abortController.abort(); } catch { /* already aborted */ }
        }, TRANSLATE_TIMEOUT_MS);
        const backstopP = new Promise((_, reject) => {
          backstopId = setTimeout(() => {
            reject(new Error('translate timed out — the translation backend may be stuck'));
          }, TRANSLATE_BACKSTOP_MS);
        });
        let translated;
        try {
          const failoverNotice = (p) => {
            if (p && p.failoverFrom && p.failoverTo) {
              logFailoverLine(p);
              chrome.tabs.sendMessage(tabId, {
                type: MSG.PILL_NOTICE,
                text: `Engine ${p.failoverFrom} failed — retrying with ${p.failoverTo}`,
                sticky: false,
              }).catch(() => {});
            }
          };
          translated = await Promise.race([
            translateBlocks(blocks, effSettings, failoverNotice, abortController.signal, 30000, () => runs.get(runId)?.cancelled === true),
            backstopP,
          ]);
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
          if (backstopId) clearTimeout(backstopId);
        }
        checkCancelled(runId);
        blocks.forEach((b, i) => { b.translation = translated[i]; });
        const translateMs = Math.round(performance.now() - t0t);
        parProgress('translate', 1);
        await imgEmitDebug('translate', {
          // Title shows the backend that ACTUALLY translated, not the
          // configured one — after failover they differ, and the old title
          // always said Google even when Azure/LM Studio did the work.
          title: `Translation — ${BACKEND_LABEL[blocks[0]?.backendUsed || settings.translationBackend] || settings.translationBackend}`,
          rows: blocks.map(b => ({ text: b.text, translation: b.translation, backend: b.backendUsed || settings.translationBackend })),
          ms: translateMs,
        });
        return { translateMs };
      };
      const runMask = async () => {
        parProgress('mask', 0);
        const t0m = performance.now();
        const pageGray = toGrayU8(rgba, w, h);
        const { mask: fullMask, entries } = generateMask(rgba, w, h, pageGray, blocks, 5);
        const maskMs = Math.round(performance.now() - t0m);
        parProgress('mask', 1);
        await imgEmitDebug('mask', {
          title: `Mask — ${entries.length} block masks`,
          mask: settings.debugMode ? await rgbaToDataURL(maskToRGBA(fullMask, w, h), w, h) : null, ms: maskMs,
        });
        return { fullMask, entries, maskMs };
      };
      const runInpaint = async ({ fullMask, entries, maskMs }) => {
        checkCancelled(runId);
        // Skip-inpaint (Debug setting): skip LaMa entirely — the translated text
        // renders over the original image. The model is never loaded, so
        // a device that dies loading LaMa stays alive.
        if (settings.bypassInpaint) {
          parProgress('inpaint', 1);
          return { inpainted: new Uint8ClampedArray(rgba), inpaintMs: 0, maskMs, totalInpaintMs: 0 };
        }
        parProgress('inpaint', 0);
        const t0i = performance.now();
        // DIAG (2.0.5): phase split of the inpaint stage, so one Mac run
        // shows where the stage time goes (prep / model load / GPU run /
        // paste / round-trip call / stage total). loadMs/readyMs ride on
        // r from the ML handler; the rest is timed here.
        let inpaintPath = 'wasm';
        let prepMs = 0, callMs = 0, pasteMs = 0, splitLoadMs = 0, splitReadyMs = null, splitTileMax = 0, splitHostMs = null, splitDocMs = null;
        // 2.0.27: the merge uses the LEARNED spread for this path
        // (gpu on Chrome, wasm1 on Firefox), starting at 1.3 and
        // adjusting from real runs (see readInpaintSpread above).
        const spreadMap = await readInpaintSpread();
        const mergeKey = directHandlers() ? 'wasm1' : 'gpu';
        const mergeSpread = spreadMap[mergeKey] || INPAINT_COST_SPREAD;
        const { boxes: patchBoxes, predictedMs, counts: patchCounts } = mergeBoxesByCost(entries, {
          // 2.0.14: cost-based merge (see textblock.js) — merge only when
          // the merged patch is predicted cheaper than the two apart.
          // Expected path: Chrome tries GPU first (tileMax 1024); Firefox
          // is WASM 1-thread (tileMax 512). A Chrome GPU failure falls back
          // to WASM on these same patches, as before.
          tileMax: directHandlers() ? TILE_MAX : 1024,
          ...(directHandlers() ? INPAINT_COST.wasm1 : INPAINT_COST.gpu),
          spread: mergeSpread,
        });
        const patches = [];
        for (const [i, pb] of patchBoxes.entries()) {
          checkCancelled(runId);
          const [x1, y1, x2, y2] = pb.map(Math.round);
          const pxKey = `inpaint:${runId}:${i}`;
          const maskKey = `inpaint-mask:${runId}:${i}`;
          imgPxKeys.push(pxKey, maskKey);
          await pixelPut(pxKey, cropRGBA(rgba, w, x1, y1, x2, y2).data.buffer);
          // Keep the mask bytes in memory too: the offscreen handler only
          // peeks the pixel-store copy (inputs are dropped by the pipeline
          // finally, not on read), but we need the mask again at compositing
          // time for mask-aware paste. pixelPut copies, so this view stays
          // valid.
          const maskData = cropMask1(fullMask, w, x1, y1, x2, y2);
          await pixelPut(maskKey, maskData.buffer);
          patches.push({ id: i, x: x1, y: y1, key: pxKey, maskKey, maskData, width: x2 - x1, height: y2 - y1 });
        }
        prepMs = Math.round(performance.now() - t0i);
        const inpainted = new Uint8ClampedArray(rgba);
        let inpaintMs = 0;
        if (patches.length) {
          const wirePatches = patches.map(({ id, key, maskKey, width, height }) => ({ id, key, maskKey, width, height }));
          let r;
          // GPU1 (Firefox only): LaMa on WebGPU in a dedicated worker,
          // tried first when the browser exposes WebGPU. Any GPU failure
          // except user cancel (error, buffer error, OOM, or a hang
          // caught by the 60s inactivity watchdog in ml-bridge.js)
          // downgrades to WASM and retries once via the preloaded shared
          // worker, then sticks to WASM for the rest of this run. The
          // full error text is logged (no cut) so the panel log shows
          // exactly how GPU died. Cancelled runs never fall back:
          // checkCancelled throws before the downgrade. Chrome takes
          // the GPU1-Chrome branch below (offscreen-document GPU worker).
          // If WebGPU is not exposed, one line explains why GPU was
          // skipped, so a missing navigator.gpu is visible, not silent.
          const callT0 = performance.now();
          if (directHandlers() && !gpuDowngradedThisRun && !(typeof navigator !== 'undefined' && navigator.gpu)) {
          }
          if (directHandlers() && !gpuDowngradedThisRun && gpuInpaintAllowed() && typeof navigator !== 'undefined' && navigator.gpu) {
            try {
              r = await runGpuInpaint({
                runId, patches: wirePatches,
                onProgress: (frac) => parProgress('inpaint', frac),
                diag: diagPush,
                isCancelled: () => runs.get(runId)?.cancelled === true,
              });
              inpaintPath = 'gpu';
            } catch (e) {
              checkCancelled(runId);
              gpuDowngradedThisRun = true;
              inpaintPath = 'gpu-failed-wasm';
              diagPush('  Inpaint fell back to WASM (GPU failed: ' + String((e && e.message) || e).slice(0, 80) + ').');
              markGpuInpaintDead().catch(() => {});
              r = await callMlChecked(runId, { type: MSG.ML_INPAINT, runId, patches: wirePatches });
            }
          } else if (!directHandlers() && !gpuDowngradedThisRun && gpuInpaintAllowed()) {
          // GPU1-Chrome: LaMa on WebGPU in a dedicated worker spawned by
          // the offscreen document (the SW cannot spawn workers). Tried
          // first on Chrome; the document decides GPU availability in its
          // own realm (its navigator.gpu, not the SW's). Any GPU failure
          // except user cancel (error or a hang caught by the 60s
          // inactivity watchdog in ml-bridge.js) downgrades to WASM and
          // retries once via the offscreen document, then sticks to WASM
          // for the rest of this run. GPU_SKIPPED (no navigator.gpu in
          // the doc realm, worker creation/ready failure) logs "skipped"
          // and falls back to the single WASM path. Full error text is
          // logged (no cut). Cancelled runs never fall back:
          // checkCancelled throws before the downgrade.
            try {
              r = await runChromeGpuInpaint({
                runId, patches: wirePatches,
                onProgress: (frac) => parProgress('inpaint', frac),
                diag: diagPush,
                isCancelled: () => runs.get(runId)?.cancelled === true,
              });
              inpaintPath = 'gpu';
            } catch (e) {
              checkCancelled(runId);
              if (e && e.gpuSkipped) {
                inpaintPath = 'gpu-skipped-wasm';
                diagPush('  Inpaint skipped GPU (' + String((e && e.message) || e).slice(0, 80) + '), using WASM.');
                r = await callMlChecked(runId, { type: MSG.ML_INPAINT, runId, patches: wirePatches });
              } else {
                gpuDowngradedThisRun = true;
                inpaintPath = 'gpu-failed-wasm';
                diagPush('  Inpaint fell back to WASM (GPU failed: ' + String((e && e.message) || e).slice(0, 80) + ').');
                markGpuInpaintDead().catch(() => {});
                r = await callMlChecked(runId, { type: MSG.ML_INPAINT, runId, patches: wirePatches });
              }
            }
          } else {
            // Single WASM inpaint (2.1.27): the Firefox 2-worker pool
            // (POOL1) was removed — it never beat single (83.5s pool vs
            // 80.5s single on the standard page, 2026-11-04), and on this
            // Mac it never ran anyway (Firefox has GPU, GPU fails, then
            // single WASM). One big patch sets the floor no split can beat.
            r = await callMlChecked(runId, {
              type: MSG.ML_INPAINT, runId,
              patches: wirePatches,
            });
          }
          inpaintMs = r.ms;
          callMs = Math.round(performance.now() - callT0);
          splitLoadMs = (r && r.loadMs) || 0;
          splitReadyMs = (r && r.readyMs != null) ? r.readyMs : null;
          splitTileMax = (r && r.tileMax) || 0;
          // BUGFIX (2.1.11): r is block-scoped (declared inside the
          // patches block above) but the timing line below sits outside it
          // — reading r there threw 'r is not defined' and killed the run
          // after inpaint finished. Hoist the two timing values like
          // splitLoadMs above, so the line below reads them, not r.
          splitHostMs = (r && r.hostMs != null) ? r.hostMs : null;
          splitDocMs = (r && r.docMs != null) ? r.docMs : null;
          // MEASURE1: tile shape of this page, from the handler's count.
          const pasteT0 = performance.now();
          for (const res of r.results) {
            const p = patches[res.id];
            imgPxKeys.push(res.key);
            const buf = await pixelTake(res.key);
            // Use the in-memory mask copy (p.maskData): the pixel-store copy
            // is only peeked by the handler and dropped by the pipeline
            // finally, so it may still be there — but maskData is the copy
            // this stage owns.
            pasteMaskedRGBA(inpainted, w,
              { data: new Uint8ClampedArray(buf), w: p.width, h: p.height },
              { data: p.maskData, w: p.width, h: p.height },
              p.x, p.y);
          }
          pasteMs = Math.round(performance.now() - pasteT0);
          // DIAG (2.0.8): one line per patch — size, tile count, fast-path
          // hit, and ms — so the fix follows the real shape, not a guess.
          if (r && Array.isArray(r.patchStats)) {
          }
          // 2.0.27: LEARN the spread from this run's merged patches.
          // For a merged patch, the base model (no spread) predicts
          // patchCostMs; the per-pixel part of (actual / predicted) is
          // the measured spread for that patch. Fast-path patches never
          // ran the model, so they carry no signal and are skipped.
          // Only merged patches count — a single-box patch never used
          // the spread. The median ratio of the run moves the stored
          // spread 10% toward it (damped, clamped), so one noisy run
          // cannot overfit it. The key is the path that actually ran
          // (gpu, or wasm on Chrome fallback, or wasm1 on Firefox).
          try {
            const actualKey = inpaintPath === 'gpu' ? 'gpu' : (directHandlers() ? 'wasm1' : 'wasm');
            const actualCost = INPAINT_COST[actualKey] || INPAINT_COST.gpu;
            const actualTileMax = splitTileMax || (actualKey === 'gpu' ? 1024 : TILE_MAX);
            const ratios = [];
            if (r && Array.isArray(r.patchStats) && Array.isArray(patchCounts)) {
              for (const ps of r.patchStats) {
                if (ps.fast) continue;
                if (!patchCounts[ps.id] || patchCounts[ps.id] < 2) continue;
                const w = Number(ps.w), h = Number(ps.h), tiles = Number(ps.tiles), ms = Number(ps.ms);
                if (!w || !h || !tiles || !ms) continue;
                const base = patchCostMs(w, h, actualTileMax, actualCost.fixedMs, actualCost.perPxMs);
                const fixedPart = tiles * actualCost.fixedMs;
                const perPxPart = base - fixedPart;
                const actualPerPx = ms - fixedPart;
                // Only use patches where the per-pixel part beats the fixed
                // overhead — otherwise the ratio is noise in the fixed cost.
                if (perPxPart <= fixedPart || actualPerPx <= 0) continue;
                const ratio = actualPerPx / perPxPart;
                if (Number.isFinite(ratio)) ratios.push(Math.min(3, Math.max(0.5, ratio)));
              }
            }
            if (ratios.length) {
              ratios.sort((a, b) => a - b);
              const median = ratios[Math.floor(ratios.length / 2)];
              const cur = (await readInpaintSpread())[actualKey] || INPAINT_COST_SPREAD;
              const next = Math.min(INPAINT_SPREAD_MAX, Math.max(INPAINT_SPREAD_MIN, cur * (1 - INPAINT_SPREAD_LEARN) + median * INPAINT_SPREAD_LEARN));
              if (Math.abs(next - cur) >= 0.005) {
                const map = await readInpaintSpread();
                map[actualKey] = Math.round(next * 100) / 100;
                await saveInpaintSpread(map);
              }
            }
          } catch {}
        }
        const totalInpaintMs = Math.round(performance.now() - t0i);
        // DIAG (2.1.9): split the call-vs-GPU gap. host = the SW's host
        // check (ping) before the send; doc = the offscreen handler from
        // entry to reply (includes the worker call); worker = the GPU
        // worker's patch loop; load = model load. transit = call - host -
        // doc = the SW<->doc message hops both ways. Doc overhead (handler
        // work outside the worker) is doc - load - worker. GPU path only.
        if (patches.length && inpaintPath === 'gpu' && splitHostMs != null) {
          const transitMs = callMs - (splitHostMs || 0) - (splitDocMs || 0);
        }
        parProgress('inpaint', 1);
        await imgEmitDebug('inpaint', {
          title: `Inpaint — ${patches.length} patches`,
          image: settings.debugMode ? await rgbaToDataURL(inpainted, w, h) : null, ms: inpaintMs,
        });
        return { inpainted, inpaintMs, maskMs, totalInpaintMs };
      };

      // Firefox runs ML in-process on a single thread: WASM inpaint blocks the
      // event loop, freezing the parallel translate branch and the UI. Run the
      // stages sequentially there; Chrome keeps the parallel pipeline (ML is in
      // the offscreen document on its own thread).
      let translateOut, inpaintOut;
      if (directHandlers()) {
        // Firefox: translation runs on a Web Worker (own thread) and ML runs
        // on the ML worker — the main thread only orchestrates, so it stays
        // free to monitor and restart both. (Mask is synchronous JS on the
        // main thread, but it is bounded and fast, not WASM.)
        // imgTimings.translate is the worker round-trip ONLY: t0t is set at
        // postMessage and translateEnd at the final reply, so mask/inpaint
        // (which run while the worker works) are NOT counted in it.
        let t0t = 0, translateEnd = 0;
        const workerUrl = chrome.runtime.getURL('src/background/translate-worker.js');
        const tWorker = new Worker(workerUrl, { type: 'module' });
        // Track for cancellation: cancelRunsForTab terminates this immediately
        // instead of waiting for the 60s backstop or natural completion.
        runs.get(runId).translateWorker = tWorker;
        // Hoisted so the catch block below can cancel the 60s timer on early
        // mask/inpaint failure — otherwise it fires pointlessly after terminate.
        let translateTimeout = null;
        let translateReject = null;
        const killTranslateWorker = (err) => {
          if (translateTimeout) { clearTimeout(translateTimeout); translateTimeout = null; }
          try { tWorker.terminate(); } catch { /* already terminated */ }
          // If killed externally (cancel), the promise would otherwise hang
          // forever — no onmessage/onerror fires on a terminated worker.
          if (err && translateReject) { const rej = translateReject; translateReject = null; rej(err); }
        };
        // cancelRunsForTab uses this to abort the in-flight worker immediately.
        runs.get(runId).killTranslateWorker = killTranslateWorker;
        const translateP = new Promise((resolve, reject) => {
          translateReject = reject;
          // 60s backstop only: the worker's own 30s abort triggers failover
          // inside translateBlocks, and stall (30s) + rescue (20s) needs up
          // to ~50s — a 30s kill here would murder the rescue.
          translateTimeout = setTimeout(() => {
            translateTimeout = null;
            tWorker.terminate();
            reject(new Error('translate worker timeout'));
          }, 60000);
          tWorker.onmessage = (e) => {
            // Failover notices arrive before the final ok/error — show a pill
            // but don't settle the promise.
            if (e.data && e.data.type === 'failover-notice') {
              logFailoverLine(e.data);
              chrome.tabs.sendMessage(tabId, {
                type: MSG.PILL_NOTICE,
                text: `Engine ${e.data.failoverFrom} failed — retrying with ${e.data.failoverTo}`,
                sticky: false,
              }).catch(() => {});
              return;
            }
            killTranslateWorker();
            translateEnd = performance.now();
            if (e.data.ok) resolve({ translated: e.data.translated, backendUsed: e.data.backendUsed });
            else reject(new Error(e.data.error));
          };
          tWorker.onerror = (err) => {
            killTranslateWorker();
            translateEnd = performance.now();
            reject(err instanceof Error ? err : new Error(String(err)));
          };
          t0t = performance.now();
          tWorker.postMessage({
            blocks: blocks.map(b => ({ text: b.text })),
            settings: effSettings,
          });
        });
        // Main thread: mask → inpaint (linear, WASM may block but worker continues)
        // If mask/inpaint throws first, translateP would reject with no handler
        // (unhandled rejection) and the worker would linger until its timeout —
        // attach a handler and stop the worker on the way out.
        translateP.catch(() => {});
        let maskRes, translated;
        try {
          maskRes = await runMask();
          inpaintOut = await runInpaint(maskRes);
          // Collect translation from worker
          translated = await translateP;
        } catch (e) {
          // Pass the error so translateReject fires — otherwise translateP
          // pends forever, leaking the closure chain per failed Firefox run.
          killTranslateWorker(e instanceof Error ? e : new Error(String(e)));
          throw e;
        }
        try { tWorker.terminate(); } catch { /* already terminated by onmessage */ }
        checkCancelled(runId);
        blocks.forEach((b, i) => {
          b.translation = translated.translated[i];
          b.backendUsed = translated.backendUsed;
        });
        translated = translated.translated;
        const translateMs = Math.round(translateEnd - t0t);
        parProgress('translate', 1);
        await imgEmitDebug('translate', {
          // Same as the main path: the actual backend, not the configured one.
          title: `Translation — ${BACKEND_LABEL[blocks[0]?.backendUsed || settings.translationBackend] || settings.translationBackend}`,
          rows: blocks.map(b => ({ text: b.text, translation: b.translation, backend: b.backendUsed || settings.translationBackend })),
          ms: translateMs,
        });
        translateOut = { translateMs };
      } else {
        const maskP = runMask();
        const inpaintP = maskP.then(runInpaint);
        const translateP = runTranslate();
        // If either branch fails, stop the other branch of THIS image so
        // it does not burn CPU/network on a dead image. Record the first
        // REAL branch failure: without it, the run catch below sees the
        // abort flag and reports quiet 'cancelled', swallowing the actual
        // error (inpaint/timeout failures showed no notification at all).
        // Not recorded for user cancels (their errors must stay quiet) or
        // for cancel-marked errors (those are the abort itself, not a
        // failure).
        // 2.2.12: do NOT set the run-level `cancelled` flag here. That
        // made one image's branch failure abort the whole multi-pic run
        // (the per-image loop treats `isCancelled` as fatal), defeating
        // per-image fault isolation. The other branch is stopped by its
        // own timeout (translate 30s, inpaint ML timeout) and its result
        // is discarded; the run continues to the next image.
        const cancelOnFail = p => p.catch(e => {
          const r = runs.get(runId);
          if (r) {
            if (!r.userCancelled && !e.cancelled && !r.branchError) r.branchError = e;
          }
          throw e;
        });
        [translateOut, inpaintOut] = await Promise.all([cancelOnFail(translateP), cancelOnFail(inpaintP)]);
      }
      imgTimings.translate = translateOut.translateMs;
      // One translate line per picture: which engine actually translated
      // (after failover it differs from the configured one) and how long.
      diagPush(`  Translated by ${BACKEND_SHORT_LABEL[blocks[0]?.backendUsed || settings.translationBackend] || settings.translationBackend} in ${translateOut.translateMs} ms.`);
      imgTimings.mask = inpaintOut.maskMs;
      imgTimings.inpaint = inpaintOut.totalInpaintMs;
      const { inpainted } = inpaintOut;

      // ---- 8. render: translated text composited onto the image.
      // mode 'replace' swaps the page's original <img>; 'overlay' shows it in the overlay.
      // NOTE: the finished picture travels as a WebP data URL — raw pixel buffers
      // don't survive chrome.tabs messaging from the service worker either.
      checkCancelled(runId);
      imgSetProgress('render', 0.96);
      const finalDataUrl = await rgbaToDataURL(inpainted, w, h, Math.max(w, h));
      // Same tick as the send below: a cancellation can never slip in between
      // and let a stale render reach the tab.
      checkCancelled(runId);
      imgTimings.total = Math.round(performance.now() - imgT0);
      const renderRes = await sendRender(tabId, runId, mode, finalDataUrl, w, h, blocks, imgTimings, settings.debugMode, { srcUrl: manualSrc || img.src, uid: img.uid });
      // The content script measures the render (canvas compose + text draw)
      // and returns it on the RENDER reply; the benchmark log needs it.
      imgTimings.render = (renderRes && Number.isFinite(renderRes.renderMs)) ? Math.round(renderRes.renderMs) : 0;
      // ---- 9. page cache: remember this translated page for instant revisits.
      // Best-effort — a cache failure must never fail the run. Skipped in
      // incognito; a cancelled run never reaches this point (it throws above).
      await writePageCache(rgba, w, h, finalDataUrl, blocks, effSettings, settings, tabId, mode);
      // Fresh path done: report this image's backend for the final pill.
      return { ok: true, doneExtra: { backendLabel: BACKEND_SHORT_LABEL[blocks?.[0]?.backendUsed || settings.translationBackend] || settings.translationBackend } };
    }
    for (const [imgIdx, img] of images.entries()) {
      // Pipelined: `images` grows as later pictures load (refill appends
      // at the end of each picture — array iterators see appended items),
      // so the label and total are read fresh for each picture.
      const imgLabel = multi ? ` — image ${imgIdx + 1}/${images.length} (${img.w}×${img.h})` : '';
      const imgBase = imgIdx / images.length, imgSpan = 1 / images.length;
      // Progress high-water mark (pipelined): the total grows as new
      // pictures are found, so a naive done/total fraction would go
      // backwards mid-image. Clamp to the highest progress shown so far.
      // On the manual path fractions are already monotonic, so the clamp
      // is a no-op there.
      const imgSetProgress = (stage, frac, extra) => {
        const raw = imgBase + frac * imgSpan;
        if (!pipe) { setProgress(runId, stage, raw, extra || {}); return; }
        const v = Math.max(pipe.lastProgress, Math.min(1, raw));
        pipe.lastProgress = v;
        setProgress(runId, stage, v, extra || {});
      };
      const imgEmitDebug = (stage, payload) => emitDebug(runId, tabId, settings, stage, { ...payload, title: (payload.title || stage) + imgLabel });
      const imgTimings = {};
      const imgPxKeys = [];
      const imgT0 = performance.now();
      try {
        // Pipelined auto only: a picture that arrived after the initial
        // gate was never checked upfront — the run cannot know later
        // hosts upfront (the old code threw for the whole run because it
        // knew all hosts before starting). Check this picture's host now;
        // a missing grant fails just this picture (per-image fault
        // isolation — the catch below records it and the next picture
        // runs) instead of failing the whole run.
        if (pipe && imgIdx >= pipe.gatedCount) {
          const lateMissing = await checkImageHostPermissions([img]);
          if (lateMissing.length) {
            for (const h of lateMissing) await recordMissingHost('https://' + h + '/');
            diagPush('Host permission missing for ' + lateMissing.join(', ') + ' — open the popup and tap Grant access.');
            if (!pipe.pillSent) {
              pipe.pillSent = true;
              try {
                await withTimeout(chrome.tabs.sendMessage(tabId, {
                  type: MSG.PILL_NOTICE,
                  text: `Pictures on ${displayHost(lateMissing[0])} need permission — open the popup and tap Grant access, then run translate again.`,
                  sticky: true,
                }), MSG_TIMEOUT_MS, 'pill notice');
              } catch { /* pill is best-effort */ }
            }
            throw new Error(`Pictures on ${displayHost(lateMissing[0])} need permission — open the extension popup and tap "Grant access", then run translate again.`);
          }
        }
        const r = await runOneImage(img, imgSetProgress, imgEmitDebug, imgTimings, imgPxKeys, imgT0, undefined, imgIdx + 1);
        // No text in this picture: nothing was translated, nothing was
        // cached, so it counts as neither translated nor quota. It is
        // not a failure either — it just has no text.
        if (!r || !r.noText) {
          doneImgs.push(imgIdx + 1);
          if (img.src) { doneSrcs.push(img.src); doneCountEntries.push({ key: img.src, w: img.w, h: img.h }); }
        }
        if (r && r.doneExtra) lastDoneExtra = r.doneExtra;
        // Benchmark log: one entry per finished full run (imgTimings.total
        // is only set on the full path — cache hits and no-text pictures
        // never reach it, so they are not recorded). Fire-and-forget:
        // logging must never slow or fail a run.
        if (r && r.ok && !r.noText && Number.isFinite(imgTimings.total)) {
          recordBenchRun({
            t: new Date().toISOString(),
            v: chrome.runtime.getManifest().version,
            br: (typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox')) ? 'Firefox' : 'Chrome',
            host: hostOf(img.src) || '',
            img: img.w + 'x' + img.h,
            blk: imgTimings.blockCount || 0,
            ocr: imgTimings.ocrEngine || '',
            be: settings.translationBackend || '',
            tier: imgTimings.tier || '',
            cap: imgTimings.capture || 0, det: imgTimings.detect || 0,
            blkMs: imgTimings.blocks || 0, ocrMs: imgTimings.ocr || 0,
            tr: imgTimings.translate || 0, mask: imgTimings.mask || 0,
            inp: imgTimings.inpaint || 0, ren: imgTimings.render || 0,
            total: imgTimings.total,
          }).catch(() => {});
        }
      } catch (e) {
        // Only a USER cancel aborts the whole run. A per-image failure —
        // even one that throws 'cancelled' (e.g. a translate timeout-abort)
        // — is recorded and the next picture runs. The old check
        // (`e.cancelled || isCancelled`) rethrew on any branch failure,
        // so one bad picture killed a 50-image run (2.2.12).
        if (e && runs.get(runId)?.userCancelled) throw e;
        if (/Out of memory/i.test(String((e && e.message) || ''))) throw e;
        // 403 auto fallback (auto path only — manual send has its own
        // fallback in the handler, so it must not double-attempt): the
        // image server refused the download, but a background tab reads it
        // same-origin. Try it once for this image; the original 403 error
        // is recorded only if the tab read fails too.
        let recovered = false;
        if (e && e.fallbackUrl && !manualSrc) {
          try {
            const pre = await fallbackCaptureViaTab(tabId, e.fallbackUrl);
            const r2 = await runOneImage(img, imgSetProgress, imgEmitDebug, imgTimings, imgPxKeys, imgT0, pre, imgIdx + 1);
            // No text: same as above — not translated, not counted.
            if (!r2 || !r2.noText) {
              doneImgs.push(imgIdx + 1);
              if (img.src) { doneSrcs.push(img.src); doneCountEntries.push({ key: img.src, w: img.w, h: img.h }); }
            }
            if (r2 && r2.doneExtra) lastDoneExtra = r2.doneExtra;
            recovered = true;
          } catch (e2) {
            // Log the tab failure reason to the diag log (not just the
            // console): the original error alone hides WHY the tab read
            // failed (timeout, redirect, server refused the tab too).
            diagPush(`Picture ${imgIdx + 1}: background tab read failed — ${String((e2 && e2.message) || e2).slice(0, 160)}`);
            console.warn('[ct] auto fallback capture failed for image ' + (imgIdx + 1) + ':', String((e2 && e2.message) || e2).slice(0, 120));
          }
        }
        if (!recovered) {
          if (e && e.fallbackUrl && !fallbackUrl) fallbackUrl = e.fallbackUrl;
          failedImgs.push(`image ${imgIdx + 1} (${img.w}×${img.h}): ${String((e && e.message) || e).slice(0, 120)}`);
          missedDetail.push({ idx: imgIdx + 1, w: img.w || 0, h: img.h || 0, src: img.src || '', reason: String((e && e.message) || e).slice(0, 120) });
        }
      } finally {
        for (const k of imgPxKeys.splice(0)) await pixelDrop(k);
      }
      // Pipelined work queue: pull newly loaded pictures into `images`
      // (the iterator above picks appended items up in order). A quick
      // poll while pictures are still queued; a wait (poll every ~500ms
      // until new pictures arrive or force-load settles) when this was
      // the last known picture.
      if (pipe) {
        await refillPipelineQueue(imgIdx >= images.length - 1);
        if (images.length > 1) multi = true;
      }
    }
    if (pipe) {
      // Cumulative accounting for the pipelined run: the per-poll skip
      // strings were deferred (counts grow as pictures load), so build
      // them now from the accumulated skippedDetail and count them as
      // not-translated in the summary, as the old code did up front.
      // alreadyDone/ignored likewise take their final cumulative values
      // (later batches may have added already-translated pictures).
      const belowMin = pipe.skippedDetail.filter(d => String(d.reason || '').startsWith('below min size')).length;
      const overCap = pipe.skippedDetail.filter(d => String(d.reason || '').startsWith('over ')).length;
      const minSize = settings.minImageSize || 460;
      const cumSkipped = [];
      if (belowMin) cumSkipped.push(`${belowMin} below the minimum image size of ${minSize}px (change it in Settings)`);
      if (overCap) cumSkipped.push(`${overCap} over the ${MAX_IMAGES_PER_PAGE}-image per-run cap`);
      if (cumSkipped.length) {
        failedImgs.push(...cumSkipped);
      }
      alreadyDone = pipe.alreadyDone;
      ignored = pipe.ignored;
    }
    if (!doneImgs.length) {
      const err = new Error('no picture could be translated (' + failedImgs.join('; ').slice(0, 400) + ')');
      if (fallbackUrl) err.fallbackUrl = fallbackUrl;
      throw err;
    }
    timings.total = Math.round(performance.now() - pipelineT0);
    setProgress(runId, 'done', 1, lastDoneExtra || { backendLabel: settings.translationBackend });
    // Complete missed accounting, written LAST so it can never be pushed
    // out of the log buffer: every picture not translated, with size, host
    // and reason. The skipped (below-min / over-cap) pictures never reach
    // the per-image loop, so they only exist in skippedDetail; the capture
    // failures are in missedDetail. Together they name all of them — a run
    // that misses 6 of 30 lists all 6, not just the ones that failed
    // capture.
    // Run footer (human-readable log, James): one line with the outcome,
    // then one line per missed picture. Written last so it survives.
    try {
      const missed = [...(skippedDetail || []), ...missedDetail];
      // Done counts the pictures translated in this run plus the ones that
      // were already translated (header total, so the two lines agree).
      const doneCount = doneImgs.length + runAlreadyDone;
      diagPush(`Run done. ${doneCount} of ${runTotal} picture${runTotal === 1 ? '' : 's'} done${missed.length ? ', ' + missed.length + ' missed' : ''}.`);
      for (const m of missed) diagPush(`  Missed ${m.idx ? '#' + m.idx + ' ' : ''}${m.w}x${m.h} ${hostOf(m.src) || '?'} — ${m.reason}`);
    } catch { /* accounting is best-effort — the run already succeeded */ }
    // Surface the outcome on the PAGE too: runs take minutes and the popup is
    // usually closed by the time the last picture finishes, so without this a
    // partial run (skips, per-image failures, ignored tiny images) is silent.
    try {
      await withTimeout(chrome.tabs.sendMessage(tabId, {
        type: 'ct/run-summary', runId, images: doneImgs.length,
        failed: failedImgs, ignored,
        ...(opts.resume ? { resumed: true, alreadyDone } : {}),
      }), MSG_TIMEOUT_MS, 'run summary');
    } catch { /* content script may have been removed mid-run */ }
    // Pre-translate the next page (best-effort, fire-and-forget — the job
    // handles its own errors and never touches this run's result).
    try { pretranslateNextPage(tabId, tabUrl, settings); } catch {}
    if (settings.debugMode) await sendDiagLog(tabId, runId);
    result = { runId, ok: true, images: doneImgs.length, imageSrcs: doneSrcs, failed: failedImgs, ...(opts.resume ? { resumed: true, alreadyDone } : {}) };
    // Freemium: a finished translation counts toward the free daily quota
    // when any Pro feature is on (auto-translate or pre-translate).
    // It is free only when both are off. Pro users are not counted.
    // A run cancelled in the middle throws above, so it counts nothing.
    // This covers auto and manual runs alike — the auto handler no longer
    // counts separately.
    if (!proIsActive(settings) && anyProFeatureOn(settings)) await addProUsageForImages(doneCountEntries);
  } catch (e) {
    let msg;
    // A user-cancelled run stays 'cancelled' even if the in-flight work
    // later fails (e.g. ML times out after Cancel) — the user asked to
    // stop, so a later error must not surface as a failure. But a BRANCH
    // failure (recorded by cancelOnFail) is not a user cancel: the abort
    // flag it sets must not swallow it. Prefer the recorded failure so
    // inpaint/timeout/translate errors always notify.
    const branchError = runs.get(runId)?.branchError;
    let quietCancel = (runs.get(runId)?.userCancelled || ((e && e.cancelled) || isCancelled(runId))) && !branchError;
    if (quietCancel) {
      setProgress(runId, 'cancelled', 0);
      msg = 'cancelled';
    } else {
      const err = branchError || e;
      msg = String((err && err.message) || err);
      // A render that lost to a newer run ('stale run') is not a failure:
      // the user moved to another page and the new run owns the tab now.
      // Treat it as a quiet cancel — no error pill, and the auto dedupe
      // stays (the new run already recorded it). Otherwise a fast
      // page-flip leaves 'Render failed' on every page and the dedupe
      // clears, so the next flip re-runs and fails the same way.
      if (msg.includes('stale run')) {
        quietCancel = true;
        setProgress(runId, 'cancelled', 0);
        msg = 'cancelled';
      } else {
        broadcastError(runId, msg, err && err.grantHost ? { host: err.grantHost, label: displayHost(err.grantHost), hosts: err.grantHosts || null } : null);
        try {
          await withTimeout(chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES }), MSG_TIMEOUT_MS, 'content script injection');
          // Show the debug panel on failure too (emitDebug sets debug:true and
          // respects debugMode) — otherwise a capture-stage failure leaves
          // James with only the error text and no stage/tier diagnostics.
          if (settings) await emitDebug(runId, tabId, settings, 'error', { title: 'Error', error: msg });
        } catch { /* ignore */ }
      }
    }
    // DIAGNOSTIC (temporary): one self-contained summary line, so ANY
    // paste containing it shows the true totals and the outcome.
    // Run footer for a failed/cancelled run: outcome + how many pictures
    // finished. No run id, no progress-send counts — noise. runTotal and
    // doneImgs live in function scope (see above) so this catch can read
    // them; a try-scoped let/const is invisible here.
    {
      const doneCount = doneImgs.length + runAlreadyDone;
      if (msg === 'cancelled') {
        diagPush(`Run cancelled. ${doneCount} of ${runTotal} picture${runTotal === 1 ? '' : 's'} done.`);
      } else {
        diagPush(`Run failed: ${String(msg).slice(0, 120)}. ${doneCount} of ${runTotal} picture${runTotal === 1 ? '' : 's'} done.`);
      }
    }
    // DIAGNOSTIC (temporary): send AFTER the summary is pushed, so the
    // panel log includes it. Error runs only (not user cancels), and only
    // when debug mode is on — otherwise the panel pops up even though the
    // user turned it off.
    if (!quietCancel && settings && settings.debugMode) await sendDiagLog(tabId, runId);
    result = { runId, ok: false, error: msg, cancelled: !!quietCancel,
      ...(e && e.fallbackUrl ? { fallbackUrl: e.fallbackUrl } : {}) };
  } finally {
    runs.delete(runId);
    clearRunRecord(runId); // FIX1: run ended, drop its persisted record.
    // Drop any pixel payloads this run staged but never got taken.
    for (const k of pxKeys) await pixelDrop(k);
    keepAliveStop(runId); // FIX2: release the run-scoped hold last, after all cleanup.
  }
  // Chrome 2.0.13: after a successful run, measure the best WASM thread
  // count once, in the background (ML_BENCH_THREADS). The run does not
  // wait for the bench itself, but the trigger is confirmed: 2.1.15 made
  // it await the reply and retry (up to 3 tries, 3s each) instead of
  // fire-and-forget, because a send to a dead doc was lost silently.
  // 2.1.59: the bench is Chrome-only (it runs in the offscreen doc).
  // Firefox WASM runs 1 thread, so there is nothing to measure, and
  // there is no offscreen doc to receive the trigger — it failed 3
  // times + 2 min of keepalive pings after every Firefox run. Skip it
  // on Firefox (directHandlers() is set there); the else below only
  // logs a run that actually failed.
  // 2.0.25: gate the trigger here too. The offscreen doc also skips when
  // it sees a complete save, but in 2.0.24 the bench re-measured after
  // every run, so check in the service worker as well — if a complete
  // full-chain result is already saved for this machine, do not send the
  // trigger at all. Fail open: any error or missing value still sends it.
  if (result && result.ok && !directHandlers()) {
    try {
      // 2.1.25: log only lines that tell something. The old code logged
      // "run ok, checking saved count" + "already measured N, skipping"
      // after EVERY run — in the steady state (bench done) that is dozens
      // of identical lines and tells nothing. Now: silence when the bench
      // is already measured (the persisted trace already shows "bench done
      // best N"); log only when the bench will actually run, or on error.
      let alreadyMeasured = false;
      try {
        const saved = await chrome.storage.local.get('measuredThreads');
        const m = saved && saved.measuredThreads;
        const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
        if (m && m.method === 'full-chain' && m.hardwareConcurrency === cores && Number.isInteger(m.threads)) {
          alreadyMeasured = true;
        } else {
          benchTracePush('threads bench trigger: no complete save (method=' + (m && m.method) + ' threads=' + (m && m.threads) + '), will send');
        }
      } catch (e) {
        benchTracePush('threads bench trigger: storage read failed: ' + String((e && e.message) || e) + ' — will send anyway');
      }
      if (!alreadyMeasured) {
        // The doc can be discarded once the run ends; a trigger sent to
        // a dead doc is lost (sendMessage rejects: no listener) and the
        // bench never runs — single OCR then keeps the raw core count.
        // The 2.1.14 run proved this: bench status stayed 'none', so the
        // bench never started at all. Confirm delivery: await the reply
        // (the doc's handler replies at once) and retry after re-ensuring
        // the host if it fails. Up to 3 tries, 3s each. The outcome is
        // logged (it contains 'threads bench', so it survives into the
        // next run's panel log) AND saved to storage (2.1.16): the log
        // line is lost if the service worker restarts before the next
        // run, but storage survives, so the persisted trace can
        // show whether the trigger was delivered.
        let delivered = false;
        let attempts = 0;
        let lastError = '';
        for (let attempt = 0; attempt < 3 && !delivered; attempt++) {
          attempts = attempt + 1;
          try {
            await ensureMlHost();
            benchTracePush('threads bench trigger attempt ' + attempts + ': host alive');
          } catch (e) {
            lastError = 'ensureMlHost: ' + String((e && e.message) || e);
            benchTracePush('threads bench trigger attempt ' + attempts + ': ensureMlHost failed: ' + lastError);
          }
          try {
            // 3s: the doc's handler replies at once, so any wait past 3s
            // means the doc is dead or gone — the timeout is a liveness
            // check, not a latency budget. No event confirms delivery;
            // the sendMessage reply is the only signal.
            const reply = await Promise.race([
              chrome.runtime.sendMessage({ type: MSG.ML_BENCH_THREADS }),
              new Promise((_, rej) => setTimeout(() => rej(new Error('bench trigger timeout')), 3000)),
            ]);
            delivered = true;
            benchTracePush('threads bench trigger attempt ' + attempts + ': delivered, reply=' + JSON.stringify(reply || null));
          } catch (e) {
            lastError = String((e && e.message) || e);
            benchTracePush('threads bench trigger attempt ' + attempts + ': send failed: ' + lastError);
          }
        }
        benchTracePush('threads bench trigger ' + (delivered ? 'delivered' : 'FAILED after 3 tries') + (delivered ? '' : ' last error: ' + lastError));
        try { await chrome.storage.local.set({ benchTrigger: { delivered, attempts, at: new Date().toISOString(), lastError } }); } catch {}
      }
    } catch (e) {
      try { benchTracePush('threads bench trigger: outer error: ' + String((e && e.message) || e)); } catch {}
    }
    // 2.1.21 (approach C): keep the doc alive while the bench runs. The
    // doc may be discarded once the run ends, killing a bench in flight.
    // The SW pings the doc every 15s for 2 minutes after a run; the doc
    // logs each ping and does NOT cancel the bench for it. If the bench
    // saves 'done', the pings stop early. Each ping logs its outcome, so
    // one run shows whether the pings reached the doc. Fire-and-forget:
    // the run does not wait for the pings.
    // 2.1.25: check benchStatus BEFORE starting. In the steady state
    // (bench done) the old code logged "pings starting" + "bench done,
    // stopping pings" after every run — noise. Now: silent return when
    // done, no pings, no lines.
    (async function startBenchKeepalivePings() {
      try {
        const saved = await chrome.storage.local.get('benchStatus');
        const st = saved && saved.benchStatus;
        if (st && st.state === 'done') return;
      } catch {}
      let count = 0;
      const maxPings = 8; // 8 x 15s = 2 minutes
      // QUESTIONABLE: the pings stop after 2 minutes even if the bench is
      // still running — a bench slower than 2 min loses its keepalive and
      // the doc may be discarded mid-bench. Better: keep pinging until
      // benchStatus is 'done' (the tick already checks that each round),
      // with a longer cap (e.g. 10 min) as the only stop. Left as is —
      // audit only. The 15s interval itself has no stated origin in the
      // code — presumably below the offscreen doc's idle-discard threshold;
      // TODO verify.
      benchTracePush('threads bench keepalive: pings starting (15s x 8)');
      const tick = async () => {
        try {
          const saved = await chrome.storage.local.get('benchStatus');
          const st = saved && saved.benchStatus;
          if (st && st.state === 'done') { benchTracePush('threads bench keepalive: bench done, stopping pings'); return; }
        } catch {}
        if (count >= maxPings) { benchTracePush('threads bench keepalive: 2 min up, stopping pings'); return; }
        count++;
        try {
          await ensureMlHost();
          const reply = await chrome.runtime.sendMessage({ type: MSG.ML_BENCH_KEEPALIVE });
          benchTracePush('threads bench keepalive ping ' + count + ': ok reply=' + JSON.stringify(reply || null));
        } catch (e) {
          benchTracePush('threads bench keepalive ping ' + count + ': failed: ' + String((e && e.message) || e));
        }
        setTimeout(tick, 15000);
      };
      setTimeout(tick, 15000);
    })();
  } else if (!result || !result.ok) {
    benchTracePush('threads bench trigger: run not ok (ok=' + (result && result.ok) + '), skipping');
  }
  // (Firefox + run ok: bench skipped silently — Chrome-only, steady state.)
  return result;
}

// Tall-image detection: vertical slices (ratio 3.0, overlap 0.2), merge.
async function detectSliced(rgba, w, h, threshold, runId, pxKeys) {
  const sliceH = Math.round(w * 3.0);
  const step = Math.round(sliceH * 0.8);
  const all = [];
  const seams = [];
  for (let y0 = 0; y0 < h; y0 += step) {
    checkCancelled(runId);
    const y1 = Math.min(h, y0 + sliceH);
    const c = cropRGBA(rgba, w, 0, y0, w, y1);
    const pxKey = `detect:${runId}:slice${y0}`;
    pxKeys.push(pxKey);
    await pixelPut(pxKey, c.data.buffer);
    const r = await callMlChecked(runId, {
      type: MSG.ML_DETECT, key: pxKey, width: w, height: c.h, threshold, runId,
      // SW already sliced; detector must not strip again (double seams).
      noStrip: true,
    });
    for (const b of r.boxes) {
      all.push({ ...b, xyxy: [b.xyxy[0], b.xyxy[1] + y0, b.xyxy[2], b.xyxy[3] + y0] });
    }
    if (y1 >= h) break;
    seams.push(y1);
  }
  // Dedup overlap-zone doubles and merge bubbles split across slice seams.
  return dedupAndMergeSeams(all, seams, true);
}

// ---------------------------------------------------------------- auto-translate on page load
// Fires the pipeline automatically when an allowed page finishes loading —
// no button click needed. One run per page load; only for the active tab.
const autoFired = new Map(); // tabId -> {url, at}
chrome.tabs.onRemoved.addListener(tabId => { autoFired.delete(tabId); lastTabUrl.delete(tabId); predictedNext.delete(tabId); });

// Auto-download on install (2.2.2): start fetching missing models in the
// background right after install, so the first run usually finds them
// already here. Update: only when the update changes the model list
// (new/changed file IDs or sizes — e.g. a Baberu swap), i.e. when a new
// download is actually necessary; a code-only update downloads nothing.
// The fingerprint is stored on install and on every model-changing
// update, so the next update compares against the last installed list.
// No stored fingerprint (updating from before this check existed) counts
// as changed — one download to set the baseline, then only real changes.
// A run that starts before the download finishes waits for it instead
// (see waitForModels); the Settings "Download all models" button stays
// as a manual fallback.
// Silent first-startup core detection (Chrome 2.0.2, no UI).
// Detects navigator.hardwareConcurrency once and saves it to
// storage.local as detectedCores { cores, detectedAt, source }.
// Saved only when missing or when the live number differs (machine
// changed). Never throws, never blocks install or a run, never shows
// UI. Thread calculation itself stays live in offscreen.js (all
// detected cores on Chrome, 1 on Firefox without SAB — cap removed
// in 2.0.3); this record is the first-startup detection, and the
// debug-panel diag line below is how it is verified (debug on,
// first run).
async function saveDetectedCores(cores, source) {
  try {
    if (!cores || typeof cores !== 'number' || cores < 1) return;
    const got = await chrome.storage.local.get(['detectedCores']);
    const prev = got && got.detectedCores;
    if (prev && prev.cores === cores) return;
    await chrome.storage.local.set({ detectedCores: { cores, detectedAt: new Date().toISOString(), source } });
  } catch { /* silent, never fails install or a run */ }
}

chrome.runtime.onInstalled.addListener(details => {
  if (!details || (details.reason !== 'install' && details.reason !== 'update')) return;
  // Run before the early return below: a code-only update changes no
  // models, so the handler returns early for it — core detection must
  // still run on that first startup after the update.
  saveDetectedCores((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || null, 'onInstalled');
  chrome.storage.local.get(['modelFingerprint']).then(async ({ modelFingerprint: stored }) => {
    const current = computeModelFingerprint();
    const modelsChanged = stored !== current;
    if (details.reason === 'update' && !modelsChanged) return;
    if (modelsChanged) {
      try { await chrome.storage.local.set({ modelFingerprint: current }); } catch {}
    }
    // Fire-and-forget: a run that starts before they finish waits for
    // them (see waitForModels), so a slow or failed start here is not fatal.
    try { await autoDownloadMissingModels(); } catch {}
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // A new document is loading (refresh or navigation): the old auto-fire
  // record is stale. Without this, a refresh within 2 min of a successful
  // run is skipped as a dupe ("auto diag skip: dedupe 2min") and the
  // cached translation is never re-rendered — the page stays untranslated
  // even though the translation is already in the cache. A duplicate
  // 'complete' from a slow iframe never triggers a new 'loading', so the
  // dedupe still blocks double-fires for the same load.
  if (changeInfo && changeInfo.status === 'loading') autoFired.delete(tabId);
  // Learned next-page rules: watch URL changes (URL-only learning). Runs
  // on the 'loading' event, which carries changeInfo.url — the 'complete'
  // event below usually does not.
  try {
    if (changeInfo && changeInfo.url) {
      const oldUrl = lastTabUrl.get(tabId);
      const newUrl = changeInfo.url;
      if (oldUrl && oldUrl !== newUrl) {
        observeNextPageChange(tabId, oldUrl, newUrl);
        // Same-document navigation (reader "next" via history.pushState):
        // the URL changed but the tab never left 'complete', so there is
        // no 'complete' event and no fresh content-script injection.
        // Trigger auto-translate here; the dedupe in maybeAutoStart
        // keeps a later 'complete' for the same URL from double-firing.
        // A full navigation has status 'loading' here, so it waits for
        // 'complete' as before and never starts early on a half-loaded page.
        if (tab && tab.status === 'complete') {
          maybeAutoStart(tabId, tab, 'page-load', true);
        }
      }
      lastTabUrl.set(tabId, newUrl);
    }
  } catch {}
  // DIAGNOSTIC (temporary): log every document change for a tab with a
  // run in flight, so the log proves or refutes a mid-run navigation
  // without asking the user.
  try {
    const inFlight = [...runs].some(([, r]) => r.tabId === tabId && !r.cancelled);
  } catch {}
  if (!changeInfo || changeInfo.status !== 'complete') return;
  maybeAutoStart(tabId, tab, 'page-load', true);
});

// 2.3.15/1.7.15: auto-translate trigger, shared by the page-load
// listener above and the registered content script (MSG.AUTO_START).
// Same gates, same diag lines — `source` only tags the log
// ('page-load' vs 'content'), so a pasted log shows which trigger
// fired. The content trigger exists because on Vivaldi the worker can
// wake after the page loaded and miss 'complete' entirely.
// `injectFirst` is only for the page-load path: the content path
// already runs inside the script.
async function maybeAutoStart(tabId, tab, source, injectFirst) {
  try {
    const srcTag = ' (' + source + ')';
    const settings = await getSettings();
    const host = hostOf(tab.url || '');
    if (!host || (!settings.allowAllSites && !isSiteAllowed(host, settings.siteWhitelist || []))) return;
    // Inject the content script on page load for allowed sites, even
    // when auto-translate is off: it carries the anti-right-click
    // override, so it must be on the page BEFORE the user right-clicks
    // a picture. Fire-and-forget (not awaited): the registered script
    // is already on the page at document_end, so this is a redundant
    // no-op — but awaiting it stalled the run start by up to 5s on a
    // busy tab, and a failed inject here never blocks auto-translate.
    if (injectFirst) {
      withTimeout(chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES }), MSG_TIMEOUT_MS, 'content script injection').catch(() => {});
    }
    // AUTO DIAGNOSTIC (2.3.3): log every auto decision for an allowed
    // site — on Vivaldi the page-load signal may never arrive (the
    // worker wakes after the page loaded) or a gate may stop it, and
    // the log then shows which. Silent for disallowed sites (chrome://
    // tabs would flood the log). One line per 'complete'.
    const url = tab.url || '';
    if (!settings.autoTranslateOnLoad) { diagPush('Auto-translate off — skipping ' + url.slice(0, 120) + srcTag); return; }
    if (!tab || !tab.active) { diagPush('Auto-translate skipped — tab not active: ' + url.slice(0, 120) + srcTag); return; }
    const prev = autoFired.get(tabId);
    const now = Date.now();
    if (prev && prev.url === url && now - prev.at < 120000) { diagPush('Auto-translate skipped — same page within 2 minutes: ' + url.slice(0, 120) + srcTag); return; } // same load, don't double-fire
    // Same page and a run for this tab is still working: a late 'complete'
    // (slow iframe, ad slot, …) is not a new page and must not kill the run
    // and restart it from scratch. This matters more now that tiled inpaint
    // can keep a run busy for many minutes. Backstop: if it has been wedged
    // for >15min, let the restart through anyway.
    // (Checked against the live runs map — not a recorded run id — so the
    // guard works while the run is in flight, which is when it matters.)
    if (prev && prev.url === url && now - prev.at < 900000) {
      for (const [inFlightId, r] of runs) {
        if (r.tabId === tabId && !r.cancelled) {
          diagPush('Auto-translate skipped — a run is already going on this page: ' + url.slice(0, 120) + srcTag);
          // The content script just injected (it sent this auto-start)
          // and missed the run's early progress: the first send failed
          // because the script was not there yet, so the pill never
          // showed — on a fast cache-hit run no later progress ever
          // comes, so the pill only appears seconds later, if at all.
          // Re-send the run's current progress now that the script is
          // listening, so the pill appears at once.
          if (currentRun && currentRun.runId === inFlightId) {
            try { setProgress(inFlightId, currentRun.stage, currentRun.progress); } catch {}
          }
          return;
        }
      }
    }
    // One tab at a time (2.3.85, James): a foreground run on another tab
    // owns the single shared ML worker — starting a second run here would
    // starve both, and the other tab would get no response (not even
    // Cancel). Skip this auto start; do NOT cancel the other tab's run.
    // The next trigger retries once it clears. Pre-translate never trips
    // this guard — its runs entry has tabId null, so it is not a
    // foreground run on another tab. Placed before autoFired.set so a
    // skip does not consume the 2-min dedupe window (same as a gate
    // failure below).
    if (foregroundRunState(tabId).other) {
      diagPush('Auto-translate skipped — a run is already going on another tab: ' + url.slice(0, 120) + srcTag);
      return;
    }
    // Record the fire SYNCHRONOUSLY here, BEFORE the gate await below.
    // The dedupe check and this record are one synchronous block (no await
    // between them), so a second 'complete' event (page + a slow iframe)
    // landing in the same tick sees the record at its dedupe check and
    // returns instead of starting a second run. Before this move the record
    // was set after the gate await, so both events passed the dedupe and
    // both started — the second one's cancelRunsForTab then killed the
    // first one's just-started run ('cancelled' in the log).
    autoFired.set(tabId, { url, at: now });
    // Freemium gate: auto-translate counts against the 50/day free limit
    // unless Pro is active. Manual translate is always free and never gated.
    // A stale Pro validation re-checks in the background (never blocks the run).
    const gate = await canAutoOrPre(settings);
    if (!gate.ok) {
      // The gate failed, so no run starts: delete the record we just set,
      // so a gate failure does not consume the 2-min dedupe window. Only
      // clear our own record (same url), so a newer fire's record survives.
      const cur = autoFired.get(tabId);
      if (cur && cur.url === url) autoFired.delete(tabId);
      diagPush('Auto-translate skipped — free limit reached (' + gate.used + '/' + gate.limit + ' images today).');
      // No error is shown on the page (James, 2026-11-26): the daily
      // support popup below is the only limit notice.
      // First time the free limit is hit today, show the daily support popup
      // (Rate it in store → Discount Code: 5STARS). Fire-and-forget: it must
      // never block or slow this return, and it no-ops once the popup has
      // been shown today. The pre-translate limit skip does not trigger it — the
      // user never sees that one, so a popup there would surprise them.
      try { maybeShowSupportPopupAtLimit(tabId).catch(() => {}); } catch {}
      return;
    }
    if (gate.pro && proCheckDue(settings)) validateProLicense(settings).then(r => { if (r && r.ok === false) diagPush('Pro license check failed: ' + (r.error || 'unknown') + ' — keeping Pro state.'); }).catch(() => {});
    diagPush('Auto-translate starting: ' + url.slice(0, 120) + srcTag);
    // New page: drop whatever the tab was doing and start fresh immediately.
    // A stale run must never finish on top of the new page. The fire was
    // already recorded above, before the gate await, so a second 'complete'
    // in the same tick is deduped before it reaches here.
    await cancelRunsForTab(tabId);
    const r = await runPipeline(tabId, { auto: true });
    // Freemium counting now lives inside runPipeline (it counts a finished
    // translation when any Pro feature is on), so nothing to add here.
    // A run cancelled in the middle throws above and counts nothing.
    if (!r.ok && !r.cancelled) {
      console.warn('[ct] auto-translate failed:', String(r.error).slice(0, 160));
      // 2.3.5: a failed auto run must not consume the dedupe window.
      // The user may fix the cause (e.g. lower the minimum image size)
      // and reload at once — that reload would otherwise be skipped as
      // a dupe for 2 minutes, and auto looks dead. Only clear our own
      // record (same url), so a newer fire's record survives.
      const cur = autoFired.get(tabId);
      if (cur && cur.url === url) autoFired.delete(tabId);
    }
  } catch (e) {
    console.warn('[ct] auto-translate error:', String((e && e.message) || e).slice(0, 120));
    diagPush('Auto-translate failed: ' + String((e && e.message) || e).slice(0, 120));
  }
}
// ---------------------------------------------------------------- message router
// ------------------------------------------- right-click "send this image"
// The menu item appears on images on sites that pass the site-access gate:
// documentUrlPatterns mirrors the whitelist (omitted entirely when "Allow
// all sites" is on, since the gate passes everywhere then; no item at all
// when nothing is allowed). A click sends that exact image through the
// pipeline — bypassing the minimum image size — and the translated picture
// replaces it in place. The page cache keys on image content, so it works
// for manual sends too.
const CTX_MENU_ID = 'ct-send-image';
function menuPatternsFor(settings) {
  if (settings.allowAllSites) return null;
  const hosts = settings.siteWhitelist || [];
  if (!hosts.length) return [];
  return hosts.flatMap(h => [`*://${h}/*`, `*://*.${h}/*`]);
}
async function refreshContextMenu() {
  if (!chrome.contextMenus || !chrome.contextMenus.create) return;
  try {
    await chrome.contextMenus.removeAll();
    const settings = await getSettings().catch(() => ({}));
    const patterns = menuPatternsFor(settings);
    if (patterns && !patterns.length) return; // nothing allowed: no menu item
    const props = {
      id: CTX_MENU_ID,
      title: chrome.i18n.getMessage('ctx_send_image') || 'Send to Comic Translate 4 Free',
      contexts: ['image'],
    };
    if (patterns) props.documentUrlPatterns = patterns;
    await chrome.contextMenus.create(props);
  } catch (e) {
    console.warn('[ct] context menu setup failed:', String((e && e.message) || e).slice(0, 120));
  }
}
// Manual send: the right-clicked image goes through the pipeline like a page
// run — same gate, same stages, same page cache, in-place replace.
async function handleTranslateImage(tabId, srcUrl) {
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || /^chrome:\/\//.test(tab.url || '')) return;
    const settings = await getSettings();
    const host = hostOf(tab.url);
    if (!host) return;
    if (!settings.allowAllSites && !isSiteAllowed(host, settings.siteWhitelist || [])) {
      // Unreachable in practice (the menu patterns mirror this gate);
      // best-effort: surface it on the page's pill when a content script
      // can be injected (the menu click is a user gesture).
      try {
        await withTimeout(chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES }), MSG_TIMEOUT_MS, 'content script injection');
        await withTimeout(chrome.tabs.sendMessage(tabId, {
          type: MSG.RUN_PROGRESS, direct: true, stage: 'error',
          error: `"${host}" is not in your site access list — allow it from the popup or Settings, or turn on "Allow all sites"`,
        }), MSG_TIMEOUT_MS, 'run progress notice');
      } catch { /* no page access: stay silent */ }
      return;
    }
    // One tab at a time (2.3.87, James): a right-click send must not start
    // a second run while another tab is translating. Show the reason on
    // the page's pill (same pattern as the site-not-allowed branch above).
    // Never cancels the other tab's run.
    if (foregroundRunState(tabId).other) {
      try {
        await withTimeout(chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES }), MSG_TIMEOUT_MS, 'content script injection');
        await withTimeout(chrome.tabs.sendMessage(tabId, {
          type: MSG.RUN_PROGRESS, direct: true, stage: 'error',
          error: 'Another tab is already translating — wait for it to finish.',
        }), MSG_TIMEOUT_MS, 'run progress notice');
      } catch { /* no page access: stay silent */ }
      return;
    }
    // Any in-flight run for this tab is dropped first — the new request wins.
    await cancelRunsForTab(tabId);
    const r = await runPipeline(tabId, { srcUrl });
    // 403 fallback: the image server refused our download, but opening the
    // image URL directly makes it same-origin, so the canvas tier can read it
    // with no download at all. Capture the pixels in a background tab, then
    // run the normal pipeline on the original tab — the translated picture
    // replaces the original in place.
    if (!r.ok && r.fallbackUrl) {
      try {
        const preCaptured = await fallbackCaptureViaTab(tabId, r.fallbackUrl);
        await runPipeline(tabId, { srcUrl, preCaptured });
      } catch (e) {
        // Fallback failed — the 403 error pill from the first attempt is
        // already showing; leave it.
        console.warn('[ct] fallback capture failed:', String((e && e.message) || e).slice(0, 160));
      }
    }
  } catch (e) {
    console.warn('[ct] manual image send failed:', String((e && e.message) || e).slice(0, 160));
  }
}

// 403 fallback for "Send to Comic Translate 4 Free": open the image URL in a
// background tab, read its pixels via the canvas tier (same-origin there —
// no download, no bot-protection fight), close the tab, and hand the pixels
// back so the normal pipeline runs on the original tab.
//
// Hosts whose pictures fail the background-tab read with "Missing host
// permission for the tab" are recorded here: the popup offers a one-click
// grant for them. The content-script host list alone can miss them (an old
// content script in the tab, or a host that only appears on a later
// picture), and a multi-pic run that partly succeeds never sets
// lastStatus.grantHost, so without this the popup never offers the grant
// and those pictures keep failing.
const MISSING_HOSTS_KEY = 'ct-missing-hosts';
async function recordMissingHost(imageUrl) {
  try {
    const host = new URL(imageUrl).hostname.toLowerCase();
    if (!host) return;
    const got = await chrome.storage.local.get(MISSING_HOSTS_KEY);
    const list = Array.isArray(got[MISSING_HOSTS_KEY]) ? got[MISSING_HOSTS_KEY] : [];
    if (!list.includes(host)) {
      list.push(host);
      // Cap the list: it is a hint for the popup, not a log.
      await chrome.storage.local.set({ [MISSING_HOSTS_KEY]: list.slice(-10) });
    }
  } catch { /* recording must never break the run */ }
}

// Permission gate (James, 2026-11-12): check permission for EVERY picture's
// host BEFORE the run starts — you do not get a second chance. A picture
// whose host has no permission fails the background-tab read and is lost
// for that run, so the run must not start until every host is permitted.
// The hosts come from the inventory's real picture URLs (src), not a guess.
// Same rule as the popup's hasOriginAccess: an exact-host grant OR a
// base-domain grant counts. Fail open: if the hosts cannot be learned or
// the check itself errors, the run proceeds — the per-image fallback still
// records failures for the popup grant.
async function checkImageHostPermissions(images) {
  const hosts = [];
  for (const im of images || []) {
    try {
      const src = im && im.src;
      if (!src || !/^https?:\/\//i.test(src)) continue;
      const h = new URL(src).hostname.toLowerCase();
      if (h && !hosts.includes(h)) hosts.push(h);
    } catch { /* unparsable src — skip it, the run fails open on it */ }
  }
  const missing = [];
  for (const h of hosts) {
    let has = false;
    try {
      for (const p of originAccessPatterns(h)) {
        if (await chrome.permissions.contains({ origins: [p] }).catch(() => false)) { has = true; break; }
      }
    } catch { has = true; /* check errored — fail open, do not block the run */ }
    if (!has) missing.push(h);
  }
  return missing;
}
async function fallbackCaptureViaTab(origTabId, imageUrl, quiet) {
  const notice = (text, sticky) =>
    chrome.tabs.sendMessage(origTabId, { type: MSG.PILL_NOTICE, text, sticky }).catch(() => {});
  // Quiet mode (pre-translate): the job runs in the background, so no pill
  // notice on the user's current page — the failure is in the diag log.
  if (!quiet) await notice('Direct download blocked — reading the image in a background tab…', true);
  // Parse the image URL once for the failure log (host + path).
  let imgHost = '', imgPath = '';
  try { const u = new URL(imageUrl); imgHost = u.host; imgPath = u.pathname; } catch {}
  // Log a failed attempt with everything related: the picture's host/path,
  // the tab's real host/path (redirect target or error page), and the error.
  // "Missing host permission" alone says nothing — the tab URL names
  // where the tab actually was when the script could not run.
  const logFailure = (attemptNo, e) => {
    const tabUrl = (e && e.tabUrl) || '';
    let tabHost = '', tabPath = '';
    if (tabUrl) {
      try {
        const u = new URL(tabUrl);
        if (u.host) { tabHost = u.host; tabPath = u.pathname; }
        else tabHost = tabUrl.slice(0, 120); // e.g. about:neterror — no host, keep the whole URL
      } catch { tabHost = tabUrl; }
    } else tabHost = '(unknown)';
    diagPush(`Background tab read failed (attempt ${attemptNo}): image ${imgHost}${imgPath}, tab ${tabHost}${tabPath} — ${String((e && e.message) || e).slice(0, 120)}`);
  };
  const isMissingHost = (e) => /Missing host permission for the tab/i.test(String((e && e.message) || e));
  // Label for an error-page tab URL: host+path when there is one (a
  // server error page), else the whole URL (about:neterror has no host).
  const errorPageLabel = (u) => {
    try { const p = new URL(u); if (p.host) return p.host + p.pathname; } catch {}
    return String(u).slice(0, 120);
  };
  // One attempt: open the image in a background tab, wait for the picture
  // to load, inject the content script and read the pixels.
  const attempt = async () => {
    let newTabId = null;
    try {
      const newTab = await chrome.tabs.create({ url: imageUrl, active: false });
      if (!newTab || newTab.id == null) throw new Error('could not open background tab');
      newTabId = newTab.id;
      // Wait for the image document to finish loading (its <img> is the page).
      // Only a tab whose address is the picture (an http(s) URL) counts as
      // loaded. A new tab starts at about:blank, which is 'complete'
      // instantly — resolving on that blank 'complete' runs the script
      // before the tab ever reaches the picture, and it fails with
      // "Missing host permission for the tab". So every 'complete' is
      // checked against the tab's real address: an http(s) address
      // resolves, an error page (about:neterror) rejects at once with the
      // real address, and about:blank keeps waiting for the real load.
      await new Promise((resolve, reject) => {
        let done = false;
        const finishOk = () => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        };
        const finishErr = (err) => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          reject(err);
        };
        // 2.2.12: the timeout goes through finishErr, not a bare reject —
        // the old bare reject never removed the onUpdated listener and
        // never set done, leaking one listener per timed-out attempt.
        // 20s is 10x the ~2s normal tab load (see CAPTURE_TAB_TIMEOUT_MS;
        // the ~2s normal is estimated — tab overhead unmeasured — so this
        // is the least certain of the capture timeouts). One stuck image
        // tab costs at most 20s.
        const timeout = setTimeout(() => finishErr(new Error('timed out waiting for the image tab to load')), CAPTURE_TAB_TIMEOUT_MS);
        const checkLoaded = async () => {
          if (done) return;
          let t = null;
          try { t = await chrome.tabs.get(newTabId); } catch { return; }
          if (!t || t.status !== 'complete') return;
          const u = t.url || '';
          if (/^https?:\/\//i.test(u)) { finishOk(); return; }
          if (u && u !== 'about:blank') {
            // Error page (about:neterror, …): the load already failed, it
            // will never reach the picture — fail at once with the real address.
            // This is an error page, not a missing permission: name it so.
            const e = new Error('the image tab loaded an error page at ' + errorPageLabel(u));
            e.tabUrl = u;
            finishErr(e);
          }
          // about:blank (or no address yet): the tab has not reached the
          // picture — keep waiting for the real load.
        };
        const listener = (tabId, changeInfo) => {
          if (tabId === newTabId && changeInfo.status === 'complete') checkLoaded();
        };
        chrome.tabs.onUpdated.addListener(listener);
        // Already loaded (fast cache hit): don't wait for an event that fired.
        checkLoaded();
      });
      // The tab is 'complete' — read its real URL now. If the server
      // refused the picture the tab is on an error page (about:neterror),
      // not the picture, and no script can run there. A redirect to
      // another http(s) address is fine — the reader matches the single
      // picture on the page — so only a non-http(s) tab URL fails here.
      let tabUrl = '';
      try { const t = await chrome.tabs.get(newTabId); tabUrl = (t && t.url) || ''; } catch {}
      if (tabUrl && !/^https?:\/\//i.test(tabUrl)) {
        const e = new Error('the image tab loaded an error page at ' + errorPageLabel(tabUrl));
        e.tabUrl = tabUrl;
        throw e;
      }
      // Log the final tab URL against the requested URL: a redirect to a
      // different host is diagnosable from the log even when the read
      // itself succeeds (a redirect to an error page fails below, and
      // logFailure names both URLs there too).
      if (tabUrl && tabUrl !== imageUrl) diagPush(`Background tab opened a different page than requested (final tab URL ${tabUrl.slice(0, 120)} vs requested ${imageUrl.slice(0, 120)}).`);
      await withTimeout(chrome.scripting.executeScript({ target: { tabId: newTabId }, files: CONTENT_SCRIPT_FILES }), MSG_TIMEOUT_MS, 'content script injection');
      const p = await withTimeout(chrome.tabs.sendMessage(newTabId, { type: 'ct/get-image-pixels', srcUrl: imageUrl }), DATA_TIMEOUT_MS, 'get-image-pixels');
      if (!p || !p.ok || typeof p.dataUrl !== 'string') {
        throw new Error(((p && p.error) || 'could not read the image') + (tabUrl ? ` (tab showed ${tabUrl.slice(0, 120)})` : ''));
      }
      return await dataUrlToRGBA(p.dataUrl);
    } catch (e) {
      // Attach the tab's real URL (if we can still read it) so the
      // failure log shows where the tab actually was.
      if (e && !e.tabUrl && newTabId != null) {
        try { const t = await chrome.tabs.get(newTabId); if (t && t.url) e.tabUrl = t.url; } catch {}
      }
      throw e;
    } finally {
      if (newTabId != null) await chrome.tabs.remove(newTabId).catch(() => {});
    }
  };
  try {
    return await attempt();
  } catch (e1) {
    logFailure(1, e1);
    if (isMissingHost(e1)) await recordMissingHost(imageUrl);
    // Retry once in a fresh tab: a tab that was not ready (or a transient
    // server refusal) can succeed on a second open. Wait a moment first
    // so a transient CDN hiccup can clear before the retry.
    // 1s is an unmeasured guess — no data in the code on how long a
    // transient CDN refusal lasts. The wait itself is justified (a retry
    // in the same instant would hit the same refusal); only the duration
    // is unproven.
    await new Promise(r => setTimeout(r, 1000));
    try {
      return await attempt();
    } catch (e2) {
      logFailure(2, e2);
      if (isMissingHost(e2)) await recordMissingHost(imageUrl);
      throw e2;
    }
  }
}
if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!info || info.menuItemId !== CTX_MENU_ID) return;
    if (!tab || tab.id == null || !info.srcUrl) return;
    // Return the promise so the worker stays alive for the run.
    return handleTranslateImage(tab.id, info.srcUrl);
  });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    refreshContextMenu().catch(() => {});
    try { syncAutoStartRegistrations(); } catch {}
  }
});
refreshContextMenu().catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Learned next-page link text: remember the last link click per tab
  // (one-way, no reply). The click must match a navigation that follows
  // within 2s to teach anything — see observeNextPageChange.
  if (msg && msg.type === MSG.LINK_CLICKED) {
    try {
      const tabId = sender && sender.tab && sender.tab.id;
      if (tabId !== undefined && tabId !== null && msg.href) {
        lastLinkClick.set(tabId, { text: String(msg.text || ''), href: String(msg.href), hasImage: !!msg.hasImage, at: Date.now() });
      }
    } catch {}
    return false;
  }
  // 2.3.15: Vivaldi auto-translate trigger (one-way, no reply). The
  // registered content script sends this on page load; the background
  // runs the same auto gates as the page-load listener. sender.tab
  // carries the tab (id, url, active).
  if (msg && msg.type === MSG.AUTO_START) {
    try {
      const tab = sender && sender.tab;
      if (tab && tab.id !== undefined && tab.id !== null) maybeAutoStart(tab.id, tab, 'content', false);
    } catch {}
    return false;
  }
  // Debug panel Hide button (content -> SW, one-way). Same as turning
  // the debug switch off in Settings: sets debugMode=false in storage,
  // so the Settings Debug section hides too (options.js re-applies on
  // storage change) and emitDebug stops sending panel messages. The
  // panel is already hidden on the content side; this only persists it.
  if (msg && msg.type === MSG.SET_DEBUG_MODE) {
    try { updateSettingsField('debugMode', !!msg.on); } catch {}
    return false;
  }
  // 2.3.15: re-register the content script after a grant change
  // (popup/Settings ask for this right after allowing a site).
  // Also inject it into the active tab right away, so the right-click
  // unlock works without a refresh — registerContentScripts only
  // covers future page loads, so the already-open page would otherwise
  // need a reload. The content script's double-injection guard makes
  // this a no-op if it's already there. Best-effort: a missing host
  // permission or a chrome:// tab just throws, caught below.
  if (msg && msg.type === MSG.SYNC_AUTO_START) {
    (async () => {
      try { await syncAutoStartRegistrations(); } catch {}
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null]);
        if (!tab || tab.id === undefined || tab.id === null) return;
        const settings = await getSettings();
        const host = hostOf(tab.url || '');
        if (!host) return;
        if (!settings.allowAllSites && !isSiteAllowed(host, settings.siteWhitelist || [])) return;
        await withTimeout(chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPT_FILES }), MSG_TIMEOUT_MS, 'content script injection');
      } catch {}
    })();
    return false;
  }
  // Inpaint progress from the Chrome offscreen document (one-way, no reply).
  // Routes into the run's progress bar, so the pill keeps moving during long
  // inpaints instead of looking stalled. Each message is also a worker event,
  // which resets the idle timer — healthy long inpaints keep the worker alive.
  if (msg && msg.type === MSG.ML_INPAINT_PROGRESS) {
    try {
      const r = runs.get(msg.runId);
      if (r && typeof r.onInpaintProgress === 'function') r.onInpaintProgress(msg.frac);
    } catch { /* progress must never break the pipeline */ }
    // GPU1-Chrome: the same progress re-arms the SW-side GPU watchdog
    // in ml-bridge.js (progress resets the 60s inactivity window).
    try { notifyChromeGpuProgress(msg.runId, msg.frac); } catch {}
    return false;
  }
  // Model-download progress from the ML host (one-way, no reply).
  // The offscreen doc broadcasts ct/model-progress {loaded, total} on
  // every read, plus {error} on failure and {done:true} on completion
  // (offscreen.js ML_DOWNLOAD). The SW never consumed these before — the
  // stall checks only saw 8 MB IndexedDB chunk flushes, so a healthy
  // download slower than ~45 KB/s looked stalled. The live byte counts
  // feed modelByteProgress (stall detection) and the error text feeds
  // modelDownloadErrors (restart/give-up policy). Options/popup have
  // their own listeners; this branch does not interfere with them.
  if (msg && msg.type === MSG.MODEL_PROGRESS && msg.fileId) {
    try {
      if (typeof msg.loaded === 'number') modelByteProgress.set(msg.fileId, { loaded: msg.loaded, at: Date.now() });
      if (typeof msg.error === 'string' && msg.error) recordModelDownloadError(msg.fileId, msg.error);
      if (msg.done) { modelByteProgress.delete(msg.fileId); modelDownloadErrors.delete(msg.fileId); }
    } catch { /* progress must never break the pipeline */ }
    return false;
  }
  if (msg && msg.type === MSG.ML_BENCH_RESULT) {
    // 2.1.20: persist every bench line to the trace (diagPush alone is
    // lost on a worker restart). Bench lines stay in benchTrace storage
    // only — they no longer go to the diagnostic log (James, 2026-11-26).
    try { if (typeof msg.line === 'string' && msg.line) benchTracePush(msg.line); } catch {}
    try { if (typeof msg.line === 'string' && msg.line) chrome.storage.local.set({ benchLastLog: { line: msg.line, at: new Date().toISOString() } }); } catch {}
    return false;
  }
  if (msg && msg.type === MSG.ML_BENCH_GET) {
    // 2.1.22: the doc asks the SW for the saved bench values, because
    // the doc's own storage reads fail like its writes. The SW's reads
    // work. Reply with both records (null when nothing is saved).
    (async () => {
      try {
        const saved = await chrome.storage.local.get(['measuredThreads', 'benchStatus']);
        sendResponse({ ok: true, measuredThreads: (saved && saved.measuredThreads) || null, benchStatus: (saved && saved.benchStatus) || null });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  if (msg && msg.type === MSG.ML_BENCH_SAVE) {
    // 2.1.19: the offscreen doc saves bench records through the SW
    // because the doc's own storage writes may be failing (the bench
    // never saves a status, yet the SW's trigger record is saved). The
    // SW writes the same key the doc would have written, so the bench's
    // result and the SW's reads see the same storage.
    // 2.1.20: log the save so the trace proves it arrived and was stored.
    try {
      if (msg.key === 'benchStatus' && msg.value && typeof msg.value === 'object') {
        benchTracePush('threads bench save received benchStatus=' + (msg.value.state || '?') + (msg.value.best != null ? ' best ' + msg.value.best : ''));
        chrome.storage.local.set({ benchStatus: msg.value });
        benchTracePush('threads bench save stored benchStatus=' + (msg.value.state || '?'));
      } else if (msg.key === 'measuredThreads' && msg.value && typeof msg.value === 'object') {
        benchTracePush('threads bench save received measuredThreads=' + (msg.value.threads != null ? msg.value.threads : '?'));
        chrome.storage.local.set({ measuredThreads: msg.value });
        chrome.storage.sync.set({ measuredThreads: msg.value });
        benchTracePush('threads bench save stored measuredThreads=' + (msg.value.threads != null ? msg.value.threads : '?'));
      } else {
        benchTracePush('threads bench save received bad key=' + String(msg.key));
      }
    } catch (e) {
      try { benchTracePush('threads bench save error: ' + String((e && e.message) || e)); } catch {}
    }
    return false;
  }
  // Pill "Allow <host>" button (content script). permissions.request() must be
  // called synchronously in the message turn — the click's user gesture only
  // survives one sync hop across sendMessage, so nothing may be awaited first
  // (same constraint as the popup's grant button; see requestSiteAccessNow).
  if (msg && msg.type === MSG.GRANT_IMAGE_HOST && msg.host) {
    let req;
    try {
      req = chrome.permissions.request({ origins: imageHostOrigins(msg.host) });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 120) });
      return false;
    }
    Promise.resolve(req).then(granted => {
      if (granted && sender.tab && sender.tab.id != null) {
        // Access granted — re-run the pipeline so the user doesn't have to
        // click Translate again. Failures surface through the normal pill.
        runPipeline(sender.tab.id).catch(() => {});
      }
      sendResponse({ ok: !!granted });
    }, () => sendResponse({ ok: false }));
    return true;
  }
  // Support popup buttons (content script). Only the popup's own links may
  // be opened this way — anything else is refused, so a compromised page
  // can never use this channel to open an arbitrary URL. The checkout URL
  // is allowlisted so the Get Pro button can open the Pro checkout.
  if (msg && msg.type === MSG.OPEN_LINK && typeof msg.url === 'string') {
    const ok = msg.url === STORE_URLS.chrome || msg.url === STORE_URLS.firefox ||
      msg.url === FEEDBACK_MAILTO || msg.url === DODO_CHECKOUT_URL;
    if (!ok) { sendResponse({ ok: false, error: 'not an allowed link' }); return false; }
    (async () => {
      try { await chrome.tabs.create({ url: msg.url, active: true }); sendResponse({ ok: true }); }
      catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 120) }); }
    })();
    return true;
  }
  (async () => {
    try {
      switch (msg && msg.type) {
        case MSG.TRANSLATE_PAGE: {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab || tab.id == null) throw new Error('no active tab');
          if (/^chrome:\/\//.test(tab.url || '')) throw new Error('cannot run on chrome:// pages');
          const settings = await getSettings();
          const host = hostOf(tab.url);
          if (!host) throw new Error('cannot determine the site of this tab');
          if (!settings.allowAllSites && !isSiteAllowed(host, settings.siteWhitelist || [])) {
            throw new Error(`"${host}" is not in your site access list — allow it from the popup or Settings, or turn on "Allow all sites"`);
          }
          // Awaited (not fire-and-forget) so the popup can report the result.
          // NOTE: awaiting does NOT keep the worker alive — Chrome may kill
          // it idle (~30s) or at the 5-minute per-event cap mid-run. The ML
          // alarm backup (ml-bridge.js) and inpaint progress keep-alive cover
          // that; without them a killed worker meant a frozen pill, no error.
          // One tab at a time (2.3.87, James): refuse to start a second run
          // while another tab is translating. The popup button is grayed
          // out, but a stale popup (opened before the other run started)
          // can still send this — the guard here makes the rule airtight.
          // Never cancels the other tab's run.
          if (foregroundRunState(tab.id).other) {
            sendResponse({ ok: false, error: 'Another tab is already translating — wait for it to finish or cancel it from the popup.' });
            break;
          }
          // Any in-flight run for this tab is dropped first — the new request wins.
          await cancelRunsForTab(tab.id);
          const r = await runPipeline(tab.id);
          sendResponse(r.ok ? { ok: true, runId: r.runId } : { ok: false, error: r.error });
          break;
        }
        case MSG.CHECK_AZURE: {
          const s = await getSettings();
          sendResponse(await checkAzure(s));
          break;
        }
        case MSG.CHECK_LMSTUDIO: {
          const s = await getSettings();
          sendResponse(await checkLmStudio(s));
          break;
        }
        case MSG.CHECK_GEMINI: {
          const s = await getSettings();
          sendResponse(await checkGemini(s));
          break;
        }
        case MSG.PAGE_CACHE_STATS: {
          sendResponse({ ok: true, ...(await pageCacheStats()) });
          break;
        }
        case MSG.CLEAR_PAGE_CACHE: {
          const st = await pageCacheStats();
          await clearPageCache();
          sendResponse({ ok: true, count: st.count, bytes: st.bytes });
          break;
        }
        case MSG.CANCEL_RUN: {
          // 2.2.12: cancel only the requesting tab's runs. The old code
          // cancelled every tab's run (and the background pre-translate
          // job, whose tabId is null). When no tabId is given (old
          // popup), fall back to cancelling all — the popup always sends
          // one now.
          // 2.3.85 (one tab at a time, James): the popup on a tab with no
          // run of its own sends otherTabs:true to cancel the run on the
          // OTHER tab instead — that is the "Cancel other tab" button.
          // The pre-translate job (tabId null) is never touched by the
          // other-tabs path.
          const targetTab = (msg && typeof msg.tabId === 'number') ? msg.tabId : null;
          if (msg && msg.otherTabs && targetTab !== null) {
            await cancelRunsForOtherTabs(targetTab);
          } else if (targetTab === null) {
            await cancelRunsWhere(() => true);
          } else {
            await cancelRunsForTab(targetTab);
          }
          sendResponse({ ok: true });
          break;
        }
        case MSG.GET_STATUS: {
          // 2.3.85 (one tab at a time, James): the popup also needs to
          // know whether a foreground run is in flight on THIS tab or on
          // ANOTHER tab, so it can gray out Translate and label Cancel
          // "Cancel other tab" when the run is elsewhere. Pre-translate
          // (tabId null) never counts — it is a background job. When no
          // tabId is given, any foreground run counts as this tab's (the
          // old behaviour).
          const stTab = (msg && typeof msg.tabId === 'number') ? msg.tabId : null;
          const st = foregroundRunState(stTab);
          sendResponse({ ok: true, status: currentRun || { stage: 'idle', progress: 0 },
            ownTabRunning: st.own, otherTabRunning: st.other });
          break;
        }
        case MSG.GET_MODELS: {
          sendResponse({ ok: true, models: await getModelStatus() });
          break;
        }
        case MSG.DOWNLOAD_MODEL: {
          // fire-and-forget; progress arrives via MODEL_PROGRESS broadcasts.
          // Routed through triggerModelDownload so a manual click cannot
          // start a duplicate of an auto-download already in flight.
          const p = triggerModelDownload(msg.fileId);
          if (p) p.then(
            () => chrome.runtime.sendMessage({
              type: MSG.MODEL_PROGRESS, fileId: msg.fileId, done: true,
            }).catch(() => {}),
            e => chrome.runtime.sendMessage({
              type: MSG.MODEL_PROGRESS, fileId: msg.fileId,
              error: String((e && e.message) || e),
            }).catch(() => {}),
          );
          sendResponse({ ok: true });
          break;
        }
        case MSG.DELETE_MODEL: {
          await deleteModelGroup(msg.id);
          // Drop any loaded session built from the deleted bytes.
          try { await callMl({ type: MSG.ML_RESET, group: msg.id }); } catch { /* offscreen not up */ }
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

// FIX1: orphan + alarm recovery. Runs once when this background page /
// service worker loads. If a previous background died mid-run, its
// persisted record is still in storage (the in-memory runs map died with
// it). Failing it cleanly here unfreezes the pill and shows the panel
// log, instead of leaving the pill frozen at the last progress.
// 1.4.0 (m4): Chrome service workers now run this too, with a guard:
// orphans with a pending ct-ml alarm entry are skipped (the alarm backup
// will fail those, single error), while orphans with NO ct-ml entry
// (GPU runs, which bypass callMl and create no alarm entries, and
// runs past ML) are failed here — previously they were lost with a
// stuck pill and no error. Firefox behaviour is unchanged (all orphans
// failed here); m1 idempotence prevents the alarm double-fail there.
// 1.4.0 (m1): runIds already failed by recovery in this background.
// Same-background guard for orphan-then-alarm duplicates; the storage
// check inside failOrphanedRun covers cross-restart duplicates.
const recoveredOrphanRuns = new Set();
// Returns true only if this call actually sent the error. Callers send
// their error diag + panel log ONLY when this returns true, so one
// background death produces one error, not orphan + alarm.
async function failOrphanedRun(orphanRunId, rec, msg) {
  if (recoveredOrphanRuns.has(orphanRunId)) return false;
  recoveredOrphanRuns.add(orphanRunId);
  while (recoveredOrphanRuns.size > 64) recoveredOrphanRuns.delete(recoveredOrphanRuns.values().next().value);
  // FIX2: a recovered orphan's repeating keepalive alarm must not fire
  // forever — clear it here (finally never ran for this run). Best-effort,
  // and idempotent, so it is safe to clear even on the skip path below
  // (a previous recovery may have died after clearing the record but
  // before clearing the alarm).
  try {
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      const p = chrome.alarms.clear('ct-keepalive:' + orphanRunId);
      if (p && p.catch) p.catch(() => {});
    }
  } catch {}
  // Storage check: if no record remains, an earlier recovery already
  // handled this run (or it ended normally) — do not send a second
  // error. A storage read failure falls through to failing the run:
  // a duplicate error is a wart, a frozen pill with no error is worse.
  try {
    const all = (await chrome.storage.local.get(ACTIVE_RUNS_KEY))[ACTIVE_RUNS_KEY] || {};
    if (!all[orphanRunId]) return false;
  } catch {}
  // Remove first: never fail the same orphan twice (e.g., if this
  // background restarts again mid-recovery).
  await clearRunRecord(orphanRunId);
  // 1.4.0 (m5): drop this dead run's staged pixel payloads (the
  // pipeline finally never ran for it). Best-effort; never blocks error.
  try { await pixelPruneRun(orphanRunId); } catch {}
  if (rec.tabId == null) return false;
  const tab = await chrome.tabs.get(rec.tabId).catch(() => null);
  if (!tab) return false;
  try { await withTimeout(chrome.scripting.executeScript({ target: { tabId: rec.tabId }, files: CONTENT_SCRIPT_FILES }), MSG_TIMEOUT_MS, 'content script injection'); } catch {}
  // RUN_STARTED first: it sets the tab's current run to this runId, so the
  // error + panel log below are not rejected as stale.
  try { await withTimeout(chrome.tabs.sendMessage(rec.tabId, { type: MSG.RUN_STARTED, runId: orphanRunId }), MSG_TIMEOUT_MS, 'content script ping'); } catch {}
  try { await withTimeout(chrome.tabs.sendMessage(rec.tabId, { type: MSG.RUN_PROGRESS, runId: orphanRunId, stage: 'error', error: msg, direct: true }), MSG_TIMEOUT_MS, 'run progress notice'); } catch {}
  return true;
}
async function recoverOrphanedRuns() {
  try {
    const all = (await chrome.storage.local.get(ACTIVE_RUNS_KEY))[ACTIVE_RUNS_KEY] || {};
    for (const orphanRunId of Object.keys(all)) {
      const rec = all[orphanRunId];
      try {
        // 1.4.0 (m4, Chrome service workers only): skip orphans with a
        // pending ct-ml alarm entry — the alarm backup will fail those
        // (single error). On a storage-list failure, also skip (leave
        // the record for the next load) rather than risk a double-fail.
        // Firefox skips this check entirely (all orphans failed here).
        if (!(typeof window !== 'undefined' && window.document)) {
          let hasMlAlarm = false;
          let checkFailed = false;
          try {
            const store = await chrome.storage.local.get(null);
            hasMlAlarm = Object.keys(store || {}).some(k => k.startsWith('ct-ml-pending:') && k.includes(':' + orphanRunId + ':'));
          } catch { checkFailed = true; }
          if (checkFailed) {
            diagPush('A run died mid-translate — ML alarm check failed, leaving its record for the next load.');
            continue;
          }
          if (hasMlAlarm) {
            diagPush('A run died mid-translate — its pending ML alarm will handle it.');
            continue;
          }
        }
        // 2.2.10: no log clear here — the log is global across tabs/runs,
        // so the auto-resume decision lines are kept.
        // Auto-resume (2.1.56): a run the background killed mid-way restarts
        // by itself on the same tab, skipping the pictures it already
        // finished, instead of only showing an error. Limits: at most 2
        // auto-resumes per run (loop guard), the tab must still be open on
        // the SAME page, and at least one picture must already be finished
        // (otherwise there is nothing to resume from).
        const MAX_AUTO_RESUMES = 2;
        const resumes = (rec && rec.resumes) || 0;
        if (resumes < MAX_AUTO_RESUMES && rec && rec.tabId != null && rec.url) {
          let resumed = false;
          try {
            const tab = await chrome.tabs.get(rec.tabId).catch(() => null);
            if (tab && tab.url === rec.url) {
              await withTimeout(chrome.scripting.executeScript({ target: { tabId: rec.tabId }, files: CONTENT_SCRIPT_FILES }), MSG_TIMEOUT_MS, 'content script injection').catch(() => {});
              const r = await withTimeout(chrome.tabs.sendMessage(rec.tabId, { type: 'ct/list-images' }), DATA_TIMEOUT_MS, 'list-images').catch(() => null);
              const list = (r && r.images) || [];
              const alreadyDone = list.filter(im => im && im.translated).length;
              if (alreadyDone > 0) {
                diagPush(`A run died mid-translate — resuming it (resume ${resumes + 1} of ${MAX_AUTO_RESUMES}, ${alreadyDone} picture${alreadyDone === 1 ? '' : 's'} already done).`);
                // Clear the dead run's record + keepalive alarm so it is
                // not recovered again, then start the resumed run.
                await clearRunRecord(orphanRunId);
                try {
                  if (typeof chrome !== 'undefined' && chrome.alarms) {
                    const p = chrome.alarms.clear('ct-keepalive:' + orphanRunId);
                    if (p && p.catch) p.catch(() => {});
                  }
                } catch {}
                // 2.1.57: clear the dead run's pending ML alarms too. The
                // ML call it died in never settled, so its alarm entry is
                // still in storage; when it fires later the hook would fail
                // a run that was already resumed (spurious error on the tab).
                try {
                  const store = await chrome.storage.local.get(null);
                  const keys = Object.keys(store || {}).filter(k => k.startsWith('ct-ml-pending:') && k.includes(':' + orphanRunId + ':'));
                  for (const k of keys) {
                    try { await chrome.storage.local.remove(k); } catch {}
                    try {
                      const alarmName = k.slice('ct-ml-pending:'.length);
                      const p = chrome.alarms.clear(alarmName);
                      if (p && p.catch) p.catch(() => {});
                    } catch {}
                  }
                  if (keys.length) diagPush(`Resumed run: cleared ${keys.length} pending ML alarm(s) from the dead run.`);
                } catch {}
                runPipeline(rec.tabId, { resume: true, resumeCount: resumes, auto: true }).catch(() => {});
                resumed = true;
              } else {
                diagPush(`A run died mid-translate — not resuming it, no picture finished yet (${list.length} pictures on the page).`);
              }
            } else {
              diagPush('A run died mid-translate — not resuming it, the tab is gone or the page changed.');
            }
          } catch (e) {
            diagPush('A run died mid-translate — resume check failed: ' + String((e && e.message) || e).slice(0, 80));
          }
          if (resumed) {
            diagPush('Dead run resumed.');
            continue;
          }
        } else {
          // 2.1.57: log why the resume was not even attempted, so a
          // skipped second resume is diagnosable instead of silent.
          diagPush(`Dead run not resumed — already resumed ${resumes} of ${MAX_AUTO_RESUMES} times.`);
        }
        // 2.1.55: replay the persisted pre-restart log into the panel log,
        // so the user sees what the background was doing before it died.
        const recoveredCount = await replayDiagTrace();
        const msg = 'Translation stopped because the background restarted while it was at stage ' + (rec.stage || 'unknown') + ' — please run translate again.' + (recoveredCount > 0 ? ' (The log from before the restart is in the diagnostic panel below.)' : ' (The detailed log from before the restart was in memory only and is lost.)');
        diagPush('A run died at stage ' + (rec.stage || 'unknown') + ' — the background restarted.');
        const sent = await failOrphanedRun(orphanRunId, rec, msg);
        if (sent) {
          diagPush('Run died: ' + msg);
          if (rec.tabId != null) {
            const s = await getSettings().catch(() => null);
            if (s && s.debugMode) await sendDiagLog(rec.tabId, orphanRunId);
          }
        }
        diagPush('Dead-run recovery done.');
      } catch {}
    }
  } catch {}
}
// Alarm recovery hook (ml-bridge onAlarm): the alarm fired because the
// background died mid-ML-call. Fail that run the same clean way.
// ML worker startup measurement (item 6): the ready/timeout lines go to
// the diagnostic log, so James can read the real startup time off his phone.
setMlWorkerDiagHook((line) => { try { diagPush(line); } catch {} });
setMlAlarmRecoveryHook(async (entry, msg) => {
  try {
    // 2.1.57: skip a run whose record is already gone — it was auto-resumed
    // (its pending ML alarms were cleared there) or already failed, so
    // failing it here would show a spurious error for a run that no longer
    // exists. The record is the source of truth; the alarm entry is stale.
    try {
      const all = (await chrome.storage.local.get(ACTIVE_RUNS_KEY))[ACTIVE_RUNS_KEY] || {};
      if (!all[entry.runId]) {
        diagPush('Alarm recovery skipped — no active run record (already resumed or failed).');
        return;
      }
    } catch {}
    // 2.1.55: replay the persisted pre-restart log, same as orphan recovery.
    await replayDiagTrace();
    diagPush('Alarm recovery: a run died mid-ML-call (' + entry.type + ').');
    const sent = await failOrphanedRun(entry.runId, { tabId: entry.tabId }, msg);
    if (sent) {
      diagPush('Alarm recovery failed: ' + msg);
      if (entry.tabId != null) {
        const s = await getSettings().catch(() => null);
        if (s && s.debugMode) await sendDiagLog(entry.tabId, entry.runId);
      }
    }
  } catch {}
});
// 1.4.0 (m4): runs on both browsers now (see the FIX1 comment above).
// Fire-and-forget: never block background startup, never throw.
recoverOrphanedRuns().catch(() => {});
recoverPretranslateJob().catch(() => {});
