/*
 * bubbles.js
 * Purpose : Reusable floating "bubble map" (as on stock and crypto bubble
 *           screens) with a full-screen button. Used by markets.js for the
 *           U.S. and NGX stock maps on the News page.
 * API     : window.BubbleMap.mount(board, items, options)
 *             board   : element containing a [data-bubble-field] (the dark
 *                       field) and optionally a [data-bubble-fullscreen] button.
 *             items   : [{ id, label, value, change, tone: 'good'|'bad'|'flat',
 *                         weight: 0..1, href, aria, tip: [title, line, note] }]
 *             options : { fill: share of the field covered by bubbles (0.3) }
 * Notes   : 1. Radius = base x (1 + 1.6 x weight); base is chosen so the bubbles
 *              cover about `fill` of the field at any size (also in full screen);
 *              a bubble is never smaller than its label needs at an 8px font.
 *           2. Bubbles drift and push apart with a small physics loop. Motion
 *              pauses while the pointer or keyboard focus is inside the field,
 *              when it is off screen or the tab is hidden, and is off entirely
 *              under prefers-reduced-motion.
 *           3. Each bubble is a link (new tab) with a full aria-label; hover or
 *              focus shows a details card. All text is set with textContent.
 *           4. Full screen uses the Fullscreen API where available, otherwise a
 *              fixed overlay (e.g. iPhone Safari). Esc or the button exits.
 */
