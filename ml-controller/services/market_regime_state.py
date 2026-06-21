from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Protocol


MARKET_REGIME_STATE_KEY = "market_regime_state"
LEGACY_REGIME_KEY = "ml:regime"
LEGACY_REGIME_META_KEY = "ml:regime:meta"


class RegimeKVReader(Protocol):
    def get(self, key: str) -> str | None: ...
    def get_json(self, key: str, default: Any = None) -> Any: ...


def normalize_regime_label(raw: Any) -> tuple[str, str] | None:
    text = str(raw or "").strip().lower()
    if not text:
        return None
    if text.startswith("bull"):
        return "bull_market", "bull"
    if text.startswith("bear"):
        return "bear_market", "bear"
    if text.startswith("volatile"):
        return "volatile", "volatile"
    if text.startswith("sideway"):
        return "sideways", "sideways"
    return None


def _as_float_map(raw: Any) -> dict[str, float]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, float] = {}
    for key, value in raw.items():
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            continue
        if parsed >= 0:
            out[str(key)] = parsed
    return out


def _contract_from_state(state: dict[str, Any], *, source: str) -> dict[str, Any] | None:
    normalized = normalize_regime_label(state.get("label") or state.get("regime") or state.get("family"))
    if not normalized:
        return None
    label, family = normalized
    regime_surface = _as_float_map(
        state.get("regime_surface")
        or state.get("regime_probabilities")
        or state.get("probabilities")
        or {}
    )
    if not regime_surface:
        regime_surface = {label: 1.0}
    return {
        "schema_version": "market-regime-state-v1",
        "label": label,
        "raw_label": state.get("raw_label") or label,
        "alpha_regime": family,
        "family": family,
        "source": source,
        "run_date": state.get("run_date"),
        "computed_at": state.get("computed_at") or state.get("pushed_at") or datetime.now(timezone.utc).isoformat(),
        "regime_surface": regime_surface,
        "regime_index": state.get("regime_index"),
        "hmm_state": state.get("hmm_state"),
        "label_zh": state.get("label_zh"),
        "consensus_threshold": state.get("consensus_threshold"),
        "weight_multipliers": state.get("weight_multipliers") if isinstance(state.get("weight_multipliers"), dict) else {},
        "regime_evidence": state.get("regime_evidence") if isinstance(state.get("regime_evidence"), dict) else {},
        "transition_guard": state.get("transition_guard") if isinstance(state.get("transition_guard"), dict) else {},
        "monitors": state.get("monitors") if isinstance(state.get("monitors"), dict) else {},
        "missing": False,
    }


def resolve_market_regime_contract(kv: RegimeKVReader) -> dict[str, Any]:
    current = kv.get_json(MARKET_REGIME_STATE_KEY, default={}) or {}
    if isinstance(current, dict) and current.get("schema_version") == "market-regime-state-v1":
        contract = _contract_from_state(current, source="market_regime_state")
        if contract:
            return contract

    legacy_meta = kv.get_json(LEGACY_REGIME_META_KEY, default={}) or {}
    if isinstance(legacy_meta, dict):
        contract = _contract_from_state(legacy_meta, source="legacy_meta")
        if contract:
            return contract

    raw_label = kv.get(LEGACY_REGIME_KEY)
    normalized = normalize_regime_label(raw_label)
    if normalized:
        label, family = normalized
        return {
            "schema_version": "market-regime-state-v1",
            "label": label,
            "raw_label": label,
            "alpha_regime": family,
            "family": family,
            "source": "legacy_label",
            "run_date": None,
            "computed_at": datetime.now(timezone.utc).isoformat(),
            "regime_surface": {label: 1.0},
            "regime_index": None,
            "hmm_state": None,
            "label_zh": None,
            "consensus_threshold": None,
            "weight_multipliers": {},
            "regime_evidence": {},
            "transition_guard": {},
            "monitors": {},
            "missing": False,
        }

    return {
        "schema_version": "market-regime-state-v1",
        "label": None,
        "raw_label": None,
        "alpha_regime": "unknown",
        "family": "unknown",
        "source": "missing",
        "run_date": None,
        "computed_at": None,
        "regime_surface": {},
        "regime_index": None,
        "hmm_state": None,
        "label_zh": None,
        "consensus_threshold": None,
        "weight_multipliers": {},
        "regime_evidence": {},
        "transition_guard": {},
        "monitors": {},
        "missing": True,
    }


