from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.backtest_engine import AccountState, OpenPosition, PendingSettlement, _mark_to_market


class _Dataset:
    def get_bar(self, symbol: str, date: str):
        return {"close": 105.0}


def _position() -> OpenPosition:
    return OpenPosition(
        symbol="2330",
        industry="semi",
        entry_date="2026-08-17",
        entry_price=100.0,
        shares=1000,
        initial_stop=95.0,
        tp1_price=110.0,
        tp2_price=120.0,
        atr14=2.0,
        sl_mult=2.0,
        highest_since_entry=105.0,
    )


def test_pending_buy_is_payable_not_extra_nav():
    account = AccountState(cash=1_000_000.0, initial_capital=1_000_000.0)
    account.positions["2330"] = _position()
    account.pending_settlements.append(PendingSettlement(
        trade_date="2026-08-17",
        settlement_date="2026-08-19",
        side="buy",
        amount=100_142.5,
        symbol="2330",
    ))

    assert account.settlement_adjusted_cash == 899_857.5
    assert account.total_portfolio == 999_857.5
    assert _mark_to_market(account, _Dataset(), "2026-08-17") == 1_004_857.5


def test_pending_sell_is_receivable_not_temporary_drawdown():
    account = AccountState(cash=100_000.0, initial_capital=1_000_000.0)
    account.pending_settlements.append(PendingSettlement(
        trade_date="2026-08-17",
        settlement_date="2026-08-19",
        side="sell",
        amount=900_000.0,
        symbol="2330",
    ))

    assert account.settlement_adjusted_cash == 1_000_000.0
    assert _mark_to_market(account, _Dataset(), "2026-08-17") == 1_000_000.0
