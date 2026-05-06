"""
optuna_fttransformer_arch.py — FT-Transformer architecture search

Roadmap: #29 "FT-T architecture Optuna (d_model / n_heads / n_layers / dropout)"
         project_optimization_queue.md

Current FT-T hyperparameters (hardcoded in main.py):
  d_model  = 128   (embedding dim)
  n_heads  = 8     (multi-head attention)
  n_layers = 3     (transformer blocks)
  dropout  = 0.1

Search space:
  d_model  ∈ {64, 96, 128, 160, 192, 256}
  n_heads  ∈ {2, 4, 8}    (must divide d_model)
  n_layers ∈ {2, 3, 4, 5, 6}
  dropout  ∈ [0.0, 0.3]   continuous

Objective: Rank IC on validation fold (MarginRankingLoss downstream metric).
           Best FT-T run IC so far = 0.0547 (Run #2 with warmup) / 0.0378 (Run #1).
           Current Run #3 no-warmup = 0.0204. Architecture search is one lever
           to recover the 0.04+ regime without re-adding warmup.

🔒 LOCKED constraints (DO NOT search these — see feedback_ft_transformer_tuning.md):
  ❌ Do NOT search warmup_ratio — locked to 0 (or ≤0.02 minimal if ever revived)
  ❌ Do NOT search PATIENCE — locked to 16
  ❌ Do NOT search loss type — locked to MarginRankingLoss
  ❌ Do NOT search cosine decay — removed and locked off

GPU requirement:
  Each trial = one full retrain cycle (~3-5 min on L4 GPU with 681K samples).
  50 trials ≈ 3-4 hours of GPU wall clock. Budget accordingly.

Usage:
  # Inside Modal function (has GPU): call from retrain_trigger.py or manually
  #   python -m app.optuna_fttransformer_arch --n-trials=50 --subset=50000

  # WARNING: this is the arch search. Full-retrain-after-search (to push to GCS)
  # must be triggered via retrain_trigger.py `force_monthly=True` after Wei picks
  # a winning config — DO NOT auto-push.

Output: best params dict + JSON audit trail. Does NOT auto-update hardcoded
        defaults — Wei must manually copy best config into main.py FTTransformer
        class after reviewing results.
"""
from __future__ import annotations
import argparse
import json
import logging
import os
from typing import Callable

import numpy as np

logger = logging.getLogger(__name__)


def _build_ftt_model(n_feat: int, d_model: int, n_heads: int, n_layers: int,
                     dropout: float):
    """Construct an FT-Transformer matching main.py shape."""
    import torch.nn as nn
    import torch

    class FTTransformer(nn.Module):
        def __init__(self):
            super().__init__()
            self.feat_embed = nn.Linear(1, d_model, bias=True)
            self.cls_token = nn.Parameter(torch.zeros(1, 1, d_model))
            encoder_layer = nn.TransformerEncoderLayer(
                d_model=d_model, nhead=n_heads,
                dim_feedforward=int(d_model * 4 / 3),
                dropout=dropout, batch_first=True, norm_first=True,
            )
            self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=n_layers)
            self.head = nn.Linear(d_model, 1)

        def forward(self, x):
            # x: (batch, n_feat)
            batch = x.size(0)
            h = self.feat_embed(x.unsqueeze(-1))                 # (batch, n_feat, d_model)
            cls = self.cls_token.expand(batch, -1, -1)            # (batch, 1, d_model)
            h = torch.cat([cls, h], dim=1)                        # (batch, n_feat+1, d_model)
            h = self.encoder(h)
            return self.head(h[:, 0]).squeeze(-1)                 # (batch,)

    return FTTransformer()


