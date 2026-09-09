from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))


def _rows():
    from services.active8_oof_stacker import ACTIVE8_MODELS

    rows = []
    folds = [
        ("w1", "2026-01-01", ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"], "2026-01-16"),
        ("w2", "2026-01-20", ["2026-01-28"], "2026-02-04"),
    ]
    for fold_id, test_start, prediction_dates, known_date in folds:
        for idx in range(520):
            prediction_date = prediction_dates[idx % len(prediction_dates)]
            target = ((idx % 21) - 10) / 1000
            for model_idx, model in enumerate(ACTIVE8_MODELS):
                rows.append({
                    "fold_id": fold_id,
                    "prediction_date": prediction_date,
                    "symbol": f"S{idx:04d}",
                    "market_segment": "TW",
                    "model_name": model,
                    "rank_score": ((idx + model_idx) % 520) / 519,
                    "target_return": target,
                    "label_known_date": known_date,
                    "artifact_version": f"{model}-oof-{fold_id}",
                    "test_start": test_start,
                    "test_end": prediction_dates[-1],
                })
    return rows


def test_stacker_never_uses_current_fold_targets_for_its_weights():
    from services.active8_oof_stacker import build_chronological_oof_stack

    output, evidence = build_chronological_oof_stack(_rows())
    by_fold = {row["fold_id"]: row for row in evidence["folds"]}
    assert by_fold["w1"]["source"] == "warmup_equal_weight_baseline"
    assert by_fold["w1"]["train_rows"] == 0
    assert by_fold["w2"]["source"] == "chronological_resolved_oof_nonnegative_ridge"
    assert by_fold["w2"]["train_rows"] == 520
    assert all(0.0 <= row["ensemble_rank"] <= 1.0 for row in output)


def test_stacker_keeps_partial_sequence_candidate_and_reports_availability():
    from services.active8_oof_stacker import build_chronological_oof_stack

    rows = _rows()
    rows.pop()
    output, evidence = build_chronological_oof_stack(rows)

    assert len(output) == 1040
    assert evidence["incomplete_candidate_rows"] == 1
    assert evidence["partial_candidate_rows_used"] == 1
    assert evidence["rejected_core_model_rows"] == 0
    assert evidence["missing_by_model"] == {"iTransformer": 1}
    assert evidence["complete_candidate_coverage"] < 1.0
    partial = next(row for row in output if row["fold_id"] == "w2" and row["symbol"] == "S0519")
    assert partial["model_availability"]["iTransformer"] is False
    assert "iTransformer" not in partial["artifact_versions"]


def test_stacker_rejects_duplicate_model_lineage():
    import pytest

    from services.active8_oof_stacker import build_chronological_oof_stack

    rows = _rows()
    rows.append(dict(rows[0]))
    with pytest.raises(ValueError, match="active8_oof_duplicate_model_rows"):
        build_chronological_oof_stack(rows)


def test_stacker_accepts_float32_target_noise_but_rejects_material_drift():
    import pytest

    from services.active8_oof_stacker import build_chronological_oof_stack

    rows = _rows()
    rows[0]["target_return"] += 1e-7
    _output, evidence = build_chronological_oof_stack(rows)
    assert 0 < evidence["max_target_lineage_drift"] < evidence["target_agreement_tolerance"]

    rows[0]["target_return"] += 1e-4
    with pytest.raises(ValueError, match="active8_oof_target_lineage_disagreement"):
        build_chronological_oof_stack(rows)


def test_stacker_rejects_candidate_missing_core_cross_sectional_model():
    from services.active8_oof_stacker import build_chronological_oof_stack

    rows = _rows()
    rows = [
        row for row in rows
        if not (
            row["fold_id"] == "w2"
            and row["symbol"] == "S0519"
            and row["model_name"] == "LightGBM"
        )
    ]
    output, evidence = build_chronological_oof_stack(rows)

    assert len(output) == 1039
    assert evidence["rejected_core_model_rows"] == 1
    assert all(row["symbol"] != "S0519" for row in output if row["fold_id"] == "w2")


def test_spearman_and_rank_paths_preserve_ties_and_match_serving_semantics():
    import numpy as np

    from services.active8_oof_stacker import _rank_by_date_market, _spearman
    from services.active8_score_semantics import _percentile_by_average_rank

    assert _spearman(np.ones(6), np.arange(6, dtype=float)) == 0.0
    rows = [
        {"prediction_date": "2026-08-24", "market_segment": "TW", "symbol": symbol, "ensemble_raw": 0.3}
        for symbol in ["C", "A", "B"]
    ]
    _rank_by_date_market(rows)
    assert {row["ensemble_rank"] for row in rows} == {0.5}
    serving = _percentile_by_average_rank([(row["symbol"], row["ensemble_raw"]) for row in rows])
    assert {value for value in serving.values()} == {0.5}
    assert {row["symbol"]: row["ensemble_rank"] for row in rows} == serving


def _inner_panel():
    import numpy as np

    # Unequal rows per date and shuffled input catch accidental row-based gaps.
    dates = np.repeat([f"2026-01-{day:02d}" for day in range(1, 11)], range(25, 35))
    known = np.asarray([f"2026-01-{int(day[-2:]) + 2:02d}" for day in dates])
    order = np.random.default_rng(42).permutation(len(dates))
    x = np.zeros((len(dates), 16))
    y = np.arange(len(dates), dtype=float)
    return x[order], y[order], dates[order], np.full(len(dates), "TW"), known[order]


def test_both_inner_tuning_passes_purge_labels_at_and_after_validation_start(monkeypatch):
    import numpy as np
    import services.active8_oof_stacker as stacker

    x, y, dates, markets, known = _inner_panel()
    calls = []

    def fit(features, target, regularization, *, active_models=None):
        calls.append((target.copy(), active_models))
        weights = np.zeros(16)
        weights[:2] = 1.0
        return weights, 0.0

    monkeypatch.setattr(stacker, "_fit_ridge", fit)
    stacker._fit_selected_ridge(x, y, dates, markets, label_known_dates=known)
    expected = y[(dates < "2026-01-09") & (known < "2026-01-09")]
    assert len(expected) >= 100
    assert np.any(known == "2026-01-09")
    # Four lambda fits, then full training fit, repeated for the selected subset.
    assert len(calls) == 10
    for index in (0, 1, 2, 3, 5, 6, 7, 8):
        np.testing.assert_array_equal(calls[index][0], expected)
        assert calls[index][1] == (None if index < 5 else stacker.ACTIVE8_MODELS[:2])
    for index in (4, 9):
        np.testing.assert_array_equal(calls[index][0], y)


def test_inner_tuning_falls_back_after_purge_without_fitting_unresolved_targets(monkeypatch):
    import numpy as np
    import services.active8_oof_stacker as stacker

    x, y, dates, markets, known = _inner_panel()
    known[:] = "2026-02-01"

    def unexpected_fit(*args, **kwargs):
        raise AssertionError("insufficient purged rows must use the fixed fallback")

    monkeypatch.setattr(stacker, "_fit_ridge", unexpected_fit)
    assert stacker._select_regularization(
        x, y, dates, markets, label_known_dates=known
    ) == 1.0


def test_inner_tuning_requires_complete_label_maturity():
    import pytest
    import services.active8_oof_stacker as stacker

    x, y, dates, markets, known = _inner_panel()
    with pytest.raises(TypeError, match="label_known_dates"):
        stacker._select_regularization(x, y, dates, markets)
    with pytest.raises(ValueError, match="shape_mismatch"):
        stacker._select_regularization(x, y, dates, markets, label_known_dates=known[:-1])
    missing = known.astype(object)
    missing[0] = None
    with pytest.raises(ValueError, match="date_missing"):
        stacker._select_regularization(x, y, dates, markets, label_known_dates=missing)
    with pytest.raises(ValueError, match="not_after_prediction"):
        stacker._select_regularization(x, y, dates, markets, label_known_dates=dates)


def test_chronological_stacker_passes_actual_label_maturity(monkeypatch):
    import numpy as np
    import services.active8_oof_stacker as stacker

    original = stacker._fit_selected_ridge
    calls = []

    def capture(x, y, dates, markets, *, label_known_dates):
        calls.append(label_known_dates.copy())
        assert np.all(label_known_dates == "2026-01-16")
        return original(x, y, dates, markets, label_known_dates=label_known_dates)

    monkeypatch.setattr(stacker, "_fit_selected_ridge", capture)
    _, evidence = stacker.build_chronological_oof_stack(_rows())
    assert len(calls) == 1
    assert len(calls[0]) == 520
    assert evidence["inner_tuning_policy"] == stacker.INNER_TUNING_POLICY
