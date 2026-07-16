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
    assert by_fold["w2"]["source"] == "chronological_prior_oof_ridge"
    assert by_fold["w2"]["train_rows"] == 520
    assert all(0.0 <= row["ensemble_rank"] <= 1.0 for row in output)


def test_stacker_rejects_partial_active8_candidate_instead_of_silently_dropping_it():
    import pytest

    from services.active8_oof_stacker import build_chronological_oof_stack

    rows = _rows()
    rows.pop()
    with pytest.raises(ValueError, match="active8_oof_incomplete_active8_rows"):
        build_chronological_oof_stack(rows)


def test_stacker_rejects_duplicate_model_lineage():
    import pytest

    from services.active8_oof_stacker import build_chronological_oof_stack

    rows = _rows()
    rows.append(dict(rows[0]))
    with pytest.raises(ValueError, match="active8_oof_duplicate_model_rows"):
        build_chronological_oof_stack(rows)
