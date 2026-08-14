import ast
from pathlib import Path

SOURCE_PATH = Path(__file__).resolve().parents[1] / "routers/l4_alpha_ev.py"


def test_l4_alpha_ev_refresh_route_calls_builder_with_trained_until() -> None:
    source = SOURCE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source)

    calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "build_l4_alpha_ev_artifact_from_rows"
    ]
    assert len(calls) == 1
    keyword_names = {keyword.arg for keyword in calls[0].keywords}
    assert "trained_until" in keyword_names
    assert "end_date" not in keyword_names

    loader_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "load_l4_alpha_ev_training_rows"
    ]
    assert len(loader_calls) == 1
    loader_keywords = {keyword.arg for keyword in loader_calls[0].keywords}
    assert "knowledge_cutoff_date" in loader_keywords

    reconstruction_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "reconstruct_rows_with_point_in_time_lineage"
    ]
    assert len(reconstruction_calls) == 1
    assert isinstance(calls[0].args[0], ast.Name)
    assert calls[0].args[0].id == "lineage_rows"


def test_l4_alpha_ev_refresh_exposes_lineage_reconstruction_audit() -> None:
    source = SOURCE_PATH.read_text(encoding="utf-8")
    assert '"lineage_rows_accepted": len(lineage_rows)' in source
    assert '"lineage_rows_rejected": max(0, len(rows) - len(lineage_rows))' in source
    assert '"lineage_reconstruction": lineage_audit' in source
    assert '"champion_history_load": champion_history_load' in source


def test_l4_alpha_ev_refresh_persists_registry_without_direct_config_promotion() -> None:
    source = SOURCE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source)
    refresh = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "refresh_l4_alpha_ev_artifact"
    )
    calls = [
        node.func.id
        for node in ast.walk(refresh)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    ]
    assert "upsert_artifact_record" in calls
    assert "worker_fetch" not in calls
    assert '"/api/admin/config"' not in source


def test_l4_alpha_ev_refresh_rejects_direct_promotion_to_active8_owner() -> None:
    source = SOURCE_PATH.read_text(encoding="utf-8")
    assert "promote: bool = False" in source
    assert "if req.promote:" in source
    assert "status_code=409" in source
    assert 'DIRECT_REFRESH_PROMOTION_OWNER = "active8_oof_lifecycle"' in source
    assert 'DIRECT_REFRESH_PROMOTION_ENDPOINT = "/walk_forward/oof/lifecycle"' in source
    assert source.index("if req.promote:") < source.index("defaults = _defaults_for_cadence")


def test_l4_alpha_ev_dry_run_does_not_write_registry() -> None:
    source = SOURCE_PATH.read_text(encoding="utf-8")
    assert "if isinstance(artifact, dict) and not req.dry_run:" in source


def test_l4_alpha_ev_registry_maps_promotion_to_lifecycle_states() -> None:
    source = SOURCE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source)
    function = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "_registry_lifecycle_state"
    )
    constants = {
        node.value for node in ast.walk(function)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    }
    assert {"offline_passed", "offline_failed"} <= constants
    assert {"production", "approval_required"}.isdisjoint(constants)


def test_l4_registry_envelope_uses_formal_direct_identity_v1() -> None:
    source = SOURCE_PATH.read_text(encoding="utf-8")
    assert '"identity_schema_version": "expected-return-candidate-identity-v1"' in source
    assert '"identity_schema_version": "expected-return-candidate-identity-v2"' not in source
    assert '"expected_return_owner": artifact.get("expected_return_owner")' in source
    assert '"model_version": model_version' in source
    assert '"artifact_checksum": artifact_checksum' not in source
    assert '"cadence": cadence' in source
    assert '"checksum": artifact_checksum' in source
    assert '"production_mutation_allowed": False' in source
