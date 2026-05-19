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
