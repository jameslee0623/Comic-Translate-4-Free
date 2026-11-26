// Translation backends. translateBlocks(blocks, settings) -> aligned [string].
// Empty source texts map to empty translations. Throws with a human message.
import { LANGS, TARGET_LANGS, updateSettingsField } from '../shared/settings.js';

// Plain sleep primitive: waits for wall-clock time to pass. No event,
// callback or promise can replace it — elapsed time is the thing being
// waited for. All real waits in this file go through sleep/sleepAbortable.
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Abort-aware sleep: rejects immediately on cancel instead of waiting out
// the full backoff delay.
// Retry logger: the service worker sets this to diagPush so every
// translate retry lands in the Diagnostic log (backend, attempt,
// status, wait). Without it a slow translate looks like one slow call
// when it was really retries + backoff. Set via setTranslateLogger.
let _translateLog = null;
export function setTranslateLogger(fn) { _translateLog = typeof fn === 'function' ? fn : null; }
function tlog(line) { try { if (_translateLog) _translateLog(line); } catch {} }

// Abort-aware sleep: waits out a backoff delay, but resolves/rejects at
// once when `signal` aborts instead of sleeping the full delay. This is
// the best shape for a timed wait that must stay cancellable: a bare
// setTimeout cannot be cut short by a cancel, and there is no event that
// fires when "enough time has passed for the server to recover".
function sleepAbortable(ms, signal) {
  if (!signal) return sleep(ms);
  if (signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    };
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Retry-After: when a backend answers 429 it tells us how long to wait,
// as seconds ("5") or an HTTP date. Read that number instead of guessing
// a backoff — it is the server's own signal, so it is the fastest correct
// wait. Returns milliseconds, or null when the header is absent or
// unparseable (then the caller falls back to its fixed delay).
// RETRY_AFTER_MAX_MS: the longest Retry-After worth waiting out. It is the
// max blind delay (4000ms), not a new magic number. A server that says
// "come back in 60s" is down for longer than our translate budget, so the
// caller breaks out of the retry loop at once and fails over to Google
// instead of burning the budget waiting.
const RETRY_AFTER_MAX_MS = 4000;
function retryAfterMs(resp) {
  if (!resp || !resp.headers || typeof resp.headers.get !== 'function') return null;
  const v = resp.headers.get('Retry-After');
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const secs = Number(s);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  return null;
}

// Retry-After, plus the millisecond variant some Azure services send
// (retry-after-ms). Returns ms, or null. The header path is kept even
// though it is unverified for Azure Translator / Gemini: whichever
// header is present wins, and the blind backoff is the fallback.
function retryAfterMsAny(resp) {
  const ra = retryAfterMs(resp);
  let ms = null;
  try {
    const v = resp && resp.headers && typeof resp.headers.get === 'function'
      ? resp.headers.get('retry-after-ms') : null;
    if (v != null) { const n = Number(String(v).trim()); if (Number.isFinite(n) && n >= 0) ms = n; }
  } catch {}
  if (ra != null && ms != null) return Math.max(ra, ms);
  return ra != null ? ra : ms;
}

// Log the rate-limit / correlation headers a backend sent, when present.
// Never throws: headers are diagnostic, not load-bearing.
function logRateLimitHeaders(resp, backend) {
  try {
    if (!resp || !resp.headers || typeof resp.headers.get !== 'function') return;
    const parts = [];
    for (const name of ['X-RequestId', 'x-requestid', 'x-ratelimit-remaining-requests', 'x-ratelimit-remaining-tokens', 'retry-after-ms', 'Retry-After']) {
      const v = resp.headers.get(name);
      if (v != null && String(v).trim() !== '') parts.push(`${name}=${v}`);
    }
    if (parts.length) tlog(`translate ${backend}: ${parts.join(' ')}`);
  } catch {}
}

function requestIdOf(resp) {
  try {
    const v = resp && resp.headers && typeof resp.headers.get === 'function'
      ? (resp.headers.get('X-RequestId') || resp.headers.get('x-requestid')) : null;
    return v != null && String(v).trim() !== '' ? String(v).trim() : null;
  } catch { return null; }
}

// Map a 4xx status to a plain-language message (audit 3b). The raw status
// is kept in the prefix so the diag log still shows it.
function mapHttpStatus(status, backend) {
  if (status === 401) return `${backend}: key invalid, check Settings`;
  if (status === 404) return `${backend}: model/endpoint not found`;
  if (status === 400) return `${backend}: bad request (prompt too long / bad language)`;
  if (status === 403) return `${backend}: forbidden / trial quota used up`;
  return null;
}

// Parse an error body once. Returns { code, message, status } (any field
// may be null) — the callers surface code/message, never the raw slice
// alone. Accepts both {error:{code,message,status}} (Azure/Gemini) and a
// bare {code,message} shape.
function parseErrorBody(text) {
  const out = { code: null, message: null, status: null };
  if (!text || !String(text).trim()) return out;
  try {
    const data = JSON.parse(String(text));
    const e = data && data.error ? data.error : data;
    if (e && typeof e === 'object') {
      if (e.code != null) out.code = String(e.code);
      if (typeof e.message === 'string' && e.message.trim()) out.message = e.message.trim();
      if (e.status != null) out.status = String(e.status);
    }
  } catch { /* not JSON — callers keep the raw slice as fallback */ }
  return out;
}

// A fetch TypeError with no response. Chrome's message rarely names the
// cause, so classify only what the message actually says — never guess.
function classifyTypeError(e) {
  const m = String((e && e.message) || e || '');
  if (/cors|permission|blocked by|access-control/i.test(m)) return 'CORS';
  if (/dns|ENOTFOUND|getaddrinfo|name not resolved|ERR_NAME_NOT_RESOLVED/i.test(m)) return 'DNS';
  if (/refused|ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(m)) return 'refused';
  if (/offline|network|Failed to fetch|fetch failed/i.test(m)) return 'network';
  return m ? m.slice(0, 80) : 'network';
}
function isCorsTypeError(e) {
  return e && e.name === 'TypeError' && classifyTypeError(e) === 'CORS';
}

// Fetch one attempt with its own timer: min(remaining, 15000) ms, mirroring
// lmStudioFetch. The per-attempt controller is linked to the caller's
// signal, so a user cancel / deadline abort still aborts everything.
// On a timer abort the error carries .timedOut = true so the caller can
// retry once and then fail over instead of treating it as a network error.
async function fetchAttempt(url, opts, signal, timeoutMs) {
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, Math.max(1, timeoutMs));
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (timedOut && e && e.name === 'AbortError') {
      const err = new Error('attempt timed out');
      err.name = 'AbortError'; err.timedOut = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// Remaining budget (ms) against an absolute deadline (Date.now() clock),
// or Infinity when no deadline was supplied.
function remainingMs(deadlineAt) {
  return deadlineAt == null ? Infinity : deadlineAt - Date.now();
}

// Read a JSON body only after checking Content-Type. When the header is
// present and is not JSON, the body is a block/error page, not a reply.
// When the header is absent, still try to parse and report a parse failure
// as an unreadable reply rather than a bare SyntaxError.
async function readJsonChecked(resp, backend) {
  const ct = (() => { try { return resp.headers && resp.headers.get ? resp.headers.get('Content-Type') : null; } catch { return null; } })();
  if (ct != null && !/json/i.test(String(ct))) {
    throw new Error(`${backend}: unreadable reply (HTTP 200, not JSON — likely a block page)`);
  }
  const text = await resp.text().catch(() => '');
  try { return JSON.parse(text); }
  catch { throw new Error(`${backend}: unreadable reply (HTTP 200, not JSON — likely a block page)`); }
}

// Parse a Gemini-style retry delay ("40s", "54.2s", "1m5s") to ms.
function parseRetryDelaySeconds(v) {
  if (v == null) return null;
  const m = String(v).trim().match(/^(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!m || (m[1] == null && m[2] == null)) return null;
  return ((Number(m[1] || 0) * 60) + Number(m[2] || 0)) * 1000;
}

// Source-language guard, shared by Gemini and LM Studio (audit 3b item 14).
// Returns { bad, why, badCount, kanjiOnly } or null when the output is clean.
// An empty translation for a non-empty source counts as bad. When the
// target is Japanese, identity against a non-Japanese source counts as bad
// instead of skipping the guard entirely. Kanji-only output that differs
// from the source cannot be told apart from a real Chinese translation,
// so it is accepted but noted (kanjiOnly) for the diagnostic log.
function checkSourceLanguageOutput(out, texts, targetLang) {
  let bad = -1, why = '', badCount = 0, kanjiOnly = false;
  const kanaRe = /[\u3040-\u309F\u30A0-\u30FF]/;
  const japaneseRe = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/;
  (out || []).forEach((t, i) => {
    const s = (t || '').trim();
    const src = (texts[i] || '').trim();
    if (!src) return;
    if (!s) { badCount++; if (bad < 0) { bad = i; why = 'empty translation for a non-empty source'; } return; }
    if (targetLang === 'ja') {
      if (s === src && !japaneseRe.test(src)) { badCount++; if (bad < 0) { bad = i; why = 'identical to a non-Japanese source'; } }
      return;
    }
    if (kanaRe.test(s)) { badCount++; if (bad < 0) { bad = i; why = 'still contains Japanese kana'; } return; }
    if (src && s === src) { badCount++; if (bad < 0) { bad = i; why = 'identical to the source text'; } return; }
    if (/[\u4E00-\u9FFF]/.test(s) && !kanaRe.test(s) && kanaRe.test(src)) kanjiOnly = true;
  });
  if (bad < 0 && !kanjiOnly) return null;
  return { bad, why, badCount, kanjiOnly };
}
function applySourceLanguageGuard(out, texts, settings, backend) {
  const hit = checkSourceLanguageOutput(out, texts, settings.targetLang);
  if (!hit) return out;
  if (hit.kanjiOnly && hit.bad < 0) {
    tlog(`${backend}: kanji-only output, cannot rule out untranslated kanji — accepted`);
    return out;
  }
  tlog(`${backend} returned source-language output (${hit.why}) — ${hit.badCount} of ${out.length} entries bad, failing over`);
  throw new Error(`${backend}: returned source-language text (${hit.why}), failing over`);
}

// Fetch with timeout and retry for LM Studio (the flakiest backend).
// NOTE: the old "10-min timeout per attempt; 2 retries with 2s/6s backoff"
// line was stale and is corrected here — the code caps each attempt at 60s
// (see the Math.min(60000, remaining) timer) and the whole call at
// deadlineMs (default 30s), with up to 3 retries on backoffs [1000, 2000,
// 4000]ms, on network errors and 5xx only (4xx are not retried).

// LM Studio host permission check. Manifest covers localhost/127.0.0.1
// only — NOT [::1] (the manifests grant no IPv6 loopback). A [::1] URL
// therefore needs an explicit grant like a LAN host; treating it as
// covered made the fetch fail with a misleading "is the server running?"
// while the grant button said no grant was needed.
export function lmStudioHostPattern(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return null; // covered by manifest
    // Ensure IPv6 literals are bracketed in the permission pattern.
    // u.host is already bracketed for IPv6, but be explicit: an IPv6
    // address has 2+ colons (IPv4:port has exactly one).
    let h = u.host;
    const colons = (h.match(/:/g) || []).length;
    if (colons >= 2 && !h.startsWith('[')) {
      // Unbracketed IPv6 (with or without port) — bracket the address.
      const lastColon = h.lastIndexOf(':');
      const afterLast = h.slice(lastColon + 1);
      if (/^\d+$/.test(afterLast) && h.slice(0, lastColon).includes(':')) {
        h = `[${h.slice(0, lastColon)}]:${afterLast}`; // addr:port
      } else {
        h = `[${h}]`; // bare address
      }
    }
    return `${u.protocol}//${h}/*`;
  } catch { return null; }
}

export async function ensureLmStudioHostAccess(url) {
  const pattern = lmStudioHostPattern(url);
  if (!pattern) return; // localhost — manifest covers it
  let has = false;
  try {
    has = await chrome.permissions.contains({ origins: [pattern] });
  } catch { /* assume not granted */ }
  if (!has) {
    const host = (() => { try { return new URL(url).host; } catch { return url; } })();
    const err = new Error(`LM Studio: no permission to reach ${host}. Click "Grant host access" next to the server URL in Settings, then try again.`);
    err.needsHostGrant = true;
    err.hostPattern = pattern;
    throw err;
  }
}
// deadlineMs caps the TOTAL wall time across attempts + backoffs (default
// 30s — matching the Firefox worker deadline and Chrome's translate
// abort, so a hung server can't hold the worker past its kill). Callers
// thread their own deadline: the SW passes 30s on both browser paths.
// The 30s value is an app-chosen budget, not a server/API limit: it is
// sized so stall (30s) + rescue failover (20s) still fits under the
// caller's 60s backstop (TRANSLATE_BACKSTOP_MS in service-worker.js).
async function lmStudioFetch(url, opts, signal, label, deadlineMs = 30000) {
  const deadline = Date.now() + deadlineMs;
  // Retry backoff between LM Studio attempts: waits for a flaky local
  // server / transient network error to clear. No event exists for "the
  // server recovered", so a timed wait is the only option. This is the
  // one backoff in this file that is budget-safe: the wait is capped at
  // the remaining deadline (Math.min below), so retries can never eat
  // time reserved for failover — copy this pattern, don't copy the
  // Google/Azure/Gemini delays. TODO: the 1000/2000/4000 values have no
  // measured basis or API contract in the code — conventional exponential
  // backoff; verify whether a shorter first delay would fail over sooner.
  const backoffs = [1000, 2000, 4000];
  let lastErr = null;
  let retries408 = 0; // 408 like 503: retry once, then fail over.
  let pendingWait = null; // Retry-After (ms) from a 429, used for the next backoff instead of the blind delay.
  const timedOut = () => new Error('LM Studio: translate timed out');
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    let remaining = deadline - Date.now();
    if (remaining <= 0) throw timedOut();
    if (attempt > 0) {
      // Backoff wait, capped at the remaining deadline (see the backoffs
      // comment above): retries never consume failover's time.
      const wait = pendingWait != null ? Math.min(pendingWait, remaining) : Math.min(backoffs[attempt - 1], remaining);
      pendingWait = null;
      await sleepAbortable(wait, signal);
      remaining = deadline - Date.now();
      if (remaining <= 0) throw timedOut();
    }
    // Combine the caller's cancel signal with the per-attempt timeout
    // (capped by the remaining deadline).
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
      signal.addEventListener('abort', onAbort, { once: true });
    }
    // Per-attempt abort timer: waits for one LM Studio fetch to answer,
    // then aborts it so a hung local server cannot stall the whole page.
    // fetch() has no built-in timeout, so a timer + AbortController is
    // the only way to bound a single attempt. 60s is the per-attempt
    // ceiling; the remaining deadline caps it further, so inside a 30s
    // budget this timer effectively fires at `remaining`, not 60s.
    // TODO: why 60s? No measured value or server contract found in the
    // code — verify whether it should be the deadline itself.
    const timer = setTimeout(() => ctrl.abort(), Math.min(60000, remaining));
    try {
      const resp = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      // Retry on 5xx, on 429 (treated like 5xx: no quota exists on a
      // local server, so a 429 is a transient overload, not a limit),
      // and once on 408 (like 503, then fail over).
      // 4xx are client errors (not retried) — except that callers map
      // 404/401 into plain messages once the response is returned.
      if (resp.status === 408 && retries408 >= 1) return resp;
      if (resp.status === 408) retries408++;
      if ((resp.status === 429 || resp.status === 408 || (resp.status >= 500 && resp.status < 600)) && attempt < backoffs.length) {
        const ra = resp.status === 429 ? retryAfterMsAny(resp) : null;
        if (ra != null) pendingWait = ra;
        lastErr = new Error(`LM Studio: HTTP ${resp.status} from ${label} (retrying)`);
        typeof tlog === 'function' && tlog(`translate retry lmstudio attempt ${attempt + 1}/${backoffs.length} status=${resp.status} backoff=${pendingWait != null ? pendingWait : backoffs[attempt]}ms`);
        continue;
      }
      return resp;
    } catch (e) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (e && e.cancelled) throw e;
      // Deadline hit while waiting: report the timeout, not "cannot reach"
      // — the server was reachable but too slow.
      if (Date.now() >= deadline) throw timedOut();
      // AbortError from timeout: retry if attempts remain.
      const isTimeout = e && e.name === 'AbortError' && !signal?.aborted;
      const isNetwork = e && (e.name === 'TypeError' || /fetch failed|cannot reach|network/i.test(String(e.message)));
      if ((isTimeout || isNetwork) && attempt < backoffs.length) {
        lastErr = e;
        typeof tlog === 'function' && tlog(`translate retry lmstudio attempt ${attempt + 1}/${backoffs.length} ${e && e.name ? e.name : 'network'} backoff=${backoffs[attempt]}ms`);
        continue;
      }
      throw e;
    }
  }
  // Attempts exhausted on timeouts: report the deadline, not "cannot reach".
  if (lastErr && lastErr.name === 'AbortError') throw timedOut();
  throw lastErr || new Error('LM Studio: request failed');
}

