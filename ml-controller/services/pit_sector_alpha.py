"""Point-in-time sector alpha evidence shared by L4 and Fusion.

The expert intentionally emits learned-model features rather than a hardcoded
expected return. Artifact builders decide whether the evidence adds OOS edge.
"""
from __future__ import annotations

import hashlib
import json
import math
from collections import defaultdict
from datetime import datetime, timezone
from statistics import pstdev
from typing import Any, Callable

from services.fusion_market_context import market_context_feature_values


SCHEMA_VERSION = "pit-sector-alpha-expert-v1"
FEATURE_SEMANTIC_VERSION = "pit-sector-alpha-prior-completed-cross-layer-rank-v1"
SECTOR_FLOW_PIT_LINEAGE_VERSION = "sector-flow-pit-v1"
MAX_SOURCE_SESSION_LAG = 1
LAYERS = ("industry", "industry_theme", "subindustry", "theme")
TAG_TYPE_TO_CLASSIFICATION = {
    "industry": "industry",
    "industry_theme": "industry_theme",
    "subindustry": "subindustry",
    "concept": "theme",
}
SECTOR_ALPHA_FEATURE_NAMES = [
    "sector_alpha_available",
    "sector_formal_rs_rank",
    "sector_thematic_rs_rank",
    "sector_rs_consensus",
    "sector_momentum_consensus",
    "sector_rotation_consensus",
    "sector_flow_consensus",
    "sector_cross_layer_dispersion",
    "sector_breadth_balance",
    "sector_breadth_available",
    "sector_participation_acceleration",
    "sector_participation_available",
    "sector_membership_coverage",
    "sector_defensive_rs_interaction",
]

