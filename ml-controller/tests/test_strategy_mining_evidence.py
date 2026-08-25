from __future__ import annotations

import hashlib
import json
from datetime import date, timedelta

from services.strategy_mining_evidence import build_strategy_mining_evidence


def _purge_attestation(dates: list[str], *, n_partitions: int = 8, embargo: int = 1) -> dict:
    chunk_size = len(dates) // n_partitions
    assert chunk_size * n_partitions == len(dates)
    partitions = []
    for partition_id in range(n_partitions):
        start = partition_id * chunk_size
        end = start + chunk_size
        chunk = dates[start:end]
        partitions.append({
            "partition_id": partition_id,
            "raw_start": chunk[0],
            "raw_end": chunk[-1],
            "test_start": chunk[embargo],
            "test_end": chunk[-1],
            "purged_sessions": embargo,
        })
    payload = {
        "schema_version": "strategy-mining-purge-attestation-v1",
        "method": "ordered_partition_front_embargo",
        "embargo_sessions": embargo,
        "partition_count": n_partitions,
        "holdout_dates": dates,
        "partitions": partitions,
    }
    payload["payload_checksum"] = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return payload


def _row(candidate_id: str, partitions: list[float], daily: list[float]):
    dates = [(date(2026, 1, 1) + timedelta(days=index)).isoformat() for index in range(len(daily))]
    return {
        "candidate_id": candidate_id,
        "status": "ok",
        "holdout_partition_returns": partitions,
        "holdout_daily_returns": daily,
        "holdout_regimes": ["bull"] * len(daily),
        "holdout_dates": dates,
        "pbo_purge_attestation": _purge_attestation(dates),
    }


def test_strategy_evidence_is_pending_when_common_matrix_is_missing():
    out = build_strategy_mining_evidence(
        [_row("only", [0.01] * 8, [0.001] * 40)],
        n_partitions=8,
        n_simulations=10,
    )
    assert out["status"] == "pending"
    assert out["pbo"]["status"] == "pending"


def test_strategy_evidence_computes_all_required_evidence():
    rows = [
        _row("steady", [0.02] * 8, [0.001] * 40),
        _row("weak", [-0.01] * 8, [-0.0005] * 40),
        _row("mixed", [0.01, 0.02, 0.01, 0.02, 0.01, 0.02, 0.01, 0.02], [0.0007] * 40),
    ]
    out = build_strategy_mining_evidence(rows, n_partitions=8, n_simulations=20)
    assert out["pbo"]["method"] == "cscv_rank_logit"
    assert out["walk_forward"]["method"] == "attested_front_embargo_expanding_selection_v3"
    assert out["walk_forward"]["purge_attestation"]["payload_checksum"]
    assert out["multiple_testing"]["method"] == "holm_bonferroni"
    assert out["multiple_testing"]["family_size"] == 3
    assert out["candidate_evidence"]["steady"]["monte_carlo"]["method"] == "regime_block_bootstrap"
    assert out["candidate_evidence"]["steady"]["multiple_testing"]["passed"] is True
    assert out["candidate_evidence"]["steady"]["status"] == "pass"


def test_strategy_evidence_rejects_misaligned_regimes_without_bypass():
    row = _row("bad", [0.01] * 8, [0.001] * 40)
    row["holdout_regimes"] = ["bull"]
    out = build_strategy_mining_evidence(
        [row, _row("good", [0.02] * 8, [0.001] * 40)],
        n_partitions=8,
        n_simulations=10,
    )
    assert out["status"] == "pending"
    assert out["common_candidate_matrix"]["rejected"]["bad"] == "holdout_regime_alignment_unmet"


def test_strategy_evidence_rejects_missing_or_tampered_purge_lineage():
    missing = _row("missing", [0.01] * 8, [0.001] * 40)
    missing.pop("pbo_purge_attestation")
    tampered = _row("tampered", [0.02] * 8, [0.001] * 40)
    tampered["pbo_purge_attestation"]["embargo_sessions"] = 0
    out = build_strategy_mining_evidence(
        [missing, tampered, _row("good", [0.03] * 8, [0.001] * 40)],
        n_partitions=8,
        n_simulations=10,
    )
    assert out["status"] == "pending"
    rejected = out["common_candidate_matrix"]["rejected"]
    assert rejected["missing"] == "purge_attestation_missing_or_invalid"
    assert rejected["tampered"] == "purge_attestation_missing_or_invalid"


def test_strategy_evidence_fails_null_candidate_after_family_wise_adjustment():
    oscillating = [0.002 if index % 2 == 0 else -0.002 for index in range(40)]
    rows = [
        _row("strong", [0.02] * 8, [0.001] * 40),
        _row("null", [0.001, -0.001] * 4, oscillating),
    ]
    out = build_strategy_mining_evidence(rows, n_partitions=8, n_simulations=20)
    null_test = out["candidate_evidence"]["null"]["multiple_testing"]
    assert null_test["adjustment_method"] == "holm_bonferroni"
    assert null_test["family_size"] == 2
    assert null_test["passed"] is False
    assert "holdout_hac_holm_bonferroni" in out["candidate_evidence"]["null"]["failed_gates"]
