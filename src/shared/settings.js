// Shared settings: defaults + storage access. Importable in SW, offscreen, UI pages.
// (Content scripts use chrome.storage directly via messaging to avoid duplication.)

export const DEFAULT_SETTINGS = {
  sourceLang: 'auto', // 'auto' = detect from the OCR'd text; or 'ja' | 'en' | 'zh-CN' | 'zh-TW'
  targetLang: 'en', // static fallback only — with no stored value, readSettingsRaw()/getSettings() use the browser language instead (browserTargetLang, below)
  translationBackend: 'google', // 'google' | 'azure' | 'gemini' | 'lmstudio' | 'local-llm'
  backendFailover: true, // if the selected backend fails, try another (default on, 2026-10-26)
  azureKey: '',
  azureRegion: '',
  azureRetireDismissed: false, // Azure retirement notice: once dismissed, never show it again (2.2.17)
  azureRetireUpdateShown: false, // Azure retirement notice: shown once after an update to users already on Azure (2.3.1)
  geminiApiKey: '', // Google AI Studio key for the Gemini backend (gemini-3.5-flash-lite, 500 req/day free)
  lmStudioUrl: 'http://127.0.0.1:1234', // LM Studio server (bare host:port; flavour adds its path)
  lmStudioKey: '',
  lmStudioApi: 'lmstudio-v1', // 'openai' | 'lmstudio-v1' (LM Studio REST)
  lmStudioModelId: '', // auto-managed: loaded model id for the v1 flavour (no UI)
  localLlmModel: 'SmolLM2-1.7B-Instruct-q4f16_1-MLC',
  debugMode: false,
  detectionThreshold: 0.3,
  minImageSize: 460, // skip images smaller than this (max dimension, px)
  siteWhitelist: [], // hostnames with site access, e.g. ['example.com']
  allowAllSites: false, // site access: translate on any site (requests <all_urls> when enabled)
  autoTranslateOnLoad: true, // start the pipeline automatically on allowed page loads
  pretranslateNextPage: true, // after a run finishes, translate the next page's single picture in the background into the page cache
  playDing: true, // play a chime when a translation finishes (toggle in Settings)
  // Pro (freemium, Dodo Payments license keys): free is 50 auto/pre-translate
  // images/day; Pro is unlimited. Manual translate is always free.
  proLicenseKey: '', // Dodo license key, entered by the user in Settings
  proInstanceId: '', // Dodo license instance id, from activation
  proActive: false, // last validation said valid (re-checked at most once a day)
  proLastCheck: 0, // timestamp (ms) of the last Dodo validation
};

export const LANGS = [
  ['ja', 'Japanese'], ['en', 'English'], ['zh-CN', 'Chinese (Simplified)'],
  ['zh-TW', 'Chinese (Traditional)'],
];

// Native names for the source-language dropdowns in popup/options UI.
export const NATIVE_LANGS = [
  ['ja', '日本語'], ['en', 'English'], ['zh-CN', '简体中文'],
  ['zh-TW', '繁體中文'],
];

