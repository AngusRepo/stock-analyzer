from app.research_model_benchmark_runtime import run_research_model_benchmark


def test_research_model_benchmark_runtime_supports_sequence_upgrade_candidates_with_executor_result():
    for candidate_id in [
        "DLinear",
        "DartsDLinear",
        "PatchTST",
        "iTransformer",
        "TimesFM",
        "TimesFM25",
    ]:
        result = run_research_model_benchmark({
            "candidate_id": candidate_id,
            "experiment_id": "exp-sequence-upgrade",
            "executor_result": {
                "fold_metrics": [{"fold_id": "w1", "oos_ic": 0.01, "test_rows": 30, "coverage": 1.0}],
                "pbo": 0.0,
                "cost_sensitivity": {"status": "available"},
                "data_slice_report": {"status": "available"},
            },
        })

        assert result["candidate_id"] == candidate_id
        assert result["experiment_id"] == "exp-sequence-upgrade"
        assert result["status"] == "available"


def test_research_model_benchmark_runtime_fails_closed_for_unknown_candidate():
    result = run_research_model_benchmark({"candidate_id": "UnknownModel"})

    assert result["status"] == "blocked"
    assert "unknown_benchmark_candidate" in result["blockers"]