function langName(code) {
  const hit = LANGS.find(([c]) => c === code) || TARGET_LANGS.find(([c]) => c === code);
  return hit ? hit[1] : code;
}

async function googleFree(texts, src, dst, signal, deadlineAt) {
  // The gtx endpoint is unofficial and rate-limits aggressively (HTTP 500 /
  // 429 in bursts). Requests run with a small worker pool (3 lanes) instead
  // of one-at-a-time; each lane keeps the original ~120ms pacing between its
  // own requests, so total rate is ~3x the old sequential rate, not Nx.
  // Lanes share an internal controller linked to the caller's signal: when
  // one lane fails, the others are aborted at once (their results would be
  // discarded anyway) and the first failure is the one thrown. The caller
  // signal itself is never aborted — only this call's lanes are.
  const out = new Array(texts.length);
  const laneCtrl = new AbortController();
  if (signal) {
    if (signal.aborted) laneCtrl.abort();
    else signal.addEventListener('abort', () => laneCtrl.abort(), { once: true });
  }
  const failed = [];
  let next = 0;
  async function lane() {
    for (;;) {
      const i = next++;
      if (i >= texts.length) return;
      try {
        out[i] = await googleOne(texts[i], src, dst, laneCtrl.signal, deadlineAt);
      } catch (e) {
        // A 'cancelled' here with the caller's signal still alive means
        // this lane was aborted because a sibling failed — it did not fail
        // itself, so do not list it as failed. (Without this, an aborted
        // sibling's 'cancelled' could be picked as the thrown error below
        // and the real backend failure would surface as a quiet cancel.)
        const abortedBySibling = e && e.message === 'cancelled' && !(signal && signal.aborted);
        if (!abortedBySibling) failed.push(i);
        tlog(`google lane failed for text ${i + 1} of ${texts.length}: ${String(e && e.message ? e.message : e).slice(0, 120)}`);
        laneCtrl.abort();
        throw e;
      }
      // Per-lane pacing: waits 120ms between one lane's Google requests
      // so the unofficial gtx endpoint is not hammered into 429s. No
      // server signal tells us when it is safe to send the next request,
      // so a fixed gap is the only throttle — but the 120ms value is
      // inherited ("as before"), not measured, and the code never reads
      // the 429 Retry-After header, which IS the server's real signal.
      // TODO: verify 120ms against actual 429 rates; honour Retry-After
      // on 429 instead of (or in addition to) blind pacing.
      // Abort-aware so a cancel stops pacing at once instead of waiting
      // out the 120ms.
      await sleepAbortable(120, laneCtrl.signal);
    }
  }
  const lanes = [];
  for (let k = 0; k < Math.min(3, texts.length); k++) lanes.push(lane());
  const settled = await Promise.allSettled(lanes);
  // Prefer a real backend error over a 'cancelled' from a lane that was
  // only aborted because a sibling failed — otherwise a real Google
  // failure surfaces as a quiet cancel and no failover happens. A genuine
  // user cancel still throws 'cancelled' (all rejections are cancelled).
  const firstErr = settled.find(r => r.status === 'rejected' && !(r.reason && (r.reason.cancelled || r.reason.message === 'cancelled')))
    || settled.find(r => r.status === 'rejected');
  if (firstErr) {
    tlog(`google lane failure: texts ${failed.map(i => i + 1).join(', ')} of ${texts.length} failed; other lanes aborted`);
    throw firstErr.reason;
  }
  return out;
}

