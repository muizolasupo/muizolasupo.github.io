/*
 * signals.js
 * Purpose : Render the "Economic signals" panel on the Home page: twelve stat
 *           tiles (value, change since the prior release, factual status note,
 *           sparkline with crosshair read-out) in three groups.
 * Inputs  : /signals.json, written every three hours by scripts/update_signals.py
 *           from FRED (Federal Reserve Bank of St. Louis);
 *           the <div data-signals> block in index.html.
 * Outputs : tile markup inside [data-signals-groups].
 * Notes   : 1. All text from the data file is inserted with textContent.
 *           2. Changes are shown in neutral ink with an up/down glyph: whether a
 *              rise is good depends on the indicator, so no red/green is implied.
 *           3. Sparklines are drawn at their real pixel size (redrawn on resize)
 *              so strokes and the end dot stay crisp. Pointer and keyboard
 *              (arrow keys, Home, End) both move the crosshair; every value it
 *              shows is also summarised in the sparkline's accessible label.
 */
(() => {
  const root = document.querySelector('[data-signals]');
  if (!root) return;
  const mount = root.querySelector('[data-signals-groups]');
  const updatedLine = root.querySelector('[data-signals-updated]');
  const SVG = 'http://www.w3.org/2000/svg';
  const MINUS = '−';

  // ---- Formatting ---------------------------------------------------------
  const signed = (x, digits) => {
    const r = Number(x.toFixed(digits));
    if (r === 0) return (0).toFixed(digits);
    return (r > 0 ? '+' : MINUS) + Math.abs(r).toFixed(digits);
  };
  const fmtValue = (f, v) => ({
    pct2: () => v.toFixed(2) + '%',
    pct1: () => v.toFixed(1) + '%',
    bp: () => (Math.round(v * 100) < 0 ? MINUS : '') + Math.abs(Math.round(v * 100)) + ' bp',
    usd2: () => '$' + v.toFixed(2),
    k: () => Math.round(v / 1000).toLocaleString() + 'K',
    num2: () => v.toFixed(2),
  }[f] || (() => String(v)))();
  // Change since the prior observation, plus its direction (-1, 0, 1) after rounding.
  const fmtChange = (f, v1, v0) => {
    const spec = {
      bp: [(v1 - v0) * 100, 0, ' bp'],
      pt: [v1 - v0, 1, ' pt'],
      pct: [(v1 / v0 - 1) * 100, 1, '%'],
      k: [(v1 - v0) / 1000, 0, 'K'],
      num2: [v1 - v0, 2, ''],
    }[f] || [v1 - v0, 2, ''];
    const [d, digits, unit] = spec;
    const text = signed(d, digits);
    const dir = Number(d.toFixed(digits)) === 0 ? 0 : Math.sign(d);
    return { text: dir === 0 ? 'Unchanged' : text + unit, dir };
  };
  const utc = (iso) => new Date(iso + 'T00:00:00Z');
  const fmtDate = (iso, freq, long) => {
    const d = utc(iso);
    if (freq === 'quarterly') return 'Q' + (Math.floor(d.getUTCMonth() / 3) + 1) + ' ' + d.getUTCFullYear();
    if (freq === 'monthly') return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
    return d.toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', timeZone: 'UTC', ...(long || !sameYear ? { year: 'numeric' } : {}),
    });
  };
  // Reference lines that give a tile its benchmark (also forced into the y-range).
  const REFERENCE = { T10Y2Y: [0, '0'], PCEPILFE: [2, '2%'], SAHMREALTIME: [0.5, '0.50'] };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const svgEl = (tag, attrs) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  // ---- Sparkline ----------------------------------------------------------
  function sparkline(box, s) {
    const pts = s.trend.map(([d, v]) => ({ d, v }));
    const ref = REFERENCE[s.id];
    const tip = el('div', 'spark-tip');
    tip.hidden = true;
    let geom = null, active = -1;

    const draw = () => {
      const W = Math.max(box.clientWidth, 60), H = box.clientHeight || 46, padY = 6, padX = 5;
      let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
      if (ref) { lo = Math.min(lo, ref[0]); hi = Math.max(hi, ref[0]); }
      if (hi === lo) { hi += 1; lo -= 1; }
      const x = (i) => padX + (i * (W - 2 * padX)) / Math.max(pts.length - 1, 1);
      const y = (v) => padY + ((hi - v) * (H - 2 * padY)) / (hi - lo);
      geom = { x, y, W, H };
      const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true', focusable: 'false' });
      if (ref) {
        svg.append(svgEl('line', { x1: 0, x2: W, y1: y(ref[0]), y2: y(ref[0]), class: 'spark-ref' }));
        const label = svgEl('text', { x: W - 1, y: y(ref[0]) - 3, class: 'spark-ref-label', 'text-anchor': 'end' });
        label.textContent = ref[1];
        svg.append(label);
      }
      const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
      svg.append(svgEl('path', { d: `${line}L${x(pts.length - 1).toFixed(1)},${H}L${x(0).toFixed(1)},${H}Z`, class: 'spark-area' }));
      svg.append(svgEl('path', { d: line, class: 'spark-line' }));
      const last = pts.length - 1;
      svg.append(svgEl('circle', { cx: x(last), cy: y(pts[last].v), r: 4, class: 'spark-end' }));
      svg.append(svgEl('line', { x1: 0, x2: 0, y1: 0, y2: H, class: 'spark-cross', visibility: 'hidden' }));
      svg.append(svgEl('circle', { cx: 0, cy: 0, r: 4, class: 'spark-hover', visibility: 'hidden' }));
      box.replaceChildren(svg, tip);
      if (active >= 0) show(active);
    };

    const show = (i) => {
      active = i;
      const svg = box.querySelector('svg');
      const cross = svg.querySelector('.spark-cross'), dot = svg.querySelector('.spark-hover');
      const px = geom.x(i), py = geom.y(pts[i].v);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('visibility', 'visible');
      tip.replaceChildren(el('strong', null, fmtValue(s.format, pts[i].v)), el('span', null, fmtDate(pts[i].d, s.freq, true)));
      tip.hidden = false;
      // Keep the read-out inside the tile.
      const w = tip.offsetWidth;
      tip.style.left = Math.min(Math.max(px - w / 2, 0), geom.W - w) + 'px';
    };
    const hide = () => {
      active = -1;
      tip.hidden = true;
      box.querySelectorAll('.spark-cross, .spark-hover').forEach((n) => n.setAttribute('visibility', 'hidden'));
    };
    const nearest = (clientX) => {
      const r = box.getBoundingClientRect();
      const t = (clientX - r.left - 5) / Math.max(r.width - 10, 1);
      return Math.min(pts.length - 1, Math.max(0, Math.round(t * (pts.length - 1))));
    };

    box.addEventListener('pointermove', (e) => show(nearest(e.clientX)));
    box.addEventListener('pointerleave', () => { if (document.activeElement !== box) hide(); });
    box.addEventListener('focus', () => show(pts.length - 1));
    box.addEventListener('blur', hide);
    box.addEventListener('keydown', (e) => {
      const i = active < 0 ? pts.length - 1 : active;
      const next = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: pts.length - 1 }[e.key];
      if (next == null) { if (e.key === 'Escape') hide(); return; }
      e.preventDefault();
      show(Math.min(pts.length - 1, Math.max(0, next)));
    });
    if ('ResizeObserver' in window) new ResizeObserver(draw).observe(box);
    draw();

    // Accessible summary of what the line shows.
    const low = pts.reduce((a, b) => (b.v < a.v ? b : a)), high = pts.reduce((a, b) => (b.v > a.v ? b : a));
    box.setAttribute('aria-label',
      `${s.window} trend of ${s.label}: low ${fmtValue(s.format, low.v)} (${fmtDate(low.d, s.freq, true)}), ` +
      `high ${fmtValue(s.format, high.v)} (${fmtDate(high.d, s.freq, true)}). Use the arrow keys to read values.`);
  }

  // ---- Tiles --------------------------------------------------------------
  function tile(s) {
    const card = el('article', 'signal');
    const head = el('div', 'signal-head');
    head.append(el('h4', 'signal-label', s.label), el('p', 'signal-sub', s.sub));
    const value = el('p', 'signal-value', fmtValue(s.format, s.value));
    const ch = fmtChange(s.change_format, s.value, s.prev_value);
    const change = el('p', 'signal-change');
    const glyph = el('span', 'signal-glyph', ch.dir > 0 ? '▲' : ch.dir < 0 ? '▼' : '–');
    glyph.setAttribute('aria-hidden', 'true');
    // The glyph carries direction visually; screen readers get the words "Up"/"Down".
    change.append(glyph,
      ch.dir === 0 ? el('span', 'signal-delta', 'Unchanged') : el('span', 'sr-only', ch.dir > 0 ? 'Up ' : 'Down '),
      ch.dir === 0 ? '' : ch.text.replace(/^[+−]/, ''), el('span', 'signal-vs', ' vs ' + fmtDate(s.prev_date, s.freq)));
    card.append(head, value, change);
    if (s.status) card.append(el('p', 'signal-status', s.status));
    const box = el('div', 'spark');
    box.tabIndex = 0;
    card.append(box);
    const foot = el('div', 'signal-foot');
    const asOf = el('span', null, fmtDate(s.date, s.freq, true));
    const src = el('a', 'signal-src', 'FRED');
    src.href = s.source_url;
    src.target = '_blank';
    src.rel = 'noopener noreferrer';
    src.setAttribute('aria-label', `${s.label} on FRED`);
    foot.append(asOf, el('span', 'signal-window', s.window), src);
    card.append(foot);
    return { card, draw: () => sparkline(box, s) };
  }

  function render(data) {
    const frag = document.createDocumentFragment(), drawers = [];
    for (const g of data.groups || []) {
      if (!g.series || !g.series.length) continue;
      const group = el('div', 'signal-group');
      const grid = el('div', 'signal-grid');
      for (const s of g.series) {
        if (!s.trend || s.trend.length < 2) continue;
        const t = tile(s);
        grid.append(t.card);
        drawers.push(t.draw);
      }
      group.append(el('h4', 'signal-group-label', g.label), grid);
      frag.append(group);
    }
    if (!drawers.length) throw new Error('no series');
    mount.replaceChildren(frag);
    drawers.forEach((draw) => draw()); // after insertion, so each sparkline knows its width
    if (data.updated && updatedLine) {
      updatedLine.textContent = 'Checked for new releases ' + new Date(data.updated).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      }) + '. Market series update after each trading day; monthly and quarterly series on their official release dates.';
    }
  }

  fetch('/signals.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(render)
    .catch((err) => {
      console.warn('Signals: could not load data.', err);
      mount.replaceChildren(el('p', 'news-status', 'Economic signals will appear here shortly.'));
    });
})();
