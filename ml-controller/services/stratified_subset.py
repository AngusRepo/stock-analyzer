"""
stratified_subset.py — Sprint 5.1 subset 取樣器

目的：從 D1 stocks 表按 sector 做 proportional-stratified sampling，
輸出 200-300 檔 symbol list，餵進 backtest_engine / Optuna subset 搜尋。

Why:
  Full universe (~2346 stocks) 跑 backtest_engine replay 太慢，Sprint 5.1
  要 200 trials × 90 days × full universe 根本不可行。subset 取樣需要 stratified
  (不是 random)，不然 L2/SLTP 最佳化會偏 sector heavyweight（大型股／電子股）。

取樣策略：
  1. 讀 `stocks` 表 active + not delisted 的 (id, symbol, sector)
  2. 讀每檔近 lookback_days 的 close × volume (stock_prices)
  3. 濾掉：無 sector / median daily traded value 未達 L0.5 capacity / 少於 3 個 PIT sessions
  4. 按 sector 分層 → 每層 sample 數 = round(target_size * sector_ratio)
  5. 層內用 end_date + symbol 的 deterministic hash 取樣，不依流動性排序
  6. 層分配總數湊不齊 target_size 時，從最大層補

回傳：sorted list[str] (symbol)。這是 research compute subset，不是 production top-k。

NOTE (2026-04-09 F1 fix):
  這裡刻意不濾 `in_current_watchlist=1`。`in_current_watchlist` 是 ML 運算成本
  收束（每週 ~33 檔進 Modal ensemble），不是 tradable universe 定義。SLTP/L2
  是 vol-branched exit params (slMultLow/slMultHigh 依 vol_pct 切換)，需要涵蓋
  low/mid/high 三個 vol 分支的樣本才能正確 fit。只搜 in_current_watchlist 會嚴重 under-sample 且 overfit
  當週 screener 偏好。正確的 tradability filter 是 `delisted_date IS NULL`。
"""
from __future__ import annotations
import hashlib
import logging
from statistics import median
from datetime import datetime, timedelta, timezone
from typing import Optional

from services.domain_stock_read_models import load_market_price_rows_with_identity

logger = logging.getLogger(__name__)


def select_stratified_subset(
    target_size: int = 250,
    end_date: Optional[str] = None,
    lookback_days: int = 30,
    min_median_daily_traded_value: float = 13_000_000,
) -> list[str]:
    """
    Args:
        target_size:    目標取樣檔數，預設 250
        end_date:       lookback 上界，預設今天 (TW)；格式 'YYYY-MM-DD'
        lookback_days:  PIT daily traded value 計算的回看天數，預設 30
        min_median_daily_traded_value: L0.5 median ADTV capacity floor (TWD)

    Returns:
        list[str] symbols, sorted, len ≈ target_size
    """
    if end_date is None:
        # TW local date
        tw_now = datetime.now(timezone.utc) + timedelta(hours=8)
        end_date = tw_now.date().isoformat()
    start_date = (
        datetime.fromisoformat(end_date) - timedelta(days=lookback_days)
    ).date().isoformat()

    # ── Step 1: Core identities + Market volume, joined in memory ───────────
    price_rows = load_market_price_rows_with_identity(
        start_date=start_date,
        end_date=end_date,
        fields=("date", "close", "volume"),
        require_sector=True,
    )
    window_sessions = 20
    min_days = 3
    aggregates: dict[str, dict[str, object]] = {}
    for price_row in price_rows:
        symbol = str(price_row.get("symbol") or "")
        sector = str(price_row.get("sector") or "")
        trade_date = str(price_row.get("date") or "")
        close = price_row.get("close")
        volume = price_row.get("volume")
        if not symbol or not sector or not trade_date or close is None or volume is None:
            continue
        daily_value = float(close) * float(volume)
        if daily_value < 0:
            continue
        packet = aggregates.setdefault(
            symbol,
            {"symbol": symbol, "sector": sector, "daily_values_by_date": {}},
        )
        values_by_date = packet["daily_values_by_date"]
        if isinstance(values_by_date, dict):
            values_by_date[trade_date] = daily_value
    rows: list[dict[str, object]] = []
    for packet in aggregates.values():
        values_by_date = packet["daily_values_by_date"]
        if not isinstance(values_by_date, dict):
            continue
        recent_values = [float(value) for _, value in sorted(values_by_date.items())[-window_sessions:]]
        if len(recent_values) < min_days:
            continue
        median_daily_value = float(median(recent_values))
        if median_daily_value < min_median_daily_traded_value:
            continue
        symbol = str(packet["symbol"])
        sample_key = hashlib.sha256(f"{end_date}:{symbol}".encode("utf-8")).hexdigest()
        rows.append({
            "symbol": symbol,
            "sector": packet["sector"],
            "median_daily_value": median_daily_value,
            "sample_key": sample_key,
        })
    if not rows:
        logger.warning(
            f"[stratified_subset] 0 candidates in {start_date}~{end_date} "
            f"(min_median_daily_traded_value={min_median_daily_traded_value})"
        )
        return []

    logger.info(
        f"[stratified_subset] {len(rows)} candidates after basic filter "
        f"({start_date}~{end_date}, min_median_daily_traded_value={min_median_daily_traded_value})"
    )

    # ── Step 2: group by sector ─────────────────────────────────────────────
    by_sector: dict[str, list[dict]] = {}
    for r in rows:
        by_sector.setdefault(r["sector"], []).append(r)
    # Stable deterministic sample; never rank the research universe by liquidity.
    for sector in by_sector:
        by_sector[sector].sort(key=lambda x: str(x["sample_key"]))

    total = len(rows)
    # ── Step 3: proportional allocation per sector ─────────────────────────
    #  quota_i = round(target_size * len(sector_i) / total)
    sector_counts = {s: len(lst) for s, lst in by_sector.items()}
    quotas = {
        s: max(1, round(target_size * cnt / total))
        for s, cnt in sector_counts.items()
    }
    # Cap: 不能超過該 sector 實際數量
    for s in quotas:
        quotas[s] = min(quotas[s], sector_counts[s])

    # ── Step 4: deterministic within-sector compute sample ────────────────
    picked: list[str] = []
    for sector, lst in by_sector.items():
        q = quotas[sector]
        picked.extend(r["symbol"] for r in lst[:q])

    # ── Step 5: 校正總數 ─────────────────────────────────────────────────────
    deficit = target_size - len(picked)
    if deficit > 0:
        # 從最大 sector 補（逐一加回尚未選的 symbol）
        leftover: list[tuple[str, str]] = []
        picked_set = set(picked)
        for sector, lst in by_sector.items():
            for r in lst:
                if r["symbol"] not in picked_set:
                    leftover.append((str(r["symbol"]), str(r["sample_key"])))
        leftover.sort(key=lambda x: x[1], reverse=True)
        picked.extend(sym for sym, _ in leftover[:deficit])
    elif deficit < 0:
        # 超出 target：用相同 deterministic key 收束 compute subset。
        all_picked: list[tuple[str, str, str]] = []
        for sector, lst in by_sector.items():
            q = quotas[sector]
            for r in lst[:q]:
                all_picked.append((str(r["symbol"]), str(r["sample_key"]), sector))
        all_picked.sort(key=lambda x: x[1], reverse=True)
        picked = [x[0] for x in all_picked[:target_size]]

    result = sorted(set(picked))
    logger.info(
        f"[stratified_subset] target={target_size} picked={len(result)} "
        f"across {len(by_sector)} sectors"
    )
    return result
