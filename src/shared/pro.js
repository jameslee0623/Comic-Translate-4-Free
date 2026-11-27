// Freemium (Pro) with Dodo Payments license keys.
// Free: 50 images/day while any Pro feature is on (auto-translate,
// pre-translate). Engine failover is free, not a Pro feature — it is
// never gated. A translation is free only when both Pro features are
// off. Pro: unlimited, unlocked by a Dodo license key.
// One image counts as one, whatever its height (long strips are 1:1).
// Dodo's license endpoints are public (no API key), so the extension calls
// them directly. The business_id check at activation stops a key bought
// from any other Dodo seller from unlocking Pro here.

export const PRO_FREE_DAILY_LIMIT = 50;

// A long strip counts as ONE image (1:1), not as the pages it spans.
// James's order 2026-11-25: height alone overcounts — an Asurascans
// strip 900x16000px counted as 12 pages, so one 18-image chapter cost
// 126 of the 50/day free limit, and those strips carry little text.
// One image = one count, whatever its height. PRO_PAGE_RATIO and the
// w/h arguments stay so the rule can come back later if needed.
export const PRO_PAGE_RATIO = 1.5;

export function pagesForImage(w, h) {
  return 1;
}

// --- Dodo setup: James fills these in after creating the Pro product ---
// DODO_BUSINESS_ID: the business id shown in the Dodo dashboard.
// DODO_CHECKOUT_URL: the checkout link for the Pro subscription product.
// DODO_PORTAL_URL: the Dodo Customer Portal (unified, customer.dodopayments.com).
// A subscriber opens it, enters their email, and gets a sign-in link to
// manage their subscription — including changing plans (monthly <-> annual)
// and entering a discount code there. Plan changes need "Allow Subscription
// Updates" on in the Dodo dashboard (Settings -> Subscriptions, off by default).
export const DODO_BUSINESS_ID = 'bus_0NshEEgPyJXea5YDdtX1N';
export const DODO_CHECKOUT_URL = 'https://checkout.dodopayments.com/buy/pdc_0NshS3ePj2aiNr7Cj03d9';
export const DODO_PORTAL_URL = 'https://customer.dodopayments.com';
export const DODO_ACTIVATE_URL = 'https://live.dodopayments.com/licenses/activate';
export const DODO_VALIDATE_URL = 'https://live.dodopayments.com/licenses/validate';
export const DODO_DEACTIVATE_URL = 'https://live.dodopayments.com/licenses/deactivate';
// Pro product ids accepted at activation. Dodo's activate response carries
// the key's product as product.product_id. James (2026-11-26): the
// collection id covers the 2 paid plans, so it stays in the list; the two
// paid single-product ids are a safety net in case Dodo returns the single
// product id for a paid key instead of the collection id; the free product
// is outside the collection but its keys unlock Pro for James and his
// friends, so it is listed too. A key for any other product of the same
// business must not unlock Pro.
export const DODO_PRODUCT_IDS = [
  'pdc_0NshS3ePj2aiNr7Cj03d9', // Pro collection (monthly + annual) — checkout URL
  'pdt_0NshpHpVeof17P0j3FQc3', // free product, for James and his friends
  'pdt_0NshP40zDKoQGS0LmrNzw', // Pro Annual
  'pdt_0NshOPdURVUBjPoj1CLMA', // Pro Monthly
];

// Dodo fetch timeout (15 s, matching a third-party Dodo client's default;
// the SDKs default to 60 s). All three license calls use it — before this
// fix none of them had any timeout, so a hung connection left the Options
// button stuck on "activating…" and validate promises never settled.
// Back-off after a failed validate: retry at most once per hour, not on
// every auto/pre run, so a Dodo outage is not hammered by retries.
export const DODO_FETCH_TIMEOUT_MS = 15000;
export const PRO_VALIDATE_ERROR_BACKOFF_MS = 60 * 60 * 1000;

// How long a successful validation stays trusted before re-checking (24h).
export const PRO_VALID_TTL_MS = 24 * 60 * 60 * 1000;

const USAGE_KEY = 'ct-pro-usage'; // { date: 'YYYY-MM-DD', count: N }