// Every language both Google Translate and Azure Translator support
// (intersection verified 2026-09-28). Google-style codes, matching LANGS.
export const TARGET_LANGS = [

  ['en', 'English'],
  ['af', 'Afrikaans'],
  ['sq', 'Albanian'],
  ['am', 'Amharic'],
  ['ar', 'Arabic'],
  ['hy', 'Armenian'],
  ['as', 'Assamese'],
  ['az', 'Azerbaijani'],
  ['ba', 'Bashkir'],
  ['eu', 'Basque'],
  ['bn', 'Bengali'],
  ['bho', 'Bhojpuri'],
  ['bs', 'Bosnian'],
  ['bg', 'Bulgarian'],
  ['yue', 'Cantonese'],
  ['ca', 'Catalan'],
  ['ny', 'Chichewa'],
  ['zh-CN', 'Chinese (Simplified)'],
  ['zh-TW', 'Chinese (Traditional)'],
  ['hr', 'Croatian'],
  ['cs', 'Czech'],
  ['da', 'Danish'],
  ['dv', 'Divehi'],
  ['doi', 'Dogri'],
  ['nl', 'Dutch'],
  ['et', 'Estonian'],
  ['fj', 'Fijian'],
  ['fil', 'Filipino'],
  ['fi', 'Finnish'],
  ['fr', 'French'],
  ['fr-CA', 'French (Canada)'],
  ['gl', 'Galician'],
  ['ka', 'Georgian'],
  ['de', 'German'],
  ['el', 'Greek'],
  ['gu', 'Gujarati'],
  ['ht', 'Haitian Creole'],
  ['ha', 'Hausa'],
  ['he', 'Hebrew'],
  ['hi', 'Hindi'],
  ['hu', 'Hungarian'],
  ['is', 'Icelandic'],
  ['ig', 'Igbo'],
  ['id', 'Indonesian'],
  ['ga', 'Irish'],
  ['it', 'Italian'],
  ['ja', 'Japanese'],
  ['kn', 'Kannada'],
  ['kk', 'Kazakh'],
  ['km', 'Khmer'],
  ['rw', 'Kinyarwanda'],
  ['gom', 'Konkani'],
  ['ko', 'Korean'],
  ['ku', 'Kurdish (Kurmanji)'],
  ['ckb', 'Kurdish (Sorani)'],
  ['ky', 'Kyrgyz'],
  ['lo', 'Lao'],
  ['lv', 'Latvian'],
  ['lt', 'Lithuanian'],
  ['ln', 'Lingala'],
  ['lg', 'Luganda'],
  ['mk', 'Macedonian'],
  ['mai', 'Maithili'],
  ['mg', 'Malagasy'],
  ['ms', 'Malay'],
  ['ml', 'Malayalam'],
  ['mt', 'Maltese'],
  ['mi', 'Maori'],
  ['mr', 'Marathi'],
  ['mn', 'Mongolian'],
  ['my', 'Myanmar (Burmese)'],
  ['ne', 'Nepali'],
  ['nso', 'Northern Sotho'],
  ['nb', 'Norwegian'],
  ['or', 'Odia'],
  ['ps', 'Pashto'],
  ['fa', 'Persian'],
  ['pl', 'Polish'],
  ['pt', 'Portuguese'],
  ['pt-BR', 'Portuguese (Brazil)'],
  ['pt-PT', 'Portuguese (Portugal)'],
  ['pa', 'Punjabi'],
  ['ro', 'Romanian'],
  ['rn', 'Rundi'],
  ['ru', 'Russian'],
  ['sm', 'Samoan'],
  ['sr', 'Serbian'],
  ['st', 'Sesotho'],
  ['sn', 'Shona'],
  ['sd', 'Sindhi'],
  ['si', 'Sinhala'],
  ['sk', 'Slovak'],
  ['sl', 'Slovenian'],
  ['so', 'Somali'],
  ['es', 'Spanish'],
  ['sw', 'Swahili'],
  ['sv', 'Swedish'],
  ['ta', 'Tamil'],
  ['tt', 'Tatar'],
  ['te', 'Telugu'],
  ['th', 'Thai'],
  ['ti', 'Tigrinya'],
  ['tn', 'Tswana'],
  ['tr', 'Turkish'],
  ['tk', 'Turkmen'],
  ['uk', 'Ukrainian'],
  ['ur', 'Urdu'],
  ['ug', 'Uyghur'],
  ['uz', 'Uzbek'],
  ['vi', 'Vietnamese'],
  ['cy', 'Welsh'],
  ['xh', 'Xhosa'],
  ['yo', 'Yoruba'],
  ['zu', 'Zulu'],
];

