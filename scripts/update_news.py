"""
update_news.py
Purpose : Refresh the "Economy & markets" headlines on the Home page.
          Reads a fixed list of publisher RSS/Atom feeds, keeps each item's
          headline, link, source, publication time and thumbnail image URL
          (never article text), and writes the newest items per category to
          news.json, which news.js renders on index.html. Thumbnails come from
          the feed itself or, failing that, the article page's og:image; images
          are linked from the publisher, not copied.
Inputs  : the FEEDS list below; the previous news.json (if any), used to keep
          a stable first-seen time for items whose feed carries no date.
Outputs : news.json at the repository root, rewritten only when the set of
          headlines changes, so the scheduled workflow commits only real updates.
Depends : Python 3.9+, feedparser (pip install feedparser).
Run by  : .github/workflows/news.yml (every three hours, on demand, and when
          this script or the workflow changes).
"""
from __future__ import annotations

import calendar
import html
import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from urllib.parse import urljoin
from pathlib import Path

import feedparser

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
OUT = Path(__file__).resolve().parent.parent / "news.json"
USER_AGENT = "Mozilla/5.0 (compatible; muizolasupo.com headline reader; +https://muizolasupo.com)"
TIMEOUT_S = 20            # per-feed network timeout
PER_CATEGORY = 6          # headlines shown per tab
PER_SOURCE_FIRST_PASS = 2 # variety: at most this many per source before back-filling
MAX_TITLE = 170           # characters; longer headlines are trimmed at a word boundary
PAGE_BYTES = 400_000      # read at most this much of an article page when looking for og:image
MAX_PAGE_LOOKUPS = 24     # og:image page fetches per run (only for newly chosen headlines)

# Category id -> (tab label, maximum item age in days)
CATEGORIES = {
    "economy": ("Economy", 10),
    "markets": ("Markets", 4),
    "policy":  ("Policy & research", 45),
    "africa":  ("Nigeria & Africa", 5),
}

# Personal-finance advice columns ("I'm 67 and ...", "My wife ...",
# "'The pain was excruciating': ...") are not market news; they are skipped for
# the feeds that carry them. Signals: first person singular, or a headline that
# opens with a quoted phrase followed by a colon.
ADVICE_COLUMN = re.compile(r"(?<![\w’'])(I|I’m|I'm|I’ve|I've|I’d|I'd|I’ll|I'll|[Mm]y|me)(?![\w’'])"
                           r"|^[‘'“\"][^:]{3,90}[’'”\"]:")

# General-interest feeds also carry lifestyle, entertainment and corporate PR items;
# for the sources listed in ECON_ONLY a headline must mention an economic topic.
ECON_TERMS = re.compile(
    r"naira|₦|\bcbn\b|central bank|inflation|\bgdp\b|econom|\bbank|\bngx\b|stock|\bshares?\b|equit|bond|"
    r"treasur|debt|loan|credit|budget|fiscal|monetary|\btax|tariff|revenue|forex|\bfx\b|exchange rate|dollar|"
    r"interest rate|\bmpc\b|\boil\b|crude|refiner|petrol|\bfuel|\bgas\b|nnpc|\bpower\b|electricity|energy|"
    r"mining|export|import|\btrade|invest|market|price|cost of living|wage|salar|\bjobs?\b|unemploy|\bimf\b|"
    r"world bank|afdb|afrexim|ecowas|agri|\bfood|manufactur|telecom|fintech|startup|earnings|profit|dividend|"
    r"capital|funding|\bipo\b|\bsmes?\b|industr|\bports?\b|customs|subsid|privati[sz]|growth|recession|"
    r"deficit|reserves|insur|pension|remittance|eurobond|sukuk|liquidity|\bfirms?\b",
    re.I)
ECON_ONLY = {"BusinessDay", "Premium Times", "The Africa Report", "PBS NewsHour"}  # PBS economy feed also carries "News Wrap"

