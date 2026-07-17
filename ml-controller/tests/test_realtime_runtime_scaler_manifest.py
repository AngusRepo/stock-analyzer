from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_realtime_scaler_manifests_are_single_owner_and_fail_closed():
    for name in ("realtime-runtime-min-1.job.yaml", "realtime-runtime-min-0.job.yaml"):
        source = (ROOT / "infra" / name).read_text(encoding="utf-8")
        assert "shioaji-proxy stockvision-execution-gateway" in source
        assert "run.googleapis.com/minScale" in source
        assert "autoscaling.knative.dev/minScale" in source
        assert "revision_level_min_present" in source
        assert "traffic_tag_present" in source
        assert "latest_revision_parity_failed" in source
        assert "live_submit_not_disabled" in source
        assert "--min-instances" not in source
        assert "--tag" not in source


def test_ml_controller_deploy_preserves_service_level_scaling_only():
    source = (ROOT / "deploy_ml_controller.sh").read_text(encoding="utf-8")
    assert 'service_annotations.get("run.googleapis.com/minScale", "0")' in source
    assert 'service_annotations.get("run.googleapis.com/maxScale", "5")' in source
    assert '--min="${LIVE_SERVICE_MIN_SCALE:-0}"' in source
    assert '--max="${LIVE_SERVICE_MAX_SCALE:-5}"' in source
    assert "REVISION_MIN_SCALE" in source
