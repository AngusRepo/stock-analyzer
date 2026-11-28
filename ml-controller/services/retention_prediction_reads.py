"""Learning predictions reads that can pass the 120-day D1 hot window.

retention-hot-window-drain deletes predictions only after a verified R2 archive and a source
release receipt. Readers either merge those archived rows (retention_history.archived_predictions:
checksum, receipt and hot-wins rules), add the archived totals the drain keeps in
prediction_cold_stats_v1 (whole-history aggregates), or fail closed with an explicit reason when
no archived equivalent exists. Results equal the pre-deletion query; nothing shortens a window.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Iterable

from services import retention_history
from services.retention_archive import SCHEMA

PREDICTIONS_ARCHIVE_DOMAIN = 'retention_learning_lineage_v1_predictions'
# retentionHotDrainCutoff (worker) floors predictions at 120 + 7 buffer days from min(business date,
# Taipei today), so every archived row has prediction_date < Taipei today - 127 days.
PREDICTIONS_HOT_FLOOR_DAYS = 127


def never_archived(start: str, *, date_column: str = 'prediction_date', today: date | None = None) -> bool:
    """True when no archived row can fall at or after `start` (prediction_date windows only)."""
    if date_column != 'prediction_date':
        return False  # generated_at of a backfilled row can be recent while its prediction_date is old.
    taipei_today = today or (datetime.now(timezone.utc) + timedelta(hours=8)).date()
    return str(start)[:10] >= (taipei_today - timedelta(days=PREDICTIONS_HOT_FLOOR_DAYS)).isoformat()


class ColdPredictionsRequired(RuntimeError):
    """The requested window reaches archived predictions this reader cannot merge."""


def archived_prediction_rows(start: str, end: str, **kwargs: Any) -> list[dict]:
    if never_archived(start, date_column=kwargs.get('date_column', 'prediction_date')):
        return []
    return list(retention_history.archived_predictions(start, end, **kwargs))


def archived_predictions_overlap(start: str, end: str, *, query_ops: Callable | None = None) -> bool:
    """True when some deleted predictions chunk covers a prediction_date inside [start, end]."""
    if never_archived(start):
        return False
    ops = query_ops or retention_history.OPS.query
    rows = ops(
        """SELECT 1 AS hit FROM run_artifacts a
            WHERE a.domain=? AND a.schema_version=? AND a.retention_class='ten_year_cold_archive'
              AND a.status='ready' AND a.payload_deleted_at IS NULL
              AND COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.coverage_end') END,'9999-12-31')>=?
              AND COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.coverage_start') END,'0000-01-01')<=?
            LIMIT 1""",
        [PREDICTIONS_ARCHIVE_DOMAIN, SCHEMA, str(start)[:10], str(end)[:10]],
    )
    return bool(rows)


def require_hot_prediction_lookback(end: str, lookback_days: int, reason: str) -> None:
    """Guard for SQL windows `date(prediction_date) >= date(end, '-N days')` that only read D1."""
    start = (date.fromisoformat(str(end)[:10]) - timedelta(days=max(1, int(lookback_days)))).isoformat()
    require_hot_predictions(start, end, reason)


def require_hot_predictions(start: str, end: str, reason: str, *, query_ops: Callable | None = None) -> None:
    """Fail closed instead of returning a window silently cut at the hot-window boundary."""
    if archived_predictions_overlap(start, end, query_ops=query_ops):
        raise ColdPredictionsRequired(f'predictions_cold_archive_required:{reason}:{str(start)[:10]}..{str(end)[:10]}')


def require_hot_latest(rows: list[dict], limit: int, start: str, end: str, reason: str,
                       date_key: str = 'prediction_date') -> None:
    """Guard for D1-only `ORDER BY <date> DESC LIMIT n` reads: a full page is only affected at or after
    its oldest date (normally inside the hot window, so nothing is looked up)."""
    if rows and len(rows) >= int(limit):
        oldest = min(str(row.get(date_key) or '')[:10] for row in rows)
        start = max(str(start)[:10], oldest)
    require_hot_predictions(start, end, reason)


def merge_latest(hot_rows: list[dict], cold_rows: Iterable[dict], *, key: Callable[[dict], Any],
                 reverse: bool, limit: int | None = None) -> list[dict]:
    """ORDER BY key [DESC] LIMIT over hot plus archived rows; ties keep hot first, like a stable merge."""
    cold = list(cold_rows)
    if not cold:
        return hot_rows
    merged = sorted([*hot_rows, *cold], key=key, reverse=reverse)
    return merged if limit is None else merged[:limit]


# Same aggregates, names and order as worker/src/lib/retentionPredictionColdStats.ts (the drain
# writes them per archived chunk); worker retentionPredictionColdStats.test.ts compares both lists.
PREDICTION_COLD_STATS_EXPRESSIONS: tuple[tuple[str, str, str], ...] = (
    ('d_total', 'count', 'SUM(CASE WHEN p.direction_correct IN (0,1) THEN 1 ELSE 0 END)'),
    ('d_correct', 'count', 'SUM(CASE WHEN p.direction_correct IN (0,1) THEN p.direction_correct ELSE 0 END)'),
    ('d_err_sum', 'sum', 'SUM(CASE WHEN p.direction_correct IN (0,1) THEN p.price_error_pct END)'),
    ('d_err_n', 'count', 'COUNT(CASE WHEN p.direction_correct IN (0,1) THEN p.price_error_pct END)'),
    ('d_low_total', 'count', "SUM(CASE WHEN p.direction_correct IN (0,1) AND p.market_risk_level IN ('green','yellow') THEN 1 ELSE 0 END)"),
    ('d_low_correct', 'count', "SUM(CASE WHEN p.direction_correct IN (0,1) AND p.market_risk_level IN ('green','yellow') THEN p.direction_correct ELSE 0 END)"),
    ('d_high_total', 'count', "SUM(CASE WHEN p.direction_correct IN (0,1) AND p.market_risk_level IN ('red','black') THEN 1 ELSE 0 END)"),
    ('d_high_correct', 'count', "SUM(CASE WHEN p.direction_correct IN (0,1) AND p.market_risk_level IN ('red','black') THEN p.direction_correct ELSE 0 END)"),
    ('d_win_sum', 'sum', 'SUM(CASE WHEN p.direction_correct IN (0,1) AND p.direction_correct=1 THEN p.actual_return_pct END)'),
    ('d_win_n', 'count', 'COUNT(CASE WHEN p.direction_correct IN (0,1) AND p.direction_correct=1 THEN p.actual_return_pct END)'),
    ('d_loss_sum', 'sum', 'SUM(CASE WHEN p.direction_correct IN (0,1) AND p.direction_correct=0 THEN p.actual_return_pct END)'),
    ('d_loss_n', 'count', 'COUNT(CASE WHEN p.direction_correct IN (0,1) AND p.direction_correct=0 THEN p.actual_return_pct END)'),
    ('d_pnl_sum', 'sum', 'SUM(CASE WHEN p.direction_correct IN (0,1) THEN p.trade_pnl_pct END)'),
    ('d_pnl_n', 'count', 'COUNT(CASE WHEN p.direction_correct IN (0,1) THEN p.trade_pnl_pct END)'),
    ('d_r_sum', 'sum', 'SUM(CASE WHEN p.direction_correct IN (0,1) THEN p.trade_pnl_r END)'),
    ('d_r_n', 'count', 'COUNT(CASE WHEN p.direction_correct IN (0,1) THEN p.trade_pnl_r END)'),
    ('d_gross_profit', 'sum', 'SUM(CASE WHEN p.direction_correct IN (0,1) THEN CASE WHEN p.trade_pnl_pct > 0 THEN p.trade_pnl_pct ELSE 0 END END)'),
    ('d_gross_loss', 'sum', 'SUM(CASE WHEN p.direction_correct IN (0,1) THEN CASE WHEN p.trade_pnl_pct < 0 THEN ABS(p.trade_pnl_pct) ELSE 0 END END)'),
    ('d_hit_target', 'count', "SUM(CASE WHEN p.direction_correct IN (0,1) AND (p.trade_outcome='hit_target1' OR p.trade_outcome='hit_target2') THEN 1 ELSE 0 END)"),
    ('d_hit_stop', 'count', "SUM(CASE WHEN p.direction_correct IN (0,1) AND p.trade_outcome='hit_stop' THEN 1 ELSE 0 END)"),
    ('t_total', 'count', 'SUM(CASE WHEN p.trade_pnl_pct IS NOT NULL THEN 1 ELSE 0 END)'),
    ('t_wins', 'count', 'SUM(CASE WHEN p.trade_pnl_pct > 0 THEN 1 ELSE 0 END)'),
    ('t_losses', 'count', 'SUM(CASE WHEN p.trade_pnl_pct < 0 THEN 1 ELSE 0 END)'),
    ('t_pnl_sum', 'sum', 'SUM(p.trade_pnl_pct)'),
    ('t_win_sum', 'sum', 'SUM(CASE WHEN p.trade_pnl_pct > 0 THEN p.trade_pnl_pct END)'),
    ('t_loss_sum', 'sum', 'SUM(CASE WHEN p.trade_pnl_pct < 0 THEN p.trade_pnl_pct END)'),
    ('t_max', 'max', 'MAX(p.trade_pnl_pct)'),
    ('t_min', 'min', 'MIN(p.trade_pnl_pct)'),
    ('t_gross_profit', 'sum', 'SUM(CASE WHEN p.trade_pnl_pct IS NOT NULL THEN CASE WHEN p.trade_pnl_pct > 0 THEN p.trade_pnl_pct ELSE 0 END END)'),
    ('t_gross_loss', 'sum', 'SUM(CASE WHEN p.trade_pnl_pct IS NOT NULL THEN CASE WHEN p.trade_pnl_pct < 0 THEN ABS(p.trade_pnl_pct) ELSE 0 END END)'),
    ('t_r_sum', 'sum', 'SUM(CASE WHEN p.trade_pnl_pct IS NOT NULL THEN p.trade_pnl_r END)'),
    ('t_r_n', 'count', 'COUNT(CASE WHEN p.trade_pnl_pct IS NOT NULL THEN p.trade_pnl_r END)'),
    ('t_hit_t1', 'count', "SUM(CASE WHEN p.trade_pnl_pct IS NOT NULL AND p.trade_outcome='hit_target1' THEN 1 ELSE 0 END)"),
    ('t_hit_t2', 'count', "SUM(CASE WHEN p.trade_pnl_pct IS NOT NULL AND p.trade_outcome='hit_target2' THEN 1 ELSE 0 END)"),
    ('t_hit_stop', 'count', "SUM(CASE WHEN p.trade_pnl_pct IS NOT NULL AND p.trade_outcome='hit_stop' THEN 1 ELSE 0 END)"),
    ('t_expired', 'count', "SUM(CASE WHEN p.trade_pnl_pct IS NOT NULL AND p.trade_outcome='expired' THEN 1 ELSE 0 END)"),
    ('t_mfe_sum', 'sum', 'SUM(CASE WHEN p.trade_pnl_pct IS NOT NULL THEN p.max_favorable_pct END)'),
    ('t_mfe_n', 'count', 'COUNT(CASE WHEN p.trade_pnl_pct IS NOT NULL THEN p.max_favorable_pct END)'),
    ('t_mae_sum', 'sum', 'SUM(CASE WHEN p.trade_pnl_pct IS NOT NULL THEN p.max_adverse_pct END)'),
    ('t_mae_n', 'count', 'COUNT(CASE WHEN p.trade_pnl_pct IS NOT NULL THEN p.max_adverse_pct END)'),
    # services.no_lookahead_audit canonical_prediction_label (CANONICAL_LABEL_VERSION) over archived rows.
    ('label_v4_violations', 'count', "SUM(CASE WHEN p.verification_label_schema_version='next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4' AND (p.prediction_date IS NULL OR p.verification_label_end_date < p.prediction_date OR p.verification_label_known_date <= p.prediction_date) THEN 1 ELSE 0 END)"),
)


def load_prediction_cold_stats(query: Callable) -> dict[tuple[int, str], dict]:
    """All prediction_cold_stats_v1 rows (one per stock/model with archived rows), paged by primary key."""
    out: dict[tuple[int, str], dict] = {}
    cursor: tuple[int, str] = (-(2 ** 62), '')
    while True:
        try:
            rows = query(
                'SELECT * FROM prediction_cold_stats_v1 WHERE (stock_id, model_name) > (?, ?) '
                'ORDER BY stock_id, model_name LIMIT 2000', [cursor[0], cursor[1]])
        except Exception as exc:  # noqa: BLE001 - only a missing table is tolerated
            # Learning migration 0073 not applied yet: the drain cannot have released a predictions
            # chunk (its delete batch writes this table), so there are no archived totals.
            if 'no such table' in str(exc) and 'prediction_cold_stats_v1' in str(exc):
                return out
            raise
        for row in rows:
            out[(int(row['stock_id']), str(row['model_name']))] = dict(row)
        if len(rows) < 2000:
            return out
        cursor = (int(rows[-1]['stock_id']), str(rows[-1]['model_name']))


def hot_prediction_partials(query: Callable, stock_id: Any, model_name: str) -> dict:
    sql = ('SELECT ' + ', '.join(f'{expr} AS {name}' for name, _, expr in PREDICTION_COLD_STATS_EXPRESSIONS)
           + ' FROM predictions p WHERE p.stock_id=? AND p.model_name=?')
    rows = query(sql, params=[stock_id, model_name])
    return dict(rows[0]) if rows else {}


def combine_prediction_partials(hot: dict, cold: dict | None) -> dict:
    """Hot aggregates plus archived totals; a sum stays None while no row contributed (SQL SUM semantics)."""
    combined: dict[str, Any] = {}
    for name, kind, _ in PREDICTION_COLD_STATS_EXPRESSIONS:
        a, b = hot.get(name), (cold or {}).get(name)
        if kind == 'count':
            combined[name] = int(a or 0) + int(b or 0)
        elif a is None or b is None:
            combined[name] = b if a is None else a
        else:
            combined[name] = a + b if kind == 'sum' else (max(a, b) if kind == 'max' else min(a, b))
    return combined
