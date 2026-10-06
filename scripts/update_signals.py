"""
update_signals.py
Purpose : Refresh the economic signals on the News page (and the four-chip
          preview on Home). Two panels:
            United States : twelve official FRED series (rates, inflation,
                            growth, labor);
            Nigeria & world: naira per US dollar, Nigeria inflation and real
                            GDP growth, Brent crude, world GDP growth, global
                            food prices, the euro and the Chinese yuan.
          Each series carries its latest value, the change since the prior
          observation, a trend series for the sparkline, a factual status
          note where meaningful, its source, and a polarity ("up_good",
          "up_bad" or "neutral") that signals.js uses to colour moves.
Inputs  : FRED graph CSV downloads (no key):
            https://fred.stlouisfed.org/graph/fredgraph.csv?id=SERIES
          IMF World Economic Outlook DataMapper API (annual, includes the
          current-year estimate), with the World Bank API as fallback:
            https://www.imf.org/external/datamapper/api/v1/IND/COUNTRY
            https://api.worldbank.org/v2/country/C/indicator/IND?format=json
          Daily exchange rates from the open currency API (fawazahmed0),
          dated snapshots served by jsDelivr, with its Cloudflare mirror:
            https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@DATE/v1/currencies/usd.min.json
          FRED series are limited to public-domain government data; equity
          indexes (S&P 500, VIX) are excluded because their licences prohibit
          reproduction.
Outputs : signals.json at the repository root, rewritten only when a value
          changes.
Depends : Python 3.9+ standard library only.
Run by  : .github/workflows/news.yml, alongside update_news.py.
Notes   : 12-month inflation rates are computed from the price indexes
          (CPIAUCSL, PCEPILFE) as 100 * (x_t / x_{t-12} - 1). A series that
          fails to download keeps its previous entry, so one outage never
          blanks a tile. Exchange-rate history is cached in signals.json, so
          after the first run only new dates are downloaded.
"""
from __future__ import annotations

import csv
import io
import json
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
OUT = Path(__file__).resolve().parent.parent / "signals.json"
USER_AGENT = "Mozilla/5.0 (compatible; muizolasupo.com signals reader; +https://muizolasupo.com)"
TIMEOUT_S = 30

FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={id}&cosd={start}"
IMF_API = "https://www.imf.org/external/datamapper/api/v1/{ind}/{cty}"
WB_API = "https://api.worldbank.org/v2/country/{cty}/indicator/{ind}?format=json&per_page=80&date={y0}:{y1}"
FX_URLS = [  # tried in order; {d} is YYYY-MM-DD or "latest"
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{d}/v1/currencies/{base}.min.json",
    "https://{d}.currency-api.pages.dev/v1/currencies/{base}.min.json",
]

# Trend window (days of history in the sparkline) and thinning step by frequency.
WINDOW = {"daily": (365, 5), "weekly": (365, 1), "monthly": (3 * 365, 1),
          "quarterly": (5 * 365, 1), "annual": (10 * 366, 1)}
WINDOW_LABEL = {"daily": "Past year", "weekly": "Past year", "monthly": "Past 3 years",
                "quarterly": "Past 5 years", "annual": "Past 10 years"}

