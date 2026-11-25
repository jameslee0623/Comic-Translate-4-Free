// Freemium (Pro) with Dodo Payments license keys.
// Free: 50 images/day while any Pro feature is on (auto-translate,
// pre-translate, engine failover). A translation is free only when all
// Pro features are off. Pro: unlimited, unlocked by a Dodo license key.
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
export const DODO_BUSINESS_ID = 'bus_0NshEEgPyJXea5YDdtX1N';
export const DODO_CHECKOUT_URL = 'https://checkout.dodopayments.com/buy/pdc_0NshS3ePj2aiNr7Cj03d9';
export const DODO_ACTIVATE_URL = 'https://live.dodopayments.com/licenses/activate';
export const DODO_VALIDATE_URL = 'https://live.dodopayments.com/licenses/validate';
export const DODO_DEACTIVATE_URL = 'https://live.dodopayments.com/licenses/deactivate';

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
    return Number.isFinite(rec.count) ? Math.max(0, rec.count) : 0;
  } catch { return 0; }
}

// Reset today's free usage count to 0 (test helper, Debug section only).
// Removes the whole usage record; getProUsageCount() returns 0 when
// there is no record. Used while the Dodo account is under screening
// and Pro cannot be activated yet.
export async function resetProUsageToday() {
  try { await chrome.storage.local.remove(USAGE_KEY); } catch { /* ignore */ }
}

// True when any Pro feature is enabled: auto-translate, pre-translate, or
// engine failover. A finished translation counts toward the free daily
// quota when any Pro feature is on; it is free only when all three are
// off. (Failover defaults on, so by default every translation counts.)
export function anyProFeatureOn(settings) {
  if (!settings) return false;
  return !!settings.autoTranslateOnLoad
    || !!settings.pretranslateNextPage
    || !!settings.backendFailover;
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
    const keysArr = [...keySet].slice(-200);
    await chrome.storage.local.set({ [USAGE_KEY]: { date: today, count: count + added, keys: keysArr } });
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

// Activate a license key: POST to Dodo, check business_id, store key+instance.
// Returns { ok: true } or { ok: false, error }.
export async function activateProLicense(key) {
  const licenseKey = String(key || '').trim();
  if (!licenseKey) return { ok: false, error: 'empty key' };
  let res;
  try {
    res = await fetch(DODO_ACTIVATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: licenseKey, name: 'Comic Translate 4 Free' }),
    });
  } catch (e) {
    return { ok: false, error: 'network error: ' + String((e && e.message) || e).slice(0, 100) };
  }
  // Dodo returns 201 on a successful activation (not 200).
  if (res.status !== 201) {
    let detail = '';
    try { const j = await res.json(); detail = (j && (j.message || j.error)) || ''; } catch {}
    return { ok: false, error: 'activation failed (HTTP ' + res.status + ')' + (detail ? ': ' + String(detail).slice(0, 100) : '') };
  }
  let data;
  try { data = await res.json(); } catch { return { ok: false, error: 'bad activation response' }; }
  // The business_id check: a key bought from any other Dodo seller must
  // not unlock Pro here.
  if (!data || data.business_id !== DODO_BUSINESS_ID) {
    return { ok: false, error: 'this key was not sold by Comic Translate 4 Free' };
  }
  const instanceId = data.license_key_instance_id || data.instance_id;
  if (!instanceId) return { ok: false, error: 'bad activation response (no instance id)' };
  const { updateSettingsField } = await import('./settings.js');
  await updateSettingsField('proLicenseKey', licenseKey);
  await updateSettingsField('proInstanceId', String(instanceId));
  await updateSettingsField('proActive', true);
  await updateSettingsField('proLastCheck', Date.now());
  return { ok: true };
}

// Re-validate the stored license against Dodo. Updates proActive/proLastCheck.
// Returns { ok: true, valid } or { ok: false, error }.
export async function validateProLicense(settings) {
  const key = settings && settings.proLicenseKey;
  const instanceId = settings && settings.proInstanceId;
  if (!key || !instanceId) return { ok: false, error: 'no license' };
  let res;
  try {
    res = await fetch(DODO_VALIDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: key, license_key_instance_id: instanceId }),
    });
  } catch (e) {
    return { ok: false, error: 'network error: ' + String((e && e.message) || e).slice(0, 100) };
  }
  if (!res.ok) return { ok: false, error: 'validate failed (HTTP ' + res.status + ')' };
  let data;
  try { data = await res.json(); } catch { return { ok: false, error: 'bad validate response' }; }
  const valid = !!(data && data.valid);
  const { updateSettingsField } = await import('./settings.js');
  await updateSettingsField('proActive', valid);
  await updateSettingsField('proLastCheck', Date.now());
  return { ok: true, valid };
}

// Deactivate the stored license (frees an activation slot) and clear it.
export async function deactivateProLicense(settings) {
  const key = settings && settings.proLicenseKey;
  const instanceId = settings && settings.proInstanceId;
  if (key && instanceId) {
    try {
      await fetch(DODO_DEACTIVATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: key, license_key_instance_id: instanceId }),
      });
    } catch {}
  }
  const { updateSettingsField } = await import('./settings.js');
  await updateSettingsField('proLicenseKey', '');
  await updateSettingsField('proInstanceId', '');
  await updateSettingsField('proActive', false);
  await updateSettingsField('proLastCheck', 0);
  return { ok: true };
}