def build_market_regime_contract_from_market_env(
    market_env: dict[str, Any] | None,
    *,
    run_date: str | None = None,
) -> dict[str, Any]:
    """Build a dated fallback contract from the already-loaded market_env.

    This is only for historical/direct controller reruns where Worker readiness
    can be bypassed and KV market_regime_state is unavailable. The source stays
    explicit so production telemetry does not mistake it for a normal HMM KV
    regime-compute result.
    """
    if not isinstance(market_env, dict) or not market_env:
        return {
            "schema_version": "market-regime-state-v1",
            "label": None,
            "raw_label": None,
            "alpha_regime": "unknown",
            "family": "unknown",
            "source": "market_env_fallback_missing",
            "run_date": run_date,
            "computed_at": None,
            "regime_surface": {},
            "regime_index": None,
            "hmm_state": None,
            "label_zh": None,
            "consensus_threshold": None,
            "weight_multipliers": {},
            "regime_evidence": {},
            "transition_guard": {},
            "monitors": {},
            "missing": True,
        }

    try:
        from services.market_regime_evidence import build_regime_evidence_pack
    except Exception:
        return {
            "schema_version": "market-regime-state-v1",
            "label": None,
            "raw_label": None,
            "alpha_regime": "unknown",
            "family": "unknown",
            "source": "market_env_fallback_unavailable",
            "run_date": run_date,
            "computed_at": None,
            "regime_surface": {},
            "regime_index": None,
            "hmm_state": None,
            "label_zh": None,
            "consensus_threshold": None,
            "weight_multipliers": {},
            "regime_evidence": {},
            "transition_guard": {},
            "monitors": {},
            "missing": True,
        }

    probe = build_regime_evidence_pack(market_env, raw_label="sideways")
    counts = probe.get("support_counts") if isinstance(probe, dict) else {}
    bearish = int((counts or {}).get("bearish") or 0)
    bullish = int((counts or {}).get("bullish") or 0)
    available = int((counts or {}).get("available") or 0)
    if available <= 0:
        return {
            "schema_version": "market-regime-state-v1",
            "label": None,
            "raw_label": None,
            "alpha_regime": "unknown",
            "family": "unknown",
            "source": "market_env_fallback_no_evidence",
            "run_date": run_date,
            "computed_at": None,
            "regime_surface": {},
            "regime_index": None,
            "hmm_state": None,
            "label_zh": None,
            "consensus_threshold": None,
            "weight_multipliers": {},
            "regime_evidence": probe if isinstance(probe, dict) else {},
            "transition_guard": {},
            "monitors": {},
            "missing": True,
        }

    if bearish >= 3 and bearish >= bullish:
        raw_label = "bear_market"
    elif bullish >= 3 and bullish > bearish:
        raw_label = "bull_market"
    elif bearish >= 2:
        raw_label = "volatile"
    else:
        raw_label = "sideways"

    evidence_pack = build_regime_evidence_pack(market_env, raw_label=raw_label)
    label = str(evidence_pack.get("effective_label") or raw_label)
    normalized = normalize_regime_label(label)
    if not normalized:
        normalized = ("sideways", "sideways")
        label = "sideways"
    normalized_label, family = normalized
    surface = {
        "bull_market": 0.0,
        "bear_market": 0.0,
        "volatile": 0.0,
        "sideways": 0.0,
    }
    surface[normalized_label] = 1.0
    return {
        "schema_version": "market-regime-state-v1",
        "label": normalized_label,
        "raw_label": raw_label,
        "alpha_regime": family,
        "family": family,
        "source": "market_env_fallback",
        "run_date": run_date,
        "computed_at": datetime.now(timezone.utc).isoformat(),
        "regime_surface": surface,
        "regime_index": None,
        "hmm_state": None,
        "label_zh": None,
        "consensus_threshold": None,
        "weight_multipliers": {},
        "regime_evidence": evidence_pack,
        "transition_guard": evidence_pack.get("transition_guard") if isinstance(evidence_pack.get("transition_guard"), dict) else {},
        "monitors": evidence_pack.get("monitors") if isinstance(evidence_pack.get("monitors"), dict) else {},
        "missing": False,
    }
