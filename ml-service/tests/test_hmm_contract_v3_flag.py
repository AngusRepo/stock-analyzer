"""HMM input contract v3 (no risk_score_fraction) stays behind HMM_INPUT_CONTRACT_VERSION; default is v2."""
import hashlib
import json
import os
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np

from app import hmm_input_contract as contract

ROOT = Path(__file__).resolve().parents[1]
V2_HASH = "8b6542b50ea5c57c768e76bd517712e42579141cc1533169f2046cffce1a5e5f"
V3_HASH = "64d6493131d1d51900e6a9fbb50a4a7f3456baa58d5eed9ff993dd1df6486d34"


def _env(days=40, version_hash=None):
    history = {}
    for i in range(days):
        day = f"2026-07-{i + 1:02d}" if i < 31 else f"2026-08-{i - 30:02d}"
        ret = 0.004 * np.sin(i)
        history[day] = {"market_return_1d": ret, "market_return_5d": 2 * ret, "market_bias_20d": ret / 2,
                        "realized_vol_3d": 0.01 + abs(ret), "risk_score": 30 + i % 7,
                        "benchmark_source": contract.SOURCE, "risk_quality_status": "score_verified"}
    return {"hmm_input_contract": version_hash or contract.CONTRACT_HASH, "requested_run_date": max(history),
            "history": history, "hmm_input_checksum": contract.checksum(history)}


def test_default_is_v2_with_unchanged_hash_and_features():
    assert os.environ.get(contract.CONTRACT_VERSION_ENV) in (None, "", contract.VERSION_V2)
    assert contract.VERSION == contract.VERSION_V2
    assert contract.CONTRACT_HASH == V2_HASH
    assert contract.CONTRACT_HASHES == {contract.VERSION_V2: V2_HASH, contract.VERSION_V3: V3_HASH}
    assert "risk_score_fraction" in contract.FEATURES and len(contract.FEATURES) == 6


def test_v2_training_input_key_matches_legacy_packing():
    env = _env()
    legacy = hashlib.sha256()
    for day in sorted(env["history"]):
        row = env["history"][day]
        ret = float(row["market_return_1d"])
        legacy.update(day.encode("ascii"))
        legacy.update(struct.pack("<6d", ret, float(row["market_return_5d"]), float(row["risk_score"]) / 100,
                                  float(row["market_bias_20d"]), abs(ret), float(row["realized_vol_3d"])))
    assert contract.training_input_key(env) == legacy.hexdigest()


def _run_with_version(version, code):
    env = {**os.environ, contract.CONTRACT_VERSION_ENV: version, "PYTHONPATH": str(ROOT)}
    return subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)


def test_v3_flag_drops_risk_score_and_trains_five_columns():
    code = """
import json, numpy as np
from app import hmm_input_contract as c
from app.regime import RegimeDetector, build_market_feature_rows, REGIME_FEATURE_WIDTH, VOL_INDEX
from tests.test_hmm_contract_v3_flag import _env
env = _env(60)
dates, features = build_market_feature_rows(env)
base = features.copy()
for row in env["history"].values(): row["risk_score"] = 99
env["hmm_input_checksum"] = c.checksum(env["history"])
_, changed = build_market_feature_rows(env)
det = RegimeDetector().fit(features, input_contract=c.CONTRACT_HASH, training_input_checksum="a" * 64)
out = det.predict_regime(features)
print(json.dumps({"version": c.VERSION, "hash": c.CONTRACT_HASH, "features": list(c.FEATURES), "width": REGIME_FEATURE_WIDTH,
  "vol_index": VOL_INDEX, "shape": list(features.shape), "risk_invariant": bool(np.array_equal(base, changed)),
  "compatible": det.compatible(), "surface": bool(out.get("regime_surface"))}))
"""
    result = _run_with_version(contract.VERSION_V3, code)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["version"] == contract.VERSION_V3 and payload["hash"] == V3_HASH
    assert "risk_score_fraction" not in payload["features"] and payload["width"] == 5 and payload["vol_index"] == 4
    assert payload["shape"] == [60, 5] and payload["risk_invariant"]
    assert payload["compatible"] and payload["surface"]


def test_v3_rejects_v2_environment_and_unknown_flag_fails_closed():
    code = """
from app import hmm_input_contract as c
from tests.test_hmm_contract_v3_flag import _env, V2_HASH
try:
    c.validate_environment(_env(version_hash=V2_HASH))
except ValueError as exc:
    print(exc)
"""
    result = _run_with_version(contract.VERSION_V3, code)
    assert result.returncode == 0 and "HMM_INPUT_CONTRACT_MISMATCH" in result.stdout
    bad = _run_with_version("hmm-taiex-fraction-v9", "import app.hmm_input_contract")
    assert bad.returncode != 0 and "HMM_INPUT_CONTRACT_VERSION_UNKNOWN" in bad.stderr


def test_v2_artifact_is_incompatible_under_v3():
    code = """
import numpy as np
from app.regime import RegimeDetector
det = RegimeDetector()
det._trained = True; det.model = object(); det.input_contract = "8b6542b50ea5c57c768e76bd517712e42579141cc1533169f2046cffce1a5e5f"
det.feature_means = np.zeros(6); det.feature_stds = np.ones(6)
print(det.compatible())
"""
    result = _run_with_version(contract.VERSION_V3, code)
    assert result.returncode == 0 and result.stdout.strip() == "False"
