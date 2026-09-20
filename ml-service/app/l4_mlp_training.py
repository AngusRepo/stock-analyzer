"""Accepted three-head EV residual network; explicit fitting only, no publication."""
from copy import deepcopy
import numpy as np
import torch
from torch import nn


class ResidualBlock(nn.Module):
    def __init__(self, width, dropout):
        super().__init__()
        self.transform = nn.Sequential(nn.LayerNorm(width), nn.Linear(width, width), nn.GELU(),
                                       nn.Dropout(dropout), nn.Linear(width, width))

    def forward(self, x):
        return x + self.transform(x)


class AnchoredResidualMLP(nn.Module):
    def __init__(self, inputs=30, width=128, blocks=3, dropout=0.1):
        super().__init__()
        self.input = nn.Linear(inputs, width)
        self.blocks = nn.Sequential(*[ResidualBlock(width, dropout) for _ in range(blocks)])
        self.output = nn.Linear(width, 1)
        nn.init.zeros_(self.output.weight)
        nn.init.zeros_(self.output.bias)

    def correction(self, features):
        return self.output(self.blocks(torch.nn.functional.gelu(self.input(features)))).squeeze(-1)

    def forward(self, features, anchor, residual_scale=1.0):
        return anchor + residual_scale * self.correction(features)


def fit(train_x, train_y, train_anchor, train_weights, *, valid=None, epochs=30, patience=5,
        seed=42, device='cpu', batch_size=1024):
    """Inputs/scaling are trained upstream on training dates only; valid must be purged.

    Validation selects epoch only. A caller must refit on the complete permitted
    training data for exactly that epoch count before predicting an outer fold.
    """
    torch.manual_seed(seed)
    model = AnchoredResidualMLP(inputs=train_x.shape[1]).to(device)
    weights = np.asarray(train_weights, dtype=np.float64)
    assert weights.shape == train_y.shape and np.isfinite(weights).all() and (weights > 0).all()
    weights = weights / weights.sum()
    residual = np.asarray(train_y) - np.asarray(train_anchor)
    scale = max(float(np.sqrt(weights @ (residual ** 2))), 0.001)
    x = torch.as_tensor(np.asarray(train_x), dtype=torch.float32)
    target = torch.as_tensor(residual / scale, dtype=torch.float32)
    w = torch.as_tensor(weights * len(weights), dtype=torch.float32)
    loader = torch.utils.data.DataLoader(torch.utils.data.TensorDataset(x, target, w),
                                         batch_size=batch_size, shuffle=True, num_workers=0)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.001, weight_decay=0.001)
    best_state, best_loss, best_epoch, stale, history = None, float('inf'), 0, 0, []
    for epoch in range(1, epochs + 1):
        model.train()
        for xb, yb, wb in loader:
            optimizer.zero_grad(set_to_none=True)
            error = model.correction(xb.to(device)) - yb.to(device)
            loss = (wb.to(device) * error.square()).mean()
            if not torch.isfinite(loss):
                raise ValueError('nonfinite_residual_mlp_loss')
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 3.0)
            optimizer.step()
        if valid is None:
            best_epoch = epoch
            continue
        vx, vy, va, vw = valid
        prediction = predict(model, vx, va, scale=scale, device=device)
        score = float(np.average((prediction - vy) ** 2, weights=vw))
        history.append({'epoch': epoch, 'date_weighted_validation_mse': score})
        if score < best_loss:
            best_loss, best_epoch, stale = score, epoch, 0
            best_state = deepcopy(model.state_dict())
        else:
            stale += 1
            if stale >= patience:
                break
    if best_state is not None:
        model.load_state_dict(best_state)
    return model, {'residual_scale': scale, 'selected_epochs': best_epoch, 'history': history,
                   'anchor_preserved_at_initialization': True, 'overfitting_guarantee': False}


def predict(model, matrix, anchor, *, scale, device='cpu', batch_size=4096):
    model.eval()
    out = []
    with torch.inference_mode():
        for start in range(0, len(matrix), batch_size):
            x = torch.as_tensor(matrix[start:start + batch_size], dtype=torch.float32, device=device)
            base = torch.as_tensor(anchor[start:start + batch_size], dtype=torch.float32, device=device)
            out.append(model(x, base, scale).cpu().numpy())
    return np.concatenate(out) if out else np.array([])