async function googleOne(t, src, dst, signal, deadlineAt) {
  // Never send a GET the URL cannot hold: a very long q= comes back 414,
  // which is not rate-limiting and cannot be fixed by retrying.
  if (encodeURIComponent(t).length > 6000) {
    throw new Error('google translate: text too long for Google URL — failing over to a POST backend');
  }
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx' +
    `&sl=${encodeURIComponent(src)}&tl=${encodeURIComponent(dst)}&dt=t&q=${encodeURIComponent(t)}`;
  // The gtx endpoint is unofficial and rate-limits aggressively (HTTP 500 /
  // 429 in bursts). One failure must not kill the whole page: retry with
  // exponential backoff + jitter before giving up on this text.
  // 3 tries only (James 2026-11-26 — the old 10s third delay is gone):
  // waits are 1500+4000 = 5.5s max, plus up to 0.8s jitter per wait
  // (~7.1s). Every backoff is capped at the remaining budget, like
  // lmStudioFetch (Math.min(wait, remaining)); when nothing remains the
  // loop breaks out and fails over instead of sleeping. Retry-After
  // is honoured on 429 (see retryAfterMs). TODO: the 1500/4000 values
  // have no measured basis — verify against real timings.
  const delays = [1500, 4000];
  let resp = null, lastErr = null;
  let consecutive429 = 0, timeoutRetries = 0, networkRetries = 0, retries408 = 0;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const remaining = remainingMs(deadlineAt);
    if (remaining <= 0) { lastErr = lastErr || new Error('google translate: translate timed out'); break; }
    try {
      // Per-attempt timeout: min(remaining, 15000) ms, mirroring
      // lmStudioFetch — one hung attempt never consumes the failover budget.
      resp = await fetchAttempt(url, {}, signal, Math.min(remaining, 15000));
    } catch (e) {
      // Cancelled: don't burn the retry backoff on an aborted request —
      // surface the quiet 'cancelled' shape the pipeline expects.
      if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
      if (e && e.timedOut) {
        // Per-attempt timeout: retry once, then fail over.
        lastErr = new Error('google translate: attempt timed out after 15s');
        resp = null;
        if (timeoutRetries >= 1) break;
        timeoutRetries++;
        continue;
      }
      if (e && e.name === 'TypeError') {
        // CORS/permission never clears on retry — fail over at once.
        if (isCorsTypeError(e)) {
          throw new Error('google translate: blocked by browser permissions (CORS/host permission)');
        }
        // Other network errors: one retry after 1.5s (transient), then fail over.
        lastErr = new Error(`google translate: network error (${classifyTypeError(e)}) — ${String(e.message || e).slice(0, 120)}`);
        resp = null;
        if (networkRetries >= 1) break;
        networkRetries++;
        const rem = remainingMs(deadlineAt);
        if (rem <= 0) break;
        tlog(`translate retry google attempt ${attempt + 1}/${delays.length} status=network wait=1500ms`);
        await sleepAbortable(Math.min(1500, rem), signal);
        continue;
      }
      lastErr = e;
      resp = null;
    }
    if (resp && resp.ok) break;
    if (resp && resp.redirected) {
      throw new Error(`google translate: redirected to ${resp.url}`);
    }
    if (resp) logRateLimitHeaders(resp, 'google');
    const status = resp ? resp.status : null;
    if (status === 429) {
      consecutive429++;
      if (consecutive429 >= 2) {
        tlog('gtx 429, no Retry-After (expected) — second 429 in a row, failing over at once');
        break;
      }
      const ra = retryAfterMs(resp);
      if (ra == null) tlog('gtx 429, no Retry-After (expected)');
    } else {
      consecutive429 = 0;
    }
    if (status === 408) {
      // 408 like 503: retry once after the fixed delay, then fail over.
      tlog('translate retry google: HTTP 408 Request Timeout');
      if (retries408 >= 1) break;
      retries408++;
    }
    const retryable = !resp || status === 429 || status === 408 || status >= 500;
    if (!retryable || attempt === delays.length) break;
    // Retry-After first: on a 429 the server tells us how long to wait.
    // Use its number (no jitter — it is the server's own instruction).
    // Longer than RETRY_AFTER_MAX_MS means the backend is down for a
    // while, so break out at once and let the caller fail over to Google
    // instead of burning the budget waiting.
    let wait;
    if (resp && resp.status === 429) {
      const ra = retryAfterMs(resp);
      if (ra != null && ra > RETRY_AFTER_MAX_MS) {
        typeof tlog === 'function' && tlog(`translate retry google: Retry-After ${Math.round(ra)}ms too long, failing over instead of waiting`);
        break;
      }
      if (ra != null) wait = ra;
    }
    if (wait == null) {
      // Jitter (0–800ms, random) spreads simultaneous retries so lanes
      // don't re-hit the endpoint in lockstep. 800ms is an arbitrary
      // spread, not a measured value — verify.
      wait = delays[attempt] + Math.random() * 800;
    }
    // Cap the backoff at the remaining budget; nothing left means fail
    // over at once instead of sleeping.
    const rem = remainingMs(deadlineAt);
    if (rem <= 0) break;
    wait = Math.min(wait, rem);
    typeof tlog === 'function' && tlog(`translate retry google attempt ${attempt + 1}/${delays.length} status=${resp ? resp.status : 'network'} wait=${Math.round(wait)}ms`);
    await sleepAbortable(wait, signal);
    resp = null;
  }
  if (!resp) throw lastErr || new Error('google translate: network error — no response');
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const slice = body.slice(0, 160);
    if (resp.status === 429) {
      throw new Error(`google translate: HTTP 429 after retries (unofficial endpoint — Google is rate-limiting right now; wait a few minutes)${slice ? ' — ' + slice : ''}`);
    }
    if (resp.status >= 500) {
      throw new Error(`google translate: HTTP ${resp.status} after retries (server error)${slice ? ' — ' + slice : ''}`);
    }
    const mapped = mapHttpStatus(resp.status, 'google translate');
    throw new Error(`${mapped || `google translate: HTTP ${resp.status} after retries`}${slice ? ' — ' + slice : ''}`);
  }
  const data = await readJsonChecked(resp, 'google translate');
  // 2.2.12: a valid JSON non-array (e.g. an error object) used to yield
  // '' silently — an empty translation with no error and no failover.
  // Throw so the caller fails over to the next backend instead.
  if (!Array.isArray(data)) throw new Error('google translate: unexpected response (not an array) — ' + JSON.stringify(data).slice(0, 120));
  // An empty data[0] is an empty reply, not a translation — never return
  // '' for a non-empty source.
  if (!Array.isArray(data[0]) || data[0].length === 0) throw new Error('google translate: empty reply');
  return (data[0].map(seg => (seg && seg[0]) || '').join(''));
}

function azureLang(code) {
  // Same language, different code per backend (Google-style -> Azure).
  // ku is a semantic trap: Google's ku is Kurmanji, Azure's ku is Central
  // Kurdish (Sorani) — the mapping is mandatory, not cosmetic.
  // Source of truth for the 114 codes: TARGET_LANGS in shared/settings.js.
  // Verified against https://learn.microsoft.com/en-us/azure/ai-services/translator/language-support
  const m = {
    'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant',
    pt: 'pt-pt', 'pt-BR': 'pt', 'pt-PT': 'pt-pt', 'fr-CA': 'fr-ca',
    sr: 'sr-Cyrl', mn: 'mn-Cyrl',
    ny: 'nya', lg: 'lug', rn: 'run',
    ku: 'kmr', ckb: 'ku',
  };
  const mapped = m[code] || code;
  // Safety net: if TARGET_LANGS gains a code Azure doesn't support, fail
  // fast with a clear message instead of sending a bad code (HTTP 400).
  if (!AZURE_SUPPORTED.has(mapped.toLowerCase())) {
    throw new Error(`Azure Translator does not support language "${code}" — pick Google or LM Studio for this target`);
  }
  return mapped;
}

// Azure Cloud Text-translation codes (lowercased). All 114 TARGET_LANGS
// codes map into this set via azureLang() above.
const AZURE_SUPPORTED = new Set(
  ('af sq am ar hy as az bn ba eu bho bs bg yue ca zh-Hans zh-Hant sn hr cs da ' +
   'dv doi nl en et fj fil fi fr fr-ca gl ka de el gu ht ha he hi hu is ig id ' +
   'ga it ja kn kk km rw gom ko ku kmr ky lo lv lt ln lug mk mai mg ms ml mt ' +
   'mi mr mn-Cyrl mn-Mong my ne nb nya or ps fa pl pt pt-pt pa ro run ru sm ' +
   'sr-Cyrl sr-Latn st nso tn sd si sk sl so es sw sv ta tt te th ti tr tk uk ' +
   'ur ug uz vi cy xh yo zu').toLowerCase().split(' ')
);

