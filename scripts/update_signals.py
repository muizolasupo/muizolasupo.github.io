"""
update_signals.py
Purpose : Refresh the "Economic signals" panel on the Home page: twelve
          official U.S. indicators for rates, inflation, growth and labor,
          each with its latest value, change since the prior observation, a
          trend series for the sparkline, and (where meaningful) a factual
          status note.
Inputs  : FRED graph CSV downloads (Federal Reserve Bank of St. Louis), which
          need no API key: https://fred.stlouisfed.org/graph/fredgraph.csv?id=SERIES
          Only public-domain government series are used (Federal Reserve Board,
          BLS, BEA, EIA, Department of Labor) plus FRED's own Sahm rule series;
          equity indexes such as the S&P 500 and VIX are excluded because their
          licences prohibit reproduction.
Outputs : signals.json at the repository root, rewritten only when a value
          changes; signals.js renders it on index.html.
Depends : Python 3.9+ standard library only.
Run by  : .github/workflows/news.yml, alongside update_news.py.
Notes   : 12-month inflation rates are computed here from the price indexes
          (CPIAUCSL, PCEPILFE) as 100 * (x_t / x_{t-12} - 1). A series that
          fails to download keeps its previous entry, so one outage never
          blanks a tile.
"""
from __future__ import annotations

import csv
import io
import json
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
OUT = Path(__file__).resolve().parent.parent / "signals.json"
USER_AGENT = "Mozilla/5.0 (compatible; muizolasupo.com signals reader; +https://muizolasupo.com)"
FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={id}&cosd={start}"
TIMEOUT_S = 30

# Trend window (days of history shown in the sparkline) and thinning step by frequency.
WINDOW = {"daily": (365, 5), "weekly": (365, 1), "monthly": (3 * 365, 1), "quarterly": (5 * 365, 1)}
WINDOW_LABEL = {"daily": "Past year", "weekly": "Past year", "monthly": "Past 3 years", "quarterly": "Past 5 years"}

# Display formats (interpreted by signals.js):
#   value: "pct2" 4.21%, "pct1" 3.4%, "bp" 55 bp, "usd2" $61.23, "k" 218K, "num2" 0.30
#   change: "bp" (percentage-point change shown in basis points), "pt" (percentage points),
#           "pct" (percent change), "k" (thousands), "num2"
GROUPS = [
    ("Rates & policy", [
        dict(id="DFF",    label="Fed funds rate",          sub="Effective, daily",            freq="daily",  value="pct2", change="bp"),
        dict(id="DGS2",   label="2-year Treasury yield",   sub="Constant maturity",           freq="daily",  value="pct2", change="bp"),
        dict(id="DGS10",  label="10-year Treasury yield",  sub="Constant maturity",           freq="daily",  value="pct2", change="bp"),
        dict(id="T10Y2Y", label="Yield curve",             sub="10-year minus 2-year",        freq="daily",  value="bp",   change="bp",
             status="curve"),
    ]),
    ("Inflation & prices", [
        dict(id="CPIAUCSL", label="CPI inflation",         sub="12-month change",             freq="monthly", value="pct1", change="pt",
             transform="yoy"),
        dict(id="PCEPILFE", label="Core PCE inflation",    sub="12-month change; Fed target 2%", freq="monthly", value="pct1", change="pt",
             transform="yoy", status="target2"),
        dict(id="T10YIE", label="10-year breakeven inflation", sub="Market-implied",          freq="daily",  value="pct2", change="bp"),
        dict(id="DCOILWTICO", label="WTI crude oil",       sub="Spot, dollars per barrel",    freq="daily",  value="usd2", change="pct"),
    ]),
    ("Growth & labor", [
        dict(id="A191RL1Q225SBEA", label="Real GDP growth", sub="Quarterly, annualized",      freq="quarterly", value="pct1", change="pt"),
        dict(id="UNRATE", label="Unemployment rate",       sub="Seasonally adjusted",         freq="monthly", value="pct1", change="pt"),
        dict(id="ICSA",   label="Initial jobless claims",  sub="Weekly, seasonally adjusted", freq="weekly",  value="k",    change="k"),
        dict(id="SAHMREALTIME", label="Sahm rule indicator", sub="Recession signal at 0.50",  freq="monthly", value="num2", change="num2",
             status="sahm"),
    ]),
]


