from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any


ML_THRESHOLD_POLICY_KV_KEY = "ml:threshold_policy:champion"
ML_THRESHOLD_POLICY_SNAPSHOT_PREFIX = "ml:threshold_policy:snapshot:"
SCHEMA_VERSION = "ml-threshold-policy-v1"
PROMOTED_STATUSES = {"champion", "promoted", "active", "approved"}
BLOCKED_STATUSES = {"candidate", "shadow", "draft", "failed", "archived", "rejected"}
REQUIRED_VALIDATION_EVIDENCE = (
    "walk_forward_oos",
    "cpcv_pbo",
    "regime_segments",
    "twse_otc_segments",
    "turnover_capacity",
    "collapse_guard",
)
DELTA_CAP_MIN = 0.0
DELTA_CAP_MAX = 0.10
ADAPTIVE_OVERLAY_MAX_AGE_DAYS = int(os.getenv("ML_THRESHOLD_POLICY_ADAPTIVE_MAX_AGE_DAYS", "7"))


class ThresholdPolicyError(RuntimeError):
    pass


@dataclass(frozen=True)
class ResolvedThresholdPolicy:
    policy_id: str
    version: str
    status: str
    source: str
    selected_regime: str
    run_date: str
    base_thresholds: dict[str, float]
    thresholds: dict[str, float]
    delta_cap: float
    adaptive_overlay: dict[str, Any]
    validation_evidence: dict[str, Any]
    selector: dict[str, Any]
    evidence_hash: str

    def ensemble_config(self, ev2_cfg: dict | None = None) -> dict[str, Any]:
        cfg = dict(ev2_cfg or {})
        cfg.update(self.thresholds)
        cfg["mlThresholdPolicy"] = self.evidence()
        return cfg

    def evidence(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "policy_id": self.policy_id,
            "version": self.version,
            "status": self.status,
            "source": self.source,
            "run_date": self.run_date,
            "selected_regime": self.selected_regime,
            "selector": self.selector,
            "base_thresholds": self.base_thresholds,
            "thresholds": self.thresholds,
            "delta_cap": self.delta_cap,
            "adaptive_overlay": self.adaptive_overlay,
            "validation_evidence": self.validation_evidence,
            "evidence_hash": self.evidence_hash,
        }


def _clipped(value: float) -> float:
    return max(0.01, min(0.99, float(value)))


def _as_float(value: Any, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if math.isfinite(parsed) else default


def _parse_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text).date()
    except ValueError:
        pass
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def _date_text(value: Any) -> str | None:
    parsed = _parse_date(value)
    return parsed.isoformat() if parsed else None