async function azure(texts, settings, signal, deadlineAt) {
  const key = (settings.azureKey || '').trim();
  const region = (settings.azureRegion || '').trim();
  if (!key) throw new Error('azure translator: API key not set — add it in Settings');
  if (!region) throw new Error('azure translator: region not set — add it in Settings');
  const to = azureLang(settings.targetLang);
  // Send the source language when the user picked one: without `from`,
  // Azure auto-detects, and short manga fragments (sound effects, 2–3
  // kana) are exactly what auto-detect gets wrong. 'auto' stays omitted —
  // that is the correct call then. azureLang() also maps the zh codes
  // (zh-CN -> zh-Hans, zh-TW -> zh-Hant), same as for the target.
  const from = settings.sourceLang && settings.sourceLang !== 'auto'
    ? azureLang(settings.sourceLang) : null;
  // The 25-text batches used to run one at a time; now 3 batches fly in
  // parallel (official paid API — no rate-limit gentleness needed).
  const batches = [];
  for (let i = 0; i < texts.length; i += 25) batches.push(texts.slice(i, i + 25));
  const out = new Array(batches.length);
  let next = 0;
  async function lane() {
    for (;;) {
      const bi = next++;
      if (bi >= batches.length) return;
      out[bi] = await azureBatch(batches[bi], key, region, to, from, signal, deadlineAt);
    }
  }
  const lanes = [];
  for (let k = 0; k < Math.min(3, batches.length); k++) lanes.push(lane());
  await Promise.all(lanes);

  async function azureBatch(batch, key, region, to, from, signal, deadlineAt) {
    const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(to)}` +
      (from ? `&from=${encodeURIComponent(from)}` : '');
    // Like the Google path: one throttled batch (429/5xx) must not kill the
    // whole page. Retry with exponential backoff + jitter.
    // 3 tries only (James 2026-11-26 — the old 10s third delay is gone):
    // waits are 1500+4000 = 5.5s max, plus jitter (~7.1s). Every backoff
    // is capped at the remaining budget, like lmStudioFetch
    // (Math.min(wait, remaining)); when nothing remains the loop breaks
    // out and fails over instead of sleeping. Retry-After is honoured on
    // 429 (see retryAfterMs; retry-after-ms is read too). TODO: the
    // 1500/4000 values are copied verbatim from Google with no
    // Azure-specific basis — verify.
    // One X-ClientTraceId per batch across retries, so Microsoft can
    // correlate the attempts (it used to be regenerated per attempt).
    const traceId = crypto.randomUUID();
    const delays = [1500, 4000];
    let resp = null, lastErr = null;
    let timeoutRetries = 0, networkRetries = 0, retries408 = 0, retried401 = false;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      const remaining = remainingMs(deadlineAt);
      if (remaining <= 0) { lastErr = lastErr || new Error('azure translator: translate timed out'); break; }
      try {
        resp = await fetchAttempt(url, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': key,
            'Ocp-Apim-Subscription-Region': region,
            'Content-type': 'application/json',
            'X-ClientTraceId': traceId,
          },
          body: JSON.stringify(batch.map(t => ({ text: t }))),
        }, signal, Math.min(remaining, 15000));
      } catch (e) {
        if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
        if (e && e.timedOut) {
          lastErr = new Error('azure translator: attempt timed out after 15s');
          resp = null;
          if (timeoutRetries >= 1) break;
          timeoutRetries++;
          continue;
        }
        if (e && e.name === 'TypeError') {
          if (isCorsTypeError(e)) {
            throw new Error('azure translator: blocked by browser permissions (CORS/host permission)');
          }
          lastErr = new Error(`azure translator: network error (${classifyTypeError(e)}) — ${String(e.message || e).slice(0, 120)}`);
          resp = null;
          if (networkRetries >= 1) break;
          networkRetries++;
          const rem = remainingMs(deadlineAt);
          if (rem <= 0) break;
          tlog(`translate retry azure attempt ${attempt + 1}/${delays.length} status=network wait=1500ms`);
          await sleepAbortable(Math.min(1500, rem), signal);
          continue;
        }
        lastErr = e;
        resp = null;
      }
      if (resp && resp.ok) break;
      if (resp && resp.redirected) {
        throw new Error(`azure translator: redirected to ${resp.url}`);
      }
      if (resp) {
        logRateLimitHeaders(resp, 'azure');
        // 401001 on a new token is transient (Microsoft Q&A): retry once
        // after ~2s; a second 401 is a genuinely bad key.
        if (resp.status === 401 && !retried401) {
          retried401 = true;
          const rem = remainingMs(deadlineAt);
          if (rem <= 0) break;
          tlog('translate retry azure: 401 once after 2s (transient 401001 on a new token)');
          await sleepAbortable(Math.min(2000, rem), signal);
          resp = null;
          continue;
        }
        // 403 trial quota exhausted: never retry, fail over at once.
        if (resp.status === 403) {
          const bodyPeek = await resp.text().catch(() => '');
          const parsed = parseErrorBody(bodyPeek);
          if (parsed.code && /^403/.test(parsed.code)) {
            throw new Error(`azure translator: Azure free/trial translations used up (403)${parsed.message ? ' — ' + parsed.message.slice(0, 160) : ''}`);
          }
          // Body already consumed: keep the parsed message for the throw below.
          resp._bodyText = bodyPeek;
        }
      }
      if (resp && resp.status === 408) {
        tlog('translate retry azure: HTTP 408 Request Timeout');
        if (retries408 >= 1) break;
        retries408++;
      }
      const retryable = !resp || resp.status === 429 || resp.status === 408 || resp.status >= 500;
      if (!retryable || attempt === delays.length) break;
      // Retry-After first (see googleOne): on a 429 use the server's own
      // wait; longer than RETRY_AFTER_MAX_MS means break out and fail over
      // to Google instead of burning the budget waiting. retry-after-ms
      // is read too (retryAfterMsAny) — whichever is present wins.
      let wait;
      if (resp && resp.status === 429) {
        const ra = retryAfterMsAny(resp);
        if (ra != null && ra > RETRY_AFTER_MAX_MS) {
          typeof tlog === 'function' && tlog(`translate retry azure: Retry-After ${Math.round(ra)}ms too long, failing over instead of waiting`);
          break;
        }
        if (ra != null) wait = ra;
      }
      if (wait == null) wait = delays[attempt] + Math.random() * 800;
      const rem = remainingMs(deadlineAt);
      if (rem <= 0) break;
      wait = Math.min(wait, rem);
      typeof tlog === 'function' && tlog(`translate retry azure attempt ${attempt + 1}/${delays.length} status=${resp ? resp.status : 'network'} wait=${Math.round(wait)}ms`);
      await sleepAbortable(wait, signal);
      resp = null;
    }
    if (!resp) throw lastErr || new Error('azure translator: network error — no response');
    if (!resp.ok) {
      const reqId = requestIdOf(resp);
      const body = resp._bodyText != null ? resp._bodyText : await resp.text().catch(() => '');
      const parsed = parseErrorBody(body);
      const slice = (parsed.message || body).slice(0, 160);
      if (resp.status === 401) {
        throw new Error(`azure translator: Azure key not accepted (401) — check key/region in Settings${parsed.code ? ` (code ${parsed.code})` : ''}`);
      }
      if (resp.status === 403 && parsed.code && /^403/.test(parsed.code)) {
        throw new Error(`azure translator: Azure free/trial translations used up (403)${slice ? ' — ' + slice : ''}`);
      }
      const mapped = mapHttpStatus(resp.status, 'azure translator');
      const suffix = [slice, reqId ? `X-RequestId ${reqId}` : null].filter(Boolean).join(' ');
      if (resp.status >= 500 && reqId) tlog(`azure 500/503 X-RequestId=${reqId} X-ClientTraceId=${traceId}`);
      throw new Error(`${mapped || `azure translator: HTTP ${resp.status} after retries`}${parsed.code ? ` (code ${parsed.code})` : ''}${suffix ? ' — ' + suffix : ''}`);
    }
    const data = await readJsonChecked(resp, 'azure translator');
    // 2.2.12: validate the reply length matches the batch. The old code
    // built `r` from whatever Azure returned — if Azure returned fewer
    // translations than the batch, the tail blocks silently got ''.
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new Error(`azure translator: reply has ${Array.isArray(data) ? data.length : 'non-array'} translations for a batch of ${batch.length}`);
    }
    const r = [];
    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      if (d && typeof d === 'object' && d.error) {
        const em = d.error.message || d.error.code || '';
        throw new Error(`azure translator: error for item ${i + 1} of ${data.length}${em ? ' — ' + String(em).slice(0, 160) : ''}`);
      }
      const text = d && typeof d === 'object' && Array.isArray(d.translations) && d.translations[0] && typeof d.translations[0].text === 'string'
        ? d.translations[0].text : null;
      if (text == null) {
        throw new Error(`azure translator: empty translation for item ${i + 1} of ${data.length}`);
      }
      r.push(text);
    }
    return r;
  }

  return out.flat();
}

// Gemini (Google AI Studio, free tier): gemini-3.5-flash-lite, 500 requests
// a day. One batched request for all texts — the same JSON-array contract as
// LM Studio, so entries stay aligned. The prompt is the manga-aware one
// proven in the 2026-11-21 six-line test (3.5-flash-lite: 1 right, 5 half,
// 0 wrong; it reads sound effects as sounds, never as names). 3.6-flash
// scored better (3 right, 3 half) but its free tier is 20 requests a day,
// so it cannot serve the extension.
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// The prompt, exported so the harness can check it. `texts` ride as a JSON
// array (OCR text can contain newlines/quotes, so line-based framing would
// shift entries) and the model must answer with a JSON array of the same
// length, in the same order.
export function geminiPrompt(texts, settings) {
  const n = texts.length;
  const from = settings.sourceLang && settings.sourceLang !== 'auto'
    ? ' from ' + langName(settings.sourceLang) : '';
  const to = langName(settings.targetLang);
  const srcName = settings.sourceLang && settings.sourceLang !== 'auto'
    ? langName(settings.sourceLang) : 'source-language';
  return 'Translate the following ' + n + ' manga text(s)' + from + ' to ' + to +
    '. These are dialogue and sound effects from a manga. ' +
    'Translate sound effects as ' + to + ' onomatopoeia that match the sound. ' +
    'Panting and gasping are heavy breathing, not laughing. ' +
    'Reply with ONLY a JSON array of ' + n +
    ' translated strings, in the same order, no explanations, no code fences. ' +
    'Output entirely in ' + to + '. ' +
    'Do not leave any ' + srcName + ' characters, kana, or romanization in the output.' +
    '\n' + JSON.stringify(texts);
}

// Parse a generateContent reply body into the N translations. The model
// answer is a string that may itself be JSON, may be code-fenced, or may
// carry prose — so the array is extracted with the same brace-balance scan
// as the LM Studio path. A length mismatch is an error, never a zip:
// silently pairing the wrong strings paints plausible nonsense into
// speech bubbles.
export function parseGeminiBody(bodyText, expected) {
  const text = bodyText === null || bodyText === undefined ? '' : String(bodyText);
  if (!text.trim()) {
    throw new Error('Gemini reply was empty.');
  }
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  if (data !== null) {
    // An error envelope ({error:{code,message,status,details}}) is
    // surfaced first, before the candidates logic — otherwise its
    // message is lost behind "no text" / "not a JSON array".
    if (data.error && typeof data.error === 'object') {
      const e = data.error;
      const retry = Array.isArray(e.details)
        ? e.details.find(d => d && d['@type'] === 'google.rpc.RetryInfo' && d.retryDelay) : null;
      throw new Error(`gemini: ${e.status || e.code || ''} ${e.message || ''}`.trim() +
        (retry ? ` (retry after ${retry.retryDelay})` : ''));
    }
    // A bare JSON array is the answer itself.
    if (Array.isArray(data)) return geminiNormalizeTranslations(data, expected);
    // A generateContent envelope: pull the model's text out of it.
    const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    const answer = Array.isArray(parts)
      ? parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('')
      : null;
    if (answer === null || answer.trim() === '') {
      const cand = data.candidates && data.candidates[0];
      const why = (cand && cand.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason) || '';
      // Map the reason: SAFETY/RECITATION is a block (fail over at
      // once); MAX_TOKENS is a reply that was cut off (do not retry the
      // same prompt). The raw reason stays in the message for the log.
      if (why === 'SAFETY' || why === 'RECITATION') {
        throw new Error(`Gemini blocked this content (${why}).`);
      }
      if (why === 'MAX_TOKENS') {
        throw new Error(`Gemini reply too long (${why}) — failing over.`);
      }
      throw new Error('Gemini returned no text' + (why ? ` (${why})` : '') + '.');
    }
    try {
      const parsed = JSON.parse(answer);
      if (Array.isArray(parsed)) return geminiNormalizeTranslations(parsed, expected);
    } catch { /* fall through to the scan */ }
    const found = lmExtractJsonArray(answer, expected);
    if (found && Array.isArray(found.parsed)) return geminiNormalizeTranslations(found.parsed, expected);
    throw new Error('Gemini reply was not a JSON array of ' + expected + ' translated strings.');
  }
  // Not JSON at all: a raw completion that wrapped the array in prose or a
  // code fence.
  const found = lmExtractJsonArray(text, expected);
  if (found && Array.isArray(found.parsed)) return geminiNormalizeTranslations(found.parsed, expected);
  throw new Error('Gemini reply was not valid JSON. Expected a JSON array of ' + expected + ' translated strings.');
}

function geminiNormalizeTranslations(list, expected) {
  if (!Array.isArray(list)) {
    throw new Error('Gemini reply has no translations array. Expected a JSON array of ' + expected + ' translated strings.');
  }
  if (typeof expected === 'number' && list.length !== expected) {
    throw new Error('Gemini returned ' + list.length + ' translation(s) for ' + expected +
      ' source line(s) — refusing to pair them, because shifted entries would paint the wrong text into the wrong bubble.');
  }
  return list.map(v => (v === null || v === undefined ? '' : String(v)));
}

async function gemini(texts, settings, signal, deadlineAt) {
  const key = (settings.geminiApiKey || '').trim();
  if (!key) throw new Error('gemini: API key not set — add it in Settings');
  const body = JSON.stringify({
    contents: [{ parts: [{ text: geminiPrompt(texts, settings) }] }],
    generationConfig: { temperature: 0 },
  });
  // Like the Google/Azure paths: one throttled call (429/5xx) must not kill
  // the whole page. Retry with exponential backoff + jitter. 4xx are client
  // errors (bad key, unknown model) and are not retried.
  // 3 tries only (James 2026-11-26 — the old 10s third delay is gone):
  // waits are 1500+4000 = 5.5s max, plus jitter (~7.1s). Every backoff
  // is capped at the remaining budget, like lmStudioFetch
  // (Math.min(wait, remaining)); when nothing remains the loop breaks
  // out and fails over instead of sleeping. TODO: the 1500/4000 values
  // are copied verbatim from Google with no Gemini-specific basis — verify.
  // Gemini's 429 wait lives in the BODY (details[].RetryInfo.retryDelay
  // and the "Please retry in Ns" tail), not the Retry-After header — the
  // header is read too, and the largest wait wins (capped at 4000ms).
  const delays = [1500, 4000];
  let resp = null, lastErr = null, lastBodyText = '', lastParsed = null;
  let timeoutRetries = 0, networkRetries = 0, retries408 = 0, retries504 = 0, consecutive503NoRA = 0;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const remaining = remainingMs(deadlineAt);
    if (remaining <= 0) { lastErr = lastErr || new Error('gemini: translate timed out'); break; }
    try {
      resp = await fetchAttempt(GEMINI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body,
      }, signal, Math.min(remaining, 15000));
    } catch (e) {
      if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
      if (e && e.timedOut) {
        lastErr = new Error('gemini: attempt timed out after 15s');
        resp = null;
        if (timeoutRetries >= 1) break;
        timeoutRetries++;
        continue;
      }
      if (e && e.name === 'TypeError') {
        if (isCorsTypeError(e)) {
          throw new Error('gemini: blocked by browser permissions (CORS/host permission)');
        }
        lastErr = new Error(`gemini: network error (${classifyTypeError(e)}) — ${String(e.message || e).slice(0, 120)}`);
        resp = null;
        if (networkRetries >= 1) break;
        networkRetries++;
        const rem = remainingMs(deadlineAt);
        if (rem <= 0) break;
        tlog(`translate retry gemini attempt ${attempt + 1}/${delays.length} status=network wait=1500ms`);
        await sleepAbortable(Math.min(1500, rem), signal);
        continue;
      }
      lastErr = e;
      resp = null;
    }
    if (resp && resp.ok) break;
    if (resp && resp.redirected) {
      throw new Error(`gemini: redirected to ${resp.url}`);
    }
    if (resp) logRateLimitHeaders(resp, 'gemini');
    const status = resp ? resp.status : null;
    let wait = null;
    if (resp && !resp.ok) {
      // Read the error body once per attempt: it carries the status,
      // the RetryInfo/QuotaFailure details and the message tail.
      lastBodyText = await resp.text().catch(() => '');
      lastParsed = parseErrorBody(lastBodyText);
      if (status === 429) {
        // Daily quota vs per-minute throttle: QuotaFailure.violations[]
        // quotaId naming …PerDay… (or limit: 0) never clears today.
        let daily = false;
        try {
          const data = JSON.parse(lastBodyText);
          const details = (data && data.error && data.error.details) || [];
          for (const d of details) {
            if (d && d['@type'] === 'google.rpc.QuotaFailure' && Array.isArray(d.violations)) {
              for (const v of d.violations) {
                if (v && /PerDay/i.test(String(v.quotaId || ''))) daily = true;
                if (v && /limit:\s*0\b/.test(String(v.quotaId || '') + ' ' + String(v.quotaValue || ''))) daily = true;
              }
            }
          }
          if (/PerDay/i.test(lastBodyText) && /limit:\s*0/.test(lastBodyText)) daily = true;
        } catch {}
        if (daily) {
          throw new Error('gemini: Gemini daily quota used up (resets midnight Pacific)');
        }
        // Largest of header / body RetryInfo / message tail wins.
        const cands = [retryAfterMs(resp)];
        try {
          const data = JSON.parse(lastBodyText);
          const details = (data && data.error && data.error.details) || [];
          for (const d of details) {
            if (d && d['@type'] === 'google.rpc.RetryInfo' && d.retryDelay) {
              const ms = parseRetryDelaySeconds(d.retryDelay);
              if (ms != null) cands.push(ms);
            }
          }
        } catch {}
        const tail = lastBodyText.match(/Please retry in\s+(\d+(?:\.\d+)?)\s*s/i);
        if (tail) cands.push(Number(tail[1]) * 1000);
        const found = cands.filter(v => v != null);
        if (found.length) {
          wait = Math.max(...found);
          if (wait > RETRY_AFTER_MAX_MS) {
            tlog(`translate retry gemini: retry delay ${Math.round(wait)}ms too long, failing over instead of waiting`);
            break;
          }
        }
      }
      if (status === 504) {
        tlog('translate retry gemini: HTTP 504 DEADLINE_EXCEEDED');
        if (retries504 >= 1) break;
        retries504++;
      }
      if (status === 503) {
        const ra = retryAfterMs(resp);
        if (ra == null) {
          consecutive503NoRA++;
          if (consecutive503NoRA >= 2) {
            tlog('translate retry gemini: second 503 with no Retry-After, failing over at once instead of burning the third try');
            break;
          }
        } else consecutive503NoRA = 0;
      }
      if (status === 408) {
        tlog('translate retry gemini: HTTP 408 Request Timeout');
        if (retries408 >= 1) break;
        retries408++;
      }
    }
    const retryable = !resp || status === 429 || status === 408 || status >= 500;
    if (!retryable || attempt === delays.length) break;
    if (wait == null) wait = delays[attempt] + Math.random() * 800;
    const rem = remainingMs(deadlineAt);
    if (rem <= 0) break;
    wait = Math.min(wait, rem);
    typeof tlog === 'function' && tlog(`translate retry gemini attempt ${attempt + 1}/${delays.length} status=${resp ? resp.status : 'network'} wait=${Math.round(wait)}ms`);
    await sleepAbortable(wait, signal);
    resp = null;
  }
  if (!resp) throw lastErr || new Error('gemini: network error — no response');
  if (!resp.ok) {
    const msg = (lastParsed && lastParsed.message) || '';
    const statusWord = resp.status === 503 ? 'overloaded' : resp.status === 500 ? 'internal' : resp.status === 504 ? 'deadline exceeded' : '';
    if (resp.status === 400 && /token|too long|too large|INVALID_ARGUMENT/i.test(msg)) {
      throw new Error('gemini: prompt too long — failing over');
    }
    if (resp.status === 401 || /API key not valid/i.test(msg)) {
      throw new Error('gemini: Gemini key invalid — check Settings');
    }
    if (resp.status === 404) {
      throw new Error('gemini: model not found — the model ID may be retired, update the extension');
    }
    if (resp.status === 403 && /leaked/i.test(msg)) {
      throw new Error('gemini: key reported leaked, make a new key');
    }
    const mapped = mapHttpStatus(resp.status, 'gemini');
    const slice = (msg || lastBodyText).slice(0, 160);
    throw new Error(`${mapped || `gemini: HTTP ${resp.status} after retries`}${statusWord ? ` (${statusWord})` : ''}${lastParsed && lastParsed.status ? ` (${lastParsed.status})` : ''}${slice ? ' — ' + slice : ''}`);
  }
  const bodyText = await resp.text();
  // usageMetadata (prompt/output tokens) is diagnostic only — log it
  // when the free tier returns it; never fail on its absence.
  try {
    const meta = JSON.parse(bodyText).usageMetadata;
    if (meta) tlog(`gemini usage: promptTokens=${meta.promptTokenCount ?? '?'} outputTokens=${meta.candidatesTokenCount ?? '?'} totalTokens=${meta.totalTokenCount ?? '?'}`);
  } catch {}
  const out = parseGeminiBody(bodyText, texts.length);
  // 2.3.28: Gemini sometimes ignores the prompt and echoes the source
  // language (James, 2026-11-23: Japanese out when the target is
  // Traditional Chinese). A "translation" that is still Japanese is a
  // failure, not a result — throw so translateBlocks fails over to the
  // next backend instead of caching and rendering Japanese as if it
  // were translated. Shared guard (see checkSourceLanguageOutput):
  // kana in the output, identity with the source, or an empty entry
  // for a non-empty source all fail the batch.
  return applySourceLanguageGuard(out, texts, settings, 'gemini');
}


// Probe helper (Settings connection checks): one 10s-timed request, retried
// once on 429/5xx after ~1.5s. An AbortError is a timeout, not "server
// down" — it throws a distinct timed-out error the caller surfaces.
async function probeRequest(makeRequest) {
  let lastErr = null;
  for (let attempt = 0; attempt <= 1; attempt++) {
    if (attempt > 0) await sleep(1500);
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, 10000);
    try {
      const resp = await makeRequest(ctrl.signal);
      if (resp.ok || attempt === 1) return resp;
      if (resp.status === 429 || resp.status >= 500) { lastErr = new Error('HTTP ' + resp.status); continue; }
      return resp;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        const t = new Error('timed out after 10s — server is slow or stuck');
        t.probeTimeout = true;
        throw t;
      }
      lastErr = e;
      if (attempt === 1) throw e;
    } finally { clearTimeout(timer); }
  }
  throw lastErr || new Error('probe failed');
}

// "Rate-limited — try again in <N>s" from a probe response, or null.
function probeRateLimitSeconds(resp, bodyText) {
  const cands = [retryAfterMsAny(resp)];
  try {
    const data = JSON.parse(bodyText || '');
    const details = (data && data.error && data.error.details) || [];
    for (const d of details) {
      if (d && d['@type'] === 'google.rpc.RetryInfo' && d.retryDelay) {
        const ms = parseRetryDelaySeconds(d.retryDelay);
        if (ms != null) cands.push(ms);
      }
    }
  } catch {}
  const tail = String(bodyText || '').match(/Please retry in\s+(\d+(?:\.\d+)?)\s*s/i);
  if (tail) cands.push(Number(tail[1]) * 1000);
  const found = cands.filter(v => v != null);
  if (!found.length) return null;
  return Math.max(1, Math.ceil(Math.max(...found) / 1000));
}

export async function checkGemini(settings) {
  const key = (settings.geminiApiKey || '').trim();
  if (!key) return { ok: false, error: 'API key not set' };
  try {
    // Minimal real call: one tiny generation. A 200 proves key+network.
    // 10s timeout (probeRequest): fetch() has no built-in timeout, so a
    // timer + AbortController is the only bound. 10s is an app-chosen UX
    // bound (a one-word probe should answer in ~1s), not a server SLA.
    const resp = await probeRequest((signal) => fetch(GEMINI_API_URL, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Say OK.' }] }],
        generationConfig: { temperature: 0 },
      }),
    }));
    const bodyText = await resp.text().catch(() => '');
    if (!resp.ok) {
      const parsed = parseErrorBody(bodyText);
      if (resp.status === 429) {
        const secs = probeRateLimitSeconds(resp, bodyText);
        return { ok: false, error: secs != null ? `Rate-limited — try again in ${secs}s` : 'Rate-limited — try again shortly' };
      }
      if (resp.status === 401 || /API key not valid/i.test(parsed.message || '')) return { ok: false, error: 'Gemini key invalid — check Settings' };
      if (resp.status === 404) return { ok: false, error: 'model not found — the model ID may be retired, update the extension' };
      if (resp.status === 403 && /leaked/i.test(parsed.message || '')) return { ok: false, error: 'key reported leaked, make a new key' };
      const mapped = mapHttpStatus(resp.status, 'gemini');
      return { ok: false, error: `${mapped || `HTTP ${resp.status}`}${parsed.message ? ' — ' + parsed.message.slice(0, 120) : bodyText ? ' — ' + bodyText.slice(0, 120) : ''}` };
    }
    // Validate the 200 body: a 200 with no candidates is not "connected".
    let hasText = false;
    try {
      const data = JSON.parse(bodyText);
      if (data && data.error) return { ok: false, error: `gemini: ${data.error.status || ''} ${data.error.message || ''}`.trim() };
      const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      hasText = Array.isArray(parts) && parts.some(p => p && typeof p.text === 'string' && p.text.trim());
    } catch { hasText = false; }
    if (!hasText) return { ok: false, error: 'connected, but the reply had no text (no candidates) — try again' };
    return { ok: true, detail: 'connected — key accepted' };
  } catch (e) {
    if (e && e.probeTimeout) return { ok: false, error: e.message };
    return { ok: false, error: 'network error — ' + String(e).slice(0, 120) };
  }
}

function lmStudioBase(settings) {
  return (settings.lmStudioUrl || 'http://127.0.0.1:1234').replace(/\/+$/, '');
}

// Which server API the user points at. The two flavours differ in path,
// request shape and reply envelope:
// 'openai': POST <url>/chat/completions with {messages, temperature, ...},
//   reply {choices:[{message:{content}}]}. LM Studio mounts this under /v1,
//   so a bare host:port URL gets /v1 added; a URL that already carries a path
//   is left alone (a non-LM-Studio server with its own mount point).
// 'lmstudio-v1': POST <server-root>/api/v1/chat with {model, input},
//   reply {output:[{type:"reasoning"|"message", content}]}. `model` is required,
//   so it is auto-detected from /api/v1/models (the /v1 prefix the URL field
//   carries is the OpenAI-compat mount; the native REST API lives at the
//   server root, so it is stripped).
function lmStudioEndpoints(settings) {
  const url = lmStudioBase(settings);
  if ((settings.lmStudioApi || 'lmstudio-v1') === 'lmstudio-v1') {
    const root = url.replace(/\/v1$/, '');
    return { chat: root + '/api/v1/chat', models: root + '/api/v1/models', label: 'LM Studio REST API v1', flavor: 'lmstudio-v1' };
  }
  const afterHost = url.replace(/^https?:\/\/[^/]+/i, '');
  const base = afterHost === '' ? url + '/v1' : url;
  return { chat: base + '/chat/completions', models: base + '/models', label: 'OpenAI-compatible', flavor: 'openai' };
}

// The native v1 API requires a `model` id on every chat request, but the
// translation flow must not interrogate the server first — it just asks the
// running model to translate. So the loaded model is learned once (from the
// connection check, or lazily on the first translation) and remembered in
// settings; later translations send a single POST. If the remembered model
// is gone (unloaded/swapped in LM Studio), the caller rediscovers once and
// retries. Prefers the native v1 shape (key + loaded_instances), falls back
// to older {id, state} shapes.
async function lmStudioDiscoverModel(ep, headers, signal, deadlineMs) {
  await ensureLmStudioHostAccess(ep.models);
  let resp;
  try {
    resp = await lmStudioFetch(ep.models, { headers }, signal, 'model discovery', deadlineMs);
  } catch (e) {
    if (e && e.cancelled) throw e;
    throw new Error('LM Studio: cannot reach ' + ep.models + ' — is the server running?');
  }
  if (!resp.ok) throw new Error(`LM Studio: HTTP ${resp.status} from ${ep.models}`);
  // A garbled (non-JSON) models reply is not "no model loaded" — the
  // server answered, but its reply cannot be read.
  const modelsText = await resp.text().catch(() => '');
  let data;
  try { data = JSON.parse(modelsText); } catch {
    throw new Error('LM Studio: models reply was not JSON (server answered, but garbled)');
  }
  const models = (data && (data.data || data.models)) || [];
  const loaded = models.find(m => m && Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0 && (m.key || m.id))
    || models.find(m => m && m.state === 'loaded' && (m.key || m.id));
  // No loaded model: say so plainly rather than JIT-loading some arbitrary
  // downloaded model the user didn't ask for.
  if (!loaded) throw new Error('LM Studio: no model is loaded — load one in LM Studio first, then translate again');
  const id = loaded.key || loaded.id;
  try {
    await updateSettingsField('lmStudioModelId', id);
  } catch { /* remembering is best-effort; the id is still returned */ }
  return id;
}

// LM Studio's OpenAI-compatible server (user hosts the model themselves).
// One batched request for all texts. The prompt follows the contract from
// jameslee0623/ComicTranslate (src/background/lensLocalEngine.js): the
// instruction is the first line, outside any JSON, then the source strings as
// a JSON array (OCR text can contain newlines/quotes, so line-based framing
// would shift entries). `texts`/`target`/`source` ride along for chat servers
// that are actually dedicated translators; a general LLM ignores them and
// obeys the prompt. temperature 0: a re-read of the same page must give the
// same translation.
function lmStudioPrompt(texts, settings) {
  const n = texts.length;
  // 'auto' is not a language: with the default source setting the prompt
  // used to say "from auto", which is nonsense to the model. Omit the
  // source clause then; the model detects it from the text.
  const from = settings.sourceLang && settings.sourceLang !== 'auto'
    ? ' from ' + langName(settings.sourceLang) : '';
  const to = langName(settings.targetLang);
  return 'Translate the following ' + n + ' text(s)' + from + ' to ' + to +
    '. Reply with ONLY a JSON array of ' + n +
    ' translated strings, in the same order, no explanations, no code fences.' +
    ' Do not analyse the text and do not think step by step: output the array' +
    ' itself as your very first characters, then stop.' +
    '\n' + JSON.stringify(texts);
}

// Map an LM Studio HTTP status to a plain message. 404/401 are the
// common local-server failures (model not loaded / route wrong / key).
function lmHttpError(status, bodyText) {
  if (status === 404) return `LM Studio: model not loaded / route not found (HTTP 404) — ${bodyText.slice(0, 160) || 'check the server URL'}`;
  if (status === 401) return `LM Studio: key rejected (HTTP 401) — ${bodyText.slice(0, 160) || 'check the server key'}`;
  return `LM Studio: HTTP ${status} — ${bodyText.slice(0, 160) || 'check the server URL'}`;
}

async function lmStudio(texts, settings, signal, deadlineMs) {
  const ep = lmStudioEndpoints(settings);
  await ensureLmStudioHostAccess(ep.chat);
  const headers = { 'Content-Type': 'application/json' };
  if ((settings.lmStudioKey || '').trim()) headers['Authorization'] = 'Bearer ' + settings.lmStudioKey.trim();
  if (ep.flavor === 'lmstudio-v1') return lmStudioV1(texts, settings, ep, headers, signal, deadlineMs);
  const body = {
    messages: [{ role: 'user', content: lmStudioPrompt(texts, settings) }],
    temperature: 0,
    texts,
    target: settings.targetLang,
  };
  if (settings.sourceLang && settings.sourceLang !== 'auto') body.source = settings.sourceLang;
  let resp;
  try {
    resp = await lmStudioFetch(ep.chat, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, signal, 'chat', deadlineMs);
  } catch (e) {
    if (e && e.cancelled) throw e;
    throw new Error('LM Studio: cannot reach ' + ep.chat + ' (' + ep.label + ') — is the server running? (' + String(e).slice(0, 100) + ')');
  }
  // Read as text, not res.json(): the reply is not reliably JSON, an error
  // status carries the real reason in its body, and json() consumes the stream
  // even when the parse then throws.
  let bodyText = await resp.text().catch(() => '');
  if (!resp.ok && resp.status === 404) {
    // One-shot rediscover, like the v1 flavour: the model may have been
    // swapped/unloaded since the id was remembered. Retry once, then fail.
    try { await lmStudioDiscoverModel(ep, headers, signal, deadlineMs); } catch {}
    try {
      resp = await lmStudioFetch(ep.chat, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }, signal, 'chat', deadlineMs);
      bodyText = await resp.text().catch(() => '');
    } catch (e) {
      if (e && e.cancelled) throw e;
      throw new Error('LM Studio: cannot reach ' + ep.chat + ' (' + ep.label + ') — is the server running? (' + String(e).slice(0, 100) + ')');
    }
  }
  if (!resp.ok) {
    throw new Error(lmHttpError(resp.status, bodyText));
  }
  return applySourceLanguageGuard(parseLmStudioBody(bodyText, texts.length), texts, settings, 'LM Studio');
}

// Native REST API v1 translation: one POST per page, {model, input,
// temperature}. The model id is the remembered one when we have it; learned
// once when we don't; re-learned once if the remembered one fails (the user
// may have swapped models in LM Studio since).
async function lmStudioV1(texts, settings, ep, headers, signal, deadlineMs) {
  const input = lmStudioPrompt(texts, settings);
  const post = async (modelId) => {
    try {
      return await lmStudioFetch(ep.chat, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: modelId, input, temperature: 0 }),
      }, signal, 'v1 chat', deadlineMs);
    } catch (e) {
      if (e && e.cancelled) throw e;
      throw new Error('LM Studio: cannot reach ' + ep.chat + ' — is the server running? (' + String(e).slice(0, 100) + ')');
    }
  };
  const fail = async (resp) => {
    const t = await resp.text().catch(() => '');
    throw new Error(lmHttpError(resp.status, t));
  };
  const n = texts.length;
  let modelId = settings.lmStudioModelId;
  if (!modelId) {
    const resp = await post(await lmStudioDiscoverModel(ep, headers, signal, deadlineMs));
    if (!resp.ok) await fail(resp);
    return applySourceLanguageGuard(parseLmStudioBody(await resp.text(), n), texts, settings, 'LM Studio');
  }
  let resp = await post(modelId);
  if (!resp.ok) {
    resp = await post(await lmStudioDiscoverModel(ep, headers, signal, deadlineMs));
    if (!resp.ok) await fail(resp);
  }
  return applySourceLanguageGuard(parseLmStudioBody(await resp.text(), n), texts, settings, 'LM Studio');
}

// --- LM Studio reply parsing (ported from lensLocalEngine.js in the author's own
// project jameslee0623/ComicTranslate — no third-party license obligation)
// Index alignment is the whole contract: entry i translates region i. A length
// mismatch is an error, never a zip — silently pairing the wrong strings
// paints plausible nonsense into speech bubbles.

// Brace-balance scan for a [...] window that JSON.parses. A regex cannot do
// this: quoted strings are skipped (brackets inside text must not throw the
// depth count) and escapes are honoured. Of several parseable windows the LAST
// one with exactly `expected` entries wins — a reasoning model repeats its
// draft and then restates the final version. Without a count the longest
// parseable window wins.
function lmExtractJsonArray(raw, expected) {
  let best = null, exact = null;
  const counted = typeof expected === 'number' && expected >= 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '[') continue;
    let depth = 0, inString = false, escaped = false;
    for (let j = i; j < raw.length; j++) {
      const c = raw[j];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (c === '\\') { escaped = true; continue; }
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) {
          const candidate = raw.slice(i, j + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (counted && Array.isArray(parsed) && parsed.length === expected) {
              exact = { candidate, parsed };
            } else if (!best || candidate.length > best.candidate.length) {
              best = { candidate, parsed };
            }
          } catch { /* this window is prose, keep scanning */ }
          break;
        }
      }
    }
  }
  return exact || best;
}

// Pull the assistant's ANSWER out of a chat envelope, or null when this is
// not one. Reasoning models (Qwen3, Gemma, DeepSeek-R1, ...) carry two pieces
// of text: the reasoning half quotes the input back — including the ORIGINAL
// JSON array of source strings — so scanning the whole body for an array would
// find the untranslated original first. Only the answer half is a candidate.
function lmUnwrapAssistantText(data) {
  if (!data || typeof data !== 'object') return null;
  // LM Studio native: keep only the answer items, never the reasoning ones.
  if (Array.isArray(data.output)) {
    const parts = data.output
      .filter(o => o && (o.type === 'message' || o.type === 'text'))
      .map(o => String(o.content === undefined ? '' : o.content));
    return parts.length ? parts.join('\n') : null;
  }
  // OpenAI-compatible.
  if (Array.isArray(data.choices) && data.choices.length) {
    const msg = data.choices[0] && data.choices[0].message;
    if (msg && typeof msg.content === 'string' && msg.content.trim()) return msg.content;
    return null;
  }
  // Ollama.
  if (data.message && typeof data.message.content === 'string' && data.message.content.trim()) {
    return data.message.content;
  }
  return null;
}

// The model's SCRATCH text when the server split it out of the answer, or
// null. LM Studio can return HTTP 200 with an empty message.content and the
// whole reply in reasoning_content (LM Studio bug #1602) — the work is done,
// so it is recovered, but ONLY via an array of exactly `expected` entries:
// reading this field without a count could paint the quoted-back source text
// over every bubble.
function lmReasoningText(data) {
  if (!data || typeof data !== 'object') return null;
  const boxes = [];
  if (Array.isArray(data.choices) && data.choices.length) boxes.push(data.choices[0] && data.choices[0].message);
  boxes.push(data.message, data);
  for (const box of boxes) {
    if (!box || typeof box !== 'object') continue;
    for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
      if (typeof box[key] === 'string' && box[key].trim()) return box[key];
    }
  }
  if (Array.isArray(data.output)) {
    const parts = data.output
      .filter(o => o && o.type === 'reasoning')
      .map(o => String(o.content === undefined ? '' : o.content));
    if (parts.length && parts.join('').trim()) return parts.join('\n');
  }
  return null;
}

// The server's own error text, when it reported one in a body. LM Studio
// answers an unknown route with HTTP 200 and {"error":"Unexpected endpoint or
// method. ..."} — surfacing it verbatim beats reporting a parsing bug.
function lmServerErrorMessage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.translations || data.result) return null; // a real payload
  for (const key of ['error', 'detail', 'message', 'msg']) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object' && typeof v.message === 'string' && v.message.trim()) return v.message.trim();
  }
  return null;
}

function lmNormalizeTranslations(data, expected) {
  let list = null;
  if (Array.isArray(data)) list = data;
  else if (data && Array.isArray(data.translations)) list = data.translations;
  else if (data && Array.isArray(data.result)) list = data.result;
  if (list === null) {
    throw new Error('LM Studio reply has no translations array. Expected a JSON array of ' + expected + ' translated strings.');
  }
  if (typeof expected === 'number' && list.length !== expected) {
    throw new Error('LM Studio returned ' + list.length + ' translation(s) for ' + expected +
      ' source line(s) — refusing to pair them, because shifted entries would paint the wrong text into the wrong bubble.');
  }
  return list.map(v => (v === null || v === undefined ? '' : String(v)));
}

function parseLmStudioBody(bodyText, expected) {
  const text = bodyText === null || bodyText === undefined ? '' : String(bodyText);
  if (!text.trim()) {
    throw new Error('LM Studio reply was empty. Is a model loaded in LM Studio?');
  }
  let parsedBody;
  try { parsedBody = JSON.parse(text); } catch { parsedBody = undefined; }

  // finish_reason is the server's own verdict on the reply: a truncated
  // reply (length) or a filtered one (content_filter) must not be
  // reported later as a JSON/length error with no hint it was cut off.
  if (parsedBody && Array.isArray(parsedBody.choices) && parsedBody.choices.length) {
    const fr = parsedBody.choices[0] && parsedBody.choices[0].finish_reason;
    if (fr === 'length') throw new Error('LM Studio: reply cut off (too long), try fewer texts');
    if (fr === 'content_filter') throw new Error('LM Studio: blocked by model filter');
  }

  let data = null;
  if (parsedBody !== undefined) {
    const answer = lmUnwrapAssistantText(parsedBody);
    if (answer !== null) {
      // A chat envelope. The answer is a STRING that may itself be JSON, may
      // be code-fenced, may carry prose — so parse that string, with `expected`
      // so a reply that also quotes the source back resolves to the array with
      // the right number of entries.
      try {
        data = JSON.parse(answer);
      } catch {
        const found = lmExtractJsonArray(answer, expected);
        data = found ? found.parsed : null;
      }
    } else {
      // Not an envelope: a dedicated translation server answering
      // {"translations":[...]} or a bare array — but surface its own error
      // text first.
      const reported = lmServerErrorMessage(parsedBody);
      if (reported) throw new Error('LM Studio reported: ' + reported);
      // An envelope whose ANSWER is empty: a reasoning model that put the whole
      // reply in its thinking half. Recoverable only with the exact count.
      const think = lmReasoningText(parsedBody);
      if (think !== null) {
        const found = typeof expected === 'number' ? lmExtractJsonArray(think, expected) : null;
        if (found && Array.isArray(found.parsed) && found.parsed.length === expected) {
          return lmNormalizeTranslations(found.parsed, expected);
        }
        throw new Error('LM Studio spent its whole reply thinking and left the answer empty — nothing was translated. ' +
          'Try switching off "Separate reasoning_content and content in API responses" in LM Studio Developer settings, or pick a non-reasoning model.');
      }
      data = parsedBody;
    }
  } else {
    // Not JSON at all: a raw completion that wrapped the array in prose or a
    // code fence.
    const found = lmExtractJsonArray(text, expected);
    data = found ? found.parsed : null;
  }
  if (data === null || data === undefined) {
    throw new Error('LM Studio reply was not valid JSON. Expected a JSON array of ' + expected + ' translated strings.');
  }
  return lmNormalizeTranslations(data, expected);
}

export async function checkLmStudio(settings) {
  const ep = lmStudioEndpoints(settings);
  // Host grant first: without it a LAN/[::1] probe fails as a generic
  // "cannot reach" with no grant hint. The grant error is returned, not
  // thrown, so the Settings button shows the action to take.
  try { await ensureLmStudioHostAccess(ep.models); }
  catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e), needsHostGrant: !!(e && e.needsHostGrant), hostPattern: e && e.hostPattern };
  }
  let resp;
  try {
    // 10s timeout (probeRequest): the old plain fetch hung forever if
    // the server accepted the connection but never responded, leaving
    // the Settings button stuck on "checking…". 10s is an app-chosen
    // UX bound (a local-server probe should answer in well under a
    // second), not a server SLA.
    resp = await probeRequest((signal) => fetch(ep.models, { signal }));
  } catch (e) {
    if (e && e.probeTimeout) return { ok: false, error: e.message };
    return { ok: false, error: 'cannot reach ' + ep.models + ' (' + ep.label + ') — start the LM Studio server first' };
  }
  const bodyText = await resp.text().catch(() => '');
  if (!resp.ok) {
    if (resp.status === 429) {
      const secs = probeRateLimitSeconds(resp, bodyText);
      return { ok: false, error: secs != null ? `Rate-limited — try again in ${secs}s` : 'Rate-limited — try again shortly' };
    }
    const mapped = mapHttpStatus(resp.status, 'LM Studio');
    return { ok: false, error: `${mapped || `HTTP ${resp.status} from ${ep.models}`}${bodyText ? ' — ' + bodyText.slice(0, 120) : ''}` };
  }
  // A garbled (non-JSON) models reply is not "no model loaded".
  let data;
  try { data = JSON.parse(bodyText); } catch {
    return { ok: false, error: 'LM Studio: models reply was not JSON (server answered, but garbled)' };
  }
  const models = (data && (data.data || data.models)) || [];
  const names = models.map(m => m.key || m.id).filter(Boolean);
  if (ep.flavor === 'lmstudio-v1') {
    // Remember the loaded model now, so translations just send one POST.
    const loaded = models.find(m => m && Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0 && (m.key || m.id));
    if (loaded) {
      try {
        await updateSettingsField('lmStudioModelId', loaded.key || loaded.id);
      } catch { /* best-effort */ }
    }
  }
  if (!names.length) {
    return { ok: false, error: `connected (${ep.label}) — but no model is loaded in LM Studio` };
  }
  return {
    ok: true,
    detail: `connected (${ep.label}) — ${names.length} model${names.length > 1 ? 's' : ''} loaded: ${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''}`,
  };
}

export async function checkAzure(settings) {
  const key = (settings.azureKey || '').trim();
  const region = (settings.azureRegion || '').trim();
  if (!key) return { ok: false, error: 'API key not set' };
  if (!region) return { ok: false, error: 'region not set' };
  try {
    // Minimal real call: translate one word. A 200 proves key+region+network.
    // 10s timeout (probeRequest): fetch() has no built-in timeout, so a
    // timer + AbortController is the only bound. 10s is an app-chosen UX
    // bound (a one-word probe should answer in ~1s), not a server SLA.
    const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=en`;
    const resp = await probeRequest((signal) => fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Ocp-Apim-Subscription-Region': region,
        'Content-type': 'application/json',
        'X-ClientTraceId': crypto.randomUUID(),
      },
      body: JSON.stringify([{ text: 'test' }]),
    }));
    const bodyText = await resp.text().catch(() => '');
    if (!resp.ok) {
      const parsed = parseErrorBody(bodyText);
      if (resp.status === 429) {
        const secs = probeRateLimitSeconds(resp, bodyText);
        return { ok: false, error: secs != null ? `Rate-limited — try again in ${secs}s` : 'Rate-limited — try again shortly' };
      }
      if (resp.status === 401) return { ok: false, error: 'Azure key not accepted (401) — check key/region in Settings' };
      if (resp.status === 403 && parsed.code && /^403/.test(parsed.code)) return { ok: false, error: 'Azure free/trial translations used up (403)' };
      const mapped = mapHttpStatus(resp.status, 'azure translator');
      return { ok: false, error: `${mapped || `HTTP ${resp.status}`}${parsed.code ? ` (code ${parsed.code})` : ''}${parsed.message ? ' — ' + parsed.message.slice(0, 120) : bodyText ? ' — ' + bodyText.slice(0, 120) : ''}` };
    }
    // Validate the 200 body: it must be an array of length 1 with a
    // translations[0].text — a 200 with [] is not "connected".
    let okBody = false;
    try {
      const data = JSON.parse(bodyText);
      okBody = Array.isArray(data) && data.length === 1 && data[0] && Array.isArray(data[0].translations)
        && data[0].translations[0] && typeof data[0].translations[0].text === 'string';
    } catch { okBody = false; }
    if (!okBody) return { ok: false, error: 'connected, but the reply had no translation — try again' };
    return { ok: true, detail: 'connected — key and region accepted' };
  } catch (e) {
    if (e && e.probeTimeout) return { ok: false, error: e.message };
    return { ok: false, error: 'network error — ' + String(e).slice(0, 120) };
  }
}
async function localLlm(texts, settings, signal, deadlineAt) {
  // WebLLM runtime removed from the bundle (was 6.6 MB). A stale stored
  // 'local-llm' pref falls back to Google instead of hard-failing.
  return googleFree(texts, settings.sourceLang, settings.targetLang, signal, deadlineAt);
}