// Map a browser UI locale (e.g. 'zh-TW', 'en-US', 'pt-BR') to the nearest
// supported target language. Exact match first, then the Traditional/Simplified
// Chinese regions, then the base language ('es-MX' -> 'es'); anything unknown
// falls back to English. Pure function, so the harness can test it.
export function targetLangForLocale(locale) {
  if (!locale || typeof locale !== 'string') return 'en';
  const tag = locale.trim();
  if (!tag) return 'en';
  const codes = TARGET_LANGS.map(([c]) => c);
  const exact = codes.find(c => c === tag) || codes.find(c => c.toLowerCase() === tag.toLowerCase());
  if (exact) return exact;
  // Script forms: zh-Hant(-TW/-HK) is Traditional, zh-Hans(-CN/-SG) is
  // Simplified. (Without this, zh-Hant fell through to the base 'zh' and
  // wrongly became Simplified.)
  if (/^zh-Hant/i.test(tag)) return 'zh-TW';
  if (/^zh-Hans/i.test(tag)) return 'zh-CN';
  // Chinese regions: TW/HK/MO read Traditional, CN/SG read Simplified.
  if (/^zh-(TW|HK|MO)$/i.test(tag)) return 'zh-TW';
  if (/^zh-(CN|SG)$/i.test(tag)) return 'zh-CN';
  const base = tag.split('-')[0].toLowerCase();
  // Browsers sometimes use a different code than the target list: 'iw' is
  // old Hebrew (list has 'he'), 'nn' is Norwegian Nynorsk (list has 'nb'
  // Bokmal). Javanese has no alias — neither 'jw' nor 'jv' is a target
  // language, so it stays English.
  const ALIASES = { iw: 'he', nn: 'nb' };
  if (ALIASES[base]) return ALIASES[base];
  const baseHit = codes.find(c => c.toLowerCase() === base);
  if (baseHit) return baseHit;
  if (base === 'zh') return 'zh-CN';
  return 'en';
}

// The browser's UI language as a target language. chrome.i18n is the
// extension API for it; navigator.language is the fallback (and the only
// one in a plain page context). Guarded for node, where neither exists.
export function browserTargetLang() {
  let locale = '';
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage) locale = chrome.i18n.getUILanguage();
  } catch { /* fall through to navigator */ }
  if (!locale) {
    try { if (typeof navigator !== 'undefined' && navigator.language) locale = navigator.language; } catch { /* fall through */ }
  }
  return targetLangForLocale(locale);
}

// Raw settings read: merged with defaults, no migrations or validation.
// Use for UI reads; getSettings() below is the validated pipeline read.
export async function readSettingsRaw() {
  const stored = await chrome.storage.local.get('settings');
  const s = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  // No stored target language (fresh install): default to the browser
  // language. A stored value — the user's own choice — always wins.
  if (!stored.settings || !stored.settings.targetLang) s.targetLang = browserTargetLang();
  return s;
}

// Serialized settings write: read-modify-write chained so concurrent
// callers don't clobber each other (the translators.js lmStudioModelId
// write-back raced the popup's writes before this).
// NOTE: the chain is per-JS-context — the SW, popup, and options page each
// have their own. Concurrent writes from DIFFERENT contexts can still race.
// Keep full-patch writes rare (user-initiated saves); hot single-field
// write-backs should use updateSettingsField() below.
let settingsWriteChain = Promise.resolve();
export function updateSettings(patch) {
  const w = settingsWriteChain.then(async () => {
    const s = await readSettingsRaw();
    await chrome.storage.local.set({ settings: { ...s, ...patch } });
  }).catch(() => {});
  settingsWriteChain = w;
  return w;
}

// Single-field write-back for cross-context hot paths (e.g. translators.js
// persisting the discovered lmStudioModelId while the popup may be saving).
// Reads fresh at write time and changes ONLY that field, so at worst we
// overwrite with near-current data instead of a stale snapshot.
export async function updateSettingsField(key, value) {
  const s = await readSettingsRaw();
  await chrome.storage.local.set({ settings: { ...s, [key]: value } });
}

