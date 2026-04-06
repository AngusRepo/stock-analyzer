"""
rl_env.py — P3#29 RL Shadow Trading Environment

Gymnasium env wrapping stock price data for RL training.
Shadow mode: predictions recorded but never executed.
"""
import gymnasium as gym
from gymnasium import spaces
import numpy as np


class StockTradingEnv(gym.Env):
    """
    Single-stock trading environment.

    Observation (38 dims):
      - 32 features from FEATURE_COLS
      - position_pct, entry_price_ratio, unrealized_pnl_pct
      - hold_days_ratio, cash_ratio, portfolio_return_pct

    Action: Discrete(3) = {0: HOLD, 1: BUY, 2: SELL}
    Reward: daily portfolio P&L - transaction cost
    Episode: one stock, 250 trading days
    """

    metadata = {"render_modes": []}

    def __init__(self, prices, features, initial_cash=1_000_000,
                 buy_fee=0.001425, sell_fee=0.004425, max_hold_days=30):
        super().__init__()
        self.prices = np.array(prices, dtype=np.float32)
        self.features = np.array(features, dtype=np.float32)
        self.n_days = len(prices)
        self.initial_cash = initial_cash
        self.buy_fee = buy_fee
        self.sell_fee = sell_fee
        self.max_hold_days = max_hold_days

        self.action_space = spaces.Discrete(3)
        self.observation_space = spaces.Box(
            low=-np.inf, high=np.inf, shape=(38,), dtype=np.float32
        )
        self.reset()

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        self.current_step = 0
        self.cash = self.initial_cash
        self.shares = 0
        self.entry_price = 0
        self.hold_days = 0
        self.portfolio_value = self.initial_cash
        return self._get_obs(), {}

    def _get_obs(self):
        idx = min(self.current_step, len(self.features) - 1)
        feat = self.features[idx] if idx < len(self.features) else np.zeros(32, dtype=np.float32)
        if len(feat) < 32:
            feat = np.pad(feat, (0, 32 - len(feat)))

        price = self.prices[min(self.current_step, self.n_days - 1)]
        position_pct = 1.0 if self.shares > 0 else 0.0
        entry_ratio = price / self.entry_price if self.entry_price > 0 else 0.0
        pnl_pct = (price - self.entry_price) / self.entry_price if self.entry_price > 0 else 0.0
        hold_ratio = self.hold_days / self.max_hold_days
        cash_ratio = self.cash / self.initial_cash
        portfolio_ret = (self.portfolio_value - self.initial_cash) / self.initial_cash

        return np.concatenate([
            feat[:32],
            [position_pct, entry_ratio, pnl_pct, hold_ratio, cash_ratio, portfolio_ret]
        ]).astype(np.float32)

    def step(self, action):
        price = self.prices[min(self.current_step, self.n_days - 1)]
        reward = 0.0

        if action == 1 and self.shares == 0:  # BUY
            max_shares = int(self.cash * 0.95 / (price * (1 + self.buy_fee)))
            if max_shares > 0:
                cost = max_shares * price * (1 + self.buy_fee)
                self.cash -= cost
                self.shares = max_shares
                self.entry_price = price
                self.hold_days = 0

        elif action == 2 and self.shares > 0:  # SELL
            proceeds = self.shares * price * (1 - self.sell_fee)
            pnl = proceeds - self.shares * self.entry_price * (1 + self.buy_fee)
            reward = pnl / self.initial_cash
            self.cash += proceeds
            self.shares = 0
            self.entry_price = 0
            self.hold_days = 0

        if self.shares > 0:
            self.hold_days += 1

        self.portfolio_value = self.cash + self.shares * price

        # Small unrealized P&L signal
        if self.shares > 0 and self.current_step > 0:
            prev_price = self.prices[self.current_step - 1]
            daily_pnl = self.shares * (price - prev_price) / self.initial_cash
            reward += daily_pnl * 0.1

        self.current_step += 1
        terminated = self.current_step >= self.n_days - 1
        return self._get_obs(), reward, terminated, False, {}
