"""
ft_online_update.py — P2#22 FT-Transformer Online Update

After daily verify, fine-tune last 2 layers with new 5-day (X, y) data.
lr=1e-4, 3 epochs. Don't touch embedding layers. Full retrain only on Sunday.
"""
import logging
import numpy as np
from typing import Optional

logger = logging.getLogger(__name__)

# Online update params
ONLINE_LR = 1e-4
ONLINE_EPOCHS = 3
MIN_NEW_SAMPLES = 5


def online_update_ft_transformer(
    model_bundle: dict,
    X_new: np.ndarray,
    y_new: np.ndarray,
) -> Optional[dict]:
    """
    Fine-tune the last 2 layers of FT-Transformer with new data.

    Args:
        model_bundle: saved FT-Transformer bundle (model + scaler + metadata)
        X_new: new feature matrix (from last 5 days)
        y_new: actual outcomes (direction: 0/1)

    Returns:
        Updated bundle dict with training metrics, or None if skipped.
    """
    if len(X_new) < MIN_NEW_SAMPLES:
        logger.info(f"[FT-Online] Only {len(X_new)} new samples, need {MIN_NEW_SAMPLES}. Skipping.")
        return None

    if len(set(y_new.tolist() if hasattr(y_new, 'tolist') else list(y_new))) < 2:
        logger.info("[FT-Online] No class variance in new data. Skipping.")
        return None

    try:
        import torch
        import torch.nn as nn
    except ImportError:
        logger.warning("[FT-Online] PyTorch not available. Skipping online update.")
        return None

    model = model_bundle.get("model")
    scaler = model_bundle.get("scaler")

    if model is None:
        logger.warning("[FT-Online] No model in bundle. Skipping.")
        return None

    # Scale features
    if scaler is not None:
        X_scaled = scaler.transform(X_new)
    else:
        X_scaled = X_new

    X_t = torch.FloatTensor(X_scaled)
    y_t = torch.LongTensor(y_new.astype(int))

    # Freeze all layers except last 2
    for name, param in model.named_parameters():
        param.requires_grad = False

    # Unfreeze last 2 layers (typically classifier head)
    # Unfreeze last 2 LAYERS (each layer has weight+bias = 2 params, so 4 total)
    unfrozen = 0
    for name, param in reversed(list(model.named_parameters())):
        if unfrozen < 4:
            param.requires_grad = True
            unfrozen += 1
            logger.info(f"[FT-Online] Unfreezing: {name}")

    # Fine-tune
    optimizer = torch.optim.Adam(
        [p for p in model.parameters() if p.requires_grad],
        lr=ONLINE_LR,
    )
    criterion = nn.CrossEntropyLoss()

    model.train()
    losses = []
    for epoch in range(ONLINE_EPOCHS):
        optimizer.zero_grad()
        output = model(X_t)
        loss = criterion(output, y_t)
        loss.backward()
        optimizer.step()
        losses.append(float(loss.item()))

    model.eval()

    # Unfreeze all for next full retrain
    for param in model.parameters():
        param.requires_grad = True

    return {
        "updated": True,
        "samples": len(X_new),
        "epochs": ONLINE_EPOCHS,
        "final_loss": round(losses[-1], 4) if losses else None,
        "loss_trajectory": [round(l, 4) for l in losses],
    }
