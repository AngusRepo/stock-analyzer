import json

from services.alpha_evidence_runner import run_parameter_candidate_evidence


def _metrics(label: str) -> dict:
    base = 0.012 if label == "candidate" else 0.004
    trades = [
        {"profit_ratio": base + (i % 3) * 0.001, "entry_regime": ["bull", "volatile", "sideways", "bear"][i % 4]}
        for i in range(80)
    ]
    partitions = [base + i * 0.0005 for i in range(8)]
    return {
        "end_date": "2026-05-22",
        "mode": "B",
        "total_trades": 80,
        "trades": trades,
        "partition_returns": partitions,
        "sharpe": 1.2 if label == "candidate" else 0.5,
        "profit_factor": 1.4 if label == "candidate" else 1.1,
        "max_drawdown": 0.08 if label == "candidate" else 0.11,
        "absolute_confidence": "moderate",
        "sanity_flags": [],
    }


def test_parameter_candidate_evidence_bundle_is_candidate_specific():
    calls: list[dict] = []

    def fake_replay(**kwargs):
        calls.append(kwargs)
        params = kwargs.get("params") or {}
        return _metrics("candidate" if params.get("sltp", {}).get("slMultBase") == 1.2 else "champion")

    evidence = run_parameter_candidate_evidence(
        {
            "id": "parameter:sltp:test",
            "config": {"sltp": {"slMultBase": 1.2}},
        },
        start_date="2026-01-01",
        end_date="2026-05-22",
        baseline_config={"sltp": {"slMultBase": 1.0}},
        parity_audit={"worker_parity": {"decision": "PASS"}},
        dataset_loader=lambda **_: "dataset",
        replay_fn=fake_replay,
    )

    assert len(calls) == 2
    assert evidence["candidate_id"] == "parameter:sltp:test"
    assert evidence["backtest"]["mode"] == "B"
    assert evidence["pbo"]["method"] == "cscv_rank_logit"
    assert evidence["walk_forward"]["method"] == "paired_partition_walk_forward"
    assert evidence["gate"]["inputs"]["candidate_id"] == "parameter:sltp:test"


def test_parameter_candidate_evidence_preserves_mode_b_replay_funnel():
    def fake_replay(**kwargs):
        return {
            "end_date": "2026-05-22",
            "mode": "B",
            "total_trades": 0,
            "trades": [],
            "partition_returns": [],
            "sharpe": 0.0,
            "profit_factor": 0.0,
            "max_drawdown": 0.0,
            "absolute_confidence": "moderate",
            "sanity_flags": ["n_trades=0 < 30"],
            "entry_attempts": 174,
            "entries_filled": 0,
            "fill_rate": 0.0,
            "skip_reasons": {"skipped_no_ml_pred": 142, "skipped_low_conf": 32},
            "mode_b_prediction_diagnostics": {
                "cache_size": 1035,
                "source_counts": {"predictions.direction_accuracy_legacy": 1035},
            },
            "mode_b_threshold_diagnostics": {
                "buy_conf_threshold": 0.6,
                "source": "fallback_default",
            },
        }

    evidence = run_parameter_candidate_evidence(
        {
            "id": "parameter:screener:test",
            "config": {"screener": {"minAvgVolume": 350000}},
        },
        start_date="2026-02-21",
        end_date="2026-05-22",
        baseline_config={"screener": {"minAvgVolume": 300000}},
        parity_audit={"worker_parity": {"decision": "MISSING", "source": "validation_chain"}},
        dataset_loader=lambda **_: "dataset",
        replay_fn=fake_replay,
    )

    backtest = evidence["backtest"]
    assert backtest["entry_attempts"] == 174
    assert backtest["entries_filled"] == 0
    assert backtest["skip_reasons"] == {"skipped_no_ml_pred": 142, "skipped_low_conf": 32}
    assert backtest["mode_b_prediction_diagnostics"]["cache_size"] == 1035
    assert backtest["mode_b_threshold_diagnostics"]["source"] == "fallback_default"

    raw = json.loads(backtest["raw_results"])
    assert raw["skip_reasons"]["skipped_no_ml_pred"] == 142
