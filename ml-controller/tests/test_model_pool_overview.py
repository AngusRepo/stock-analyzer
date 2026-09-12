import json
import pytest
from services.model_pool_overview import cohort_progress, load_model_pool_overview


def receipt(mature="2026-09-01"):
    return {"cohort_id": "cohort-1", "cadence": "daily", "knowledge_cutoff_date": "2026-09-08",
            "calendar": {"mature_max_date": mature}, "status": "materialized",
            "physical_prediction_coverage": {"base_max_date": "2026-09-01"}}


def test_maturity_frontier_proves_zero_but_cannot_invent_trading_day_count():
    assert cohort_progress(receipt(), "cohort-1", "source")["pending_mature_dates"] == 0
    assert cohort_progress(receipt("2026-09-04"), "cohort-1", "source")["pending_mature_dates"] is None
    with pytest.raises(ValueError):
        cohort_progress(receipt("invalid"), "cohort-1", "source")
    with pytest.raises(ValueError, match="identity_mismatch"):
        cohort_progress(receipt(), "another-cohort", "source")


class Blob:
    name = "walk_forward/oof_cohorts/cohort-1/lifecycle/2026-09-08.daily.json"
    def download_as_text(self, **kwargs):
        return json.dumps(receipt())


class Bucket:
    def list_blobs(self, **kwargs):
        assert kwargs["prefix"] == "walk_forward/oof_cohorts/cohort-1/lifecycle/"
        return [Blob()]


def bundle():
    return {"artifact_id": "ensemble-1", "cohort_id": "cohort-1", "observability": {
        "feature_names": ["TabM.rank", "GNN.rank", "TabM.available"],
        "fit": {"coefficients": [0.2, 0, -0.1]}, "validation": {"decision": "PASS"}}}


def test_read_only_projection_is_bound_to_bundle_and_ignores_availability_coefficients():
    result = load_model_pool_overview(bundle(), Bucket())
    assert result["bundle_artifact_id"] == "ensemble-1"
    assert result["rank_coefficients"] == {"TabM": 0.2, "GNN": 0}
    assert result["cohort"]["as_of"] == "2026-09-08"
    assert result["cohort"]["pending_mature_dates"] == 0


def test_receipt_read_failure_does_not_destroy_bundle_metadata_or_expose_error():
    class Broken:
        def list_blobs(self, **kwargs):
            raise RuntimeError("sensitive backend detail")
    result = load_model_pool_overview(bundle(), Broken())
    assert result["rank_coefficients"]["TabM"] == 0.2
    assert result["cohort"]["status"] == "unavailable"
    assert result["cohort"]["pending_mature_dates"] is None
    assert "sensitive" not in json.dumps(result)


def test_truncated_listing_is_unknown_not_a_stale_success():
    class Truncated:
        def list_blobs(self, **kwargs):
            return [Blob()] * 101
    assert load_model_pool_overview(bundle(), Truncated())["cohort"]["status"] == "unavailable"
