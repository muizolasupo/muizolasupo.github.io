/*
 * news.js
 * Purpose : Render the "Economy & markets" headlines on the Home page.
 * Inputs  : /news.json, refreshed every three hours by
 *           .github/workflows/news.yml (scripts/update_news.py);
 *           the <div data-news> block in index.html.
 * Outputs : one tab per news category and a list of headlines, each linking to
 *           the original publisher in a new tab.
 * Notes   : 1. Feed text is inserted with textContent only (never innerHTML) and
 *              only http(s) links are rendered, so feed content cannot inject markup.
 *           2. Tabs follow the WAI-ARIA tabs pattern: arrow keys, Home and End
 *              move between categories.
 *           3. If news.json is missing or unreadable, a short notice replaces the list.
 */
(() => {
  const root = document.querySelector('[data-news]');
  if (!root) return;
  const tabBar = root.querySelector('[data-news-tabs]');
  const panel = root.querySelector('[data-news-panel]');
  const list = root.querySelector('[data-news-list]');
  const statusLine = root.querySelector('[data-news-status]');
  const updatedLine = root.querySelector('[data-news-updated]');
  const SVG = 'http://www.w3.org/2000/svg';

  // ---- Formatting helpers -------------------------------------------------
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
  // Small "opens elsewhere" arrow drawn after each headline.
  const arrow = () => {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'news-arrow');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', 'M7 17 17 7M8 7h9v9');
    svg.appendChild(path);
    return svg;
  };
  const notice = (text) => { list.replaceChildren(); statusLine.textContent = text; statusLine.hidden = false; };

  // ---- Rendering ----------------------------------------------------------
  const showCategory = (cat) => {
    list.replaceChildren();
    for (const item of cat.items) {
      const href = safeUrl(item.url);
      if (!href) continue;
      const a = el('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      const source = el('span', 'news-source', item.source);
      const when = el('time', null, ago(item.published));
      when.dateTime = item.published;
      source.append(' · ', when);
      a.append(source, el('span', 'news-title', item.title), arrow());
      const li = el('li', 'news-item');
      li.appendChild(a);
      list.appendChild(li);
    }
    statusLine.hidden = list.children.length > 0;
    if (!list.children.length) statusLine.textContent = 'No recent headlines in this category.';
  };

  const render = (data) => {
    const cats = (data.categories || []).filter((c) => c.items && c.items.length);
    if (!cats.length) { notice('Headlines will appear here shortly.'); return; }
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
    select(0);
    if (data.updated) updatedLine.textContent = 'Updated ' + stamp(data.updated) + '. Headlines link to the original publishers.';
  };

  fetch('/news.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(render)
    .catch((err) => {
      console.warn('News: could not load headlines.', err);
      notice('Headlines will appear here shortly.');
    });
})();
