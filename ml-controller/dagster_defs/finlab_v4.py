from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from services.finlab_dagster_factory import (
    FinLabDagsterFactoryError,
    build_finlab_dagster_definitions,
    build_finlab_definitions_payload,
)


def _default_graph_path() -> Path:
    env_path = os.environ.get("FINLAB_DAGSTER_GRAPH_PATH")
    if env_path:
        return Path(env_path)

    here = Path(__file__).resolve()
    candidates = [
        here.parents[2] / "data" / "finlab_research" / "dagster_asset_graph.json",
        here.parents[1] / "data" / "finlab_research" / "dagster_asset_graph.json",
        Path("/app/data/finlab_research/dagster_asset_graph.json"),
        Path("/data/finlab_research/dagster_asset_graph.json"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


DEFAULT_GRAPH_PATH = _default_graph_path()

DEFINITIONS_STATUS: dict[str, Any] = {
    "mode": "finlab_asset_runtime_formal_shadow",
    "schedule_enabled": False,
    "asset_graph_path": str(DEFAULT_GRAPH_PATH),
    "asset_count": 0,
    "asset_check_spec_count": 0,
    "error": None,
}


def load_finlab_asset_graph(path: Path = DEFAULT_GRAPH_PATH) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def build_definitions(path: Path = DEFAULT_GRAPH_PATH) -> Any:
    graph = load_finlab_asset_graph(path)
    payload = build_finlab_definitions_payload(graph)
    DEFINITIONS_STATUS.update({
        "asset_graph_checksum": payload.get("asset_graph_checksum"),
        "source_plan_checksum": payload.get("source_plan_checksum"),
        "asset_count": len(payload.get("assets") or []),
        "asset_check_spec_count": len(payload.get("asset_checks") or []),
        "asset_check_def_count": 1 if payload.get("asset_checks") else 0,
        "schedule_count": 0,
        "error": None,
    })
    return build_finlab_dagster_definitions(graph)


try:
    defs = build_definitions()
except (FinLabDagsterFactoryError, FileNotFoundError) as exc:
    defs = None
    DEFINITIONS_STATUS["error"] = str(exc)
