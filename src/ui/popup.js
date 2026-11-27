// Popup: trigger runs, show progress, backend + language quick-switch, whitelist.
import { baseDomain, imageHostOrigins, originAccessPatterns, displayHost, hostOf, isSiteAllowed } from '../shared/site-access.js';
import { NATIVE_LANGS as LANGS, TARGET_LANGS, getSettings, updateSettings as writeSettings } from '../shared/settings.js';
import { PRO_FREE_DAILY_LIMIT, DODO_CHECKOUT_URL, getProUsageCount, proIsActive } from '../shared/pro.js';
import { CURRENT_PROMO, promoActive } from '../shared/promo.js';
const $ = id => document.getElementById(id);
// Escape for innerHTML interpolation (hostnames are DNS-safe, but explicit).
const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Stage labels come from i18n (stage_* keys), English fallback if missing.
const STAGE_LABEL = {
  idle: 'idle', capture: 'Capturing page…', detect: 'Detecting bubbles & text…',
  blocks: 'Assembling text blocks…', ocr: 'Reading text (OCR)…', mask: 'Building masks…',
  inpaint: 'Inpainting…', translate: 'Translating…', render: 'Rendering…',
  downloading: 'Downloading models…',
  done: 'Done', cancelled: 'Cancelled', error: 'Error',
};
for (const k of Object.keys(STAGE_LABEL)) {
  const m = ctMsg('stage_' + k);
  if (m) STAGE_LABEL[k] = m;
}

let currentHost = null;

function setStatus(s) {
  $('status').textContent = s || '';
}

function setProgress(p) {
  $('progress').style.width = Math.round((p || 0) * 100) + '%';
}

// Two buttons: "Translate this page" starts a run, "Cancel" stops one.
// Translate is disabled while a run is in flight; Cancel is disabled
// when idle — so a second run can't start and there's nothing to cancel.
// Translate is also disabled while the required models are still
// downloading (2.3.14): auto-download fetches them in the background, so
// the button just waits — no jump to the Models section.
// One tab at a time (2.3.85, James): the buttons depend on WHERE the run
// is, not just whether one exists. ownRunning = a foreground run on this
// tab; otherRunning = a foreground run on another tab (pre-translate never
// counts — it is a background job). Translate is disabled while either
// runs; Cancel is enabled while either runs, and reads "Cancel other tab"
// when the only run is elsewhere.
let ownRunning = false;
let otherRunning = false;
let modelsReady = true; // fail-open: only gray out when we positively know models are missing
// Pure button state, so the harness can test it without a DOM:
// returns {translateDisabled, cancelDisabled, cancelLabelKey}.
function computeButtonState(own, other, modelsOk) {
  return {
    translateDisabled: !!(own || other || !modelsOk),
    cancelDisabled: !(own || other),
    cancelLabelKey: (!own && other) ? 'cancel_other_tab' : 'cancel',
  };
}
function applyButtons() {
  const s = computeButtonState(ownRunning, otherRunning, modelsReady);
  $('translateBtn').disabled = s.translateDisabled;
  $('cancelBtn').disabled = s.cancelDisabled;
  $('cancelBtn').textContent = ctMsg(s.cancelLabelKey) ||
    (s.cancelLabelKey === 'cancel_other_tab' ? 'Cancel other tab' : 'Cancel');
}
// One-tab state, from the background (authoritative): which tab, if any,
// has a foreground run.
function setRunState(own, other) {
  ownRunning = !!own;
  otherRunning = !!other;
  applyButtons();
}

// The popup belongs to the tab it opened on: cache its id once, so the run
// state can tell "my tab's run" from "another tab's run" (2.3.85).
let popupTabId = null;
async function refreshPopupTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null]);
  popupTabId = tab ? tab.id : null;
}

// Model gate (2.3.14): ask the background which model groups are
// downloaded. Unknown (background unreachable) leaves the button alone —
// the run's own model-ready gate waits for the models instead.
async function refreshModelsReady() {
  const r = await bgMessage({ type: 'ct/get-models' });
  if (!r || !r.ok || !Array.isArray(r.models)) return;
  const ready = r.models.every(g => g.downloaded && !g.sizeMismatch);
  if (ready === modelsReady) return;
  modelsReady = ready;
  applyButtons();
  if (!ready) setStatus(ctMsg('models_downloading_auto') || 'Models are downloading automatically');
}

