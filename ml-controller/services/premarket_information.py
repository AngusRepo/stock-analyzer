"""Pure batch preparation of *available* overnight information; never alters model scores.

Versioned payloads can be consumed by a separately validated L4 recipe. This module
does not fetch data, call LLMs, refit models, or mutate the immutable L3 snapshot.
"""
from datetime import datetime, timezone, timedelta
from copy import deepcopy
from math import isfinite
from hashlib import sha256
import json


def _ts(value):
    instant = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if instant.tzinfo is None:
        raise ValueError("premarket_timezone_required")
    return instant.astimezone(timezone.utc)


def _digest(value):
    return sha256(json.dumps(value,sort_keys=True,separators=(",",":"),allow_nan=False).encode()).hexdigest()


def _index(records, cutoff):
    indexed = {}
    for record in records:
        key = record.get("source_key")
        if not isinstance(key,str) or not key or not record.get("version") or not isinstance(record.get("payload"),dict):
            raise ValueError("premarket_source_contract_invalid")
        observed, available = _ts(record["observed_at"]), _ts(record["available_at"])
        if observed > available or available > cutoff:
            raise ValueError("premarket_future_information:"+key)
        item = {"source_key":key,"version":record["version"],"session":record.get("session"),
                "observed_at":observed.isoformat(),"available_at":available.isoformat(),"payload":deepcopy(record["payload"])}
        _digest(item)  # rejects non-JSON/NaN evidence, including nested values
        if key in indexed and indexed[key] != item:
            raise ValueError("premarket_conflicting_source:"+key)
        indexed[key] = item
    return indexed


def build_information_delta(*, baseline, current_records, cutoff, trade_date, required_sources=(), max_age_seconds=None):
    """One global source comparison; stock/sector joins happen downstream in batches.

    source_key identifies the economic source/event, not a per-stock duplicate.
    For prices include the original market session in each receipt. payload deltas
    are NOT blindly subtracted; the trained consumer controls feature semantics.
    """
    now, prior_time = _ts(cutoff), _ts(baseline["available_at"])
    if now.astimezone(timezone(timedelta(hours=8))).date().isoformat() != trade_date:
        raise ValueError("premarket_cutoff_trade_date_mismatch")
    if prior_time > now or not baseline.get("l3_snapshot_id") or baseline.get("signal_date",trade_date) >= trade_date:
        raise ValueError("premarket_baseline_identity_invalid")
    prior = _index(baseline["sources"],prior_time)
    current = _index(current_records,now)
    required = set(required_sources)
    absent = sorted(required-set(current))
    if absent:
        raise ValueError("premarket_required_sources_missing:"+",".join(absent))
    changed, unchanged, missing = [], [], sorted(set(prior)-set(current))
    ages = {}
    for key,item in sorted(current.items()):
        ages[key] = (now-_ts(item["observed_at"])).total_seconds()
        limit=(max_age_seconds or {}).get(key)
        if limit is not None and (not isinstance(limit,(int,float)) or not isfinite(limit) or limit<0 or ages[key]>limit):
            raise ValueError("premarket_source_stale:"+key)
        previous=prior.get(key)
        if previous and _ts(item["observed_at"]) < _ts(previous["observed_at"]):
            raise ValueError("premarket_source_regressed:"+key)
        # Receipt refresh alone is not new economic information.
        signature=lambda row:_digest({k:row[k] for k in ("version","session","payload")})
        if previous and signature(previous)==signature(item):
            unchanged.append(key)
        else:
            changed.append({"source_key":key,"kind":"updated" if previous else "new",
                            "baseline":previous,"current":item})
    body={"schema_version":"premarket-information-delta-v1","trade_date":trade_date,
          "signal_date":baseline["signal_date"],"l3_snapshot_id":baseline["l3_snapshot_id"],
          "baseline_checksum":_digest(baseline),"cutoff":now.isoformat(),
          "changes":changed,"unchanged":unchanged,"missing":missing,"source_age_seconds":ages,
          "scores_modified":False,"training_dispatched":False}
    return {**body,"checksum":_digest(body)}
