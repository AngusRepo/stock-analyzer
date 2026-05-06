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
    "XGBoost",
    "CatBoost",
    "ExtraTrees",
    "LightGBM",
    "FT-Transformer",
    "Chronos",
    "DLinear",
    "PatchTST",
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
    L2 = L2_formula or {}
    risk_mult    = float(L2.get("confidence_risk_mult", 0.15))
    perf_mult    = float(L2.get("confidence_perf_mult", 0.20))
    delta_lo     = float(L2.get("confidence_delta_clip_lo", -0.10))
    delta_hi     = float(L2.get("confidence_delta_clip_hi", 0.20))
    risk_adj = (risk_score / 100) * risk_mult
    perf_adj = (0.6 - accuracy_30d) * perf_mult
    return round(_clip(risk_adj + perf_adj, delta_lo, delta_hi), 4)


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

    pf_90_map: dict[str, float] = {
        r["model_name"]: r["profit_factor"]
        for r in rows_90d
        if r.get("profit_factor") is not None
    }

    result: dict[str, float] = {}
    for r in rows_30d:
        name = r["model_name"]
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

    if total_5d == 0:
        return {"bandit_max_mult": mult_low, "bandit_force_explore": False}
    loss_rate = losses_5d / total_5d
    if loss_rate > thresh_high: return {"bandit_max_mult": mult_high, "bandit_force_explore": True}
    if loss_rate > thresh_med:  return {"bandit_max_mult": mult_med,  "bandit_force_explore": False}
    return {"bandit_max_mult": mult_low, "bandit_force_explore": False}


# ── Main ─────────────────────────────────────────────────────────────────────

def compute_regime_overrides(
    confidence_delta: float,
    bandit_max_mult: float,
    L2_formula: dict | None = None,
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
    return {
        regime: {
            "confidence_delta": round(_clip(confidence_delta + shifts[regime], -0.10, 0.20), 4),
            "bandit_max_mult": round(_clip(bandit_caps[regime], 1.0, 2.5), 4),
        }
        for regime in REGIME_KEYS
    }


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

    conf_delta      = compute_confidence_delta(risk_score, accuracy_30d, L2)
    pf_quality_mult = compute_pf_quality_mults(rows_30d, rows_90d, L2)
    sl_tp_add       = compute_sltp_override(risk_level, L2)
    bandit          = compute_bandit_protection(losses_5d, total_5d, L2)
    computed_at     = _tw_now()
    regime_overrides = compute_regime_overrides(conf_delta, bandit["bandit_max_mult"], L2)

    # legacy backwards compat: 計算 effective absolute confidence threshold
    eff_lo = float(L2.get("confidence_effective_clip_lo", 0.45))
    eff_hi = float(L2.get("confidence_effective_clip_hi", 0.75))
    legacy_conf_threshold = round(_clip(baseline_buy + conf_delta, eff_lo, eff_hi), 4)

    return {
        # 新 schema (delta-based)
        "confidence_delta":      conf_delta,
        "position_pct_delta":    0.0,  # Phase 補齊
        "sltp_add":              sl_tp_add,
        "pf_quality_mult":       pf_quality_mult,
        "bandit_max_mult":       bandit["bandit_max_mult"],
        "bandit_force_explore":  bandit["bandit_force_explore"],
        "computed_at":           computed_at,
        "market_risk_score":     risk_score,
        "recent_accuracy_30d":   round(accuracy_30d, 2),
        "regime_overrides":      regime_overrides,
        "provenance": {
            "owner": "ml-controller",
            "source": "risk-assess",
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
