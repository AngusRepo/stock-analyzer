"""Canonical cross-layer versions for production expected-return artifacts."""

LABEL_SCHEMA_VERSION = "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
LEGACY_LABEL_SCHEMA_VERSION = "next-session-raw-open-to-fifth-session-raw-close-canonical-finlab-factor-net-v3"
CANONICAL_ROUNDTRIP_COST_BPS = 18.0
CANONICAL_ROUNDTRIP_COST_RATE = CANONICAL_ROUNDTRIP_COST_BPS / 10_000.0

L4_ARTIFACT_CONTRACT_VERSION = "l4-alpha-ev-contract-v4"
L4_FEATURE_SEMANTIC_VERSION = "l4-directional-score-components-v2-lineage-bound"
SUPPORTED_L4_SERVING_CONTRACT_PAIRS = frozenset({
    ("l4-alpha-ev-contract-v3", LEGACY_LABEL_SCHEMA_VERSION),
    (L4_ARTIFACT_CONTRACT_VERSION, LABEL_SCHEMA_VERSION),
})

LEGACY_ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION = "allocator-ev-fusion-contract-v11"
LEGACY_ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION = "allocator-ev-fusion-directional-components-v2-lineage-bound"
ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION = "allocator-ev-fusion-contract-v12"
ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION = "allocator-ev-fusion-market-conditioned-components-v3-lineage-bound"
SUPPORTED_ALLOCATOR_EV_SERVING_CONTRACT_PAIRS = frozenset({
    ("allocator-ev-fusion-contract-v9", LEGACY_LABEL_SCHEMA_VERSION),
    (LEGACY_ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION, LABEL_SCHEMA_VERSION),
    (ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION, LABEL_SCHEMA_VERSION),
})
SUPPORTED_ALLOCATOR_EV_FEATURE_SEMANTICS = {
    "allocator-ev-fusion-contract-v9": LEGACY_ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION,
    LEGACY_ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION: LEGACY_ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION,
    ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION: ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION,
}