# Display formats (interpreted by signals.js):
#   value : pct2 4.21% | pct1 3.4% | bp 55 bp | usd2 $61.23 | k 218K | num1 128.4 | num2 0.30
#           | fx4 1.0842 | ngn ₦1,530.12
#   change: bp (percentage-point change in basis points) | pt (percentage points) | pct (percent
#           change) | k (thousands) | num2
# Polarity: whether a rise is favourable ("up_good"), unfavourable ("up_bad"), or neither
#           ("neutral"; coloured by market convention, green up and red down).
FRED = "fred"
PANELS = [
    ("us", "United States", [
        ("Rates & policy", [
            dict(src=FRED, id="DFF", short="Fed funds",    label="Fed funds rate",         sub="Effective, daily",         freq="daily", value="pct2", change="bp", polarity="neutral"),
            dict(src=FRED, id="DGS2", short="2Y yield",   label="2-year Treasury yield",  sub="Constant maturity",        freq="daily", value="pct2", change="bp", polarity="neutral"),
            dict(src=FRED, id="DGS10", short="10Y yield",  label="10-year Treasury yield", sub="Constant maturity",        freq="daily", value="pct2", change="bp", polarity="neutral"),
            dict(src=FRED, id="T10Y2Y", short="10Y−2Y", label="Yield curve",            sub="10-year minus 2-year",     freq="daily", value="bp",   change="bp", polarity="neutral", status="curve"),
        ]),
        ("Inflation & prices", [
            dict(src=FRED, id="CPIAUCSL", short="CPI", label="CPI inflation",        sub="12-month change",          freq="monthly", value="pct1", change="pt", polarity="up_bad", transform="yoy"),
            dict(src=FRED, id="PCEPILFE", short="Core PCE", label="Core PCE inflation",   sub="12-month change; Fed target 2%", freq="monthly", value="pct1", change="pt", polarity="up_bad", transform="yoy", status="target2"),
            dict(src=FRED, id="T10YIE", short="Breakeven", label="10-year breakeven inflation", sub="Market-implied",      freq="daily", value="pct2", change="bp", polarity="neutral"),
            dict(src=FRED, id="DCOILWTICO", short="WTI oil", label="WTI crude oil",      sub="Spot, dollars per barrel", freq="daily", value="usd2", change="pct", polarity="neutral"),
        ]),
        ("Growth & labor", [
            dict(src=FRED, id="A191RL1Q225SBEA", short="GDP", label="Real GDP growth", sub="Quarterly, annualized",  freq="quarterly", value="pct1", change="pt", polarity="up_good"),
            dict(src=FRED, id="UNRATE", short="Unemployment", label="Unemployment rate",      sub="Seasonally adjusted",      freq="monthly", value="pct1", change="pt", polarity="up_bad"),
            dict(src=FRED, id="ICSA", short="Jobless claims",   label="Initial jobless claims", sub="Weekly, seasonally adjusted", freq="weekly", value="k", change="k", polarity="up_bad"),
            dict(src=FRED, id="SAHMREALTIME", short="Sahm rule", label="Sahm rule indicator", sub="Recession signal at 0.50", freq="monthly", value="num2", change="num2", polarity="up_bad", status="sahm"),
        ]),
    ]),
    ("global", "Nigeria & world", [
        ("Nigeria", [
            dict(src="fx", id="USDNGN", short="USD/NGN", base="usd", quote="ngn", label="Naira per US dollar", sub="Daily market rate", freq="daily", value="ngn", change="pct", polarity="up_bad"),
            dict(src="annual", id="NGA_INFL", short="NG inflation", imf=("PCPIPCH", "NGA"), wb=("FP.CPI.TOTL.ZG", "NGA"), label="Nigeria inflation", sub="Annual average, consumer prices", freq="annual", value="pct1", change="pt", polarity="up_bad"),
            dict(src="annual", id="NGA_GDP", short="NG growth", imf=("NGDP_RPCH", "NGA"), wb=("NY.GDP.MKTP.KD.ZG", "NGA"), label="Nigeria real GDP growth", sub="Annual", freq="annual", value="pct1", change="pt", polarity="up_good"),
            dict(src=FRED, id="DCOILBRENTEU", short="Brent", label="Brent crude oil", sub="Nigeria's export benchmark, $ per barrel", freq="daily", value="usd2", change="pct", polarity="neutral"),
        ]),
        ("World", [
            dict(src="annual", id="WLD_GDP", short="World GDP", imf=("NGDP_RPCH", "WEOWORLD"), wb=("NY.GDP.MKTP.KD.ZG", "WLD"), label="World real GDP growth", sub="Annual", freq="annual", value="pct1", change="pt", polarity="up_good"),
            dict(src=FRED, id="PFOODINDEXM", short="Food prices", label="Global food prices", sub="IMF index, 2016 = 100", freq="monthly", value="num1", change="pct", polarity="up_bad"),
            dict(src=FRED, id="DEXUSEU", short="EUR/USD", label="Euro", sub="US dollars per euro", freq="daily", value="fx4", change="pct", polarity="neutral"),
            dict(src=FRED, id="DEXCHUS", short="USD/CNY", label="Chinese yuan", sub="Yuan per US dollar", freq="daily", value="fx4", change="pct", polarity="neutral"),
        ]),
    ]),
]


