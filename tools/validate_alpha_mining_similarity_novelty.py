from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "tools" / "finlab_alpha_miner_bakeoff.py"
DEFAULT_OUTPUT = ROOT / "output" / "feature_universe_triage" / "alpha_mining_similarity_novelty_validation_20260618.json"


def _load_module():
    spec = importlib.util.spec_from_file_location("stockvision_alpha_miner_bakeoff_validate", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot_load_module:{MODULE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def build_validation_payload() -> dict[str, object]:
    miner = _load_module()
    pair_map = {
        miner._pair_key("factor_a", "factor_b"): 0.95,
        miner._pair_key("factor_a", "factor_c"): 0.12,
        miner._pair_key("factor_c", "factor_d"): 0.20,
    }
    feature_meta = {}

    high_dup = miner._similarity_adjusted_novelty(
        ["factor_a", "factor_b"],
        [],
        base_novelty=1.0,
        pair_map=pair_map,
        feature_meta=feature_meta,
    )
    low_dup = miner._similarity_adjusted_novelty(
        ["factor_a", "factor_c"],
        [],
        base_novelty=0.70,
        pair_map=pair_map,
        feature_meta=feature_meta,
    )
    archive_dup = miner._similarity_adjusted_novelty(
        ["factor_a", "factor_c"],
        [{"factor_b"}],
        base_novelty=0.80,
        pair_map=pair_map,
        feature_meta=feature_meta,
    )
    missing_pair = miner._similarity_adjusted_novelty(
        ["factor_e", "factor_f"],
        [],
        base_novelty=1.0,
        pair_map={},
        feature_meta=feature_meta,
    )

    assert high_dup["similarity_novelty_penalty"] > 0.0, high_dup
    assert high_dup["novelty"] < high_dup["base_novelty"], high_dup
    assert low_dup["similarity_novelty_penalty"] == 0.0, low_dup
    assert low_dup["similarity_novelty_bonus"] > 0.0, low_dup
    assert archive_dup["similarity_novelty_penalty"] > 0.0, archive_dup
    assert missing_pair["max_internal_similarity"] == 1.0, missing_pair
    assert missing_pair["similarity_matrix_missing_internal_pairs"] == 1, missing_pair
    assert missing_pair["similarity_novelty_penalty"] > 0.0, missing_pair
    assert missing_pair["similarity_novelty_method"].endswith("matrix_only_fail_closed"), missing_pair

    return {
        "schema_version": "stockvision-alpha-mining-similarity-novelty-validation-v1",
        "status": "pass",
        "decision_effect": "local_validation_only",
        "validated_cases": [
            "high_duplicate_penalized",
            "low_similarity_bonus_allowed",
            "archive_duplicate_penalized",
            "missing_pair_fail_closed",
        ],
        "method": "formal137_pairwise_abs_rank_corr_matrix_only_fail_closed",
        "source_module": "tools/finlab_alpha_miner_bakeoff.py",
        "cases": {
            "high_duplicate": high_dup,
            "low_similarity": low_dup,
            "archive_duplicate": archive_dup,
            "missing_pair_fail_closed": missing_pair,
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate alpha mining similarity novelty fail-closed behavior.")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--no-write", action="store_true", help="Print JSON only; do not write the evidence artifact.")
    args = parser.parse_args(argv)

    payload = build_validation_payload()
    if not args.no_write:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
