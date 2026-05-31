from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_ai_factor_miner import discover_finlab_raw_factor_candidates  # noqa: E402


class FakeFinLabData:
    def __init__(self):
        self.markets: list[str | None] = []

    def search(self, query: str, market: str | None = None):
        self.markets.append(market)
        rows = {
            "RSI": [
                "technical:rsi14",
                {"dataset": "technical:volume_expansion", "display_name": "Volume expansion"},
            ],
            "外資": [
                "institutional:foreign_net_buy",
            ],
            "ROE": [
                {"dataset": "fundamental:roe", "display_name": "ROE"},
                "fundamental:eps",
            ],
        }
        return rows.get(query, [])


def test_finlab_ai_factor_miner_searches_raw_factor_lanes():
    fake_data = FakeFinLabData()
    payload = discover_finlab_raw_factor_candidates(
        finlab_data=fake_data,
        lane_search_terms={
            "technical": ["RSI"],
            "chip": ["外資"],
            "fundamental": ["ROE"],
        },
        max_per_lane=2,
        generated_at="2026-06-01T00:00:00+00:00",
    )

    assert payload["version"] == "finlab-ai-factor-miner-v1"
    assert set(fake_data.markets) == {"tw"}
    assert payload["closure_ready"] is True
    assert payload["registry_target"] == "strategy_spec_registry"
    assert payload["production_effect"] is False
    assert payload["ingestion_contract"]["consumer"] == "worker.runFinLabAiSkillDiscoveryClosure.rawFactorMinerPayload"
    assert payload["summary"]["candidate_count"] == 5
    lanes = {row["lane"] for row in payload["candidates"]}
    assert lanes == {"technical", "chip", "fundamental"}
    assert all(row["promotion_status"] == "research" for row in payload["candidates"])
    assert all(row["strategy_spec_hint"]["status"] == "research" for row in payload["candidates"])
    assert all(row["strategy_spec_hint"]["candidate_policy"]["maxMlShare"] == 0 for row in payload["candidates"])
    assert all("pbo" in row["evidence_requirements"] for row in payload["candidates"])
    assert all("reality_check" in row["evidence_requirements"] for row in payload["candidates"])
    assert any(row["dataset_key"] == "institutional:foreign_net_buy" for row in payload["candidates"])
    assert any(row["strategy_spec_hint"]["thresholds"].get("minTechnicalIndicators", {}).get("rsi14") == 35 for row in payload["candidates"])
    assert any(row["strategy_spec_hint"]["thresholds"].get("minForeignTrustNet5d") == 0 for row in payload["candidates"])
    assert any(row["strategy_spec_hint"]["thresholds"].get("minRoe") == 3 for row in payload["candidates"])
    assert payload["checksum"].startswith("sha256:")


def test_finlab_ai_factor_miner_route_contract():
    router_source = (Path(__file__).resolve().parent.parent / "routers" / "finlab.py").read_text(encoding="utf-8")

    assert '@router.post("/ai-factor-discovery")' in router_source
    assert "discover_finlab_raw_factor_candidates" in router_source
    assert '"research_payload_only"' in router_source
    assert '"production_effect"] = False' in router_source
