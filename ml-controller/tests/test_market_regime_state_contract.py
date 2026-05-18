from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.market_regime_state import (  # noqa: E402
    MARKET_REGIME_STATE_KEY,
    resolve_market_regime_contract,
)


class FakeKV:
    def __init__(self, values: dict):
        self.values = values

    def get(self, key: str):
        value = self.values.get(key)
        if isinstance(value, str):
            return value
        return None

    def get_json(self, key: str, default=None):
        value = self.values.get(key)
        return value if isinstance(value, dict) else default


def test_market_regime_state_contract_prefers_new_state_over_legacy_keys():
    contract = resolve_market_regime_contract(FakeKV({
        MARKET_REGIME_STATE_KEY: {
            "schema_version": "market-regime-state-v1",
            "label": "bear_market",
            "family": "bear",
            "run_date": "2026-05-16",
            "computed_at": "2026-05-16T10:30:00+08:00",
            "source": "hmm",
            "regime_surface": {"bear_market": 0.71, "sideways": 0.20},
        },
        "ml:regime": "bull_market",
        "ml:regime:meta": {"label": "bull_market", "regime_surface": {"bull_market": 0.8}},
    }))

    assert contract["label"] == "bear_market"
    assert contract["alpha_regime"] == "bear"
    assert contract["source"] == "market_regime_state"
    assert contract["regime_surface"]["bear_market"] == 0.71
    assert contract["missing"] is False


def test_market_regime_state_contract_falls_back_to_legacy_meta_during_migration():
    contract = resolve_market_regime_contract(FakeKV({
        "ml:regime:meta": {
            "label": "volatile",
            "regime_surface": {"volatile": 0.62},
            "computed_at": "2026-05-16T10:30:00+08:00",
        },
    }))

    assert contract["label"] == "volatile"
    assert contract["alpha_regime"] == "volatile"
    assert contract["source"] == "legacy_meta"
    assert contract["missing"] is False


def test_daily_pipeline_recommendation_path_uses_market_regime_state_contract():
    source = Path(__file__).resolve().parent.parent.joinpath("graphs", "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert "resolve_market_regime_contract" in source
    assert 'kv_client.get("ml:regime")' not in source
    assert 'kv_client.get_json("ml:regime:meta"' not in source
    assert "market_regime_state missing before recommendation" in source
