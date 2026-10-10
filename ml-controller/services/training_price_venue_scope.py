"""Evidence-bound ROTC-to-listed scope for prior price eligibility comparison."""
from __future__ import annotations

import hashlib
import html
import json
import re
from datetime import date
from pathlib import Path
from urllib.parse import urlparse


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _date(value):
    if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
        raise ValueError("price_venue_date_invalid")
    return value


def verify_scope(scope, manifest):
    if scope is None:
        return {}
    if (scope.get("schema") != "price-prior-venue-scope-v1"
            or scope.get("capture_id") != manifest.get("capture_id")
            or scope.get("end_date") != manifest.get("end_date")
            or scope.get("price_checksums") != manifest.get("checksums")):
        raise ValueError("price_venue_capture_binding_mismatch")
    entries = scope.get("entries")
    if not isinstance(entries, list) or not entries:
        raise ValueError("price_venue_entries_missing")
    result = {}
    for entry in entries:
        symbol = entry.get("symbol")
        if not isinstance(symbol, str) or not re.fullmatch(r"[0-9]{4,6}", symbol) or symbol in result:
            raise ValueError("price_venue_owner_duplicate_or_invalid")
        effective = _date(entry["listed_from"])
        if effective > scope["end_date"] or entry.get("market") not in ("TWSE", "OTC"):
            raise ValueError("price_venue_scope_invalid")
        evidence = entry["evidence"]
        raw = evidence["raw_utf8"].encode("utf8")
        url = urlparse(evidence["url"])
        if (url.scheme != "https" or url.hostname != "www.tpex.org.tw"
                or url.path != "/www/bulletin/annDetail"
                or hashlib.sha256(raw).hexdigest() != evidence["sha256"]):
            raise ValueError("price_venue_official_evidence_mismatch")
        doc = json.loads(raw)
        if doc.get("stat") != "ok":
            raise ValueError("price_venue_official_status_invalid")
        body = doc["data"]
        subject = html.unescape(re.sub("<[^>]*>", "", body["subject"]))
        content = html.unescape(re.sub("<[^>]*>", "", body["content"]))
        y, m, d = map(int, effective.split("-"))
        native_date = f"{y - 1911}年{m}月{d}日"
        if entry["market"] == "TWSE":
            valid = (f"股票代號：{symbol}" in subject
                     and f"公告自{native_date}起終止" in subject
                     and "興櫃" in subject
                     and re.search(r"因於臺灣證券交易所(?:創新板)?上市而申請終止興櫃", content)
                     and f"自{native_date}起終止" in content)
        else:
            valid = ("初次申請上櫃" in subject and "自同日起終止該興櫃" in subject
                     and f"上櫃股票開始買賣日期：{native_date}。" in content
                     and re.search(r"原興櫃股票代號及簡稱：.*?代號：" + re.escape(symbol) + r"。", content)
                     and f"今訂於{native_date}起開始以一般類股" in content
                     and "自同日起終止該興櫃股票" in content)
        if not valid:
            raise ValueError("price_venue_official_owner_or_transition_mismatch")
        result[symbol] = entry
    return result


def compare_prior_scope(entry, *, symbol, market, previous, rows):
    """Only remove pre-listing rows from the eligibility comparison, not the raw data."""
    start = entry["listed_from"]
    if entry["symbol"] != symbol or entry["market"] != market:
        raise ValueError("price_venue_requested_owner_mismatch")
    current_dates = [_date(str(row["date"])) for row in rows]
    prior_dates = [_date(str(row["date"])) for row in previous]
    if (not current_dates or min(current_dates) != start
            or len(set(current_dates)) != len(current_dates)
            or len(set(prior_dates)) != len(prior_dates)):
        raise ValueError("price_venue_bar_dates_invalid")
    comparable = [day for day in prior_dates if day >= start]
    if not set(comparable).issubset(current_dates):
        raise ValueError("price_venue_lost_post_listing_dates")
    return len(comparable), {"symbol": symbol, "listed_from": start, "market": market,
        "prior_rows": len(previous), "comparable_prior_rows": len(comparable),
        "pre_listing_rows_excluded_from_comparison": len(previous) - len(comparable),
        "new_rows": len(rows), "prior_dates_sha256": digest(prior_dates),
        "new_dates_sha256": digest(current_dates), "official_evidence_sha256": entry["evidence"]["sha256"],
        "policy": "listed-only prices retained; original minimum 60 rows unchanged; no old bars copied"}


def write_scope_manifest(run_dir, path, expected_sha):
    """Producer-only sealing step before uploading a newly materialized capture."""
    raw = Path(path).read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_sha:
        raise ValueError("price_venue_scope_checksum_mismatch")
    target = Path(run_dir) / "raw/daily_price_full_vintage/manifest.json"
    manifest = json.loads(target.read_bytes())
    if "prior_venue_scope" in manifest:
        raise ValueError("price_venue_scope_already_sealed")
    scope = json.loads(raw)
    verify_scope(scope, manifest)
    manifest["prior_venue_scope"] = scope
    manifest["prior_venue_scope_sha256"] = digest(scope)
    target.write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf8")
    return digest(scope)


def scope_from_manifest(manifest):
    scope = manifest.get("prior_venue_scope")
    expected = manifest.get("prior_venue_scope_sha256")
    if scope is None and expected is None:
        return {}, None
    if scope is None or digest(scope) != expected:
        raise ValueError("price_venue_scope_manifest_mismatch")
    return verify_scope(scope, manifest), expected
