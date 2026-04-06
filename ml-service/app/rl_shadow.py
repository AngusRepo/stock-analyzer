"""
rl_shadow.py — P3#29 RL Shadow Mode

Train PPO on historical data, record daily predictions.
Shadow only — predictions NEVER affect actual trading decisions.
"""
import logging
import numpy as np
from typing import Optional

logger = logging.getLogger("rl_shadow")


def train_rl_shadow(
    prices: np.ndarray,
    features: np.ndarray,
    stock_id: int = 0,
    total_timesteps: int = 50000,
) -> Optional[dict]:
    """
    Train PPO policy on historical data for a single stock.
    Called during weekly retrain cycle.
    """
    try:
        from stable_baselines3 import PPO
        from .rl_env import StockTradingEnv
    except ImportError:
        logger.warning("[RL Shadow] stable-baselines3 or gymnasium not available")
        return None

    if len(prices) < 60 or len(features) < 60:
        return None

    env = StockTradingEnv(prices, features)

    model = PPO(
        "MlpPolicy", env,
        learning_rate=3e-4,
        n_steps=256,
        batch_size=64,
        n_epochs=10,
        gamma=0.99,
        verbose=0,
    )

    model.learn(total_timesteps=total_timesteps)

    # Evaluate on last 20%
    eval_start = int(len(prices) * 0.8)
    eval_env = StockTradingEnv(prices[eval_start:], features[eval_start:])
    obs, _ = eval_env.reset()
    total_reward = 0
    actions_taken = {"hold": 0, "buy": 0, "sell": 0}

    for _ in range(len(prices) - eval_start - 1):
        action, _ = model.predict(obs, deterministic=True)
        obs, reward, done, truncated, _ = eval_env.step(action)
        total_reward += reward
        actions_taken[["hold", "buy", "sell"][int(action)]] += 1
        if done or truncated:
            break

    eval_return = (eval_env.portfolio_value - eval_env.initial_cash) / eval_env.initial_cash

    result = {
        "trained": True,
        "stock_id": stock_id,
        "total_timesteps": total_timesteps,
        "eval_return_pct": round(eval_return * 100, 2),
        "eval_total_reward": round(total_reward, 4),
        "actions": actions_taken,
    }

    logger.info(f"[RL Shadow] stock {stock_id}: eval return {eval_return*100:.1f}%")
    return result


def rl_shadow_predict(
    model_path: str,
    current_features: np.ndarray,
    current_price: float,
    position_state: dict,
) -> Optional[dict]:
    """
    Shadow prediction using trained RL policy.
    Returns action recommendation (recorded, never executed).
    """
    try:
        from stable_baselines3 import PPO
    except ImportError:
        return None

    try:
        model = PPO.load(model_path)
    except Exception:
        return None

    feat = current_features[:32] if len(current_features) >= 32 else np.pad(
        current_features, (0, 32 - len(current_features)))
    pos_pct = 1.0 if position_state.get("has_position") else 0.0
    entry_ratio = (current_price / position_state.get("entry_price", current_price)
                   if position_state.get("entry_price", 0) > 0 else 0.0)
    pnl_pct = position_state.get("pnl_pct", 0.0)
    hold_ratio = position_state.get("hold_days", 0) / 30.0
    cash_ratio = position_state.get("cash_ratio", 1.0)
    port_ret = position_state.get("portfolio_return", 0.0)

    obs = np.concatenate([
        feat, [pos_pct, entry_ratio, pnl_pct, hold_ratio, cash_ratio, port_ret]
    ]).astype(np.float32)

    action, _ = model.predict(obs, deterministic=True)
    action_name = ["HOLD", "BUY", "SELL"][int(action)]

    return {
        "shadow_action": action_name,
        "model": "rl_ppo",
        "note": "SHADOW ONLY - not executed",
    }
