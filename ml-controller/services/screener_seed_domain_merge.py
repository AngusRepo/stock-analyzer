"""Pure OPS/Core screener-seed merge used for cutover equivalence checks."""
from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any


EMERGING_SEGMENTS = {"EMERGING", "ESB", "ROTC"}
TRADABLE_MARKETS = {"TWSE", "TSE", "LISTED", "OTC", "TPEX"}


def _context_digest(value: Any) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _merge_source_identity() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def capture_screener_seed_context(*, run_date: str, ops_seed_rows: list[dict],
                                  daily_rows: list[dict], stock_rows: list[dict],
                                  merged_rows: list[dict], read_started_at: str) -> dict:
    """Keep the actual reads, not rows reconstructed from the merged output.

    Observation time is NOT a historical PIT attestation. Cross-domain reads
    are not a database transaction; the original inputs and their observation
    interval are retained so a later verifier can check producer consistency.
    """
    packet = {
        "schema_version": "screener-seed-context-v1", "status": "captured",
        "signal_date": run_date, "source_identity": _merge_source_identity(),
        "knowledge_scope": "observed_at_capture_not_historical_asof",
        "read_started_at": read_started_at,
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "inputs": deepcopy({"ops_seed_rows": ops_seed_rows, "daily_rows": daily_rows,
                            "stock_rows": stock_rows}),
        "expected": deepcopy(merged_rows),
    }
    packet["content_checksum"] = _context_digest(packet)
    replay_screener_seed_context(packet, run_date=run_date)
    return packet


def replay_screener_seed_context(context: dict, *, run_date: str,
                                 producer_run_id: str | None = None) -> list[dict]:
    """Re-run the ORIGINAL merge without a new OPS/Core read."""
    if (not isinstance(context, dict) or context.get("schema_version") != "screener-seed-context-v1"
            or context.get("status") != "captured" or context.get("signal_date") != run_date
            or date.fromisoformat(run_date).isoformat() != run_date
            or context.get("knowledge_scope") != "observed_at_capture_not_historical_asof"
            or context.get("content_checksum") != _context_digest(
                {k: v for k, v in context.items() if k != "content_checksum"})):
        raise ValueError("screener_seed_context_invalid")
    if context.get("source_identity") != _merge_source_identity():
        raise ValueError("screener_seed_merge_source_changed")
    started = datetime.fromisoformat(context["read_started_at"].replace("Z", "+00:00"))
    observed = datetime.fromisoformat(context["observed_at"].replace("Z", "+00:00"))
    if (started.tzinfo is None or observed.tzinfo is None
            or not started <= observed <= datetime.now(timezone.utc)):
        raise ValueError("screener_seed_context_time_invalid")
    inputs = context.get("inputs")
    if (not isinstance(inputs, dict) or set(inputs) != {"ops_seed_rows", "daily_rows", "stock_rows"}
            or any(not isinstance(rows, list) or any(not isinstance(r, dict) for r in rows)
                   for rows in inputs.values())):
        raise ValueError("screener_seed_context_inputs_invalid")
    runs = {row.get("screener_run_id") for row in inputs["ops_seed_rows"]}
    if len(runs) > 1 or (producer_run_id and runs != {producer_run_id}):
        raise ValueError("screener_seed_context_producer_mismatch")
    result = merge_screener_seed_domains(run_date=run_date, **deepcopy(inputs))
    # Exact whole-row comparison also binds Route contrast, ordering and fields
    # not covered by the legacy migration comparator's abbreviated field list.
    if _context_digest(result) != _context_digest(context.get("expected")):
        raise ValueError("screener_seed_merge_replay_mismatch")
    return result


