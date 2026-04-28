"""Paper/order-level AB evidence for model-pool challenger promotion."""

from __future__ import annotations

import os
from collections import defaultdict
from typing import Any


MANAGED_MODELS = (
    "XGBoost",
    "CatBoost",
    "ExtraTrees",
    "LightGBM",
    "FT-Transformer",
    "Chronos",
    "DLinear",
    "PatchTST",
    "KalmanFilter",
    "MarkovSwitching",
)


def _as_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _rank_avg_ties(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(values):
        j = i
        while j + 1 < len(values) and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg = (i + j + 2) / 2.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def _spearman(xs: list[float], ys: list[float]) -> float:
    if len(xs) != len(ys) or len(xs) < 2:
        return 0.0
    xr = _rank_avg_ties(xs)
    yr = _rank_avg_ties(ys)
    mx = sum(xr) / len(xr)
    my = sum(yr) / len(yr)
    num = sum((x - mx) * (y - my) for x, y in zip(xr, yr))
    denx = sum((x - mx) ** 2 for x in xr) ** 0.5
    deny = sum((y - my) ** 2 for y in yr) ** 0.5
    if denx == 0 or deny == 0:
        return 0.0
    return num / (denx * deny)


def evaluate_paper_order_ab_rows(
    rows: list[dict[str, Any]],
    *,
    min_orders: int = 20,
    min_ic_lift: float = 0.0,
    min_challenger_ic: float = 0.0,
) -> dict[str, dict[str, Any]]:
    grouped: dict[str, list[tuple[float, float, float]]] = defaultdict(list)
    order_counts: dict[str, int] = defaultdict(int)
    for row in rows:
        model = str(row.get("model_name") or "")
        active = _as_float(row.get("active_score"))
        challenger = _as_float(row.get("challenger_score"))
        actual = _as_float(row.get("actual_return_pct"))
        if not model or active is None or challenger is None or actual is None:
            continue
        grouped[model].append((active, challenger, actual))
        order_counts[model] += int(row.get("paper_buy_count") or 1)

    out: dict[str, dict[str, Any]] = {}
    for model, triples in grouped.items():
        active_scores = [t[0] for t in triples]
        challenger_scores = [t[1] for t in triples]
        returns = [t[2] for t in triples]
        active_ic = _spearman(active_scores, returns)
        challenger_ic = _spearman(challenger_scores, returns)
        ic_lift = challenger_ic - active_ic
        failed: list[str] = []
        if order_counts[model] < min_orders:
            failed.append("paper_order_min_samples")
        if challenger_ic < min_challenger_ic:
            failed.append("paper_order_challenger_ic")
        if ic_lift <= min_ic_lift:
            failed.append("paper_order_ic_lift")
        out[model] = {
            "decision": "PASS" if not failed else "FAIL",
            "failed_gates": failed,
            "orders": order_counts[model],
            "matched_rows": len(triples),
            "active_order_ic": round(active_ic, 6),
            "challenger_order_ic": round(challenger_ic, 6),
            "ic_lift": round(ic_lift, 6),
            "min_orders": min_orders,
            "min_ic_lift": min_ic_lift,
            "min_challenger_ic": min_challenger_ic,
        }
    return out


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def load_paper_order_ab_by_model(lookback_days: int = 90) -> dict[str, dict[str, Any]]:
    from services.d1_client import query

    managed_csv = ",".join(f"'{m}'" for m in MANAGED_MODELS)
    challenger_csv = ",".join(f"'{m}::challenger'" for m in MANAGED_MODELS)
    rows = query(
        f"""
        WITH paper_buys AS (
            SELECT
                po.symbol,
                date(po.created_at) AS order_date,
                COUNT(*) AS paper_buy_count
            FROM paper_orders po
            WHERE po.side = 'buy'
              AND COALESCE(po.source, '') IN ('auto_ml', 'manual', 'limit_intraday')
              AND po.created_at >= datetime('now', ?)
            GROUP BY po.symbol, date(po.created_at)
        ),
        scored AS (
            SELECT
                pb.symbol,
                pb.order_date,
                pb.paper_buy_count,
                base.model_name,
                base.direction_accuracy AS active_score,
                ch.direction_accuracy AS challenger_score,
                base.actual_return_pct
            FROM paper_buys pb
            JOIN stocks s ON s.symbol = pb.symbol
            JOIN predictions base
              ON base.stock_id = s.id
             AND base.model_name IN ({managed_csv})
             AND date(base.generated_at) <= pb.order_date
             AND base.verified_at IS NOT NULL
             AND base.actual_return_pct IS NOT NULL
            JOIN predictions ch
              ON ch.stock_id = base.stock_id
             AND ch.model_name = base.model_name || '::challenger'
             AND date(ch.generated_at) = date(base.generated_at)
             AND ch.verified_at IS NOT NULL
             AND ch.actual_return_pct IS NOT NULL
             AND ch.model_name IN ({challenger_csv})
            WHERE base.id = (
                SELECT b2.id
                FROM predictions b2
                WHERE b2.stock_id = base.stock_id
                  AND b2.model_name = base.model_name
                  AND date(b2.generated_at) <= pb.order_date
                ORDER BY b2.generated_at DESC, b2.id DESC
                LIMIT 1
            )
        )
        SELECT *
        FROM scored
        """,
        [f"-{lookback_days} days"],
    )
    return evaluate_paper_order_ab_rows(
        rows,
        min_orders=_env_int("PROMOTION_MIN_PAPER_AB_ORDERS", 20),
        min_ic_lift=_env_float("PROMOTION_MIN_PAPER_ORDER_IC_LIFT", 0.0),
        min_challenger_ic=_env_float("PROMOTION_MIN_PAPER_ORDER_CHALLENGER_IC", 0.0),
    )
