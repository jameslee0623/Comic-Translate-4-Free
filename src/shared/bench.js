// Benchmark log: one entry per finished pipeline run (full run only —
// cache hits are ~1s and not comparable, so they are not recorded).
// Stored in chrome.storage.local under BENCH_KEY, capped at BENCH_MAX
// entries (oldest dropped). The Settings Debug section copies the log
// as a Markdown table for future benchmarking (compare runs across
// builds, devices, and fixes).
export const BENCH_KEY = 'ct-bench-log';
export const BENCH_MAX = 100;

// One entry: t = ISO timestamp, v = extension version, br = browser
// ('Firefox'/'Chrome'), host = image host, img = 'WxH', blk = text
// block count, ocr = OCR engine id, be = backend, tier = capture tier,
// then one ms number per pipeline stage. Missing stages are 0.
export async function recordBenchRun(entry) {
  try {
    const stored = await chrome.storage.local.get(BENCH_KEY);
    const arr = Array.isArray(stored[BENCH_KEY]) ? stored[BENCH_KEY] : [];
    arr.push(entry);
    await chrome.storage.local.set({ [BENCH_KEY]: arr.slice(-BENCH_MAX) });
  } catch { /* benchmark logging must never fail a run */ }
}

export async function readBenchLog() {
  try {
    const stored = await chrome.storage.local.get(BENCH_KEY);
    return Array.isArray(stored[BENCH_KEY]) ? stored[BENCH_KEY] : [];
  } catch { return []; }
}

export async function clearBenchLog() {
  try { await chrome.storage.local.remove(BENCH_KEY); } catch { /* ignore */ }
}

const num = v => (Number.isFinite(v) ? Math.round(v) : 0);

// Markdown table: one row per run, one column per stage, so runs can be
// compared side by side (before/after a fix, phone vs computer).
export function formatBenchTable(entries) {
  const head = '| Date | Ver | Browser | Host | Image | Blocks | OCR eng | Backend | Tier | Cap | Det | Blk | OCR | Tr | Mask | Inp | Ren | Total |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const rows = (entries || []).map(e => {
    const d = String(e.t || '').slice(0, 16).replace('T', ' ');
    return `| ${d} | ${e.v || ''} | ${e.br || ''} | ${e.host || ''} | ${e.img || ''} | ${num(e.blk)} | ${e.ocr || ''} | ${e.be || ''} | ${e.tier || ''} | ${num(e.cap)} | ${num(e.det)} | ${num(e.blkMs)} | ${num(e.ocrMs)} | ${num(e.tr)} | ${num(e.mask)} | ${num(e.inp)} | ${num(e.ren)} | ${num(e.total)} |`;
  });
  return [head, sep, ...rows].join('\n');
}
