"""Canonical cross-layer versions loaded from the repository contract manifest."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _manifest_path() -> Path:
    source = Path(__file__).resolve()
    candidates = (
        source.parents[2] / "schemas" / "expected-return-contracts-v1.json",
        source.parents[1] / "schemas" / "expected-return-contracts-v1.json",
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise RuntimeError("expected_return_contract_manifest_missing")


EXPECTED_RETURN_CONTRACT_MANIFEST_PATH = _manifest_path()
EXPECTED_RETURN_CONTRACT_MANIFEST: dict[str, Any] = json.loads(
    EXPECTED_RETURN_CONTRACT_MANIFEST_PATH.read_text(encoding="utf-8")
)
if EXPECTED_RETURN_CONTRACT_MANIFEST.get("schema_version") != "expected-return-contract-manifest-v1":
    raise RuntimeError("expected_return_contract_manifest_version_invalid")

LABEL_SCHEMA_VERSION = str(EXPECTED_RETURN_CONTRACT_MANIFEST["canonical_label_schema_version"])
LEGACY_LABEL_SCHEMA_VERSION = str(EXPECTED_RETURN_CONTRACT_MANIFEST["legacy_label_schema_version"])
CANONICAL_ROUNDTRIP_COST_BPS = float(
    EXPECTED_RETURN_CONTRACT_MANIFEST["canonical_roundtrip_cost_bps"]
)
CANONICAL_ROUNDTRIP_COST_RATE = CANONICAL_ROUNDTRIP_COST_BPS / 10_000.0

_L4 = EXPECTED_RETURN_CONTRACT_MANIFEST["owners"]["l4_alpha_ev"]
_FUSION = EXPECTED_RETURN_CONTRACT_MANIFEST["owners"]["allocator_ev_fusion"]
_L4_CURRENT = _L4["current"]
_FUSION_CURRENT = _FUSION["current"]

L4_ARTIFACT_CONTRACT_VERSION = str(_L4_CURRENT["artifact_contract_version"])
L4_FEATURE_SEMANTIC_VERSION = str(_L4_CURRENT["feature_semantic_version"])
L4_EXPECTED_RETURN_SEMANTIC = str(_L4_CURRENT["expected_return_semantic"])
SUPPORTED_L4_SERVING_CONTRACT_PAIRS = frozenset({
    (L4_ARTIFACT_CONTRACT_VERSION, LABEL_SCHEMA_VERSION),
})
SUPPORTED_L4_FEATURE_SEMANTICS = {
    L4_ARTIFACT_CONTRACT_VERSION: L4_FEATURE_SEMANTIC_VERSION,
}
RETIRED_L4_COMPATIBILITY = tuple(_L4.get("retired_compatibility") or ())

ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION = str(_FUSION_CURRENT["artifact_contract_version"])
ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION = str(_FUSION_CURRENT["feature_semantic_version"])
ALLOCATOR_EV_EXPECTED_RETURN_SEMANTIC = str(_FUSION_CURRENT["expected_return_semantic"])
SUPPORTED_ALLOCATOR_EV_SERVING_CONTRACT_PAIRS = frozenset({
    (ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION, LABEL_SCHEMA_VERSION),
})
SUPPORTED_ALLOCATOR_EV_FEATURE_SEMANTICS = {
    ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION: ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION,
}
RETIRED_ALLOCATOR_EV_COMPATIBILITY = tuple(_FUSION.get("retired_compatibility") or ())