// Local date, YYYY-MM-DD. Pure function of a Date, so the harness can test it.
export function dateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Today's free usage count (0 when the stored date is not today).
export async function getProUsageCount() {
  try {
    const stored = await chrome.storage.local.get(USAGE_KEY);
    const rec = stored[USAGE_KEY];
    if (!rec || rec.date !== dateStr()) return 0;
    // Cap the display at the daily limit: a count stored before the
    // 1.7.52 write cap can already be over 50 (54/50), and the display
    // must never show an impossible number.
    return Number.isFinite(rec.count) ? Math.min(Math.max(0, rec.count), PRO_FREE_DAILY_LIMIT) : 0;
  } catch { return 0; }
}

// True when any Pro feature is enabled: auto-translate or pre-translate.
// A finished translation counts toward the free daily quota when a Pro
// feature is on; manual translation (both off) is free and unlimited.
// Engine failover is free, not a Pro feature, so it never counts here.
export function anyProFeatureOn(settings) {
  if (!settings) return false;
  return !!settings.autoTranslateOnLoad
    || !!settings.pretranslateNextPage;
}

// Add finished auto/pre-translate images to today's count — distinct
// images only, by URL. A re-translation of the same image is free, so the
// quota matches the cache's distinct-image count. A cancelled run never
// reaches here (it throws before counting). Returns new images counted.
export async function addProUsageForImages(entries) {
  // Each entry is a URL string (counts as 1 image) or { key/url/src, w, h }
  // (counts as 1 image — long strips are 1:1, see pagesForImage).
  // Distinct images only: a re-translation of the same URL is free.
  const list = (Array.isArray(entries) ? entries : [entries])
    .map(e => {
      if (typeof e === 'string') return { key: e, pages: 1 };
      if (e && typeof e === 'object') {
        const key = String(e.key || e.url || e.src || '');
        if (!key) return null;
        return { key, pages: pagesForImage(e.w, e.h) };
      }
      return null;
    })
    .filter(Boolean);
  if (!list.length) return 0;
  try {
    const stored = await chrome.storage.local.get(USAGE_KEY);
    const rec = stored[USAGE_KEY];
    const today = dateStr();
    let count = 0;
    let keySet = new Set();
    if (rec && rec.date === today) {
      count = Number.isFinite(rec.count) ? Math.max(0, rec.count) : 0;
      keySet = new Set(Array.isArray(rec.keys) ? rec.keys : []);
    }
    let added = 0;
    for (const { key, pages } of list) {
      if (keySet.has(key)) continue;
      keySet.add(key);
      added += pages;
    }
    if (!added) return 0;
    // Bound the stored keys (the daily limit is 50, so 200 is generous).
    // Cap the stored count at the daily limit too: a run that finishes
    // past the limit (manual runs are not gated) used to push it to
    // 51/50, 52/50, ... and the display showed an impossible number.
    const keysArr = [...keySet].slice(-200);
    await chrome.storage.local.set({ [USAGE_KEY]: { date: today, count: Math.min(count + added, PRO_FREE_DAILY_LIMIT), keys: keysArr } });
    return added;
  } catch { return 0; }
}

// Pro is active when a license key + instance are stored and the last
// validation said valid. No network here, so the hot path (auto-translate)
// never blocks on Dodo. A stale check only triggers a background re-check;
// it does not turn Pro off by itself.
export function proIsActive(settings) {
  if (!settings || !settings.proLicenseKey || !settings.proInstanceId) return false;
  return settings.proActive === true;
}

// True when a re-validation is due (last check older than 24h).
export function proCheckDue(settings) {
  if (!settings || !settings.proLicenseKey || !settings.proInstanceId) return false;
  const last = Number(settings.proLastCheck) || 0;
  return Date.now() - last >= PRO_VALID_TTL_MS;
}

// Can auto-translate / pre-translate run now? Pro always; free while under
// the daily limit. Returns { ok, pro, used, limit }.
export async function canAutoOrPre(settings) {
  if (proIsActive(settings)) return { ok: true, pro: true };
  const used = await getProUsageCount();
  if (used < PRO_FREE_DAILY_LIMIT) return { ok: true, pro: false, used, limit: PRO_FREE_DAILY_LIMIT };
  return { ok: false, pro: false, used, limit: PRO_FREE_DAILY_LIMIT };
}

