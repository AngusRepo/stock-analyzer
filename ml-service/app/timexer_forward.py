"""Frozen historical TimeXer inference; inputs are hash-bound and windows causal."""
from __future__ import annotations
import hashlib
import io
import json
import numpy as np


def predict_forward(*, bucket, prep, sequence, rows, source, train_end):
    import torch
    from .timexer_contract import metadata_contract, canonical_checksum
    from .timexer_inference import feature_receipt
    from .timexer_runtime import load_checkpoint, predict_asof
    if not torch.cuda.is_available():
        raise ValueError("timexer_verified_cuda_runtime_required")
    metadata = json.loads(bucket.blob(source["metadata_path"]).download_as_bytes())
    config = metadata_contract(metadata)
    if (any(metadata.get(k) != source.get(k) for k in ("version", "artifact_path"))
            or canonical_checksum(metadata.get("checksum")) != canonical_checksum(source.get("checksum"))):
        raise ValueError("timexer_forward_identity_mismatch")
    if metadata.get("train_range", [None, None])[1] != train_end or metadata.get("training_label_known_max", "9999") > train_end:
        raise ValueError("timexer_forward_training_cutoff_mismatch")
    prefix = prep["source_gcs_prefix"]
    receipt = json.loads(bucket.blob(prefix+"/prep/immutable_receipt.json").download_as_bytes())
    receipt = feature_receipt(bucket, {"schema_version": "timexer-feature-source-v1",
        "signal_date": receipt["business_date"], "status": "ready", "training_dispatched": False,
        "source_gcs_prefix": prefix, "source_receipt_checksum": prep["source_receipt_checksum"]}, receipt["business_date"])
    torch.set_float32_matmul_precision("high")
    model, settings = load_checkpoint(bucket.blob(source["artifact_path"]).download_as_bytes(),
        expected_checksum=source["checksum"], expected_variant=config["variant"], device="cuda")
    histories = {s: (r["dates"], r["close"]) for s, r in sequence.items()}
    calendar = sorted({d for r in sequence.values() for d in r["dates"]})
    days, symbols = rows["dates"].astype(str), rows["symbols"].astype(str)
    scores = np.full(len(days), np.nan)
    seen = set()
    for path, digest in sorted(receipt["output_checksums"].items()):
        raw = bucket.blob(path).download_as_bytes()
        if hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError("timexer_forward_feature_checksum_mismatch")
        with np.load(io.BytesIO(raw), allow_pickle=True) as shard:
            sy, dt, matrix = shard["symbols"].astype(str), shard["dates"].astype(str), shard["X"].astype(np.float32)
        del raw
        features = {}
        for symbol in set(sy) & set(symbols):
            if symbol in seen:
                raise ValueError("timexer_forward_duplicate_feature_symbol")
            seen.add(symbol)
            mask = sy == symbol
            order = np.argsort(dt[mask], kind="stable")
            features[symbol] = (dt[mask][order], matrix[mask][order])
        for day in sorted(set(days)):
            indices = np.flatnonzero((days == day) & np.isin(symbols, list(features)))
            predictions = predict_asof(model, settings=settings, exogenous=config["variant"] == "exo137",
                histories=histories, feature_histories=features, calendar=calendar,
                symbols=sorted(set(symbols[indices]) & set(histories)), signal_date=day, device="cuda")
            values = {r["symbol"]: r["raw_score"] for r in predictions}
            for i in indices:
                value = values.get(symbols[i])
                if value is not None:
                    scores[i] = value
        del matrix, features
    return scores
