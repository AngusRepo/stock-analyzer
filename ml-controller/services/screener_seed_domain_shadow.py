"""Read-only production comparator for the legacy screener seed cross-domain join."""
from __future__ import annotations

import os
from typing import Any, Protocol

from services.d1_domain_client import shadow_client_for_domain
from services.screener_seed_domain_merge import (
    compare_screener_seed_domain_results,
    merge_screener_seed_domains,
)


SHADOW_COMPARE_ENV = "D1_SCREENER_SEED_SHADOW_COMPARE_ENABLED"
D1_QUERY_SYMBOL_CHUNK = 80


class ReadOnlyD1Client(Protocol):
    def query(
        self,
        sql: str,
        params: list[Any] | None = None,
        timeout: float = 60.0,
    ) -> list[dict]: ...


def screener_seed_shadow_compare_enabled() -> bool:
    return os.environ.get(SHADOW_COMPARE_ENV, "").strip().lower() in {"1", "true", "yes", "on"}


def _ops_seed_rows(client: ReadOnlyD1Client, run_date: str) -> list[dict[str, Any]]:
    return client.query(
        """
        WITH latest_screener_run AS (
            SELECT run_id, created_at
              FROM screener_funnel_runs
             WHERE date = ? AND status = 'success'
             ORDER BY created_at DESC
             LIMIT 1
        ),
        candidate_seed AS (
            SELECT sfi.*,
                   ROW_NUMBER() OVER (
                       PARTITION BY sfi.symbol
                       ORDER BY CASE sfi.stage
                           WHEN 'l1_candidate_seed_after_overlay' THEN 0
                           WHEN 'final_selection' THEN 1
                           ELSE 3 END,
                           COALESCE(sfi.rank, 999999)
                   ) AS stage_preference_rank
              FROM screener_funnel_items sfi
             WHERE sfi.run_id = (SELECT run_id FROM latest_screener_run)
               AND (
                    sfi.stage = 'l1_candidate_seed_after_overlay' AND sfi.decision = 'selected'
                 OR sfi.stage = 'final_selection' AND sfi.decision = 'selected'
               )
        ),
        scoring_seed AS (
            SELECT * FROM (
                SELECT sfi.*,
                       ROW_NUMBER() OVER (
                           PARTITION BY sfi.symbol
                           ORDER BY COALESCE(sfi.rank, 999999), sfi.created_at DESC
                       ) AS scoring_rank
                  FROM screener_funnel_items sfi
                 WHERE sfi.run_id = (SELECT run_id FROM latest_screener_run)
                   AND sfi.stage = 'scoring' AND sfi.decision = 'pass'
            ) WHERE scoring_rank = 1
        ),
        l1_seed AS (
            SELECT * FROM (
                SELECT sfi.*,
                       ROW_NUMBER() OVER (
                           PARTITION BY sfi.symbol
                           ORDER BY COALESCE(sfi.rank, 999999), sfi.created_at DESC
                       ) AS l1_rank
                  FROM screener_funnel_items sfi
                 WHERE sfi.run_id = (SELECT run_id FROM latest_screener_run)
                   AND sfi.stage = 'l1_candidate_seed_after_overlay'
                   AND sfi.decision = 'selected'
            ) WHERE l1_rank = 1
        )
        SELECT sfi.run_id AS screener_run_id,
               (SELECT created_at FROM latest_screener_run) AS decision_universe_frozen_at,
               sfi.symbol,
               sfi.name AS seed_name,
               sfi.stage AS seed_stage,
               sfi.reason_code AS seed_reason_code,
               sfi.rank AS seed_rank,
               sfi.score_after AS seed_score,
               sfi.evidence AS seed_evidence,
               scoring.score_after AS scoring_score,
               scoring.evidence AS scoring_evidence,
               l1.evidence AS l1_evidence
          FROM candidate_seed sfi
          LEFT JOIN scoring_seed scoring ON scoring.symbol = sfi.symbol
          LEFT JOIN l1_seed l1 ON l1.symbol = sfi.symbol
         WHERE sfi.stage_preference_rank = 1
         ORDER BY COALESCE(sfi.rank, 999999), COALESCE(sfi.score_after, scoring.score_after, 0) DESC
        """,
        [run_date],
        timeout=90,
    )


def _chunks(values: list[str], size: int = D1_QUERY_SYMBOL_CHUNK) -> list[list[str]]:
    return [values[index:index + size] for index in range(0, len(values), size)]


def _core_rows(
    client: ReadOnlyD1Client,
    run_date: str,
    symbols: list[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    daily_rows: list[dict[str, Any]] = []
    stock_rows: list[dict[str, Any]] = []
    for chunk in _chunks(symbols):
        placeholders = ",".join("?" for _ in chunk)
        daily_rows.extend(client.query(
            f"""
            SELECT id, stock_id, symbol, name, sector, industry, rank, score,
                   signal, confidence, reason, watch_points, has_buy_signal,
                   current_price, foreign_net_5d, trust_net_5d, rsi14, macd_hist,
                   sector_rank, market_segment, recommendation_lane, eligible_for_ml,
                   eligible_for_pending_buy, alpha_context, alpha_allocation,
                   ml_vote_summary, score_components
              FROM daily_recommendations
             WHERE date = ? AND symbol IN ({placeholders})
            """,
            [run_date, *chunk],
            timeout=90,
        ))
        stock_rows.extend(client.query(
            f"""
            SELECT id AS stock_id, symbol, name, sector, market
              FROM stocks
             WHERE symbol IN ({placeholders})
            """,
            chunk,
            timeout=90,
        ))
    return daily_rows, stock_rows


def run_screener_seed_domain_shadow_comparison(
    *,
    run_date: str,
    legacy_rows: list[dict[str, Any]],
    ops_client: ReadOnlyD1Client | None = None,
    core_client: ReadOnlyD1Client | None = None,
) -> dict[str, Any]:
    """Compare real split-domain rows while preserving legacy rows as authority."""
    ops_reader = ops_client or shadow_client_for_domain("ops")
    core_reader = core_client or shadow_client_for_domain("core")
    ops_rows = _ops_seed_rows(ops_reader, run_date)
    symbols = sorted({str(row.get("symbol") or "").strip() for row in ops_rows if row.get("symbol")})
    daily_rows, stock_rows = _core_rows(core_reader, run_date, symbols)
    split_rows = merge_screener_seed_domains(
        ops_seed_rows=ops_rows,
        daily_rows=daily_rows,
        stock_rows=stock_rows,
        run_date=run_date,
    )
    result = compare_screener_seed_domain_results(legacy_rows, split_rows)
    return {
        **result,
        "run_date": run_date,
        "ops_seed_count": len(ops_rows),
        "core_daily_count": len(daily_rows),
        "core_stock_count": len(stock_rows),
        "authoritative_output": "legacy_unchanged",
    }
