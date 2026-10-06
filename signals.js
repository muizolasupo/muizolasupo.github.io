/*
 * signals.js
 * Purpose : Render the economic signals from /signals.json:
 *             - on the News page, one panel per [data-signals-panel="ID"]
 *               ("us" = United States, "global" = Nigeria & world): grouped
 *               stat tiles with value, coloured change bubble, status note,
 *               coloured sparkline with crosshair read-out, date and source;
 *             - on Home, compact chips in [data-signals-chips] for the series
 *               ids listed in its data-ids attribute.
 * Inputs  : /signals.json, written every three hours by scripts/update_signals.py.
 * Outputs : DOM inside the mounts above; the "updated" line beside each live dot.
 * Notes   : 1. Colour follows the reading, not just the arithmetic: each series
 *              has a polarity. For "up_good" (GDP growth) a rise is green; for
 *              "up_bad" (inflation, unemployment, jobless claims, naira per
 *              dollar, food prices) a rise is red; "neutral" market prices use
 *              the market convention (green up, red down). Colour never stands
 *              alone: every move also has an up/down glyph and words for
 *              screen readers.
 *           2. The bubble shows the latest change; the sparkline colour shows
 *              the direction over the whole window shown.
 *           3. All text from the data file is inserted with textContent.
 *           4. Sparklines are drawn at their real pixel size (redrawn on resize);
 *              pointer and keyboard (arrow keys, Home, End) move the crosshair.
 */
