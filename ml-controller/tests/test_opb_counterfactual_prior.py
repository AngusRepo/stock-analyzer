from __future__ import annotations

import sys
import asyncio
from datetime import date, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import online_portfolio_bandit, opb_counterfactual_prior  # noqa: E402
from services.online_portfolio_bandit import resolve_portfolio_bandit_arms  # noqa: E402
from services.opb_counterfactual_prior import (  # noqa: E402
    build_opb_arm_prior_artifact,
    load_opb_counterfactual_inputs,
)
from routers import opb_arm_prior as opb_route  # noqa: E402


def _l4(expected_return: float, version: str = "l4-test") -> dict:
    return {
        "expected_return": expected_return,
        "expected_return_owner": "l4_alpha_ev",
        "expected_return_source": "l4_alpha_ev_ridge",
        "approval_state": "production_approved",
        "validation_packet": {"decision": "PASS"},
        "resolver_method": "ridge",
        "model_version": version,
        "feature_snapshot_version": "snapshot-v1",
        "trained_until": "2026-05-31",
        "horizon_days": 5,
        "cost_model_bps": 18.0,
        "output_is_net_of_costs": True,
    }


def test_counterfactual_prior_replays_every_arm_and_discount_overlapping_dates(monkeypatch):
    monkeypatch.setattr(
        online_portfolio_bandit,
        "allocate_sparse_tangent_with_evidence",
        lambda candidates, return_history, **kwargs: {
            "weights": {row["symbol"]: 1.0 / len(candidates) for row in candidates},
            "candidate_diagnostics": {},
        },
    )
    start = date(2026, 6, 1)
    rows = []
    price_rows = []
    for index in range(20):
        day = (start + timedelta(days=index)).isoformat()
        for symbol, actual_return, edge in (("AAA", 0.02, 0.03), ("BBB", -0.01, 0.01)):
            rows.append({
                "prediction_date": day,
                "symbol": symbol,
                "score": 80 - index / 10,
                "actual_return_pct": actual_return,
                "alpha_allocation": {"l4_alpha_ev": _l4(edge)},
            })
            price_rows.append({"price_date": day, "symbol": symbol, "close": 100 + index})

    result = build_opb_arm_prior_artifact(
        rows,
        price_rows,
        expected_return_owner="l4_alpha_ev",
        trained_until="2026-06-20",
        min_dates=20,
    )

    artifact = result["artifact"]
    assert artifact["validation"]["decision"] == "PASS"
    assert artifact["source_expected_return_contract_version"] == "l4-alpha-ev-contract-v5"
    assert artifact["source_expected_return_semantic"] == "canonical_l4_expected_return_net_of_costs"
    assert artifact["live_reward_ledger_merged"] is False
    assert len(artifact["arm_priors"]) == 5
    assert {row["dates"] for row in artifact["arm_priors"]} == {20}
    assert {row["prior_samples"] for row in artifact["arm_priors"]} == {4}


def test_counterfactual_input_loader_maps_canonical_executable_return(monkeypatch):
    monkeypatch.setattr(
        opb_counterfactual_prior,
        "load_allocator_ev_fusion_training_rows",
        lambda *_, **__: [{
            "prediction_date": "2026-06-24",
            "symbol": "AAA",
            "l4_executable_return_pct": 0.025,
        }],
    )

    rows, price_rows = load_opb_counterfactual_inputs(
        end_date="2026-06-30",
        query_fn=lambda *_args, **_kwargs: [{"symbol": "AAA", "price_date": "2026-06-24", "close": 100.0}],
    )

    assert rows[0]["snapshot_date"] == "2026-06-24"
    assert rows[0]["actual_return_pct"] == pytest.approx(0.025)
    assert price_rows[0]["symbol"] == "AAA"