# ---------------------------------------------------------------------------
# Data access and transforms
# ---------------------------------------------------------------------------
def fetch_series(series_id: str, start: date) -> list[tuple[str, float]]:
    """(ISO date, value) observations from FRED's CSV download, missing values dropped."""
    url = FRED_CSV.format(id=series_id, start=start.isoformat())
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/csv"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        text = resp.read().decode("utf-8")
    rows = csv.reader(io.StringIO(text))
    header = next(rows)
    if len(header) < 2:
        raise ValueError(f"unexpected CSV header {header}")
    out = []
    for row in rows:
        if len(row) < 2 or row[1] in ("", "."):
            continue  # FRED marks missing observations (e.g. market holidays) with "."
        out.append((row[0], float(row[1])))
    if not out:
        raise ValueError("no observations")
    return out


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
    thinned = window[::-1][::step][::-1]  # keep every step-th point counting back from the latest
    return [[d, round(v, 4)] for d, v in thinned]


def status_note(kind: str | None, value: float) -> str | None:
    """Short, factual reading of the latest value against a standard benchmark."""
    if kind == "curve":
        return "Inverted" if value < 0 else "Positively sloped"
    if kind == "sahm":
        return "At or above 0.50 threshold" if value >= 0.5 else "Below 0.50 threshold"
    if kind == "target2":
        gap = value - 2.0
        return "Near 2% target" if abs(gap) < 0.25 else (f"{gap:+.1f} pt vs 2% target")
    return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    today = datetime.now(timezone.utc).date()
    try:
        previous = json.loads(OUT.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        previous = {}
    prev_by_id = {s["id"]: s for g in previous.get("groups", []) for s in g.get("series", [])}

    groups, failures = [], 0
    for group_label, specs in GROUPS:
        series_out = []
        for spec in specs:
            sid, freq = spec["id"], spec["freq"]
            # History: the trend window plus 13 months for 12-month changes and a margin.
            start = today - timedelta(days=WINDOW[freq][0] + (420 if spec.get("transform") == "yoy" else 30))
            try:
                obs = fetch_series(sid, start)
                if spec.get("transform") == "yoy":
                    obs = yoy(obs)
                if len(obs) < 2:
                    raise ValueError("fewer than two observations")
                (d1, v1), (d0, v0) = obs[-1], obs[-2]
                entry = {
                    "id": sid, "label": spec["label"], "sub": spec["sub"], "freq": freq,
                    "format": spec["value"], "change_format": spec["change"],
                    "date": d1, "value": round(v1, 4),
                    "prev_date": d0, "prev_value": round(v0, 4),
                    "window": WINDOW_LABEL[freq], "trend": trend(obs, freq, today),
                    "status": status_note(spec.get("status"), v1),
                    "source_url": f"https://fred.stlouisfed.org/series/{sid}",
                }
                print(f"ok    {sid:16s} {d1}  {v1:10.4f}  (prev {d0} {v0:.4f})  {len(entry['trend'])} trend points")
            except Exception as exc:  # keep the last good tile rather than dropping it
                failures += 1
                entry = prev_by_id.get(sid)
                print(f"FAIL  {sid:16s} ({exc}); {'kept previous value' if entry else 'no previous value'}")
                if entry is None:
                    continue
            series_out.append(entry)
        groups.append({"label": group_label, "series": series_out})

    if failures == sum(len(s) for _, s in GROUPS) and not previous:
        print("Every series failed and there is no previous file; nothing written.")
        return 0
    if groups == previous.get("groups"):
        print("No change in signals.")
        return 0
    OUT.write_text(json.dumps({
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "FRED, Federal Reserve Bank of St. Louis",
        "groups": groups,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {OUT.name} ({failures} series failed).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