QueryFn = Callable[[str, list[Any]], list[dict[str, Any]]]


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _loads(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _centered_percentile(values_by_key: dict[tuple[str, str], float]) -> dict[tuple[str, str], float]:
    by_layer: dict[str, list[tuple[tuple[str, str], float]]] = defaultdict(list)
    for key, value in values_by_key.items():
        by_layer[key[0]].append((key, value))
    out: dict[tuple[str, str], float] = {}
    for rows in by_layer.values():
        ordered = sorted(rows, key=lambda item: (item[1], item[0][1]))
        if len(ordered) == 1:
            out[ordered[0][0]] = 0.0
            continue
        index = 0
        while index < len(ordered):
            end = index + 1
            while end < len(ordered) and ordered[end][1] == ordered[index][1]:
                end += 1
            average_rank = (index + end - 1) / 2.0
            centered = (average_rank / (len(ordered) - 1)) * 2.0 - 1.0
            for cursor in range(index, end):
                out[ordered[cursor][0]] = centered
            index = end
    return out


def _chunked(values: list[str], size: int = 80) -> list[list[str]]:
    return [values[index:index + size] for index in range(0, len(values), size)]


def _knowledge_cutoff(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _membership_rows(
    query_fn: QueryFn,
    *,
    signal_date: str,
    symbols: list[str],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for chunk in _chunked(symbols):
        placeholders = ",".join("?" for _ in chunk)
        rows.extend(query_fn(
            f"""
            SELECT symbol, tag, tag_type, source, weight, as_of_date
              FROM finlab_taxonomy_tags
             WHERE symbol IN ({placeholders})
               AND tag_type IN ('industry','industry_theme','subindustry')
               AND date(as_of_date)<=date(?)
             ORDER BY symbol, tag_type, tag, date(as_of_date) DESC
            """,
            [*chunk, signal_date],
        ))
        rows.extend(query_fn(
            f"""
            SELECT symbol, tag, tag_type, source, weight,
                   substr(updated_at,1,10) as_of_date
              FROM stock_tags
             WHERE symbol IN ({placeholders})
               AND tag_type IN ('industry','industry_theme','subindustry','concept')
               AND datetime(updated_at)<datetime(?, '+1 day')
             ORDER BY symbol, tag_type, tag, datetime(updated_at) DESC
            """,
            [*chunk, signal_date],
        ))
    return rows


def unavailable_sector_alpha(signal_date: str, reason: str) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "feature_semantic_version": FEATURE_SEMANTIC_VERSION,
        "status": "unavailable",
        "signal_date": str(signal_date)[:10],
        "source_date": None,
        "source_available_at": None,
        "source_session_lag": None,
        "knowledge_cutoff": None,
        "point_in_time": False,
        "producer_position": "post_recommendation_for_next_decision_session",
        "candidate_set_mutation_allowed": False,
        "memberships": [],
        "layers": {},
        "features": {
            name: 0.0 for name in SECTOR_ALPHA_FEATURE_NAMES
            if name != "sector_defensive_rs_interaction"
        },
        "blockers": [reason],
    }


def load_pit_sector_alpha_experts(
    query_fn: QueryFn,
    *,
    signal_date: str,
    symbols: list[str],
    fallback_industry_by_symbol: dict[str, str] | None = None,
    knowledge_cutoff: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Load the latest completed pre-decision sector snapshot for a symbol batch.

    The producer runs after recommendation. A decision may only consume a
    strictly earlier session whose latest mutation predates the frozen slate.
    """
    signal_day = str(signal_date)[:10]
    normalized_symbols = sorted({str(symbol).strip() for symbol in symbols if str(symbol).strip()})
    if not signal_day or not normalized_symbols:
        return {}

    cutoff = _knowledge_cutoff(knowledge_cutoff)
    if cutoff is None:
        return {
            symbol: unavailable_sector_alpha(signal_day, "knowledge_cutoff_missing_or_invalid")
            for symbol in normalized_symbols
        }

    source_rows = query_fn(
        """
        SELECT date,
               MAX(COALESCE(updated_at, created_at)) AS source_available_at,
               COUNT(*) AS source_row_count,
               COUNT(DISTINCT classification) AS source_layer_count
          FROM sector_flow
         WHERE date < ?
           AND classification IN ('industry','industry_theme','subindustry','theme')
           AND pit_lineage_version = ?
           AND datetime(COALESCE(updated_at, created_at)) <= datetime(?)
         GROUP BY date
         ORDER BY date DESC
         LIMIT 1
        """,
        [signal_day, SECTOR_FLOW_PIT_LINEAGE_VERSION, cutoff],
    )
    source_meta = dict(source_rows[0]) if source_rows else {}
    source_date = str(source_meta.get("date") or "")[:10]
    source_available_at = str(source_meta.get("source_available_at") or "").strip()
    source_row_count = int(source_meta.get("source_row_count") or 0)
    source_layer_count = int(source_meta.get("source_layer_count") or 0)
    if not source_date or not source_available_at:
        return {
            symbol: unavailable_sector_alpha(signal_day, "prior_completed_sector_flow_missing")
            for symbol in normalized_symbols
        }

    lag_rows = query_fn(
        """
        SELECT COUNT(DISTINCT date) AS source_session_lag
          FROM market_risk
         WHERE date > ?
           AND date <= ?
           AND twii_close IS NOT NULL
        """,
        [source_date, signal_day],
    )
    source_session_lag = int((lag_rows[0] if lag_rows else {}).get("source_session_lag") or 0)
    if source_session_lag != MAX_SOURCE_SESSION_LAG:
        reason = (
            "source_session_lag_unverifiable"
            if source_session_lag <= 0
            else f"source_session_lag_exceeded:{source_session_lag}"
        )
        return {
            symbol: unavailable_sector_alpha(signal_day, reason)
            for symbol in normalized_symbols
        }

    flow_rows = query_fn(
        """
        SELECT date, sector, classification, rs_ratio, rs_momentum,
               rotation_score, rotation_regime, total_net,
               stock_count, up_count, turnover_share_delta,
               COALESCE(updated_at, created_at) AS source_available_at,
               pit_lineage_version
          FROM sector_flow
         WHERE date = ?
           AND classification IN ('industry','industry_theme','subindustry','theme')
           AND pit_lineage_version = ?
           AND datetime(COALESCE(updated_at, created_at)) <= datetime(?)
        """,
        [source_date, SECTOR_FLOW_PIT_LINEAGE_VERSION, cutoff],
    )
    flow_rows = [
        dict(row) for row in flow_rows
        if str(row.get("date") or "")[:10] == source_date
        and str(row.get("classification") or "") in LAYERS
        and str(row.get("sector") or "").strip()
        and str(row.get("pit_lineage_version") or "") == SECTOR_FLOW_PIT_LINEAGE_VERSION
    ]
    if not flow_rows:
        return {
            symbol: unavailable_sector_alpha(signal_day, "prior_completed_sector_flow_rows_missing")
            for symbol in normalized_symbols
        }

    flow_by_key = {
        (str(row["classification"]), str(row["sector"]).strip()): row
        for row in flow_rows
    }
    metric_ranks: dict[str, dict[tuple[str, str], float]] = {}
    for metric in ("rs_ratio", "rs_momentum", "rotation_score", "total_net"):
        raw = {
            key: value
            for key, row in flow_by_key.items()
            if (value := _finite(row.get(metric))) is not None
        }
        metric_ranks[metric] = _centered_percentile(raw)

    memberships_by_symbol: dict[str, list[dict[str, Any]]] = defaultdict(list)
    seen_memberships: set[tuple[str, str, str]] = set()
    for row in _membership_rows(
        query_fn,
        signal_date=signal_day,
        symbols=normalized_symbols,
    ):
        symbol = str(row.get("symbol") or "").strip()
        tag = str(row.get("tag") or "").strip()
        classification = TAG_TYPE_TO_CLASSIFICATION.get(str(row.get("tag_type") or "").strip())
        as_of_date = str(row.get("as_of_date") or "")[:10]
        key = (symbol, classification or "", tag)
        if (
            symbol not in normalized_symbols
            or not classification
            or not tag
            or not as_of_date
            or as_of_date > signal_day
            or key in seen_memberships
        ):
            continue
        seen_memberships.add(key)
        memberships_by_symbol[symbol].append({
            "classification": classification,
            "sector": tag,
            "source": str(row.get("source") or "unknown"),
            "as_of_date": as_of_date,
            "weight": _finite(row.get("weight")) or 1.0,
        })

    fallback_industry_by_symbol = fallback_industry_by_symbol or {}
    for symbol in normalized_symbols:
        fallback = str(fallback_industry_by_symbol.get(symbol) or "").strip()
        if not fallback or any(item["classification"] == "industry" for item in memberships_by_symbol[symbol]):
            continue
        memberships_by_symbol[symbol].append({
            "classification": "industry",
            "sector": fallback,
            "source": "candidate_recorded_point_in_time_industry",
            "as_of_date": signal_day,
            "weight": 1.0,
        })

    experts: dict[str, dict[str, Any]] = {}
    for symbol in normalized_symbols:
        matched: list[dict[str, Any]] = []
        layer_metrics: dict[str, dict[str, list[float]]] = {}
        for membership in memberships_by_symbol[symbol]:
            key = (membership["classification"], membership["sector"])
            flow = flow_by_key.get(key)
            if flow is None:
                continue
            metric = {
                "rs_rank": metric_ranks["rs_ratio"].get(key, 0.0),
                "momentum_rank": metric_ranks["rs_momentum"].get(key, 0.0),
                "rotation_rank": metric_ranks["rotation_score"].get(key, 0.0),
                "flow_rank": metric_ranks["total_net"].get(key, 0.0),
            }
            stock_count = _finite(flow.get("stock_count"))
            up_count = _finite(flow.get("up_count"))
            if stock_count is not None and stock_count > 0 and up_count is not None:
                metric["breadth_balance"] = max(-1.0, min(1.0, (up_count / stock_count) * 2.0 - 1.0))
            participation = _finite(flow.get("turnover_share_delta"))
            if participation is not None:
                metric["participation_acceleration"] = participation
            matched.append({**membership, "rotation_regime": flow.get("rotation_regime")})
            layer_metrics.setdefault(membership["classification"], defaultdict(list))
            for name, value in metric.items():
                layer_metrics[membership["classification"]][name].append(float(value))

        collapsed_layers: dict[str, dict[str, float]] = {
            layer: {name: _mean(values) for name, values in metrics.items()}
            for layer, metrics in layer_metrics.items()
        }
        if not collapsed_layers:
            experts[symbol] = unavailable_sector_alpha(signal_day, "point_in_time_membership_not_matched")
            continue

        def layer_values(metric: str, *, thematic_only: bool = False) -> list[float]:
            return [
                float(values[metric])
                for layer, values in collapsed_layers.items()
                if metric in values and (not thematic_only or layer != "industry")
            ]

        rs_values = layer_values("rs_rank")
        thematic_rs = layer_values("rs_rank", thematic_only=True)
        breadth_values = layer_values("breadth_balance")
        participation_values = layer_values("participation_acceleration")
        features = {
            "sector_alpha_available": 1.0,
            "sector_formal_rs_rank": float((collapsed_layers.get("industry") or {}).get("rs_rank") or 0.0),
            "sector_thematic_rs_rank": _mean(thematic_rs),
            "sector_rs_consensus": _mean(rs_values),
            "sector_momentum_consensus": _mean(layer_values("momentum_rank")),
            "sector_rotation_consensus": _mean(layer_values("rotation_rank")),
            "sector_flow_consensus": _mean(layer_values("flow_rank")),
            "sector_cross_layer_dispersion": pstdev(rs_values) if len(rs_values) > 1 else 0.0,
            "sector_breadth_balance": _mean(breadth_values),
            "sector_breadth_available": 1.0 if breadth_values else 0.0,
            "sector_participation_acceleration": _mean(participation_values),
            "sector_participation_available": 1.0 if participation_values else 0.0,
            "sector_membership_coverage": len(collapsed_layers) / len(LAYERS),
        }
        checksum_payload = {
            "signal_date": signal_day,
            "source_date": source_date,
            "source_available_at": source_available_at,
            "source_row_count": source_row_count,
            "source_layer_count": source_layer_count,
            "knowledge_cutoff": cutoff,
            "symbol": symbol,
            "memberships": sorted(matched, key=lambda item: (item["classification"], item["sector"])),
            "layers": collapsed_layers,
        }
        experts[symbol] = {
            "schema_version": SCHEMA_VERSION,
            "feature_semantic_version": FEATURE_SEMANTIC_VERSION,
            "status": "loaded",
            "signal_date": signal_day,
            "source_date": source_date,
            "source_available_at": source_available_at,
            "source_session_lag": source_session_lag,
            "source_row_count": source_row_count,
            "source_layer_count": source_layer_count,
            "knowledge_cutoff": cutoff,
            "point_in_time": True,
            "source": "sector_flow_prior_completed_snapshot_plus_asof_taxonomy",
            "source_lineage_version": SECTOR_FLOW_PIT_LINEAGE_VERSION,
            "producer_position": "post_recommendation_for_next_decision_session",
            "candidate_set_mutation_allowed": False,
            "application_scope": "late_l4_fusion_feature_only",
            "memberships": matched,
            "layers": collapsed_layers,
            "features": features,
            "checksum": "sha256:" + hashlib.sha256(
                json.dumps(checksum_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest(),
            "blockers": [],
        }
    return experts

def load_pit_sector_alpha_experts_by_key(
    query_fn: QueryFn,
    rows: list[dict[str, Any]],
) -> dict[tuple[str, str], dict[str, Any]]:
    """Load multi-date PIT experts without sharing evidence across dates."""
    rows_by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        signal_date = str(
            row.get("prediction_date")
            or row.get("snapshot_date")
            or row.get("recommendation_date")
            or row.get("date")
            or ""
        )[:10]
        symbol = str(row.get("symbol") or "").strip()
        if signal_date and symbol:
            rows_by_date[signal_date].append(row)

    out: dict[tuple[str, str], dict[str, Any]] = {}
    for signal_date, date_rows in sorted(rows_by_date.items()):
        cutoffs = sorted({
            cutoff
            for row in date_rows
            if (cutoff := _knowledge_cutoff(
                row.get("decision_universe_frozen_at")
                or row.get("prediction_generated_at")
                or row.get("generated_at")
            ))
        })
        if not cutoffs:
            out.update({
                (signal_date, str(row.get("symbol") or "").strip()): unavailable_sector_alpha(
                    signal_date,
                    "historical_knowledge_cutoff_missing",
                )
                for row in date_rows
                if str(row.get("symbol") or "").strip()
            })
            continue
        fallback_industries = {
            str(row.get("symbol") or "").strip(): str(
                row.get("industry") or row.get("sector") or ""
            ).strip()
            for row in date_rows
            if str(row.get("symbol") or "").strip()
        }
        experts = load_pit_sector_alpha_experts(
            query_fn,
            signal_date=signal_date,
            symbols=[str(row.get("symbol") or "") for row in date_rows],
            fallback_industry_by_symbol=fallback_industries,
            knowledge_cutoff=cutoffs[0],
        )
        out.update({(signal_date, symbol): expert for symbol, expert in experts.items()})
    return out

def sector_alpha_feature_values(row: dict[str, Any]) -> dict[str, float]:
    alpha_context = _loads(row.get("alpha_context"))
    expert = row.get("pit_sector_alpha_expert")
    if not isinstance(expert, dict):
        expert = alpha_context.get("pit_sector_alpha_expert")
    payload = expert if isinstance(expert, dict) else {}
    raw_features = payload.get("features") if isinstance(payload.get("features"), dict) else {}
    values = {
        name: float(_finite(raw_features.get(name)) or 0.0)
        for name in SECTOR_ALPHA_FEATURE_NAMES
        if name != "sector_defensive_rs_interaction"
    }
    market_features = market_context_feature_values(row, l4_value=None)
    values["sector_defensive_rs_interaction"] = (
        values["sector_rs_consensus"]
        * float(market_features.get("regime_defensive_probability") or 0.0)
    )
    if payload.get("status") != "loaded" or payload.get("point_in_time") is not True:
        values = {name: 0.0 for name in SECTOR_ALPHA_FEATURE_NAMES}
    return values
