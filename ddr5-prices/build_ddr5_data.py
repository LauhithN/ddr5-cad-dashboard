#!/usr/bin/env python3
"""
Builds ddr5-data.js for the local DDR5 CAD price dashboard.

Data sources:
- RAM Pricing benchmark (USD):
  https://www.ram-pricing.com/benchmarks/ddr5-ram-prices?locale=us
- Bank of Canada FXUSDCAD daily rates:
  https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json
"""

from __future__ import annotations

import json
import math
import re
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

OUT_PATH = Path(__file__).resolve().parent / "ddr5-data.js"

RAM_BENCHMARK_URL = "https://www.ram-pricing.com/benchmarks/ddr5-ram-prices?locale=us"
BOC_BASE_URL = "https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json"

HIST_START = "2021-02"
HIST_END = "2026-02"
PROJ_MONTHS = 120

CAPS = [16, 32, 64]
LAUNCH_MONTH = {
    16: "2021-11",
    32: "2021-11",
    64: "2022-08",
}

# Relative index anchors (to Feb 2026 = 1.0).
# 2025-11 onward is replaced with observed benchmark index months.
BACKFILL_ANCHORS = {
    "2021-11": 1.42,
    "2022-06": 1.18,
    "2023-06": 0.76,
    "2024-06": 0.83,
    "2025-06": 0.95,
    "2025-10": 0.99,
}


def fetch_text(url: str) -> str:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/122.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.ram-pricing.com/",
    }

    last_error = None
    for attempt in range(4):
        try:
            req = Request(url, headers=headers)
            with urlopen(req, timeout=35) as resp:
                return resp.read().decode("utf-8")
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt == 3:
                break
            # Back off to handle intermittent blocks/rate limiting.
            time.sleep(2 ** attempt)

    raise RuntimeError(f"Failed to fetch URL after retries: {url}") from last_error


def month_num(ym: str) -> int:
    y, m = ym.split("-")
    return int(y) * 12 + int(m)


def month_iter(start: str, end: str) -> list[str]:
    sy, sm = map(int, start.split("-"))
    ey, em = map(int, end.split("-"))
    out = []
    y, m = sy, sm
    while (y < ey) or (y == ey and m <= em):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


def parse_benchmark_us() -> tuple[list[dict], dict[int, float], dict[str, float]]:
    html = fetch_text(RAM_BENCHMARK_URL)

    trend_match = re.search(
        r'\\"data\\":\[(\{\\"date\\":\\"[0-9-]+\\".*?\})\],\\"title\\":\\"Average DDR5 Module Price',
        html,
    )
    if not trend_match:
        raise RuntimeError("Could not find DDR5 trend data in benchmark page")

    trend_payload = "[" + trend_match.group(1) + "]"
    trend = json.loads(trend_payload.encode("utf-8").decode("unicode_escape"))

    cap_match = re.search(
        r'\\"data\\":\[(\{\\"label\\":\\"(?:8GB|16GB)\\".*?\})\],\\"title\\":\\"Average Price by Capacity',
        html,
    )
    if not cap_match:
        raise RuntimeError("Could not find capacity benchmark data in benchmark page")

    cap_payload = "[" + cap_match.group(1) + "]"
    cap_rows = json.loads(cap_payload.encode("utf-8").decode("unicode_escape"))
    cap_map = {int(row["label"].replace("GB", "")): float(row["value"]) for row in cap_rows}

    if not all(cap in cap_map for cap in CAPS):
        missing = [cap for cap in CAPS if cap not in cap_map]
        raise RuntimeError(f"Missing capacity rows in benchmark data: {missing}")

    by_month = defaultdict(list)
    for row in trend:
        by_month[row["date"][:7]].append(float(row["avgPrice"]))
    monthly_avg = {month: sum(vals) / len(vals) for month, vals in by_month.items()}

    return trend, cap_map, monthly_avg


def fetch_fx_monthly(start_date: str, end_date: str) -> dict[str, float]:
    query = urlencode({"start_date": start_date, "end_date": end_date})
    url = f"{BOC_BASE_URL}?{query}"
    payload = json.loads(fetch_text(url))

    by_month = defaultdict(list)
    for obs in payload.get("observations", []):
        day = obs.get("d")
        fx_cell = obs.get("FXUSDCAD", {})
        if not day or "v" not in fx_cell:
            continue
        try:
            rate = float(fx_cell["v"])
        except (TypeError, ValueError):
            continue
        by_month[day[:7]].append(rate)

    return {month: sum(vals) / len(vals) for month, vals in by_month.items()}


def interpolate_index(ym: str, anchors: dict[str, float]) -> float | None:
    ordered = sorted(anchors)
    n = month_num(ym)

    if n < month_num(ordered[0]):
        return None
    if ym in anchors:
        return anchors[ym]

    for i in range(len(ordered) - 1):
        left, right = ordered[i], ordered[i + 1]
        nl, nr = month_num(left), month_num(right)
        if nl <= n <= nr:
            vl, vr = anchors[left], anchors[right]
            if nr == nl:
                return vl
            t = (n - nl) / (nr - nl)
            return vl + t * (vr - vl)

    return anchors[ordered[-1]]


