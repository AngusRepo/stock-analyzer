from __future__ import annotations

import ast
from pathlib import Path

from app.alpha_model_roster import SUPPORTED_MODELS
from app.challenger_models import CHALLENGERS
from app.gnn_graph_contract import GNN_GRAPH_VARIANTS
from app.linear_neutral import EXPOSURE_SET_MODEL_NAMES


def test_challenger_registry_matches_trainer_identities_and_modal_functions():
    modal_functions = {
        node.name for node in ast.parse((Path(__file__).resolve().parents[1] / "modal_app.py").read_text(encoding="utf-8")).body
        if isinstance(node, ast.FunctionDef)
    }
    trainer_names = set(EXPOSURE_SET_MODEL_NAMES.values()) | {v["model_name"] for v in GNN_GRAPH_VARIANTS.values()}
    assert set(CHALLENGERS) == trainer_names
    for name, spec in CHALLENGERS.items():
        assert spec["modal_function"] in modal_functions
        assert name not in SUPPORTED_MODELS  # challengers never enter the 7/8-model roster
        cfg = spec["payload_config"]
        if spec["modal_function"] == "train_linear_neutral_universal":
            assert EXPOSURE_SET_MODEL_NAMES[cfg["neutralization_exposures"]] == name == cfg["model_name"]
        else:
            assert GNN_GRAPH_VARIANTS[cfg["graph_variant"]]["model_name"] == name


def test_lifecycle_slots_only_produce_registered_challengers():
    from app.challenger_models import DEFERRED_CHALLENGERS, LIFECYCLE_SLOTS

    scheduled = {name for slot in LIFECYCLE_SLOTS.values() for name in slot["produces"]}
    assert scheduled <= set(CHALLENGERS) and set(DEFERRED_CHALLENGERS) <= set(CHALLENGERS)
    assert not scheduled & set(DEFERRED_CHALLENGERS)
    assert LIFECYCLE_SLOTS["linear_neutral"]["payload_config"]["neutralization_exposures"] == "auto"
