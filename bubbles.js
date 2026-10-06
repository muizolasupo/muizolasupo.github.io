/*
 * bubbles.js
 * Purpose : Floating "bubble map" for the stock boards on the News page (as on
 *           stock and crypto bubble screens), drawn on a high-resolution canvas.
 * API     : const map = window.BubbleMap.create(board, { label })
 *           map.setItems(items)   items: [{ id, label, value, change,
 *                                  tone: 'good'|'bad'|'flat', weight: 0..1,
 *                                  href, aria, tip: [title, line, note] }]
 *           board must contain [data-bubble-field]; an optional
 *           [data-bubble-fullscreen] button and [data-bubble-live] live region.
 * Rendering
 *   - The canvas is sized in device pixels (devicePixelRatio, max 3), so rims
 *     and text stay sharp on any screen; text is drawn every frame at its
 *     exact sub-pixel position rather than as a moving bitmap.
 *   - Each bubble: tinted radial fill, crisp 1.5px rim, soft halo, glossy
 *     highlight, and up to three centred lines (symbol, price, change), each
 *     fitted to the bubble with measureText.
 * Motion
 *   - Time-based physics (dt in seconds, two sub-steps per frame) so speed is
 *     the same at 60, 120 or 144 Hz: gentle drifting force, weak pull to the
 *     centre, spring separation weighted by bubble mass (area), exponential
 *     damping, soft walls and a speed limit.
 *   - The bubble under the pointer holds still; bubbles can be dragged and
 *     flung. Animation stops when the map is off screen or the tab is hidden,
 *     and is replaced by a settled still layout under prefers-reduced-motion.
 * Interaction and accessibility
 *   - Mouse: hover shows details; click opens the quote page. Touch: the first
 *     tap shows details, a second tap opens. Keyboard: the canvas is focusable;
 *     arrow keys move between stocks (announced in a live region), Enter opens.
 *   - Full screen via the Fullscreen API, or a fixed overlay where that is not
 *     available (e.g. iPhone Safari). Esc or the button exits.
 */
