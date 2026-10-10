"""Explicit search-budget variant; upstream training semantics remain unchanged."""
from copy import deepcopy
import hashlib
import json

UPSTREAM_COMMIT = '05a89e21b955f12de84889d662e15ca534019aaa'
LEGACY_RECIPE = 'three-head-oof-official-tabpack-v2'
RECIPE = 'three-head-oof-tabpack-official-core16-v1'
MEDIAN_RECIPE = 'three-head-oof-tabpack-official-core16-median-v1'
SEEDS = (42, 43, 44)
N_MODELS = 16
# Pinned official factory, excluding declared seed/data/search-count adapters.
# Includes the existing numeric-data batch size (1024).
CORE_CONFIG_SHA256 = '93d71947a2a0f9f78c0e4a8dee36b4f9d271de76a1a14140937071cc0277c22b'


def validate_core(config):
    core = {k:v for k,v in config.items() if k not in ('seed','data','n_models')}
    raw = json.dumps(core, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    if hashlib.sha256(raw).hexdigest() != CORE_CONFIG_SHA256:
        raise ValueError('tabpack_core_configuration_changed')


def validate_run(recipe, seed):
    if (type(seed) is not int or recipe not in (LEGACY_RECIPE, RECIPE)
            or seed not in ((42,) if recipe == LEGACY_RECIPE else SEEDS)):
        raise ValueError('tabpack_training_recipe_or_seed_invalid')


def configure(official_config, *, recipe, seed):
    validate_run(recipe, seed)
    validate_core(official_config)
    if official_config.get('seed') != seed or official_config.get('n_models') != 64:
        raise ValueError('tabpack_upstream_default_changed')
    result = deepcopy(official_config)
    if recipe == RECIPE:
        result['n_models'] = N_MODELS
    return result


def validate_result(result, *, recipe, seed):
    validate_run(recipe, seed)
    validate_core(result.get('config') or {})
    if (result.get('training_recipe') != recipe or result.get('seed') != seed
            or result.get('training_completed') is not True
            or result.get('configuration_overrides') != ({'n_models': N_MODELS} if recipe == RECIPE else {})
            or result.get('config', {}).get('n_models') != (N_MODELS if recipe == RECIPE else 64)
            or result.get('config', {}).get('seed') != seed):
        raise ValueError('tabpack_training_result_identity_invalid')