// --- Dodo helpers (audit 3d) ---

function dodoSleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function dodoLog(line) {
  try { console.warn('[ct] dodo ' + line); } catch {}
}

// One Dodo POST with a 15 s timeout. Throws on network failure or abort;
// the caller tells them apart via e.name === 'AbortError'.
async function dodoFetch(url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DODO_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
}

// True when the response really came from Dodo's live host. fetch follows
// redirects silently, so a redirect to a marketing/login page would
// otherwise surface only as a confusing JSON-parse failure downstream.
function dodoUrlOk(res) {
  const url = typeof res.url === 'string' ? res.url : '';
  // An empty url means the environment did not report one — nothing to
  // check, so do not fail the call on that alone.
  return !url || url.startsWith('https://live.dodopayments.com/');
}

function dodoIsJson(res) {
  const ct = (res.headers && res.headers.get) ? (res.headers.get('Content-Type') || '') : '';
  return String(ct).toLowerCase().includes('application/json');
}

// Read a body as JSON, but never parse it as JSON without checking
// Content-Type first — an HTML error page must be reported as an
// unexpected page, not as "bad response". Returns
// { ok: true, data } or { ok: false, reason: 'not-json'|'empty'|'parse' }.
async function dodoReadJson(res) {
  if (!dodoIsJson(res)) return { ok: false, reason: 'not-json' };
  let text;
  try { text = await res.text(); } catch { return { ok: false, reason: 'parse' }; }
  if (!text || !text.trim()) return { ok: false, reason: 'empty' };
  try { return { ok: true, data: JSON.parse(text) }; } catch { return { ok: false, reason: 'parse' }; }
}

// Best-effort read of a Dodo error body: { code, message } when the body
// is JSON, {} otherwise. Never throws.
async function dodoReadError(res) {
  const r = await dodoReadJson(res);
  if (!r.ok || !r.data || typeof r.data !== 'object') return {};
  return {
    code: typeof r.data.code === 'string' ? r.data.code : '',
    message: typeof r.data.message === 'string' ? r.data.message
      : (typeof r.data.error === 'string' ? r.data.error : ''),
  };
}