def _train_one_trial(
    d_model: int, n_heads: int, n_layers: int, dropout: float,
    X_train: np.ndarray, y_train: np.ndarray,
    X_val: np.ndarray,   y_val:   np.ndarray,
    max_epochs: int = 30,  # shorter for search (real retrain uses more)
    patience: int = 8,     # shorter ES patience inside search
) -> float:
    """Train an FT-T with given arch and return validation Rank IC.

    Uses MarginRankingLoss (locked) and AdamW (main.py default).
    Patience for search is 8 (not the locked production 16) — search is shorter
    for throughput. The WINNING config is then re-trained with production settings.

    #29a.3 debug fixes (2026-04-21):
      - Val set size sanity (reject < 50 rows — MarginRankingLoss needs enough pairs)
      - Batched val inference (VAL_BATCH=2048) to prevent L4 OOM on large d_model ×
        full-val pass (137K × 101 feats × d_model=256 × n_layers=6 ≈ 14GB
        activation in one shot, exceeds L4's 24GB at peak)
    """
    import torch
    import torch.nn as nn
    from torch.utils.data import DataLoader, TensorDataset
    from scipy.stats import spearmanr

    # Fix 3 (#29a.3): val set size sanity — guard against tiny val post-subset
    if len(y_val) < 50:
        raise ValueError(f"val set too small for MarginRankingLoss: {len(y_val)} rows < 50 minimum")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = _build_ftt_model(X_train.shape[1], d_model, n_heads, n_layers, dropout).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=2e-4, weight_decay=1e-4)

    # Build pairs for MarginRankingLoss (sample 512 pairs per batch)
    X_tr = torch.tensor(X_train, dtype=torch.float32).to(device)
    y_tr = torch.tensor(y_train, dtype=torch.float32).to(device)
    X_va = torch.tensor(X_val,   dtype=torch.float32).to(device)

    criterion = nn.MarginRankingLoss(margin=0.0)
    best_ic, no_improve = -1e9, 0
    batch_size = 256
    VAL_BATCH = 2048  # Fix 2 (#29a.3): chunked val inference, prevents OOM

    for epoch in range(max_epochs):
        model.train()
        perm = torch.randperm(len(X_tr), device=device)
        for i in range(0, len(perm), batch_size):
            idx = perm[i:i + batch_size]
            if len(idx) < 16:
                continue
            x_b = X_tr[idx]
            y_b = y_tr[idx]
            preds = model(x_b)
            # Build random pairs within batch
            a_idx = torch.randperm(len(idx), device=device)
            b_idx = torch.randperm(len(idx), device=device)
            y_a, y_b_ = y_b[a_idx], y_b[b_idx]
            sign = torch.where(y_a > y_b_, 1.0, -1.0)
            # Skip ties
            mask = y_a != y_b_
            if mask.sum() < 8:
                continue
            loss = criterion(preds[a_idx][mask], preds[b_idx][mask], sign[mask])
            opt.zero_grad()
            loss.backward()
            opt.step()

        # Validation IC — chunked to avoid OOM on large d_model × full val
        model.eval()
        with torch.no_grad():
            pred_chunks = []
            for i in range(0, len(X_va), VAL_BATCH):
                pred_chunks.append(model(X_va[i:i + VAL_BATCH]).cpu().numpy())
            pred_val = np.concatenate(pred_chunks) if pred_chunks else np.array([])

        ic, _ = spearmanr(pred_val, y_val)
        ic = float(ic or 0.0)
        if ic > best_ic:
            best_ic, no_improve = ic, 0
        else:
            no_improve += 1
            if no_improve >= patience:
                break

    return best_ic