def build_historical(cap_usd: dict[int, float], idx_month: dict[str, float], fx_month: dict[str, float]) -> list[dict]:
    months = month_iter(HIST_START, HIST_END)

    if "2026-02" not in idx_month:
        raise RuntimeError("Benchmark index missing 2026-02")

    idx_ref = idx_month["2026-02"]

    anchors = dict(BACKFILL_ANCHORS)
    for month in ["2025-11", "2025-12", "2026-01", "2026-02"]:
        if month in idx_month:
            anchors[month] = idx_month[month] / idx_ref

    fx_fallback = fx_month.get("2026-02", 1.35)

    rows = []
    for ym in months:
        idx = interpolate_index(ym, anchors)
        fx = fx_month.get(ym, fx_fallback)

        row = {
            "month": ym,
            "phase": "historical_observed_index" if ym >= "2025-11" else "historical_modeled",
            "fx_usdcad": round(fx, 4),
        }

        for cap in CAPS:
            key = f"gb{cap}"
            if idx is None or month_num(ym) < month_num(LAUNCH_MONTH[cap]):
                row[key] = None
                continue

            usd = cap_usd[cap] * idx
            row[key] = round(usd * fx, 2)

        rows.append(row)

    return rows


def build_projection(history: list[dict]) -> list[dict]:
    out = []
    hist_end_num = month_num(HIST_END)

    # mean-reverting growth model:
    # recent growth -> long-run slight decline with cyclical memory market wave.
    long_run_growth = 0.999  # monthly
    cycle_months = 36
    cycle_amp = 0.04

    for cap in CAPS:
        key = f"gb{cap}"
        recent = [
            (month_num(row["month"]), row[key])
            for row in history
            if row[key] is not None and row["month"] >= "2024-01"
        ]
        if len(recent) < 2:
            raise RuntimeError(f"Not enough history for projection: {cap}GB")

        start_val = recent[0][1]
        last_val = recent[-1][1]
        recent_growth = math.exp((math.log(last_val) - math.log(start_val)) / (len(recent) - 1))
        recent_growth = min(max(recent_growth, 0.997), 1.004)

        val = last_val
        for step in range(1, PROJ_MONTHS + 1):
            month_index = hist_end_num + step
            y = month_index // 12
            m = month_index % 12
            if m == 0:
                y -= 1
                m = 12
            ym = f"{y:04d}-{m:02d}"

            blend = 1.0 - math.exp(-step / 36.0)
            growth = math.exp(
                math.log(recent_growth) * (1.0 - blend) + math.log(long_run_growth) * blend
            )
            val *= growth

            cyc = 1.0 + cycle_amp * math.sin(2.0 * math.pi * step / cycle_months)
            projected = round(val * cyc, 2)

            if len(out) < step:
                out.append({"month": ym, "phase": "projection"})
            out[step - 1][key] = projected

    return out


def main() -> None:
    trend_daily, cap_map, idx_month = parse_benchmark_us()

    fx_month = fetch_fx_monthly("2021-02-01", "2026-02-28")

    cap_usd = {cap: cap_map[cap] for cap in CAPS}
    historical = build_historical(cap_usd, idx_month, fx_month)
    projection = build_projection(historical)

    payload = {
        "generatedAtUtc": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "historicalWindow": {
            "start": HIST_START,
            "end": HIST_END,
            "observedIndexStart": "2025-11",
        },
        "projectionWindow": {
            "start": projection[0]["month"],
            "end": projection[-1]["month"],
        },
        "capacitiesGb": CAPS,
        "baseUsdByCapacityAt2026_02": cap_usd,
        "assumptions": {
            "launchMonthByCapacity": LAUNCH_MONTH,
            "backfillAnchorsRelativeTo2026_02": BACKFILL_ANCHORS,
            "projectionModel": "mean-reverting monthly log-growth with 36-month +/-4% cycle",
        },
        "sources": [
            {
                "name": "RAM Pricing DDR5 Benchmark (Amazon.com, USD)",
                "url": RAM_BENCHMARK_URL,
            },
            {
                "name": "Bank of Canada FXUSDCAD daily exchange rate",
                "url": "https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json",
            },
        ],
        "series": {
            "historical": historical,
            "projection": projection,
            "observedDailyIndexUsd": trend_daily,
        },
    }

    js = "const DDR5_DATA = " + json.dumps(payload, separators=(",", ":")) + ";\n"
    js += "if (typeof window !== 'undefined') { window.DDR5_DATA = DDR5_DATA; }\n"
    OUT_PATH.write_text(js)

    print(f"wrote {OUT_PATH}")
    print(f"historical rows: {len(historical)}")
    print(f"projection rows: {len(projection)}")


if __name__ == "__main__":
    main()