(() => {
  const panelMounts = [...document.querySelectorAll('[data-signals-panel]')];
  const chipMount = document.querySelector('[data-signals-chips]');
  if (!panelMounts.length && !chipMount) return;
  const SVG = 'http://www.w3.org/2000/svg';
  const MINUS = '−';

  // ---- Formatting ---------------------------------------------------------
  const DIGITS = { pct2: 2, pct1: 1, bp: 2, usd2: 2, num1: 1, num2: 2, fx4: 4, ngn: 2 };
  const fmtValue = (f, v) => ({
    pct2: () => v.toFixed(2) + '%',
    pct1: () => v.toFixed(1) + '%',
    bp: () => (Math.round(v * 100) < 0 ? MINUS : '') + Math.abs(Math.round(v * 100)) + ' bp',
    usd2: () => '$' + v.toFixed(2),
    k: () => Math.round(v / 1000).toLocaleString() + 'K',
    num1: () => v.toFixed(1),
    num2: () => v.toFixed(2),
    fx4: () => v.toFixed(4),
    ngn: () => '₦' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  }[f] || (() => String(v)))();
  // Round to the displayed precision so the change agrees with the numbers shown.
  const asShown = (f, v) => (f === 'k' ? Math.round(v / 1000) * 1000 : DIGITS[f] == null ? v : Number(v.toFixed(DIGITS[f])));
  // Change since the prior observation: magnitude text (no sign) and direction -1/0/1.
  const fmtChange = (cf, v1raw, v0raw, vf) => {
    const v1 = asShown(vf, v1raw), v0 = asShown(vf, v0raw);
    const [d, digits, unit] = {
      bp: [(v1 - v0) * 100, 0, ' bp'], pt: [v1 - v0, 1, ' pt'], pct: [(v1 / v0 - 1) * 100, 1, '%'],
      k: [(v1 - v0) / 1000, 0, 'K'], num2: [v1 - v0, 2, ''],
    }[cf] || [v1 - v0, 2, ''];
    const r = Number(d.toFixed(digits));
    return { text: Math.abs(r).toFixed(digits) + unit, dir: r === 0 ? 0 : Math.sign(r) };
  };
  // "good" / "bad" / "flat" for a move in direction dir, given the series polarity.
  const tone = (polarity, dir) => {
    if (dir === 0) return 'flat';
    const favourable = polarity === 'up_bad' ? -dir : dir;
    return favourable > 0 ? 'good' : 'bad';
  };
  const utc = (iso) => new Date(iso + 'T00:00:00Z');
  const fmtDate = (iso, freq, long) => {
    const d = utc(iso);
    if (freq === 'annual') return String(d.getUTCFullYear());
    if (freq === 'quarterly') return 'Q' + (Math.floor(d.getUTCMonth() / 3) + 1) + ' ' + d.getUTCFullYear();
    if (freq === 'monthly') return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
    return d.toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', timeZone: 'UTC', ...(long || !sameYear ? { year: 'numeric' } : {}),
    });
  };
  const fmtStamp = (iso) => new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  // Benchmark lines (also forced into the y-range).
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

  // Coloured change bubble: glyph + magnitude + "vs <prior date>"; words for screen readers.
  function bubble(s, withVs) {
    const ch = fmtChange(s.change_format, s.value, s.prev_value, s.format);
    const wrap = el('span', 'signal-change');
    const pill = el('span', 'signal-bubble ' + tone(s.polarity, ch.dir));
    const glyph = el('span', 'signal-glyph', ch.dir > 0 ? '▲' : ch.dir < 0 ? '▼' : '●');
    glyph.setAttribute('aria-hidden', 'true');
    pill.append(glyph, ch.dir === 0 ? el('span', null, 'Unchanged')
      : el('span', null, ch.text));
    if (ch.dir !== 0) pill.prepend(el('span', 'sr-only', ch.dir > 0 ? 'Up ' : 'Down '));
    wrap.append(pill);
    if (withVs) wrap.append(el('span', 'signal-vs', 'vs ' + fmtDate(s.prev_date, s.freq)));
    return wrap;
  }

  // ---- Sparkline ----------------------------------------------------------
  function sparkline(box, s) {
    const pts = s.trend.map(([d, v]) => ({ d, v }));
    const ref = REFERENCE[s.id];
    const first = pts[0].v, last = pts[pts.length - 1].v;
    box.classList.add('spark-' + tone(s.polarity, Math.sign(Number((last - first).toFixed(6)))));
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
      const n = pts.length - 1;
      svg.append(svgEl('circle', { cx: x(n), cy: y(pts[n].v), r: 4, class: 'spark-end' }));
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
      const w = tip.offsetWidth;
      tip.style.left = Math.min(Math.max(px - w / 2, 0), geom.W - w) + 'px';
    };
    const hide = () => {
      active = -1;
      tip.hidden = true;
      box.querySelectorAll('.spark-cross, .spark-hover').forEach((m) => m.setAttribute('visibility', 'hidden'));
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
    const low = pts.reduce((a, b) => (b.v < a.v ? b : a)), high = pts.reduce((a, b) => (b.v > a.v ? b : a));
    box.setAttribute('aria-label',
      `${s.window} trend of ${s.label}: low ${fmtValue(s.format, low.v)} (${fmtDate(low.d, s.freq, true)}), ` +
      `high ${fmtValue(s.format, high.v)} (${fmtDate(high.d, s.freq, true)}). Use the arrow keys to read values.`);
  }

  // ---- Tiles --------------------------------------------------------------
  function tile(s) {
    const card = el('article', 'signal');
    card.id = 'signal-' + s.id;
    const head = el('div', 'signal-head');
    head.append(el('h4', 'signal-label', s.label), el('p', 'signal-sub', s.sub));
    card.append(head, el('p', 'signal-value', fmtValue(s.format, s.value)), bubble(s, true));
    if (s.status) card.append(el('p', 'signal-status', s.status));
    const box = el('div', 'spark');
    box.tabIndex = 0;
    card.append(box);
    const foot = el('div', 'signal-foot');
    const src = el('a', 'signal-src', s.source_name || 'FRED');
    src.href = s.source_url;
    src.target = '_blank';
    src.rel = 'noopener noreferrer';
    src.setAttribute('aria-label', `${s.label} source: ${s.source_name || 'FRED'}`);
    foot.append(el('span', null, fmtDate(s.date, s.freq, true)), el('span', 'signal-window', s.window), src);
    card.append(foot);
    return { card, draw: () => sparkline(box, s) };
  }

  function renderPanel(mount, panel, updated) {
    const groupsMount = mount.querySelector('[data-signals-groups]');
    const frag = document.createDocumentFragment(), drawers = [];
    for (const g of panel.groups || []) {
      const grid = el('div', 'signal-grid');
      for (const s of g.series || []) {
        if (!s.trend || s.trend.length < 2) continue;
        const t = tile(s);
        grid.append(t.card);
        drawers.push(t.draw);
      }
      if (!grid.children.length) continue;
      const group = el('div', 'signal-group');
      group.append(el('h4', 'signal-group-label', g.label), grid);
      frag.append(group);
    }
    if (!drawers.length) throw new Error('no series');
    groupsMount.replaceChildren(frag);
    drawers.forEach((draw) => draw());

    const stamp = mount.querySelector('[data-signals-updated]');
    if (stamp && updated) stamp.textContent = 'Updated ' + fmtStamp(updated);
  }

  // Home: compact chips linking to the News page's signals.
  function renderChips(data) {
    const ids = (chipMount.dataset.ids || '').split(',').map((x) => x.trim()).filter(Boolean);
    const byId = {};
    for (const p of data.panels || []) for (const g of p.groups || []) for (const s of g.series || []) byId[s.id] = s;
    const chips = ids.map((id) => byId[id]).filter(Boolean).map((s) => {
      const a = el('a', 'signal-chip');
      a.href = chipMount.dataset.href || 'news.html#signals';
      a.append(el('span', 'chip-label', s.label), el('span', 'chip-value', fmtValue(s.format, s.value)), bubble(s, false));
      return a;
    });
    if (!chips.length) throw new Error('no chips');
    chipMount.replaceChildren(...chips);
  }

  fetch('/signals.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((data) => {
      // Files written before the two-panel format hold a single United States panel.
      if (!data.panels && data.groups) data.panels = [{ id: 'us', title: 'United States', groups: data.groups }];
      for (const mount of panelMounts) {
        const panel = (data.panels || []).find((p) => p.id === mount.dataset.signalsPanel);
        try {
          if (!panel) throw new Error('missing panel');
          renderPanel(mount, panel, data.updated);
        } catch (err) {
          mount.querySelector('[data-signals-groups]').replaceChildren(el('p', 'news-status', 'These signals will appear here shortly.'));
        }
      }
      if (chipMount) renderChips(data);
    })
    .catch((err) => {
      console.warn('Signals: could not load data.', err);
      for (const mount of panelMounts) {
        mount.querySelector('[data-signals-groups]').replaceChildren(el('p', 'news-status', 'Economic signals will appear here shortly.'));
      }
      if (chipMount) chipMount.replaceChildren();
    });
})();