def test_fusion_counterfactual_prior_rejects_pre_v14_source_contract():
    base_payload = {
        "artifact_contract_version": "allocator-ev-fusion-contract-v14",
        "feature_semantic_version": "allocator-ev-fusion-l4-residual-overlay-day-t-causal-v1-lineage-bound",
        "expected_return_semantic": "l4_base_expected_return_plus_validated_residual_adjustment",
        "expected_return": 0.025,
        "primary_expected_return_allowed": True,
        "model_version": "fusion-v14-test",
        "trained_until": "2026-05-31",
    }
    accepted = opb_counterfactual_prior._counterfactual_expected_return(
        {"alpha_allocation": {"allocator_ev_fusion": base_payload}},
        owner="allocator_ev_fusion",
    )
    assert accepted == (0.025, "fusion-v14-test", "2026-05-31")

    rejected = opb_counterfactual_prior._counterfactual_expected_return(
        {
            "alpha_allocation": {
                "allocator_ev_fusion": {
                    **base_payload,
                    "artifact_contract_version": "allocator-ev-fusion-contract-v13",
                },
            },
        },
        owner="allocator_ev_fusion",
    )
    assert rejected == (None, None, None)

    semantic_rejected = opb_counterfactual_prior._counterfactual_expected_return(
        {"alpha_allocation": {"allocator_ev_fusion": {**base_payload, "expected_return_semantic": "legacy_absolute_fusion"}}},
        owner="allocator_ev_fusion",
    )
    assert semantic_rejected == (None, None, None)

def test_prior_resolver_requires_owner_match_and_preserves_arm_knobs():
    artifact = {
        "artifact_id": "opb_arm_prior:test",
        "model_version": "test",
        "expected_return_owner": "l4_alpha_ev",
        "source_expected_return_contract_version": "l4-alpha-ev-contract-test",
        "source_expected_return_semantic": "canonical_l4_test_semantic",
        "validation": {"decision": "PASS"},
        "arm_priors": [
            {"arm_id": arm.arm_id, "prior_reward_mean": 0.012, "prior_samples": 6}
            for arm in online_portfolio_bandit.DEFAULT_ARMS
        ],
    }
    resolved, evidence = resolve_portfolio_bandit_arms(
        artifact,
        expected_return_owner="l4_alpha_ev",
        expected_return_contract_version="l4-alpha-ev-contract-test",
        expected_return_semantic="canonical_l4_test_semantic",
    )
    assert evidence["status"] == "artifact_loaded"
    assert all(arm.prior_reward_mean == pytest.approx(0.012) for arm in resolved)
    assert all(arm.prior_samples == 6 for arm in resolved)
    assert [arm.max_weight for arm in resolved] == [arm.max_weight for arm in online_portfolio_bandit.DEFAULT_ARMS]

    fallback, mismatch = resolve_portfolio_bandit_arms(
        artifact,
        expected_return_owner="allocator_ev_fusion",
        expected_return_contract_version="allocator-ev-fusion-contract-v14",
        expected_return_semantic="l4_base_expected_return_plus_validated_residual_adjustment",
    )
    assert fallback == online_portfolio_bandit.DEFAULT_ARMS
    assert mismatch["reason"] == "expected_return_owner_mismatch"

    stale_prior, stale_evidence = resolve_portfolio_bandit_arms(
        {**artifact, "expected_return_owner": "allocator_ev_fusion"},
        expected_return_owner="allocator_ev_fusion",
        expected_return_contract_version="allocator-ev-fusion-contract-v14",
        expected_return_semantic="l4_base_expected_return_plus_validated_residual_adjustment",
    )
    assert stale_prior == online_portfolio_bandit.DEFAULT_ARMS
    assert stale_evidence["reason"] == "expected_return_contract_mismatch"
    assert stale_evidence["runtime_contract"] == "allocator-ev-fusion-contract-v14"


def test_refresh_route_promotes_only_a_pass_artifact(monkeypatch):
    artifact = {
        "artifact_id": "opb_arm_prior:test",
        "model_version": "test",
        "expected_return_owner": "l4_alpha_ev",
        "trained_until": "2026-07-02",
        "validation": {"decision": "PASS", "failed_checks": []},
        "arm_priors": [],
    }
    writes: list[dict] = []
    monkeypatch.setattr(opb_route, "load_opb_counterfactual_inputs", lambda **_: ([{}], [{}]))
    monkeypatch.setattr(opb_route, "build_opb_arm_prior_artifact", lambda *_, **__: {"status": "validated", "artifact": artifact})
    monkeypatch.setattr(opb_route, "upsert_artifact_record", lambda record: record)

    async def fake_worker_fetch(path, **kwargs):
        writes.append({"path": path, **kwargs})
        return {"ok": True}

    monkeypatch.setattr(opb_route, "worker_fetch", fake_worker_fetch)
    result = asyncio.run(opb_route.refresh_opb_arm_prior(opb_route.OpbArmPriorRefreshReq(
        end_date="2026-07-02", promote=True, dry_run=False,
    )))
    assert result["promoted"] is True
    assert writes[0]["json_body"]["alphaFramework"]["allocation"]["opbArmPrior"] == artifact
