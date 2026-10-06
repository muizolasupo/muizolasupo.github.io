/*
 * markets.js
 * Purpose : Stock-market bubble maps on the News page: one bubble per company,
 *           green when its share price rose, red when it fell, grey when flat,
 *           sized by the size of the day's move. Boards: "us" (about 100 of the
 *           largest U.S. companies, by market value) and "ng" (every Nigerian
 *           Exchange equity, by value traded that day).
 * Inputs  : /markets.json, written every three hours by scripts/update_markets.py;
 *           each <div data-market-board="ID"> in news.html.
 * Outputs : bubbles via bubbles.js (window.BubbleMap); the board's summary line;
 *           a "Top 25 / 50 / All" selector; a List view (a table of the same
 *           stocks, also the accessible alternative to the canvas).
 * Notes   : A board with no data stays hidden. Bubble weight = |change| / 5%,
 *           capped at 1, so moves of 5% or more get the largest bubbles. "All"
 *           is offered on wide screens and in full screen, where there is room.
 *           Field height grows with the number of bubbles shown.
 */
(() => {
  const boards = [...document.querySelectorAll('[data-market-board]')];
  if (!boards.length || !window.BubbleMap) return;
  const MINUS = '−';
  const pct = (x) => (x > 0 ? '+' : x < 0 ? MINUS : '') + Math.abs(x).toFixed(2) + '%';
  const money = (v, cur) => (cur === 'NGN' ? '₦' : '$') +
    v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const big = (v, cur) => {
    const sym = cur === 'NGN' ? '₦' : '$';
    if (!v) return '';
    if (v >= 1e12) return sym + (v / 1e12).toFixed(2) + 'T';
    if (v >= 1e9) return sym + (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return sym + (v / 1e6).toFixed(1) + 'M';
    return sym + Math.round(v).toLocaleString();
  };
  const fmtDay = (iso) => {
    if (!iso) return '';
    const d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  };
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const narrow = () => window.matchMedia('(max-width: 700px)').matches;

  // Bubble description for one stock.
  function bubbleItem(s) {
    const tone = s.change_pct > 0 ? 'good' : s.change_pct < 0 ? 'bad' : 'flat';
    const glyph = s.change_pct > 0 ? '▲ ' : s.change_pct < 0 ? '▼ ' : '';
    const title = s.name ? `${s.name} · ${s.symbol}` : s.symbol;
    const extra = [s.prev ? 'Previous close ' + money(s.prev, s.currency) : '',
      s.market_cap ? 'Market value ' + big(s.market_cap, 'USD') : '',
      s.sector ? s.sector : '', s.value_traded ? 'Traded today ' + big(s.value_traded, 'NGN') : ''].filter(Boolean).join(' · ');
    const words = s.change_pct === 0 ? 'unchanged' : (s.change_pct > 0 ? 'up ' : 'down ') + Math.abs(s.change_pct).toFixed(2) + ' percent';
    return {
      id: s.symbol, label: s.symbol, value: money(s.price, s.currency),
      change: s.change_pct === 0 ? '0.00%' : glyph + Math.abs(s.change_pct).toFixed(2) + '%',
      tone, weight: Math.min(Math.abs(s.change_pct) / 5, 1), href: s.url,
      aria: `${s.name || s.symbol} (${s.symbol}): ${money(s.price, s.currency)}, ${words} on the day.`,
      tip: [title, `${money(s.price, s.currency)}  ·  ${glyph}${pct(s.change_pct)}`, extra],
    };
  }

  function render(board, data) {
    const all = (data.items || []).filter((s) => typeof s.change_pct === 'number' && typeof s.price === 'number');
    if (!all.length) { board.hidden = true; return; }
    board.hidden = false;
    const up = all.filter((s) => s.change_pct > 0).length, down = all.filter((s) => s.change_pct < 0).length;
    const summary = board.querySelector('[data-market-summary]');
    if (summary) {
      summary.textContent = `${fmtDay(data.date)} close · ${all.length} stocks: ${up} up, ${down} down, ` +
        `${all.length - up - down} unchanged · Ranked by ${data.ranking || 'size'} · Source: ${data.source}`;
    }
    const map = window.BubbleMap.create(board, { label: `${data.title} bubble map` });
    const counts = board.querySelector('[data-market-counts]');
    const listToggle = board.querySelector('[data-market-list-toggle]');
    const listBox = board.querySelector('[data-market-list]');
    const stage = board.querySelector('.bubble-stage');
    let count = narrow() ? 25 : 50;

    // Field height grows with the number of bubbles (the map stays readable).
    const heightFor = (n) => (narrow() ? (n <= 25 ? 470 : 640) : n <= 25 ? 400 : n <= 50 ? 470 : Math.min(820, Math.round(300 + n * 3.3)));
    const apply = () => {
      const shown = count === 'all' ? all : all.slice(0, count);
      if (!board.classList.contains('is-fullscreen')) board.style.setProperty('--field-h', heightFor(shown.length) + 'px');
      map.setItems(shown.map(bubbleItem));
      counts.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(String(count) === b.dataset.count)));
      if (!listBox.hidden) renderList(shown);
    };
    // Count selector: 25, 50, All (All hidden on narrow screens unless in full screen).
    const options = [25, 50, 'all'];
    counts.replaceChildren(...options.map((c) => {
      const b = el('button', 'count-btn', c === 'all' ? `All ${all.length}` : `Top ${c}`);
      b.type = 'button';
      b.dataset.count = String(c);
      b.addEventListener('click', () => { count = c === 'all' ? 'all' : c; apply(); });
      return b;
    }));
    const syncAllOption = () => {
      const allBtn = counts.querySelector('[data-count="all"]');
      const allowed = !narrow() || board.classList.contains('is-fullscreen');
      allBtn.hidden = !allowed || all.length <= 50;
      if (!allowed && count === 'all') { count = 50; apply(); }
    };
    // List view: a table of the stocks shown (also the accessible alternative).
    const renderList = (shown) => {
      const table = el('table', 'market-table');
      const head = el('tr');
      ['Stock', 'Price', 'Change', data.id === 'us' ? 'Market value' : 'Traded today'].forEach((h) => head.append(el('th', null, h)));
      const thead = el('thead'); thead.append(head);
      const tbody = el('tbody');
      for (const s of shown) {
        const tr = el('tr');
        const name = el('td', 'mt-stock');
        const a = el('a', null, s.symbol); a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        name.append(a); if (s.name) name.append(el('span', 'mt-name', s.name));
        const ch = el('td', 'mt-change ' + (s.change_pct > 0 ? 'good' : s.change_pct < 0 ? 'bad' : 'flat'), pct(s.change_pct));
        tr.append(name, el('td', 'mt-num', money(s.price, s.currency)), ch,
          el('td', 'mt-num', data.id === 'us' ? big(s.market_cap, 'USD') : big(s.value_traded, 'NGN')));
        tbody.append(tr);
      }
      table.append(thead, tbody);
      listBox.replaceChildren(table);
    };
    listToggle.addEventListener('click', () => {
      const showList = listBox.hidden;
      listBox.hidden = !showList;
      stage.hidden = showList;
      listToggle.setAttribute('aria-pressed', String(showList));
      listToggle.textContent = showList ? 'Bubbles' : 'List';
      if (showList) renderList(count === 'all' ? all : all.slice(0, count));
    });
    // Re-check options when entering or leaving full screen or resizing across the breakpoint.
    new MutationObserver(() => {
      syncAllOption();
      if (board.classList.contains('is-fullscreen')) board.style.removeProperty('--field-h');
      else board.style.setProperty('--field-h', heightFor(count === 'all' ? all.length : Math.min(count, all.length)) + 'px');
    }).observe(board, { attributes: true, attributeFilter: ['class'] });
    window.matchMedia('(max-width: 700px)').addEventListener('change', syncAllOption);
    syncAllOption();
    apply();
  }

  fetch('/markets.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((data) => {
      for (const board of boards) {
        const b = (data.boards || []).find((x) => x.id === board.dataset.marketBoard);
        if (b && b.items && b.items.length) render(board, b); else board.hidden = true;
      }
    })
    .catch((err) => {
      console.warn('Markets: could not load data.', err);
      boards.forEach((b) => { b.hidden = true; });
    });
})();