// Retry-After in ms (seconds or an HTTP date), or null when absent /
// unparsable. Dodo sends Retry-After >= 1 s on 429.
function dodoRetryAfterMs(res) {
  const v = (res.headers && res.headers.get) ? res.headers.get('Retry-After') : null;
  if (v == null) return null;
  const s = String(v).trim();
  const secs = Number(s);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const dateMs = Date.parse(s);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

// Release a seat created by an activation we are about to reject (wrong
// business, wrong product, unparsable body). Best-effort only: returns
// true when Dodo confirmed the release, false otherwise. Never throws,
// never touches local settings — the key was never stored.
async function dodoReleaseSeat(licenseKey, instanceId) {
  if (!licenseKey || !instanceId) return false;
  try {
    const res = await dodoFetch(DODO_DEACTIVATE_URL, { license_key: licenseKey, license_key_instance_id: String(instanceId) });
    const ok = !!res && res.status >= 200 && res.status < 300;
    dodoLog('release seat ' + (ok ? 'ok' : 'failed (HTTP ' + (res && res.status) + ')') + ' instance ' + String(instanceId).slice(0, 12));
    return ok;
  } catch (e) {
    dodoLog('release seat failed: ' + String((e && e.message) || e).slice(0, 80));
    return false;
  }
}

// The instance id in a successful activate body. Dodo's docs list it as
// `id` ("lki_…"); older code read only license_key_instance_id /
// instance_id, which the docs never list — so a docs-shaped body fell
// through to "no instance id" while the seat was already burned.
function dodoInstanceId(data) {
  if (!data || typeof data !== 'object') return '';
  return String(data.id || data.license_key_instance_id || data.instance_id || '');
}

// Activate a license key: POST to Dodo, check business_id, store key+instance.
// Returns { ok: true } or { ok: false, error }.
export async function activateProLicense(key) {
  const licenseKey = String(key || '').trim();
  if (!licenseKey) return { ok: false, error: 'empty key' };
  // Up to two attempts: the second only after a 429 (honouring
  // Retry-After) or a 5xx (after ~2 s). Every other outcome is final on
  // the first attempt — retrying a 4xx or a success-body problem can only
  // burn another activation seat.
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await dodoFetch(DODO_ACTIVATE_URL, { license_key: licenseKey, name: 'Comic Translate 4 Free' });
    } catch (e) {
      // Ambiguous: the request may have reached Dodo and created the
      // instance before the response was lost, so a blind retry would
      // burn a second seat. Do not invite an immediate retry — the user
      // should check Settings / deactivate before trying again.
      const timedOut = e && e.name === 'AbortError';
      dodoLog('activate ' + (timedOut ? 'timed out' : 'network error') + ': ' + String((e && e.message) || e).slice(0, 80));
      return {
        ok: false, ambiguous: true,
        error: timedOut
          ? 'Dodo did not answer — activation may have succeeded, check in Settings / deactivate before retrying'
          : 'Could not reach Dodo — activation may have succeeded, check in Settings / deactivate before retrying',
      };
    }
    if (!dodoUrlOk(res)) {
      dodoLog('activate redirected to ' + String(res.url).slice(0, 120));
      return { ok: false, error: 'Dodo returned an unexpected page (HTTP ' + res.status + ')' };
    }
    // 429: wait Retry-After (default 5 s, capped at 60 s), retry once.
    if (res.status === 429) {
      if (attempt === 0) {
        const wait = dodoRetryAfterMs(res);
        dodoLog('activate 429, waiting ' + ((wait == null ? 5000 : Math.min(wait, 60000)) / 1000) + 's before retry');
        await dodoSleep(wait == null ? 5000 : Math.min(wait, 60000));
        continue;
      }
      return { ok: false, error: 'Dodo is busy — try again in a minute' };
    }
    // 500/502/503: retry once after ~2 s. Docs say message is usually
    // null for 500, so do not rely on it.
    if (res.status === 500 || res.status === 502 || res.status === 503) {
      if (attempt === 0) {
        dodoLog('activate HTTP ' + res.status + ', retrying once after 2s');
        await dodoSleep(2000);
        continue;
      }
      const err = await dodoReadError(res);
      dodoLog('activate HTTP ' + res.status + ' code ' + (err.code || '(none)'));
      return { ok: false, error: 'Dodo had a problem — try again later' };
    }
    // Success: Dodo's API intro says 200 or 201; the activate docs say
    // 201. Accept both, same body handling.
    if (res.status === 200 || res.status === 201) {
      const r = await dodoReadJson(res);
      if (!r.ok) {
        // The seat is already created server-side but the body cannot be
        // read, so no instance id is known and the seat cannot be
        // released automatically.
        dodoLog('activate HTTP ' + res.status + ' with unreadable body (' + r.reason + ') — seat may be held');
        return { ok: false, error: 'Dodo returned an unexpected page (HTTP ' + res.status + ') — the seat could not be released automatically' };
      }
      const data = r.data;
      const instanceId = dodoInstanceId(data);
      // The business_id check: a key bought from any other Dodo seller
      // must not unlock Pro here. The activation already succeeded
      // server-side, so release the seat before reporting the error.
      if (!data || typeof data !== 'object' || data.business_id !== DODO_BUSINESS_ID) {
        dodoLog('activate business mismatch: got ' + String(data && data.business_id).slice(0, 60));
        if (instanceId) await dodoReleaseSeat(licenseKey, instanceId);
        return { ok: false, error: 'this key was not sold by Comic Translate 4 Free' };
      }
      // Product check: the response carries product.product_id when the
      // key is tied to a product (Dodo docs list a `product` object;
      // product_id confirmed by the official SDK types and a third-party
      // client). A key for a different product of the same business must
      // not unlock Pro — the accepted ids are DODO_PRODUCT_IDS (collection
      // + free + Pro Annual + Pro Monthly). When the product object (or its
      // id) is absent, the check is skipped — absence must not block
      // activation.
      if (data.product && typeof data.product === 'object') {
        const pid = typeof data.product.product_id === 'string' ? data.product.product_id
          : (typeof data.product.id === 'string' ? data.product.id : '');
        if (pid && !DODO_PRODUCT_IDS.includes(pid)) {
          dodoLog('activate product mismatch: got ' + pid);
          if (instanceId) await dodoReleaseSeat(licenseKey, instanceId);
          return { ok: false, error: 'this key is not for the Pro subscription — check you bought the right product' };
        }
      }
      if (!instanceId) {
        dodoLog('activate HTTP ' + res.status + ' with no instance id — seat may be held');
        return { ok: false, error: 'bad activation response (no instance id) — the seat could not be released automatically' };
      }
      const { updateSettingsField } = await import('./settings.js');
      try {
        await updateSettingsField('proLicenseKey', licenseKey);
        await updateSettingsField('proInstanceId', String(instanceId));
        await updateSettingsField('proActive', true);
        await updateSettingsField('proLastCheck', Date.now());
      } catch (e) {
        // Activation already happened server-side, so the seat is in
        // use — but the key was not saved locally, so Pro stays off here.
        dodoLog('activate could not save license: ' + String((e && e.message) || e).slice(0, 80));
        return { ok: false, error: 'could not save license — try again. Activation already happened on Dodo, so the seat is in use.' };
      }
      return { ok: true };
    }
    // Error statuses: parse the JSON error body (code/message) when the
    // Content-Type says it is JSON; an HTML error page is reported as an
    // unexpected page, never parsed as Dodo JSON.
    const err = await dodoReadError(res);
    if (!dodoIsJson(res)) {
      dodoLog('activate HTTP ' + res.status + ' with non-JSON body');
      return { ok: false, error: 'Dodo returned an unexpected page (HTTP ' + res.status + ')' };
    }
    dodoLog('activate HTTP ' + res.status + ' code ' + (err.code || '(none)') + ' message ' + String(err.message || '').slice(0, 80));
    if (res.status === 403) {
      if (err.code === 'INACTIVE_LICENSE_KEY') {
        return { ok: false, error: 'This key is not active (expired, disabled, or subscription ended)' };
      }
      if (err.code === 'MERCHANT_NOT_LIVE' || err.code === 'BUSINESS_ARCHIVED') {
        // Pro sales are not enabled yet — do not invite a retry loop.
        return { ok: false, error: 'Pro sales are not enabled yet — try again later' };
      }
      return { ok: false, error: 'activation failed (HTTP 403)' + (err.code ? ': ' + err.code : '') };
    }
    if (res.status === 404) {
      return { ok: false, error: "That key isn't valid — check it for typos and try again" };
    }
    if (res.status === 422) {
      if (err.code === 'LICENSE_KEY_LIMIT_REACHED' || !err.code) {
        return { ok: false, error: 'This key is already active on 2 devices — deactivate it on another device first, then try again' };
      }
      return { ok: false, error: 'activation failed (HTTP 422)' + (err.code ? ': ' + err.code : '') };
    }
    // 400, 401, 409 and anything else: server/config error, no retry.
    // (401/409 are not documented for these public endpoints; if one is
    // ever seen, the log line above carries status + code.)
    return { ok: false, error: 'activation failed (HTTP ' + res.status + ')' + (err.message ? ': ' + String(err.message).slice(0, 100) : '') };
  }
  return { ok: false, error: 'Dodo had a problem — try again later' };
}