function fillLangs() {
  const autoLabel = ctMsg('source_auto') || 'Auto-detect';
  $('sourceLang').innerHTML = [`<option value="auto">${autoLabel}</option>`,
    ...LANGS.map(([c, n]) => `<option value="${c}">${ctLangName(c, n)}</option>`)].join('');
  $('targetLang').innerHTML = TARGET_LANGS.map(([c, n]) => `<option value="${c}">${ctLangName(c, n)}</option>`).join('');
}

async function saveLang(key, value) {
  markDirty(key);
  await writeSettings({ [key]: value });
}

// All popup settings writes go through this chain. Concurrent
// read-modify-write cycles would otherwise clobber each other: two quick
// dropdown changes → the second get() returns pre-first-set() state → the
// first change is silently lost ("needs multiple tries").

let lastStatus = null;

// ---- init race guards ----
// refreshSettings() is async and can finish AFTER the user has already used a
// control. Two hazards:
//  1. A dropdown the user already changed: re-setting .value from the stale
//     storage read snaps their pick back ("needs 2 tries").
//  2. A control the user is interacting with right now (focused / dropdown
//     open): re-setting its value mid-interaction disrupts the native widget.
// During init the user's value wins; after init, storage wins (cross-page
// sync). A focused control is never stomped.
let initDone = false;
const initDirty = new Set();
function markDirty(id) { if (!initDone) initDirty.add(id); }
function keepUserValue(id) {
  const el = $(id);
  return (!initDone && initDirty.has(id)) || (el && document.activeElement === el);
}
// The background thread can be unresponsive while a pipeline runs — on
// Firefox, WASM inpaint blocks the background page's main thread, so a
// sendMessage may not resolve for tens of seconds. Time out fast so the
// popup stays usable; the 3s interval retries.
function bgMessage(msg, timeoutMs = 2500) {
  return Promise.race([
    chrome.runtime.sendMessage(msg).catch(() => null),
    new Promise(r => setTimeout(() => r(null), timeoutMs)),
  ]);
}
async function refreshStatus() {
  const st = await bgMessage({ type: 'ct/get-status', ...(popupTabId != null ? { tabId: popupTabId } : {}) });
  if (st && st.ok) {
    const s = st.status;
    lastStatus = s;
    setStatus(STAGE_LABEL[s.stage] || s.stage);
    // While models are still downloading, the status says so — the 3s
    // tick must not wipe it back to the idle stage label.
    if (!modelsReady) setStatus(ctMsg('models_downloading_auto') || 'Models are downloading automatically');
    setProgress(s.progress);
    // Never wipe an error here: a failed click shows its error via the
    // message response just before this refresh runs. Only ever set.
    if (s.error) $('error').textContent = s.error;
    const isRunning = s.stage && !['done', 'idle', 'error', 'cancelled'].includes(s.stage);
    // Authoritative one-tab state from the background; fall back to the
    // stage-derived flag when the background predates it.
    const own = (st.ownTabRunning !== undefined) ? st.ownTabRunning : isRunning;
    setRunState(own, !!st.otherTabRunning);
  }
}

