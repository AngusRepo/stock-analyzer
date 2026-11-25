"""Pure HMM input protocol shared by Controller and Modal (no data or training I/O)."""
from datetime import date
import hashlib
import json
import math
import os

SOURCE = "finlab.taiex_total_index"
VERSION_V2 = "hmm-taiex-fraction-v2"
# v3 drops risk_score_fraction: market_risk.risk_score already contains bias and volatility,
# so feeding it to the HMM double-counts them. Sessions stay gated on verified risk quality.
VERSION_V3 = "hmm-taiex-fraction-v3"
CONTRACT_VERSION_ENV = "HMM_INPUT_CONTRACT_VERSION"
_FEATURES = {
    VERSION_V2: ("return_1d", "return_5d", "risk_score_fraction", "bias_20d_fraction", "abs_return_1d", "realized_vol_3d"),
    VERSION_V3: ("return_1d", "return_5d", "bias_20d_fraction", "abs_return_1d", "realized_vol_3d"),
}
_CONTRACTS = {version: {"version": version, "benchmark": "TAIEX", "source": SOURCE,
            "features": features, "risk_owner": "market-risk-quality-v1",
            "risk_quality_rule":"complete_or_proven_equal_score_bounds", "units": "fraction", "volatility_window": "3_consecutive_price_sessions_ddof0"}
              for version, features in _FEATURES.items()}

def checksum(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()

CONTRACT_HASHES = {version: checksum(contract) for version, contract in _CONTRACTS.items()}

def _selected_version():
    version = (os.environ.get(CONTRACT_VERSION_ENV) or VERSION_V2).strip()
    if version not in _CONTRACTS:
        # A misspelled flag must not silently fall back to another contract.
        raise ValueError(f"HMM_INPUT_CONTRACT_VERSION_UNKNOWN:{version}")
    return version

VERSION = _selected_version()
FEATURES = _FEATURES[VERSION]
CONTRACT = _CONTRACTS[VERSION]
CONTRACT_HASH = CONTRACT_HASHES[VERSION]

def feature_vector(row, features=FEATURES):
    """One HMM feature row in contract order; the single place a history row becomes features."""
    ret = float(row["market_return_1d"])
    values = {"return_1d": ret, "return_5d": float(row["market_return_5d"]), "risk_score_fraction": float(row["risk_score"])/100,
              "bias_20d_fraction": float(row["market_bias_20d"]), "abs_return_1d": abs(ret), "realized_vol_3d": float(row["realized_vol_3d"])}
    return [values[name] for name in features]

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


def training_input_key(env):
    """Retry identity ignores macro annotations that are not HMM training features."""
    import struct
    history = validate_environment(env)
    digest = hashlib.sha256()
    for day in sorted(history):
        digest.update(day.encode('ascii'))
        digest.update(struct.pack(f'<{len(FEATURES)}d', *feature_vector(history[day])))
    return digest.hexdigest()
