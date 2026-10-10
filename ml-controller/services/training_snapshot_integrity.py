"""Seal every auxiliary training component before it reaches feature prep."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import polars as pl

REQUIRED_COMPONENTS = frozenset({"prices", "indicators", "chips", "broker_flows", "sentiment", "monthly_revenue", "canonical_fundamentals", "margin_data", "shareholding", "us_market_signals"})
NONEMPTY_COMPONENTS = frozenset({"prices", "monthly_revenue", "canonical_fundamentals", "margin_data", "shareholding", "us_market_signals"})

def verify_snapshot_manifest(snapshot: dict, *, business_date: str) -> dict:
    metadata=json.loads(snapshot.get("metadata_json") or "{}")
    components=metadata.get("component_meta") or {}
    missing=REQUIRED_COMPONENTS-set(components)
    if missing:
        raise ValueError("training_snapshot_components_missing:"+",".join(sorted(missing)))
    payload={"kind":snapshot.get("kind"), "business_date":snapshot.get("business_date"),
        "start_date":metadata.get("start_date"), "end_date":metadata.get("end_date"),
        "row_count":snapshot.get("row_count"), "component_meta":components}
    digest="sha256:"+hashlib.sha256(json.dumps(payload,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    if snapshot.get("checksum")!=digest or snapshot.get("business_date")!=business_date or metadata.get("end_date")!=business_date:
        raise ValueError("training_snapshot_manifest_checksum_or_date_mismatch")
    if sum(int(x.get("row_count",-1)) for x in components.values())!=snapshot.get("row_count"):
        raise ValueError("training_snapshot_total_rows_mismatch")
    for name,meta in components.items():
        if (meta.get("name")!=name or not str(meta.get("gcs_uri","")).startswith(str(snapshot.get("gcs_uri","")).rstrip("/")+"/")
                or metadata.get("components",{}).get(name)!=meta.get("gcs_uri")
                or len(str(meta.get("content_checksum", "")))!=71 or int(meta.get("row_count",-1))<0):
            raise ValueError("training_snapshot_component_metadata_invalid:"+name)
        if name in NONEMPTY_COMPONENTS and not meta["row_count"]:
            raise ValueError("training_snapshot_required_component_empty:"+name)
    return components

def verify_component_file(path: Path, meta: dict) -> pl.DataFrame:
    digest=hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b""):
            digest.update(chunk)
    if "sha256:"+digest.hexdigest()!=meta.get("content_checksum") or path.stat().st_size!=meta.get("bytes"):
        raise ValueError("training_snapshot_component_checksum_mismatch:"+str(meta.get("name")))
    frame=pl.read_parquet(path)
    if frame.height!=meta.get("row_count") or frame.columns!=meta.get("columns"):
        raise ValueError("training_snapshot_component_shape_mismatch:"+str(meta.get("name")))
    return frame