def run_search(X_train, y_train, X_val, y_val, n_trials: int = 50,
               save_path: str = "/tmp/fttransformer_optuna.json") -> dict:
    """Run NSGA-II (single-objective) search on FT-T architecture.

    Returns dict with best_params + all_trials for audit.
    """
    try:
        import optuna
        optuna.logging.set_verbosity(optuna.logging.WARNING)
    except ImportError:
        raise RuntimeError("optuna not installed; pip install optuna")

    def objective(trial: optuna.Trial):
        d_model  = trial.suggest_categorical("d_model", [64, 96, 128, 160, 192, 256])
        # n_heads must divide d_model
        valid_heads = [h for h in (2, 4, 8) if d_model % h == 0]
        n_heads  = trial.suggest_categorical("n_heads", valid_heads)
        n_layers = trial.suggest_int("n_layers", 2, 6)
        dropout  = trial.suggest_float("dropout", 0.0, 0.3, step=0.05)

        logger.info(f"[FT-T Optuna] trial {trial.number}: "
                    f"d={d_model} h={n_heads} L={n_layers} p={dropout:.2f}")

        try:
            ic = _train_one_trial(d_model, n_heads, n_layers, dropout,
                                  X_train, y_train, X_val, y_val)
        except Exception as e:
            # #29a.3 Fix 1: surface full exception instead of swallowing.
            # Previous behavior silently returned -1.0 — Wei couldn't diagnose
            # why trials failed (e.g. OOM vs val-too-small vs shape mismatch).
            import traceback as _tb
            logger.error(f"[FT-T Optuna] trial {trial.number} crashed: {type(e).__name__}: {e}")
            logger.error(_tb.format_exc())
            # Stash on trial user_attrs so final result can expose crash taxonomy
            trial.set_user_attr("crash_reason", f"{type(e).__name__}: {str(e)[:200]}")
            return -1.0
        logger.info(f"[FT-T Optuna] trial {trial.number} IC={ic:.4f}")
        return ic

    study = optuna.create_study(direction="maximize", study_name="fttransformer_arch")
    study.optimize(objective, n_trials=n_trials, show_progress_bar=False)

    best = study.best_trial
    # #29a.3 Fix 5: surface crash taxonomy so Wei sees why trials failed
    # instead of only seeing aggregate -1.0 fallbacks.
    crash_reasons = {}
    for t in study.trials:
        if t.value == -1.0 and t.user_attrs.get("crash_reason"):
            crash_reasons[t.number] = t.user_attrs["crash_reason"]

    result = {
        "best_ic": best.value,
        "best_params": best.params,
        "n_trials": len(study.trials),
        "n_crashed": len(crash_reasons),
        "crash_reasons": crash_reasons,
        "all_trials": [
            {"number": t.number, "value": t.value, "params": t.params,
             "crash_reason": t.user_attrs.get("crash_reason")}
            for t in study.trials
            if t.value is not None
        ],
    }

    with open(save_path, "w") as f:
        json.dump(result, f, indent=2)
    logger.info(f"[FT-T Optuna] saved → {save_path} — best IC {best.value:.4f}")
    logger.info(f"[FT-T Optuna] best params: {best.params}")
    logger.info(f"[FT-T Optuna] ⚠️  Wei must manually apply winning config to "
                f"main.py FTTransformer class. DO NOT auto-update production.")

    return result


def load_prep_data_from_gcs(gcs_prefix: str = "universal") -> tuple:
    """Load X_train/y_train/X_val/y_val from GCS prep npz files.

    Uses the same time-based 80/20 split as train_universal_from_gcs so the
    search evaluates the same OOS distribution production training sees.
    """
    import io
    from google.cloud import storage

    bucket_name = os.environ.get("GCS_BUCKET_NAME")
    if not bucket_name:
        raise RuntimeError("GCS_BUCKET_NAME not configured")
    bucket = storage.Client().bucket(bucket_name)
    prefix = f"{gcs_prefix}/prep/"
    blobs = sorted(
        [b for b in bucket.list_blobs(prefix=prefix) if b.name.endswith(".npz")],
        key=lambda b: b.name,
    )
    if not blobs:
        raise RuntimeError(f"No prep npz at gs://{bucket_name}/{prefix}")

    all_X, all_y, all_dates = [], [], []
    for blob in blobs:
        buf = io.BytesIO()
        blob.download_to_file(buf)
        buf.seek(0)
        data = np.load(buf, allow_pickle=True)
        all_X.append(data["X"])
        all_y.append(data["y"])
        all_dates.append(data["dates"])
    X = np.vstack(all_X)
    y = np.concatenate(all_y)
    dates = np.concatenate(all_dates)

    sorted_dates = np.sort(np.unique(dates))
    cutoff_idx = max(1, int(len(sorted_dates) * 0.8))
    cutoff_date = sorted_dates[cutoff_idx]
    train_mask = dates <= cutoff_date
    val_mask = dates > cutoff_date

    X_tr, y_tr = X[train_mask], y[train_mask]
    X_va, y_va = X[val_mask],   y[val_mask]
    logger.info(
        f"[FT-T Optuna] Loaded prep: train={len(X_tr)} val={len(X_va)} "
        f"feats={X.shape[1]} cutoff={cutoff_date}"
    )
    return X_tr, y_tr, X_va, y_va


if __name__ == "__main__":
    # Minimal CLI for running inside Modal container with GPU
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--n-trials", type=int, default=50)
    parser.add_argument("--train-npz", required=True,
                        help="npz with X_train, y_train, X_val, y_val arrays")
    parser.add_argument("--save-path", default="/tmp/fttransformer_optuna.json")
    args = parser.parse_args()

    data = np.load(args.train_npz)
    run_search(
        data["X_train"], data["y_train"], data["X_val"], data["y_val"],
        n_trials=args.n_trials, save_path=args.save_path,
    )
