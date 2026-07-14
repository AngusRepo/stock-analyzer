from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
sys.path.insert(0, str(TOOLS))
SPEC = importlib.util.spec_from_file_location("audit_active_strategies", TOOLS / "audit_active_strategies.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def _spec(strategy_id: str, *, feature_ref: str | None = None, runtime_signal: str | None = None):
    thresholds: dict = {"minPrice": 10}
    if feature_ref:
        thresholds["featureRefs"] = {"weightedScore": {"min": 0.5, "terms": [{"featureRef": feature_ref, "weight": 1}]}}
    if runtime_signal:
        thresholds["dsl"] = {"all": [{"signal": runtime_signal, "op": "==", "value": 1}]}
    return {
        "id": strategy_id, "status": "active", "familyId": "FAMILY-A", "supportedRegimes": ["bull"],
        "thresholds": thresholds, "sourceRefs": [], "riskNotes": ["not applied to remote D1 by this builder"],
    }


def test_active_attack_fails_closed_on_missing_pit_and_reward_evidence():
    specs = [_spec("S1", feature_ref="known_but_unverified"), _spec("S2", runtime_signal="technicalIndicators.S2")]
    features = {"features": [{
        "feature_id": "known_but_unverified", "availability_lag": "UNKNOWN", "earliest_execution": "UNKNOWN",
        "point_in_time": {"status": "UNKNOWN", "evidence_refs": []},
    }]}

    report = MODULE.build_active_strategy_attack(specs, [], features)

    categories = {issue["category"] for issue in report["issues"]}
    assert report["decision"] == "BLOCKED_FOR_LOCKED_TEST"
    assert "FEATURE_POINT_IN_TIME_UNVERIFIED" in categories
    assert "RUNTIME_SIGNAL_NOT_FORMAL_FEATURE" in categories
    assert "REWARD_EVIDENCE_MISSING" in categories
    assert "EXECUTION_CONTRACT_INCOMPLETE" in categories


def test_privacy_projection_removes_production_strategy_ids_and_details():
    specs = [_spec("secret_strategy_id", feature_ref="secret_feature_id")]
    report = MODULE.build_active_strategy_attack(specs, [], {"features": []})

    projection, handle_map = MODULE.build_privacy_projection(report, ["secret_strategy_id"])
    serialized = str(projection)

    assert handle_map == {"secret_strategy_id": "ACTIVE-01"}
    assert "secret_strategy_id" not in serialized
    assert "secret_feature_id" not in serialized
    assert projection["redaction"]["exact_rules_removed"] is True
