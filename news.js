/*
 * news.js
 * Purpose : Render the economy and markets headlines from /news.json:
 *             - on the News page ([data-news]): one tab per category and six
 *               headlines per tab;
 *             - on Home ([data-news-teaser]): a short preview, the newest
 *               headline from each of up to three categories.
 *           Every headline has a thumbnail and links to the original
 *           publisher in a new tab.
 * Inputs  : /news.json, refreshed every three hours by
 *           .github/workflows/news.yml (scripts/update_news.py).
 * Notes   : 1. Feed text is inserted with textContent only (never innerHTML) and
 *              only http(s) links are rendered, so feed content cannot inject markup.
 *           2. Tabs follow the WAI-ARIA tabs pattern: arrow keys, Home and End
 *              move between categories.
 *           3. Thumbnails are the publishers' own images, loaded lazily without a
 *              referrer. When a publisher supplies no image (or it fails to load),
 *              the tile shows the publisher's logo (site icon); if that also
 *              fails, its initials.
 *           4. If news.json is missing or unreadable, a short notice is shown.
 */
(() => {
  const full = document.querySelector('[data-news]');
  const teaser = document.querySelector('[data-news-teaser]');
  if (!full && !teaser) return;

  // ---- Helpers ------------------------------------------------------------
  // "12 min ago", "5 h ago", or a short date for anything older than a day.
  const ago = (iso) => {
    const then = new Date(iso);
    const mins = Math.round((Date.now() - then.getTime()) / 60000);
    if (!isFinite(mins)) return '';
    if (mins < 60) return Math.max(mins, 1) + ' min ago';
    if (mins < 24 * 60) return Math.round(mins / 60) + ' h ago';
    return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const stamp = (iso) => new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  const safeUrl = (url) => {
    try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
  };
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  };

  // Fallback tile: the publisher's site icon, then its initials.
  const INITIALS = {
    'Federal Reserve': 'FED', 'Liberty Street Economics': 'NY FED', 'The Economist': 'TE',
    'PBS NewsHour': 'PBS', MarketWatch: 'MW', NBER: 'NBER', BEA: 'BEA', CNBC: 'CNBC', NPR: 'NPR',
    Nairametrics: 'NM', BusinessDay: 'BD', 'Premium Times': 'PT', 'African Business': 'AB',
    'The Africa Report': 'TAR',
  };
  const initials = (source) => INITIALS[source] ||
    source.split(/\s+/).map((w) => w[0]).join('').slice(0, 4).toUpperCase();
  const initialsTile = (source) => {
    const tile = el('span', 'news-thumb news-thumb-fallback', initials(source));
    tile.setAttribute('aria-hidden', 'true');
    return tile;
  };
  const logoTile = (item) => {
    let host = '';
    try { host = new URL(item.url).hostname; } catch { return initialsTile(item.source); }
    const tile = el('span', 'news-thumb news-thumb-logo');
    tile.setAttribute('aria-hidden', 'true');
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.width = 48;
    img.height = 48;
    img.addEventListener('error', () => tile.replaceWith(initialsTile(item.source)), { once: true });
    img.src = 'https://www.google.com/s2/favicons?sz=128&domain=' + encodeURIComponent(host);
    tile.appendChild(img);
    return tile;
  };
  const thumb = (item) => {
    const src = item.image ? safeUrl(item.image) : null;
    if (!src || !src.startsWith('https://')) return logoTile(item);
    const frame = el('span', 'news-thumb');
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.width = 112;
    img.height = 84;
    img.addEventListener('error', () => frame.replaceWith(logoTile(item)), { once: true });
    img.src = src;
    frame.appendChild(img);
    return frame;
  };
  // One headline row: thumbnail, "SOURCE · time", title.
  const headline = (item) => {
    const href = safeUrl(item.url);
    if (!href) return null;
    const a = el('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const source = el('span', 'news-source', item.source);
    const when = el('time', null, ago(item.published));
    when.dateTime = item.published;
    source.append(' · ', when);
    a.append(thumb(item), source, el('span', 'news-title', item.title));
    const li = el('li', 'news-item');
    li.appendChild(a);
    return li;
  };

  // ---- News page: tabs ----------------------------------------------------
  function renderFull(data) {
    const tabBar = full.querySelector('[data-news-tabs]');
    const panel = full.querySelector('[data-news-panel]');
    const list = full.querySelector('[data-news-list]');
    const statusLine = full.querySelector('[data-news-status]');
    const updatedLine = full.querySelector('[data-news-updated]');
    const cats = (data.categories || []).filter((c) => c.items && c.items.length);
    if (!cats.length) { statusLine.textContent = 'Headlines will appear here shortly.'; return; }
    const showCategory = (cat) => {
      list.replaceChildren(...cat.items.map(headline).filter(Boolean));
      statusLine.hidden = list.children.length > 0;
      if (!list.children.length) statusLine.textContent = 'No recent headlines in this category.';
    };
    const tabs = cats.map((cat, i) => {
      const tab = el('button', 'news-tab', cat.label);
      tab.type = 'button';
      tab.id = 'news-tab-' + cat.id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panel.id);
      tab.addEventListener('click', () => select(i));
      return tab;
    });
    const select = (i, focus) => {
      tabs.forEach((t, j) => {
        t.setAttribute('aria-selected', String(i === j));
        t.tabIndex = i === j ? 0 : -1;
      });
      panel.setAttribute('aria-labelledby', tabs[i].id);
      showCategory(cats[i]);
      if (focus) tabs[i].focus();
    };
    tabBar.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const keys = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      select((keys[e.key] + tabs.length) % tabs.length, true);
    });
    tabBar.replaceChildren(...tabs);
    // Open the tab named in the address (news.html#africa), else the first.
    const fromHash = cats.findIndex((c) => '#' + c.id === location.hash);
    select(fromHash >= 0 ? fromHash : 0);
    if (data.updated && updatedLine) updatedLine.textContent = 'Updated ' + stamp(data.updated) + '. Headlines link to the original publishers.';
  }

  // ---- Home: preview ------------------------------------------------------
  function renderTeaser(data) {
    const list = teaser.querySelector('[data-news-list]');
    const want = (teaser.dataset.categories || 'economy,markets,africa').split(',');
    const cats = data.categories || [];
    const picks = want.map((id) => cats.find((c) => c.id === id)).filter((c) => c && c.items && c.items.length)
      .map((c) => c.items[0]);
    const rows = picks.map(headline).filter(Boolean);
    if (!rows.length) throw new Error('no headlines');
    list.replaceChildren(...rows);
  }

  fetch('/news.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((data) => {
      if (full) renderFull(data);
      if (teaser) renderTeaser(data);
    })
    .catch((err) => {
      console.warn('News: could not load headlines.', err);
      if (full) full.querySelector('[data-news-status]').textContent = 'Headlines will appear here shortly.';
      if (teaser) teaser.querySelector('[data-news-list]').replaceChildren(el('li', 'news-status', 'Headlines will appear here shortly.'));
    });
})();
