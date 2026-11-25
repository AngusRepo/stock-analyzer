"""The feature-triage window shared by the triage producers and their consumers.

The window lives in the monthly mining config (research_protocol.feature_triage_window). Every
triage artifact name carries it as `<start>_<end>` (YYYYMMDD), so a rebuild on a new window
changes the paths in one place instead of in each tool.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MONTHLY_MINING_CONFIG_PATH = ROOT / "data" / "feature_registry" / "pymoo_monthly_mining_config_v1.json"


def triage_window(config_path: Path = MONTHLY_MINING_CONFIG_PATH) -> tuple[str, str]:
    config = json.loads(Path(config_path).read_text(encoding="utf-8-sig"))
    window = (config.get("research_protocol") or {}).get("feature_triage_window") or {}
    start, end = str(window.get("start") or ""), str(window.get("end") or "")
    if not start or not end:
        raise ValueError(f"feature_triage_window_missing:{config_path}")
    return start, end


def window_stem(start: str, end: str) -> str:
    return f"{start.replace('-', '')}_{end.replace('-', '')}"


def triage_paths(stem: str | None = None, *, universe: str = "sii") -> dict[str, Path]:
    stem = stem or window_stem(*triage_window())
    out = ROOT / "output"
    return {
        "augment701_best": out / "finlab_augment701_backtests" / f"finlab701_{universe}_{stem}_top10_bothdir_best.csv",
        "augment701_audits": out / "finlab_augment701_backtests" / f"finlab701_{universe}_{stem}_top10_bothdir_audits.csv",
        "strategy95_best": out / "finlab_strategy95_backtests" / f"strategy95_factors_{universe}_{stem}_top10_bothdir_best.csv",
        "ml106_best": out / "finlab_ml_feature_backtests" / f"ml106_features_{universe}_{stem}_top10_bothdir_best.csv",
        "overlap_json": out / "feature_strategy_overlap_numeric" / f"feature_strategy_overlap_{universe}_{stem}.json",
        "overlap_nearest": out / "feature_strategy_overlap_numeric" / f"feature_strategy_overlap_{universe}_{stem}_nearest.csv",
        "overlap_pairs": out / "feature_strategy_overlap_numeric" / f"feature_strategy_overlap_{universe}_{stem}_pairs_ge_0_6.csv",
    }
