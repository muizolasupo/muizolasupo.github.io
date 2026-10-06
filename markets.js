/*
 * markets.js
 * Purpose : Stock-market bubble maps on the News page: one bubble per company,
 *           green when its share price rose, red when it fell, grey when flat,
 *           sized by the size of the day's move. Boards: "us" (largest
 *           U.S.-listed companies) and "ng" (major Nigerian Exchange stocks).
 * Inputs  : /markets.json, written every three hours by scripts/update_markets.py;
 *           each <div data-market-board="ID"> in news.html.
 * Outputs : bubbles via bubbles.js (window.BubbleMap), plus the board's date
 *           line and summary (how many stocks rose, fell, were unchanged).
 * Notes   : A board with no data stays hidden, so the page never shows an
 *           empty map. Bubble weight = |change| / 5%, capped at 1, so moves of
 *           5% or more get the largest bubbles.
 */
(() => {
  const boards = [...document.querySelectorAll('[data-market-board]')];
  if (!boards.length || !window.BubbleMap) return;
  const MINUS = '−';
  const pct = (x) => (x > 0 ? '+' : x < 0 ? MINUS : '') + Math.abs(x).toFixed(2) + '%';
  const money = (v, cur) => (cur === 'NGN' ? '₦' : '$') +
    v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDay = (iso) => {
    if (!iso) return '';
    const d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  };
  const capText = (v) => (v >= 1e12 ? '$' + (v / 1e12).toFixed(2) + 'T' : v >= 1e9 ? '$' + (v / 1e9).toFixed(0) + 'B' : '');

  function render(board, data) {
    const items = (data.items || []).filter((s) => typeof s.change_pct === 'number' && typeof s.price === 'number');
    if (!items.length) { board.hidden = true; return; }
    board.hidden = false;
    const up = items.filter((s) => s.change_pct > 0).length;
    const down = items.filter((s) => s.change_pct < 0).length;
    const flat = items.length - up - down;
    const summary = board.querySelector('[data-market-summary]');
    if (summary) {
      summary.textContent = `${fmtDay(data.date)} close · ${up} up, ${down} down, ${flat} unchanged · Source: ${data.source}`;
    }
    const bubbles = items.map((s) => {
      const tone = s.change_pct > 0 ? 'good' : s.change_pct < 0 ? 'bad' : 'flat';
      const glyph = s.change_pct > 0 ? '▲ ' : s.change_pct < 0 ? '▼ ' : '';
      const cap = s.market_cap ? capText(s.market_cap) : '';
      const words = s.change_pct === 0 ? 'unchanged' : (s.change_pct > 0 ? 'up ' : 'down ') + Math.abs(s.change_pct).toFixed(2) + ' percent';
      return {
        id: s.symbol,
        label: s.symbol,
        value: money(s.price, s.currency),
        change: s.change_pct === 0 ? '0.00%' : glyph + pct(s.change_pct).replace(/^[+−]/, ''),
        tone,
        weight: Math.min(Math.abs(s.change_pct) / 5, 1),
        href: s.url,
        aria: `${s.name} (${s.symbol}): ${money(s.price, s.currency)}, ${words} on the day. Opens a quote page.`,
        tip: [s.name + ' · ' + s.symbol, `${money(s.price, s.currency)}  ·  ${glyph}${pct(s.change_pct)}`,
              [s.prev ? 'Previous close ' + money(s.prev, s.currency) : '', cap ? 'Market value ' + cap : ''].filter(Boolean).join(' · ')],
      };
    });
    window.BubbleMap.mount(board, bubbles, { fill: 0.32 });
  }

  fetch('/markets.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((data) => {
      for (const board of boards) {
        const b = (data.boards || []).find((x) => x.id === board.dataset.marketBoard);
        if (b) render(board, b); else board.hidden = true;
      }
    })
    .catch((err) => {
      console.warn('Markets: could not load data.', err);
      boards.forEach((b) => { b.hidden = true; });
    });
})();