async function refreshSettings() {
  const settings = await getSettings();
  // Reconcile the allow-all-sites flag with the real <all_urls> permission.
  // The permission prompt steals focus and can close the popup, killing this
  // JS context before permissions.request() resolves — the grant then never
  // reaches storage, so the checkbox looks off on the next open even though
  // the permission was granted (the "needs multiple tries" bug). The
  // permission itself is the source of truth; fix storage to match it.
  // The write below only fires on mismatch, so the storage.onChanged echo
  // re-running refreshSettings() terminates after one extra pass.
  try {
    const has = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    if (settings && !!settings.allowAllSites !== has) {
      // Re-read before writing: the object captured above can go stale
      // during the permissions.contains await. Merge only the reconciled
      // flag into fresh state so a stale write can't clobber a
      // concurrent change.
      const fresh = await getSettings();
      await chrome.storage.local.set({ settings: { ...(fresh || {}), allowAllSites: has } });
    }
  } catch { /* permissions API unavailable — leave storage alone */ }
  if (settings) {
    azureRetireDismissed = !!(settings && settings.azureRetireDismissed);
    // Never stomp a control the user already set or is using (see the init
    // race guards above): during init their pick wins, and a focused control
    // keeps its value so an open dropdown isn't disrupted mid-interaction.
    if (!keepUserValue('backend') && settings.translationBackend) $('backend').value =
      settings.translationBackend === 'local-llm' ? 'google' : settings.translationBackend;
    if (!keepUserValue('sourceLang') && settings.sourceLang) $('sourceLang').value = settings.sourceLang;
    if (!keepUserValue('targetLang')) {
      if (settings.targetLang && TARGET_LANGS.some(([c]) => c === settings.targetLang)) $('targetLang').value = settings.targetLang;
      else $('targetLang').value = 'en';
    }
  }
  // Azure retirement notice (2.3.1): users already on Azure never touch the
  // dropdown, so the interaction triggers never fire for them. Show the
  // notice once, the first time the popup opens with Azure selected, then
  // remember it so it never nags again. Dismissed users never see it.
  // Runs on every refreshSettings call, but the flag makes it fire once —
  // the storage echo re-running this function sees the flag and skips.
  if (settings && settings.translationBackend === 'azure' && !settings.azureRetireDismissed && !settings.azureRetireUpdateShown) {
    await writeSettings({ azureRetireUpdateShown: true }).catch(() => {});
    showAzureRetireModal();
  }
  initDone = true;
  await refreshSite(settings || {});
}

// Pro (freemium) status line: free usage today, or Pro. The link opens
// Settings (Pro section) — or the Dodo checkout once James sets it up.
async function refreshPro() {
  const statusEl = $('proStatus'), linkEl = $('proLink'), rowEl = $('proRow');
  if (!statusEl) return;
  const settings = await getSettings().catch(() => ({}));
  const active = proIsActive(settings);
  if (active) {
    // Subscribed: hide the whole Pro row — no usage line, no Get Pro.
    if (rowEl) rowEl.style.display = 'none';
    return;
  }
  if (rowEl) rowEl.style.display = '';
  const used = await getProUsageCount();
  statusEl.textContent = 'Free: ' + used + ' / ' + PRO_FREE_DAILY_LIMIT + ' auto images today';
  if (linkEl) {
    linkEl.style.display = '';
    linkEl.onclick = e => {
      e.preventDefault();
      if (DODO_CHECKOUT_URL && !DODO_CHECKOUT_URL.startsWith('REPLACE')) chrome.tabs.create({ url: DODO_CHECKOUT_URL });
      else chrome.runtime.openOptionsPage();
    };
  }
}

// Promo banner (2.4.14, 2.4.15): the active promo from src/shared/promo.js.
// Shows to ALL users (free and Pro) while the promo is live
// (begin <= now < end, local time), so it launches by itself at begin
// and changes back by itself at end. The text comes from the
// promo_* locale keys, with the code and discount from the promo ($1).
async function refreshPromo() {
  const banner = $('promoBanner'), btn = $('promoBtn');
  if (!banner) return;
  if (!promoActive(CURRENT_PROMO, new Date())) { banner.style.display = 'none'; return; }
  const title = $('promoTitle'), body = $('promoBody');
  if (title) title.textContent = ctMsg('promo_title', [String(CURRENT_PROMO.discount)]) || title.textContent;
  if (body) body.textContent = ctMsg('promo_body', [CURRENT_PROMO.code]) || body.textContent;
  if (btn) btn.textContent = ctMsg('promo_button', [String(CURRENT_PROMO.discount)]) || btn.textContent;
  banner.style.display = '';
  if (btn) {
    btn.onclick = async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(CURRENT_PROMO.code);
        else {
          const ta = document.createElement('textarea');
          ta.value = CURRENT_PROMO.code;
          ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
      } catch {}
      if (DODO_CHECKOUT_URL && !DODO_CHECKOUT_URL.startsWith('REPLACE')) chrome.tabs.create({ url: DODO_CHECKOUT_URL });
      else chrome.runtime.openOptionsPage();
    };
  }
}

// Full refresh: status + settings. The 3s interval only needs the status
// part — rewriting the settings dropdowns on every tick stomps the user's
// in-progress selection (the open language list collapses), so settings
// controls update only here, at init, and on real storage changes.
async function refresh() {
  // Status and settings load in parallel: a hung status (blocked background)
  // must not delay the settings UI.
  await Promise.all([refreshStatus(), refreshSettings(), refreshPro(), refreshPromo()]);
}