def verify_canonical_seed_boundary(population: dict, context: dict) -> dict:
    """Reconcile original canonical funnel items with the ACTUAL OPS reads.

    Raw scoring is common upstream evidence, not a candidate's post-calibration
    replacement. Selection evidence here verifies the incumbent only; candidate
    selection must come from that candidate's own post-route replay.
    """
    run_date, producer = population['signal_date'], population['producer_run_id']
    replay_screener_seed_context(context, run_date=run_date, producer_run_id=producer)
    source = population.get('screener_seed_source')
    if (not isinstance(source, dict) or source.get('schema_version') != 'atomic-screener-seed-source-v1'
            or not isinstance(source.get('items'), list)
            or type(source.get('source_item_count')) is not int
            or source['source_item_count'] < len(source['items'])):
        raise ValueError('atomic_canonical_screener_seed_source_missing')
    by_symbol: dict[str, list[dict]] = {}
    for item in source['items']:
        if (not isinstance(item, dict) or not isinstance(item.get('symbol'), str)
                or not item['symbol'] or item['symbol'] != item['symbol'].strip()
                or (item.get('stage'), item.get('decision')) not in {
                    ('scoring', 'pass'), ('l1_candidate_seed_after_overlay', 'selected'),
                    ('final_selection', 'selected')}):
            raise ValueError('atomic_canonical_funnel_item_invalid')
        by_symbol.setdefault(item['symbol'], []).append(item)

    def selected(rows: list[dict], stage: str) -> dict | None:
        matches = [row for row in rows if row['stage'] == stage]
        if not matches:
            return None
        rank = min(_sort_number(row.get('rank'), 999999) for row in matches)
        tied = [row for row in matches if _sort_number(row.get('rank'), 999999) == rank]
        # Original SQL uses created_at for tied scoring/L1 rows. Canonical items
        # do not carry that D1 timestamp: do not invent it or pick a lucky row.
        if len({_context_digest(row) for row in tied}) > 1:
            raise ValueError('atomic_canonical_funnel_tie_timestamp_missing')
        return tied[0]

    actual = context['inputs']['ops_seed_rows']
    cutoffs = {row.get('decision_universe_frozen_at') for row in actual}
    if len(cutoffs) > 1:
        raise ValueError('atomic_canonical_seed_cutoff_ambiguous')
    cutoff = next(iter(cutoffs), None)
    replayed = []
    for symbol, rows in by_symbol.items():
        l1 = selected(rows, 'l1_candidate_seed_after_overlay')
        seed = l1 or selected(rows, 'final_selection')
        if seed is None:
            continue
        scoring = selected(rows, 'scoring') or {}
        replayed.append({
            'screener_run_id': producer, 'decision_universe_frozen_at': cutoff,
            'symbol': symbol, 'seed_name': seed.get('name'), 'seed_stage': seed['stage'],
            'seed_reason_code': seed.get('reasonCode'), 'seed_rank': seed.get('rank'),
            'seed_score': seed.get('scoreAfter'), 'seed_evidence': seed.get('evidence'),
            'scoring_score': scoring.get('scoreAfter'), 'scoring_evidence': scoring.get('evidence'),
            'l1_evidence': l1.get('evidence') if l1 else None,
        })

    def normalized(rows):
        return [{key: _canonical_json_value(value) for key, value in row.items()}
                for row in sorted(rows, key=lambda row: row['symbol'])]

    if _context_digest(normalized(actual)) != _context_digest(normalized(replayed)):
        raise ValueError('atomic_canonical_ops_seed_boundary_mismatch')
    return {'status': 'matched', 'canonical_artifact_id': population['canonical_artifact_id'],
        'canonical_artifact_checksum': population['canonical_artifact_checksum'],
        'screener_seed_context_checksum': context['content_checksum'],
        'ops_seed_count': len(actual), 'raw_scoring_symbol_count': sum(
            any(row['stage'] == 'scoring' for row in rows) for rows in by_symbol.values())}


