"""FinLab API raw-factor discovery for StockVision strategy learning.

This module is read-only: it discovers candidate factor families through the
official FinLab SDK surface and returns research specs for the Worker-side
strategy-learning registry. It does not mutate production configs.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Protocol


FINLAB_AI_FACTOR_MINER_VERSION = "finlab-ai-factor-miner-v1"


class FinLabDataClientProtocol(Protocol):
    def search(self, query: str, market: str | None = None) -> Any: ...


LANE_SEARCH_TERMS: dict[str, tuple[str, ...]] = {
    "technical": (
        "RSI",
        "MACD",
        "KD",
        "moving average",
        "trend",
        "volume",
        "momentum",
        "volatility",
    ),
    "chip": (
        "foreign investor",
        "investment trust",
        "dealer",
        "institutional flow",
        "margin",
        "short interest",
        "broker flow",
        "broker",
        "margin",
    ),
    "fundamental": (
        "revenue",
        "profit",
        "ROE",
        "EPS",
        "gross margin",
        "operating margin",
        "cash flow",
        "valuation",
        "cash flow",
    ),
}


LANE_ALPHA_BUCKET = {
    "technical": "trend_following",
    "chip": "defensive_accumulation",
    "fundamental": "mean_reversion",
}


def _threshold_hint(lane: str, dataset_key: str) -> dict[str, Any]:
    text = f"{lane} {dataset_key}".lower()
    hints: dict[str, Any] = {"minPrice": 10}
    if lane == "technical":
        hints["minVolumeExpansion20"] = 0.75
        hints["minCloseAboveMa20Pct"] = -0.03
        if "rsi" in text:
            hints["minTechnicalIndicators"] = {"rsi14": 35}
    elif lane == "chip":
        hints["minForeignTrustNet5d"] = 0
    elif lane == "fundamental":
        hints["minEps"] = 0
        hints["minRoe"] = 3
        hints["maxPe"] = 80
    return hints


@dataclass(frozen=True)
class FinLabRawFactorCandidate:
    candidate_id: str
    lane: str
    query: str
    dataset_key: str
    display_name: str
    hypothesis: str
    alpha_bucket: str
    evidence_requirements: tuple[str, ...]
    promotion_status: str
    source_refs: tuple[str, ...]
    production_effect: bool = False
    strategy_spec_hint: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _slug(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9\u4e00-\u9fff]+", "_", value.lower()).strip("_")
    return text[:80] or "factor"


def _stable_candidate_id(lane: str, dataset_key: str) -> str:
    digest = hashlib.sha1(dataset_key.encode("utf-8")).hexdigest()[:10]
    return f"finlab_ai_factor_{lane}_{_slug(dataset_key)}_{digest}"


def _rows_from_search_result(result: Any) -> list[dict[str, Any]]:
    if result is None:
        return []
    if hasattr(result, "to_dict"):
        try:
            records = result.to_dict("records")
            if isinstance(records, list):
                return [row for row in records if isinstance(row, dict)]
        except TypeError:
            try:
                payload = result.to_dict()
                if isinstance(payload, dict):
                    return [payload]
            except Exception:
                return []
    if isinstance(result, list):
        rows: list[dict[str, Any]] = []
        for row in result:
            if isinstance(row, dict):
                rows.append(row)
            else:
                dataset = _clean_text(row)
                if dataset:
                    rows.append({"dataset": dataset, "display_name": dataset})
        return rows
    if isinstance(result, (tuple, set)):
        rows = []
        for row in result:
            if isinstance(row, dict):
                rows.append(row)
            else:
                dataset = _clean_text(row)
                if dataset:
                    rows.append({"dataset": dataset, "display_name": dataset})
        return rows
    if isinstance(result, dict):
        if all(isinstance(value, dict) for value in result.values()):
            rows: list[dict[str, Any]] = []
            for key, value in result.items():
                row = dict(value)
                row.setdefault("dataset", key)
                rows.append(row)
            return rows
        return [result]
    return []


def _search_finlab_data(data_client: FinLabDataClientProtocol, query: str) -> Any:
    try:
        return data_client.search(query, market="tw")
    except TypeError:
        return data_client.search(query)


def _dataset_key(row: dict[str, Any]) -> str:
    for key in ("dataset", "api_key", "key", "name", "field", "column"):
        value = _clean_text(row.get(key))
        if value:
            return value
    namespace = _clean_text(row.get("namespace"))
    field = _clean_text(row.get("field"))
    if namespace and field:
        return f"{namespace}:{field}"
    return _clean_text(row)[:120]


def _display_name(row: dict[str, Any], dataset_key: str) -> str:
    for key in ("display_name", "title", "name", "description", "zh_name"):
        value = _clean_text(row.get(key))
        if value:
            return value[:120]
    return dataset_key


def _evidence_requirements(lane: str) -> tuple[str, ...]:
    base = ["finlab_api_search", "raw_factor_mining", "strategy_hypothesis", "research_reward", "pbo", "reality_check"]
    if lane == "technical":
        base.extend(["raw_technical_indicator_mining", "price_volume_panel"])
    elif lane == "chip":
        base.extend(["raw_chip_flow", "raw_broker_flow", "crowding_check"])
    elif lane == "fundamental":
        base.extend(["raw_profitability", "raw_valuation", "no_lookahead_financial_availability"])
    return tuple(dict.fromkeys(base))


def _candidate_from_row(
    *,
    lane: str,
    query: str,
    row: dict[str, Any],
    generated_at: str,
) -> FinLabRawFactorCandidate | None:
    dataset_key = _dataset_key(row)
    if not dataset_key:
        return None
    display_name = _display_name(row, dataset_key)
    return FinLabRawFactorCandidate(
        candidate_id=_stable_candidate_id(lane, dataset_key),
        lane=lane,
        query=query,
        dataset_key=dataset_key,
        display_name=display_name,
        hypothesis=(
            f"Mine FinLab raw {lane} factor dataset '{display_name}' ({dataset_key}) "
            "as a research-only L1 strategy candidate, then validate with walk-forward reward, PBO and reality check."
        ),
        alpha_bucket=LANE_ALPHA_BUCKET.get(lane, "trend_following"),
        evidence_requirements=_evidence_requirements(lane),
        promotion_status="research",
        source_refs=(
            FINLAB_AI_FACTOR_MINER_VERSION,
            f"finlab.data.search:{query}",
            f"dataset:{dataset_key}",
            f"generated_at:{generated_at}",
        ),
        strategy_spec_hint={
            "registry_target": "strategy_spec_registry",
            "status": "research",
            "approved_for_l1": False,
            "alpha_bucket": LANE_ALPHA_BUCKET.get(lane, "trend_following"),
            "thresholds": _threshold_hint(lane, dataset_key),
            "candidate_policy": {"maxMlShare": 0},
        },
    )


def discover_finlab_raw_factor_candidates(
    *,
    finlab_data: FinLabDataClientProtocol | None = None,
    lane_search_terms: dict[str, Iterable[str]] | None = None,
    max_per_lane: int = 8,
    generated_at: str | None = None,
) -> dict[str, Any]:
    """Search official FinLab datasets and emit research-only factor candidates."""
    data_client = finlab_data
    if data_client is None:
        from finlab import data as data_client  # type: ignore

    generated_at = generated_at or _utc_now()
    max_rows = max(1, min(int(max_per_lane or 8), 30))
    terms_by_lane = lane_search_terms or LANE_SEARCH_TERMS
    candidates: list[FinLabRawFactorCandidate] = []
    errors: list[str] = []

    for lane, terms in terms_by_lane.items():
        seen: set[str] = set()
        for query in terms:
            if len(seen) >= max_rows:
                break
            try:
                rows = _rows_from_search_result(_search_finlab_data(data_client, str(query)))
            except Exception as exc:  # pragma: no cover - external SDK surface
                errors.append(f"{lane}:{query}:{str(exc)[:160]}")
                continue
            for row in rows:
                candidate = _candidate_from_row(lane=lane, query=str(query), row=row, generated_at=generated_at)
                if candidate is None or candidate.dataset_key in seen:
                    continue
                seen.add(candidate.dataset_key)
                candidates.append(candidate)
                if len(seen) >= max_rows:
                    break

    payload = {
        "version": FINLAB_AI_FACTOR_MINER_VERSION,
        "generated_at": generated_at,
        "registry_target": "strategy_spec_registry",
        "closure_ready": True,
        "production_effect": False,
        "promotion_policy": "research_only_until_strategy_learning_reward_pbo_reality_check",
        "ingestion_contract": {
            "consumer": "worker.runFinLabAiSkillDiscoveryClosure.rawFactorMinerPayload",
            "path": [
                "FinLab data.search",
                "ml-controller /finlab/ai-factor-discovery",
                "Worker finlabAiSkillDiscovery raw-factor packet builder",
                "research_experiment_registry",
                "strategy_spec_registry",
            ],
        },
        "summary": {
            "candidate_count": len(candidates),
            "lanes": sorted({candidate.lane for candidate in candidates}),
            "errors": len(errors),
        },
        "candidates": [candidate.to_dict() for candidate in candidates],
        "errors": errors,
    }
    payload["checksum"] = "sha256:" + hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return payload
