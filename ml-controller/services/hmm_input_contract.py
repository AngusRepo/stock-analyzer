"""Pure HMM input protocol shared by Controller and Modal (no data or training I/O)."""
from datetime import date
import hashlib
import json
import math

VERSION = "hmm-taiex-fraction-v2"
SOURCE = "finlab.taiex_total_index"
FEATURES = ("return_1d", "return_5d", "risk_score_fraction", "bias_20d_fraction", "abs_return_1d", "realized_vol_3d")
CONTRACT = {"version": VERSION, "benchmark": "TAIEX", "source": SOURCE,
            "features": FEATURES, "risk_owner": "market-risk-quality-v1",
            "risk_quality_rule":"complete_or_proven_equal_score_bounds", "units": "fraction", "volatility_window": "3_consecutive_price_sessions_ddof0"}

def checksum(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()

CONTRACT_HASH = checksum(CONTRACT)

def validate_environment(env):
    if not isinstance(env, dict) or env.get("hmm_input_contract") != CONTRACT_HASH:
        raise ValueError("HMM_INPUT_CONTRACT_MISMATCH")
    requested = date.fromisoformat(env["requested_run_date"]).isoformat()
    history = env.get("history")
    if not isinstance(history, dict) or len(history) < 20 or max(history) != requested:
        raise ValueError("HMM_INPUT_HISTORY_INCOMPLETE_OR_STALE")
    if env.get("hmm_input_checksum") != checksum(history):
        raise ValueError("HMM_INPUT_CHECKSUM_MISMATCH")
    for key, row in history.items():
        if date.fromisoformat(key).isoformat() != key or key > requested:
            raise ValueError("HMM_INPUT_FUTURE_DATE")
        if row.get("benchmark_source") != SOURCE or row.get("risk_quality_status") != "score_verified":
            raise ValueError("HMM_INPUT_SOURCE_OR_QUALITY_MISMATCH")
        values = [row.get(k) for k in ("market_return_1d", "market_return_5d", "risk_score", "market_bias_20d", "realized_vol_3d")]
        if any(v is None or isinstance(v, bool) or not math.isfinite(float(v)) for v in values):
            raise ValueError("HMM_INPUT_NONFINITE")
        if not 0 <= float(values[2]) <= 100 or float(values[4]) < 0:
            raise ValueError("HMM_INPUT_RANGE_INVALID")
        if any(abs(float(values[i])) > 1 for i in (0, 1, 3, 4)):
            raise ValueError("HMM_INPUT_FRACTION_UNIT_INVALID")
    return history