(() => {
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  // Largest font (px) at which text fits across ~80% of a bubble of radius r.
  // 0.7 em per character suits bold capitals (ticker symbols), the widest case.
  const fit = (text, r, ratio, maxPx) => Math.max(8, Math.min(maxPx, r * ratio, (1.6 * r) / (Math.max(text.length, 3) * 0.7)));

  function mount(board, items, options = {}) {
    const field = board.querySelector('[data-bubble-field]');
    const fsButton = board.querySelector('[data-bubble-fullscreen]');
    const fill = options.fill || 0.3;
    const tip = el('div', 'bubble-tip');
    tip.hidden = true;
    let nodes = [], W = 0, H = 0, paused = false, visible = true, raf = 0, lastSize = '';

    const build = () => {
      W = field.clientWidth; H = field.clientHeight;
      lastSize = W + 'x' + H;
      const f = items.map((it) => 1 + 1.6 * Math.max(0, Math.min(1, it.weight || 0)));
      const sumF2 = f.reduce((a, b) => a + b * b, 0) || 1;
      const cap = Math.max(34, Math.min(W, H) * 0.075);
      const base = Math.min(Math.sqrt((fill * W * H) / (Math.PI * sumF2)), cap, H * 0.12);
      const old = new Map(nodes.map((n) => [n.id, n]));
      field.replaceChildren(tip);
      const cols = Math.max(1, Math.ceil(Math.sqrt(items.length * W / Math.max(H, 1))));
      const rows = Math.ceil(items.length / cols);
      nodes = items.map((it, i) => {
        // Never smaller than its longest line needs at the 8px minimum font.
        const longest = Math.max(String(it.label).length, String(it.change || '').length);
        const r = Math.max(base * f[i], longest * 3.6);
        const b = el('a', 'bubble bubble-' + (it.tone || 'flat'));
        b.href = it.href || '#';
        if (it.href) { b.target = '_blank'; b.rel = 'noopener noreferrer'; }
        b.style.width = b.style.height = (2 * r).toFixed(1) + 'px';
        b.setAttribute('aria-label', it.aria || it.label);
        const name = el('span', 'bubble-name', it.label);
        name.style.fontSize = fit(it.label, r, 0.26, 18).toFixed(1) + 'px';
        b.append(name);
        if (it.value && r >= 40) {
          const v = el('span', 'bubble-value', it.value);
          v.style.fontSize = fit(it.value, r, 0.2, 13).toFixed(1) + 'px';
          b.append(v);
        }
        const c = el('span', 'bubble-change', it.change);
        c.style.fontSize = fit(it.change, r, 0.24, 17).toFixed(1) + 'px';
        b.append(c);
        const showTip = () => {
          const [title, line, note] = it.tip || [it.label];
          tip.replaceChildren(el('strong', null, title));
          if (line) tip.append(el('span', 'bubble-tip-line', line));
          if (note) tip.append(el('span', 'bubble-tip-note', note));
          tip.hidden = false;
          const n = nodes.find((m) => m.el === b);
          const tw = tip.offsetWidth, th = tip.offsetHeight;
          let ty = n.y - n.r - th - 8;
          if (ty < 6) ty = n.y + n.r + 8;
          tip.style.transform = `translate(${Math.max(6, Math.min(W - tw - 6, n.x - tw / 2)).toFixed(0)}px, ${Math.max(6, Math.min(H - th - 6, ty)).toFixed(0)}px)`;
        };
        b.addEventListener('pointerenter', showTip);
        b.addEventListener('focus', showTip);
        b.addEventListener('pointerleave', () => { tip.hidden = true; });
        b.addEventListener('blur', () => { tip.hidden = true; });
        field.append(b);
        const prev = old.get(it.id);
        const gx = ((i % cols) + 0.5) * (W / cols), gy = (Math.floor(i / cols) + 0.5) * (H / rows);
        return { id: it.id, el: b, r, phase: Math.random() * 6.283, vx: 0, vy: 0,
                 x: prev ? prev.x * (W / prev.W) : gx + (Math.random() - 0.5) * 16,
                 y: prev ? prev.y * (H / prev.H) : gy + (Math.random() - 0.5) * 16, W, H };
      });
      nodes.forEach((n) => { n.W = W; n.H = H; });
      for (let k = 0; k < 280; k++) step(0, true); // settle before the first paint
      paint();
    };

    // One physics step: gentle drift, soft pull to the centre, pairwise separation, walls.
    const step = (t, settling) => {
      for (const n of nodes) {
        if (!settling) {
          n.vx += Math.cos(t * 0.00035 + n.phase) * 0.012;
          n.vy += Math.sin(t * 0.00045 + n.phase * 1.7) * 0.012;
        }
        n.vx += (W / 2 - n.x) * 0.00005;
        n.vy += (H / 2 - n.y) * 0.00009;
      }
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01, min = a.r + b.r + 5;
          if (d < min) {
            const push = (min - d) / 2, ux = dx / d, uy = dy / d;
            a.x -= ux * push; a.y -= uy * push; b.x += ux * push; b.y += uy * push;
            a.vx -= ux * 0.02; a.vy -= uy * 0.02; b.vx += ux * 0.02; b.vy += uy * 0.02;
          }
        }
      }
      for (const n of nodes) {
        n.vx *= 0.97; n.vy *= 0.97; n.x += n.vx; n.y += n.vy;
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
      step(t, false); paint();
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
    if ('ResizeObserver' in window) {
      new ResizeObserver(() => { if (field.clientWidth + 'x' + field.clientHeight !== lastSize) build(); }).observe(field);
    }

    // ---- Full screen -------------------------------------------------------
    if (fsButton) {
      const native = !!(board.requestFullscreen && document.fullscreenEnabled);
      const isFull = () => (native ? document.fullscreenElement === board : board.classList.contains('is-fullscreen'));
      const sync = () => {
        const on = isFull();
        board.classList.toggle('is-fullscreen', on);
        document.documentElement.classList.toggle('bubble-fullscreen-open', on && !native);
        fsButton.setAttribute('aria-pressed', String(on));
        fsButton.setAttribute('aria-label', on ? 'Exit full screen' : 'View full screen');
        fsButton.title = on ? 'Exit full screen' : 'View full screen';
      };
      fsButton.addEventListener('click', () => {
        if (native) {
          if (isFull()) document.exitFullscreen(); else board.requestFullscreen().catch(() => {});
        } else {
          board.classList.toggle('is-fullscreen');
          sync();
        }
      });
      if (native) document.addEventListener('fullscreenchange', sync);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !native && isFull()) { board.classList.remove('is-fullscreen'); sync(); fsButton.focus(); }
      });
      sync();
    }

    build();
    run();
  }

  window.BubbleMap = { mount };
})();
