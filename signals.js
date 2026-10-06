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
 *           5. Bubble map ([data-bubbles] inside a panel): one floating bubble per
 *              series, coloured like its change bubble and sized by how unusual
 *              the latest move is (move_z: the change in standard deviations of
 *              the series' past moves over the window, from update_signals.py).
 *              Bubbles drift gently and push apart; motion pauses while the
 *              pointer is over the field, when it is off screen, and entirely
 *              under prefers-reduced-motion. Each bubble is a button: hover or
 *              focus shows details, click jumps to the series' card.
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

  // ---- Bubble map ---------------------------------------------------------
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function bubbles(field, panel) {
    const series = (panel.groups || []).flatMap((g) => g.series || []).filter((s) => s.trend && s.trend.length > 1);
    if (!series.length) return;
    const tip = el('div', 'bubble-tip');
    tip.hidden = true;
    let nodes = [], W = 0, H = 0, paused = false, visible = true, raf = 0;

    const build = () => {
      W = field.clientWidth; H = field.clientHeight;
      // Radius = base x (1 + 1.6 z/3): base is chosen so the bubbles cover about 30% of
      // the field whatever its size or the number of series (capped on wide screens).
      const info = series.map((s) => {
        const ch = fmtChange(s.change_format, s.value, s.prev_value, s.format);
        const t = tone(s.polarity, ch.dir);
        const z = t === 'flat' || s.move_z == null ? 0 : Math.min(Math.abs(s.move_z), 3);
        return { ch, t, f: 1 + 1.6 * z / 3 };
      });
      const sumF2 = info.reduce((a, b) => a + b.f * b.f, 0);
      const base = Math.min(Math.sqrt((0.3 * W * H) / (Math.PI * sumF2)), 34, H * 0.12);
      // Largest font (px) at which text fits across ~80% of the bubble's width.
      const fit = (text, r, ratio, maxPx) => Math.max(8, Math.min(maxPx, r * ratio, (1.6 * r) / (Math.max(text.length, 3) * 0.58)));
      const old = new Map(nodes.map((n) => [n.s.id, n]));
      field.replaceChildren(tip);
      nodes = series.map((s, i) => {
        const { ch, t, f } = info[i];
        const r = base * f;
        const b = el('button', 'bubble bubble-' + t);
        b.type = 'button';
        b.style.width = b.style.height = (2 * r).toFixed(1) + 'px';
        const glyph = ch.dir > 0 ? '▲ ' : ch.dir < 0 ? '▼ ' : '';
        const nameText = s.short || s.label;
        const name = el('span', 'bubble-name', nameText);
        name.style.fontSize = fit(nameText, r, 0.24, 15).toFixed(1) + 'px';
        b.append(name);
        if (r >= 38) { // the value only where there is room for a third line
          const valText = fmtValue(s.format, s.value);
          const val = el('span', 'bubble-value', valText);
          val.style.fontSize = fit(valText, r, 0.28, 19).toFixed(1) + 'px';
          b.append(val);
        }
        const chgText = ch.dir === 0 ? 'Flat' : glyph + ch.text;
        const chg = el('span', 'bubble-change', chgText);
        chg.style.fontSize = fit(chgText, r, 0.2, 13).toFixed(1) + 'px';
        b.append(chg);
        const zText = s.move_z == null ? '' : ` Move size: ${Math.abs(s.move_z).toFixed(1)} standard deviations of its usual moves (${s.window.toLowerCase()}).`;
        const words = ch.dir === 0 ? 'unchanged' : (ch.dir > 0 ? 'up ' : 'down ') + ch.text;
        b.setAttribute('aria-label', `${s.label}: ${fmtValue(s.format, s.value)}, ${words} vs ${fmtDate(s.prev_date, s.freq)}.${zText} Opens its card.`);
        const showTip = () => {
          tip.replaceChildren(el('strong', null, s.label),
            el('span', 'bubble-tip-line', fmtValue(s.format, s.value) + '  ·  ' + (ch.dir === 0 ? 'Unchanged' : glyph + ch.text) + ' vs ' + fmtDate(s.prev_date, s.freq)));
          if (s.move_z != null) tip.append(el('span', 'bubble-tip-note', `${Math.abs(s.move_z).toFixed(1)}× a typical move (${s.window.toLowerCase()})`));
          tip.hidden = false;
          const n = nodes.find((m) => m.el === b);
          const tw = tip.offsetWidth, th = tip.offsetHeight;
          let tx = n.x - tw / 2, ty = n.y - n.r - th - 8;
          if (ty < 6) ty = n.y + n.r + 8;
          tip.style.transform = `translate(${Math.max(6, Math.min(W - tw - 6, tx)).toFixed(0)}px, ${Math.max(6, Math.min(H - th - 6, ty)).toFixed(0)}px)`;
        };
        b.addEventListener('pointerenter', showTip);
        b.addEventListener('focus', showTip);
        b.addEventListener('pointerleave', () => { tip.hidden = true; });
        b.addEventListener('blur', () => { tip.hidden = true; });
        b.addEventListener('click', () => {
          const card = document.getElementById('signal-' + s.id);
          if (!card) return;
          card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
          card.classList.remove('signal-flash'); void card.offsetWidth; card.classList.add('signal-flash');
        });
        field.append(b);
        const prev = old.get(s.id);
        // Spread the starting positions on a loose grid so the first frames are calm.
        const cols = Math.ceil(Math.sqrt(series.length * W / H));
        const gx = ((i % cols) + 0.5) * (W / cols), gy = (Math.floor(i / cols) + 0.5) * (H / Math.ceil(series.length / cols));
        return { s, el: b, r, x: prev ? Math.min(prev.x, W - r) : gx + (Math.random() - 0.5) * 20,
                 y: prev ? Math.min(prev.y, H - r) : gy + (Math.random() - 0.5) * 20, vx: 0, vy: 0, phase: Math.random() * 6.283 };
      });
      for (let i = 0; i < 260; i++) step(0, true); // settle overlaps before the first paint
      paint();
    };

    // One physics step: gentle drift, a soft pull to the centre, pairwise separation, walls.
    const step = (t, settling) => {
      for (const n of nodes) {
        if (!settling) {
          n.vx += Math.cos(t * 0.00035 + n.phase) * 0.010;
          n.vy += Math.sin(t * 0.00045 + n.phase * 1.7) * 0.010;
        }
        n.vx += (W / 2 - n.x) * 0.00006;
        n.vy += (H / 2 - n.y) * 0.00010;
      }
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01;
          const min = a.r + b.r + 6;
          if (d < min) {
            const push = (min - d) / 2, ux = dx / d, uy = dy / d;
            a.x -= ux * push; a.y -= uy * push; b.x += ux * push; b.y += uy * push;
            a.vx -= ux * 0.02; a.vy -= uy * 0.02; b.vx += ux * 0.02; b.vy += uy * 0.02;
          }
        }
      }
      for (const n of nodes) {
        n.vx *= 0.97; n.vy *= 0.97;
        n.x += n.vx; n.y += n.vy;
        if (n.x < n.r) { n.x = n.r; n.vx = Math.abs(n.vx) * 0.5; }
        if (n.x > W - n.r) { n.x = W - n.r; n.vx = -Math.abs(n.vx) * 0.5; }
        if (n.y < n.r) { n.y = n.r; n.vy = Math.abs(n.vy) * 0.5; }
        if (n.y > H - n.r) { n.y = H - n.r; n.vy = -Math.abs(n.vy) * 0.5; }
      }
    };
    const paint = () => {
      for (const n of nodes) n.el.style.transform = `translate(${(n.x - n.r).toFixed(1)}px, ${(n.y - n.r).toFixed(1)}px)`;
    };
    const loop = (t) => {
      raf = 0;
      if (paused || !visible || reduceMotion || document.hidden) return;
      step(t, false);
      paint();
      raf = requestAnimationFrame(loop);
    };
    const run = () => { if (!raf && !reduceMotion) raf = requestAnimationFrame(loop); };

    field.addEventListener('pointerenter', () => { paused = true; });
    field.addEventListener('pointerleave', () => { paused = false; tip.hidden = true; run(); });
    field.addEventListener('focusin', () => { paused = true; });
    field.addEventListener('focusout', () => { paused = false; run(); });
    document.addEventListener('visibilitychange', run);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; run(); }).observe(field);
    }
    let lastW = 0;
    if ('ResizeObserver' in window) {
      new ResizeObserver(() => { if (Math.abs(field.clientWidth - lastW) > 2) { lastW = field.clientWidth; build(); } }).observe(field);
    }
    lastW = field.clientWidth;
    build();
    run();
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
    const field = mount.querySelector('[data-bubbles]');
    if (field) bubbles(field, panel);
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
