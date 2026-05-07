"""Shared FT-Transformer architecture helpers.

Centralizes bundle metadata + model reconstruction so training, serving,
challenger inference, SHAP, and online-update stop drifting apart.
"""
from __future__ import annotations

import math
from typing import Any


DEFAULT_REGRESSION_ARCH = {
    "d_model": 128,
    "n_heads": 8,
    "n_layers": 3,
    "dropout": 0.12,
    "head_type": "regression",
}

DEFAULT_LEGACY_CLASSIFIER_ARCH = {
    "d_model": 64,
    "n_heads": 4,
    "n_layers": 2,
    "dropout": 0.1,
    "head_type": "classification",
}

_FT_RUNTIME_CACHE: dict[int, tuple[Any, str, dict[str, Any]]] = {}
_FT_RUNTIME_CACHE_ORDER: list[int] = []
_FT_RUNTIME_CACHE_STATS = {"hits": 0, "misses": 0}
_FT_RUNTIME_CACHE_MAX = 16


def clear_ft_runtime_cache() -> None:
    _FT_RUNTIME_CACHE.clear()
    _FT_RUNTIME_CACHE_ORDER.clear()
    for key in _FT_RUNTIME_CACHE_STATS:
        _FT_RUNTIME_CACHE_STATS[key] = 0


def get_ft_runtime_cache_stats() -> dict[str, int]:
    return {
        **_FT_RUNTIME_CACHE_STATS,
        "size": len(_FT_RUNTIME_CACHE),
    }


def rank_from_ft_regression_output(raw: float) -> float:
    """Map FT rank-regression utility to a bounded 0..1 rank.

    Pairwise-ranking heads output unbounded utilities centered around zero.
    A raw value of 0 means "neutral", not "worst rank", so use a monotonic
    sigmoid for every finite value.
    """
    value = float(raw)
    if not math.isfinite(value):
        return 0.5
    value = max(-50.0, min(50.0, value))
    return 1.0 / (1.0 + math.exp(-value))


def _merged_arch(bundle: dict[str, Any] | None, fallback: dict[str, Any]) -> dict[str, Any]:
    arch = dict(fallback)
    if isinstance(bundle, dict):
        arch.update(bundle.get("arch") or {})
        for key in ("d_model", "n_heads", "n_layers", "dropout", "head_type"):
            if key in bundle and bundle[key] is not None:
                arch[key] = bundle[key]
    return arch


def infer_bundle_model_type(bundle: dict[str, Any] | None) -> str:
    """Infer FT-T task type from bundle metadata with legacy fallback."""
    if not isinstance(bundle, dict):
        return "classification"

    model_type = str(bundle.get("model_type") or "").strip().lower()
    if model_type:
        return model_type

    arch = bundle.get("arch") or {}
    head_type = str(arch.get("head_type") or "").strip().lower()
    if head_type == "regression":
        return "regression"
    if head_type == "classification":
        return "classification"

    return "classification"


def build_ft_transformer(n_features: int, model_type: str, bundle: dict[str, Any] | None = None):
    """Build an FT-Transformer that matches the saved bundle contract."""
    import torch
    import torch.nn as nn

    if model_type == "regression":
        arch = _merged_arch(bundle, DEFAULT_REGRESSION_ARCH)

        class FTTransformerRegression(nn.Module):
            def __init__(self):
                super().__init__()
                d_model = int(arch["d_model"])
                n_heads = int(arch["n_heads"])
                n_layers = int(arch["n_layers"])
                dropout = float(arch["dropout"])
                self.feat_embed = nn.Linear(1, d_model, bias=True)
                self.cls_token = nn.Parameter(torch.zeros(1, 1, d_model))
                enc_layer = nn.TransformerEncoderLayer(
                    d_model=d_model,
                    nhead=n_heads,
                    dim_feedforward=int(d_model * 4 / 3),
                    dropout=dropout,
                    batch_first=True,
                )
                self.encoder = nn.TransformerEncoder(enc_layer, num_layers=n_layers)
                self.head = nn.Linear(d_model, 1)

            def forward(self, x):
                batch = x.shape[0]
                tokens = self.feat_embed(x.unsqueeze(-1))
                cls = self.cls_token.expand(batch, -1, -1)
                tokens = torch.cat([cls, tokens], dim=1)
                out = self.encoder(tokens)
                return self.head(out[:, 0, :]).squeeze(-1)

        return FTTransformerRegression(), arch

    arch = _merged_arch(bundle, DEFAULT_LEGACY_CLASSIFIER_ARCH)

    class FTTransformerClassifier(nn.Module):
        def __init__(self):
            super().__init__()
            d_model = int(arch["d_model"])
            n_heads = int(arch["n_heads"])
            n_layers = int(arch["n_layers"])
            dropout = float(arch["dropout"])
            self.feat_embed = nn.Linear(1, d_model, bias=True)
            self.cls_token = nn.Parameter(torch.zeros(1, 1, d_model))
            enc_layer = nn.TransformerEncoderLayer(
                d_model=d_model,
                nhead=n_heads,
                dim_feedforward=d_model * 4,
                dropout=dropout,
                batch_first=True,
            )
            self.encoder = nn.TransformerEncoder(enc_layer, num_layers=n_layers)
            self.head = nn.Linear(d_model, 2)

        def forward(self, x):
            batch = x.shape[0]
            tokens = self.feat_embed(x.unsqueeze(-1))
            cls = self.cls_token.expand(batch, -1, -1)
            tokens = torch.cat([cls, tokens], dim=1)
            out = self.encoder(tokens)
            return self.head(out[:, 0, :])

    return FTTransformerClassifier(), arch


def rebuild_ft_transformer_from_bundle(bundle: dict[str, Any]):
    """Rebuild FT-T model from a persisted bundle and load its weights."""
    if not isinstance(bundle, dict) or "state_dict" not in bundle:
        raise ValueError("invalid FT bundle: missing state_dict")

    cache_key = id(bundle)
    cached = _FT_RUNTIME_CACHE.get(cache_key)
    if cached is not None:
        _FT_RUNTIME_CACHE_STATS["hits"] += 1
        return cached

    n_features = int(bundle.get("n_features", 0) or 0)
    if n_features <= 0:
        raise ValueError("invalid FT bundle: missing n_features")

    model_type = infer_bundle_model_type(bundle)
    model, arch = build_ft_transformer(n_features, model_type, bundle=bundle)
    model.load_state_dict(bundle["state_dict"])
    model.eval()
    result = (model, model_type, arch)
    _FT_RUNTIME_CACHE_STATS["misses"] += 1
    _FT_RUNTIME_CACHE[cache_key] = result
    _FT_RUNTIME_CACHE_ORDER.append(cache_key)
    while len(_FT_RUNTIME_CACHE_ORDER) > _FT_RUNTIME_CACHE_MAX:
        stale_key = _FT_RUNTIME_CACHE_ORDER.pop(0)
        _FT_RUNTIME_CACHE.pop(stale_key, None)
    return result
