"""
services/adaptive.py — 自適應參數計算引擎

從 Worker adaptiveEngine.ts 移植的 Python 版。

T+1 生效原則：今天算的參數明天才用，斷開 feedback loop。
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional
from datetime import datetime, timezone, timedelta


def _clip(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _tw_now() -> str:
    """ISO 字串，台北時區（UTC+8）。"""
    tz = timezone(timedelta(hours=8))
    return datetime.now(tz).isoformat()


# ── 1. 信心門檻自適應 ──────────────────────────────────────────────────────────

def compute_confidence_threshold(risk_score: float, accuracy_30d: float) -> float:
    """
    risk_score: 0~100（越高越危險）
    accuracy_30d: 0~1（ensemble 全局 30d 準確率）
    returns: 0.55~0.75（越高越嚴格）
    """
    base     = 0.60
    risk_adj = (risk_score / 100) * 0.15      # 風險越高門檻越嚴
    perf_adj = (0.6 - accuracy_30d) * 0.20    # 準確率越低門檻越嚴
    return round(_clip(base + risk_adj + perf_adj, 0.55, 0.75), 4)


# ── 2. PF 品質權重自適應 ───────────────────────────────────────────────────────

def compute_pf_quality_mults(
    rows_30d: list[dict],   # [{model_name, profit_factor, total_count}]
    rows_90d: list[dict],   # [{model_name, profit_factor}]
) -> dict[str, float]:
    """
    各模型 PF 加權乘數（30d 70% + 90d 30%，避免近因偏差）。
    樣本不足 (<10) 或 PF 為 null → 使用預設 1.0。
    """
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
        pf30 = _clip(r["profit_factor"], 0.3, 1.8)
        pf90 = _clip(pf_90_map.get(name, pf30), 0.3, 1.8)
        result[name] = round(_clip(pf30 * 0.7 + pf90 * 0.3, 0.3, 1.8), 4)
    return result


# ── 3. SL/TP Regime 調整 ─────────────────────────────────────────────────────

def compute_sltp_override(risk_level: str) -> Optional[dict]:
    """
    orange/red/black 市況下擴大 SL+TP buffer（點數 %）。
    green/yellow → None（不調整）。
    """
    mapping = {
        "orange": {"sl_add": 0.3, "tp_add": 0.3},
        "red":    {"sl_add": 0.5, "tp_add": 0.5},
        "black":  {"sl_add": 1.0, "tp_add": 0.5},
    }
    return mapping.get(risk_level)


# ── 4. LinUCB Feedback Loop 防護 ──────────────────────────────────────────────

def compute_bandit_protection(losses_5d: int, total_5d: int) -> dict:
    """
    近 5 日紙盤虧損比例決定 LinUCB bandit 的安全參數：
    - 虧損率 > 60% → 強制探索，限制最大乘數
    - 虧損率 > 40% → 適度收斂
    """
    if total_5d == 0:
        return {"bandit_max_mult": 2.5, "bandit_force_explore": False}
    loss_rate = losses_5d / total_5d
    if   loss_rate > 0.6: return {"bandit_max_mult": 1.5, "bandit_force_explore": True}
    elif loss_rate > 0.4: return {"bandit_max_mult": 2.0, "bandit_force_explore": False}
    return {"bandit_max_mult": 2.5, "bandit_force_explore": False}


# ── Main ─────────────────────────────────────────────────────────────────────

def compute_adaptive_params(
    risk_score: float,
    risk_level: str,
    accuracy_30d: float,
    rows_30d: list[dict],
    rows_90d: list[dict],
    losses_5d: int,
    total_5d: int,
    current_version: int = 0,
) -> dict:
    """
    計算完整的自適應參數字典（可直接寫入 KV ml:adaptive_params）。

    Args:
        risk_score:       0~100，市場風險分數
        risk_level:       "green" | "yellow" | "orange" | "red" | "black"
        accuracy_30d:     全局 ensemble 30d 平均準確率（0~1）
        rows_30d:         model_accuracy 30d rows（含 model_name/profit_factor/total_count）
        rows_90d:         model_accuracy 90d rows（含 model_name/profit_factor）
        losses_5d:        近 5 天紙盤虧損筆數
        total_5d:         近 5 天紙盤總出場筆數
        current_version:  現有版本號（+1 後寫入）
    """
    conf_threshold  = compute_confidence_threshold(risk_score, accuracy_30d)
    pf_quality_mult = compute_pf_quality_mults(rows_30d, rows_90d)
    sl_tp_override  = compute_sltp_override(risk_level)
    bandit          = compute_bandit_protection(losses_5d, total_5d)

    return {
        "confidence_threshold":  conf_threshold,
        "pf_quality_mult":       pf_quality_mult,
        "sl_tp_override":        sl_tp_override,
        "bandit_max_mult":       bandit["bandit_max_mult"],
        "bandit_force_explore":  bandit["bandit_force_explore"],
        "computed_at":           _tw_now(),
        "market_risk_score":     risk_score,
        "recent_accuracy_30d":   round(accuracy_30d, 2),
        "version":               current_version + 1,
    }