(() => {
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FONT = 'Inter, "Helvetica Neue", Arial, sans-serif';
  const COLORS = {
    good: { base: [46, 160, 67], light: [126, 231, 135] },
    bad: { base: [248, 81, 73], light: [255, 148, 146] },
    flat: { base: [139, 148, 158], light: [201, 209, 217] },
  };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function create(board, options = {}) {
    const field = board.querySelector('[data-bubble-field]');
    const fsButton = board.querySelector('[data-bubble-fullscreen]');
    const live = board.querySelector('[data-bubble-live]');
    const canvas = el('canvas', 'bubble-canvas');
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', (options.label || 'Bubble map') +
      '. Use the arrow keys to move between stocks and Enter to open a quote page.');
    const tip = el('div', 'bubble-tip');
    tip.hidden = true;
    field.replaceChildren(canvas, tip);
    const ctx = canvas.getContext('2d');

    let items = [], nodes = [], W = 0, H = 0, dpr = 1;
    let hovered = null, selected = null, focusIndex = -1, drag = null, lastT = 0, raf = 0, visible = true;
    const measure = (text, weight, px) => { ctx.font = `${weight} ${px}px ${FONT}`; return ctx.measureText(text).width; };

    // ---- Layout: canvas size, radii and font sizes --------------------------
    function resize() {
      const w = field.clientWidth, h = field.clientHeight;
      if (!w || !h) return;
      const sx = W ? w / W : 1, sy = H ? h / H : 1;
      W = w; H = h;
      dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      for (const n of nodes) { n.x *= sx; n.y *= sy; }
      sizeNodes();
      for (let k = 0; k < 120; k++) physics(1 / 60, 0, true);
    }
    function sizeNodes() {
      if (!nodes.length) return;
      const f = nodes.map((n) => 1 + 1.7 * Math.max(0, Math.min(1, n.item.weight || 0)));
      const sumF2 = f.reduce((a, b) => a + b * b, 0);
      const fill = nodes.length > 80 ? 0.3 : 0.32;
      const base = Math.min(Math.sqrt((fill * W * H) / (Math.PI * sumF2)), Math.max(30, Math.min(W, H) * 0.08));
      const minFont = nodes.length > 80 ? 7 : 8;
      nodes.forEach((n, i) => {
        // Never smaller than the symbol needs at the minimum font, with a small margin.
        const need = measure(n.item.label, 700, minFont) / 1.6 + 3;
        n.r = Math.max(base * f[i], need);
        const ri = n.r;
        const fit = (text, weight, ratio, maxPx) => {
          let px = Math.min(maxPx, ri * ratio);
          const w = measure(text, weight, px);
          if (w > ri * 1.62) px *= (ri * 1.62) / w;
          return Math.max(minFont, px);
        };
        n.fs = fit(n.item.label, 700, 0.34, 22);
        n.fc = fit(n.item.change, 600, 0.27, 17);
        n.showValue = ri >= 42 && !!n.item.value;
        n.fv = n.showValue ? fit(n.item.value, 500, 0.22, 14) : 0;
        n.grad = null; // rebuilt at the new radius
      });
    }

    function setItems(next) {
      const old = new Map(nodes.map((n) => [n.item.id, n]));
      items = next;
      if (!W) { W = field.clientWidth; H = field.clientHeight; resize(); }
      const cols = Math.max(1, Math.ceil(Math.sqrt(items.length * W / Math.max(H, 1))));
      const rows = Math.ceil(items.length / cols);
      nodes = items.map((item, i) => {
        const prev = old.get(item.id);
        if (prev) { prev.item = item; return prev; }
        return {
          item, vx: 0, vy: 0, hover: 0, appear: reduceMotion ? 1 : 0, phase: Math.random() * Math.PI * 2,
          x: ((i % cols) + 0.5) * (W / cols) + (Math.random() - 0.5) * 14,
          y: (Math.floor(i / cols) + 0.5) * (H / rows) + (Math.random() - 0.5) * 14,
        };
      });
      if (hovered && !nodes.includes(hovered)) hovered = null;
      if (selected && !nodes.includes(selected)) { selected = null; tip.hidden = true; }
      focusIndex = -1;
      sizeNodes();
      for (let k = 0; k < 220; k++) physics(1 / 60, 0, true); // settle before the first frame
      start();
    }

    // ---- Physics -------------------------------------------------------------
    function physics(dt, t, settling) {
      const cx = W / 2, cy = H / 2;
      const crowded = nodes.length > 60;                               // many bubbles: less squeeze, stiffer springs
      const gx = crowded ? 0.12 : 0.35, gy = crowded ? 0.2 : 0.55, ks = crowded ? 120 : 70;
      for (const n of nodes) {
        if (n === drag?.node) continue;
        let ax = (cx - n.x) * gx, ay = (cy - n.y) * gy;                // weak pull to the centre
        if (!settling && !reduceMotion) {                              // gentle drift
          ax += Math.cos(t * 0.23 + n.phase) * 9;
          ay += Math.sin(t * 0.29 + n.phase * 1.7) * 9;
        }
        n.vx += ax * dt; n.vy += ay * dt;
      }
      for (let i = 0; i < nodes.length; i++) {                         // spring separation
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const min = a.r + b.r + 4;
          if (Math.abs(dx) > min || Math.abs(dy) > min) continue;
          const d = Math.hypot(dx, dy) || 0.01;
          if (d >= min) continue;
          const ux = dx / d, uy = dy / d, overlap = min - d;
          const ma = a.r * a.r, mb = b.r * b.r, wa = mb / (ma + mb), wb = ma / (ma + mb);
          const pinA = a === hovered || a === drag?.node, pinB = b === hovered || b === drag?.node;
          const fa = pinA ? 0 : pinB ? 1 : wa, fb = pinB ? 0 : pinA ? 1 : wb;
          const push = overlap * (settling ? 0.5 : nodes.length > 80 ? 0.35 : 0.22); // positional correction
          a.x -= ux * push * fa; a.y -= uy * push * fa; b.x += ux * push * fb; b.y += uy * push * fb;
          const k = ks * overlap * dt;                                   // spring impulse
          a.vx -= ux * k * fa; a.vy -= uy * k * fa; b.vx += ux * k * fb; b.vy += uy * k * fb;
        }
      }
      const damp = Math.exp(-2.4 * dt), vmax = 140;
      for (const n of nodes) {
        if (n === drag?.node) continue;
        if (n === hovered) { n.vx = 0; n.vy = 0; continue; }           // hold still under the pointer
        n.vx *= damp; n.vy *= damp;
        const sp = Math.hypot(n.vx, n.vy);
        if (sp > vmax) { n.vx *= vmax / sp; n.vy *= vmax / sp; }
        n.x += n.vx * dt; n.y += n.vy * dt;
        if (n.x < n.r) { n.x = n.r; n.vx = Math.abs(n.vx) * 0.4; }
        if (n.x > W - n.r) { n.x = W - n.r; n.vx = -Math.abs(n.vx) * 0.4; }
        if (n.y < n.r) { n.y = n.r; n.vy = Math.abs(n.vy) * 0.4; }
        if (n.y > H - n.r) { n.y = H - n.r; n.vy = -Math.abs(n.vy) * 0.4; }
      }
    }

    // ---- Drawing -------------------------------------------------------------
    // Vector drawing of one bubble centred on the origin of context g.
    function vector(g, n, scale, alpha, focused) {
      const c = COLORS[n.item.tone] || COLORS.flat;
      const r = n.r * scale;
      g.globalAlpha = alpha;
      const body = g.createRadialGradient(0, r * 0.08, 0, 0, 0, r);
      body.addColorStop(0, rgba(c.base, 0.05));
      body.addColorStop(0.55, rgba(c.base, 0.17));
      body.addColorStop(0.86, rgba(c.base, 0.5));
      body.addColorStop(1, rgba(c.light, 0.9));
      const ctx = g; // the drawing below is written against "ctx"
      n.grad = body; n.gradR = r;
      ctx.save();
      ctx.beginPath(); ctx.arc(0, 0, r + 3, 0, Math.PI * 2);                 // soft halo
      ctx.strokeStyle = rgba(c.base, 0.16 + 0.22 * n.hover); ctx.lineWidth = 5; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);                     // body
      ctx.fillStyle = n.grad; ctx.fill();
      ctx.beginPath(); ctx.arc(0, 0, r - 0.75, 0, Math.PI * 2);              // crisp rim
      ctx.strokeStyle = rgba(c.light, 0.85 + 0.15 * n.hover); ctx.lineWidth = 1.5; ctx.stroke();
      ctx.save();                                                            // glossy highlight
      ctx.translate(-r * 0.32, -r * 0.48); ctx.rotate(-0.45); ctx.scale(1, 0.48);
      const hl = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.34);
      hl.addColorStop(0, 'rgba(255,255,255,0.55)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hl; ctx.beginPath(); ctx.arc(0, 0, r * 0.34, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      if (focused) {                                                         // keyboard focus ring
        ctx.beginPath(); ctx.arc(0, 0, r + 6, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();
      }
      // Text: symbol, price (large bubbles), change.
      const k = scale;
      const appear = alpha;
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const lines = [[n.item.label, 700, n.fs * k]];
      if (n.showValue) lines.push([n.item.value, 500, n.fv * k]);
      lines.push([n.item.change, 600, n.fc * k]);
      const gap = 0.18;
      const total = lines.reduce((s, l) => s + l[2], 0) + gap * (lines.length - 1) * lines[0][2];
      let y = -total / 2;
      for (const [text, weight, px] of lines) {
        ctx.font = `${weight} ${px}px ${FONT}`;
        ctx.globalAlpha = appear * (weight === 500 ? 0.86 : 1);
        ctx.fillText(text, 0, y + px / 2);
        y += px + gap * lines[0][2];
      }
      ctx.restore();
    }

    // A bubble at rest is drawn once into a device-resolution sprite; each frame
    // only copies it, aligned to whole device pixels on high-density screens
    // (sharp and smooth), at sub-pixel positions on standard ones (smooth).
    const PAD = 9;
    function sprite(n) {
      const key = [n.r.toFixed(2), n.item.tone, n.item.label, n.item.value, n.item.change, n.fs, n.fc, n.fv, n.showValue, dpr].join('|');
      if (n.sprite && n.spriteKey === key) return n.sprite;
      const R = n.r + PAD, size = Math.ceil(2 * R * dpr);
      const c = n.sprite || document.createElement('canvas');
      c.width = size; c.height = size;
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, 2 * R, 2 * R);
      g.translate(R, R);
      vector(g, n, 1, 1, false);
      n.sprite = c; n.spriteKey = key; n.spriteR = R;
      return c;
    }
    function drawBubble(n, focused) {
      const active = focused || n.hover > 0.01 || n.appear < 1;
      if (active) {                                   // animating: draw as vectors
        ctx.save();
        ctx.translate(n.x, n.y);
        vector(ctx, n, (1 + 0.07 * n.hover) * (0.6 + 0.4 * n.appear), n.appear, focused);
        ctx.restore();
        return;
      }
      const img = sprite(n), R = n.spriteR;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const px = (n.x - R) * dpr, py = (n.y - R) * dpr;
      if (dpr >= 1.5) ctx.drawImage(img, Math.round(px), Math.round(py));
      else ctx.drawImage(img, px, py);
      ctx.restore();
    }

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const focused = focusIndex >= 0 ? nodes[focusIndex] : null;
      // Highlighted bubbles last, so they sit on top.
      for (const n of nodes) if (n !== hovered && n !== selected && n !== focused) drawBubble(n, false);
      for (const n of new Set([selected, hovered, focused])) if (n && nodes.includes(n)) drawBubble(n, n === focused);
      if (!tip.hidden) placeTip();
    }

    // ---- Animation loop --------------------------------------------------------
    function frame(now) {
      raf = 0;
      const t = now / 1000;
      const dt = Math.min(0.033, lastT ? t - lastT : 1 / 60);
      lastT = t;
      let busy = false;
      for (const n of nodes) {
        const target = n === hovered || n === selected || (focusIndex >= 0 && nodes[focusIndex] === n) ? 1 : 0;
        n.hover += (target - n.hover) * Math.min(1, dt * 12);
        if (n.appear < 1) { n.appear = Math.min(1, n.appear + dt * 2.2); busy = true; }
        if (Math.abs(target - n.hover) > 0.01) busy = true;
      }
      if (!reduceMotion || drag) {
        physics(dt / 2, t, false);
        physics(dt / 2, t + dt / 2, false);
      }
      draw();
      if ((!reduceMotion || busy || drag) && visible && !document.hidden) raf = requestAnimationFrame(frame);
    }
    function start() {
      if (!raf) { lastT = 0; raf = requestAnimationFrame(frame); }
    }

    // ---- Details card ------------------------------------------------------------
    function showTip(n) {
      const [title, line, note] = n.item.tip || [n.item.label];
      tip.replaceChildren(el('strong', null, title));
      if (line) tip.append(el('span', 'bubble-tip-line', line));
      if (note) tip.append(el('span', 'bubble-tip-note', note));
      tip.hidden = false;
      tip.dataset.id = n.item.id;
      placeTip();
    }
    function placeTip() {
      const n = nodes.find((m) => m.item.id === tip.dataset.id);
      if (!n) { tip.hidden = true; return; }
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let ty = n.y - n.r - th - 10;
      if (ty < 6) ty = n.y + n.r + 10;
      const tx = Math.max(6, Math.min(W - tw - 6, n.x - tw / 2));
      tip.style.transform = `translate(${Math.round(tx)}px, ${Math.round(Math.max(6, Math.min(H - th - 6, ty)))}px)`;
    }
    const hideTip = () => { tip.hidden = true; };
    const open = (n) => { if (n?.item.href) window.open(n.item.href, '_blank', 'noopener'); };
    const announce = (n) => { if (live && n) live.textContent = n.item.aria || n.item.label; };

    // ---- Pointer: hover, click, drag and fling, tap on touch --------------------
    const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const hit = (x, y) => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if ((x - n.x) ** 2 + (y - n.y) ** 2 <= n.r * n.r) return n;
      }
      return null;
    };
    canvas.addEventListener('pointermove', (e) => {
      const [x, y] = local(e);
      if (drag) {
        const now = performance.now(), dtm = Math.max(1, now - drag.t);
        if (!drag.moved && Math.hypot(x - drag.sx, y - drag.sy) > 6) { drag.moved = true; hideTip(); }
        if (drag.moved) {
          drag.node.vx = ((x - drag.dx) - drag.node.x) / (dtm / 1000);
          drag.node.vy = ((y - drag.dy) - drag.node.y) / (dtm / 1000);
          drag.node.x = Math.max(drag.node.r, Math.min(W - drag.node.r, x - drag.dx));
          drag.node.y = Math.max(drag.node.r, Math.min(H - drag.node.r, y - drag.dy));
          drag.t = now;
        }
        start();
        return;
      }
      if (e.pointerType === 'touch') return;
      const n = hit(x, y);
      if (n !== hovered) {
        hovered = n;
        canvas.style.cursor = n ? 'pointer' : 'default';
        if (n) showTip(n); else if (!selected) hideTip();
        start();
      }
    });
    canvas.addEventListener('pointerleave', () => {
      if (drag) return;
      hovered = null; canvas.style.cursor = 'default';
      if (!selected) hideTip();
      start();
    });
    canvas.addEventListener('pointerdown', (e) => {
      const [x, y] = local(e);
      const n = hit(x, y);
      if (!n) { selected = null; hideTip(); start(); return; }
      canvas.setPointerCapture(e.pointerId);
      drag = { node: n, sx: x, sy: y, dx: x - n.x, dy: y - n.y, moved: false, t: performance.now(), type: e.pointerType };
      start();
    });
    const endDrag = (e) => {
      if (!drag) return;
      const { node, moved, type } = drag;
      drag = null;
      if (moved) {                                       // fling: keep (capped) release velocity
        const sp = Math.hypot(node.vx, node.vy), cap = 600;
        if (sp > cap) { node.vx *= cap / sp; node.vy *= cap / sp; }
      } else if (e.type === 'pointerup') {
        if (type === 'touch' && selected !== node) { selected = node; showTip(node); announce(node); }
        else open(node);
      }
      start();
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    // ---- Keyboard ---------------------------------------------------------------
    const order = () => nodes; // already in board order (largest / most traded first)
    canvas.addEventListener('keydown', (e) => {
      const list = order();
      if (!list.length) return;
      const move = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (move) {
        e.preventDefault();
        focusIndex = focusIndex < 0 ? 0 : (focusIndex + move + list.length) % list.length;
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        focusIndex = e.key === 'Home' ? 0 : list.length - 1;
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (focusIndex >= 0) open(list[focusIndex]);
        return;
      } else if (e.key === 'Escape') {
        focusIndex = -1; hideTip(); start();
        return;
      } else return;
      const n = list[focusIndex];
      showTip(n); announce(n); start();
    });
    canvas.addEventListener('blur', () => { focusIndex = -1; if (!hovered && !selected) hideTip(); start(); });

    // ---- Visibility, size and full screen ----------------------------------------
    document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; if (visible) start(); }).observe(field);
    }
    if ('ResizeObserver' in window) {
      new ResizeObserver(() => {
        if (field.clientWidth !== W || field.clientHeight !== H) { resize(); start(); }
      }).observe(field);
    }
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
        if (native) { if (isFull()) document.exitFullscreen(); else board.requestFullscreen().catch(() => {}); }
        else { board.classList.toggle('is-fullscreen'); sync(); }
      });
      if (native) document.addEventListener('fullscreenchange', sync);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !native && isFull()) { board.classList.remove('is-fullscreen'); sync(); fsButton.focus(); }
      });
      sync();
    }

    resize();
    canvas.bubbleNodes = () => nodes; // read-only hook for automated layout checks
    return { setItems };
  }

  window.BubbleMap = { create };
})();
