"""
services/adaptive.py — 自適應參數計算引擎

從 Worker adaptiveEngine.ts 移植的 Python 版。

T+1 生效原則：今天算的參數明天才用，斷開 feedback loop。
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional
from datetime import datetime, timezone, timedelta

ALPHA_VOTE_MODELS = [
    "LightGBM",
    "XGBoost",
    "ExtraTrees",
    "TabM",
    "GNN",
    "DLinear",
    "PatchTST",
    "iTransformer",
    "TimesFM",
]
STATE_SPACE_OVERLAYS = ["KalmanFilter", "MarkovSwitching"]
META_OPTIMIZERS = ["GAOptimizer"]
REGIME_KEYS = ("bull", "bear", "volatile", "sideways")


def _clip(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _tw_now() -> str:
    """ISO 字串，台北時區（UTC+8）。"""
    tz = timezone(timedelta(hours=8))
    return datetime.now(tz).isoformat()


def _as_float(value: object, default: float | None = None) -> float | None:
    try:
        if value is not None:
            return float(value)
    except (TypeError, ValueError):
        return default
    return default


def _as_int(value: object, default: int = 0) -> int:
    try:
        if value is not None:
            return max(0, int(float(value)))
    except (TypeError, ValueError):
        return default
    return default


def build_ml_confidence_hook(
    rows_30d: list[dict],
    accuracy_30d: float,
    *,
    active_9_quality_30d: float | None = None,
    active_9_samples_30d: int | None = None,
    active_9_model_count_30d: int | None = None,
) -> dict:
    active = set(ALPHA_VOTE_MODELS)
    total_samples = 0
    weighted_accuracy = 0.0
    active_models_seen: set[str] = set()
    ignored_models: set[str] = set()

    for row in rows_30d:
        name = str(row.get("model_name") or "").strip()
        if not name:
            continue
        if name not in active:
            ignored_models.add(name)
            continue
        samples = _as_int(row.get("total_count"))
        accuracy = _as_float(row.get("accuracy"))
        if samples <= 0 or accuracy is None:
            continue
        total_samples += samples
        weighted_accuracy += _clip(accuracy, 0.0, 1.0) * samples
        active_models_seen.add(name)

    provided_quality = _as_float(active_9_quality_30d)
    if provided_quality is not None:
        quality = _clip(provided_quality, 0.0, 1.0)
        status = "active_9_worker_quality"
        sample_count = _as_int(active_9_samples_30d, total_samples)
        model_count = _as_int(active_9_model_count_30d, len(active_models_seen))
    elif total_samples > 0:
        quality = _clip(weighted_accuracy / total_samples, 0.0, 1.0)
        status = "active_9_rows_quality"
        sample_count = total_samples
        model_count = len(active_models_seen)
    else:
        quality = _clip(float(accuracy_30d), 0.0, 1.0)
        status = "fallback_global_accuracy"
        sample_count = 0
        model_count = 0

    return {
        "source": "model_accuracy_30d_active_9_verified_rows",
        "status": status,
        "model_quality_30d": round(quality, 4),
        "sample_count_30d": int(sample_count),
        "active_model_count_30d": int(model_count),
        "active_models": ALPHA_VOTE_MODELS,
        "ignored_non_active_models": sorted(ignored_models),
        "effect": "threshold_components.model_quality_penalty",
    }


# ── 1. 信心門檻自適應 ──────────────────────────────────────────────────────────

def compute_confidence_threshold(risk_score: float, accuracy_30d: float) -> float:
    """
    @deprecated 用 compute_confidence_delta 取代

    Legacy: 回傳 absolute (0.55~0.75)
    保留供 backwards compat 期間使用，Phase 2 後移除
    """
    base     = 0.60
    risk_adj = (risk_score / 100) * 0.15
    perf_adj = (0.6 - accuracy_30d) * 0.20
    return round(_clip(base + risk_adj + perf_adj, 0.55, 0.75), 4)


def compute_confidence_delta(
    risk_score: float,
    accuracy_30d: float,
    L2_formula: dict | None = None,
) -> float:
    """
    Phase A: 回傳純 delta（不是 absolute）

    Args:
        L2_formula: 從 trading:config.L2_formula 讀的常數 dict，None 時用 hardcoded fallback

    delta = risk * risk_mult + (0.6 - acc) * perf_mult
    bounded by [delta_clip_lo, delta_clip_hi]

    Paper.ts 端應用：effective = clip(baseline + delta, effective_clip_lo, effective_clip_hi)
    """
    return compute_confidence_components(risk_score, accuracy_30d, L2_formula)["effective_delta"]


def compute_confidence_components(
    risk_score: float,
    accuracy_30d: float,
    L2_formula: dict | None = None,
    *,
    risk_level: str | None = None,
    regime: str | None = None,
    trend_quality: float | None = None,
    volatility_score: float | None = None,
    model_quality: float | None = None,
) -> dict:
    """Build an explainable adaptive threshold delta.

    Positive components make the buy threshold more conservative. Credits lower
    the threshold only when the market context is constructive. This avoids the
    old single-delta behavior where bull markets still raised thresholds just
    because risk_score was non-zero.
    """
    L2 = L2_formula or {}
    risk_mult = float(L2.get("confidence_risk_mult", 0.15))
    perf_mult = float(L2.get("confidence_perf_mult", 0.20))
    delta_lo = float(L2.get("confidence_delta_clip_lo", -0.10))
    delta_hi = float(L2.get("confidence_delta_clip_hi", 0.20))
    target_acc = float(L2.get("confidence_target_accuracy", 0.60))
    opportunity_mult = float(L2.get("confidence_regime_opportunity_mult", 0.06))
    trend_mult = float(L2.get("confidence_trend_quality_mult", 0.05))
    volatility_mult = float(L2.get("confidence_volatility_mult", 0.04))
    bear_volatile_penalty = float(L2.get("confidence_bear_volatile_penalty", 0.03))

    risk_norm = _clip(float(risk_score) / 100.0, 0.0, 1.0)
    quality = _clip(float(model_quality if model_quality is not None else accuracy_30d), 0.0, 1.0)
    trend = _clip(float(trend_quality) if trend_quality is not None else max(0.0, 1.0 - risk_norm), 0.0, 1.0)
    volatility = _clip(float(volatility_score) if volatility_score is not None else risk_norm, 0.0, 1.0)
    normalized_regime = normalize_regime_label(regime)
    risk_level_norm = str(risk_level or "").lower()

    risk_penalty = risk_norm * risk_mult
    model_quality_penalty = max(0.0, target_acc - quality) * perf_mult
    volatility_penalty = volatility * volatility_mult if risk_level_norm in {"orange", "red", "black"} or volatility >= 0.55 else 0.0
    if normalized_regime in {"bear", "volatile"}:
        volatility_penalty += bear_volatile_penalty

    constructive = normalized_regime == "bull" and volatility < 0.45 and quality >= max(0.50, target_acc - 0.08)
    regime_opportunity_credit = opportunity_mult * (1.0 - volatility) if constructive else 0.0
    trend_quality_credit = trend * trend_mult if constructive and trend >= 0.55 else 0.0

    effective = (
        risk_penalty
        + model_quality_penalty
        + volatility_penalty
        - regime_opportunity_credit
        - trend_quality_credit
    )
    effective_delta = round(_clip(effective, delta_lo, delta_hi), 4)
    return {
        "risk_penalty": round(risk_penalty, 4),
        "model_quality_penalty": round(model_quality_penalty, 4),
        "volatility_penalty": round(volatility_penalty, 4),
        "regime_opportunity_credit": round(regime_opportunity_credit, 4),
        "trend_quality_credit": round(trend_quality_credit, 4),
        "effective_delta": effective_delta,
        "inputs": {
            "risk_score": round(float(risk_score), 4),
            "risk_norm": round(risk_norm, 4),
            "accuracy_30d": round(float(accuracy_30d), 4),
            "model_quality": round(quality, 4),
            "trend_quality": round(trend, 4),
            "volatility_score": round(volatility, 4),
            "regime": normalized_regime,
            "risk_level": risk_level_norm or None,
        },
        "formula": "risk_penalty + model_quality_penalty + volatility_penalty - regime_opportunity_credit - trend_quality_credit",
    }


# ── 2. PF 品質權重自適應 ───────────────────────────────────────────────────────

def compute_pf_quality_mults(
    rows_30d: list[dict],
    rows_90d: list[dict],
    L2_formula: dict | None = None,
) -> dict[str, float]:
    """
    Phase A: 從 L2_formula 讀 30d/90d weights + clip range

    各模型 PF 加權乘數（30d weight + 90d weight，避免近因偏差）。
    樣本不足 (<10) 或 PF 為 null → 使用預設 1.0。
    """
    L2 = L2_formula or {}
    w30 = float(L2.get("pf_quality_30d_weight", 0.7))
    w90 = float(L2.get("pf_quality_90d_weight", 0.3))
    lo  = float(L2.get("pf_quality_clip_lo", 0.3))
    hi  = float(L2.get("pf_quality_clip_hi", 1.8))

    active = set(ALPHA_VOTE_MODELS)
    pf_90_map: dict[str, float] = {}
    for r in rows_90d:
        name = str(r.get("model_name") or "").strip()
        if name in active and r.get("profit_factor") is not None:
            pf_90_map[name] = r["profit_factor"]

    result: dict[str, float] = {}
    for r in rows_30d:
        name = str(r.get("model_name") or "").strip()
        if name not in active:
            continue
        if r.get("total_count", 0) < 10 or r.get("profit_factor") is None:
            result[name] = 1.0
            continue
        pf30 = _clip(r["profit_factor"], lo, hi)
        pf90 = _clip(pf_90_map.get(name, pf30), lo, hi)
        result[name] = round(_clip(pf30 * w30 + pf90 * w90, lo, hi), 4)
    return result


# ── 3. SL/TP Regime 調整 ─────────────────────────────────────────────────────

def compute_sltp_override(risk_level: str, L2_formula: dict | None = None) -> Optional[dict]:
    """
    Phase A: 從 L2_formula 讀對應 risk_level 的加碼，不再 hardcode

    orange/red/black 市況下擴大 SL+TP buffer（點數 %）。
    green/yellow → None（不調整）。
    """
    L2 = L2_formula or {}
    if risk_level == "orange":
        return {"sl_add": float(L2.get("sltp_add_orange_sl", 0.3)),
                "tp_add": float(L2.get("sltp_add_orange_tp", 0.3))}
    if risk_level == "red":
        return {"sl_add": float(L2.get("sltp_add_red_sl", 0.5)),
                "tp_add": float(L2.get("sltp_add_red_tp", 0.5))}
    if risk_level == "black":
        return {"sl_add": float(L2.get("sltp_add_black_sl", 1.0)),
                "tp_add": float(L2.get("sltp_add_black_tp", 0.5))}
    return None


# ── 4. LinUCB Feedback Loop 防護 ──────────────────────────────────────────────

def compute_bandit_protection(losses_5d: int, total_5d: int, L2_formula: dict | None = None) -> dict:
    """
    Phase A: 從 L2_formula 讀 thresholds + max_mults

    近 5 日紙盤虧損比例決定 LinUCB bandit 的安全參數
    """
    L2 = L2_formula or {}
    thresh_high = float(L2.get("bandit_loss_thresh_high", 0.6))
    thresh_med  = float(L2.get("bandit_loss_thresh_med", 0.4))
    mult_high   = float(L2.get("bandit_max_mult_high", 1.5))
    mult_med    = float(L2.get("bandit_max_mult_med", 2.0))
    mult_low    = float(L2.get("bandit_max_mult_low", 2.5))

    context = {
        "losses_5d": int(losses_5d),
        "total_5d": int(total_5d),
        "loss_rate": round(losses_5d / total_5d, 4) if total_5d else None,
        "thresholds": {"high": thresh_high, "medium": thresh_med},
        "max_mults": {"high": mult_high, "medium": mult_med, "low": mult_low},
        "reward_ledger": "paper_orders.sell_5d",
    }

    if total_5d == 0:
        return {"bandit_max_mult": mult_low, "bandit_force_explore": False, "bandit_context": {**context, "decision": "no_recent_reward_samples"}}
    loss_rate = losses_5d / total_5d
    if loss_rate > thresh_high:
        return {"bandit_max_mult": mult_high, "bandit_force_explore": True, "bandit_context": {**context, "decision": "high_recent_loss_rate_force_explore"}}
    if loss_rate > thresh_med:
        return {"bandit_max_mult": mult_med, "bandit_force_explore": False, "bandit_context": {**context, "decision": "medium_recent_loss_rate_cap_exposure"}}
    return {"bandit_max_mult": mult_low, "bandit_force_explore": False, "bandit_context": {**context, "decision": "reward_ledger_ok"}}


# ── Main ─────────────────────────────────────────────────────────────────────

def compute_regime_overrides(
    confidence_delta: float,
    bandit_max_mult: float,
    L2_formula: dict | None = None,
    *,
    risk_score: float | None = None,
    accuracy_30d: float | None = None,
    risk_level: str | None = None,
    model_quality: float | None = None,
) -> dict[str, dict]:
    """Controller-owned per-regime adaptive deltas."""
    L2 = L2_formula or {}
    shifts = {
        "bull": float(L2.get("regime_conf_delta_shift_bull", -0.02)),
        "bear": float(L2.get("regime_conf_delta_shift_bear", 0.04)),
        "volatile": float(L2.get("regime_conf_delta_shift_volatile", 0.04)),
        "sideways": float(L2.get("regime_conf_delta_shift_sideways", 0.02)),
    }
    bandit_caps = {
        "bull": float(L2.get("regime_bandit_max_mult_bull", bandit_max_mult)),
        "bear": float(L2.get("regime_bandit_max_mult_bear", min(bandit_max_mult, 2.0))),
        "volatile": float(L2.get("regime_bandit_max_mult_volatile", min(bandit_max_mult, 1.5))),
        "sideways": float(L2.get("regime_bandit_max_mult_sideways", min(bandit_max_mult, 2.2))),
    }
    out: dict[str, dict] = {}
    for regime in REGIME_KEYS:
        component_bundle = None
        if risk_score is not None and accuracy_30d is not None:
            component_bundle = compute_confidence_components(
                risk_score,
                accuracy_30d,
                L2,
                risk_level=risk_level,
                regime=regime,
                model_quality=model_quality,
            )
            delta = component_bundle["effective_delta"]
        else:
            delta = round(_clip(confidence_delta + shifts[regime], -0.10, 0.20), 4)
        out[regime] = {
            "confidence_delta": delta,
            "bandit_max_mult": round(_clip(bandit_caps[regime], 1.0, 2.5), 4),
        }
        if component_bundle:
            out[regime]["threshold_components"] = component_bundle
        elif shifts.get(regime):
            out[regime]["legacy_shift"] = round(shifts[regime], 4)
    return out


def normalize_regime_label(raw: object) -> str:
    value = str(raw or "").lower()
    if "bull" in value:
        return "bull"
    if "bear" in value:
        return "bear"
    if "vol" in value:
        return "volatile"
    if "side" in value or "range" in value or "chop" in value:
        return "sideways"
    return "unknown"


def resolve_adaptive_params_for_regime(params: dict | None, regime: object) -> dict:
    """Apply P8 per-regime adaptive deltas before payloads reach Modal."""
    base = dict(params or {})
    normalized = normalize_regime_label(regime)
    overrides = base.get("regime_overrides") if isinstance(base.get("regime_overrides"), dict) else {}
    override = overrides.get(normalized) if normalized != "unknown" else None
    if isinstance(override, dict):
        merged = {**base, **override}
        if isinstance(base.get("pf_quality_mult"), dict) or isinstance(override.get("pf_quality_mult"), dict):
            merged["pf_quality_mult"] = {
                **(base.get("pf_quality_mult") if isinstance(base.get("pf_quality_mult"), dict) else {}),
                **(override.get("pf_quality_mult") if isinstance(override.get("pf_quality_mult"), dict) else {}),
            }
        if isinstance(base.get("screener"), dict) or isinstance(override.get("screener"), dict):
            merged["screener"] = {
                **(base.get("screener") if isinstance(base.get("screener"), dict) else {}),
                **(override.get("screener") if isinstance(override.get("screener"), dict) else {}),
            }
        base = merged

    provenance = dict(base.get("provenance") or {})
    provenance.update({
        "owner": "ml-controller",
        "schema_version": "adaptive-params-v2",
        "update_frequency": "daily_after_verify",
        "regime": normalized,
    })
    base["provenance"] = provenance
    return base


def compute_adaptive_params(
    risk_score: float,
    risk_level: str,
    accuracy_30d: float,
    rows_30d: list[dict],
    rows_90d: list[dict],
    losses_5d: int,
    total_5d: int,
    current_version: int = 0,
    L2_formula: dict | None = None,
    baseline_buy_signal_score: float | None = None,
    active_9_quality_30d: float | None = None,
    active_9_samples_30d: int | None = None,
    active_9_model_count_30d: int | None = None,
) -> dict:
    """
    計算完整的自適應參數字典（可直接寫入 KV ml:adaptive_params）。

    Phase A 改造：
    - 全部 compute function 從 L2_formula 讀係數（不再 hardcode）
    - 回傳 confidence_delta 而非 absolute confidence_threshold
    - 同時回傳 legacy confidence_threshold = baseline + delta + clip（backwards compat）

    Args:
        L2_formula: trading:config.L2_formula dict（從 Worker KV 讀後 POST 過來），None 用 hardcoded fallback
        baseline_buy_signal_score: trading:config.signal.buySignalScore（Optuna #2 baseline），None 用 0.52
    """
    L2 = L2_formula or {}
    baseline_buy = baseline_buy_signal_score if baseline_buy_signal_score is not None else 0.52
    ml_confidence_hook = build_ml_confidence_hook(
        rows_30d,
        accuracy_30d,
        active_9_quality_30d=active_9_quality_30d,
        active_9_samples_30d=active_9_samples_30d,
        active_9_model_count_30d=active_9_model_count_30d,
    )
    model_quality_30d = ml_confidence_hook["model_quality_30d"]

    threshold_components = compute_confidence_components(
        risk_score,
        accuracy_30d,
        L2,
        risk_level=risk_level,
        regime="unknown",
        model_quality=model_quality_30d,
    )
    conf_delta      = threshold_components["effective_delta"]
    pf_quality_mult = compute_pf_quality_mults(rows_30d, rows_90d, L2)
    sl_tp_add       = compute_sltp_override(risk_level, L2)
    bandit          = compute_bandit_protection(losses_5d, total_5d, L2)
    computed_at     = _tw_now()
    regime_overrides = compute_regime_overrides(
        conf_delta,
        bandit["bandit_max_mult"],
        L2,
        risk_score=risk_score,
        accuracy_30d=accuracy_30d,
        risk_level=risk_level,
        model_quality=model_quality_30d,
    )

    # legacy backwards compat: 計算 effective absolute confidence threshold
    eff_lo = float(L2.get("confidence_effective_clip_lo", 0.45))
    eff_hi = float(L2.get("confidence_effective_clip_hi", 0.75))
    legacy_conf_threshold = round(_clip(baseline_buy + conf_delta, eff_lo, eff_hi), 4)

    return {
        # 新 schema (delta-based)
        "confidence_delta":      conf_delta,
        "threshold_components":  threshold_components,
        "ml_confidence_hook":    ml_confidence_hook,
        "position_pct_delta":    0.0,  # Phase 補齊
        "sltp_add":              sl_tp_add,
        "pf_quality_mult":       pf_quality_mult,
        "bandit_max_mult":       bandit["bandit_max_mult"],
        "bandit_force_explore":  bandit["bandit_force_explore"],
        "bandit_context":        bandit.get("bandit_context"),
        "computed_at":           computed_at,
        "market_risk_score":     risk_score,
        "recent_accuracy_30d":   round(accuracy_30d, 2),
        "regime_overrides":      regime_overrides,
        "provenance": {
            "owner": "ml-controller",
            "source": "risk-assess",
            "l2_formula_source": "worker_trading_config" if L2_formula else "controller_fallback_defaults",
            "schema_version": "adaptive-params-v2",
            "update_frequency": "daily_after_verify",
            "computed_at": computed_at,
            "fallback": False,
        },
        "meta_layer": {
            "alpha_vote_models": ALPHA_VOTE_MODELS,
            "state_space_overlays": STATE_SPACE_OVERLAYS,
            "meta_optimizers": META_OPTIMIZERS,
            "adaptive_components": {
                "ARF": "drift-aware ensemble aggregation, not a standalone alpha vote",
                "LinUCB": "contextual bandit model weighting with delayed reward protection",
                "Conformal": "prediction uncertainty calibration and coverage guard",
                "Stacking": "meta learner for ensemble blending after base-model predictions",
                "GAOptimizer": "meta optimizer for ensemble weights, strategy params, and risk params",
                "NeuralUCB": "shadow meta-router for nonlinear model-weight and threshold policy comparison",
                "NeuralTS": "shadow Thompson sampler to audit NeuralUCB optimism before production consideration",
                "OnlinePortfolioBandit": "production allocator controller for sparse_tangent_inverse_risk knobs; production-capable without replacing the final weight engine",
                "NeuCB": "research-only neural contextual bandit benchmark until experiment registry evidence exists",
            },
            "immutable_risk_boundaries": [
                "circuit",
                "riskOverlay.hardGates",
                "position.maxPctOfPortfolio",
                "paperExecution.impossibleFillGuard",
            ],
        },
        "version":               current_version + 1,

        # legacy fields (Phase 2 後移除)
        "confidence_threshold":  legacy_conf_threshold,
        "sl_tp_override":        sl_tp_add,
    }