// The pictures often live on CDN hosts different from the page host; without
// permission for them the extension can't download the pictures' pixels.
// cachedImageHosts is filled in (best effort) when the popup opens, so the
// click handler below can build the full origin list SYNCHRONOUSLY — Firefox
// expires the click's user gesture across awaits, and permissions.request()
// called after an await silently does nothing. It is a LIST, not one host:
// a page's pictures can span several hosts/CDNs, and the grant must cover
// all of them — the background-tab fallback injects into a tab on the
// picture's host, so a host missing from the grant fails there with
// "Missing host permission for the tab".
let cachedImageHosts = [];
// A granted `*://host/*` satisfies the query, but be lenient like
// hasHostAccess in the service worker: scheme-specific grants count too.
async function hasOriginAccess(host) {
  // Accept an exact-host grant OR a base-domain grant (covers random
  // per-visit subdomains); existing exact grants keep working.
  for (const p of originAccessPatterns(host)) {
    if (await chrome.permissions.contains({ origins: [p] }).catch(() => false)) return true;
  }
  return false;
}
function requestSiteAccessNow(host) {
  const origins = [`*://${host}/*`, `*://*.${host}/*`];
  // Every picture host gets the base-domain treatment: hosts with random
  // per-visit subdomains (e.g. *.hath.network) would otherwise need a fresh
  // grant on every visit.
  for (const ih of cachedImageHosts) {
    if (ih && ih !== host) origins.push(...imageHostOrigins(ih));
  }
  if (chrome.permissions && chrome.permissions.request) {
    return chrome.permissions.request({ origins }).catch(() => false);
  }
  return Promise.resolve(false);
}

