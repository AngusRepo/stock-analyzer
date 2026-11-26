"""ROSTER-PREP-60: the universal prep skips a symbol by the shared contract minimum, not a literal."""
import json
from pathlib import Path

import pytest

from app import features, universal_training as u

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = json.loads((ROOT / "schemas/price-history-eligibility-v1.json").read_text(encoding="utf-8"))


def test_prep_minimum_is_the_contract_value():
    from services.price_history_contract import MIN_PRICE_ROWS
    assert MIN_PRICE_ROWS == CONTRACT["min_price_rows"] == 60


def test_one_row_short_of_the_contract_is_skipped_and_the_minimum_is_built(monkeypatch):
    minimum = CONTRACT["min_price_rows"]
    monkeypatch.setattr(features, "build_feature_matrix", lambda *a, **kw: pytest.fail("built below the minimum"))
    result = u.prep_universal_batch(u.UniversalPrepRequest(payloads=[{"symbol": "NEW", "prices": [{}] * (minimum - 1)}]))
    assert result["skipped"] == 1 and result["rows"] == 0

    def reached(*a, **kw):
        raise KeyError("reached_feature_build")
    monkeypatch.setattr(features, "build_feature_matrix", reached)
    monkeypatch.setattr(u, "_get_bucket", lambda: pytest.fail("partial artifact published"))
    with pytest.raises(ValueError, match="feature_data_quality_build_failed:EDGE:KeyError"):
        u.prep_universal_batch(u.UniversalPrepRequest(payloads=[{"symbol": "EDGE", "prices": [{}] * minimum}]))


def test_prep_has_no_literal_copy_of_the_minimum():
    source = (ROOT / "ml-service/app/universal_training.py").read_text(encoding="utf-8")
    assert "len(prices_data) < MIN_PRICE_ROWS" in source
    assert "len(prices_data) < 60" not in source
