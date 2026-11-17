"""Immutable model identities; TimeXer replaces, never aliases, DLinear. R33_MODELS is what
the monthly lifecycle trains: the cross-sectional families LightGBM, ExtraTrees, TabM and GNN
(the 2026-11-07 G5 #3 cohort showed the three sequence families at OOF rank IC ~0, so Wei
removed them from the November release roster pending a redesign; XGBoost is retired, Q5).
A published R33 roster is any non-empty TimeXer-slot-ordered subset without DLinear or XGBoost
(validate_r33_roster; no minimum size, Q3), read from the sealed object, not this constant.
model_order(complete=True) stays exact: an eight-model set or R33_MODELS."""
from __future__ import annotations

LEGACY_MODELS = ("LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN",
                 "DLinear", "PatchTST", "iTransformer")
TIMEXER_MODELS = tuple("TimeXer" if name == "DLinear" else name for name in LEGACY_MODELS)
R33_EXCLUDED_MODELS = ("XGBoost", "TimeXer", "PatchTST", "iTransformer")
R33_MODELS = tuple(name for name in TIMEXER_MODELS if name not in R33_EXCLUDED_MODELS)
SUPPORTED_MODELS = frozenset((*LEGACY_MODELS, "TimeXer"))


def validate_r33_roster(names) -> tuple[str, ...]:
    """A published R33 roster: non-empty, no repeats, TimeXer slot order, no DLinear, no XGBoost.

    No minimum size (Wei 2026-11-12 Q3): the monthly OOF checks decide membership. XGBoost is
    retired from R33 (Q5), so a set holding it is a broken eight-model set, never an R33 roster.
    Serving and cutover read the roster from the sealed object (bundle/ensemble model_order); the
    R33_MODELS constant only says what the monthly lifecycle trains."""
    order = tuple(names) if isinstance(names, (list, tuple)) else ()
    if (not order or "XGBoost" in order
            or order != tuple(name for name in TIMEXER_MODELS if name in order)):
        raise ValueError("alpha_roster_r33_order_invalid")
    return order


def is_r33_roster(names) -> bool:
    try:
        validate_r33_roster(names)
        return True
    except ValueError:
        return False


def model_order(names, *, complete=False) -> tuple[str, ...]:
    """Slot order of a model set; `complete` requires an exact eight-model set or this checkout's
    R33_MODELS. An R33 object's own roster (which may differ from R33_MODELS) is checked by
    validate_r33_roster at the R33 call sites, never here."""
    names = set(names)
    if "DLinear" in names and "TimeXer" in names:
        raise ValueError("alpha_roster_mixed_replacement_slot")
    if complete and names == set(R33_MODELS):
        return R33_MODELS
    order = TIMEXER_MODELS if "TimeXer" in names else LEGACY_MODELS
    if complete and names != set(order):
        raise ValueError("alpha_roster_requires_exactly_eight_models")
    return order


def validate_order(names) -> tuple[str, ...]:
    order = tuple(names)
    if order not in (LEGACY_MODELS, TIMEXER_MODELS) and not is_r33_roster(order):
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
