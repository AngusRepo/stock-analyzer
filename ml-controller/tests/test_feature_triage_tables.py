"""The three feature-triage tables have a producer, and their inputs follow the configured window.

Round 3 of the 2026-11-24 pymoo audit: finlab701_triage_best_by_field.csv,
finlab701_recommended_keep_candidates.csv and strategy95_vs_ml106_full_mapping.csv were committed in
05b5cfbc without a producer, and the triage consumers hard-coded the 20230101_20260615 window stem.
Every test fails on origin/main 69aaf527 (no producer, no window helper, stems hard-coded).
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def producer():
    return _load(TOOLS / "build_feature_triage_tables.py", "stockvision_triage_tables_producer")


@pytest.fixture(scope="module")
def window():
    return _load(TOOLS / "feature_triage_window.py", "stockvision_triage_window_helper")


def _csv_text(frame) -> str:
    return frame.to_csv(index=False, lineterminator="\n")


def test_finlab701_tables_are_reproduced_from_the_augment701_backtest(producer, window):
    paths = window.triage_paths()
    triage, keep = producer.build_finlab701(producer._read(paths["augment701_best"]))
    assert _csv_text(triage) == producer.FINLAB701_TRIAGE.read_text(encoding="utf-8-sig")
    assert _csv_text(keep) == producer.FINLAB701_KEEP.read_text(encoding="utf-8-sig")
    assert len(keep) == 86
    assert set(keep["decision"]) == {"keep_as_chip_candidate", "keep_as_transform_candidate_not_raw_selector"}


def test_strategy95_mapping_reproduces_rows_and_fails_closed_without_a_backtest_row(producer, window):
    paths = window.triage_paths()
    nearest = producer._read(paths["overlap_nearest"])
    strategy_best = producer._read(paths["strategy95_best"])
    ml_best = producer._read(paths["ml106_best"])
    params = json.loads(paths["overlap_json"].read_text(encoding="utf-8-sig"))["parameters"]

    present = nearest[nearest["strategy_factor"].isin(set(strategy_best["factor_id"]))]
    built = _csv_text(producer.build_strategy95_mapping(present, strategy_best, ml_best, params)).splitlines()
    committed = producer.STRATEGY95_MAPPING.read_text(encoding="utf-8-sig").splitlines()
    assert built[0] == committed[0]
    committed_by_factor = {line.split(",", 1)[0]: line for line in committed[1:]}
    assert len(built) - 1 == len(present) > 0
    for line in built[1:]:
        assert committed_by_factor[line.split(",", 1)[0]] == line

    # A factor in the overlap run without a strategy95 backtest row must not default to "watch".
    with pytest.raises(ValueError, match="strategy95_mapping_inputs_incomplete"):
        producer.build_strategy95_mapping(nearest, strategy_best.iloc[1:], ml_best, params)


def test_triage_inputs_follow_the_configured_window(window, tmp_path):
    config = json.loads(window.MONTHLY_MINING_CONFIG_PATH.read_text(encoding="utf-8-sig"))
    config["research_protocol"]["feature_triage_window"] = {"start": "2023-01-01", "end": "2025-08-05"}
    path = tmp_path / "config.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    stem = window.window_stem(*window.triage_window(path))
    assert stem == "20230101_20250805"
    for value in window.triage_paths(stem).values():
        assert "20230101_20250805" in value.name

    # The current config still names the window the committed backtests were run on.
    assert window.window_stem(*window.triage_window()) == "20230101_20260615"
    assert window.triage_paths()["augment701_best"].exists()


@pytest.mark.parametrize(
    "tool",
    ["finlab_alpha_miner_bakeoff.py", "build_unified_feature_registry.py", "merge_unified179_feature_backtest_report.py"],
)
def test_triage_consumers_do_not_hardcode_the_window_stem(tool):
    source = (TOOLS / tool).read_text(encoding="utf-8")
    assert "20230101_20260615" not in source
    assert "feature_triage_window" in source
