import ast
from pathlib import Path


def test_l4_alpha_ev_refresh_route_calls_builder_with_trained_until() -> None:
    source = Path("ml-controller/routers/l4_alpha_ev.py").read_text(encoding="utf-8")
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


def test_l4_alpha_ev_refresh_route_writes_registry_before_config_promotion() -> None:
    source = Path("ml-controller/routers/l4_alpha_ev.py").read_text(encoding="utf-8")
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
    source = Path("ml-controller/routers/l4_alpha_ev.py").read_text(encoding="utf-8")
    assert '"meta"' in source
    assert '"source": "l4_alpha_ev_refresh"' in source
    assert '"push_id": f"l4_alpha_ev:' in source