async function refreshSite(settings) {  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null]);
  currentHost = tab ? hostOf(tab.url) : null;
  // Learn the page pictures' hosts now (not on click) so the grant click can
  // request them without any awaits first — pictures often live on CDN hosts
  // different from the page host, and the pipeline's download tier (plus the
  // background-tab fallback, which injects into a tab on the picture's host)
  // needs permission for them. Awaited here: this is popup-open time, not a
  // click gesture, so awaits are fine. Prefer the full host list; fall back
  // to the single main picture's host if the list message is unavailable.
  // Also merge in the hosts the worker recorded as failing with "Missing
  // host permission for the tab" (ct-missing-hosts): the content-script
  // list alone can miss them (old content script in the tab, or a host that
  // only appears on a later picture), and a run that partly succeeds never
  // sets lastStatus.grantHost — without this the popup never offers the
  // grant and those pictures keep failing.
  cachedImageHosts = [];
  if (tab && tab.id != null) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'ct/list-image-hosts' }).catch(() => null);
      if (r && r.ok && Array.isArray(r.hosts)) {
        cachedImageHosts = r.hosts.filter(h => h && h !== currentHost);
      }
    } catch { /* content script not injected yet — page host is enough to try */ }
    if (!cachedImageHosts.length) {
      try {
        const r = await chrome.tabs.sendMessage(tab.id, { type: 'ct/find-image' }).catch(() => null);
        const src = r && r.image && r.image.src;
        if (src && /^https?:\/\//i.test(src)) {
          const ih = new URL(src).hostname.toLowerCase();
          if (ih && ih !== currentHost) cachedImageHosts = [ih];
        }
      } catch { /* content script not injected yet — page host is enough to try */ }
    }
  }
  try {
    const got = await chrome.storage.local.get('ct-missing-hosts');
    const missing = Array.isArray(got['ct-missing-hosts']) ? got['ct-missing-hosts'] : [];
    for (const h of missing) {
      const lh = String(h || '').toLowerCase();
      if (lh && lh !== currentHost && !cachedImageHosts.includes(lh)) cachedImageHosts.push(lh);
    }
  } catch { /* no recorded hosts — the content-script list is enough */ }
  // The last failed run (the permission gate) named EVERY host that needs a
  // grant, not just the first. Merge the full list in so the one grant click
  // covers every picture on the page — ask once, not once per host.
  if (lastStatus && Array.isArray(lastStatus.grantHosts)) {
    for (const h of lastStatus.grantHosts) {
      const lh = String(h || '').toLowerCase();
      if (lh && lh !== currentHost && !cachedImageHosts.includes(lh)) cachedImageHosts.push(lh);
    }
  }
  const list = settings.siteWhitelist || [];
  const btn = $('whitelistBtn');
  if (!currentHost) {
    $('site').innerHTML = ctMsg('no_site') || 'no site detected';
    btn.disabled = true;
    btn.classList.remove('remind');
    return;
  }
  const allowAll = !!settings.allowAllSites;
  const ok = allowAll || isSiteAllowed(currentHost, list);
  const hostHtml = `<b>${escHtml(currentHost)}</b>`;
  const statusHtml = allowAll
    ? `<span class="ok">${ctMsg('all_sites_on') || 'all sites allowed ✓'}</span>`
    : ok
      ? `<span class="ok">${ctMsg('whitelisted') || 'allowed ✓'}</span>`
      : `<span class="warn">${ctMsg('not_whitelisted') || 'not allowed'}</span>`;
  // site_this = "this site: $HOST$ — $STATUS$" (word order localized per locale)
  $('site').innerHTML = ctMsg('site_this', [hostHtml, statusHtml]) || `this site: ${hostHtml} — ${statusHtml}`;
  if (allowAll) {
    // Per-site allow/disallow is meaningless when every site is allowed.
    btn.style.display = 'none';
  } else {
    btn.style.display = '';
    btn.textContent = ctMsg(ok ? 'whitelist_remove' : 'whitelist_add') || (ok ? 'Disallow this site' : 'Allow this site');
    btn.disabled = false;
    // Light the button up until the site is allowed — it's the reminder.
    btn.classList.toggle('remind', !ok);
  }
  // Allowed but missing host access: offer the one-click grant. This covers
  // BOTH the page host (needed for script injection) and the pictures' hosts
  // (needed for the download tier and the background-tab fallback) — the
  // pictures often live on CDNs. After the first grant the content script
  // can inject, so the picture hosts become known and a second click covers
  // them; the row stays visible until all are granted, naming whichever host
  // is still missing. A page's pictures can span several hosts, so check
  // every one; the click grants all of them at once.
  const grantRow = $('grantRow');
  grantRow.style.display = 'none';
  if (ok && currentHost && chrome.permissions && chrome.permissions.contains) {
    const pageHas = await hasOriginAccess(currentHost);
    let missingHost = null;
    for (const ih of cachedImageHosts) {
      if (!(await hasOriginAccess(ih))) { missingHost = ih; break; }
    }
    const missing = !pageHas ? currentHost : missingHost;
    if (missing) {
      grantRow.style.display = '';
      // Name the base domain for a picture's host: the exact hostname is
      // random per visit on some sites, and the grant covers the base.
      const missingLabel = (missing === missingHost) ? displayHost(missing) : missing;
      $('grantBtn').textContent = ctMsg('grant_access_to', [missingLabel]) || `Grant access to ${missingLabel}`;
      $('grantBtn').onclick = () => {
        // Request synchronously in the click: no awaits before
        // permissions.request() or Firefox drops the user gesture.
        requestSiteAccessNow(currentHost).then(() => {
          refreshSite(settings);
          // Re-register + inject the content script now, so the
          // right-click unlock works without a refresh.
          try { chrome.runtime.sendMessage({ type: 'ct/sync-auto-start' }).catch(() => {}); } catch {}
        });
      };
    }
  }
  // The last failed run named the exact image host that needs a grant (the
  // pill's one-click grant can't work on Firefox — the content-script click
  // gesture doesn't reach the worker — so it points here). Offer it directly;
  // more reliable than the find-image heuristic above. The click grants ALL
  // hosts the run needs (requestSiteAccessNow covers every host in
  // cachedImageHosts, which now includes the run's full grantHosts list) —
  // one ask for every picture, not one ask per host.
  if (grantRow.style.display === 'none' && lastStatus && lastStatus.stage === 'error' &&
      lastStatus.grantHost && chrome.permissions && chrome.permissions.request) {
    const gh = lastStatus.grantHost;
    if (!(await hasOriginAccess(gh).catch(() => true))) {
      const gl = lastStatus.grantLabel || displayHost(gh);
      grantRow.style.display = '';
      $('grantBtn').textContent = ctMsg('grant_access_to', [gl]) || `Grant access to ${gl}`;
      $('grantBtn').onclick = () => {
        // Synchronous in the click — no awaits before permissions.request().
        // requestSiteAccessNow grants the page host plus every picture host
        // in cachedImageHosts (including the failed run's full grantHosts).
        requestSiteAccessNow(currentHost).then(() => {
          refreshSite(settings);
          // Re-register + inject the content script now, so the
          // right-click unlock works without a refresh.
          try { chrome.runtime.sendMessage({ type: 'ct/sync-auto-start' }).catch(() => {}); } catch {}
        });
      };
    }
  }
  btn.onclick = () => {
    const wl = new Set(settings.siteWhitelist || []);
    const granting = !isSiteAllowed(currentHost, [...wl]);
    if (granting) {
      // Optimistic list write FIRST, without awaiting: the permission prompt
      // can close the popup and kill this context before the .then() below
      // runs (same hazard as the allow-all-sites checkbox). The intent must
      // already be in storage. Denial rolls it back below.
      wl.add(currentHost);
      chrome.storage.local.set({
        settings: { ...settings, siteWhitelist: [...wl] },
      }).catch(() => {});
    }
    // Granting host access here (a user gesture) lets auto-translate and
    // full-resolution image fetch work on this site without further clicks.
    // The permission request must run synchronously in the click turn — no
    // awaits before permissions.request() or Firefox drops the transient
    // activation and the prompt silently never fires.
    let req = null;
    if (granting) {
      try { req = requestSiteAccessNow(currentHost); } catch { /* keep going */ }
    }
    Promise.resolve(req).catch(() => false).then(async granted => {
      // Re-read: the optimistic write above (or a Settings-page edit) may
      // have moved the list since this handler ran.
      let cur = null;
      try { (cur = await getSettings()); } catch { /* keep going */ }
      const wl2 = new Set((cur && cur.siteWhitelist) || []);
      if (granting) {
        if (!granted) wl2.delete(currentHost); // denied: roll back the optimistic add
        else wl2.add(currentHost);
      } else for (const e of [...wl2]) {
        const w = String(e).toLowerCase();
        if (currentHost === w || currentHost.endsWith('.' + w)) wl2.delete(e);
      }
      const next = { ...(cur || {}), siteWhitelist: [...wl2] };
      await writeSettings({ siteWhitelist: next.siteWhitelist });
      refreshSite(next);
      try { chrome.runtime.sendMessage({ type: 'ct/sync-auto-start' }).catch(() => {}); } catch {}
    });
  };
}

