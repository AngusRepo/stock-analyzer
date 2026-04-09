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
  2. 讀每檔近 lookback_days 平均 volume (stock_prices)
  3. 濾掉：無 sector / avg_volume < min_avg_volume / 無 30d 資料
  4. 按 sector 分層 → 每層 sample 數 = round(target_size * sector_ratio)
  5. 層內按 avg_volume 降序 pick top-N（穩定再現：同 sector 內成交活躍者優先）
  6. 層分配總數湊不齊 target_size 時，從最大層補

回傳：sorted list[str] (symbol)。

NOTE (2026-04-09 F1 fix):
  這裡刻意不濾 `is_active=1`。`is_active` 是 ML 運算成本收束（每週 ~33 檔進
  Modal ensemble），不是 tradable universe 定義。SLTP/L2 是 vol-branched exit
  params (slMultLow/slMultHigh 依 vol_pct 切換)，需要涵蓋 low/mid/high 三個
  vol 分支的樣本才能正確 fit。只搜 is_active 會嚴重 under-sample 且 overfit
  當週 screener 偏好。正確的 tradability filter 是 `delisted_date IS NULL`。
"""
from __future__ import annotations
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from services.d1_client import query as d1_query

logger = logging.getLogger(__name__)


def select_stratified_subset(
    target_size: int = 250,
    end_date: Optional[str] = None,
    lookback_days: int = 30,
    min_avg_volume: int = 500_000,
) -> list[str]:
    """
    Args:
        target_size:    目標取樣檔數，預設 250
        end_date:       lookback 上界，預設今天 (TW)；格式 'YYYY-MM-DD'
        lookback_days:  avg_volume 計算的回看天數，預設 30
        min_avg_volume: 最低平均日成交量（股），低於此值直接排除

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

    # ── Step 1: candidate rows + avg_volume (單一 JOIN query) ──────────────
    # F1 fix (2026-04-09): 移除 is_active=1 — 見檔頭 NOTE。
    # 只保留真正的 tradability filter: delisted_date IS NULL + sector + liquidity。
    sql = """
        SELECT s.symbol, s.sector, AVG(sp.volume) AS avg_vol
        FROM stocks s
        JOIN stock_prices sp ON sp.stock_id = s.id
        WHERE s.delisted_date IS NULL
          AND s.sector IS NOT NULL AND s.sector != ''
          AND sp.date >= ? AND sp.date <= ?
        GROUP BY s.symbol, s.sector
        HAVING COUNT(sp.date) >= ? AND AVG(sp.volume) >= ?
    """
    min_days = max(5, lookback_days // 3)  # 至少 1/3 的 lookback 要有資料
    rows = d1_query(sql, [start_date, end_date, min_days, min_avg_volume])
    if not rows:
        logger.warning(
            f"[stratified_subset] 0 candidates in {start_date}~{end_date} "
            f"(min_avg_volume={min_avg_volume})"
        )
        return []

    logger.info(
        f"[stratified_subset] {len(rows)} candidates after basic filter "
        f"({start_date}~{end_date}, min_avg_volume={min_avg_volume})"
    )

    # ── Step 2: group by sector ─────────────────────────────────────────────
    by_sector: dict[str, list[dict]] = {}
    for r in rows:
        by_sector.setdefault(r["sector"], []).append(r)
    # Stable: sort each sector by avg_vol desc
    for sector in by_sector:
        by_sector[sector].sort(key=lambda x: x["avg_vol"] or 0, reverse=True)

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

    # ── Step 4: pick top-avg_vol per sector up to quota ────────────────────
    picked: list[str] = []
    for sector, lst in by_sector.items():
        q = quotas[sector]
        picked.extend(r["symbol"] for r in lst[:q])

    # ── Step 5: 校正總數 ─────────────────────────────────────────────────────
    deficit = target_size - len(picked)
    if deficit > 0:
        # 從最大 sector 補（逐一加回尚未選的 symbol）
        leftover: list[tuple[str, float]] = []
        picked_set = set(picked)
        for sector, lst in by_sector.items():
            for r in lst:
                if r["symbol"] not in picked_set:
                    leftover.append((r["symbol"], r["avg_vol"] or 0))
        leftover.sort(key=lambda x: x[1], reverse=True)
        picked.extend(sym for sym, _ in leftover[:deficit])
    elif deficit < 0:
        # 超出 target：按 avg_vol 保留 top-target_size（跨 sector）
        all_picked: list[tuple[str, float, str]] = []
        for sector, lst in by_sector.items():
            q = quotas[sector]
            for r in lst[:q]:
                all_picked.append((r["symbol"], r["avg_vol"] or 0, sector))
        all_picked.sort(key=lambda x: x[1], reverse=True)
        picked = [x[0] for x in all_picked[:target_size]]

    result = sorted(set(picked))
    logger.info(
        f"[stratified_subset] target={target_size} picked={len(result)} "
        f"across {len(by_sector)} sectors"
    )
    return result
