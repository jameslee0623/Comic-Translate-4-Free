// Content script: final render overlay + debug inspector panel.
// Injected on demand by the service worker when a run finishes a stage.
// Classic script (no modules) — everything lives in this file.
(function () {
  if (window.__ctContentLoaded) return;
  window.__ctContentLoaded = true;

  // 2.3.15/1.7.15: Vivaldi auto-translate trigger. This script is
  // registered for allowed sites (see syncAutoStartRegistrations in the
  // background), so the browser injects it on page load by itself — even
  // when the background worker wakes after the page loaded and misses
  // tabs.onUpdated 'complete'. On load, wake the background and ask for
  // an auto run; the background applies the same gates (auto off / tab
  // not active / dedupe / run in flight) and logs the same auto diag
  // lines, so this and the page-load listener can only fire once per
  // page. Top frame only: iframes must not start runs.
  if (window.top === window.self) {
    try { chrome.runtime.sendMessage({ type: 'ct/auto-start' }); } catch {}
    // Same-document URL change (reader "next" via history.pushState):
    // the URL changes but the document never reloads, so there is no
    // tabs.onUpdated 'complete' and no fresh content-script injection.
    // On Vivaldi Android that means auto-translate never starts for
    // the new page. Watch for URL changes and re-send AUTO_START.
    // Only the path matters (a hash change is the same page).
    let lastUrl = location.href.split('#')[0];
    const onUrlChange = () => {
      let u;
      try { u = location.href.split('#')[0]; } catch { return; }
      if (u === lastUrl) return;
      lastUrl = u;
      try { chrome.runtime.sendMessage({ type: 'ct/auto-start' }); } catch {}
    };
    const wrapHistory = (fn) => function (...args) {
      const r = fn.apply(this, args);
      try { onUrlChange(); } catch {}
      return r;
    };
    try {
      history.pushState = wrapHistory(history.pushState);
      history.replaceState = wrapHistory(history.replaceState);
    } catch {}
    window.addEventListener('popstate', onUrlChange);
  }

  const FONT_STACK = '"Noto Sans CJK JP","Hiragino Kaku Gothic ProN","Hiragino Sans","Yu Gothic","Noto Sans",sans-serif';

  // Anti-right-click override: some sites block the context menu
  // (document.addEventListener('contextmenu', e => e.preventDefault())),
  // which also blocks the extension's "Send to Comic Translate 4 Free"
  // item. When the user right-clicks a picture, stop the event in the
  // capture phase — before the page's bubble-phase blocker runs — so
  // the browser still shows its menu. stopPropagation() does NOT call
  // preventDefault(), so the browser's default action (show the menu)
  // still happens, and the browser builds the menu from the clicked
  // element, so the image item still appears. Scoped to pictures only
  // so other custom menus (text, background) keep working. Registered
  // here, at content-script load, so it is in place before the user
  // right-clicks — the worker injects this script on page load for
  // allowed sites for exactly this reason.
  function unblockImageContextMenu(e) {
    const t = e.target;
    if (!t) return;
    const img = t.tagName === 'IMG' ? t : (t.closest ? t.closest('img') : null);
    if (img) e.stopPropagation();
  }
  window.addEventListener('contextmenu', unblockImageContextMenu, true);

  // Browser canvas size guards (mirrors src/shared/image-ops.js renderScale —
  // this is a classic script, no modules, so the constants are duplicated).
  // Chrome ~16384px side, Firefox ~11180, Safari ~4096-8192.
  const MAX_RENDER_MP = 16;
  const MAX_RENDER_SIDE = 8192;
  function renderScale(w, h) {
    if (!(w > 0 && h > 0)) return 1;
    return Math.min(1,
      Math.sqrt(MAX_RENDER_MP * 1e6 / (w * h)),
      MAX_RENDER_SIDE / Math.max(w, h));
  }

  // ------------------------------------------------------------ text utils
  // Port of ogkalu2/comic-translate's shrink_bbox (Apache License 2.0,
  // https://github.com/ogkalu2/comic-translate): `pct` is the TOTAL shrink, applied
  // centered, i.e. pct/2 inset per side. shrink_bbox(b, 0.3) leaves 70% of
  // the bubble's width/height (15% per side), NOT 40% (30% per side).
  function shrinkBbox(xyxy, pct) {
    const [x1, y1, x2, y2] = xyxy;
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const w = (x2 - x1) * (1 - pct), h = (y2 - y1) * (1 - pct);
    if (w <= 0 || h <= 0) return [x1, y1, x2, y2];
    return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
  }

  // Port of get_best_render_area + adjust_blks_size: bubble interior (ogkalu2's
  // shrink_bbox with 0.3 = 30% total shrink, i.e. 15% inset per side), else
  // the text box; -5px each side except zh source.
  function renderAreaFor(block, srcLang) {
    let area = (block.text_class === 'text_bubble' && block.bubble_xyxy)
      ? shrinkBbox(block.bubble_xyxy, 0.3)
      : block.xyxy.slice();
    // 5px inset was for Latin source text (to avoid bubble outlines).
    // Don't apply it to CJK sources — vertical CJK in small bubbles
    // gets over-shrunk (e.g. 44px bubble -> 20px render width).
    const isCjkSrc = ['ja', 'zh-CN', 'zh-TW', 'ko'].includes(srcLang);
    if (!isCjkSrc) {
      area = [area[0] + 5, area[1] + 5, area[2] - 5, area[3] - 5];
    }
    return area;
  }

  const isCJK = s => /[\u3040-\u30ff\u4e00-\u9faf\uac00-\ud7af]/.test(s);

  function wrapGreedy(ctx, text, maxW) {
    // word wrap for spaced text, char wrap for CJK / long words
    const words = text.split(/(\s+)/).filter(t => t.length);
    const lines = [];
    let cur = '';
    const push = () => { if (cur) lines.push(cur); cur = ''; };
    for (const w of words) {
      if (/^\s+$/.test(w)) { cur += w; continue; }
      const trial = cur + w;
      if (ctx.measureText(trial).width <= maxW || !cur.trim()) {
        if (ctx.measureText(trial).width <= maxW) { cur = trial; continue; }
        // single word too long: char-break it
        push();
        let cw = '';
        for (const ch of w) {
          if (ctx.measureText(cw + ch).width > maxW && cw) { lines.push(cw); cw = ''; }
          cw += ch;
        }
        cur = cw;
      } else {
        push();
        cur = w;
      }
    }
    push();
    // CJK: also break lines that are still too wide, char by char
    const out = [];
    for (const line of lines) {
      if (ctx.measureText(line).width <= maxW || !isCJK(line)) { out.push(line); continue; }
      let cw = '';
      for (const ch of line) {
        if (ctx.measureText(cw + ch).width > maxW && cw) { out.push(cw); cw = ''; }
        cw += ch;
      }
      if (cw) out.push(cw);
    }
    return out.filter(l => l.length);
  }

  // Largest font size in [minSize, initSize] whose wrapped text fits.
  // Binary search (~7 iterations) replaces the old 0.75px linear scan (~40
  // iterations, each doing a full wrap + measure pass). "Fits" is monotonic
  // in size, so the search converges to the largest fitting size.
  function fitFont(ctx, text, rw, rh, initSize, minSize, vertical) {
    // Early exit: degenerate box — skip the binary search entirely.
    if (!(rw > 0 && rh > 0)) {
      const size = minSize;
      ctx.font = `${size}px ${FONT_STACK}`;
      return vertical
        ? { size, lines: wrapVertical(text, 1), lh: size * 1.18 }
        : { size, lines: [text], lh: size * 1.18 };
    }
    const fits = (size) => {
      // Cache the font string per size probe — wrapGreedy/wrapVertical call
      // measureText many times but the font only changes here.
      ctx.font = `${size}px ${FONT_STACK}`;
      const lh = size * 1.18;
      if (vertical) {
        // charsPerCol must be >= 1: rh < lh (tiny box) would give 0 and hang
        // wrapVertical forever on `i += 0`.
        const cols = wrapVertical(text, Math.max(1, Math.floor(rh / lh)));
        return { ok: cols.length * (size * 1.05) <= rw, lines: cols, lh };
      }
      const lines = wrapGreedy(ctx, text, rw);
      const maxW = lines.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
      return { ok: lines.length * lh <= rh && maxW <= rw, lines, lh };
    };
    let best = null;
    let lo = minSize, hi = initSize;
    // 10 iterations: 0.5px precision is enough (16 was overkill — each
    // iteration re-wraps and re-measures every line).
    for (let i = 0; i < 10 && hi - lo > 0.5; i++) {
      const mid = (lo + hi) / 2;
      const r = fits(mid);
      if (r.ok) { best = { size: mid, lines: r.lines, lh: r.lh }; lo = mid; }
      else hi = mid;
    }
    if (!best) {
      const size = minSize;
      ctx.font = `${size}px ${FONT_STACK}`;
      best = vertical
        ? { size, lines: wrapVertical(text, Math.max(1, Math.floor(rh / (size * 1.18)))), lh: size * 1.18 }
        : { size, lines: wrapGreedy(ctx, text, rw), lh: size * 1.18 };
    }
    return best;
  }

  function wrapVertical(text, charsPerCol) {
    const clean = text.replace(/\s+/g, '');
    const cols = [];
    for (let i = 0; i < clean.length; i += charsPerCol) cols.push(clean.slice(i, i + charsPerCol));
    return cols.length ? cols : [''];
  }

  function luminance(css) {
    const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(css || '');
    if (!m) return 0;
    return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
  }

  // Auto font size from the ORIGINAL text: estimate the glyph size the source
  // text was set in from its detector text box and character count (area
  // model: each glyph occupies ~size^2 * lineHeight). The render starts
  // from 1.2x this size (capped by the maximum, floored by the minimum)
  // and only shrinks until the translation fits the area.
  function estimateFontSize(block, maxSize, minSize) {
    const text = (block.text || '').replace(/\s+/g, '');
    const n = Math.max(1, [...text].length);
    const xy = block.xyxy || [0, 0, 0, 0];
    const w = Math.max(1, xy[2] - xy[0]), h = Math.max(1, xy[3] - xy[1]);
    let est = Math.sqrt((w * h) / (n * 1.18));
    if (!isFinite(est) || est <= 0) est = maxSize;
    return Math.min(maxSize, Math.max(minSize, est));
  }

  function drawBlock(ctx, block, srcLang, maxSize, minSize) {
    const text = (block.translation || block.text || '').trim();
    if (!text) return null;
    const area = renderAreaFor(block, srcLang);
    const [x1, y1, x2, y2] = area;
    const rw = Math.max(8, x2 - x1), rh = Math.max(8, y2 - y1);
    const vertical = isCJK(text) && rh > rw * 1.5;
    const autoSize = estimateFontSize(block, maxSize, minSize);
    // Start from 1.2x the estimated original size (not maxSize): the estimate
    // is approximate (box area + char count), so 1.2x gives headroom to reach
    // the original size. fitFont then shrinks until it fits the box.
    // Capped by maxSize, floored by minSize — "not too big nor too small".
    const startSize = Math.min(maxSize, Math.max(minSize, autoSize * 1.2));
    const { size, lines, lh } = fitFont(ctx, text, rw, rh, startSize, minSize, vertical);
    ctx.font = `${size}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fg = block.font_color || '#000000';
    const outline = luminance(fg) > 0.5 ? 'rgba(0,0,0,0.9)' : 'rgba(255,255,255,0.9)';
    ctx.lineWidth = Math.max(2, size / 7);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = outline;
    ctx.fillStyle = fg;
    // Hard guarantee: wrapped text stays inside the render area even when the
    // translation cannot fit at the minimum font size. The fit loop above
    // shrinks until it fits; this clip only bites in the fallback case.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x1, y1, rw, rh);
    ctx.clip();
    if (vertical) {
      const colW = size * 1.05;
      const totalW = lines.length * colW;
      const startX = (x1 + x2) / 2 + totalW / 2 - colW / 2;
      lines.forEach((col, ci) => {
        const x = startX - ci * colW;
        const chars = [...col];
        const totalH = chars.length * lh;
        let y = y1 + (rh - totalH) / 2 + lh / 2;
        for (const ch of chars) {
          ctx.strokeText(ch, x, y);
          ctx.fillText(ch, x, y);
          y += lh;
        }
      });
    } else {
      const cx = (x1 + x2) / 2;
      const totalH = lines.length * lh;
      let y = y1 + (rh - totalH) / 2 + lh / 2;
      for (const line of lines) {
        ctx.strokeText(line, cx, y);
        ctx.fillText(line, cx, y);
        y += lh;
      }
    }
    ctx.restore();
    return { render_xyxy: area.map(v => Math.round(v)), render_font_size: Math.round(size * 10) / 10, auto_font_size: Math.round(autoSize * 10) / 10, vertical };
  }

  // ------------------------------------------------------------ main image
  // The page's own picture: largest fully-loaded <img> on the page.
  let mainImgEl = null;

  // Collect <img> elements from light DOM and shadow DOMs (some readers
  // render pages inside shadow roots; document.images misses those).
  // The shadow-root scan is cached per "image run" (see _imgScanCache) —
  // querySelectorAll('*') on every find is slow on large pages.
  let _imgScanCache = null;
  function invalidateImageCache() { _imgScanCache = null; }

  function collectShadowImages(root, depth, out) {
    if (depth > 3) return;
    let els;
    try { els = root.querySelectorAll('*'); } catch { return; }
    for (const el of els) {
      let sr = null;
      try { sr = el.shadowRoot; } catch { continue; }
      if (sr) {
        try { out.push(...sr.querySelectorAll('img')); } catch { /* best-effort */ }
        collectShadowImages(sr, depth + 1, out);
      }
    }
  }

  function allImages() {
    if (_imgScanCache) return _imgScanCache;
    const out = [...document.images];
    try {
      collectShadowImages(document, 0, out);
    } catch { /* shadow scan is best-effort */ }
    _imgScanCache = out;
    return out;
  }

  // Placeholder test matches only the path/filename — never the query
  // string (a legit URL like /img.png?placeholder=0 is not a placeholder).
  // 2.2.12: a data: URI as an <img> src is a placeholder (the standard
  // 1x1 transparent GIF, the most common lazy placeholder) — the real URL
  // is in data-src. `pixel.gif` is another common blank name.
  function isPlaceholderUrl(url) {
    const s = String(url || '');
    if (/^data:/i.test(s)) return true;
    const path = s.split(/[?#]/)[0];
    return /placeholder|blank|1x1|spacer|pixel/i.test(path);
  }

  // Lazy-load fallback: if the <img> src is a placeholder, try data-src /
  // data-original / data-lazy-src for the real URL. Falls back to `cur`
  // (even a placeholder) when no data-src is present — better than ''.
  function realSrc(im) {
    const cur = im.currentSrc || im.src || '';
    if (cur && !isPlaceholderUrl(cur)) return cur;
    return im.dataset.src || im.dataset.original || im.dataset.lazySrc ||
           im.getAttribute('data-src') || im.getAttribute('data-original') || cur;
  }

  function findMainImage() {
    const imgs = allImages().filter(im => {
      if (!im.isConnected || !im.complete || !im.naturalWidth) return false;
      const r = im.getBoundingClientRect();
      return r.width >= 120 && r.height >= 120;
    });
    if (!imgs.length) { mainImgEl = null; return null; }
    // Displayed size is what the user sees — the minimum-size gate uses it,
    // so a big file shown small (e.g. a 700x979 file at 350x490) does not run.
    // Biggest on screen first (displayed area, not file area).
    imgs.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    });
    const im = imgs[0];
    mainImgEl = im;
    const cur = realSrc(im);
    // Already translated in place: the <img> now shows our rendered data URL
    // (the real url was kept in dataset.ctOriginal). Report the ORIGINAL url:
    // a multi-MB data URL in this message can break tabs.sendMessage (the
    // worker then reports "no picture found"), and the worker must download
    // the original — page-canvas pixels would be the already-translated
    // image, which would translate the translation and poison the page-cache
    // key so revisits never hit the cache.
    const wasTranslated = !!im.dataset.ctOriginal && /^data:/i.test(cur);
    const r = im.getBoundingClientRect();
    return {
      src: wasTranslated ? im.dataset.ctOriginal : cur,
      w: Math.round(r.width), h: Math.round(r.height),
      translated: wasTranslated,
    };
  }

  // Multi-pic: every qualifying <img> gets a stable uid (data-ct-uid). The
  // worker translates each picture and replaces it by uid, so any layout works
  // (long strips, galleries, grids). The uid prefix is random per content
  // script load, so a re-injection never collides with uids already in the DOM.
  const IMG_UID_PREFIX = 'ct' + Math.random().toString(36).slice(2, 8) + '_';
  let imgUidSeq = 0;
  function ensureImgUid(im) {
    if (!im.dataset.ctUid) im.dataset.ctUid = IMG_UID_PREFIX + (++imgUidSeq);
    return im.dataset.ctUid;
  }
  function imgElByUid(uid) {
    if (!uid) return null;
    // allImages() descends into shadow roots — querySelector does not.
    const el = allImages().find(im => im.dataset.ctUid === uid);
    return el && el.isConnected ? el : null;
  }
  // One <img> as the worker sees it. Displayed size is what the gate uses
  // (2.1.28), so w/h are on-screen, not file size. Already translated in
  // place? Report the ORIGINAL url (same reason as findMainImage).
  function describeImage(im) {
    const cur = realSrc(im);
    const wasTranslated = !!im.dataset.ctOriginal && /^data:/i.test(cur);
    const r = im.getBoundingClientRect();
    return {
      uid: ensureImgUid(im),
      src: wasTranslated ? im.dataset.ctOriginal : cur,
      w: Math.round(r.width), h: Math.round(r.height),
      nw: im.naturalWidth || 0, nh: im.naturalHeight || 0,
      translated: wasTranslated,
    };
  }
  // Every qualifying picture on the page, top to bottom in the layout
  // (not biggest first — James's order). The worker applies the minimum
  // image size and the per-run cap; this only skips tiny/hidden images.
  // Force every picture on the page to load (auto-translate only). Lazy
  // pictures below the fold have complete=false / naturalWidth=0 until
  // they load, so the inventory would skip them. This tries, in order:
  // Phase 0 (no scroll): tell each picture to load directly — native
  // loading=lazy becomes eager, a placeholder src is replaced by the
  // real URL from data-src/data-original/data-lazy-src, data-srcset
  // becomes srcset. This covers most lazy-load patterns with no scroll
  // at all. Phase 1 (scroll fallback, only for pictures still not
  // loaded — e.g. a JS observer that holds the URL in code, not in the
  // DOM): scroll through the page in viewport steps so each picture
  // enters the viewport, then jump back to where the user was BEFORE
  // waiting for the downloads — the fetches keep running in the
  // background once triggered, so the user is only displaced for the
  // brief scroll-through, not the whole download wait. The budgets below
  // are time limits so a huge / infinite-scroll page can never hang the
  // run — after the budget, translate whatever loaded. Returns
  // { loaded, total, ms, steps, directTriggered, scrolled, filterSkipped }
  // — filterSkipped counts pictures the qualify-or-skip filter left
  // untriggered (provably too small, see skipForceLoad).
  async function forceLoadAllImages() {
    const t0 = Date.now();
    const BUDGET_MS = 15000; // whole force-load must fit in this
    const DIRECT_WAIT_MS = 5000; // longest to wait for direct triggers
    const DIRECT_STALL_MS = 1000; // no picture finished in this long: rest need scroll
    // TODO: why 60ms here? No event exists: after scrollTo the site's own
    // lazy-load observer fires asynchronously, and our own
    // IntersectionObserver firing would not prove the site's did — so a
    // fixed wait is the only option, but 60ms is an unverified guess, not
    // a measured value. Verify against slow lazy-load sites, or drive it
    // off observed events (own observer entry + a frame) instead.
    const STEP_WAIT_MS = 60; // let the lazy-load observer fire after each scroll step
    const MAX_STEPS = 200; // taller than this is effectively infinite scroll
    const startY = window.scrollY || 0, startX = window.scrollX || 0;
    const vh = Math.max(1, window.innerHeight || 800);
    // Polling helper: the loops below wait on a SET of pictures settling
    // (all loaded, or stalled) — no single event fires for that, and the
    // stall check needs a timer anyway, so a sleep-based poll is the only
    // option. Per-picture load/error listeners could replace the "all
    // loaded" exit, but not the stall exit.
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const pageHeight = () => document.documentElement.scrollHeight || document.body.scrollHeight || 0;
    // Qualify-or-skip filter (pipelined auto): only trigger pictures that
    // COULD be translated. A picture is skipped from force-load only when
    // it is provably too small to ever reach the inventory floor (120x120
    // — the inventory's own list floor in collectPageImages; the worker's
    // 460px gate still applies after load): (a) both width and height
    // attributes are present and both are < 120, or (b) its real URL is
    // still a placeholder/data-URI and it has no data-src/data-srcset to
    // load a real picture from (a spacer/tracking pixel, not a lazy manga
    // image). Everything else is triggered — a lazy manga image with no
    // attributes and a small placeholder box must NOT be excluded; the
    // inventory after load is the final filter. Limit of (a): attributes
    // are the page's declared size, and CSS could in principle display
    // the picture larger, so both-attributes-< 120 is the strongest
    // signal the DOM offers before load, not a mathematical proof.
    // The filter applies to the direct phase and to the pending counts
    // below (a skipped spacer must not hold the load wait open), but NOT
    // to the scroll check: a placeholder with no data-src could still be
    // a JS-observer lazy image whose real URL only appears on scroll, and
    // scrolling is brief and restores the position, while skipping it
    // there could lose a real manga picture.
    const skipForceLoad = (im) => {
      let attrW = 0, attrH = 0, hasW = false, hasH = false;
      try {
        const w = im.getAttribute('width'), h = im.getAttribute('height');
        hasW = w != null && w !== ''; hasH = h != null && h !== '';
        attrW = parseInt(w || '0', 10) || 0; attrH = parseInt(h || '0', 10) || 0;
      } catch { /* attributes unreadable — do not skip */ }
      if (hasW && hasH && Math.max(attrW, attrH) < 120) return 'tiny-attrs';
      const real = realSrc(im);
      const hasDataSrc = !!(im.dataset.src || im.dataset.original || im.dataset.lazySrc ||
        im.getAttribute('data-src') || im.getAttribute('data-original') ||
        im.dataset.srcset || im.getAttribute('data-srcset'));
      if (isPlaceholderUrl(real) && !hasDataSrc) return 'placeholder';
      return null;
    };
    let filterSkipped = 0;
    const countPending = () => {
      let n = 0;
      for (const im of allImages()) if (im.isConnected && !im.complete && !skipForceLoad(im)) n++;
      return n;
    };
    let steps = 0, directTriggered = 0, scrolled = false;
    // Which pictures the direct phase actually triggered. A picture
    // still loading after the direct wait that WAS triggered is just
    // slow (or broken) — the scroll cannot help it. Only a picture
    // the direct phase could not trigger at all needs the scroll.
    const triggered = new Set();
    // Phase 0: trigger every picture to load directly, without moving
    // the viewport. Skip pictures already loaded, and never touch a
    // translated picture (its src is our rendered data URL, complete).
    for (const im of allImages()) {
      if (!im.isConnected || im.complete || im.dataset.ctOriginal) continue;
      if (skipForceLoad(im)) { filterSkipped++; continue; }
      const cur = im.src || '';
      const real = realSrc(im);
      if (im.loading === 'lazy') {
        try { im.loading = 'eager'; } catch {}
        directTriggered++; triggered.add(im);
      }
      // A placeholder src with a real URL in a data attribute: point src
      // at the real URL so the browser fetches it now.
      if (real && real !== cur && (isPlaceholderUrl(cur) || !cur)) {
        try { im.src = real; } catch {}
        directTriggered++; triggered.add(im);
      }
      // Responsive lazy-load: point srcset at the real set.
      const ds = im.dataset.srcset || im.getAttribute('data-srcset');
      if (ds && ds !== (im.srcset || '')) {
        try { im.srcset = ds; } catch {}
        directTriggered++; triggered.add(im);
      }
    }
    // Wait for the direct triggers to finish: stop when all are loaded,
    // when nothing finished for DIRECT_STALL_MS (the rest were never
    // triggered and need the scroll), or at DIRECT_WAIT_MS.
    {
      let lastPending = Infinity, stallSince = Date.now();
      for (;;) {
        const pending = countPending();
        if (!pending) break;
        if (pending < lastPending) { lastPending = pending; stallSince = Date.now(); }
        else if (Date.now() - stallSince >= DIRECT_STALL_MS) break;
        if (Date.now() - t0 >= DIRECT_WAIT_MS) break;
        // Poll cadence for the direct-trigger wait: re-checks img.complete
        // for the whole set. 200ms is a chosen cadence, not a measured
        // value — fast enough that the wait ends promptly once the last
        // picture lands, slow enough not to spin. No event replaces it:
        // see the sleep helper above.
        await sleep(200);
      }
    }
    // Phase 1: scroll fallback, only for pictures the direct phase
    // could not trigger (a JS observer holding the URL in code). A
    // picture that was triggered but is still loading is just slow or
    // broken — the scroll cannot help it, so it does not scroll.
    // Restore the scroll position as soon as the scroll-through is
    // done, even if the scroll loop itself throws.
    const needsScroll = () => {
      for (const im of allImages()) {
        if (im.isConnected && !im.complete && !triggered.has(im)) return true;
      }
      return false;
    };
    if (needsScroll()) {
      scrolled = true;
      try {
        let lastH = 0;
        for (;;) {
          const h = pageHeight();
          const maxY = Math.max(0, h - vh);
          const y = Math.min(maxY, steps * vh);
          window.scrollTo({ top: y, left: 0, behavior: 'instant' });
          steps++;
          await sleep(STEP_WAIT_MS);
          const h2 = pageHeight();
          // At the bottom and nothing new appeared: done scrolling.
          if (y >= maxY && h2 <= lastH) break;
          lastH = Math.max(lastH, h2);
          if (steps >= MAX_STEPS || Date.now() - t0 >= BUDGET_MS) break;
        }
      } finally {
        try { window.scrollTo({ top: startY, left: startX, behavior: 'instant' }); } catch {}
      }
    }
    // Phase 2: wait for the triggered loads to finish. The user is
    // already back at the top (or never moved), so this wait is
    // invisible — the pictures download in the background. Poll until
    // all are complete (or errored — complete is true then too), or the
    // budget runs out; then translate whatever loaded.
    for (;;) {
      if (!countPending()) break;
      if (Date.now() - t0 >= BUDGET_MS) break;
      // Poll cadence for the post-scroll wait: same reasoning as the
      // direct-trigger poll above (no set-level event; 200ms is a chosen
      // cadence, not measured). The user is already back at the original
      // scroll position, so this wait is invisible.
      await sleep(200);
    }
    let loaded = 0, total = 0;
    for (const im of allImages()) {
      if (!im.isConnected) continue;
      total++;
      if (im.complete && im.naturalWidth) loaded++;
    }
    return { loaded, total, ms: Date.now() - t0, steps, directTriggered, scrolled, filterSkipped };
  }

  // Diagnostic for the last inventory, read by the ct/list-images handler.
  // Human-readable log (James, 2026-11-26): only big pictures LEFT OUT of
  // the inventory are worth a line — the ones in the list appear as
  // Picture blocks in the run. Empty when nothing was left out, so a
  // normal run logs nothing here.
  let lastInventoryDiag = '';
  // Full src URLs of every big picture (in the list and excluded), so the
  // worker can check host permission for ALL of them — not just the ones
  // that made the inventory.
  let lastBigSrcs = [];
  function collectPageImages() {
    const all = allImages();
    // Diagnostic — best-effort only. It must NEVER break the inventory:
    // if any read throws, the diag is replaced by an error note and the
    // filter below still runs.
    try {
      const reasons = { notConn: 0, notComplete: 0, noNat: 0, dispSmall: 0 };
      lastBigSrcs = [];
      let nBig = 0, nBigIn = 0;
      for (const im of all) {
        // Big is decided FIRST, from natural size OR width/height attributes.
        // On a 403 site a picture that failed to load has natural size 0, but
        // its width="1410" height="1000" attributes still say it is big — and
        // its src/host must reach the permission check, or the 403 pictures
        // stay invisible. (An earlier version checked natural size first and
        // skipped failed pictures before ever calling them big.)
        let attrW = 0, attrH = 0;
        try {
          attrW = parseInt(im.getAttribute('width') || '0', 10) || 0;
          attrH = parseInt(im.getAttribute('height') || '0', 10) || 0;
        } catch { /* attributes unreadable — treat as 0 */ }
        const isBig = Math.max(im.naturalWidth || 0, im.naturalHeight || 0) >= 500 || Math.max(attrW, attrH) >= 500;
        const r = im.getBoundingClientRect();
        const inList = !!(im.isConnected && im.complete && im.naturalWidth && r.width >= 120 && r.height >= 120);
        if (!im.isConnected) reasons.notConn++;
        else if (!im.complete) reasons.notComplete++;
        else if (!im.naturalWidth) reasons.noNat++;
        else if (!inList) reasons.dispSmall++;
        if (isBig) {
          nBig++;
          if (inList) nBigIn++;
          // 2.2.12: use realSrc, not currentSrc — for an already-translated
          // picture currentSrc is the rendered data URL (multi-MB), and
          // pushing it into bigSrcs can break tabs.sendMessage. realSrc
          // returns the ORIGINAL url (via dataset.ctOriginal). Skip data:
          // URLs entirely — they are not a host to check permission for.
          const src = realSrc(im);
          if (src && !/^data:/i.test(src)) lastBigSrcs.push(src);
        }
      }
      // Only the left-out big pictures matter: a picture in the list shows
      // up as a Picture block in the run. Nothing left out -> empty string,
      // so a normal run logs nothing here.
      const leftOut = nBig - nBigIn;
      if (!leftOut) {
        lastInventoryDiag = '';
      } else {
        const why = [];
        if (reasons.notConn) why.push(reasons.notConn + ' not connected');
        if (reasons.notComplete) why.push(reasons.notComplete + ' not loaded yet');
        if (reasons.noNat) why.push(reasons.noNat + ' no image data');
        if (reasons.dispSmall) why.push(reasons.dispSmall + ' too small on screen');
        lastInventoryDiag = leftOut + ' big picture' + (leftOut === 1 ? '' : 's') + ' not listed' + (why.length ? ' (' + why.join(', ') + ')' : '');
      }
    } catch (e) {
      lastInventoryDiag = 'Inventory check failed: ' + String((e && e.message) || e).slice(0, 120);
    }
    const imgs = all.filter(im => {
      if (!im.isConnected || !im.complete || !im.naturalWidth) return false;
      const r = im.getBoundingClientRect();
      return r.width >= 120 && r.height >= 120;
    });
    imgs.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.top - rb.top) || (ra.left - rb.left);
    });
    return imgs.map(describeImage);
  }

  // The image the user right-clicked ("Send to Comic Translate 4 Free"): match
  // by live src, by the translated data URL now shown, or by the stashed
  // original (re-send of an already-translated image). No size filter — the
  // manual send bypasses the minimum image size on purpose.
  // No loaded check: a lazy picture still shows its placeholder (its live src
  // is the placeholder, the real URL is in data-src), and a picture the page
  // itself failed to load (403) has naturalWidth 0. Both must still match —
  // the real URL is what the fetch tiers download, and the page-canvas tier
  // refuses unloaded/placeholder elements (see captureElementPixels), so the
  // run falls through to the network tiers instead of translating a blank.
  // 2.2.12: match by realSrc (data-src) first — the real URL is unique per
  // image. A live-src match is only trusted when it is unique: lazy
  // libraries share one placeholder live src across many images, so the
  // first match by live src could be the wrong picture (right-clicking
  // image 5 would translate image 1). If several images share the live
  // src there is no way to tell which was clicked from the URL alone —
  // return null instead of guessing.
  function findImageBySrc(srcUrl) {
    if (!srcUrl) return null;
    const imgs = allImages().filter(im => im.isConnected);
    let im = imgs.find(im => realSrc(im) === srcUrl || im.dataset.ctOriginal === srcUrl);
    if (!im) {
      const liveMatches = imgs.filter(im => (im.currentSrc || im.src || '') === srcUrl);
      if (liveMatches.length === 1) im = liveMatches[0];
    }
    if (!im) return null;
    const cur = realSrc(im);
    const wasTranslated = !!im.dataset.ctOriginal && /^data:/i.test(cur);
    return {
      uid: ensureImgUid(im),
      src: wasTranslated ? im.dataset.ctOriginal : cur,
      w: Math.round(im.getBoundingClientRect().width), h: Math.round(im.getBoundingClientRect().height),
      nw: im.naturalWidth || 0, nh: im.naturalHeight || 0,
      translated: wasTranslated,
    };
  }

  // Name a page-fetch HTTP failure distinctly, so the worker can tell a
  // dead link (404), a rate limit (429) and a permanent rejection
  // (400/413/414/418) apart from a generic failure — and never prompts
  // for a grant for any of them.
  function pageFetchHttpMessage(status) {
    if (status === 404) return 'this image link no longer exists on the server (HTTP 404) — reload the page for a fresh link';
    if (status === 429) return 'image host is rate-limiting (HTTP 429), retry later';
    if (status === 400 || status === 405 || status === 413 || status === 414 || status === 418) return `server rejected this image URL (HTTP ${status})`;
    return 'HTTP ' + status;
  }

  // Canvas capture for one <img> element. Throws (tainted canvas) when the
  // image host sends no CORS headers — the worker then tries a direct fetch.
  // NOTE: raw pixel buffers CANNOT travel via extension messaging — Chrome
  // silently turns ArrayBuffers into {} in both directions (verified). So
  // the pixels go as a WebP data URL string, the same trick the render path
  // uses for the translated image.
  // Async blob encode (not toDataURL): toDataURL is fully synchronous and
  // freezes the page for 1-3s on multi-MP images. Note: HTMLCanvasElement
  // has toBlob (callback), not convertToBlob (that's OffscreenCanvas only).
  async function captureElementPixels(im) {
    // The element must actually be showing the real picture. A lazy picture
    // still shows its placeholder, and a picture the page failed to load
    // (403) draws a 1x1 blank — translating either would be wrong. Throw so
    // the worker's fetch tiers take over with the real URL (findImageBySrc
    // already resolved it via realSrc).
    const live = im.currentSrc || im.src || '';
    if (!im.complete || !im.naturalWidth) throw new Error('image has not loaded yet');
    if (isPlaceholderUrl(live)) throw new Error('image is still showing its placeholder');
    // Canvas guard: natural size can exceed browser limits (e.g. 2000x15000).
    // Downscale to fit — the pipeline downscales to 6.5MP anyway.
    const s = renderScale(im.naturalWidth, im.naturalHeight);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(im.naturalWidth * s));
    c.height = Math.max(1, Math.round(im.naturalHeight * s));
    const cx = c.getContext('2d');
    cx.drawImage(im, 0, 0, c.width, c.height);
    const blob = await new Promise((resolve, reject) =>
      c.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/webp', 0.95));
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsDataURL(blob);
    });
    return { dataUrl, w: c.width, h: c.height };
  }

  // Direct pixels via page canvas. With srcUrl, captures that specific image
  // (the manual-send path); otherwise the main image. Throws (tainted
  // canvas) when the image host sends no CORS headers — the worker then
  // tries a direct fetch.
  async function mainImagePixels(srcUrl) {
    let im = null;
    if (srcUrl) {
      im = allImages().find(im => {
        if (!im.isConnected || !im.complete || !im.naturalWidth) return false;
        // 2.2.12: match by realSrc too — for a lazy image the manual-send
        // path resolves the real URL (data-src), and the old live-src-only
        // match failed to find it, so the page-canvas tier was silently
        // unavailable for lazy images.
        const cur = im.currentSrc || im.src || '';
        return realSrc(im) === srcUrl || cur === srcUrl || im.dataset.ctOriginal === srcUrl;
      });
      // Background-tab fallback: the tab IS the image (a single <img>).
      // If the image URL redirected, the exact match above fails even
      // though the picture is right there — use the only picture on the
      // page. Only when there is exactly one, so a normal multi-picture
      // page never picks the wrong one.
      // 2.2.12: verify the single image relates to srcUrl (same origin) —
      // the old code captured any lone loaded image, even an unrelated one,
      // when right-clicking a failed-to-load image.
      if (!im) {
        const all = allImages().filter(x => x.isConnected && x.complete && x.naturalWidth);
        if (all.length === 1) {
          let sameOrigin = false;
          try {
            sameOrigin = new URL(realSrc(all[0]) || all[0].src || '', location.href).origin === new URL(srcUrl, location.href).origin;
          } catch { sameOrigin = false; }
          if (sameOrigin) im = all[0];
        }
      }
    } else {
      im = mainImgEl && mainImgEl.isConnected ? mainImgEl : null;
    }
    if (!im) throw new Error(srcUrl ? 'image not found on page' : 'no main image');
    return captureElementPixels(im);
  }

  // Multi-pic: pixels for the <img> a run named by uid.
  async function imagePixelsByUid(uid) {
    const im = imgElByUid(uid);
    if (!im) throw new Error('image left the page before translation finished — reload the page to retry');
    return captureElementPixels(im);
  }

  function replaceMainImage(dataUrl) {
    let im = mainImgEl && mainImgEl.isConnected ? mainImgEl : null;
    // The stored element can go stale over a long pipeline (page re-rendered
    // the <img>); re-find it before giving up.
    if (!im) { findMainImage(); im = mainImgEl && mainImgEl.isConnected ? mainImgEl : null; }
    if (!im) return false;
    // Always refresh the marker: on SPA-reused elements the old marker
    // points at a previous picture. Never overwrite with a data: URL —
    // on a re-render the element shows the old translation, and the
    // existing marker is the true original.
    const cur = im.currentSrc || im.src;
    if (cur && !/^data:/i.test(cur)) im.dataset.ctOriginal = cur;
    im.removeAttribute('srcset');
    im.src = dataUrl;
    return true;
  }

  // Multi-pic: swap the exact <img> a run named by uid. The stored element
  // can go stale over a long pipeline (page re-rendered the <img>); uid
  // lookup re-queries, so that case is covered too.
  function replaceImageByUid(uid, dataUrl) {
    const im = imgElByUid(uid);
    if (!im) return false;
    // Always refresh the marker: on SPA-reused elements the old marker
    // points at a previous picture. Never overwrite with a data: URL.
    const cur = im.currentSrc || im.src;
    if (cur && !/^data:/i.test(cur)) im.dataset.ctOriginal = cur;
    im.removeAttribute('srcset');
    im.src = dataUrl;
    return true;
  }

  // In-place replace for the manual-send path: swap the <img> matching
  // srcUrl (live src, shown data URL, or stashed original).
  function replaceImageBySrc(srcUrl, dataUrl) {
    const im = allImages().find(im => {
      if (!im.isConnected) return false;
      const cur = im.currentSrc || im.src || '';
      return cur === srcUrl || im.dataset.ctOriginal === srcUrl;
    });
    if (!im) return false;
    // Always refresh the marker to this render's original (srcUrl): on
    // SPA-reused elements the old marker points at a previous picture.
    // Never overwrite with a data: URL (re-translate after the run-start
    // clear wiped the marker) — any existing marker stays.
    if (srcUrl && !/^data:/i.test(srcUrl)) im.dataset.ctOriginal = srcUrl;
    im.removeAttribute('srcset');
    im.src = dataUrl;
    return true;
  }

  // Render-miss diagnostic (2.2.18): when the put-back cannot find the
  // picture, say why — the uid asked for, the page URL, how many pictures
  // are on the page now, which uids they carry, and the big pictures' URLs.
  // Travels back on the RENDER reply; the worker logs it before throwing.
  function buildRenderMissDiag(msg) {
    let line = 'Could not put the translated picture back on the page (uid ' + (msg.uid || '-') +
      ', src ' + (msg.srcUrl || '-') +
      ', page ' + String(document.URL || '').slice(0, 160) + ').';
    try {
      const all = allImages();
      const withUid = all.filter(im => im.dataset && im.dataset.ctUid);
      line += ' ' + all.length + ' pictures on the page now, ' + withUid.length + ' carry uids [' +
        withUid.slice(0, 8).map(im => im.dataset.ctUid).join(',') + '].';
      const big = [];
      for (const im of all) {
        let w = 0, h = 0;
        try { const r = im.getBoundingClientRect(); w = r.width; h = r.height; } catch {}
        if (Math.max(w, h) >= 500) big.push(String(im.currentSrc || im.src || '').slice(0, 120));
        if (big.length >= 5) break;
      }
      if (big.length) line += ' Big pictures: [' + big.join(' | ') + '].';
    } catch {}
    return line;
  }

  // ------------------------------------------------------------ status pill
  let pill = null, pillTimer = null;
  let lastPillHtml = '', lastPillSticky = false; // latest pill content, so it can be re-shown when the debug panel closes
  // The debug panel and the pill are a toggle: when the panel is showing
  // the pill stays hidden (its text is mirrored into the panel instead);
  // when the panel is hidden the pill shows. Tap the pill to reopen the
  // panel (only while debug mode is still on).
  function isDebugPanelVisible() {
    try { return !!(debugPanel && debugPanel.style.display && debugPanel.style.display !== 'none'); } catch { return false; }
  }
  function showPillFromLast() {
    if (!lastPillHtml) return;
    try {
      const p = ensurePill();
      p.innerHTML = lastPillHtml;
      p.style.display = 'block';
      p.style.borderColor = '#444';
      clearTimeout(pillTimer);
      // Auto-hide after 4s: a display duration, not a wait for anything —
      // no event can replace "show the status long enough to read, then
      // get out of the way". 4s is a UX choice for a short status line,
      // not a measured value. Sticky pills (errors needing action) skip it.
      if (!lastPillSticky) pillTimer = setTimeout(() => { p.style.display = 'none'; }, 4000);
    } catch { /* never break the page */ }
  }
  function ensurePill() {
    if (pill) {
      // The debug overlay shares the pill's max z-index but is appended
      // later, so it paints on top and hides the pill in debug mode.
      // Re-appending the pill moves it after the overlay, so it stays
      // visible even with the panel open.
      if (overlay) document.documentElement.appendChild(pill);
      return pill;
    }
    pill = document.createElement('div');
    pill.id = 'ct-pill';
    pill.style.cssText = 'position:fixed;right:16px;top:16px;z-index:2147483647;background:#1c1c22;color:#eee;' +
      'font:13px/1.4 sans-serif;padding:10px 14px;border-radius:10px;border:1px solid #444;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.5);display:none;max-width:340px;white-space:pre-wrap;cursor:pointer;';
    // Tap the pill to reopen the debug panel (only while debug mode is on).
    // Clicks on buttons/links inside the pill (Allow, dismiss) keep their
    // own handlers and do not reopen the panel.
    pill.addEventListener('click', e => {
      try {
        if (e.target !== pill) return;
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
        chrome.storage.local.get('settings', res => {
          try {
            const s = (res && res.settings) || {};
            if (!s.debugMode) return;
            if (!overlay || !debugPanel) return;
            overlay.style.display = 'flex';
            debugPanel.style.display = 'flex';
            debugPanelSuppressed = false;
            if (dbgBtn) dbgBtn.textContent = 'Hide';
            pill.style.display = 'none';
          } catch {}
        });
      } catch {}
    });
    document.documentElement.appendChild(pill);
    return pill;
  }
  // Mirror of the pill's latest text inside the debug panel, so everything
  // the pill shows is also visible in the panel (plain text only — the
  // pill's buttons must not be duplicated with the same ids).
  function mirrorPillStatus(text) {
    try { if (debugStatus) debugStatus.textContent = text; } catch { /* never break the pill */ }
  }
  function showPill(html, sticky) {
    const p = ensurePill();
    lastPillHtml = html;
    lastPillSticky = !!sticky;
    p.innerHTML = html;
    mirrorPillStatus(p.textContent);
    // Panel/pill toggle: when the debug panel is showing, the pill stays
    // hidden (its text is mirrored into the panel above). Only show the
    // pill when the panel is hidden.
    if (isDebugPanelVisible()) {
      p.style.display = 'none';
      return;
    }
    p.style.display = 'block';
    p.style.borderColor = '#444';
    clearTimeout(pillTimer);
    // Auto-hide after 4s: a UX display duration, not a synchronisation
    // wait — see showPillFromLast above. Sticky pills skip it.
    if (!sticky) pillTimer = setTimeout(() => { p.style.display = 'none'; }, 4000);
  }
  function pillAllowLabel(host) {
    try {
      const m = chrome.i18n.getMessage('pill_allow_host', host);
      if (m) return m;
    } catch { /* fall through */ }
    return 'Allow ' + host;
  }
  function pillDeniedLabel() {
    try {
      const m = chrome.i18n.getMessage('pill_grant_denied');
      if (m) return m;
    } catch { /* fall through */ }
    return 'access denied — allow it from the popup';
  }
  function showPillError(text, grant) {
    const p = ensurePill();
    const errLabel = stageLabel('error');
    let html = 'Comic Translate 4 Free — ' + esc(errLabel) + ': ' + esc(text);
    if (grant && grant.host) {
      html += ' <button id="ct-pill-grant" style="margin-left:8px;padding:4px 10px;border:1px solid #1a73e8;border-radius:6px;' +
        'background:#1a73e8;color:#fff;font:600 12px sans-serif;cursor:pointer">' +
        esc(pillAllowLabel(grant.label || grant.host)) + '</button>';
    }
    html += ' <a href="#" id="ct-pill-x" style="color:#8ab4f8;margin-left:8px">' +
      esc(dismissLabel()) + '</a>';
    lastPillHtml = html;
    lastPillSticky = true;
    p.innerHTML = html;
    mirrorPillStatus(p.textContent);
    // Panel/pill toggle: when the debug panel is showing, the pill stays
    // hidden (its text is mirrored into the panel above).
    if (isDebugPanelVisible()) {
      p.style.display = 'none';
    } else {
      p.style.display = 'block';
    }
    p.style.borderColor = '#a33';
    const x = document.getElementById('ct-pill-x');
    if (x) x.onclick = e => { e.preventDefault(); p.style.display = 'none'; };
    const g = document.getElementById('ct-pill-grant');
    if (g) g.onclick = e => {
      e.preventDefault();
      g.disabled = true;
      g.style.opacity = '.6';
      // Classic script (no modules): use the literal message type.
      chrome.runtime.sendMessage({ type: 'ct/grant-image-host', host: grant.host }, r => {
        if (r && r.ok) {
          // Granted — the worker re-runs the pipeline; hide the error.
          p.style.display = 'none';
        } else {
          g.disabled = false;
          g.style.opacity = '';
          g.textContent = pillDeniedLabel();
        }
      });
    };
  }
  // Stage labels come from the shared stage_* i18n keys (also used by the
  // popup), English fallback if a locale is missing one.
  const PILL_STAGE_FALLBACK = {
    capture: 'Capturing', detect: 'Detecting bubbles', blocks: 'Building blocks',
    ocr: 'Reading text', mask: 'Masking', translate: 'Translating',
    inpaint: 'Inpainting', render: 'Rendering',
    downloading: 'Downloading models',
  };
  function stageLabel(stage) {
    try {
      const m = chrome.i18n.getMessage('stage_' + stage);
      if (m) return m;
    } catch { /* extension contexts without i18n */ }
    return PILL_STAGE_FALLBACK[stage] || stage;
  }
  function dismissLabel() {
    try {
      const m = chrome.i18n.getMessage('pill_dismiss');
      if (m) return m;
    } catch { /* fall through */ }
    return 'dismiss';
  }
  // Generic pill message lookup with English fallback map for new keys.
  const PILL_MSG_FALLBACK = {
    pill_err_page_changed: 'the page image changed before translation finished — reload the page to retry',
    pill_err_render_mode: 'unexpected render mode — reload the page to retry',
  };
  function pillMsg(key) {
    try {
      const m = chrome.i18n.getMessage(key);
      if (m) return m;
    } catch { /* fall through */ }
    return PILL_MSG_FALLBACK[key] || key;
  }
  // ------------------------------------------------------------ one-time support popup
  // Shown once, the first time the user hits the 50/day free limit
  // (the SW sends 'ct/show-support'). Centered over a dimmed
  // page, X top right, two buttons. Only X closes it (2.2.20): the
  // buttons open their link and leave the modal open, backdrop click
  // and Escape do nothing. It never shows again: the SW marks it shown
  // only when the content script confirms the modal actually rendered.
  // The Rate button turns into "Redeem free trial" after it is clicked
  // (and renders as Redeem from the start if the user rated before).
  let supportModal = null;
  function supportStoreUrl() {
    // Same two URLs as STORE_URLS in shared/contracts.js (classic script,
    // no imports) — that file is the source of truth.
    try {
      return navigator.userAgent.includes('Firefox')
        ? 'https://addons.mozilla.org/firefox/addon/comic-translate-4-free/'
        : 'https://chromewebstore.google.com/detail/comic-translate-4-free/pndooikgcenncdohfggodonniihplppj';
    } catch {
      return 'https://chromewebstore.google.com/detail/comic-translate-4-free/pndooikgcenncdohfggodonniihplppj';
    }
  }
  function supportMsg(key, fallback) {
    try {
      const m = chrome.i18n.getMessage(key);
      if (m) return m;
    } catch { /* fall through */ }
    return fallback;
  }
  function closeSupportModal() {
    try { if (supportModal) supportModal.remove(); } catch { /* already gone */ }
    supportModal = null;
  }
  // "Rated" flag for the support popup: once the user clicks "Rate it in
  // store", the button becomes "Redeem free trial" — in this render and in
  // any later render of the modal. Stored in chrome.storage.local (the
  // content script's own key; the SW never needs it).
  function supportRated() {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return resolve(false);
        chrome.storage.local.get('ctSupportRated', (res) => {
          try { resolve(!!(res && res.ctSupportRated)); } catch { resolve(false); }
        });
      } catch { resolve(false); }
    });
  }
  function markSupportRated() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.set({ ctSupportRated: true }, () => {});
    } catch { /* best-effort — the button still transforms in this render */ }
  }
  function showSupportModal(rated, checkoutUrl) {
    if (supportModal) return false; // already showing
    const wrap = document.createElement('div');
    wrap.id = 'ct-support-modal';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
    // 2.2.20: only X closes the modal — no backdrop-click or Escape
    // listener (the 2.2.12 ones are gone), and the buttons below do not
    // close it either.
    const card = document.createElement('div');
    card.style.cssText = 'position:relative;width:340px;max-width:calc(100vw - 32px);background:#1c1c22;color:#eee;' +
      'font:14px/1.4 sans-serif;padding:24px 20px 20px;border-radius:12px;border:1px solid #3a3a40;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.6);text-align:center;';
    const x = document.createElement('span');
    x.textContent = '✕';
    x.style.cssText = 'position:absolute;top:10px;right:14px;color:#9a9aa0;font-size:18px;cursor:pointer;';
    x.onclick = () => closeSupportModal();
    const title = document.createElement('div');
    title.textContent = supportMsg('support_modal_title', 'Enjoying Comic Translate 4 Free?');
    title.style.cssText = 'font-size:16px;color:#fff;margin-bottom:8px;';
    const text = document.createElement('p');
    text.textContent = supportMsg('support_modal_text', 'If you like it, please support it — it helps a lot.');
    text.style.cssText = 'color:#8a8a90;font-size:12px;margin:0 0 16px;';
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    const mkBtn = (labelKey, fallback, url) => {
      const b = document.createElement('button');
      b.textContent = supportMsg(labelKey, fallback);
      b.style.cssText = 'padding:9px 14px;border:1px solid #3a3a40;border-radius:6px;background:#232327;color:#e8e8ea;font-size:13px;cursor:pointer;';
      // 2.2.20: the button opens its link but leaves the modal open —
      // only X closes it.
      b.onclick = () => {
        try { chrome.runtime.sendMessage({ type: 'ct/open-link', url }); } catch { /* link open failed — modal stays */ }
      };
      return b;
    };
    // Rate button: first click opens the store and turns this button into
    // "Redeem free trial" (which opens the Pro checkout). If the user
    // already rated (stored flag), it renders as Redeem from the start.
    // Without a checkout URL it stays a plain Rate button — a missing URL
    // must never produce a dead Redeem button.
    let rateIsRedeem = !!rated;
    const hasCheckout = typeof checkoutUrl === 'string' && !!checkoutUrl;
    const rateBtn = document.createElement('button');
    const setRateLabel = () => {
      rateBtn.textContent = supportMsg(rateIsRedeem ? 'redeem_free_trial' : 'rate_store', rateIsRedeem ? '🎁 Redeem free trial' : '⭐ 5 stars at store');
    };
    rateBtn.style.cssText = 'padding:9px 14px;border:1px solid #3a3a40;border-radius:6px;background:#232327;color:#e8e8ea;font-size:13px;cursor:pointer;';
    setRateLabel();
    rateBtn.onclick = () => {
      if (rateIsRedeem) {
        try { chrome.runtime.sendMessage({ type: 'ct/open-link', url: checkoutUrl }); } catch { /* link open failed — modal stays */ }
        return;
      }
      try { chrome.runtime.sendMessage({ type: 'ct/open-link', url: supportStoreUrl() }); } catch { /* link open failed — modal stays */ }
      if (hasCheckout) {
        try { markSupportRated(); } catch {}
        rateIsRedeem = true;
        setRateLabel();
      }
    };
    btns.appendChild(rateBtn);
    btns.appendChild(mkBtn('feedback_email', '✉️ Feedback by email', 'mailto:jameslee0623@gmail.com?subject=Comic%20Translate%204%20Free%20feedback'));
    card.appendChild(x);
    card.appendChild(title);
    card.appendChild(text);
    card.appendChild(btns);
    wrap.appendChild(card);
    document.documentElement.appendChild(wrap);
    supportModal = wrap;
    return true;
  }
  // ------------------------------------------------------------ next-page discovery (pre-translation)
  // The site's Next link first, then +1 on the page number in the URL.
  // Pure helpers (tested by pretranslate-test.mjs); findNextPageUrl() is
  // the thin DOM wrapper. Same site only — pre-translation fetches the
  // page itself, and the extension only has host permission for sites
  // the user allowed.
  const NEXT_LINK_TEXT = /^\s*[»›→>]*\s*(next(\s+page|\s+chapter)?|下一页|次へ|다음)\s*[»›→>]*\s*$/i;
  const NEXT_LINK_ARROW = /^\s*[»›→>]+\s*$/;
  function nextUrlFromAnchors(anchors) {
    // anchors: [{href, texts:[...], rel}] in document order.
    for (const a of anchors) {
      if (a.rel && String(a.rel).toLowerCase().split(/\s+/).includes('next')) return a.href;
    }
    for (const a of anchors) {
      for (const t of (a.texts || [])) {
        const s = String(t || '').trim();
        if (s && (NEXT_LINK_TEXT.test(s) || NEXT_LINK_ARROW.test(s))) return a.href;
      }
    }
    return null;
  }
  function incrementPageUrl(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    // +1 the last all-digit path segment (/g/681857/2/ -> /3/).
    const segs = u.pathname.split('/');
    for (let i = segs.length - 1; i >= 0; i--) {
      if (/^\d+$/.test(segs[i])) {
        segs[i] = String(parseInt(segs[i], 10) + 1);
        u.pathname = segs.join('/');
        return u.href;
      }
    }
    // +1 the page number after a dash (example-site image pages:
    // /s/<hash>/1234567-2 -> /s/<hash>/1234567-3). Exactly one dash,
    // so a date like 2026-11-17 never matches.
    // 2.2.12: a year-month (2026-11) has exactly one dash too and used to
    // match, turning /2026-11/ into /2026-12/. Skip a 4-digit year +
    // month (01-12) — that is a date, not a page number.
    for (let i = segs.length - 1; i >= 0; i--) {
      const dm = /^(\d+)-(\d+)$/.exec(segs[i]);
      if (dm) {
        const y = parseInt(dm[1], 10), m = parseInt(dm[2], 10);
        if (dm[1].length === 4 && y >= 1900 && y <= 2100 && m >= 1 && m <= 12) continue;
        segs[i] = dm[1] + '-' + String(parseInt(dm[2], 10) + 1);
        u.pathname = segs.join('/');
        return u.href;
      }
    }
    // Else +1 ?page= / ?p=.
    for (const key of ['page', 'p']) {
      if (u.searchParams.has(key) && /^\d+$/.test(u.searchParams.get(key))) {
        u.searchParams.set(key, String(parseInt(u.searchParams.get(key), 10) + 1));
        return u.href;
      }
    }
    return null;
  }
  function findLearnedNextLink(learnedTexts) {
    // Learned "next" wording for this site (e.g. Romanian "următorul"):
    // a link whose normalized text matches a learned text, in document order.
    if (!learnedTexts || !learnedTexts.length) return null;
    try {
      const want = learnedTexts.map(t => String(t || '').trim().toLowerCase()).filter(Boolean);
      if (!want.length) return null;
      const anchors = document.querySelectorAll('a[href]');
      for (const a of anchors) {
        const texts = [a.textContent || '', a.getAttribute('aria-label') || '', a.getAttribute('title') || ''];
        for (const t of texts) {
          const s = String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (s && want.includes(s)) return { url: a.href, text: s };
        }
      }
    } catch {}
    return null;
  }
  function nextUrlFromLinkHrefs(anchors, currentUrl) {
    // A link to the same series, next page number — the page itself, read
    // from its href. This is the only way for token URLs (example-site image
    // pages: /s/<token>/<gid>-<page> — the token changes per image, so the
    // URL alone can never predict the next page; the link carries it).
    // Dash form: the last segment keeps its first number (the series id)
    // and the page number goes up by 1; earlier segments may differ (the
    // token). Plain form: the last segment is the page number, so the
    // parent path must be identical (it is the series id).
    let cur;
    try { cur = new URL(currentUrl); } catch { return null; }
    // Last non-empty segment (URLs may end with '/').
    const splitPath = (p) => { const s = p.split('/'); while (s.length && s[s.length - 1] === '') s.pop(); return s; };
    const curSegs = splitPath(cur.pathname);
    const curLast = curSegs[curSegs.length - 1] || '';
    const curDash = /^(\d+)-(\d+)$/.exec(curLast);
    const curPlain = /^\d+$/.test(curLast);
    for (const a of anchors) {
      let u;
      try { u = new URL(a.href); } catch { continue; }
      if (u.origin !== cur.origin) continue;
      if (!curDash && !curPlain) {
        if (u.pathname !== cur.pathname) continue;
        for (const key of ['page', 'p']) {
          if (cur.searchParams.has(key) && /^\d+$/.test(cur.searchParams.get(key)) &&
              u.searchParams.get(key) === String(parseInt(cur.searchParams.get(key), 10) + 1)) return a.href;
        }
        continue;
      }
      const segs = splitPath(u.pathname);
      const last = segs[segs.length - 1] || '';
      if (curDash) {
        const m = /^(\d+)-(\d+)$/.exec(last);
        if (m && m[1] === curDash[1] && parseInt(m[2], 10) === parseInt(curDash[2], 10) + 1) return a.href;
      } else {
        if (!/^\d+$/.test(last) || parseInt(last, 10) !== parseInt(curLast, 10) + 1) continue;
        if (segs.slice(0, -1).join('/') !== curSegs.slice(0, -1).join('/')) continue;
        return a.href;
      }
    }
    return null;
  }
  function findPictureLink() {
    // The link around the biggest picture on the page. On many readers
    // the picture IS the next-page link (no text, no page number in the
    // URL) — the learned picture-link rule uses this. Biggest by
    // displayed size; a link around a tiny thumbnail never counts.
    let best = null, bestArea = 0;
    try {
      document.querySelectorAll('a[href]').forEach(a => {
        const img = a.querySelector ? a.querySelector('img') : null;
        if (!img || !img.complete || !img.naturalWidth) return;
        const r = img.getBoundingClientRect();
        if (Math.max(r.width || 0, r.height || 0) < 120) return;
        const area = (r.width || 0) * (r.height || 0);
        if (area > bestArea) { bestArea = area; best = a.href; }
      });
    } catch {}
    return best;
  }
  function findNextPageUrl(picLinkActive) {
    let fromLink = null;
    let anchors = [];
    try {
      document.querySelectorAll('a[href]').forEach(a => {
        anchors.push({
          href: a.href,
          texts: [a.textContent || '', a.getAttribute('aria-label') || '', a.getAttribute('title') || ''],
          rel: a.getAttribute('rel') || '',
        });
      });
      fromLink = nextUrlFromAnchors(anchors);
    } catch { /* fall through to the URL increment */ }
    // Same series, next page number, read from a link's href (see above).
    if (!fromLink) {
      try { fromLink = nextUrlFromLinkHrefs(anchors, location.href); } catch {}
    }
    if (fromLink) return { url: fromLink, picLink: false };
    // Learned picture-link rule (active for this site): the link around
    // the biggest picture. A real link beats a guessed +1 URL, so it
    // comes before the increment.
    if (picLinkActive) {
      try {
        const pic = findPictureLink();
        if (pic) return { url: pic, picLink: true };
      } catch {}
    }
    const cand = incrementPageUrl(location.href);
    if (!cand || cand === location.href) return null;
    try {
      if (new URL(cand).origin !== location.origin) return null;
    } catch { return null; }
    return { url: cand, picLink: false };
  }
  function pillProgress(stage, progress) {
    // Sticky for the whole run: the old non-sticky call armed a 4s auto-hide
    // on every update, so long stages (inpaint, translate) left the page with
    // no visible progress between updates. done/cancelled still auto-hide;
    // errors stay until dismissed.
    showPill('Comic Translate 4 Free — ' + esc(stageLabel(stage)) +
      ' ' + Math.round((progress || 0) * 100) + '%', true);
  }

  // ------------------------------------------------------------ completion chime
  // Short synthesized "ding" when a translation finishes. WebAudio only —
  // no audio file to ship. Best-effort: if the browser's autoplay policy
  // keeps the context suspended (no user interaction with the page yet),
  // we stay silent rather than show an error.
  let dingCtx = null;
  async function maybeDing() {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      if (settings && settings.playDing === false) return; // default on
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      dingCtx = dingCtx || new AC();
      if (dingCtx.state === 'suspended') {
        try { await dingCtx.resume(); } catch { /* stay silent */ }
      }
      if (dingCtx.state !== 'running') return;
      const t0 = dingCtx.currentTime;
      for (const [freq, dt] of [[1046.5, 0], [1568.0, 0.14]]) { // C6 -> G6
        const o = dingCtx.createOscillator(), g = dingCtx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0 + dt);
        g.gain.exponentialRampToValueAtTime(0.22, t0 + dt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.6);
        o.connect(g);
        g.connect(dingCtx.destination);
        o.start(t0 + dt);
        o.stop(t0 + dt + 0.65);
      }
    } catch { /* sound must never break the page */ }
  }

  // ------------------------------------------------------------ overlay DOM
  let overlay = null, debugPanel = null, debugBody = null, dbgBtn = null, debugStatus = null;  const stageTabs = {};   // stage -> payload
  let lastRunTimes = null; // {totalMs, seqMs, breakdown} from the latest render — shown in the diaglog tab
  let currentDebugTab = null; // stage currently shown in the debug panel
  const stageOrder = ['capture', 'detect', 'blocks', 'ocr', 'mask', 'inpaint', 'translate', 'render', 'diaglog'];
  let currentRunId = null;
  let latestRunId = null;   // run the service worker last started for this tab
  let debugPanelSuppressed = false; // user hid the panel with X; auto-show stays off until a new run or a pill tap

  // FIX3: content-script-held keep-alive Port. FIX2's self-connect Port
  // (both ends in the background) did not prevent the background dying
  // mid-run — a third run died at inpaint the same way. A Port whose
  // opener lives in a DIFFERENT context (this tab's content script) is
  // the documented keep-alive: an event page / worker stays alive while
  // it has an open channel to another context, and messages across it
  // count as activity resetting the idle timer (mere open, with no
  // messages, does not reliably reset timers on modern Chromium, and
  // Firefox likewise stays alive while the background "is doing
  // something periodically"). So this port also sends a heartbeat every
  // 20s while a run is active. Held in module scope so it is not GC'd.
  // Page unload disconnects it automatically, which is fine: the run
  // ends on navigation anyway. Best-effort everywhere; never throws.
  let tabKeepAlivePort = null;
  let tabKeepAliveRunId = null;
  let tabKeepAliveTimer = null;
  function openTabKeepAlive(runId) {
    try {
      if (tabKeepAlivePort && tabKeepAliveRunId === runId) return;
      closeTabKeepAlive();
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.connect) return;
      const port = chrome.runtime.connect({ name: 'ct-keepalive-tab' });
      port.onDisconnect.addListener(() => {
        if (tabKeepAlivePort === port) {
          tabKeepAlivePort = null;
          tabKeepAliveRunId = null;
          if (tabKeepAliveTimer) { clearInterval(tabKeepAliveTimer); tabKeepAliveTimer = null; }
        }
      });
      tabKeepAlivePort = port;
      tabKeepAliveRunId = runId;
      // Heartbeat: a silent open port alone does not reliably reset idle
      // timers. One small message every 20s (under the ~30s idle clock)
      // is the activity that keeps the background alive during long runs.
      tabKeepAliveTimer = setInterval(() => {
        try {
          if (tabKeepAlivePort) tabKeepAlivePort.postMessage({ type: 'ct-keepalive-tab', runId: tabKeepAliveRunId });
          else if (tabKeepAliveTimer) { clearInterval(tabKeepAliveTimer); tabKeepAliveTimer = null; }
        } catch { closeTabKeepAlive(); }
      }, 20000);
    } catch { closeTabKeepAlive(); }
  }
  function closeTabKeepAlive(runId) {
    try {
      if (runId && tabKeepAliveRunId && tabKeepAliveRunId !== runId) return;
      if (tabKeepAliveTimer) { clearInterval(tabKeepAliveTimer); tabKeepAliveTimer = null; }
      if (tabKeepAlivePort) { try { tabKeepAlivePort.disconnect(); } catch {} }
    } catch {}
    tabKeepAlivePort = null;
    tabKeepAliveRunId = null;
  }

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'ct-overlay';
    // Debug UI floats over the page WITHOUT dimming it: the backdrop is
    // transparent and click-through, so the original picture stays fully
    // visible (and the page stays usable) while stages are inspected.
    // pointer-events are re-enabled on the bar and the debug panel only.
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent;pointer-events:none;display:none;flex-direction:column;align-items:flex-end;justify-content:flex-start;';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;padding:8px;align-items:center;color:#eee;font:13px sans-serif;pointer-events:auto;background:rgba(10,10,12,0.85);border-radius:0 0 0 8px;';
    const mkBtn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'padding:6px 12px;border:1px solid #555;border-radius:6px;background:#222;color:#eee;cursor:pointer;font:13px sans-serif;';
      b.onclick = fn;
      return b;
    };
    const title = document.createElement('span');
    title.textContent = 'Comic Translate 4 Free';
    title.style.cssText = 'font-weight:600;margin-right:8px;';
    bar.appendChild(title);
    // Two buttons on top of the debug panel (James's spec):
    // Hide — same as the debug switch in Settings (turns debug mode off).
    // Hides the panel AND the Settings Debug section until the version
    // number is clicked 5 times. Persists via the service worker.
    const hideBtnEl = mkBtn('Hide', () => {
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: 'ct/set-debug-mode', on: false });
        }
      } catch {}
      hideOverlayTemp();
    });
    dbgBtn = hideBtnEl;
    bar.appendChild(dbgBtn);
    // X — close the panel temporarily, debug mode stays on (so the user
    // can click the page). Tap the pill to reopen it, or it auto-shows
    // on the next run. Does NOT remove the overlay, only hides it.
    bar.appendChild(mkBtn('✕', () => { hideOverlayTemp(); }));
    overlay.appendChild(bar);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'flex:1;display:flex;min-height:0;width:100%;justify-content:flex-end;';
    debugPanel = document.createElement('div');
    debugPanel.style.cssText = 'display:none;pointer-events:auto;width:340px;max-height:calc(100vh - 60px);overflow:auto;background:rgba(18,18,24,0.96);color:#ddd;font:12px sans-serif;border-left:1px solid #333;flex-direction:column;';
    // Status line mirroring the pill (first child, so it is visible when
    // the panel opens). Initialized from the pill's current text, then kept
    // in sync by showPill/showPillError.
    debugStatus = document.createElement('div');
    debugStatus.style.cssText = 'padding:8px;border-bottom:1px solid #333;color:#eee;white-space:pre-wrap;';
    debugStatus.textContent = pill ? pill.textContent : '';
    debugPanel.appendChild(debugStatus);
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;padding:8px;position:sticky;top:0;background:#16161a;';
    debugPanel.appendChild(tabBar);
    debugBody = document.createElement('div');
    debugBody.style.cssText = 'padding:8px;';
    debugPanel.appendChild(debugBody);
    stageOrder.forEach(st => {
      const b = document.createElement('button');
      b.textContent = st;
      b.style.cssText = 'padding:4px 8px;background:#222;border:1px solid #444;color:#ccc;border-radius:4px;cursor:pointer;font:11px sans-serif;';
      b.onclick = () => renderDebugTab(st);
      tabBar.appendChild(b);
    });
    wrap.appendChild(debugPanel);
    overlay.appendChild(wrap);
    document.documentElement.appendChild(overlay);
  }

  // X button (temporary close): hide the overlay but keep debug mode on
  // and keep the overlay in the DOM, so the pill can reopen it. The pill
  // shows when the panel is hidden (they are a toggle). Does not remove
  // the overlay — closeOverlay() below is the full teardown.
  function hideOverlayTemp() {
    try {
      debugPanelSuppressed = true;
      if (overlay) overlay.style.display = 'none';
      if (debugPanel) debugPanel.style.display = 'none';
      showPillFromLast();
    } catch {}
  }

  function closeOverlay() {
    if (overlay) overlay.remove();
    overlay = null; debugPanel = null; debugBody = null; debugStatus = null;
    for (const k of Object.keys(stageTabs)) delete stageTabs[k];
    lastRunTimes = null; currentDebugTab = null;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderDebugTab(stage) {
    const p = stageTabs[stage];
    currentDebugTab = stage;
    if (!p) { debugBody.innerHTML = `<p style="color:#888">no data for "${esc(stage)}" yet</p>`; return; }
    // The total + per-stage times live in the diaglog tab (moved from the
    // render tab): they come from the render message, not the log payload,
    // so the diaglog tab reads them from lastRunTimes.
    const times = stage === 'diaglog' ? lastRunTimes : p;
    let html = `<h3 style="margin:0 0 8px">${esc(p.title || stage)}`;
    if (stage === 'diaglog' && p.log) html += ` <button id="ct-copy-log" style="margin-left:8px;padding:4px 8px;background:#222;border:1px solid #444;color:#ccc;border-radius:4px;cursor:pointer;font:11px sans-serif;vertical-align:middle">Copy</button>`;
    html += `</h3>`;
    // Capture tab (2.1.28): show the captured picture's size — dimensions
    // (after renderScale) and the download bytes when known. This is the
    // number the minImageSize gate uses, so a run on a small picture
    // explains itself here instead of in the log.
    if (stage === 'capture' && p.w != null && p.h != null) {
      html += `<p style="color:#eee;margin:0 0 8px">size: <b>${p.w}×${p.h}</b>${p.bytes != null ? ` · ${Number(p.bytes).toLocaleString('en-US')} bytes` : ''}</p>`;
    }
    if (times && times.totalMs != null) {
      html += `<p style="color:#eee;font-size:14px;margin:0 0 4px">total: <b>${times.totalMs}ms</b>`;
      if (times.seqMs != null && times.seqMs > times.totalMs) {
        html += ` <span style="color:#8f8;font-size:12px">(parallelism saved ${times.seqMs - times.totalMs}ms vs sequential ${times.seqMs}ms)</span>`;
      }
      html += `</p>`;
      if (times.breakdown) html += `<p style="color:#888;margin:0 0 8px">${esc(times.breakdown)}</p>`;
    }
    if (p.log) html += `<pre style="white-space:pre-wrap;word-break:break-all;color:#ddd;font:11px monospace;max-height:60vh;overflow:auto;border:1px solid #444;padding:8px">${esc(p.log)}</pre>`;
    if (p.ms != null) html += `<p style="color:#888">${p.ms} ms</p>`;
    if (p.error) html += `<p style="color:#f66">${esc(p.error)}</p>`;
    if (p.image) html += `<img src="${p.image}" style="max-width:100%;border:1px solid #444">`;
    if (p.mask) html += `<img src="${p.mask}" style="max-width:100%;border:1px solid #444">`;
    if (p.boxes) {
      html += `<p>${p.boxes.length} boxes (threshold ${esc(p.threshold)})</p>`;
      html += '<table style="width:100%;border-collapse:collapse">' +
        p.boxes.slice(0, 60).map(b =>
          `<tr><td style="border:1px solid #333;padding:2px">${b.label === 0 ? 'bubble' : 'text'}</td>` +
          `<td style="border:1px solid #333;padding:2px">${b.score.toFixed(2)}</td>` +
          `<td style="border:1px solid #333;padding:2px">${b.xyxy.map(v => Math.round(v)).join(',')}</td></tr>`
        ).join('') + '</table>';
      if (p.boxes.length > 60) html += `<p style="color:#888">…and ${p.boxes.length - 60} more</p>`;
    }
    if (p.blocks) {
      html += '<table style="width:100%;border-collapse:collapse">' +
        p.blocks.map(b =>
          `<tr><td style="border:1px solid #333;padding:2px">${b.i}</td>` +
          `<td style="border:1px solid #333;padding:2px">${esc(b.text_class)}</td>` +
          `<td style="border:1px solid #333;padding:2px">${b.xyxy.join(',')}</td></tr>`
        ).join('') + '</table>';
    }
    if (p.crops) {
      html += p.crops.map(c => {
        const n = c.chars != null ? c.chars : (c.text || '').length;
        // Baberu v1.1 reads up to ~256 chars; a crop hitting that ceiling gets
        // re-OCR'd in overlapping chunks (rare).
        const cap = c.hitCeiling
          ? ` <span style="color:#fc6">⚠ 256-char model cap` +
            (c.chunks > 1 ? ` — re-OCR'd in ${c.chunks} chunks` : ' — could not split further') + `</span>`
          : '';
        const looped = c.stopped === 'limit'
          ? ` <span style="color:#f88">⚠ hit the 128-token safety cap (output degenerate)</span>` : '';
        return `<div style="margin-bottom:8px;border-bottom:1px solid #333;padding-bottom:6px">` +
          `<img src="${c.thumb}" style="max-width:100%;background:#fff">` +
          `<div>#${c.id}: ${esc(c.text) || '<i style="color:#888">empty</i>'}</div>` +
          `<div style="color:#888">${n} chars${cap}${looped}</div></div>`;
      }).join('');
    }
    if (p.rows) {
      html += '<table style="width:100%;border-collapse:collapse">' +
        p.rows.map(r =>
          `<tr><td style="border:1px solid #333;padding:3px">${esc(r.text)}</td>` +
          `<td style="border:1px solid #333;padding:3px;color:#8f8">${esc(r.translation)}</td></tr>`
        ).join('') + '</table>';
    }
    debugBody.innerHTML = html;
    // Copy button (diaglog tab only): copies the times (total + per-stage)
    // above the log text.
    const copyBtn = debugBody.querySelector('#ct-copy-log');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        // Revert the button label 1.5s after showing "Copied" / "Copy
        // failed": a UX feedback duration, not a wait for anything — no
        // event can replace "let the user see the result, then restore
        // the label". 1.5s is a UX choice, not a measured value.
        const done = (t) => { copyBtn.textContent = t; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500); };
        let text = p.log || '';
        if (lastRunTimes) {
          const saved = lastRunTimes.seqMs != null && lastRunTimes.seqMs > lastRunTimes.totalMs
            ? ` (parallelism saved ${lastRunTimes.seqMs - lastRunTimes.totalMs}ms vs sequential ${lastRunTimes.seqMs}ms)` : '';
          text = `total: ${lastRunTimes.totalMs}ms${saved}\n${lastRunTimes.breakdown}\n\n${text}`;
        }
        try { await navigator.clipboard.writeText(text); done('Copied'); }
        catch {
          try {
            const ta = document.createElement('textarea');
            ta.value = text; document.body.appendChild(ta); ta.select();
            document.execCommand('copy'); ta.remove();
            done('Copied');
          } catch { done('Copy failed'); }
        }
      };
    }
  }

  // ------------------------------------------------------------ messages
  // Learned next-page link text: report link clicks to the background, so
  // it can learn the site's own "next" wording (e.g. Romanian "următorul")
  // — and picture links (hasImage), so it can learn "the picture goes
  // next" on sites where the next link has no text at all.
  // Capture phase, fire-and-forget — never blocks the click.
  document.addEventListener('click', (ev) => {
    try {
      const a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (!a || !a.href) return;
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const hasImage = !!(a.querySelector && a.querySelector('img'));
      if ((!text || text.length > 40) && !hasImage) return;
      chrome.runtime.sendMessage({ type: 'ct/link-clicked', text, href: a.href, hasImage });
    } catch {}
  }, true);
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('ct/')) return false;
    // Fresh image scan per message ("run"): the DOM may have changed since
    // the last scan (lazy-load, SPA navigation).
    invalidateImageCache();
    if (msg.type === 'ct/find-image') {
      try { sendResponse({ ok: true, image: findMainImage() }); }
      catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
      return false;
    }
    if (msg.type === 'ct/find-image-by-src') {
      try { sendResponse({ ok: true, image: findImageBySrc(msg.srcUrl) }); }
      catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
      return false;
    }
    if (msg.type === 'ct/get-image-pixels') {
      mainImagePixels(msg.srcUrl).then(
        r => sendResponse({ ok: true, ...r }),
        e => sendResponse({ ok: false, error: String((e && e.message) || e) })
      );
      return true; // async response
    }
    if (msg.type === 'ct/force-load-images') {
      // Auto-translate only: scroll the page to load every lazy picture
      // before the inventory is taken, then jump back. Async — the reply
      // carries how many pictures loaded.
      forceLoadAllImages().then(
        r => sendResponse({ ok: true, ...r }),
        e => sendResponse({ ok: false, error: String((e && e.message) || e) })
      );
      return true; // async response
    }
    if (msg.type === 'ct/list-images') {
      // Multi-pic inventory: every qualifying picture, top to bottom.
      try { const images = collectPageImages(); sendResponse({ ok: true, images, total: allImages().length, diag: lastInventoryDiag, bigSrcs: lastBigSrcs }); }
      catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
      return false;
    }
    if (msg.type === 'ct/list-image-hosts') {
      // Distinct hosts of every picture's real address (src or data-src),
      // loaded or not — the access grant must cover ALL of them, not just
      // the biggest picture's host. The background-tab fallback injects
      // into a tab on the picture's host, so a host missing from the
      // grant fails there with "Missing host permission for the tab".
      try {
        const hosts = new Set();
        for (const im of allImages()) {
          try {
            const u = realSrc(im);
            if (u && /^https?:\/\//i.test(u)) hosts.add(new URL(u).hostname.toLowerCase());
          } catch {}
        }
        sendResponse({ ok: true, hosts: [...hosts] });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
      return false;
    }
    if (msg.type === 'ct/get-image-pixels-by-uid') {
      imagePixelsByUid(msg.uid).then(
        r => sendResponse({ ok: true, ...r }),
        e => sendResponse({ ok: false, error: String((e && e.message) || e) })
      );
      return true; // async response
    }
    if (msg.type === 'ct/run-summary') {
      // End-of-run report from the worker: the popup is usually closed by
      // the time the last picture finishes, so the page pill carries the
      // outcome (translated / failed / tiny images skipped). A resumed run
      // says so and counts the pictures the dead run already finished.
      const n = (msg && msg.images) || 0;
      const failed = (msg && msg.failed) || [];
      const ignored = (msg && msg.ignored) || 0;
      const resumed = !!(msg && msg.resumed);
      const alreadyDone = (msg && msg.alreadyDone) || 0;
      if (failed.length) {
        showPillError(`run finished${resumed ? ' (resumed)' : ''} — ${n} translated, ${failed.length} not: ` +
          failed.slice(0, 2).join('; ') + (failed.length > 2 ? ' …' : '') +
          ' — full list in the popup');
      } else if (resumed) {
        showPill(`Comic Translate 4 Free — resumed ✓ (${n} more translated, ${alreadyDone} already done)`);
      } else if (n > 1 || ignored) {
        showPill(`Comic Translate 4 Free — done ✓ (${n} translated` +
          (ignored ? `, ${ignored} tiny/hidden images skipped` : '') + ')');
      }
      return false;
    }
    if (msg.type === 'ct/fetch-image-bytes') {
      // Download the image inside the PAGE (not the service worker): the
      // browser applies the page's real referrer policy and cookies, exactly
      // like the page's own <img> load. Some image hosts / WAFs 403 the
      // service worker's fetch because its Referer and Sec-Fetch-* headers
      // don't match what the page itself sends. The extension's host
      // permissions let the content script read the cross-origin response.
      // The bytes travel back as a data URL string: raw ArrayBuffers are
      // silently emptied by extension messaging (verified), so binary goes
      // the same string route the render path uses for the translated PNG.
      (async () => {
        try {
          // credentials:'include' — send the page's cookies like its own
          // <img> does. Cookie-gated image hosts 403 without them.
          const res = await fetch(msg.srcUrl, { credentials: 'include' });
          if (!res.ok) throw new Error(pageFetchHttpMessage(res.status));
          // Content-Type before decode: an HTML/JSON error page served
          // as 200 fails here, not at decode, with its real type named.
          const ctype = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
          if (ctype && !/^image\//.test(ctype) && ctype !== 'application/octet-stream') {
            throw new Error(`server returned ${ctype}, not an image`);
          }
          const expectedLen = Number(res.headers.get('content-length') || 0) || null;
          let blob = await res.blob();
          if (!blob.size) throw new Error('empty response body');
          if (expectedLen && blob.size < expectedLen) {
            // Truncated body: retry the same tier once, then report the
            // shortfall instead of decoding a partial image.
            const res2 = await fetch(msg.srcUrl, { credentials: 'include' });
            if (!res2.ok) throw new Error(pageFetchHttpMessage(res2.status));
            blob = await res2.blob();
            if (!blob.size) throw new Error('empty response body');
            if (blob.size < expectedLen) throw new Error(`truncated response body (expected ${expectedLen} got ${blob.size})`);
          }
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('read failed'));
            reader.readAsDataURL(blob);
          });
          sendResponse({ ok: true, dataUrl });
        } catch (e) {
          // A fetch TypeError with no status is the expected CORS
          // signature in the page: the host blocks cross-origin reads.
          // Name it so the worker does not mistake it for a missing
          // grant; offline is named too. Guard on the message so a
          // TypeError from elsewhere is not misread as a network failure.
          if (e instanceof TypeError && /failed to fetch|networkerror|network error|load failed/i.test(String((e && e.message) || ''))) {
            const offline = (typeof navigator !== 'undefined' && navigator.onLine === false);
            sendResponse({ ok: false, error: offline ? 'could not reach the image host — check the connection' : 'network/CORS failure (no HTTP status): ' + String(e.message).slice(0, 60) });
            return;
          }
          sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 120) });
        }
      })();
      return true;
    }
    if (msg.type === 'ct/pill-notice') {
      // Custom pill message from the SW (e.g. 403-fallback status). Sticky
      // keeps it visible while the background work runs.
      showPill('Comic Translate 4 Free — ' + esc(msg.text || ''), !!msg.sticky);
      return false;
    }
    if (msg.type === 'ct/show-support') {
      // One-time support popup (SW sends it the first time the free daily
      // limit is hit). 2.2.12: report whether the modal actually rendered
      // — the old code sent ok:true even when showSupportModal threw, so
      // the SW marked it shown on delivery and a render failure lost the
      // one-time popup. The render is async (it reads the stored "rated"
      // flag first), so return true to keep the channel open.
      (async () => {
        let shown = false;
        try {
          const rated = await supportRated();
          const checkoutUrl = typeof msg.checkoutUrl === 'string' ? msg.checkoutUrl : '';
          shown = showSupportModal(rated, checkoutUrl) === true;
        } catch { shown = false; }
        try { sendResponse({ ok: shown }); } catch {}
      })();
      return true;
    }
    if (msg.type === 'ct/next-page-url') {
      // Pre-translation: what is the next page from here? Learned link
      // text first, then built-in rules, then the learned picture link
      // (the link around the biggest picture), then the +1 increment.
      try {
        const learned = findLearnedNextLink(msg.learnedTexts || null);
        if (learned) { sendResponse({ url: learned.url, learnedText: learned.text }); return false; }
        const found = findNextPageUrl(msg.picLinkActive === true);
        if (found) {
          if (found.picLink) sendResponse({ url: found.url, picLink: true });
          else sendResponse({ url: found.url });
          return false;
        }
        sendResponse({ url: null });
      } catch { sendResponse({ url: null }); }
      return false;
    }
    if (msg.type === 'ct/run-progress') {
      if (!msg.direct) return false; // broadcasts are for the popup; the pill takes targeted copies
      const st = msg.stage;
      // FIX3: terminal progress ends the run — release the tab-held keep-alive.
      if (st === 'error' || st === 'done' || st === 'cancelled') closeTabKeepAlive(msg.runId);
      // 2.2.12: ignore progress from a stale run — a stale run's
      // done/error/cancelled used to overwrite the pill (and fire the
      // ding) after a newer run started. The keep-alive close above still
      // runs so a stale run's port is not leaked.
      if (msg.runId && latestRunId && msg.runId !== latestRunId) return false;
      if (st === 'error') showPillError(msg.error || stageLabel('error'),
        msg.grantHost ? { host: msg.grantHost, label: msg.grantLabel } : null);
      else if (st === 'done') { showPill('Comic Translate 4 Free — ' + esc(stageLabel('done')) + ' ✓' + (msg.cached ? ' (from cache)' : msg.backendLabel ? ' (' + esc(msg.backendLabel) + ')' : '')); maybeDing(); }
      else if (st === 'cancelled') showPill('Comic Translate 4 Free — ' + esc(stageLabel('cancelled')));
      else if (st && st !== 'idle') pillProgress(st, msg.progress);
      return false;
    }
    if (msg.type === 'ct/run-started') {
      // The service worker's current run for this tab. Renders/debug output
      // from any older run (a page the user already left) are ignored — they
      // must never touch this page's DOM.
      latestRunId = msg.runId;
      openTabKeepAlive(msg.runId); // FIX3: tab-held keep-alive for this run.
      // Clear stale original-image markers from a previous run (SPA
      // navigation can leave them behind; a new run must not resolve
      // against the old page's stashed URLs). allImages() also descends
      // into shadow roots — querySelectorAll does not, so a stale marker
      // inside a shadow box survived the clear.
      // 2.1.60: only clear a marker when the picture is NOT showing a
      // data URL. A data-URL src means the picture is still showing a
      // translation from this page, and its marker is the true original.
      // Deleting it made a fresh re-run capture the translated render
      // instead of the original, so the cache key changed and the whole
      // page re-translated (James, Asura, cache NOT cleared). A stale
      // marker on an http-src picture is harmless — describeImage only
      // uses the marker when the src is a data URL — so SPA navigation
      // still clears correctly: the new page's pictures have http srcs.
      // (This replaces the 2.1.58 resume flag: the data-URL check keeps
      // the markers for resumed runs AND fresh re-runs alike.)
      try {
        allImages().forEach(im => {
          const cur = im.currentSrc || im.src || '';
          if (!/^data:/i.test(cur)) delete im.dataset.ctOriginal;
        });
      } catch { /* best-effort */ }
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'ct/debug-stage') {
      if (msg.runId !== latestRunId) { sendResponse({ ok: false, error: 'stale run' }); return false; }
      ensureOverlay();
      // New run: drop the previous run's stage payloads (each holds a data
      // URL image). Keeps memory bounded across runs.
      if (currentRunId !== msg.runId) {
        for (const k of Object.keys(stageTabs)) delete stageTabs[k];
        lastRunTimes = null;
        debugPanelSuppressed = false;
      }
      currentRunId = msg.runId;
      stageTabs[msg.stage] = msg.payload;
      if (msg.debug && !debugPanelSuppressed) {
        overlay.style.display = 'flex';
        debugPanel.style.display = 'flex';
        // Panel/pill toggle: the panel just showed, so hide the pill.
        if (pill) pill.style.display = 'none';
      }
      renderDebugTab(msg.stage);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'ct/render') {
      // A render from a run that is no longer current (user changed page and
      // a new run started, or this run was cancelled) must never touch the page.
      if (msg.runId !== latestRunId) { sendResponse({ ok: false, error: 'stale run' }); return false; }
      (async () => {
        try {
          if (currentRunId !== msg.runId) debugPanelSuppressed = false;
          currentRunId = msg.runId;
          const { imageDataUrl, width, height, blocks, timings, debug, mode } = msg;
          // Compose the final translated page on a scratch canvas.
          // Canvas guard: downscale if over browser limits; draw blocks in
          // original coordinates via ctx.scale so text layout is unchanged.
          const renderT0 = performance.now();
          const rs = renderScale(width, height);
          const work = document.createElement('canvas');
          work.width = Math.max(1, Math.round(width * rs));
          work.height = Math.max(1, Math.round(height * rs));
          const wctx = work.getContext('2d');
          // The inpainted page arrives as a WebP data URL (raw pixel buffers do
          // not survive extension messaging from the service worker).
          const baseImg = new Image();
          await new Promise((res, rej) => {
            baseImg.onload = res;
            baseImg.onerror = () => rej(new Error('could not decode the translated page image'));
            baseImg.src = imageDataUrl;
          });
          wctx.drawImage(baseImg, 0, 0, work.width, work.height);
          if (rs < 1) wctx.scale(rs, rs);
          const settings = await chrome.storage.local.get('settings').then(r => r.settings || {});
          // Font size bounds are fixed now (the Maximum/Minimum settings
          // were removed in 1.2.6): 120px cap, 10px floor. Sizing starts
          // from the estimated original size (see drawBlock), so the
          // bounds rarely bind.
          const maxSize = 120, minSize = 10;
          const srcLang = (blocks[0] && blocks[0].source_lang) || settings.sourceLang || 'ja';
          const renderInfo = [];
          for (const b of blocks) {
            const info = drawBlock(wctx, b, srcLang, maxSize, minSize);
            if (info) {
              // render_xyxy is debug info in original coordinates; scale to
              // match the downscaled output when the guard kicked in.
              b.render_xyxy = rs < 1 ? info.render_xyxy.map(v => Math.round(v * rs)) : info.render_xyxy;
              b.render_font_size = info.render_font_size;
              renderInfo.push({ text: b.text, size: info.render_font_size, auto: info.auto_font_size, vertical: info.vertical });
            }
          }
          let replaced = false;
          let renderMissDiag = null;
          if (mode === 'replace') {
            // In-place: swap the page's original <img> for the translated one.
            // No overlay mask — the translation lives in the page itself.
            // The multi-pic path names the exact <img> (msg.uid, with
            // msg.srcUrl as a fallback if the site swapped the element);
            // the manual-send path names it by src (msg.srcUrl); the auto
            // path replaces the detected main image.
            // Async blob encode (not toDataURL): toDataURL is fully synchronous
            // and freezes the page for 1-3s on multi-MP images.
            // Note: HTMLCanvasElement has toBlob (callback), not convertToBlob
            // (that's OffscreenCanvas only).
            const blob = await new Promise((resolve, reject) =>
              work.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/webp', 0.95));
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(reader.error || new Error('read failed'));
              reader.readAsDataURL(blob);
            });
            // Try the uid first (exact picture), then the src — the uid is a
            // DOM attribute lost if the site swaps the <img> between inventory
            // and render, but the src survives the swap. Only the no-uid /
            // no-src auto path replaces the detected main image, so a
            // multi-pic run never replaces the wrong picture.
            replaced = false;
            if (msg.uid) replaced = replaceImageByUid(msg.uid, dataUrl);
            if (!replaced && msg.srcUrl) replaced = replaceImageBySrc(msg.srcUrl, dataUrl);
            if (!replaced && !msg.uid && !msg.srcUrl) replaced = replaceMainImage(dataUrl);
            if (replaced) {
              if (overlay) overlay.style.display = 'none';
            } else {
              showPillError(pillMsg('pill_err_page_changed'));
              renderMissDiag = buildRenderMissDiag(msg);
            }
          } else {
            showPillError(pillMsg('pill_err_render_mode'));
          }
          const allTimings = { ...(timings || {}) };
          allTimings.render = Math.round(performance.now() - renderT0);
          const totalMs = allTimings.total != null
            ? allTimings.total
            : Object.entries(allTimings).filter(([k]) => k !== 'total').reduce((a, [, v]) => a + (v || 0), 0);
          const seqMs = Object.entries(allTimings).filter(([k]) => k !== 'total' && k !== 'render').reduce((a, [, v]) => a + (v || 0), 0);
          stageTabs['render'] = {
            title: 'Render',
            ms: allTimings.render,
            rows: renderInfo.map(r => ({ text: r.text, translation: `${r.size}px (auto ${r.auto}px)${r.vertical ? ' vertical' : ''}` })),
          };
          // Total + per-stage times live in the diaglog tab now, not here.
          lastRunTimes = {
            totalMs,
            seqMs,
            breakdown: Object.entries(allTimings).filter(([k]) => k !== 'total').map(([k, v]) => `${k} ${v}ms`).join(' · '),
          };
          if (debug && !debugPanelSuppressed) {
            ensureOverlay();
            overlay.style.display = 'flex';
            debugPanel.style.display = 'flex';
            // Panel/pill toggle: the panel just showed, so hide the pill.
            if (pill) pill.style.display = 'none';
            renderDebugTab('render');
          }
          sendResponse({ ok: true, replaced, renderMs: allTimings.render, ...(renderMissDiag ? { diag: renderMissDiag } : {}) });
          // The keep-alive stays open: a multi-pic run renders once per
          // picture, and closing here killed the tab-held port after the
          // first render, leaving the rest of the run on the worker-side
          // keep-alive alone. The ct/run-progress handler closes it on the
          // terminal stage (done/error/cancelled) instead.
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
      })();
      return true;
    }
    return false;
  });
})();