export async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  const s = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  // No stored target language (fresh install): default to the browser
  // language, same as readSettingsRaw. Not persisted — a stored value,
  // once the user picks one, always wins.
  if (!stored.settings || !stored.settings.targetLang) s.targetLang = browserTargetLang();
  // One-time migration: the default minimum image size dropped 600 -> 500
  // -> 460 (460 fits a 360px-wide phone page, whose picture displays at
  // 465px). Installs still sitting on an old default follow it; a value
  // the user deliberately chose is left alone.
  if (stored.settings && (stored.settings.minImageSize === 600 || stored.settings.minImageSize === 500)) {
    s.minImageSize = 460;
    chrome.storage.local.set({ settings: s }).catch(() => {});
  }
  // One-time migration (2026-09-28): Latin/Russian source languages were
  // removed. A stored sourceLang that's no longer offered falls back to
  // the default; the orphaned OCR models are deleted.
  // 'auto' must be in the offered set (source auto-detect, 2026-10-05):
  // without it the default itself fails validation and every getSettings()
  // writes storage, which re-fires onChanged -> infinite write loop.
  const offered = new Set(['auto', ...LANGS.map(([code]) => code)]);
  if (s.sourceLang && !offered.has(s.sourceLang)) {
    s.sourceLang = DEFAULT_SETTINGS.sourceLang;
    chrome.storage.local.set({ settings: s }).catch(() => {});
  }
  // Target languages are now the Google∩Azure intersection (2026-09-28).
  // A stored targetLang that's not in the list falls back to the browser language.
  if (s.targetLang && !TARGET_LANGS.some(([code]) => code === s.targetLang)) {
    s.targetLang = browserTargetLang();
    chrome.storage.local.set({ settings: s }).catch(() => {});
  }
  // Prune removed models. Tracks which IDs were pruned so newly added
  // removals are picked up on installs where an earlier prune already ran.
  try {
    const { PRUNED_MODEL_IDS, pruneModelIds } = await import('./model-specs.js');
    const doneIds = Array.isArray(s._prunedModelIds) ? s._prunedModelIds : [];
    const pending = PRUNED_MODEL_IDS.filter(id => !doneIds.includes(id));
    if (pending.length) {
      await pruneModelIds(pending);
      s._prunedModelIds = [...new Set([...doneIds, ...pending])];
      chrome.storage.local.set({ settings: s }).catch(() => {});
    }
  } catch { /* best effort */ }
  // Safety-net clamps (mirrors options.js validNum): stored values are
  // trusted, but a corrupt write must never produce NaN thresholds or
  // absurd sizes downstream. No storage write here — just sanitize the read.
  const clamp = (v, lo, hi, fb) => Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;
  s.detectionThreshold = clamp(+s.detectionThreshold, 0.05, 0.9, DEFAULT_SETTINGS.detectionThreshold);
  s.minImageSize = Math.round(clamp(+s.minImageSize, 100, 4000, DEFAULT_SETTINGS.minImageSize));
  // One-time migration (2026-09-30, fixed 2026-11-23): the Local LLM
  // (WebLLM) backend does not work and is hidden from the UI. A stored
  // 'local-llm' backend migrates to Google once, with a write-back, so
  // opening Settings no longer silently converts it on every save.
  if (s.translationBackend === 'local-llm') {
    s.translationBackend = 'google';
    chrome.storage.local.set({ settings: s }).catch(() => {});
  }
  // 2.2.12: validate the backend too — a corrupt/retired stored value used
  // to pass through, leaving the popup's backend dropdown blank and the
  // pipeline with an unknown backend string.
  const VALID_BACKENDS = ['google', 'azure', 'gemini', 'lmstudio', 'local-llm'];
  if (!VALID_BACKENDS.includes(s.translationBackend)) s.translationBackend = DEFAULT_SETTINGS.translationBackend;
  return s;
}