# ---------------------------------------------------------------------------
# Data access
# ---------------------------------------------------------------------------
def get(url: str, accept: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return resp.read()


def fetch_fred(series_id: str, start: date) -> list[tuple[str, float]]:
    """(ISO date, value) observations from FRED's CSV download, missing values dropped."""
    text = get(FRED_CSV.format(id=series_id, start=start.isoformat()), "text/csv").decode("utf-8")
    rows = csv.reader(io.StringIO(text))
    header = next(rows)
    if len(header) < 2:
        raise ValueError(f"unexpected CSV header {header}")
    out = [(r[0], float(r[1])) for r in rows if len(r) >= 2 and r[1] not in ("", ".")]
    if not out:
        raise ValueError("no observations")
    return out


def fetch_annual(spec: dict, today: date) -> tuple[list[tuple[str, float]], str, str]:
    """Annual series up to the current year: IMF WEO first (has current-year estimates), World Bank fallback.
    Returns (observations, source name, source URL)."""
    first, last = today.year - 11, today.year
    ind, cty = spec["imf"]
    try:
        data = json.loads(get(IMF_API.format(ind=ind, cty=cty), "application/json"))
        values = data["values"][ind][cty]
        obs = sorted((f"{y}-01-01", float(v)) for y, v in values.items()
                     if v is not None and first <= int(y) <= last)
        if len(obs) >= 2:
            return obs, "IMF", f"https://www.imf.org/external/datamapper/{ind}@WEO/{cty}"
        raise ValueError("too few IMF observations")
    except Exception as exc:
        print(f"      IMF {ind}/{cty} unavailable ({exc}); trying World Bank")
    ind, cty = spec["wb"]
    data = json.loads(get(WB_API.format(ind=ind, cty=cty, y0=first, y1=last), "application/json"))
    rows = data[1] if isinstance(data, list) and len(data) > 1 and data[1] else []
    obs = sorted((f"{r['date']}-01-01", float(r["value"])) for r in rows if r.get("value") is not None)
    if len(obs) < 2:
        raise ValueError("too few World Bank observations")
    return obs, "World Bank", f"https://data.worldbank.org/indicator/{ind}?locations={cty[:2] if cty != 'WLD' else '1W'}"


def fx_rate(base: str, quote: str, day: str) -> tuple[str, float]:
    """(date, rate) for one dated snapshot ("latest" or YYYY-MM-DD), trying the mirrors in order."""
    last_exc = None
    for pattern in FX_URLS:
        try:
            data = json.loads(get(pattern.format(d=day, base=base), "application/json"))
            return data["date"], float(data[base][quote])
        except Exception as exc:
            last_exc = exc
    raise ValueError(f"currency API unavailable for {day} ({last_exc})")


def fetch_fx(spec: dict, today: date, cached: list) -> list[tuple[str, float]]:
    """Weekly points over the past year plus the latest two days; cached points are not re-downloaded."""
    have = {d: v for d, v in cached}
    latest_date, latest = fx_rate(spec["base"], spec["quote"], "latest")
    have[latest_date] = latest
    end = date.fromisoformat(latest_date)
    wanted = [(end - timedelta(days=1)).isoformat()] + \
             [(end - timedelta(days=7 * k)).isoformat() for k in range(1, 53)]
    for d in wanted:
        if d not in have:
            try:
                got_date, rate = fx_rate(spec["base"], spec["quote"], d)
                have[got_date] = rate
            except Exception as exc:
                print(f"      {spec['id']} {d}: {exc}")
    cutoff = (end - timedelta(days=366)).isoformat()
    return sorted((d, v) for d, v in have.items() if cutoff <= d <= latest_date)


def yoy(obs: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """12-month percent change of a monthly index, aligned on the same calendar month."""
    level = dict(obs)
    out = []
    for d, x in obs:
        y, m, _ = d.split("-")
        base = level.get(f"{int(y) - 1:04d}-{m}-01")
        if base:
            out.append((d, round(100.0 * (x / base - 1.0), 4)))
    return out


def trend(obs: list[tuple[str, float]], freq: str, today: date) -> list[list]:
    """Observations inside the sparkline window, thinned for daily data; always ends on the latest point."""
    days, step = WINDOW[freq]
    cutoff = (today - timedelta(days=days)).isoformat()
    window = [o for o in obs if o[0] >= cutoff]
    if freq == "daily" and len(window) < 70:
        step = 1  # already sparse (e.g. weekly exchange-rate snapshots)
    thinned = window[::-1][::step][::-1]
    return [[d, round(v, 4)] for d, v in thinned]


def move_z(obs: list[tuple[str, float]], change_format: str, freq: str, today: date) -> float | None:
    """Size of the latest move in units of the series' typical move over the trend window:
    z = latest change / standard deviation of past one-period changes. Changes are in the
    displayed metric (percent changes for prices and exchange rates, level changes otherwise).
    When history is sparser than the latest step (weekly exchange-rate snapshots vs a daily
    change), the deviation is rescaled by sqrt(step ratio), as for a random walk."""
    cutoff = (today - timedelta(days=WINDOW[freq][0])).isoformat()
    window = [o for o in obs if o[0] >= cutoff]
    if len(window) < 5:
        return None
    pct = change_format == "pct"
    def step(a, b):
        return (b[1] / a[1] - 1.0) * 100.0 if pct else b[1] - a[1]
    diffs = [step(a, b) for a, b in zip(window[:-2], window[1:-1])]  # past moves, excluding the latest
    days = [(date.fromisoformat(b[0]) - date.fromisoformat(a[0])).days for a, b in zip(window[:-2], window[1:-1])]
    n = len(diffs)
    mean = sum(diffs) / n
    sd = (sum((d - mean) ** 2 for d in diffs) / max(n - 1, 1)) ** 0.5
    if sd == 0:
        return None
    latest_days = (date.fromisoformat(window[-1][0]) - date.fromisoformat(window[-2][0])).days or 1
    typical_days = (sum(days) / n) or 1
    sd *= min(1.0, latest_days / typical_days) ** 0.5  # only for sparse history; weekends add no variance
    return round(step(window[-2], window[-1]) / sd, 2)


def status_note(kind: str | None, value: float) -> str | None:
    """Short, factual reading of the latest value against a standard benchmark."""
    if kind == "curve":
        return "Inverted" if value < 0 else "Positively sloped"
    if kind == "sahm":
        return "At or above 0.50 threshold" if value >= 0.5 else "Below 0.50 threshold"
    if kind == "target2":
        gap = value - 2.0
        return "Near 2% target" if abs(gap) < 0.25 else f"{gap:+.1f} pt vs 2% target"
    return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def build_series(spec: dict, today: date, previous: dict | None) -> dict:
    sid, freq = spec["id"], spec["freq"]
    source_name, source_url = "FRED", f"https://fred.stlouisfed.org/series/{sid}"
    if spec["src"] == FRED:
        start = today - timedelta(days=WINDOW[freq][0] + (420 if spec.get("transform") == "yoy" else 30))
        obs = fetch_fred(sid, start)
        if spec.get("transform") == "yoy":
            obs = yoy(obs)
    elif spec["src"] == "annual":
        obs, source_name, source_url = fetch_annual(spec, today)
    elif spec["src"] == "fx":
        obs = fetch_fx(spec, today, (previous or {}).get("trend", []))
        source_name, source_url = "Currency API", "https://github.com/fawazahmed0/exchange-api"
    else:
        raise ValueError(f"unknown source {spec['src']}")
    if len(obs) < 2:
        raise ValueError("fewer than two observations")
    (d1, v1), (d0, v0) = obs[-1], obs[-2]
    status = status_note(spec.get("status"), v1)
    if spec["src"] == "annual" and source_name == "IMF" and int(d1[:4]) >= today.year:
        status = "IMF estimate"  # the current year in the WEO is a projection
    return {
        "id": sid, "label": spec["label"], "short": spec.get("short", spec["label"]), "sub": spec["sub"], "freq": freq,
        "format": spec["value"], "change_format": spec["change"], "polarity": spec["polarity"],
        "date": d1, "value": round(v1, 4), "prev_date": d0, "prev_value": round(v0, 4),
        "window": WINDOW_LABEL[freq], "trend": trend(obs, freq, today), "status": status,
        "source_name": source_name, "source_url": source_url,
        "move_z": move_z(obs, spec["change"], freq, today),
    }


def main() -> int:
    today = datetime.now(timezone.utc).date()
    try:
        previous = json.loads(OUT.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        previous = {}
    prev_by_id = {s["id"]: s for p in previous.get("panels", []) for g in p.get("groups", []) for s in g.get("series", [])}
    prev_by_id.update({s["id"]: s for g in previous.get("groups", []) for s in g.get("series", [])
                       if s["id"] not in prev_by_id})  # first run after the single-panel format

    panels, failures, total = [], 0, 0
    for panel_id, panel_title, groups_spec in PANELS:
        groups = []
        for group_label, specs in groups_spec:
            series_out = []
            for spec in specs:
                total += 1
                try:
                    entry = build_series(spec, today, prev_by_id.get(spec["id"]))
                    print(f"ok    {spec['id']:16s} {entry['date']}  {entry['value']:12.4f}  ({entry['source_name']}, {len(entry['trend'])} points)")
                except Exception as exc:  # keep the last good tile rather than dropping it
                    failures += 1
                    entry = prev_by_id.get(spec["id"])
                    print(f"FAIL  {spec['id']:16s} ({exc}); {'kept previous value' if entry else 'no previous value'}")
                    if entry is None:
                        continue
                series_out.append(entry)
            groups.append({"label": group_label, "series": series_out})
        panels.append({"id": panel_id, "title": panel_title, "groups": groups})

    if failures == total and not previous:
        print("Every series failed and there is no previous file; nothing written.")
        return 0
    if panels == previous.get("panels"):
        print("No change in signals.")
        return 0
    OUT.write_text(json.dumps({
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "panels": panels,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {OUT.name} ({failures} of {total} series failed).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