export async function translateBlocks(blocks, settings, onProgress, signal, deadlineMs = 30000, isUserCancelled) {
  const idx = [], texts = [];
  blocks.forEach((b, i) => {
    if (b.text && b.text.trim()) { idx.push(i); texts.push(b.text); }
  });
  const translated = new Array(blocks.length).fill('');
  if (!texts.length) return translated;
  const backend = settings.translationBackend || 'google';
  const translateStart = performance.now();
  // Azure reserve: REMOVED 2026-11-26 (audit 3b). The 8s AZURE_RESERVE_MS,
  // azureStillToCome=false and the primary abort timer that depended on
  // them were dead code — proven by grep: every reference lived in this
  // function and the timer only fired when primaryCapMs < deadlineMs,
  // which was false because azureStillToCome was the literal false.
  // azureConsumed is KEPT: since the Google-primary failover (below) can
  // now try Azure once, a consumed Azure attempt is live again.
  // PRIMARY CAP: deliberately NOT imposed here. The per-attempt timeout
  // (15s) + backoff caps in the backend loops are the safe fix for
  // uncapped retries; whether the primary should get only 20s of the
  // 30s (leaving 10s for failover) is a design decision for James —
  // .58 deliberately gave the primary the full 30s.
  let azureConsumed = false;
  // translateBlocks state: the primary result, the last error (primary
  // or fallback, for the combined throw), and which backend actually
  // produced the result. These MUST be declared: this file is an ES
  // module (strict mode), so assigning to an undeclared variable throws
  // ReferenceError on every call. (Restored 2026-11-26 — commit a1783a5
  // dropped them and broke every translation.)
  let results;
  let lastErr = null;
  let backendUsed = backend;
  // Absolute deadline (Date.now() clock) for the Google/Azure/Gemini
  // retry loops, so their per-attempt timers and backoff caps can be
  // computed against the same budget LM Studio gets as deadlineMs.
  const startDateMs = Date.now();
  const primaryDeadlineAt = startDateMs + deadlineMs;
  const runBackend = async (b, attemptDeadlineMs, sig = signal, deadlineAt = primaryDeadlineAt) => {
    if (b === 'azure') return await azure(texts, settings, sig, deadlineAt);
    if (b === 'gemini') return await gemini(texts, settings, sig, deadlineAt);
    if (b === 'lmstudio') return await lmStudio(texts, settings, sig, attemptDeadlineMs ?? deadlineMs);
    if (b === 'local-llm') return await localLlm(texts, settings, sig, deadlineAt);
    return await googleFree(texts, settings.sourceLang, settings.targetLang, sig, deadlineAt);
  };
  const primaryLmCap = backend === 'lmstudio' ? Math.min(deadlineMs, 15000) : undefined;
  try {
    results = await runBackend(backend, primaryLmCap, signal, primaryDeadlineAt);
  } catch (e) {
    // Only a real user cancel skips failover. A timeout-abort is also
    // marked 'cancelled' by the backend helpers, but it must still fail
    // over — otherwise a stalled backend never switches to Azure.
    // A cancelled run throws a quiet 'cancelled', not the backend's
    // error: otherwise a run the user left (fast page-flip) surfaces
    // the backend's error (e.g. Gemini source-language) as a visible
    // failure instead of stopping quietly.
    if (isUserCancelled?.()) throw Object.assign(new Error('cancelled'), { cancelled: true });
    lastErr = e;
    // Keep the primary error: the combined throw at the end reports both
    // the primary and the fallback failure instead of overwriting it.
    const primaryErr = e;
    let lastFallbackBackend = null;
    // Opt-in failover: try the next backend. Never silently fail over to
    // paid Azure without the opt-in — the setting gates it.
    if (settings.backendFailover) {
      // James's rule (2026-11-26): every backend fails over to Google
      // only, not to each other. Google is the free fallback for all of
      // them. Chaining through LM Studio / Azure burned the budget on
      // backends that were never the right next try (no LM Studio on a
      // phone, Azure is being retired).
      const candidates = [];
      if (backend !== 'google') candidates.push('google');
      // Google-as-primary failover (audit 3b item 18): the ONLY case in
      // which a non-Google backend is tried as a fallback. Triggers only
      // when Google itself is the primary and fails with a 429/5xx (not
      // a 4xx). One alternate, once, inside the remaining budget:
      // Gemini if a key is present, else Azure, else LM Studio. Only
      // give up when no alternate is configured (LM Studio is always
      // configured — it has a default local URL — so in practice an
      // alternate always exists).
      if (backend === 'google') {
        const googleRetryable = /HTTP (429|500|502|503|504)/.test(String(primaryErr && primaryErr.message ? primaryErr.message : ''));
        if (googleRetryable) {
          if ((settings.geminiApiKey || '').trim()) candidates.push('gemini');
          else if ((settings.azureKey || '').trim() && (settings.azureRegion || '').trim()) candidates.push('azure');
          else candidates.push('lmstudio');
        }
      }
      // If the primary died by timeout-abort, the caller's signal is dead:
      // failover attempts on it would die instantly. Rescue on a fresh
      // signal with its own 20s budget, so stall (30s) + rescue fits
      // under the caller's 60s backstop. A user cancel during rescue
      // still stops it via the loop-top check below.
      const rescueMode = signal?.aborted && !isUserCancelled?.();
      // Failover budget: 20s in rescue mode (fresh signal after the 30s
      // stall abort), else the full deadline. 20s is 60s backstop − 30s
      // stall, from TRANSLATE_BACKSTOP_MS in service-worker.js — derived
      // arithmetic, not a measured value.
      const failoverBudgetMs = rescueMode ? 20000 : deadlineMs;
      const budgetStart = rescueMode ? performance.now() : translateStart;
      let attemptSignal = signal;
      let failoverTimer = null;
      let failoverAttempted = false;
      if (rescueMode) {
        // Failover rescue timer: waits failoverBudgetMs (20s), then aborts
        // the fresh failover signal. Needed because the caller's signal
        // is already dead (it fired the 30s stall abort), so without a
        // fresh controller + timer, failover would have no bound at all.
        // 20s comes from the caller's 60s backstop minus the 30s stall
        // (TRANSLATE_BACKSTOP_MS in service-worker.js), leaving ~10s
        // slack — derived arithmetic, not a measured value.
        const fc = new AbortController();
        attemptSignal = fc.signal;
        failoverTimer = setTimeout(() => { try { fc.abort(); } catch {} }, failoverBudgetMs);
      }
      // Failover must fit inside the same overall budget: a slow middle
      // backend (a running LM Studio server generating slowly) used to burn
      // the whole deadline, so later backends never got a turn and the
      // overall abort then poisoned their attempts too. Cap each LM Studio
      // failover attempt at 15s and stop when the budget is gone, so Azure
      // always gets its turn inside the 30s translate budget.
      // TODO: why 15s? No measured value or model contract found in the
      // code — half the 30s budget is a round split, not a derivation;
      // verify whether 15s fits a real slow-model generation.
      const FAILOVER_LM_DEADLINE_MS = 15000;
      for (const fb of candidates) {
        const remaining = failoverBudgetMs - (performance.now() - budgetStart);
        if (remaining <= 0) break;
        if (isUserCancelled?.()) {
          if (failoverTimer) clearTimeout(failoverTimer);
          throw Object.assign(new Error('cancelled'), { cancelled: true });
        }
        failoverAttempted = true;
        try {
          // Skip LM Studio failover if it was the failing backend (avoid loop).
          // Skip backends that need config we don't have.
          if (fb === 'lmstudio' && backend === 'lmstudio') continue;
          // Cap a non-Azure attempt so Azure keeps its reserve. LM Studio
          // takes the cap as its attempt deadline; Google has no such
          // parameter, so it gets a per-attempt abort timer instead. A
          // timer abort is not a user cancel — the catch below checks
          // isUserCancelled, so the loop still moves on to Azure.
          let attemptSig = attemptSignal;
          let attemptTimer = null;
          // LM Studio failover cap: the smaller of the remaining budget
          // and the 15s per-attempt ceiling (see FAILOVER_LM_DEADLINE_MS).
          let lmCap = fb === 'lmstudio' ? Math.min(remaining, FAILOVER_LM_DEADLINE_MS) : undefined;
          // Failover deadline for the Google/Azure/Gemini loops: the
          // remaining failover budget, not the original 30s deadline.
          const fbDeadlineAt = Date.now() + remaining;
          // User-visible notice: failover must not happen silently.
          onProgress && onProgress({ failoverFrom: backend, failoverTo: fb });
          lastFallbackBackend = fb;
          try {
            results = await runBackend(fb, lmCap, attemptSig, fbDeadlineAt);
          } finally {
            if (attemptTimer) clearTimeout(attemptTimer);
          }
          if (isUserCancelled?.()) {
            if (failoverTimer) clearTimeout(failoverTimer);
            throw Object.assign(new Error('cancelled'), { cancelled: true });
          }
          lastErr = null;
          backendUsed = fb;
          if (fb === 'azure') azureConsumed = true;
          console.warn(`[ct] backend failover: ${backend} failed, ${fb} succeeded`);
          break;
        } catch (fe) {
          if (isUserCancelled?.()) throw Object.assign(new Error('cancelled'), { cancelled: true });
          lastErr = fe;
          if (fb === 'azure') azureConsumed = true;
        }
      }
      if (failoverTimer) clearTimeout(failoverTimer);
      // Keep BOTH errors: the primary's cause and the fallback's cause.
      // The generic "all backends failed or timed out" is only a prefix,
      // never the whole message — the primary error (e.g. a Gemini 401
      // bad key or Azure 403 trial exhaustion) used to be lost here.
      if (lastErr && primaryErr && lastErr !== primaryErr && lastFallbackBackend) {
        const fbLabel = lastFallbackBackend === 'google' ? 'Google' : lastFallbackBackend === 'gemini' ? 'Gemini' : lastFallbackBackend === 'azure' ? 'Azure' : 'LM Studio';
        const primaryLabel = backend === 'google' ? 'Google' : backend === 'gemini' ? 'Gemini' : backend === 'azure' ? 'Azure' : 'LM Studio';
        const fallbackMsg = lastErr.message;
        lastErr = new Error(`translation failed: ${primaryLabel} failed (${primaryErr.message}); ${fbLabel} fallback also failed (${fallbackMsg})`);
        try { tlog(`translate failover: primary ${primaryLabel} failed: ${primaryErr.message}`); } catch {}
        try { tlog(`translate failover: fallback ${fbLabel} failed: ${fallbackMsg}`); } catch {}
      }
      // A timeout-abort that failover couldn't rescue must not surface as
      // a bare 'cancelled'. No failover attempted keeps the old
      // 'timed out after Xs' wording; a rescued-then-failed run says so.
      // (When both errors were combined above, the combined message is
      // kept — the generic line is only a prefix there.)
      if (lastErr && lastErr.cancelled && !isUserCancelled?.()) {
        lastErr = failoverAttempted
          ? new Error('translation failed: all backends failed or timed out')
          : new Error(`translate timed out after ${deadlineMs / 1000}s — the translation backend may be stuck`);
      }
      // Failover goes to Google only (James 2026-11-26) — except the
      // Google-primary case above, where one alternate is tried. Never
      // imply Azure will be tried when it was not a candidate.
      if (lastErr && failoverAttempted && backend !== 'google') {
        lastErr.message = `${lastErr.message} — failover goes to Google only`;
      }
      // Failover already tried Azure (and it failed): don't offer a
      // "retry with Azure" — it was just consumed.
      if (lastErr && azureConsumed) lastErr.azureRetryAvailable = false;
    } else {
      // Not opted in: don't fail over automatically, but tag the error so
      // the UI can offer one-click "retry with Azure".
      if ((settings.azureKey || '').trim() && backend !== 'azure') {
        lastErr.azureRetryAvailable = true;
      }
      // A timeout-abort (not a user cancel) must surface as a timeout
      // error, not a bare 'cancelled' — otherwise the run looks cancelled
      // and shows no error message at all (Chrome regression in 1018o).
      if (lastErr && lastErr.cancelled && !isUserCancelled?.()) {
        const t = new Error(`translate timed out after ${deadlineMs / 1000}s — the translation backend may be stuck`);
        t.azureRetryAvailable = lastErr.azureRetryAvailable;
        lastErr = t;
      }
    }
    if (lastErr) throw lastErr;
  }
  results.forEach((t, k) => { translated[idx[k]] = t; });
  // Record which backend produced the translation (surfaced in debug rows).
  blocks.forEach(b => { b.backendUsed = backendUsed; });
  onProgress && onProgress();
  return translated;
}

export const BACKEND_LABEL = { google: 'Google (free)', azure: 'Azure Translator', gemini: 'Gemini (3.5 Flash-Lite)', lmstudio: 'LM Studio (local)', 'local-llm': 'Local LLM (experimental)' };
// Short labels for the status pill (it has room for one word, not a sentence).
export const BACKEND_SHORT_LABEL = { google: 'Google', azure: 'Azure', gemini: 'Gemini', lmstudio: 'LM Studio', 'local-llm': 'Local LLM' };