def _hash_payload(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def normalize_policy_regime(raw: Any) -> str:
    text = str(raw or "").strip().lower()
    if "bull" in text:
        return "bull"
    if "bear" in text:
        return "bear"
    if "vol" in text:
        return "volatile"
    if "side" in text or "range" in text or "chop" in text:
        return "sideways"
    if "uncertain" in text or "unknown" in text:
        return "uncertain"
    if text in {"default", "global"}:
        return text
    return "uncertain"


def _regime_confidence(regime_contract: dict[str, Any] | None) -> float | None:
    surface = (regime_contract or {}).get("regime_surface")
    if not isinstance(surface, dict) or not surface:
        return None
    values: list[float] = []
    for value in surface.values():
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(parsed):
            values.append(parsed)
    return max(values) if values else None


def _policy_thresholds(policy: dict[str, Any]) -> dict[str, float]:
    thresholds = policy.get("thresholds") if isinstance(policy.get("thresholds"), dict) else policy
    out = {
        "strongBuyThreshold": _as_float(
            thresholds.get("strongBuyThreshold", thresholds.get("strong_buy_threshold")),
            0.85,
        ),
        "buyThreshold": _as_float(
            thresholds.get("buyThreshold", thresholds.get("buy_threshold")),
            0.70,
        ),
        "sellThreshold": _as_float(
            thresholds.get("sellThreshold", thresholds.get("sell_threshold")),
            0.30,
        ),
        "strongSellThreshold": _as_float(
            thresholds.get("strongSellThreshold", thresholds.get("strong_sell_threshold")),
            0.15,
        ),
    }
    strong_sell = out["strongSellThreshold"]
    sell = out["sellThreshold"]
    buy = out["buyThreshold"]
    strong_buy = out["strongBuyThreshold"]
    if not (0.0 < strong_sell <= sell < buy <= strong_buy < 1.0):
        raise ThresholdPolicyError(
            "ml_threshold_policy invalid threshold ordering: "
            f"strongSell={strong_sell} sell={sell} buy={buy} strongBuy={strong_buy}"
        )
    return {key: round(_clipped(value), 4) for key, value in out.items()}


def _policy_delta_cap(policy: dict[str, Any]) -> float:
    raw = policy.get("delta_cap", policy.get("deltaCap"))
    if raw is None:
        raise ThresholdPolicyError("ml_threshold_policy missing delta_cap artifact parameter")
    value = _as_float(raw, float("nan"))
    if not math.isfinite(value):
        raise ThresholdPolicyError("ml_threshold_policy delta_cap must be finite")
    value = abs(value)
    if value < DELTA_CAP_MIN or value > DELTA_CAP_MAX:
        raise ThresholdPolicyError(
            f"ml_threshold_policy delta_cap out of range: {value}; allowed=0..{DELTA_CAP_MAX}"
        )
    return round(value, 4)


def _extract_adaptive_delta(adaptive_params: dict[str, Any] | None) -> tuple[float, dict[str, Any]]:
    params = adaptive_params if isinstance(adaptive_params, dict) else {}
    components = params.get("threshold_components")
    if isinstance(components, dict) and components.get("effective_delta") is not None:
        return _as_float(components.get("effective_delta"), 0.0), {
            "source": "threshold_components.effective_delta",
            "components": components,
        }
    return _as_float(params.get("confidence_delta"), 0.0), {
        "source": "confidence_delta_legacy",
        "components": None,
    }


def _adaptive_computed_date(adaptive_params: dict[str, Any] | None) -> date | None:
    params = adaptive_params if isinstance(adaptive_params, dict) else {}
    provenance = params.get("provenance") if isinstance(params.get("provenance"), dict) else {}
    return _parse_date(params.get("computed_at") or provenance.get("computed_at") or provenance.get("updated_at"))


def _validate_adaptive_asof(
    adaptive_params: dict[str, Any] | None,
    *,
    run_dt: date,
) -> dict[str, Any]:
    if not isinstance(adaptive_params, dict) or not adaptive_params:
        raise ThresholdPolicyError("adaptive params missing before ML threshold policy resolution")
    provenance = adaptive_params.get("provenance")
    if not isinstance(provenance, dict) or provenance.get("schema_version") != "adaptive-params-v2":
        raise ThresholdPolicyError("adaptive params missing adaptive-params-v2 provenance")
    if provenance.get("fallback") is True:
        raise ThresholdPolicyError("adaptive params fallback provenance not allowed for threshold policy")
    computed_dt = _adaptive_computed_date(adaptive_params)
    if computed_dt is None:
        raise ThresholdPolicyError("adaptive params computed_at missing for threshold policy")
    if computed_dt > run_dt:
        raise ThresholdPolicyError(
            "adaptive params lookahead guard failed for threshold policy: "
            f"computed_at={computed_dt.isoformat()} run_date={run_dt.isoformat()}"
        )
    age_days = (run_dt - computed_dt).days
    if age_days > ADAPTIVE_OVERLAY_MAX_AGE_DAYS:
        raise ThresholdPolicyError(
            "adaptive params stale for threshold policy: "
            f"computed_at={computed_dt.isoformat()} run_date={run_dt.isoformat()} "
            f"age_days={age_days} max_age_days={ADAPTIVE_OVERLAY_MAX_AGE_DAYS}"
        )
    return {
        "computed_at": computed_dt.isoformat(),
        "age_days": age_days,
        "provenance": provenance,
    }


def _default_validation_evidence(source: str) -> dict[str, Any]:
    return {
        "status": "bootstrap_compat",
        "source": source,
        "warning": "seed ml:threshold_policy:champion to remove trading_config bootstrap compatibility",
        "walk_forward_oos": {"status": "not_available"},
        "cpcv_pbo": {"status": "not_available"},
        "regime_segments": {"status": "not_available"},
        "twse_otc_segments": {"status": "not_available"},
        "turnover_capacity": {"status": "not_available"},
        "collapse_guard": {"status": "not_available"},
    }


def build_bootstrap_threshold_policy(
    *,
    ev2_cfg: dict | None,
    run_date: str,
    source: str = "trading_config_ensemble_v2_bootstrap",
) -> dict[str, Any]:
    run_dt = _parse_date(run_date) or datetime.now(timezone.utc).date()
    cfg = ev2_cfg or {}
    return {
        "schema_version": SCHEMA_VERSION,
        "policy_id": "bootstrap-trading-config-ensemble-v2",
        "version": run_dt.isoformat(),
        "status": "champion",
        "source": source,
        "trained_until": (run_dt - timedelta(days=1)).isoformat(),
        "effective_from": run_dt.isoformat(),
        "expires_at": (run_dt + timedelta(days=7)).isoformat(),
        "regime": "default",
        "delta_cap": 0.02,
        "model_weight_cap": cfg.get("modelWeightCap", 1.25),
        "thresholds": {
            "strongBuyThreshold": cfg.get("strongBuyThreshold", 0.85),
            "buyThreshold": cfg.get("buyThreshold", 0.70),
            "sellThreshold": cfg.get("sellThreshold", 0.30),
            "strongSellThreshold": cfg.get("strongSellThreshold", 0.15),
        },
        "validation_evidence": _default_validation_evidence(source),
    }


def load_threshold_policy_snapshot(
    *,
    kv_reader: Any | None = None,
    trading_config: dict[str, Any] | None = None,
    ev2_cfg: dict | None = None,
    run_date: str,
) -> dict[str, Any]:
    snapshot = None
    if kv_reader is not None:
        try:
            snapshot = kv_reader.get_json(f"{ML_THRESHOLD_POLICY_SNAPSHOT_PREFIX}{run_date}", default=None)
        except Exception:
            snapshot = None
    if kv_reader is not None and (not isinstance(snapshot, dict) or not snapshot):
        try:
            snapshot = kv_reader.get_json(ML_THRESHOLD_POLICY_KV_KEY, default=None)
        except Exception:
            snapshot = None
    if not isinstance(snapshot, dict) or not snapshot:
        cfg = trading_config if isinstance(trading_config, dict) else {}
        snapshot = cfg.get("mlThresholdPolicy") or cfg.get("ml_threshold_policy")
    if isinstance(snapshot, dict) and snapshot:
        return snapshot
    if os.getenv("ML_THRESHOLD_POLICY_REQUIRE_CHAMPION", "").strip() == "1":
        raise ThresholdPolicyError(f"missing promoted ML threshold policy: {ML_THRESHOLD_POLICY_KV_KEY}")
    return build_bootstrap_threshold_policy(ev2_cfg=ev2_cfg, run_date=run_date)


def _select_policy(
    snapshot: dict[str, Any],
    *,
    regime_contract: dict[str, Any] | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    raw_regime = (
        (regime_contract or {}).get("alpha_regime")
        or (regime_contract or {}).get("family")
        or (regime_contract or {}).get("label")
        or "uncertain"
    )
    normalized = normalize_policy_regime(raw_regime)
    confidence = _regime_confidence(regime_contract)
    confidence_floor = _as_float(snapshot.get("uncertain_confidence_floor"), 0.55)
    policies = snapshot.get("policies")
    selector = {
        "regime": normalized,
        "raw_regime": raw_regime,
        "regime_confidence": confidence,
        "confidence_floor": confidence_floor,
        "source": (regime_contract or {}).get("source"),
    }
    if not isinstance(policies, dict) or not policies:
        return snapshot, {**selector, "selected_key": "root"}

    candidate_keys: list[str] = []
    if confidence is not None and confidence < confidence_floor:
        candidate_keys.append("uncertain")
    candidate_keys.extend([normalized, "default", "global"])
    for key in candidate_keys:
        if isinstance(policies.get(key), dict):
            return {**snapshot, **policies[key]}, {**selector, "selected_key": key}
    raise ThresholdPolicyError(
        f"ml_threshold_policy has no policy for regime={normalized}; keys={sorted(policies.keys())}"
    )


def _validate_runtime_policy(policy: dict[str, Any], *, run_dt: date) -> None:
    status = str(policy.get("status") or "").strip().lower()
    if status in BLOCKED_STATUSES or (status and status not in PROMOTED_STATUSES):
        raise ThresholdPolicyError(f"ml_threshold_policy status is not production-eligible: {status}")
    if not status:
        raise ThresholdPolicyError("ml_threshold_policy status missing")
    trained_until = _parse_date(policy.get("trained_until"))
    effective_from = _parse_date(policy.get("effective_from"))
    expires_at = _parse_date(policy.get("expires_at"))
    if trained_until is None or effective_from is None or expires_at is None:
        raise ThresholdPolicyError("ml_threshold_policy missing trained_until/effective_from/expires_at")
    if effective_from <= trained_until:
        raise ThresholdPolicyError(
            "ml_threshold_policy lookahead guard failed: effective_from must be after trained_until"
        )
    if effective_from > run_dt:
        raise ThresholdPolicyError(
            f"ml_threshold_policy not effective yet: effective_from={effective_from} run_date={run_dt}"
        )
    if expires_at < run_dt:
        raise ThresholdPolicyError(
            f"ml_threshold_policy expired: expires_at={expires_at} run_date={run_dt}"
        )
    _policy_thresholds(policy)
    _policy_delta_cap(policy)


def _apply_overlay(
    base: dict[str, float],
    *,
    adaptive_params: dict[str, Any] | None,
    run_dt: date,
    delta_cap: float,
) -> tuple[dict[str, float], dict[str, Any]]:
    try:
        asof = _validate_adaptive_asof(adaptive_params, run_dt=run_dt)
    except ThresholdPolicyError as exc:
        computed_dt = _adaptive_computed_date(adaptive_params)
        return dict(base), {
            "status": "skipped",
            "source": "adaptive_params_guard",
            "reason": str(exc),
            "raw_delta": 0.0,
            "applied_delta": 0.0,
            "delta_cap": round(abs(float(delta_cap or 0.0)), 4),
            "computed_at": computed_dt.isoformat() if computed_dt else None,
            "components": None,
            "provenance": (adaptive_params or {}).get("provenance") if isinstance(adaptive_params, dict) else {},
        }
    raw_delta, meta = _extract_adaptive_delta(adaptive_params)
    cap = abs(float(delta_cap or 0.0))
    applied = max(-cap, min(cap, raw_delta))
    thresholds = {
        "strongBuyThreshold": _clipped(base["strongBuyThreshold"] + applied),
        "buyThreshold": _clipped(base["buyThreshold"] + applied),
        "sellThreshold": _clipped(base["sellThreshold"] - applied),
        "strongSellThreshold": _clipped(base["strongSellThreshold"] - applied),
    }
    return {key: round(value, 4) for key, value in thresholds.items()}, {
        "status": "applied",
        "source": meta["source"],
        "raw_delta": round(raw_delta, 4),
        "applied_delta": round(applied, 4),
        "delta_cap": round(cap, 4),
        "computed_at": asof["computed_at"],
        "age_days": asof.get("age_days"),
        "components": meta.get("components"),
        "provenance": asof.get("provenance") or {},
    }


def resolve_ml_threshold_policy(
    *,
    run_date: str,
    regime_contract: dict[str, Any] | None,
    ev2_cfg: dict[str, Any] | None,
    adaptive_params: dict[str, Any] | None,
    policy_snapshot: dict[str, Any] | None,
) -> ResolvedThresholdPolicy:
    run_dt = _parse_date(run_date)
    if run_dt is None:
        raise ThresholdPolicyError(f"invalid run_date for threshold policy: {run_date}")
    snapshot = policy_snapshot
    if not isinstance(snapshot, dict) or not snapshot:
        snapshot = build_bootstrap_threshold_policy(ev2_cfg=ev2_cfg, run_date=run_date)
    policy, selector = _select_policy(snapshot, regime_contract=regime_contract)
    _validate_runtime_policy(policy, run_dt=run_dt)
    base_thresholds = _policy_thresholds(policy)
    delta_cap = _policy_delta_cap(policy)
    thresholds, overlay = _apply_overlay(
        base_thresholds,
        adaptive_params=adaptive_params,
        run_dt=run_dt,
        delta_cap=delta_cap,
    )
    validation_evidence = policy.get("validation_evidence")
    if not isinstance(validation_evidence, dict):
        validation_evidence = {}
    status = str(policy.get("status") or "champion").lower()
    source = str(policy.get("source") or snapshot.get("source") or "ml_threshold_policy")
    evidence_core = {
        "policy_id": str(policy.get("policy_id") or snapshot.get("policy_id") or "unknown"),
        "version": str(policy.get("version") or snapshot.get("version") or "unknown"),
        "status": status,
        "source": source,
        "run_date": run_dt.isoformat(),
        "selector": selector,
        "thresholds": thresholds,
        "delta_cap": delta_cap,
        "adaptive_overlay": overlay,
        "validation_evidence": validation_evidence,
    }
    return ResolvedThresholdPolicy(
        policy_id=evidence_core["policy_id"],
        version=evidence_core["version"],
        status=status,
        source=source,
        selected_regime=str(policy.get("regime") or selector.get("selected_key") or "default"),
        run_date=run_dt.isoformat(),
        base_thresholds=base_thresholds,
        thresholds=thresholds,
        delta_cap=delta_cap,
        adaptive_overlay=overlay,
        validation_evidence=validation_evidence,
        selector=selector,
        evidence_hash=_hash_payload(evidence_core),
    )


def validate_threshold_policy_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    blockers: list[str] = []
    if not isinstance(candidate, dict) or not candidate:
        return {"ok": False, "blockers": ["candidate_missing"]}

    status = str(candidate.get("status") or "candidate").strip().lower()
    if status in PROMOTED_STATUSES:
        blockers.append("candidate_already_promoted")
    if candidate.get("mutates_trading_config") is True:
        blockers.append("ga_optuna_candidate_must_not_mutate_trading_config")
    try:
        _policy_thresholds(candidate)
    except ThresholdPolicyError as exc:
        blockers.append(str(exc))
    try:
        _policy_delta_cap(candidate)
    except ThresholdPolicyError as exc:
        blockers.append(str(exc))

    trained_until = _parse_date(candidate.get("trained_until"))
    effective_from = _parse_date(candidate.get("effective_from"))
    expires_at = _parse_date(candidate.get("expires_at"))
    if not trained_until or not effective_from or not expires_at:
        blockers.append("candidate_missing_asof_dates")
    elif effective_from <= trained_until:
        blockers.append("effective_from_must_be_after_trained_until")

    evidence = candidate.get("validation_evidence")
    if not isinstance(evidence, dict):
        blockers.append("validation_evidence_missing")
        evidence = {}
    missing = [key for key in REQUIRED_VALIDATION_EVIDENCE if key not in evidence]
    if missing:
        blockers.append(f"validation_evidence_missing:{','.join(missing)}")

    collapse = evidence.get("collapse_guard") if isinstance(evidence.get("collapse_guard"), dict) else {}
    for key in ("all_hold", "all_buy"):
        if collapse.get(key) is True:
            blockers.append(f"collapse_guard_failed:{key}")
    pbo = evidence.get("cpcv_pbo") if isinstance(evidence.get("cpcv_pbo"), dict) else {}
    pbo_value = pbo.get("pbo")
    if pbo_value is not None and _as_float(pbo_value, 1.0) > 0.20:
        blockers.append("cpcv_pbo_above_guardrail")

    return {
        "ok": not blockers,
        "blockers": blockers,
        "required_evidence": list(REQUIRED_VALIDATION_EVIDENCE),
        "mutation_policy": "candidate_registry_only_no_live_trading_config_mutation",
    }
