"""
update_markets.py
Purpose : Daily stock-market data for the bubble maps on the News page.
            us : about one hundred of the largest U.S.-listed companies
                 (the S&P 100 universe), ranked by market value;
            ng : every equity on the Nigerian Exchange (NGX) price list,
                 ranked by value traded that day, so new listings (for example
                 Dangote Petroleum Refinery after its IPO) appear automatically.
          For each stock: latest close, previous close, one-day % change, date,
          sector (NGX), market value (U.S.), value traded (NGX), quote link.
Inputs  : U.S.: Finnhub (free personal key in the repository secret
          FINNHUB_API_KEY, passed in by the workflow as an environment variable;
          it never appears on the site). Quotes: /quote. Market values and
          names: /stock/profile2, cached in markets.json for a week. Calls are
          paced to stay under the free plan's 60 per minute.
          Nigeria: the NGX public equities price list (the JSON feed behind
          ngxgroup.com's price-list page), no key.
Outputs : markets.json at the repository root, rewritten only when data
          change. A board whose source fails keeps its previous data.
Depends : Python 3.9+ standard library only.
Run by  : .github/workflows/news.yml, alongside the news and signals updates.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "markets.json"
USER_AGENT = "Mozilla/5.0 (compatible; muizolasupo.com market reader; +https://muizolasupo.com)"
TIMEOUT_S = 30
FINNHUB = "https://finnhub.io/api/v1"
CALL_GAP_S = 1.05            # ~57 calls a minute, under the free limit of 60
PROFILE_MAX_AGE_DAYS = 7

# The S&P 100 universe (largest U.S. companies), with short display names.
US_STOCKS = [
    ("AAPL", "Apple"), ("ABBV", "AbbVie"), ("ABT", "Abbott"), ("ACN", "Accenture"), ("ADBE", "Adobe"),
    ("AIG", "AIG"), ("AMD", "AMD"), ("AMGN", "Amgen"), ("AMT", "American Tower"), ("AMZN", "Amazon"),
    ("AVGO", "Broadcom"), ("AXP", "American Express"), ("BA", "Boeing"), ("BAC", "Bank of America"),
    ("BK", "BNY"), ("BKNG", "Booking Holdings"), ("BLK", "BlackRock"), ("BMY", "Bristol Myers Squibb"),
    ("BRK.B", "Berkshire Hathaway"), ("C", "Citigroup"), ("CAT", "Caterpillar"), ("CHTR", "Charter"),
    ("CL", "Colgate-Palmolive"), ("CMCSA", "Comcast"), ("COF", "Capital One"), ("COP", "ConocoPhillips"),
    ("COST", "Costco"), ("CRM", "Salesforce"), ("CSCO", "Cisco"), ("CVS", "CVS Health"), ("CVX", "Chevron"),
    ("DE", "Deere"), ("DHR", "Danaher"), ("DIS", "Walt Disney"), ("DUK", "Duke Energy"), ("EMR", "Emerson"),
    ("F", "Ford"), ("FDX", "FedEx"), ("GD", "General Dynamics"), ("GE", "GE Aerospace"), ("GILD", "Gilead"),
    ("GM", "General Motors"), ("GOOGL", "Alphabet"), ("GS", "Goldman Sachs"), ("HD", "Home Depot"),
    ("HON", "Honeywell"), ("IBM", "IBM"), ("INTC", "Intel"), ("INTU", "Intuit"), ("ISRG", "Intuitive Surgical"),
    ("JNJ", "Johnson & Johnson"), ("JPM", "JPMorgan Chase"), ("KO", "Coca-Cola"), ("LIN", "Linde"),
    ("LLY", "Eli Lilly"), ("LMT", "Lockheed Martin"), ("LOW", "Lowe's"), ("MA", "Mastercard"),
    ("MCD", "McDonald's"), ("MDLZ", "Mondelez"), ("MDT", "Medtronic"), ("MET", "MetLife"), ("META", "Meta"),
    ("MMM", "3M"), ("MO", "Altria"), ("MRK", "Merck"), ("MS", "Morgan Stanley"), ("MSFT", "Microsoft"),
    ("NEE", "NextEra Energy"), ("NFLX", "Netflix"), ("NKE", "Nike"), ("NOW", "ServiceNow"), ("NVDA", "Nvidia"),
    ("ORCL", "Oracle"), ("PEP", "PepsiCo"), ("PFE", "Pfizer"), ("PG", "Procter & Gamble"), ("PLTR", "Palantir"),
    ("PM", "Philip Morris"), ("PYPL", "PayPal"), ("QCOM", "Qualcomm"), ("RTX", "RTX"), ("SBUX", "Starbucks"),
    ("SCHW", "Charles Schwab"), ("SO", "Southern Company"), ("SPG", "Simon Property"), ("T", "AT&T"),
    ("TGT", "Target"), ("TMO", "Thermo Fisher"), ("TMUS", "T-Mobile US"), ("TSLA", "Tesla"),
    ("TXN", "Texas Instruments"), ("UBER", "Uber"), ("UNH", "UnitedHealth"), ("UNP", "Union Pacific"),
    ("UPS", "UPS"), ("USB", "U.S. Bancorp"), ("V", "Visa"), ("VZ", "Verizon"), ("WFC", "Wells Fargo"),
    ("WMT", "Walmart"), ("XOM", "Exxon Mobil"),
]

# Readable names for NGX symbols (others are shown by symbol and sector).
NG_NAMES = {
    "DANGCEM": "Dangote Cement", "MTNN": "MTN Nigeria", "AIRTELAFRI": "Airtel Africa", "BUAFOODS": "BUA Foods",
    "BUACEMENT": "BUA Cement", "SEPLAT": "Seplat Energy", "ARADEL": "Aradel Holdings", "GTCO": "GTCO",
    "ZENITHBANK": "Zenith Bank", "ACCESSCORP": "Access Holdings", "UBA": "UBA", "FIRSTHOLDCO": "First HoldCo",
    "STANBIC": "Stanbic IBTC", "FIDELITYBK": "Fidelity Bank", "FCMB": "FCMB Group", "WEMABANK": "Wema Bank",
    "NESTLE": "Nestle Nigeria", "NB": "Nigerian Breweries", "INTBREW": "International Breweries",
    "DANGSUGAR": "Dangote Sugar", "TRANSCORP": "Transcorp", "TRANSPOWER": "Transcorp Power",
    "GEREGU": "Geregu Power", "OANDO": "Oando", "PRESCO": "Presco", "OKOMUOIL": "Okomu Oil", "NAHCO": "NAHCO",
    "CONOIL": "Conoil", "TOTAL": "TotalEnergies Marketing", "JBERGER": "Julius Berger", "CADBURY": "Cadbury Nigeria",
    "UNILEVER": "Unilever Nigeria", "GUINNESS": "Guinness Nigeria", "FLOURMILL": "Flour Mills of Nigeria",
    "ETI": "Ecobank Transnational", "STERLINGNG": "Sterling Financial", "UCAP": "United Capital",
    "AIICO": "AIICO Insurance", "CUSTODIAN": "Custodian Investment", "MANSARD": "AXA Mansard",
    "NEM": "NEM Insurance", "ETERNA": "Eterna", "MRS": "MRS Oil Nigeria", "JAIZBANK": "Jaiz Bank",
    "UPDC": "UPDC", "UACN": "UAC of Nigeria", "PZ": "PZ Cussons Nigeria", "VITAFOAM": "Vitafoam Nigeria",
    "CHAMPION": "Champion Breweries", "HONYFLOUR": "Honeywell Flour Mills", "FIDSON": "Fidson Healthcare",
    "MAYBAKER": "May & Baker", "GLAXOSMITH": "GlaxoSmithKline Nigeria", "CAVERTON": "Caverton",
    "LIVESTOCK": "Livestock Feeds", "ELLAHLAKES": "Ellah Lakes", "CORNERST": "Cornerstone Insurance",
    "SOVRENINS": "Sovereign Trust Insurance", "LASACO": "LASACO Assurance", "NGXGROUP": "NGX Group",
    "INFINITY": "Infinity Trust", "UNITYBNK": "Unity Bank", "CWG": "CWG", "CHAMS": "Chams", "NSLTECH": "SecureID",
    "BETAGLAS": "Beta Glass", "BERGER": "Berger Paints", "CUTIX": "Cutix", "MECURE": "Mecure Industries",
    "IKEJAHOTEL": "Ikeja Hotel", "TRANSCOHOT": "Transcorp Hotels", "LEARNAFRCA": "Learn Africa",
    "ACADEMY": "Academy Press", "UPL": "University Press", "REDSTAREX": "Red Star Express",
    "DANGREF": "Dangote Petroleum Refinery", "DANGOTEREF": "Dangote Petroleum Refinery",
}
NGX_FEED = "https://doclib.ngxgroup.com/REST/api/statistics/equities/?market=&sector=&orderby=&pageSize=500&pageNo=0"


def get(url: str, accept: str = "application/json") -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return resp.read()


def num(v):
    if v in (None, ""):
        return None
    try:
        return float(str(v).replace(",", "").replace("%", "").replace("$", "").strip())
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# United States (Finnhub)
# ---------------------------------------------------------------------------
def us_board(key: str, today: date, cached_profiles: dict) -> tuple[list[dict], dict, list[str]]:
    """Quotes for the universe plus market values (profiles refreshed when older than a week)."""
    profiles, notes, items = dict(cached_profiles), [], []
    stale_before = (today - timedelta(days=PROFILE_MAX_AGE_DAYS)).isoformat()
    for symbol, name in US_STOCKS:
        try:
            q = json.loads(get(f"{FINNHUB}/quote?symbol={symbol}&token={key}"))
            time.sleep(CALL_GAP_S)
            if not q or not q.get("c"):
                notes.append(f"{symbol}: no quote")
                continue
            prof = profiles.get(symbol)
            if not prof or prof.get("checked", "") < stale_before:
                p = json.loads(get(f"{FINNHUB}/stock/profile2?symbol={symbol}&token={key}"))
                time.sleep(CALL_GAP_S)
                cap = num(p.get("marketCapitalization"))  # millions of U.S. dollars
                prof = {"cap": cap * 1e6 if cap else (prof or {}).get("cap"), "checked": today.isoformat()}
                profiles[symbol] = prof
            when = datetime.fromtimestamp(q["t"], tz=timezone.utc).date().isoformat() if q.get("t") else today.isoformat()
            items.append({
                "symbol": symbol, "name": name, "price": round(q["c"], 2),
                "prev": round(q["pc"], 2) if q.get("pc") else None, "change_pct": round(q.get("dp") or 0.0, 2),
                "market_cap": prof.get("cap"), "date": when, "currency": "USD",
                "url": f"https://www.nasdaq.com/market-activity/stocks/{symbol.replace('.', '-').lower()}",
            })
        except Exception as exc:
            notes.append(f"{symbol}: " + str(exc).replace(key, "***")[:120])
    items.sort(key=lambda s: s.get("market_cap") or 0, reverse=True)
    return items, profiles, notes


# ---------------------------------------------------------------------------
# Nigeria (NGX price list)
# ---------------------------------------------------------------------------
def ng_board() -> tuple[list[dict], list[str]]:
    data = json.loads(get(NGX_FEED))
    rows = data if isinstance(data, list) else next((v for v in data.values() if isinstance(v, list)), [])
    items = []
    for r in rows:
        sym = str(r.get("Symbol") or "").strip().upper()
        close = num(r.get("ClosePrice"))
        if not sym or not close:
            continue
        prev = num(r.get("PrevClosingPrice"))
        pct = num(r.get("PercChange"))
        if pct is None and prev:
            pct = (close / prev - 1) * 100
        items.append({
            "symbol": sym, "name": NG_NAMES.get(sym), "price": round(close, 2),
            "prev": round(prev, 2) if prev else None, "change_pct": round(pct or 0.0, 2),
            "value_traded": num(r.get("Value")) or 0.0, "trades": int(num(r.get("Trades")) or 0),
            "sector": (str(r.get("Sector") or "").strip().title() or None), "board": str(r.get("Market") or "").strip() or None,
            "date": str(r.get("TradeDate") or "")[:10], "currency": "NGN",
            "url": f"https://ngxgroup.com/exchange/data/company-profile/?symbol={sym}&directory=companydirectory",
        })
    if not items:
        raise ValueError("no priced equities in the NGX feed")
    items.sort(key=lambda s: s["value_traded"], reverse=True)  # most traded first
    return items, []


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
    profiles = previous.get("profiles", {})
    status = {}

    key = os.environ.get("FINNHUB_API_KEY", "").strip()
    us_items = []
    if key:
        us_items, profiles, us_notes = us_board(key, today, profiles)
        status["us_problems"] = us_notes[:15]
    else:
        status["us_problems"] = ["FINNHUB_API_KEY is not set"]
    try:
        ng_items, ng_notes = ng_board()
    except Exception as exc:
        ng_items, ng_notes = [], [str(exc)[:160]]
    status["ng_problems"] = ng_notes
    print(f"US: {len(us_items)} stocks; problems: {status['us_problems'][:5]}")
    print(f"NG: {len(ng_items)} stocks; problems: {ng_notes[:5]}")

    boards = []
    for bid, title, items, source, source_url, ranking in (
        ("us", "U.S. stocks", us_items, "Finnhub", "https://finnhub.io/", "market value"),
        ("ng", "Nigerian Exchange (NGX)", ng_items, "Nigerian Exchange Group",
         "https://ngxgroup.com/exchange/data/equities-price-list/", "value traded"),
    ):
        if not items and bid in prev_boards:
            boards.append(prev_boards[bid])  # keep the last good board
            continue
        dates = sorted({i["date"] for i in items if i.get("date")})
        boards.append({"id": bid, "title": title, "source": source, "source_url": source_url, "ranking": ranking,
                       "date": dates[-1] if dates else None, "items": items})

    if boards == previous.get("boards") and profiles == previous.get("profiles"):
        print("No change in market data.")
        return 0
    OUT.write_text(json.dumps({"updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                               "boards": boards, "profiles": profiles, "status": status},
                              ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("Wrote markets.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
