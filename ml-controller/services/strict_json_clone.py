"""Strict JSON-normalized copies without a whole-document text/bytes buffer.

Use the existing writer's 32-record batching policy with stdlib's C decoder.
No source container or repeated alias is reused in the result. A single large
record, tuple or non-string-key mapping remains the lower memory bound.
"""
from __future__ import annotations

import json
import math

from services.streaming_json_reader import _SharedKeysDict


def _clone_batch(value):
    return json.loads(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(',', ':'), allow_nan=False))


def strict_json_clone(value):
    """Retain ``json.loads(encode(value))`` normalization and rejection policy.

    Inputs must remain unchanged throughout this synchronous call. String-key
    dictionaries stream their values; lists clone 32 complete records at once.
    Numeric/non-string keys and tuples keep the stdlib's exact coercion policy.
    Immutable JSON scalars may be returned directly; mutable aliases never are.
    """
    active = set()

    def clone(item):
        if type(item) in (dict, _SharedKeysDict) and all(type(key) is str for key in item):
            identity = id(item)
            if identity in active:
                raise ValueError('Circular reference detected')
            active.add(identity)
            try:
                return {key: clone(item[key]) for key in sorted(item)}
            finally:
                active.remove(identity)
        if type(item) is list:
            result = []
            for start in range(0, len(item), 32):
                # The stdlib C encoder retains recursive/circular/type checks
                # within each complete record, including references to parents.
                result.extend(_clone_batch(item[start:start + 32]))
            return result
        if item is None or type(item) in (str, bool):
            return item
        if type(item) is float and math.isfinite(item):
            return item  # repr/parse roundtrips finite binary64 exactly, including -0.0.
        return _clone_batch(item)

    try:
        return clone(value)
    except RecursionError:
        # A Python container walk reaches its recursion limit before stdlib's
        # C encoder on very deep maps. Preserve the legacy acceptance boundary
        # through its original path; genuinely too-deep/cyclic values still fail.
        pass
    return _clone_batch(value)
