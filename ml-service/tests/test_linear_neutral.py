from __future__ import annotations

import io

import joblib
import numpy as np
import pytest

from app import linear_neutral as ln
from app import linear_neutral_training
from app.formal_feature_contract import FEATURE131_SEMANTIC, FEATURES131
from app.industry_exposure import asof_industry, decode_industry_sidecar, encode_industry_sidecar
from app.oof_lineage import OOF_PREDICTION_SCHEMA_VERSION

from tests.challenger_fixtures import PREFIX, put_industry_sidecar, synthetic_prep


def _cohort_design(industries, log_mcap):
    labels = np.unique(industries)
    size = (log_mcap - log_mcap.mean()) / log_mcap.std()
    return np.column_stack([(industries == label).astype(float) for label in labels] + [size])


def test_residuals_are_orthogonal_to_industry_and_log_market_cap_in_every_cohort():
    rng = np.random.default_rng(0)
    n = 240
    dates = np.repeat(["2026-01-05", "2026-01-06"], n // 2)
    markets = np.tile(["LISTED", "OTC"], n // 2)
    industries = rng.choice(["a", "b", "c", "d"], size=n)
    log_mcap = rng.normal(22, 1, size=n)
    X = rng.normal(size=(n, 5)) + log_mcap[:, None] + (industries == "a")[:, None] * 2.0

    resid = ln.neutralize_cross_section(
        X, dates=dates, markets=markets, exposures=ln.EXPOSURE_SETS["industry_log_mktcap"],
        log_mcap=log_mcap, industries=industries)

    for idx in ln.cohort_groups(dates, markets):
        design = _cohort_design(industries[idx], log_mcap[idx])
        assert np.abs(design.T @ resid[idx]).max() < 1e-9
        raw = ln._centered_rank(X[idx])
        assert np.abs(raw).max() > 0.4  # residualization actually changed a non-trivial input


def test_size_only_residuals_have_zero_mean_and_zero_size_loading():
    rng = np.random.default_rng(1)
    n = 100
    dates = np.asarray(["2026-02-02"] * n)
    markets = np.asarray(["LISTED"] * n)
    log_mcap = rng.normal(22, 1, size=n)
    X = np.column_stack([log_mcap * 3 + rng.normal(size=n), rng.normal(size=n)])
    resid = ln.neutralize_cross_section(X, dates=dates, markets=markets, exposures=("log_market_cap",),
                                        log_mcap=log_mcap)
    assert np.abs(resid.sum(axis=0)).max() < 1e-9
    assert np.abs(((log_mcap - log_mcap.mean()) @ resid)).max() < 1e-8


def test_date_constant_feature_is_exactly_zero_after_neutralization():
    dates = np.asarray(["2026-02-02"] * 10 + ["2026-02-03"] * 10)
    markets = np.asarray(["LISTED"] * 20)
    X = np.column_stack([np.r_[np.full(10, 0.4), np.full(10, 0.6)], np.arange(20.0)])
    resid = ln.neutralize_cross_section(X, dates=dates, markets=markets, exposures=("log_market_cap",),
                                        log_mcap=np.linspace(20, 24, 20))
    assert np.all(resid[:, 0] == 0.0)


def test_missing_industry_fails_closed():
    with pytest.raises(ValueError, match="industry_missing"):
        ln.neutralize_cross_section(
            np.ones((3, 1)), dates=np.asarray(["d"] * 3), markets=np.asarray(["m"] * 3),
            exposures=("industry", "log_market_cap"), log_mcap=np.arange(3.0), industries=np.asarray(["a", "", "a"]))


def test_purged_blocks_never_train_on_label_windows_touching_the_test_block():
    dates = np.asarray([f"2026-03-{d:02d}" for d in range(1, 29)])
    known = np.asarray([f"2026-03-{min(d + 5, 31):02d}" for d in range(1, 29)])
    for train_idx, test_idx, report in ln.purged_date_blocks(dates, known, n_blocks=4):
        start, end = min(dates[test_idx].tolist()), max(dates[test_idx].tolist())
        last_known = max(known[test_idx].tolist())
        for i in train_idx:
            assert not (dates[i] < start and known[i] >= start)
            assert not (start <= dates[i] <= end)
            assert not (end < dates[i] <= last_known)
        assert report["purged_rows"] > 0


def test_ridge_alpha_is_the_cv_argmax_over_effective_df_candidates():
    bucket, info = synthetic_prep(n_dates=60, n_symbols=40)
    idx = np.arange(len(info["target"]))
    y = info["target"]
    model = ln.fit_linear_neutral(
        info["X"][idx], y, feature_names=list(FEATURES131), dates=info["dates"].astype(str),
        markets=info["markets"].astype(str), label_known_dates=info["label_known_dates"].astype(str),
        exposure_set="log_mktcap", inner_folds=4)
    sel = model.alpha_selection
    curve = np.asarray(sel["cv_mean_daily_rank_ic"])
    assert sel["inner_folds"] == 4
    assert sel["alpha"] == sel["alpha_candidates"][int(np.flatnonzero(curve == curve.max())[-1])]
    assert model.alpha_ == sel["alpha"]
    assert len(sel["alpha_candidates"]) > 10 and curve.max() > 0.2


def test_ridge_shrinkage_is_chosen_by_the_data_not_fixed():
    """Signal in the dominant factor -> heavy shrinkage; signal in weak directions -> light shrinkage."""

    rng = np.random.default_rng(3)
    n_dates, n = 40, 60
    day_list = [str(d) for d in np.busday_offset(np.datetime64("2026-01-05"), np.arange(n_dates + 5), roll="forward")]
    dates = np.repeat(day_list[:n_dates], n)
    known = np.repeat(day_list[5:], n)
    markets = np.asarray(["LISTED"] * len(dates))
    names = list(FEATURES131)
    factor = rng.normal(size=len(dates))
    idio = rng.normal(size=(len(dates), len(names)))
    X = factor[:, None] * 3.0 + idio

    def selected_df(y):
        return ln.fit_linear_neutral(X, y, feature_names=names, dates=dates, markets=markets,
                                     label_known_dates=known, exposure_set="log_mktcap",
                                     inner_folds=4).alpha_selection["selected_effective_df"]

    dominant = selected_df(factor + rng.normal(0, 1.0, len(dates)))
    weak = selected_df(idio[:, :60].sum(axis=1) - idio[:, 60:120].sum(axis=1) + rng.normal(0, 0.1, len(dates)))
    assert dominant < weak


def test_sidecar_asof_join_uses_only_past_snapshots_and_checks_sha():
    raw = encode_industry_sidecar(symbols=["2330", "2330", "2603"], snapshot_dates=["2026-08-01", "2026-09-01", "2026-09-01"],
                                  industries=["A", "B", "C"], pit_status="pit_snapshot", source={})
    import hashlib
    sidecar = decode_industry_sidecar(raw, expected_sha256=hashlib.sha256(raw).hexdigest())
    labels = asof_industry(np.asarray(["2330", "2330", "2330", "2603", "2603"]),
                           np.asarray(["2026-07-31", "2026-08-15", "2026-09-01", "2026-08-31", "2026-09-02"]), sidecar)
    assert labels.tolist() == ["", "A", "B", "", "C"]
    with pytest.raises(ValueError, match="checksum"):
        decode_industry_sidecar(raw, expected_sha256="0" * 64)


@pytest.fixture(autouse=True)
def _source_sha(monkeypatch):
    monkeypatch.setenv("STOCKVISION_SOURCE_SHA", "0" * 40)


def _payload(bucket, info, **extra):
    dates = info["signal_dates"]
    return {
        "gcs_prefix": PREFIX, "batch_count": info["batch_count"], "feature_semantic_version": FEATURE131_SEMANTIC,
        "feature_release_mode": "approved_full131_v1", "generation_mode": "purged_oof",
        "cohort_id": "cohort-test", "fold_id": "w0", "window_id": 0, "validation_folds": 4,
        "output_model_version": "cohort-test-w0", "label_horizon_days": 5,
        "train_start": dates[0], "train_end": dates[59], "test_start": dates[65], "test_end": dates[79],
        **extra,
    }


@pytest.mark.parametrize("exposure_set,model_name", [("log_mktcap", "LinearNeutralSize"),
                                                    ("industry_log_mktcap", "LinearNeutral")])
def test_fold_oof_and_artifact_match_the_tree_trainer_formats(monkeypatch, exposure_set, model_name):
    bucket, info = synthetic_prep()
    monkeypatch.setattr("app.model_store._get_bucket", lambda: bucket)
    extra = {"neutralization_exposures": exposure_set}
    if exposure_set == "industry_log_mktcap":
        # First PIT snapshot lands mid-train: earlier rows must be excluded, not backfilled.
        extra["industry_exposure"] = put_industry_sidecar(bucket, info, snapshot_dates=[info["signal_dates"][20]])
    result = linear_neutral_training.train_linear_neutral_universal(_payload(bucket, info, **extra))

    reg = result["artifact_registrations"][model_name]
    assert reg["gcs_path"] == f"{PREFIX}/frozen_models/{model_name.lower()}/cohort-test-w0.joblib"
    assert reg["promotion_eligible"] is False
    meta = __import__("json").loads(bucket.blob(reg["metadata_path"]).download_as_text())
    assert meta["schema_version"] == "model-artifact-v2" and meta["model_name"] == model_name
    assert meta["feature_names"] == list(FEATURES131)
    assert meta["challenger"]["roster_member"] is False
    assert meta["linear_neutral"]["alpha_selection"]["method"] == ln.ALPHA_SELECTION_METHOD

    oof = result["oof_artifact"]
    assert oof["path"] == f"{PREFIX}/oof/cohort-test/w0/{model_name.lower()}.npz"
    assert oof["schema_version"] == OOF_PREDICTION_SCHEMA_VERSION and oof["model_name"] == model_name
    data = np.load(io.BytesIO(bucket.blob(oof["path"]).download_as_bytes()), allow_pickle=True)
    assert set(data.files) >= {"raw_scores", "rank_scores", "targets", "dates", "symbols", "markets", "label_known_dates"}
    assert min(data["dates"].tolist()) >= info["signal_dates"][65]
    assert result["ic_tracking"][model_name]["oos_ic"] > 0.2

    model = joblib.load(io.BytesIO(bucket.blob(reg["gcs_path"]).download_as_bytes()))
    mask = np.isin(info["dates"].astype(str), data["dates"]) & np.isin(info["symbols"].astype(str), data["symbols"])
    order = np.lexsort((info["symbols"][mask].astype(str), info["dates"][mask].astype(str)))
    industries = None
    if exposure_set == "industry_log_mktcap":
        industries = np.asarray([info["industry_of"][s] for s in info["symbols"][mask]])[order]
        assert result["exposure_coverage"]["industry"]["first_labelled_date"] == info["signal_dates"][20]
    replay = model.predict(info["X"][mask][order], dates=info["dates"][mask][order].astype(str),
                           markets=info["markets"][mask][order].astype(str), industries=industries)
    saved_order = np.lexsort((data["symbols"], data["dates"]))
    assert np.allclose(replay, data["raw_scores"][saved_order])


def test_full_fit_writes_universal_challenger_artifact_without_oof(monkeypatch):
    bucket, info = synthetic_prep()
    monkeypatch.setattr("app.model_store._get_bucket", lambda: bucket)
    payload = _payload(bucket, info, neutralization_exposures="log_mktcap", generation_mode="oof_full_fit_release",
                       as_of_date=max(info["label_known_dates"].astype(str).tolist()))
    for key in ("train_start", "train_end", "test_start", "test_end"):
        payload.pop(key)
    result = linear_neutral_training.train_linear_neutral_universal(payload)
    assert result["artifact_registrations"]["LinearNeutralSize"]["gcs_path"] == "universal/linearneutralsize/cohort-test-w0.joblib"
    assert result["oof_artifact"] is None and result["train_samples"] == len(info["target"])


def test_requires_explicit_exposure_set_and_folds(monkeypatch):
    bucket, info = synthetic_prep(n_symbols=10)
    monkeypatch.setattr("app.model_store._get_bucket", lambda: bucket)
    with pytest.raises(ValueError, match="exposure_set_invalid"):
        linear_neutral_training.train_linear_neutral_universal(_payload(bucket, info))
    with pytest.raises(ValueError, match="model_name_exposure_mismatch"):
        linear_neutral_training.train_linear_neutral_universal(
            _payload(bucket, info, neutralization_exposures="log_mktcap", model_name="LinearNeutral"))
    with pytest.raises(ValueError, match="validation_folds"):
        linear_neutral_training.train_linear_neutral_universal(
            _payload(bucket, info, neutralization_exposures="log_mktcap", validation_folds=None))


@pytest.mark.parametrize("snapshot_index,pit_status,expected_model,reason", [
    (None, None, "LinearNeutralSize", "no_industry_sidecar"),
    (20, "pit_snapshot", "LinearNeutralSize", "pit_snapshots_start_after_window"),
    (0, "rule_inferred_backfill", "LinearNeutralSize", "sidecar_not_pit:rule_inferred_backfill"),
    (0, "pit_snapshot", "LinearNeutral", "pit_snapshots_cover_window"),
])
def test_auto_exposure_switches_to_industry_only_when_pit_snapshots_cover_the_window(
        monkeypatch, snapshot_index, pit_status, expected_model, reason):
    bucket, info = synthetic_prep()
    monkeypatch.setattr("app.model_store._get_bucket", lambda: bucket)
    extra = {"neutralization_exposures": "auto"}
    if snapshot_index is not None:
        extra["industry_exposure"] = put_industry_sidecar(
            bucket, info, snapshot_dates=[info["signal_dates"][snapshot_index]], pit_status=pit_status)
    result = linear_neutral_training.train_linear_neutral_universal(_payload(bucket, info, **extra))
    assert result["model"] == expected_model
    coverage = result["exposure_coverage"]
    assert coverage["requested_exposure_set"] == "auto"
    assert coverage["auto_resolution"]["reason"] == reason
    assert result["oof_artifact"]["path"].endswith(f"/{expected_model.lower()}.npz")
    assert (coverage["industry"] is None) == (expected_model == "LinearNeutralSize")


def test_auto_exposure_rejects_a_caller_chosen_model_name(monkeypatch):
    bucket, info = synthetic_prep(n_symbols=10)
    monkeypatch.setattr("app.model_store._get_bucket", lambda: bucket)
    with pytest.raises(ValueError, match="auto_exposure_resolves_model_name"):
        linear_neutral_training.train_linear_neutral_universal(
            _payload(bucket, info, neutralization_exposures="auto", model_name="LinearNeutral"))
