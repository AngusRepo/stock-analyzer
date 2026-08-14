from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.bounded_json import (
    BoundedJsonContractError,
    assert_bounded_json_fields_complete,
    bounded_json_dumps,
)
from services.monte_carlo_service import _extract_backtest_returns_and_regimes


def test_bounded_json_preserves_small_payload_exactly():
    payload = {"status": "ok", "values": [1, 2, 3]}
    encoded = bounded_json_dumps(payload)
    assert json.loads(encoded) == payload


def test_bounded_json_compacts_large_payload_without_corrupting_json():
    payload = {
        "method": "cpcv",
        "logit_values": [float(index) / 100 for index in range(20_000)],
        "details": [{"window": index, "label": "台股" * 200} for index in range(200)],
    }
    encoded = bounded_json_dumps(payload, max_utf8_bytes=4_000)
    decoded = json.loads(encoded)

    assert len(encoded.encode("utf-8")) <= 4_000
    assert decoded["schema_version"] == "bounded-json-v2"
    assert decoded["truncated"] is True
    assert decoded["original_utf8_bytes"] > 4_000
    assert len(decoded["original_sha256"]) == 64
    assert decoded["payload"]["method"] == "cpcv"
    assert decoded["payload"]["logit_values"]["_truncated_list"] is True


def test_bounded_json_uses_valid_metadata_only_fallback_for_extreme_mapping():
    payload = {f"key-{index}": "x" * 2_000 for index in range(1_000)}
    encoded = bounded_json_dumps(payload, max_utf8_bytes=512)
    decoded = json.loads(encoded)

    assert len(encoded.encode("utf-8")) <= 512
    assert decoded["truncated"] is True
    assert decoded["original_utf8_bytes"] > 512


def test_bounded_json_preserves_algorithmic_fields_exactly_when_compacting_diagnostics():
    returns = [index / 10_000 for index in range(250)]
    regimes = ["bull" if index % 2 else "bear" for index in range(250)]
    payload = {
        "all_returns": returns,
        "all_regimes": regimes,
        "trades": [],
        "diagnostics": [{"window": index, "detail": "x" * 500} for index in range(100)],
    }

    encoded = bounded_json_dumps(
        payload,
        max_utf8_bytes=12_000,
        preserve_exact_keys=("all_returns", "all_regimes", "trades"),
    )
    decoded = json.loads(encoded)

    assert len(encoded.encode("utf-8")) <= 12_000
    assert decoded["_bounded_json"]["truncated"] is True
    assert set(decoded["_bounded_json"]["exact_keys"]) == {"all_returns", "all_regimes", "trades"}
    extracted_returns, extracted_regimes = _extract_backtest_returns_and_regimes(decoded)
    assert extracted_returns == returns
    assert extracted_regimes == regimes
    assert_bounded_json_fields_complete(decoded, ("all_returns", "all_regimes"))


def test_bounded_json_fails_closed_when_exact_fields_do_not_fit():
    payload = {
        "all_returns": [index / 1_000 for index in range(20_000)],
        "diagnostics": "x" * 10_000,
    }

    with pytest.raises(BoundedJsonContractError, match="exact_fields_exceed_limit"):
        bounded_json_dumps(
            payload,
            max_utf8_bytes=4_000,
            preserve_exact_keys=("all_returns",),
        )


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_bounded_json_rejects_non_finite_numbers(value: float):
    with pytest.raises(BoundedJsonContractError, match="non_finite_number"):
        bounded_json_dumps({"value": value})


def test_bounded_json_rejects_legacy_truncated_payload_for_algorithmic_consumers():
    payload = {
        "schema_version": "bounded-json-v1",
        "truncated": True,
        "payload": {
            "all_returns": {
                "_truncated_list": True,
                "head": [0.1],
                "tail": [-0.1],
            }
        },
    }

    with pytest.raises(BoundedJsonContractError, match="legacy_truncated_payload"):
        assert_bounded_json_fields_complete(payload, ("all_returns",))


def test_bounded_json_preserves_promotion_metadata_at_top_level():
    payload = {
        "distribution": [index / 10_000 for index in range(20_000)],
        "simulation_method": "regime_block_bootstrap",
        "block_size": 12,
        "regime_counts": {"bull": 120, "bear": 80},
    }

    encoded = bounded_json_dumps(
        payload,
        max_utf8_bytes=4_000,
        preserve_exact_keys=("simulation_method", "block_size", "regime_counts"),
    )
    decoded = json.loads(encoded)

    assert decoded["simulation_method"] == "regime_block_bootstrap"
    assert decoded["block_size"] == 12
    assert decoded["regime_counts"] == {"bull": 120, "bear": 80}
    assert decoded["distribution"]["_truncated_list"] is True
    assert_bounded_json_fields_complete(
        decoded,
        ("simulation_method", "block_size", "regime_counts"),
    )
