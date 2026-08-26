from modal_app import _run_active8_sequence_shadow_candidates


def _identity():
    return {
        "version": "vCandidate",
        "artifact_id": "PatchTST:vCandidate:monthly_release",
        "artifact_path": "universal/patchtst/vCandidate.zip",
        "metadata_path": "registry-metadata/patchtst-vCandidate.json",
        "checksum": "sha256:" + "a" * 64,
    }


def test_sequence_shadow_candidate_is_zero_weight_and_exact_identity():
    identity = _identity()

    def predictor(*, series_list, horizon_used, version, artifact_identity):
        assert horizon_used == 5
        assert version == identity["version"]
        assert artifact_identity == {"model": "PatchTST", **identity}
        return [
            {"symbol": row["symbol"], "forecast_pct": float(index)}
            for index, row in enumerate(series_list)
        ]

    result = _run_active8_sequence_shadow_candidates(
        candidate_series_by_model={
            "PatchTST": [{"symbol": "2330"}, {"symbol": "2317"}],
        },
        candidate_entries={
            "PatchTST": {"candidate_type": "monthly_release"},
        },
        candidate_identities={"PatchTST": identity},
        predictors={"PatchTST": predictor},
    )

    assert result["production_effect"] is False
    assert result["vote_weight"] == 0.0
    candidate = result["candidates"]["PatchTST"]
    assert candidate["status"] == "complete"
    assert candidate["identity"] == identity
    assert candidate["n_success"] == 2
    assert {row["symbol"] for row in candidate["results"]} == {"2330", "2317"}
    assert all(row["production_effect"] is False for row in candidate["results"])
    assert all(row["vote_weight"] == 0.0 for row in candidate["results"])
    assert all(row["artifact_id"] == identity["artifact_id"] for row in candidate["results"])
    assert all(row["artifact_checksum"] == identity["checksum"] for row in candidate["results"])


def test_sequence_shadow_candidate_fails_closed_on_partial_cardinality():
    identity = _identity()

    def partial_predictor(**_kwargs):
        return [{"symbol": "2330", "forecast_pct": 0.1}]

    result = _run_active8_sequence_shadow_candidates(
        candidate_series_by_model={
            "PatchTST": [{"symbol": "2330"}, {"symbol": "2317"}],
        },
        candidate_entries={
            "PatchTST": {"candidate_type": "monthly_release"},
        },
        candidate_identities={"PatchTST": identity},
        predictors={"PatchTST": partial_predictor},
    )

    candidate = result["candidates"]["PatchTST"]
    assert candidate["status"] == "failed"
    assert candidate["results"] == []
    assert "candidate_sequence_result_cardinality_mismatch" in candidate["error"]
