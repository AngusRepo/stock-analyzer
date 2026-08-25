"""Authenticated operational endpoints for design review and migration safety.

Deployment and research orchestration are intentionally excluded from this
serving process. Modal releases run only from an approved local/CI identity.
"""
from __future__ import annotations

import json as _json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel, Field

from services.design_review_client import call_gemini_design_review
from services.d1_domain_client import D1DataDomain, client_proxy_for_domain

LEARNING_D1_CLIENT = client_proxy_for_domain(D1DataDomain.LEARNING)

router = APIRouter(prefix="/admin", tags=["admin"])
logger = logging.getLogger(__name__)

class DesignReviewArtifact(BaseModel):
    name: str = Field(..., min_length=1, max_length=160)
    kind: Literal["code", "diff", "markdown", "route_map", "screenshot_note", "text"] = "text"
    content: str = Field(..., min_length=1, max_length=24_000)


class DesignReviewRequest(BaseModel):
    objective: str = Field(..., min_length=1, max_length=1_000)
    focus: list[str] = Field(default_factory=list, max_items=10)
    current_notes: Optional[str] = Field(default=None, max_length=4_000)
    artifacts: list[DesignReviewArtifact] = Field(default_factory=list, max_items=8)
    temperature: float = Field(default=0.35, ge=0.0, le=0.8)
    max_output_tokens: int = Field(default=2048, ge=512, le=3072)


@router.post("/design-review")
async def design_review(req: DesignReviewRequest):
    """Bounded Gemini UI/UX reviewer.

    This endpoint deliberately accepts curated UI/UX artifacts instead of free
    chat. The Gemini key remains server-side in Cloud Run.
    """
    try:
        result = await call_gemini_design_review(
            req.dict(),
            temperature=req.temperature,
            max_output_tokens=req.max_output_tokens,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("[admin/design-review] unexpected failure")
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}") from exc
    return {
        "ok": True,
        "artifact_count": len(req.artifacts),
        **result,
    }


# Signal ordinal mapping for migration-safety comparisons.
_SIGNAL_ORDINAL = {
    "STRONG_BUY":  2,
    "BUY":         1,
    "HOLD":        0,
    "NO_SIGNAL":   0,
    "SELL":       -1,
    "STRONG_SELL": -2,
}


class MigrationSafetyCheckReq(BaseModel):
    """3-layer validation for signal-migration safety (M33).

    Queries predictions.forecast_data JSON over a recent window, compares
    two paths (legacy vs new) across:
      L1 label set parity         — are the distinct value sets compatible?
      L2 behavioral replay parity — per-row label mismatch rate
      L3 distributional parity    — KS-test on ordinal-encoded signals
                                    (+ optional numeric-field paths for
                                    continuous-value comparison, e.g.
                                    ensemble_v2.avg_rank vs legacy_conf)
    """
    legacy_json_path: str = Field(
        ..., description="Dotted path in predictions.forecast_data for legacy signal, "
                         "e.g. 'legacy_signal' or 'signal'.")
    new_json_path: str = Field(
        ..., description="Dotted path for new signal, e.g. 'ensemble_v2.signal'.")
    window_days: int = Field(default=30, ge=7, le=365)
    end_date: Optional[str] = Field(
        default=None, description="Window end (YYYY-MM-DD, inclusive). Default today TW.")
    ks_alpha: float = Field(default=0.05, ge=0.001, le=0.5,
                             description="KS-test significance level.")
    mismatch_threshold: float = Field(
        default=0.10, ge=0.0, le=1.0,
        description="Layer 2 mismatch rate above this = FAIL (default 10%).")
    legacy_numeric_path: Optional[str] = Field(
        default=None, description="Optional continuous-value path for legacy, "
                                   "e.g. 'legacy_confidence'.")
    new_numeric_path: Optional[str] = Field(
        default=None, description="Optional continuous-value path for new, "
                                   "e.g. 'ensemble_v2.avg_rank'.")
    note: Optional[str] = Field(default=None, max_length=200)


def _get_json_path(obj: Any, path: str) -> Any:
    """Traverse dotted path. Returns None on missing/None at any level."""
    cur = obj
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
        if cur is None:
            return None
    return cur


def _tw_today() -> str:
    return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")


