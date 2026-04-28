"""
StockVisionStrategy — Freqtrade strategy mirroring paper.ts entry/exit logic

Entry: ML signal (BUY/STRONG_BUY) + confidence threshold
Exit: 7-layer cascade (hard stop → ATR stop → ML SELL → trailing → TP1 → TP2 → time stop)

Hyperopt-ready parameters for W4 parameter sensitivity analysis.
"""
import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import numpy as np
# Freqtrade strategy callbacks are pandas-native; this adapter is the only
# intentional pandas boundary outside StockVision's Polars/NumPy pipeline.
import pandas as pd
from freqtrade.strategy import IStrategy, DecimalParameter, IntParameter
from freqtrade.persistence import Trade

logger = logging.getLogger(__name__)

SIGNALS_DIR = Path('/freqtrade/user_data/data/signals')


class StockVisionStrategy(IStrategy):
    """
    Mirror of StockVision paper.ts trading logic for backtesting.

    Paper.ts 7-layer exit cascade:
      1. Hard stop (-12%)
      2. ATR initial stop (entry × 0.93 fallback)
      3. ML SELL signal (EOD)
      4. Chandelier trailing stop (ATR-based)
      5. TP1: sell 50% at entry × 1.03
      6. TP2: sell remaining at entry × 1.06
      7. Time stop: 20 days + profit > 0.5%
    """

    # ── Strategy metadata ──────────────────────────────────────────────────────
    INTERFACE_VERSION = 3
    timeframe = '1d'
    can_short = False
    stoploss = -0.12  # Hard stop: layer 1

    # Trailing stop disabled — we use custom_stoploss instead
    trailing_stop = False

    # ── Hyperopt parameters (for W4 grid search) ──────────────────────────────
    buy_confidence = DecimalParameter(0.50, 0.80, default=0.60, space='buy', optimize=True)
    hard_stop_pct = DecimalParameter(-0.15, -0.08, default=-0.12, space='sell', optimize=True)
    tp1_mult = DecimalParameter(1.02, 1.05, default=1.03, space='sell', optimize=True)
    tp2_mult = DecimalParameter(1.04, 1.10, default=1.06, space='sell', optimize=True)
    time_stop_days = IntParameter(10, 30, default=20, space='sell', optimize=True)
    trail_mult_default = DecimalParameter(2.0, 4.0, default=3.0, space='sell', optimize=True)
    trail_mult_3pct = DecimalParameter(1.5, 3.5, default=2.5, space='sell', optimize=True)
    trail_mult_8pct = DecimalParameter(1.5, 3.0, default=2.0, space='sell', optimize=True)

    # ── Signal cache ──────────────────────────────────────────────────────────
    _signals_cache: dict[str, list[dict]] = {}

    def _load_signals(self, symbol: str) -> list[dict]:
        """Load ML prediction signals for a stock."""
        # Extract symbol from pair (e.g., "2330/TWD" → "2330")
        sym = symbol.split('/')[0] if '/' in symbol else symbol.split('-')[0]

        if sym not in self._signals_cache:
            sig_file = SIGNALS_DIR / f'{sym}.json'
            if sig_file.exists():
                with open(sig_file) as f:
                    self._signals_cache[sym] = json.load(f)
            else:
                self._signals_cache[sym] = []

        return self._signals_cache[sym]

    def _get_signal_for_date(self, symbol: str, date_str: str) -> Optional[dict]:
        """Get ML signal for a specific date."""
        signals = self._load_signals(symbol)
        for s in signals:
            if s.get('date') == date_str:
                return s
        return None

    # ── Indicators ─────────────────────────────────────────────────────────────
    def populate_indicators(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        """Add ML signals + ATR as custom indicators."""
        pair = metadata['pair']

        # ATR(14) for trailing stop calculation
        high = dataframe['high']
        low = dataframe['low']
        close = dataframe['close']
        tr = pd.concat([
            high - low,
            (high - close.shift(1)).abs(),
            (low - close.shift(1)).abs(),
        ], axis=1).max(axis=1)
        dataframe['atr14'] = tr.rolling(14).mean()

        # ML signals
        signals = self._load_signals(pair)
        sig_map = {s['date']: s for s in signals}

        ml_signal = []
        ml_confidence = []
        ml_entry = []
        ml_stop = []
        ml_tp1 = []
        ml_tp2 = []

        for _, row in dataframe.iterrows():
            date_str = row['date'].strftime('%Y-%m-%d') if hasattr(row['date'], 'strftime') else str(row['date'])[:10]
            sig = sig_map.get(date_str, {})
            ml_signal.append(sig.get('signal', 'HOLD'))
            ml_confidence.append(sig.get('confidence', 0))
            ml_entry.append(sig.get('entry_price'))
            ml_stop.append(sig.get('stop_loss'))
            ml_tp1.append(sig.get('target1'))
            ml_tp2.append(sig.get('target2'))

        dataframe['ml_signal'] = ml_signal
        dataframe['ml_confidence'] = ml_confidence
        dataframe['ml_entry_price'] = ml_entry
        dataframe['ml_stop_loss'] = ml_stop
        dataframe['ml_target1'] = ml_tp1
        dataframe['ml_target2'] = ml_tp2

        return dataframe

    # ── Entry ──────────────────────────────────────────────────────────────────
    def populate_entry_trend(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        """ML BUY/STRONG_BUY + confidence threshold → entry."""
        dataframe.loc[
            (dataframe['ml_signal'].isin(['BUY', 'STRONG_BUY'])) &
            (dataframe['ml_confidence'] >= self.buy_confidence.value),
            'enter_long'
        ] = 1

        return dataframe

    # ── Exit ───────────────────────────────────────────────────────────────────
    def populate_exit_trend(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        """ML SELL signal → exit (layer 3)."""
        dataframe.loc[
            dataframe['ml_signal'].isin(['SELL', 'STRONG_SELL']),
            'exit_long'
        ] = 1

        return dataframe

    # ── Custom stoploss: ATR trailing (layers 2, 4) ────────────────────────────
    def custom_stoploss(self, pair: str, trade: Trade, current_time: datetime,
                        current_rate: float, current_profit: float,
                        after_fill: bool, **kwargs) -> Optional[float]:
        """
        Dynamic trailing stop based on profit level (mirror paper.ts Chandelier).

        Profit > 8% → tight trail (ATR × 2.0)
        Profit > 3% → medium trail (ATR × 2.5)
        Else → loose trail (ATR × 3.0)
        """
        dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        if dataframe.empty:
            return self.hard_stop_pct.value

        last = dataframe.iloc[-1]
        atr = last.get('atr14', 0)

        if atr <= 0:
            # Fallback: 2% of entry price as pseudo-ATR
            atr = trade.open_rate * 0.02

        # Select trail multiplier based on profit
        if current_profit > 0.08:
            trail_mult = self.trail_mult_8pct.value
        elif current_profit > 0.03:
            trail_mult = self.trail_mult_3pct.value
        else:
            trail_mult = self.trail_mult_default.value

        # Trailing stop distance as ratio
        trail_distance = (atr * trail_mult) / current_rate

        # Don't widen stop beyond hard stop
        return max(-trail_distance, self.hard_stop_pct.value)

    # ── Custom exit: TP1/TP2 + time stop (layers 5, 6, 7) ─────────────────────
    def custom_exit(self, pair: str, trade: Trade, current_time: datetime,
                    current_rate: float, current_profit: float,
                    **kwargs) -> Optional[str]:
        """
        Layer 5: TP1 at entry × tp1_mult → partial exit (50%)
        Layer 6: TP2 at entry × tp2_mult → full exit
        Layer 7: Time stop after N days + profit > 0.5%
        """
        entry_price = trade.open_rate

        # ── TP2: full exit ──
        tp2_price = entry_price * self.tp2_mult.value
        if current_rate >= tp2_price:
            return f'TP2 @ {current_rate:.1f} (+{current_profit*100:.1f}%)'

        # ── TP1: partial exit (Freqtrade doesn't support partial — treat as full) ──
        # Note: Freqtrade v2024+ supports partial exits via exit_reason + custom_exit_price
        # For simplicity, TP1 triggers full exit (conservative)
        tp1_price = entry_price * self.tp1_mult.value
        if current_rate >= tp1_price:
            return f'TP1 @ {current_rate:.1f} (+{current_profit*100:.1f}%)'

        # ── Time stop: N days + profit > 0.5% ──
        days_held = (current_time - trade.open_date_utc).days
        if days_held >= self.time_stop_days.value and current_profit > 0.005:
            return f'TimeStop ({days_held}d, +{current_profit*100:.1f}%)'

        return None

    # ── Leverage (spot only) ───────────────────────────────────────────────────
    def leverage(self, pair: str, current_time: datetime, current_rate: float,
                 proposed_leverage: float, max_leverage: float,
                 entry_tag: Optional[str], side: str, **kwargs) -> float:
        return 1.0  # 台股現股，無槓桿