// Re-validate the stored license against Dodo. Updates proActive/proLastCheck.
// Returns { ok: true, valid } or { ok: false, error }.
// Outcomes split three ways — callers must not treat them alike:
//  (1) revoked: 200 valid:false, or 404 → proActive=false, proLastCheck
//      updated, { ok: true, valid: false, revoked: true }. Pro ended.
//  (2) unknown: 429 / 5xx / network / timeout / unparsable 200 / 204 →
//      Pro stays on, proLastCheck untouched, { ok: false, transient: true }
//      and proLastErrorAt recorded, so the next check is backed off for
//      an hour (see the check at the top — no fetch is made while backed
//      off, so every caller benefits).
//  (3) other 4xx → logged, Pro stays on, same back-off as (2).
// A network error / timeout returns the distinct transient marker so
// callers and logs can tell "could not reach Dodo" from "Dodo said no".
// Note (known limitation, no change possible): validate returns only
// {valid}, so no business/product check can be done here — that check
// exists only at activation time.
export async function validateProLicense(settings) {
  const key = settings && settings.proLicenseKey;
  const instanceId = settings && settings.proInstanceId;
  if (!key || !instanceId) return { ok: false, error: 'no license' };
  // Back-off inside pro.js: if the last validate failed with a transient
  // error less than an hour ago, do not fetch at all.
  const lastErr = Number(settings.proLastErrorAt) || 0;
  if (lastErr && Date.now() - lastErr < PRO_VALIDATE_ERROR_BACKOFF_MS) {
    return { ok: false, transient: true, backedOff: true, error: 'validate backed off (recent error)' };
  }
  const { updateSettingsField } = await import('./settings.js');
  // Record a transient failure time so later calls back off. Best-effort:
  // if the write itself fails, the check just retries sooner.
  const recordError = async () => {
    try { await updateSettingsField('proLastErrorAt', Date.now()); } catch {}
  };
  const clearError = async () => {
    try { await updateSettingsField('proLastErrorAt', 0); } catch {}
  };
  const transient = async (error) => {
    await recordError();
    return { ok: false, transient: true, error };
  };
  let res;
  try {
    res = await dodoFetch(DODO_VALIDATE_URL, { license_key: key, license_key_instance_id: instanceId });
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    dodoLog('validate ' + (timedOut ? 'timed out' : 'network error') + ': ' + String((e && e.message) || e).slice(0, 80));
    return transient(timedOut ? 'Dodo did not answer — validate timed out' : 'network error: ' + String((e && e.message) || e).slice(0, 100));
  }
  if (!dodoUrlOk(res)) {
    dodoLog('validate redirected to ' + String(res.url).slice(0, 120));
    return transient('Dodo returned an unexpected page (HTTP ' + res.status + ')');
  }
  // 204 has no body: unknown, not revoked — never turn Pro off on it.
  if (res.status === 204) {
    dodoLog('validate HTTP 204 (no content)');
    return transient('validate failed (HTTP 204, no content)');
  }
  if (!res.ok) {
    // 404: the key/instance is gone on Dodo's side — treat as revoked,
    // like 200 valid:false. (Dodo documents no error statuses for
    // validate, and a wrong key answers 200 valid:false; 404 is handled
    // defensively the way a third-party client does.)
    if (res.status === 404) {
      dodoLog('validate HTTP 404 — treating as revoked');
      try {
        await updateSettingsField('proActive', false);
        await updateSettingsField('proLastCheck', Date.now());
        await clearError();
      } catch (e) {
        dodoLog('validate could not save revocation: ' + String((e && e.message) || e).slice(0, 80));
        return transient('could not save validation result');
      }
      return { ok: true, valid: false, revoked: true };
    }
    const err = await dodoReadError(res);
    dodoLog('validate HTTP ' + res.status + ' code ' + (err.code || '(none)') + ' — keeping Pro state');
    return transient('validate failed (HTTP ' + res.status + ')' + (err.code ? ': ' + err.code : ''));
  }
  const r = await dodoReadJson(res);
  if (!r.ok) {
    dodoLog('validate HTTP 200 with unreadable body (' + r.reason + ')');
    return transient(r.reason === 'not-json' ? 'Dodo returned an unexpected page (HTTP 200)' : 'bad validate response');
  }
  const data = r.data;
  // A missing or wrong-typed `valid` is unknown, not revoked: !!{} used
  // to turn Pro off on a malformed-but-200 response, and "false" (a
  // string) is truthy, so it kept Pro on. Leave proActive/proLastCheck
  // untouched here.
  if (!data || typeof data.valid !== 'boolean') {
    dodoLog('validate HTTP 200 without a boolean valid field');
    return transient('bad validate response');
  }
  const valid = data.valid;
  try {
    await updateSettingsField('proActive', valid);
    await updateSettingsField('proLastCheck', Date.now());
    await clearError();
  } catch (e) {
    dodoLog('validate could not save result: ' + String((e && e.message) || e).slice(0, 80));
    return transient('could not save validation result');
  }
  return { ok: true, valid, revoked: !valid };
}

