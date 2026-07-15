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


def test_l4_alpha_ev_refresh_route_writes_registry_before_config_promotion() -> None:
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
    assert "worker_fetch" in calls
    assert calls.index("upsert_artifact_record") < calls.index("worker_fetch")


def test_l4_alpha_ev_refresh_route_sends_config_snapshot_meta() -> None:
    source = SOURCE_PATH.read_text(encoding="utf-8")
    assert '"meta"' in source
    assert '"source": "l4_alpha_ev_refresh"' in source
    assert '"push_id": f"l4_alpha_ev:' in source


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
    assert {"production", "approval_required", "offline_passed", "offline_failed"} <= constants
    assert "production_approved" not in constants
