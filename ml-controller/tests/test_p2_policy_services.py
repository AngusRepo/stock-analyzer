from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.alpha_quality_policy import alpha_quality_policy, resolve_alpha_quality_inputs  # noqa: E402
from services.config_pool_policy import ConfigPoolPolicy  # noqa: E402


def test_alpha_quality_policy_clamps_and_builds_runtime_kwargs():
    policy = alpha_quality_policy({
        "alphaFramework": {
            "quality": {
                "outcomeLimit": 99999,
                "minSamples": "40",
                "posteriorWeightImpactBps": 1500,
                "returnPctPerRBps": 300,
            }
        }
    })

    assert policy.outcome_limit == 5000
    assert policy.min_samples == 40
    assert policy.to_builder_kwargs()["posterior_weight_impact"] == 0.15
    assert policy.to_builder_kwargs()["return_pct_per_r"] == 0.03


def test_resolve_alpha_quality_inputs_tracks_query_overrides():
    resolved = resolve_alpha_quality_inputs(
        {"alphaFramework": {"quality": {"outcomeLimit": 700, "minSamples": 4}}},
        limit=500,
        min_samples=None,
        min_bucket_samples=3,
    )

    assert resolved["limit"] == 500
    assert resolved["min_samples"] == 4
    assert resolved["min_bucket_samples"] == 3
    assert resolved["query_overrides"] == {
        "limit": True,
        "min_samples": False,
        "min_bucket_samples": True,
    }


def test_config_pool_policy_uses_trading_config_section():
    policy = ConfigPoolPolicy.from_config({
        "configPool": {
            "sharpeDeltaWinThreshold": 0.35,
            "winRateFloor": 0.6,
            "consecutiveWinsToPromote": 3,
            "maxShadowDays": 45,
        }
    })

    assert policy.is_win(0.34, 0.7) is False
    assert policy.is_win(0.35, 0.6) is True
    assert policy.decide_action(3, 0, 10)[0] == "promote"
    assert policy.decide_action(0, 0, 46)[0] == "retire"