def _coalesce(*values: Any) -> Any:
    return next((value for value in values if value is not None), None)


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _json_extract_value(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        # Outer snapshot JSON sorts object keys. Make embedded JSON equally
        # deterministic so a gzip/JSON round trip cannot change merge output.
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return value


def _sort_number(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def merge_screener_seed_domains(
    *,
    ops_seed_rows: list[dict[str, Any]],
    daily_rows: list[dict[str, Any]],
    stock_rows: list[dict[str, Any]],
    run_date: str,
) -> list[dict[str, Any]]:
    """Reproduce the legacy cross-domain SQL result without cross-database joins."""
    daily_by_symbol = {
        str(row.get("symbol") or "").strip(): row
        for row in daily_rows
        if str(row.get("symbol") or "").strip()
    }
    stock_by_symbol = {
        str(row.get("symbol") or "").strip(): row
        for row in stock_rows
        if str(row.get("symbol") or "").strip()
    }
    merged: list[dict[str, Any]] = []

    for seed in ops_seed_rows:
        symbol = str(seed.get("symbol") or "").strip()
        if not symbol:
            continue
        daily = daily_by_symbol.get(symbol, {})
        stock = stock_by_symbol.get(symbol, {})
        stock_id = _coalesce(daily.get("stock_id"), stock.get("stock_id"))
        if stock_id is None:
            continue

        seed_evidence = _json_object(seed.get("seed_evidence"))
        scoring_evidence = _json_object(seed.get("scoring_evidence"))
        l1_evidence = _json_object(seed.get("l1_evidence"))
        taxonomy = scoring_evidence.get("taxonomy")
        taxonomy = taxonomy if isinstance(taxonomy, dict) else {}
        market_segment = _coalesce(
            daily.get("market_segment"),
            seed_evidence.get("market_segment"),
            l1_evidence.get("market_segment"),
            stock.get("market"),
            "LISTED",
        )
        stock_market = str(stock.get("market") or "").upper()
        default_lane = (
            "tradable"
            if stock_market in TRADABLE_MARKETS
            else "emerging_watchlist"
            if stock_market in EMERGING_SEGMENTS
            else "research_only"
        )
        recommendation_lane = _coalesce(daily.get("recommendation_lane"), default_lane)
        if recommendation_lane == "emerging_watchlist":
            continue
        if str(market_segment or "").upper() in EMERGING_SEGMENTS:
            continue

        merged.append({
            "id": daily.get("id"),
            "screener_run_id": seed.get("screener_run_id"),
            "decision_universe_frozen_at": seed.get("decision_universe_frozen_at"),
            # Preserve the whole per-run PIT contrast, never reconstruct its
            # missing half from mutable Core recommendation score_components.
            "l15_route_source": {
                "schema_version": "l15-route-source-v1",
                "signal_date": run_date,
                "screener_run_id": seed.get("screener_run_id"),
                "decision_universe_frozen_at": seed.get("decision_universe_frozen_at"),
                "l1_contrast": deepcopy(l1_evidence.get("l15_route_contrast")),
                "seed_contrast": deepcopy(seed_evidence.get("l15_route_contrast")),
            } if "l15_route_contrast" in l1_evidence or "l15_route_contrast" in seed_evidence else None,
            "date": run_date,
            "stock_id": stock_id,
            "symbol": symbol,
            "name": _coalesce(daily.get("name"), seed.get("seed_name"), stock.get("name"), symbol),
            "sector": _coalesce(daily.get("sector"), stock.get("sector")),
            "industry": _coalesce(
                daily.get("industry"),
                taxonomy.get("industry"),
                l1_evidence.get("industry"),
                stock.get("sector"),
            ),
            "rank": _coalesce(seed.get("seed_rank"), daily.get("rank"), 999999),
            "score": _coalesce(seed.get("seed_score"), daily.get("score"), seed.get("scoring_score"), 0),
            "signal": daily.get("signal"),
            "confidence": daily.get("confidence"),
            "reason": _coalesce(
                daily.get("reason"),
                l1_evidence.get("strategy_pool_reason"),
                seed.get("seed_reason_code"),
                "screener candidate seed",
            ),
            "watch_points": _coalesce(
                daily.get("watch_points"),
                json.dumps(
                    [
                        f"screener_seed:{seed.get('seed_stage')}",
                        f"screener_run:{seed.get('screener_run_id')}",
                    ],
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            ),
            "has_buy_signal": _coalesce(daily.get("has_buy_signal"), 0),
            "current_price": daily.get("current_price"),
            "foreign_net_5d": daily.get("foreign_net_5d"),
            "trust_net_5d": daily.get("trust_net_5d"),
            "rsi14": daily.get("rsi14"),
            "macd_hist": daily.get("macd_hist"),
            "sector_rank": daily.get("sector_rank"),
            "market_segment": market_segment,
            "recommendation_lane": recommendation_lane,
            "eligible_for_ml": _coalesce(daily.get("eligible_for_ml"), 1),
            "eligible_for_pending_buy": _coalesce(daily.get("eligible_for_pending_buy"), 0),
            "alpha_context": daily.get("alpha_context"),
            "alpha_allocation": daily.get("alpha_allocation"),
            "ml_vote_summary": daily.get("ml_vote_summary"),
            "score_components": _json_extract_value(
                _coalesce(scoring_evidence.get("score_components"), daily.get("score_components"))
            ),
        })

    return sorted(
        merged,
        key=lambda row: (
            _sort_number(row.get("rank"), 999999),
            -_sort_number(row.get("score"), 0),
        ),
    )


SCREENER_SEED_EQUIVALENCE_FIELDS = (
    "id",
    "screener_run_id",
    "decision_universe_frozen_at",
    "date",
    "stock_id",
    "symbol",
    "name",
    "sector",
    "industry",
    "rank",
    "score",
    "signal",
    "confidence",
    "reason",
    "watch_points",
    "has_buy_signal",
    "current_price",
    "foreign_net_5d",
    "trust_net_5d",
    "rsi14",
    "macd_hist",
    "sector_rank",
    "market_segment",
    "recommendation_lane",
    "eligible_for_ml",
    "eligible_for_pending_buy",
    "alpha_context",
    "alpha_allocation",
    "ml_vote_summary",
    "score_components",
)


def _canonical_json_value(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    stripped = value.strip()
    if not stripped or stripped[0] not in "[{":
        return value
    try:
        return json.loads(stripped)
    except (TypeError, ValueError):
        return value


def _canonical_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        field: _canonical_json_value(row.get(field))
        for field in SCREENER_SEED_EQUIVALENCE_FIELDS
    }


def _row_digest(row: dict[str, Any]) -> str:
    payload = json.dumps(_canonical_row(row), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def compare_screener_seed_domain_results(
    legacy_rows: list[dict[str, Any]],
    split_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    """Compare legacy cross-domain SQL and split merge output without mutating either."""
    legacy_by_symbol = {
        str(row.get("symbol") or "").strip(): row
        for row in legacy_rows
        if str(row.get("symbol") or "").strip()
    }
    split_by_symbol = {
        str(row.get("symbol") or "").strip(): row
        for row in split_rows
        if str(row.get("symbol") or "").strip()
    }
    symbols = sorted(set(legacy_by_symbol) | set(split_by_symbol))
    missing_from_split = [symbol for symbol in symbols if symbol not in split_by_symbol]
    unexpected_in_split = [symbol for symbol in symbols if symbol not in legacy_by_symbol]
    mismatches: list[dict[str, Any]] = []
    for symbol in symbols:
        legacy = legacy_by_symbol.get(symbol)
        split = split_by_symbol.get(symbol)
        if legacy is None or split is None:
            continue
        differing_fields = [
            field
            for field in SCREENER_SEED_EQUIVALENCE_FIELDS
            if _canonical_json_value(legacy.get(field)) != _canonical_json_value(split.get(field))
        ]
        if differing_fields:
            mismatches.append({
                "symbol": symbol,
                "fields": differing_fields,
                "legacy_digest": _row_digest(legacy),
                "split_digest": _row_digest(split),
            })
    status = "pass" if not missing_from_split and not unexpected_in_split and not mismatches else "fail"
    return {
        "schema_version": "screener-seed-domain-equivalence-v1",
        "status": status,
        "legacy_count": len(legacy_rows),
        "split_count": len(split_rows),
        "missing_from_split": missing_from_split,
        "unexpected_in_split": unexpected_in_split,
        "mismatches": mismatches,
    }
