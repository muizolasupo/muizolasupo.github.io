"""
update_markets.py
Purpose : Daily stock-market data for the bubble maps on the News page:
            us : about thirty of the largest U.S.-listed companies;
            ng : about thirty major companies on the Nigerian Exchange (NGX).
          For each stock it records the latest close, the previous close, the
          one-day percentage change, the date, and a link to a quote page.
Inputs  : U.S.: Nasdaq's public stock screener (the JSON behind nasdaq.com's
          screener page, no key), which lists every U.S.-listed stock with its
          last price, change and market value; the thirty largest by market
          value are shown. Stooq daily price files are a fallback.
          Nigeria: the NGX public equities price list (the JSON feed behind
          ngxgroup.com's price-list page), no key.
Outputs : markets.json at the repository root, rewritten only when prices
          change. A board whose source fails keeps its previous data.
Depends : Python 3.9+ standard library only.
Run by  : .github/workflows/news.yml, alongside the news and signals updates.
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "markets.json"
USER_AGENT = "Mozilla/5.0 (compatible; muizolasupo.com market reader; +https://muizolasupo.com)"
TIMEOUT_S = 30

# (symbol shown, company name, Stooq symbol)
US_STOCKS = [
    ("AAPL", "Apple", "aapl.us"), ("MSFT", "Microsoft", "msft.us"), ("NVDA", "Nvidia", "nvda.us"),
    ("AMZN", "Amazon", "amzn.us"), ("GOOGL", "Alphabet", "googl.us"), ("META", "Meta Platforms", "meta.us"),
    ("AVGO", "Broadcom", "avgo.us"), ("TSLA", "Tesla", "tsla.us"), ("BRK.B", "Berkshire Hathaway", "brk-b.us"),
    ("JPM", "JPMorgan Chase", "jpm.us"), ("LLY", "Eli Lilly", "lly.us"), ("V", "Visa", "v.us"),
    ("MA", "Mastercard", "ma.us"), ("XOM", "Exxon Mobil", "xom.us"), ("UNH", "UnitedHealth", "unh.us"),
    ("WMT", "Walmart", "wmt.us"), ("JNJ", "Johnson & Johnson", "jnj.us"), ("PG", "Procter & Gamble", "pg.us"),
    ("HD", "Home Depot", "hd.us"), ("COST", "Costco", "cost.us"), ("ORCL", "Oracle", "orcl.us"),
    ("NFLX", "Netflix", "nflx.us"), ("BAC", "Bank of America", "bac.us"), ("CVX", "Chevron", "cvx.us"),
    ("KO", "Coca-Cola", "ko.us"), ("AMD", "AMD", "amd.us"), ("CRM", "Salesforce", "crm.us"),
    ("PEP", "PepsiCo", "pep.us"), ("GS", "Goldman Sachs", "gs.us"), ("DIS", "Walt Disney", "dis.us"),
]
STOOQ = "https://stooq.com/q/d/l/?s={sym}&i=d&d1={d1}&d2={d2}"

# NGX symbols to show (as listed on the exchange), with readable names.
NG_STOCKS = [
    ("DANGCEM", "Dangote Cement"), ("MTNN", "MTN Nigeria"), ("AIRTELAFRI", "Airtel Africa"),
    ("BUAFOODS", "BUA Foods"), ("BUACEMENT", "BUA Cement"), ("SEPLAT", "Seplat Energy"),
    ("ARADEL", "Aradel Holdings"), ("GTCO", "GTCO"), ("ZENITHBANK", "Zenith Bank"),
    ("ACCESSCORP", "Access Holdings"), ("UBA", "UBA"), ("FIRSTHOLDCO", "First HoldCo"),
    ("STANBIC", "Stanbic IBTC"), ("FIDELITYBK", "Fidelity Bank"), ("FCMB", "FCMB Group"),
    ("WEMABANK", "Wema Bank"), ("NESTLE", "Nestle Nigeria"), ("NB", "Nigerian Breweries"),
    ("INTBREW", "International Breweries"), ("DANGSUGAR", "Dangote Sugar"),
    ("TRANSCORP", "Transcorp"), ("TRANSPOWER", "Transcorp Power"), ("GEREGU", "Geregu Power"),
    ("OANDO", "Oando"), ("PRESCO", "Presco"), ("OKOMUOIL", "Okomu Oil"),
    ("NAHCO", "NAHCO"), ("CONOIL", "Conoil"), ("TOTAL", "TotalEnergies Marketing"),
    ("JBERGER", "Julius Berger"), ("CADBURY", "Cadbury Nigeria"),
]
NGX_FEEDS = [
    "https://doclib.ngxgroup.com/REST/api/statistics/equities/?market=&sector=&orderby=&pageSize=500&pageNo=0",
]


def get(url: str, accept: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return resp.read()


# ---------------------------------------------------------------------------
# United States (Nasdaq screener, Stooq fallback)
# ---------------------------------------------------------------------------
NASDAQ_SCREENER = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25&offset=0&download=true"
US_COUNT = 30


def us_board_nasdaq(today: date) -> list[dict]:
    """The largest U.S.-listed companies by market value with today's change."""
    req = urllib.request.Request(NASDAQ_SCREENER, headers={
        "User-Agent": USER_AGENT, "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        data = json.loads(resp.read())
    rows = (data.get("data") or {}).get("rows") or []
    if not rows:
        raise ValueError("no rows; keys " + str(list(data)[:6]))
    def money(v):
        return num(str(v).replace("$", "")) if v not in (None, "", "NA") else None
    stocks = []
    for r in rows:
        sym = str(r.get("symbol", "")).strip()
        cap, last, pct = money(r.get("marketCap")), money(r.get("lastsale")), num(r.get("pctchange"))
        # Ordinary shares only: skip preferred shares, warrants and units (symbols with ^, /, or spaces).
        if not sym or re.search(r"[\^/ ]", sym) or cap is None or last is None or pct is None:
            continue
        name = re.sub(r"\s+(Common Stock|Class [A-C] (Common|Capital|Ordinary) (Stock|Shares)|Ordinary Shares|"
                      r"Common Shares|American Depositary Shares).*$", "", str(r.get("name", "")), flags=re.I).strip()
        stocks.append({"symbol": sym, "name": name or sym, "price": round(last, 2),
                       "prev": round(last / (1 + pct / 100), 2) if pct > -100 else None,
                       "change_pct": round(pct, 2), "market_cap": cap, "date": today.isoformat(), "currency": "USD",
                       "url": f"https://www.nasdaq.com/market-activity/stocks/{sym.lower()}"})
    stocks.sort(key=lambda x: x["market_cap"], reverse=True)
    # Two share classes of one company (GOOGL/GOOG, BRK.A/BRK.B): keep the larger listing only.
    seen, out = set(), []
    for st in stocks:
        key = re.sub(r"[^a-z]", "", st["name"].lower())[:12]
        if key in seen:
            continue
        seen.add(key); out.append(st)
        if len(out) == US_COUNT:
            break
    return out


# ---------------------------------------------------------------------------
# United States (Stooq fallback)
# ---------------------------------------------------------------------------
def us_board(today: date) -> tuple[list[dict], list[str]]:
    d1, d2 = (today - timedelta(days=14)).strftime("%Y%m%d"), today.strftime("%Y%m%d")
    items, notes = [], []
    for symbol, name, stooq in US_STOCKS:
        try:
            text = get(STOOQ.format(sym=stooq, d1=d1, d2=d2), "text/csv").decode("utf-8", "replace")
            rows = [r for r in csv.DictReader(io.StringIO(text)) if r.get("Close") not in (None, "", "N/D")]
            if len(rows) < 2:
                raise ValueError("unexpected reply: " + text[:80].replace("\n", " "))
            last, prev = rows[-1], rows[-2]
            close, prev_close = float(last["Close"]), float(prev["Close"])
            items.append({
                "symbol": symbol, "name": name, "price": round(close, 2), "prev": round(prev_close, 2),
                "change_pct": round((close / prev_close - 1) * 100, 2), "date": last["Date"], "currency": "USD",
                "url": f"https://stooq.com/q/?s={stooq}",
            })
        except Exception as exc:
            notes.append(f"{symbol}: {str(exc)[:120]}")
    return items, notes


# ---------------------------------------------------------------------------
# Nigeria (NGX price list)
# ---------------------------------------------------------------------------
def pick(row: dict, *names):
    """Value of the first matching key, case- and punctuation-insensitive."""
    norm = {re.sub(r"[^a-z]", "", k.lower()): v for k, v in row.items()}
    for n in names:
        v = norm.get(re.sub(r"[^a-z]", "", n.lower()))
        if v not in (None, ""):
            return v
    return None


def num(v):
    if v is None:
        return None
    try:
        return float(str(v).replace(",", "").replace("%", "").strip())
    except ValueError:
        return None


def ng_board() -> tuple[list[dict], list[str], dict]:
    wanted = {s: n for s, n in NG_STOCKS}
    notes, sample = [], {}
    for url in NGX_FEEDS:
        try:
            data = json.loads(get(url, "application/json"))
            rows = data if isinstance(data, list) else next((v for v in data.values() if isinstance(v, list)), [])
            if not rows:
                raise ValueError("no rows; top-level keys " + str(list(data)[:8]) if isinstance(data, dict) else "empty")
            sample = {k: rows[0][k] for k in list(rows[0])[:24]}  # field names, for diagnosis
            items = []
            for r in rows:
                sym = str(pick(r, "Symbol", "Ticker", "SecuritySymbol") or "").strip().upper()
                if sym not in wanted:
                    continue
                close = num(pick(r, "ClosePrice", "Close", "ClosingPrice", "CurrentPrice", "LastPrice", "Price"))
                prev = num(pick(r, "PrevClosingPrice", "PreviousClose", "PrevClose", "OpeningPrice", "PreviousClosingPrice"))
                pct = num(pick(r, "PercChange", "PercentageChange", "ChangePercent", "PctChange", "PercentChange"))
                if close is None:
                    continue
                if pct is None and prev:
                    pct = (close / prev - 1) * 100
                if prev is None and pct is not None:
                    prev = close / (1 + pct / 100)
                when = str(pick(r, "TradeDate", "Date", "LastTradeDate", "PriceDate") or "")[:10]
                items.append({
                    "symbol": sym, "name": wanted[sym], "price": round(close, 2),
                    "prev": round(prev, 2) if prev else None, "change_pct": round(pct or 0.0, 2),
                    "date": when, "currency": "NGN",
                    "url": f"https://ngxgroup.com/exchange/data/company-profile/?symbol={sym}&directory=companydirectory",
                })
            if items:
                return items, notes, sample
            notes.append(f"{url[:60]}: none of the chosen symbols found")
        except Exception as exc:
            notes.append(f"{url[:60]}: {str(exc)[:160]}")
    return [], notes, sample


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    today = datetime.now(timezone.utc).date()
    try:
        previous = json.loads(OUT.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        previous = {}
    prev_boards = {b["id"]: b for b in previous.get("boards", [])}

    try:
        us_items, us_notes, us_source = us_board_nasdaq(today), [], ("Nasdaq", "https://www.nasdaq.com/market-activity/stocks/screener")
    except Exception as exc:
        print(f"Nasdaq screener unavailable ({exc}); trying Stooq")
        us_items, us_notes = us_board(today)
        us_notes.insert(0, f"Nasdaq: {str(exc)[:160]}")
        us_source = ("Stooq", "https://stooq.com/")
    ng_items, ng_notes, ng_sample = ng_board()
    print(f"US: {len(us_items)} stocks; problems: {us_notes[:5]}")
    print(f"NG: {len(ng_items)} stocks; problems: {ng_notes[:5]}; sample fields: {list(ng_sample)[:24]}")

    boards = []
    for bid, title, items, source, source_url in (
        ("us", "U.S. stocks", us_items, us_source[0], us_source[1]),
        ("ng", "Nigerian Exchange (NGX)", ng_items, "Nigerian Exchange Group", "https://ngxgroup.com/exchange/data/equities-price-list/"),
    ):
        if not items and bid in prev_boards:
            boards.append(prev_boards[bid])  # keep the last good board
            continue
        dates = sorted({i["date"] for i in items if i.get("date")})
        boards.append({"id": bid, "title": title, "source": source, "source_url": source_url,
                       "date": dates[-1] if dates else None, "items": items})

    status = {"us_problems": us_notes[:10], "ng_problems": ng_notes[:10], "ng_sample": ng_sample}
    if boards == previous.get("boards") and status == previous.get("status"):
        print("No change in market data.")
        return 0
    OUT.write_text(json.dumps({"updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                               "boards": boards, "status": status}, ensure_ascii=False, indent=1) + "\n",
                   encoding="utf-8")
    print("Wrote markets.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
