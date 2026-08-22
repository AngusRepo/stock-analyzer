from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.obsidian_position_valuation import hydrate_position_valuations  # noqa: E402


class PositionValuationTests(unittest.TestCase):
    def test_reads_owner_domains_and_is_point_in_time(self) -> None:
        calls: list[tuple[str, list | None, str]] = []

        async def fake_query(_client, sql, params=None, *, domain):
            calls.append((sql, params, domain))
            if domain == "core":
                return [{"id": 11, "symbol": "2330"}, {"id": 22, "symbol": "2317"}]
            if domain == "market":
                return [
                    {"stock_id": 11, "date": "2026-08-21", "close": 1000.0},
                    {"stock_id": 11, "date": "2026-08-20", "close": 990.0},
                    {"stock_id": 22, "date": "2026-08-20", "close": 210.0},
                ]
            raise AssertionError(f"unexpected domain: {domain}")

        rows = asyncio.run(hydrate_position_valuations(
            fake_query,
            object(),
            [
                {"symbol": "2330", "shares": 10, "avg_cost": 900.0},
                {"symbol": "2317", "shares": 20, "avg_cost": 200.0},
            ],
            as_of_date="2026-08-21",
            core_domain="core",
            market_domain="market",
        ))

        self.assertEqual(rows[0]["current_price"], 1000.0)
        self.assertEqual(rows[0]["price_date"], "2026-08-21")
        self.assertEqual(rows[0]["unrealized_pnl"], 1000)
        self.assertEqual(rows[0]["unrealized_pnl_pct"], 11.11)
        self.assertEqual(rows[1]["current_price"], 210.0)
        self.assertEqual(rows[1]["unrealized_pnl"], 200)
        self.assertEqual(calls[0][2], "core")
        self.assertEqual(calls[1][2], "market")
        self.assertIn("date <= ?", calls[1][0])
        self.assertEqual(calls[1][1][-2:], ["2026-08-21", "2026-08-21"])

    def test_paper_query_excludes_derived_market_columns(self) -> None:
        source = Path("ml-controller/services/obsidian_writer.py").read_text(encoding="utf-8")
        self.assertIn('SELECT symbol, name, shares, avg_cost, entry_price "', source)
        self.assertNotIn('entry_price, current_price', source)
        self.assertNotIn('unrealized_pnl, unrealized_pnl_pct FROM paper_positions', source)


if __name__ == "__main__":
    unittest.main()