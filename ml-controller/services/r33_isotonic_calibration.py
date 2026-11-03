"""R33 seven-model equal-weight score and isotonic E[excess | score].

Per model, ranks are re-ranked among the stocks available inside one day's
attested pool and standardized; an unavailable model contributes z=0 and the
denominator is always seven. A model with no dispersion among its available
stocks carries no cross-sectional information that day and counts as
unavailable. Calibration is a weighted PAVA step function of daily-centered
excess on the score, every day weighing equally. Nothing here trains a model.
"""
from __future__ import annotations

import hashlib
import json
import math

import numpy as np
from scipy.stats import rankdata

MODELS = ("LightGBM", "ExtraTrees", "TabM", "GNN", "TimeXer", "PatchTST", "iTransformer")
SCHEMA = "r33-seven-model-isotonic-excess-v1"
# mean_z follows R33 literally; mean_z_restandardized rescales the composite to
# unit cross-sectional dispersion each day (D9 compares the two on OOF).
VARIANTS = ("mean_z", "mean_z_restandardized")


def canonical_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def checksum(value) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def pool_scores(ranks, available, *, variant):
    """Score one day's pool. Returns (score, z, uninformative_models)."""
    if variant not in VARIANTS:
        raise ValueError("r33_score_variant_unknown:" + str(variant))
    ranks = np.asarray(ranks, dtype=float)
    available = np.asarray(available, dtype=bool)
    if ranks.ndim != 2 or ranks.shape[1] != len(MODELS) or ranks.shape != available.shape or not len(ranks):
        raise ValueError("r33_pool_shape_invalid")
    if not np.isfinite(ranks[available]).all():
        raise ValueError("r33_available_rank_not_finite")
    z = np.zeros(ranks.shape)
    uninformative = []
    for i, model in enumerate(MODELS):
        mask = available[:, i]
        if not mask.any():
            continue
        position = rankdata(ranks[mask, i], method="average")
        spread = position.std()
        if not spread > 0:
            uninformative.append(model)
            continue
        z[mask, i] = (position - position.mean()) / spread
    score = z.sum(axis=1) / len(MODELS)
    if variant == "mean_z_restandardized":
        spread = score.std()
        if not spread > 0:
            raise ValueError("r33_pool_no_score_dispersion")
        score = (score - score.mean()) / spread
    return score, z, uninformative


def pava(x, y, w, *, min_block_weight=0.0):
    """Weighted non-decreasing step fit; blocks are contiguous in sorted x.

    A block lighter than min_block_weight is merged into its nearer-mean neighbour
    until every block carries that much evidence; merging adjacent monotone blocks
    keeps the fit monotone."""
    x, y, w = (np.asarray(v, dtype=float).reshape(-1) for v in (x, y, w))
    if not len(x) or not (len(x) == len(y) == len(w)) or not np.isfinite(np.r_[x, y, w]).all() or (w <= 0).any():
        raise ValueError("r33_calibration_input_invalid")
    order = np.argsort(x, kind="stable")
    blocks = []  # [sum_wy, sum_w, n, x_lo, x_hi]
    for xi, yi, wi in zip(x[order], y[order], w[order]):
        if blocks and blocks[-1][4] == xi:
            last = blocks[-1]
            last[0] += yi * wi; last[1] += wi; last[2] += 1
        else:
            blocks.append([yi * wi, wi, 1, xi, xi])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1]:
            tail = blocks.pop()
            head = blocks[-1]
            head[0] += tail[0]; head[1] += tail[1]; head[2] += tail[2]; head[4] = tail[4]
    while len(blocks) > 1 and min(b[1] for b in blocks) < min_block_weight:
        i = min(range(len(blocks)), key=lambda k: blocks[k][1])
        mean = blocks[i][0] / blocks[i][1]
        if i == 0 or (i < len(blocks) - 1 and
                      abs(blocks[i + 1][0] / blocks[i + 1][1] - mean) < abs(blocks[i - 1][0] / blocks[i - 1][1] - mean)):
            i += 1
        tail = blocks.pop(i)
        head = blocks[i - 1]
        head[0] += tail[0]; head[1] += tail[1]; head[2] += tail[2]; head[4] = tail[4]
    return [dict(score_lo=float(b[3]), score_hi=float(b[4]), mean_excess=float(b[0] / b[1]),
                 weight=float(b[1]), n=int(b[2])) for b in blocks]


def predict(blocks, scores):
    """Step lookup: a score takes the block whose lower edge it last passed."""
    lo = np.array([b["score_lo"] for b in blocks])
    mean = np.array([b["mean_excess"] for b in blocks])
    idx = np.clip(np.searchsorted(lo, np.asarray(scores, dtype=float), side="right") - 1, 0, len(blocks) - 1)
    return mean[idx]


def build_payload(*, blocks, variant, horizon_sessions, inputs, diagnostics):
    payload = dict(schema_version=SCHEMA, variant=variant, model_order=list(MODELS),
                   horizon_sessions=int(horizon_sessions), target="daily_pool_centered_excess_return",
                   weighting="each_day_equal", blocks=blocks, inputs=inputs, diagnostics=diagnostics)
    validate_payload(dict(payload, payload_checksum=checksum(payload)))
    payload["payload_checksum"] = checksum(payload)
    return payload


def validate_payload(payload):
    body = {k: v for k, v in payload.items() if k != "payload_checksum"}
    if payload.get("schema_version") != SCHEMA or payload.get("payload_checksum") != checksum(body):
        raise ValueError("r33_calibration_payload_checksum_invalid")
    if payload.get("variant") not in VARIANTS or tuple(payload.get("model_order") or ()) != MODELS:
        raise ValueError("r33_calibration_payload_contract_invalid")
    if not isinstance(payload.get("horizon_sessions"), int) or payload["horizon_sessions"] < 1:
        raise ValueError("r33_calibration_horizon_invalid")
    blocks = payload.get("blocks") or []
    if not blocks:
        raise ValueError("r33_calibration_blocks_empty")
    previous = None
    for block in blocks:
        values = (block.get("score_lo"), block.get("score_hi"), block.get("mean_excess"))
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in values) or block["score_lo"] > block["score_hi"]:
            raise ValueError("r33_calibration_block_invalid")
        if previous is not None and (block["score_lo"] <= previous["score_hi"] or block["mean_excess"] < previous["mean_excess"]):
            raise ValueError("r33_calibration_blocks_not_monotone")
        previous = block
    return payload


def expected_excess(payload, scores):
    return predict(validate_payload(payload)["blocks"], scores)
