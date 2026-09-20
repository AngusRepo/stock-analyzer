"""Immutable eight-model identities; TimeXer replaces, never aliases, DLinear."""
from __future__ import annotations

LEGACY_MODELS = ("LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN",
                 "DLinear", "PatchTST", "iTransformer")
TIMEXER_MODELS = tuple("TimeXer" if name == "DLinear" else name for name in LEGACY_MODELS)
SUPPORTED_MODELS = frozenset((*LEGACY_MODELS, "TimeXer"))


def model_order(names, *, complete=False) -> tuple[str, ...]:
    names = set(names)
    if "DLinear" in names and "TimeXer" in names:
        raise ValueError("alpha_roster_mixed_replacement_slot")
    order = TIMEXER_MODELS if "TimeXer" in names else LEGACY_MODELS
    if complete and names != set(order):
        raise ValueError("alpha_roster_requires_exactly_eight_models")
    return order


def validate_order(names) -> tuple[str, ...]:
    order = tuple(names)
    if order not in (LEGACY_MODELS, TIMEXER_MODELS):
        raise ValueError("alpha_roster_order_invalid")
    return order


def stacker_features(order) -> tuple[str, ...]:
    order = validate_order(order)
    return tuple([f"{name}.rank" for name in order]
                 + [f"{name}.available" for name in order])


def is_complete_roster(names) -> bool:
    try:
        model_order(names, complete=True)
        return True
    except (ValueError, TypeError):
        return False


def published_model_order(query):
    """The ensemble pointer owns the slot replacement, never newest artifacts."""
    import json
    rows = query("SELECT a.payload_json, a.payload_checksum, a.state, a.production_effect, "
        "p.payload_checksum AS pointer_payload_checksum FROM active8_ensemble_pointer_v1 p "
        "JOIN active8_ensemble_artifacts_v1 a ON a.artifact_id=p.artifact_id WHERE p.singleton_id=1", [])
    if not rows:
        return LEGACY_MODELS
    if len(rows) != 1:
        raise ValueError('alpha_roster_published_pointer_ambiguous')
    row = rows[0]
    payload = json.loads(row['payload_json'])
    if (row.get('state') != 'production' or int(row.get('production_effect') or 0) != 1
            or row.get('payload_checksum') != row.get('pointer_payload_checksum')
            or payload.get('payload_checksum') != row.get('payload_checksum')):
        raise ValueError('alpha_roster_published_pointer_invalid')
    return validate_order(payload['model_order'])