// Deactivate the stored license (frees an activation slot) and clear it.
// Always clears locally, even when Dodo cannot confirm the seat was
// freed — the intent is to deactivate. Returns { ok: true } on a
// confirmed release, or { ok: true, warned: <message> } when the seat
// may still be held on Dodo's side. The options.js caller must show
// `warned` when present (it currently ignores the return value).
export async function deactivateProLicense(settings) {
  const key = settings && settings.proLicenseKey;
  const instanceId = settings && settings.proInstanceId;
  let warned = null;
  if (key && instanceId) {
    // Up to two attempts: the second only after a 429 (honouring
    // Retry-After) or a 5xx (after ~2 s). A network error is not retried
    // — the local clear must not wait on a dead connection.
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await dodoFetch(DODO_DEACTIVATE_URL, { license_key: key, license_key_instance_id: instanceId });
      } catch (e) {
        const timedOut = e && e.name === 'AbortError';
        dodoLog('deactivate ' + (timedOut ? 'timed out' : 'network error') + ': ' + String((e && e.message) || e).slice(0, 80));
        warned = 'Deactivated here, but Dodo could not be reached — the activation may still count toward your 2-device limit';
        break;
      }
      if (!dodoUrlOk(res)) {
        dodoLog('deactivate redirected to ' + String(res.url).slice(0, 120));
        warned = 'Deactivated on this device — Dodo could not confirm the seat was freed (HTTP ' + res.status + '); if you hit the 2-device limit later, free it in the Dodo dashboard';
        break;
      }
      if (res.status === 429) {
        if (attempt === 0) {
          const wait = dodoRetryAfterMs(res);
          dodoLog('deactivate 429, waiting ' + ((wait == null ? 5000 : Math.min(wait, 60000)) / 1000) + 's before retry');
          await dodoSleep(wait == null ? 5000 : Math.min(wait, 60000));
          continue;
        }
        dodoLog('deactivate still 429 after retry');
        warned = 'Deactivated on this device — Dodo could not confirm the seat was freed (HTTP 429); if you hit the 2-device limit later, free it in the Dodo dashboard';
        break;
      }
      if (res.status === 500 || res.status === 502 || res.status === 503) {
        if (attempt === 0) {
          dodoLog('deactivate HTTP ' + res.status + ', retrying once after 2s');
          await dodoSleep(2000);
          continue;
        }
        const err = await dodoReadError(res);
        dodoLog('deactivate HTTP ' + res.status + ' code ' + (err.code || '(none)') + ' after retry');
        warned = 'Deactivated on this device — Dodo could not confirm the seat was freed (HTTP ' + res.status + '); if you hit the 2-device limit later, free it in the Dodo dashboard';
        break;
      }
      if (res.status >= 200 && res.status < 300) break; // confirmed
      // 403 (instance does not belong to the key), 404 (key/instance
      // already gone), or any other 4xx: the seat is not confirmed
      // freed, but the local intent stands — clear locally with a warning.
      const err = await dodoReadError(res);
      dodoLog('deactivate HTTP ' + res.status + ' code ' + (err.code || '(none)'));
      warned = 'Deactivated on this device — Dodo could not confirm the seat was freed (HTTP ' + res.status + '); if you hit the 2-device limit later, free it in the Dodo dashboard';
      break;
    }
  }
  const { updateSettingsField } = await import('./settings.js');
  try {
    await updateSettingsField('proLicenseKey', '');
    await updateSettingsField('proInstanceId', '');
    await updateSettingsField('proActive', false);
    await updateSettingsField('proLastCheck', 0);
  } catch (e) {
    dodoLog('deactivate could not clear local state: ' + String((e && e.message) || e).slice(0, 80));
  }
  return warned ? { ok: true, warned } : { ok: true };
}
