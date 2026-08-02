from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pandas as pd
import pytest


ROOT = Path(__file__).resolve().parents[2]
MINER_PATH = ROOT / "tools" / "finlab_alpha_miner_bakeoff.py"
SPEC = importlib.util.spec_from_file_location("stockvision_pymoo_labeler_v2_test", MINER_PATH)
assert SPEC is not None and SPEC.loader is not None
miner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = miner
SPEC.loader.exec_module(miner)


def test_labeler_v2_labels_every_l0_candidate_without_fixed_top_k():
    index = pd.to_datetime(["2026-07-30", "2026-07-31"])
    columns = ["A", "B", "C", "D", "E"]
    score = pd.DataFrame(
        [[1, 2, 3, 4, 5], [5, 4, 3, 2, 1]],
        index=index,
        columns=columns,
        dtype=float,
    )
    tradable = pd.DataFrame(True, index=index, columns=columns)

    labels = miner._labels_from_score(score, 0.60, tradable)
    metrics = miner._label_matrix_metrics(labels, tradable)

    assert labels.shape == score.shape
    assert all(dtype == bool for dtype in labels.dtypes)
    assert labels.sum(axis=1).tolist() == [3, 3]
    assert metrics["label_scope"] == "all_l0_candidates"
    assert metrics["eligible_cell_count"] == 10
    assert metrics["positive_label_count"] == 6
    assert metrics["positive_label_rate"] == pytest.approx(0.6)
    assert metrics["label_entropy"] > 0.0


def test_label_matrix_novelty_penalizes_duplicate_label_behavior():
    index = pd.date_range("2026-07-01", periods=10, freq="D")
    labels_a = pd.DataFrame(
        [[True, False, True, False]] * 10,
        index=index,
        columns=list("ABCD"),
    )
    labels_b = ~labels_a
    signature_a = miner._label_signature(labels_a)
    signature_b = miner._label_signature(labels_b)

    assert miner._label_matrix_novelty(signature_a, []) == 1.0
    assert miner._label_matrix_novelty(signature_a, [signature_a]) == 0.0
    assert miner._label_matrix_novelty(signature_b, [signature_a]) == 1.0


def test_monthly_config_runs_v1_control_and_v2_labeler_in_parallel_shadow():
    config = json.loads(
        (ROOT / "data" / "feature_registry" / "pymoo_monthly_mining_config_v1.json").read_text(
            encoding="utf-8"
        )
    )

    assert config["defaults"]["pymoo_search_mode"] == "parallel_shadow"
    assert config["labeler_search_v2"]["label_scope"] == "all_l0_candidates"
    assert config["labeler_search_v2"]["v1_control_retained"] is True
    assert config["labeler_search_v2"]["promotion_effect"].startswith("none_until")
