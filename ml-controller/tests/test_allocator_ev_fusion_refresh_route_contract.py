import ast
from pathlib import Path


SOURCE = Path("ml-controller/routers/allocator_ev_fusion.py").read_text(encoding="utf-8")


def test_allocator_ev_fusion_refresh_route_accepts_v2_promotion_states() -> None:
    tree = ast.parse(SOURCE)
    function = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "_promotion_config_allowed"
    )
    constants = {
        node.value
        for node in ast.walk(function)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    }
    assert "production_primary" in constants
    assert "production_assistive" in constants
    assert "production_approved" not in constants


def test_allocator_ev_fusion_refresh_route_writes_registry_before_config_promotion() -> None:
    tree = ast.parse(SOURCE)
    refresh = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "refresh_allocator_ev_fusion_artifact"
    )
    calls = [
        node.func.id
        for node in ast.walk(refresh)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    ]
    assert "upsert_artifact_record" in calls
    assert "worker_fetch" in calls
    assert calls.index("upsert_artifact_record") < calls.index("worker_fetch")


def test_allocator_ev_fusion_refresh_route_sends_config_snapshot_meta() -> None:
    assert '"meta"' in SOURCE
    assert '"source": "allocator_ev_fusion_refresh"' in SOURCE
    assert '"push_id": f"allocator_ev_fusion:' in SOURCE


def test_allocator_ev_fusion_registry_maps_promotion_to_lifecycle_states() -> None:
    tree = ast.parse(SOURCE)
    function = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "_registry_lifecycle_state"
    )
    constants = {
        node.value for node in ast.walk(function)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    }
    assert {"production", "approval_required", "offline_passed", "offline_failed"} <= constants
    assert "shadow" not in constants