$('cancelBtn').onclick = async () => {
  // 2.2.12: send the active tab's id so the worker cancels only that tab's
  // run — the old message had no tab, so the worker cancelled every tab's
  // run (and the background pre-translate job too).
  // 2.3.85 (one tab at a time, James): when the only run is on ANOTHER tab
  // (Cancel reads "Cancel other tab"), send otherTabs:true so the worker
  // cancels that run instead of this tab's (which has none).
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null]);
  const other = !ownRunning && otherRunning;
  chrome.runtime.sendMessage({ type: 'ct/cancel-run', tabId: tab ? tab.id : undefined, ...(other ? { otherTabs: true } : {}) });
  // Re-read the state at once: the 3s tick would leave Translate grayed
  // out until then, even though the other run is already cancelled.
  refreshStatus().catch(() => {});
};

$('translateBtn').onclick = async () => {
  $('error').textContent = '';
  try {
    // Best-effort one-time permission so the worker can download the page's
    // picture at full resolution (covers the picture's host too).
    // Uses the host cached at popup-open: no awaits before
    // permissions.request(), so Firefox's transient activation survives and
    // the prompt actually fires.
    if (currentHost) await requestSiteAccessNow(currentHost);
  } catch { /* optional; the pipeline reports what it can't read */ }
  const r = await chrome.runtime.sendMessage({ type: 'ct/translate-page' }).catch(e => ({ ok: false, error: String(e) }));
  if (!r.ok) $('error').textContent = r.error;
  refresh();
};

$('backend').onchange = e => {
  markDirty('backend');
  writeSettings({ translationBackend: e.target.value }).catch(() => {});
  if (e.target.value === 'azure') showAzureRetireModal();
};