# (source shown on the site, feed URL, category id, headline pattern to skip or None)
FEEDS = [
    ("NPR",                      "https://feeds.npr.org/1017/rss.xml",                                "economy", None),
    ("PBS NewsHour",             "https://www.pbs.org/newshour/feeds/rss/economy",                    "economy", None),
    ("The Economist",            "https://www.economist.com/finance-and-economics/rss.xml",           "economy", None),
    ("CNBC",                     "https://www.cnbc.com/id/20910258/device/rss/rss.html",              "economy", None),
    ("MarketWatch",              "https://feeds.content.dowjones.io/public/rss/mw_topstories",        "markets", ADVICE_COLUMN),
    ("CNBC",                     "https://www.cnbc.com/id/10000664/device/rss/rss.html",              "markets", ADVICE_COLUMN),
    ("CNBC",                     "https://www.cnbc.com/id/15839069/device/rss/rss.html",              "markets", ADVICE_COLUMN),
    ("Federal Reserve",          "https://www.federalreserve.gov/feeds/press_monetary.xml",           "policy",  None),
    ("Federal Reserve",          "https://www.federalreserve.gov/feeds/speeches.xml",                 "policy",  None),
    ("BEA",                      "https://apps.bea.gov/rss/rss.xml",                                  "policy",  None),
    ("NBER",                     "https://www.nber.org/rss/new.xml",                                  "policy",  None),
    ("Liberty Street Economics", "https://libertystreeteconomics.newyorkfed.org/feed/",               "policy",  None),
    # Nigeria (business and economy desks) and Africa-wide business coverage.
    ("Nairametrics",             "https://nairametrics.com/feed/",                                    "africa",  ADVICE_COLUMN),
    ("BusinessDay",              "https://businessday.ng/feed/",                                      "africa",  None),
    ("Premium Times",            "https://www.premiumtimesng.com/business/feed",                      "africa",  None),
    ("African Business",         "https://african.business/feed",                                     "africa",  None),
    ("The Africa Report",        "https://www.theafricareport.com/feed/",                             "africa",  None),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def clean_title(raw: str) -> str:
    """Strip markup and entities, collapse whitespace, trim very long headlines."""
    text = html.unescape(re.sub(r"<[^>]+>", " ", raw or ""))
    text = re.sub(r"\s+", " ", text).strip()
    text = re.split(r"\s+--\s+by\s+", text, maxsplit=1)[0]  # NBER author suffix
    if len(text) > MAX_TITLE:
        text = text[:MAX_TITLE].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    return text


def norm_key(title: str) -> str:
    """Key used to drop the same story syndicated under two feeds."""
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def entry_time(entry) -> float | None:
    """Publication (or update) time as a UTC epoch, if the feed provides one."""
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        st = entry.get(key)
        if st:
            return float(calendar.timegm(st))  # feedparser normalises to UTC
    return None


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                               "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return resp.read()


def usable_image(url: str | None, base: str = "") -> str | None:
    """Absolute https image URL, or None. http images would be blocked as mixed content."""
    if not url:
        return None
    url = urljoin(base, html.unescape(url.strip()))
    if not url.startswith("https://"):
        return None
    if re.search(r"(spacer|pixel|1x1|blank|logo)[^/]*\.(gif|png|svg)", url, re.I):
        return None  # tracking pixels and site logos are not thumbnails
    return url


def entry_image(entry) -> str | None:
    """The thumbnail a feed item carries: media tags, image enclosures, or an <img> in its HTML."""
    for media in (entry.get("media_thumbnail") or []):
        if (img := usable_image(media.get("url"))):
            return img
    for media in (entry.get("media_content") or []):
        kind = (media.get("medium") or media.get("type") or "image")
        if kind.startswith("image") and (img := usable_image(media.get("url"))):
            return img
    for link in (entry.get("enclosures") or []) + [l for l in (entry.get("links") or []) if l.get("rel") == "enclosure"]:
        if str(link.get("type", "")).startswith("image") and (img := usable_image(link.get("href") or link.get("url"))):
            return img
    blobs = [c.get("value", "") for c in (entry.get("content") or [])] + [entry.get("summary", "")]
    for blob in blobs:
        m = re.search(r"<img[^>]+src=[\"']([^\"']+)", blob or "", re.I)
        if m and (img := usable_image(m.group(1))):
            return img
    return None


OG_IMAGE = re.compile(
    r"<meta[^>]+(?:property|name)=[\"'](?:og:image(?::secure_url)?|twitter:image(?::src)?)[\"'][^>]*>", re.I)


def page_image(url: str) -> str:
    """og:image (or twitter:image) of an article page; "" when none is found or the page refuses."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "en",
                                                   "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"})
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            head = resp.read(PAGE_BYTES).decode("utf-8", "replace")
        for tag in OG_IMAGE.findall(head):
            m = re.search(r"content=[\"']([^\"']+)", tag, re.I)
            if m and (img := usable_image(m.group(1), base=url)):
                return img
        # Fallbacks some publishers use instead of Open Graph tags.
        for pattern in (r"<link[^>]+rel=[\"']image_src[\"'][^>]+href=[\"']([^\"']+)",
                        r"\"image\"\s*:\s*\{[^}]*\"url\"\s*:\s*\"([^\"]+)\"",
                        r"\"image\"\s*:\s*\[?\s*\"(https://[^\"]+)\""):
            m = re.search(pattern, head, re.I)
            if m and (img := usable_image(m.group(1).replace("\\/", "/"), base=url)):
                return img
    except Exception as exc:
        print(f"      no page image for {url[:80]} ({exc})")
    return ""


def load_previous() -> dict:
    try:
        return json.loads(OUT.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    now = time.time()
    previous = load_previous()
    # First-seen times for items whose feed gives no date (e.g. NBER's new papers),
    # carried between runs so such items age normally instead of looking new every run.
    old_first_seen = dict(previous.get("first_seen", {}))
    old_first_seen.update({it["url"]: it["published"]
                           for cat in previous.get("categories", []) for it in cat.get("items", [])
                           if it["url"] not in old_first_seen})
    first_seen: dict[str, str] = {}

    pools: dict[str, list[dict]] = {c: [] for c in CATEGORIES}
    status = []
    for source, url, cat, skip in FEEDS:
        try:
            parsed = feedparser.parse(fetch(url))
            if parsed.bozo and not parsed.entries:
                raise ValueError(f"unreadable feed ({parsed.bozo_exception})")
            kept = skipped = undated = 0
            dates = []
            for e in parsed.entries:
                title, link = clean_title(e.get("title", "")), (e.get("link") or "").strip()
                if not title or not link.startswith(("https://", "http://")):
                    continue
                if (skip is not None and skip.search(title)) or (source in ECON_ONLY and not ECON_TERMS.search(title)):
                    skipped += 1
                    continue
                ts = entry_time(e)
                if ts:
                    published = iso(ts)
                else:
                    undated += 1
                    published = first_seen[link] = old_first_seen.get(link, iso(now))
                dates.append(published)
                item = {"title": title, "url": link, "source": source, "published": published}
                if (img := entry_image(e)):
                    item["image"] = img
                pools[cat].append(item)
                kept += 1
            # Diagnostics, visible in news.json and the workflow log.
            status.append({"source": source, "feed": url, "ok": True, "items": kept, "skipped": skipped,
                           "undated": undated, "newest": max(dates, default=None), "oldest": min(dates, default=None)})
            print(f"ok    {kept:3d}  {source:26s} newest {max(dates, default='-')}  skipped {skipped}  undated {undated}")
        except Exception as exc:  # one failing publisher must not stop the others
            status.append({"source": source, "feed": url, "ok": False, "error": str(exc)[:160]})
            print(f"FAIL       {source:26s} {url}  ({exc})")

    if not any(s["ok"] for s in status):
        print("Every feed failed; keeping the previous news.json.")
        return 0

    categories = []
    taken_keys, taken_urls = set(), set()  # a story shown in one tab is not repeated in another
    for cat, (label, max_age_days) in CATEGORIES.items():
        cutoff = now - max_age_days * 86400
        items = sorted(pools[cat], key=lambda it: it["published"], reverse=True)
        fresh, keys, urls = [], set(taken_keys), set(taken_urls)
        for it in items:  # drop stale items and duplicates
            ts = calendar.timegm(time.strptime(it["published"], "%Y-%m-%dT%H:%M:%SZ"))
            k = norm_key(it["title"])
            if ts < cutoff or ts > now + 3600 or k in keys or it["url"] in urls:
                continue
            keys.add(k); urls.add(it["url"]); fresh.append(it)
        # First pass caps each source for variety; second pass back-fills.
        chosen, per_source = [], {}
        for it in fresh:
            if per_source.get(it["source"], 0) < PER_SOURCE_FIRST_PASS:
                chosen.append(it); per_source[it["source"]] = per_source.get(it["source"], 0) + 1
            if len(chosen) == PER_CATEGORY:
                break
        for it in fresh:
            if len(chosen) == PER_CATEGORY:
                break
            if it not in chosen:
                chosen.append(it)
        chosen.sort(key=lambda it: it["published"], reverse=True)
        taken_keys.update(norm_key(it["title"]) for it in chosen); taken_urls.update(it["url"] for it in chosen)
        # Keep the previous headlines for a tab whose feeds all failed this run.
        if not chosen:
            chosen = next((c["items"] for c in previous.get("categories", []) if c.get("id") == cat), [])
        categories.append({"id": cat, "label": label, "items": chosen})

    # Thumbnails for chosen headlines whose feed gave none: reuse an image an
    # earlier run found; otherwise (including earlier misses, which are retried,
    # since pages can refuse one request and serve the next) read the article's og:image.
    previous_images = {it["url"]: it["image"]
                       for c in previous.get("categories", []) for it in c.get("items", []) if it.get("image")}
    lookups = 0
    for c in categories:
        for it in c["items"]:
            if it.get("image"):
                continue
            if it["url"] in previous_images:
                it["image"] = previous_images[it["url"]]
            elif lookups < MAX_PAGE_LOOKUPS:
                lookups += 1
                it["image"] = page_image(it["url"])
    print(f"Thumbnails: {sum(1 for c in categories for it in c['items'] if it.get('image'))} of "
          f"{sum(len(c['items']) for c in categories)} headlines ({lookups} article pages read)")

    # Source status alone never forces a commit; headlines or first-seen times do.
    if categories == previous.get("categories") and first_seen == previous.get("first_seen", {}):
        print("No change in headlines.")
        return 0
    OUT.write_text(json.dumps({"updated": iso(now), "categories": categories, "sources": status,
                               "first_seen": first_seen},
                              ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {OUT.name}: " + ", ".join(f"{c['label']} {len(c['items'])}" for c in categories))
    return 0


if __name__ == "__main__":
    sys.exit(main())
