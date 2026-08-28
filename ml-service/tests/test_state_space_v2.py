from __future__ import annotations

import json
import math
from pathlib import Path
import sys

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.state_space_v2 import (  # noqa: E402
    STATE_SPACE_V2_CONTRACT,
    STATE_SPACE_V2_SCHEMA,
    _canonical_json,
    build_state_space_v2_batch,
)


def _series(symbol: str = "2330", count: int = 90) -> dict:
    prices = [100.0 * math.exp(0.0015 * idx + 0.003 * math.sin(idx / 5)) for idx in range(count)]
    return {"symbol": symbol, "stock_id": 1, "prices": prices, "sequence_source": "immutable-test"}


def test_state_space_v2_is_deterministic_and_observation_only() -> None:
    packet = build_state_space_v2_batch(
        [_series()],
        as_of_date="2026-08-27",
        run_id="state-space-v2-test",
        input_evidence={"snapshot_id": "immutable-snapshot-test"},
    )
    replay = build_state_space_v2_batch(
        [_series()],
        as_of_date="2026-08-27",
        run_id="state-space-v2-test",
        input_evidence={"snapshot_id": "immutable-snapshot-test"},
    )
    assert packet == replay
    assert packet["schema_version"] == STATE_SPACE_V2_SCHEMA
    assert packet["contract_version"] == STATE_SPACE_V2_CONTRACT
    assert packet["production_effect"] is False
    assert packet["decision_role"] == "risk_overlay_comparison_only"
    assert packet["observation_count"] == 1
    assert packet["error_count"] == 0
    assert len(packet["payload_checksum"]) == 64
    assert 0 <= packet["observations"][0]["up_probability"] <= 1


def test_state_space_v2_rejects_short_series_per_symbol() -> None:
    packet = build_state_space_v2_batch(
        [_series(count=20)],
        as_of_date="2026-08-27",
        run_id="state-space-v2-short",
    )
    assert packet["observation_count"] == 0
    assert packet["error_count"] == 1
    assert "insufficient_observations" in packet["errors"][0]["error"]


def test_canonical_json_matches_javascript_integral_float_semantics() -> None:
    canonical = json.loads(_canonical_json({"b": 0.0, "a": [1.0, 1.25], "tiny": 1e-7}))
    assert canonical == {
        "a": [{"$number": "1"}, {"$number": "1.25"}],
        "b": {"$number": "0"},
        "tiny": {"$number": "0.0000001"},
    }
    assert json.loads(_canonical_json({"x": np.float64(2.0)})) == {"x": {"$number": "2"}}