// Azure retirement notice (2.2.17): same message as Settings — picking
// Azure shows how to get a Gemini key. The dismissed flag is cached from
// refreshSettings; the buttons below keep it in sync.
let azureRetireDismissed = false;
function showAzureRetireModal() {
  if (azureRetireDismissed) return;
  const m = $('azureRetireModal');
  if (m) m.style.display = 'flex';
}
function hideAzureRetireModal() {
  const m = $('azureRetireModal');
  if (m) m.style.display = 'none';
}
$('azureRetireClose').onclick = hideAzureRetireModal;
$('azureRetireModal').onclick = e => { if (e.target === $('azureRetireModal')) hideAzureRetireModal(); };
$('azureRetireDismiss').onclick = () => {
  azureRetireDismissed = true;
  writeSettings({ azureRetireDismissed: true }).catch(() => {});
  hideAzureRetireModal();
};
$('azureRetireSettings').onclick = () => {
  try { chrome.runtime.openOptionsPage(); } catch { /* popup closes — nothing to do */ }
  hideAzureRetireModal();
};

// ---- translated page cache (same stats as the Settings page) ----
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

async function refreshCacheStats() {
  let st = { count: 0, bytes: 0 };
  try {
    const r = await bgMessage({ type: 'ct/page-cache-stats' });
    if (r && r.ok) st = r;
  } catch { /* background unreachable — show zeros */ }
  $('cacheInfo').textContent =
    ctMsg('pagecache_stats', [String(st.count), fmtBytes(st.bytes)]) ||
    `${st.count} images · ${fmtBytes(st.bytes)}`;
}

$('clearCacheBtn').onclick = async () => {
  const btn = $('clearCacheBtn');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = ctMsg('pagecache_clearing') || 'Clearing…';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'ct/clear-page-cache' });
    if (r && r.ok) {
      $('cacheInfo').textContent =
        ctMsg('pagecache_cleared', [String(r.count), fmtBytes(r.bytes)]) ||
        `Cache cleared (${r.count} images, ${fmtBytes(r.bytes)} freed)`;
      setTimeout(refreshCacheStats, 4000);
    } else {
      throw new Error((r && r.error) || 'unknown error');
    }
  } catch (e) {
    $('cacheInfo').textContent = `✗ ${String((e && e.message) || e).slice(0, 100)}`;
  }
  btn.textContent = old;
  btn.disabled = false;
};

$('sourceLang').onchange = e => saveLang('sourceLang', e.target.value);
$('targetLang').onchange = e => saveLang('targetLang', e.target.value);

// Sync with the Settings page (and any other settings writer): re-render when
// settings change elsewhere. Our own writes echo back through here too, but
// refreshSettings() only reads, so re-running it is harmless.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) refreshSettings().catch(() => {});
});

$('options').onclick = e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

chrome.runtime.onMessage.addListener(msg => {
  // A model download finishing (or failing) can flip the Translate gate.
  if (msg && msg.type === 'ct/model-progress') { refreshModelsReady(); return; }
  if (msg.type === 'ct/run-progress') {
    setStatus(STAGE_LABEL[msg.stage] || msg.stage);
    setProgress(msg.progress);
    if (msg.stage === 'error') {
      $('error').textContent = msg.error || 'unknown error';
      // A failed run may carry hosts that need a grant (the permission
      // gate). Re-check the grant row now so the button appears without
      // reopening the popup — refreshSite merges the run's grantHosts
      // into the grant list, so one click covers every picture.
      refreshStatus().then(async () => {
        const settings = await getSettings().catch(() => null);
        refreshSite(settings || {});
      }).catch(() => {});
    }
    else if (msg.stage === 'done') $('error').textContent = '';
    // Tab-aware fast path (2.3.85): the progress message carries the run's
    // tab, so the buttons update at once instead of waiting for the 3s
    // tick. The tick (refreshStatus) is the authority and reconciles.
    const progRunning = msg.stage && !['done', 'idle', 'error', 'cancelled'].includes(msg.stage);
    if (msg.tabId != null && popupTabId != null) {
      if (msg.tabId === popupTabId) setRunState(progRunning, otherRunning);
      else setRunState(ownRunning, progRunning);
    } else {
      // No tab info (old background): a running stage counts as this tab's.
      setRunState(progRunning, otherRunning);
    }
  }
});

ctApplyI18n();
fillLangs();
// Models auto-download (2.2.2): no first-run redirect to Settings any
// more — the install trigger fetches them, and a run that starts before
// they finish waits for them instead.
// Cache this tab's id first: refreshStatus needs it to split own/other runs.
refreshPopupTab().then(() => Promise.all([refresh(), refreshModelsReady()])).catch(() => {});
refreshCacheStats();
setInterval(refreshStatus, 3000);