@router.post("/migration_safety_check")
def migration_safety_check(req: MigrationSafetyCheckReq = Body(default=None)):
    """Run 3-layer parity validation on predictions.forecast_data JSON.

    Returns structured verdict with per-layer PASS/WARN/FAIL + metrics +
    sample mismatches for manual review. Never 500s — monitoring endpoint.

    Recommended harness before ANY signal-source migration landing:
      1. Pre-migration: smoke run with legacy vs legacy (should all PASS)
      2. Post-migration: smoke run with legacy vs new (flags distributional shift)
    """
    if req is None:
        raise HTTPException(400, "Request body required.")

    end_date = req.end_date or _tw_today()
    start_date = (datetime.fromisoformat(end_date) - timedelta(days=req.window_days)).strftime("%Y-%m-%d")

    logger.info(
        f"[admin/migration_safety] window={start_date}~{end_date} "
        f"legacy='{req.legacy_json_path}' new='{req.new_json_path}' "
        f"note={req.note!r}"
    )

    # ── Fetch: predictions.model_name='ensemble' only (forecast_data lives there) ─
    rows = LEARNING_D1_CLIENT.query(
        "SELECT stock_id, generated_at, prediction_date, forecast_data FROM predictions "
        "WHERE model_name='ensemble' "
        "AND prediction_date >= ? "
        "AND prediction_date <= ? "
        "ORDER BY generated_at DESC LIMIT 50000",
        [start_date, end_date],
    )
    if not rows:
        return {
            "status": "insufficient_data",
            "reason": f"No predictions rows in {start_date}~{end_date}",
            "window": {"start": start_date, "end": end_date},
            "row_count": 0,
        }

    # Parse forecast_data + extract paths
    legacy_labels: list[str] = []
    new_labels:    list[str] = []
    legacy_nums:   list[float] = []
    new_nums:      list[float] = []
    parse_errors = 0

    for r in rows:
        fd_raw = r.get("forecast_data") or ""
        if not fd_raw:
            continue
        try:
            fd = _json.loads(fd_raw)
        except (ValueError, TypeError):
            parse_errors += 1
            continue

        leg = _get_json_path(fd, req.legacy_json_path)
        new = _get_json_path(fd, req.new_json_path)
        if leg is not None and new is not None:
            legacy_labels.append(str(leg))
            new_labels.append(str(new))

        if req.legacy_numeric_path and req.new_numeric_path:
            leg_n = _get_json_path(fd, req.legacy_numeric_path)
            new_n = _get_json_path(fd, req.new_numeric_path)
            if isinstance(leg_n, (int, float)) and isinstance(new_n, (int, float)):
                legacy_nums.append(float(leg_n))
                new_nums.append(float(new_n))

    n_pairs = len(legacy_labels)
    if n_pairs < 30:
        return {
            "status": "insufficient_data",
            "reason": f"Only {n_pairs} label pairs extracted (need >=30 for meaningful stats)",
            "window": {"start": start_date, "end": end_date},
            "row_count": len(rows),
            "parse_errors": parse_errors,
        }

    # ── Layer 1: Label set parity ───────────────────────────────────────────
    legacy_set = set(legacy_labels)
    new_set    = set(new_labels)
    only_legacy = sorted(legacy_set - new_set)
    only_new    = sorted(new_set - legacy_set)
    label_parity_ok = not (only_legacy or only_new)
    layer1 = {
        "verdict":     "PASS" if label_parity_ok else "WARN",
        "legacy_set":  sorted(legacy_set),
        "new_set":     sorted(new_set),
        "only_in_legacy": only_legacy,
        "only_in_new":    only_new,
    }

    # ── Layer 2: Behavioral replay (mismatch rate) ──────────────────────────
    mismatches = sum(1 for a, b in zip(legacy_labels, new_labels) if a != b)
    mismatch_rate = mismatches / n_pairs
    from collections import Counter
    layer2_transitions = Counter(
        f"{a}→{b}" for a, b in zip(legacy_labels, new_labels) if a != b
    )
    layer2_top = layer2_transitions.most_common(10)
    layer2 = {
        "verdict":        "PASS" if mismatch_rate <= req.mismatch_threshold else "FAIL",
        "n_pairs":        n_pairs,
        "n_mismatches":   mismatches,
        "mismatch_rate":  round(mismatch_rate, 4),
        "threshold":      req.mismatch_threshold,
        "top_transitions": [{"from_to": k, "count": v} for k, v in layer2_top],
    }

    # ── Layer 3: Distributional parity (KS-test on ordinal labels) ──────────
    try:
        import numpy as np
        from scipy import stats
    except ImportError as e:
        return {
            "status": "partial",
            "window": {"start": start_date, "end": end_date},
            "row_count": len(rows),
            "n_pairs": n_pairs,
            "layer1_label_parity": layer1,
            "layer2_behavioral_replay": layer2,
            "layer3_distributional_parity": {
                "verdict": "SKIP",
                "reason": f"scipy/numpy import failed: {e}",
            },
        }

    leg_ord = np.array([_SIGNAL_ORDINAL.get(s, 0) for s in legacy_labels], dtype=float)
    new_ord = np.array([_SIGNAL_ORDINAL.get(s, 0) for s in new_labels],    dtype=float)
    ks_ord = stats.ks_2samp(leg_ord, new_ord)

    # Optional numeric-field KS (catches CLT-compression-class bugs where
    # label distributions look identical but raw values diverge)
    num_ks = None
    if legacy_nums and new_nums and len(legacy_nums) >= 30 and len(new_nums) >= 30:
        leg_arr = np.array(legacy_nums, dtype=float)
        new_arr = np.array(new_nums, dtype=float)
        ks_num  = stats.ks_2samp(leg_arr, new_arr)
        num_ks = {
            "ks_statistic":  round(float(ks_num.statistic), 4),
            "p_value":       round(float(ks_num.pvalue), 4),
            "alpha":         req.ks_alpha,
            "legacy_mean":   round(float(leg_arr.mean()), 4),
            "legacy_std":    round(float(leg_arr.std()), 4),
            "legacy_range":  [round(float(leg_arr.min()), 4), round(float(leg_arr.max()), 4)],
            "new_mean":      round(float(new_arr.mean()), 4),
            "new_std":       round(float(new_arr.std()), 4),
            "new_range":     [round(float(new_arr.min()), 4), round(float(new_arr.max()), 4)],
            "n_legacy":      len(legacy_nums),
            "n_new":         len(new_nums),
            # Same-distribution null hypothesis: fail to reject if p > alpha
            "distributions_differ": bool(ks_num.pvalue < req.ks_alpha),
        }

    # Layer 3 verdict: FAIL if either ordinal or numeric distributions differ
    ord_differ = bool(ks_ord.pvalue < req.ks_alpha)
    num_differ = bool(num_ks and num_ks["distributions_differ"])
    if ord_differ or num_differ:
        l3_verdict = "FAIL"
    elif num_ks is None and ord_differ == False:
        l3_verdict = "PASS_ORDINAL_ONLY"  # ordinal OK but no numeric check available
    else:
        l3_verdict = "PASS"

    layer3 = {
        "verdict":  l3_verdict,
        "ordinal": {
            "ks_statistic":       round(float(ks_ord.statistic), 4),
            "p_value":            round(float(ks_ord.pvalue), 4),
            "alpha":              req.ks_alpha,
            "distributions_differ": ord_differ,
            "signal_ordinal_map": _SIGNAL_ORDINAL,
        },
        "numeric":  num_ks,
        "hint": ("Numeric KS-test not run — pass legacy_numeric_path + new_numeric_path "
                 "to catch CLT-compression bugs (label distributions can agree while raw "
                 "rank/score distributions diverge wildly, which is the Migration C 4/17 class)."
                 if num_ks is None else None),
    }

    overall = ("FAIL" if "FAIL" in (layer1["verdict"], layer2["verdict"], layer3["verdict"])
               else "WARN" if "WARN" in (layer1["verdict"], layer2["verdict"], layer3["verdict"])
               else "PASS")

    return {
        "status": "ok",
        "verdict": overall,
        "window": {"start": start_date, "end": end_date, "days": req.window_days},
        "row_count":     len(rows),
        "n_pairs":       n_pairs,
        "parse_errors":  parse_errors,
        "paths": {
            "legacy_label":   req.legacy_json_path,
            "new_label":      req.new_json_path,
            "legacy_numeric": req.legacy_numeric_path,
            "new_numeric":    req.new_numeric_path,
        },
        "layer1_label_parity":          layer1,
        "layer2_behavioral_replay":     layer2,
        "layer3_distributional_parity": layer3,
        "note": req.note,
    }
