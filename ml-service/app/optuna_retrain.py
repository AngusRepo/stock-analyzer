"""
optuna_retrain.py — Per-model Optuna hyperparameter search during weekly retrain (P1#9)

For each tree-based model, runs a quick Optuna search (20 trials) to find
optimal hyperparameters for the current stock's data distribution.

Search spaces:
  XGBoost:    depth[3-6], lr[0.01-0.1], n_estimators[100-300]
  CatBoost:   depth[3-7], lr[0.01-0.1], iterations[100-300]
  ExtraTrees: depth[4-8], n_estimators[100-300], min_samples_split[3-10]
  LightGBM:   depth[3-7], lr[0.01-0.1], n_leaves[20-60]
"""
import logging
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

N_TRIALS = 20  # quick search per model per stock


def _optuna_xgboost(X_train, y_train, X_val, y_val) -> dict:
    """Optuna search for XGBoost hyperparameters."""
    import optuna
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    from xgboost import XGBClassifier

    def objective(trial):
        params = {
            "n_estimators": trial.suggest_int("n_estimators", 100, 300, step=50),
            "max_depth": trial.suggest_int("max_depth", 3, 6),
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.1, log=True),
            "subsample": trial.suggest_float("subsample", 0.7, 1.0),
            "colsample_bytree": trial.suggest_float("colsample_bytree", 0.7, 1.0),
            "use_label_encoder": False,
            "eval_metric": "logloss",
            "random_state": 42,
            "verbosity": 0,
        }
        m = XGBClassifier(**params)
        m.fit(X_train, y_train)
        return float(m.score(X_val, y_val))

    study = optuna.create_study(direction="maximize")
    study.optimize(objective, n_trials=N_TRIALS, show_progress_bar=False)
    return study.best_params


def _optuna_catboost(X_train, y_train, X_val, y_val) -> dict:
    """Optuna search for CatBoost hyperparameters."""
    import optuna
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    from catboost import CatBoostClassifier

    def objective(trial):
        params = {
            "iterations": trial.suggest_int("iterations", 100, 300, step=50),
            "depth": trial.suggest_int("depth", 3, 7),
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.1, log=True),
            "l2_leaf_reg": trial.suggest_float("l2_leaf_reg", 1.0, 10.0),
            "loss_function": "Logloss",
            "random_seed": 42,
            "verbose": 0,
        }
        m = CatBoostClassifier(**params)
        m.fit(X_train, y_train)
        return float(m.score(X_val, y_val))

    study = optuna.create_study(direction="maximize")
    study.optimize(objective, n_trials=N_TRIALS, show_progress_bar=False)
    return study.best_params


def _optuna_extratrees(X_train, y_train, X_val, y_val) -> dict:
    """Optuna search for ExtraTrees hyperparameters."""
    import optuna
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    from sklearn.ensemble import ExtraTreesClassifier

    def objective(trial):
        params = {
            "n_estimators": trial.suggest_int("n_estimators", 100, 300, step=50),
            "max_depth": trial.suggest_int("max_depth", 4, 8),
            "min_samples_split": trial.suggest_int("min_samples_split", 3, 10),
            "min_samples_leaf": trial.suggest_int("min_samples_leaf", 2, 5),
            "max_features": "sqrt",
            "class_weight": "balanced",
            "bootstrap": True,
            "random_state": 42,
            "n_jobs": -1,
        }
        m = ExtraTreesClassifier(**params)
        m.fit(X_train, y_train)
        return float(m.score(X_val, y_val))

    study = optuna.create_study(direction="maximize")
    study.optimize(objective, n_trials=N_TRIALS, show_progress_bar=False)
    return study.best_params


def _optuna_lightgbm(X_train, y_train, X_val, y_val) -> dict:
    """Optuna search for LightGBM hyperparameters."""
    import optuna
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    import lightgbm as lgb

    def objective(trial):
        params = {
            "n_estimators": trial.suggest_int("n_estimators", 100, 300, step=50),
            "max_depth": trial.suggest_int("max_depth", 3, 7),
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.1, log=True),
            "num_leaves": trial.suggest_int("num_leaves", 20, 60),
            "subsample": trial.suggest_float("subsample", 0.7, 1.0),
            "colsample_bytree": trial.suggest_float("colsample_bytree", 0.7, 1.0),
            "class_weight": "balanced",
            "random_state": 42,
            "verbose": -1,
        }
        m = lgb.LGBMClassifier(**params)
        m.fit(X_train, y_train)
        return float(m.score(X_val, y_val))

    study = optuna.create_study(direction="maximize")
    study.optimize(objective, n_trials=N_TRIALS, show_progress_bar=False)
    return study.best_params


OPTUNA_SEARCHERS = {
    "XGBoost": _optuna_xgboost,
    "CatBoost": _optuna_catboost,
    "ExtraTrees": _optuna_extratrees,
    "LightGBM": _optuna_lightgbm,
}


def search_best_params(
    model_name: str,
    X: np.ndarray,
    y: np.ndarray,
    split_ratio: float = 0.8,
) -> Optional[dict]:
    """
    Run Optuna search for a model. Returns best_params dict or None.
    FT-Transformer is excluded (PyTorch, needs different optimization).
    """
    searcher = OPTUNA_SEARCHERS.get(model_name)
    if not searcher:
        return None

    split = int(len(X) * split_ratio)
    if split < 20 or len(X) - split < 10:
        return None

    # VULN-22 fix: skip if features contain NaN
    if np.isnan(X).any():
        logger.warning(f"[Optuna] {model_name}: X contains NaN values, skipping")
        return None

    # VULN-24 fix: skip Optuna if labels have no variance (all same class)
    unique_classes = len(set(y[:split].tolist() if hasattr(y[:split], 'tolist') else list(y[:split])))
    if unique_classes < 2:
        logger.warning(f"[Optuna] {model_name}: y has only {unique_classes} class(es), skipping")
        return None

    X_train, X_val = X[:split], X[split:]
    y_train, y_val = y[:split], y[split:]

    try:
        best = searcher(X_train, y_train, X_val, y_val)
        logger.info(f"[Optuna] {model_name}: best_params = {best}")
        return best
    except Exception as e:
        logger.warning(f"[Optuna] {model_name} search failed: {e}")
        return None
