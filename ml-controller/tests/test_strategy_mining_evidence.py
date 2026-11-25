from __future__ import annotations

import hashlib
import json
from datetime import date, timedelta

from services.strategy_mining_evidence import build_strategy_mining_evidence


def _attestation(dates: list[str], *, sample: str, n_partitions: int = 8, embargo: int = 1) -> dict:
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
        f"{sample}_dates": dates,
        "partitions": partitions,
    }
    if sample != "holdout":
        payload["sample"] = sample
    payload["payload_checksum"] = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return payload


SELECTION_DATES = [(date(2024, 1, 1) + timedelta(days=index)).isoformat() for index in range(80)]
SELECTION = _attestation(SELECTION_DATES, sample="selection")


def _row(candidate_id: str, partitions: list[float], daily: list[float], *, finalist: bool = True,
         finlab: str = "pass"):
    row = {
        "candidate_id": candidate_id,
        "status": "ok",
        "selection_partition_returns": partitions,
        "selection_attestation_checksum": SELECTION["payload_checksum"],
    }
    if finalist:
        dates = [(date(2026, 1, 1) + timedelta(days=index)).isoformat() for index in range(len(daily))]
        row.update({
            "holdout_status": "evaluated",
            "holdout_partition_returns": partitions,
            "holdout_daily_returns": daily,
            "holdout_regimes": ["bull"] * len(daily),
            "holdout_dates": dates,
            "pbo_purge_attestation": _attestation(dates, sample="holdout"),
            "finlab_confirm_gate": {"status": finlab, "reasons": []},
            "holdout_excess": {"one_sided_regimes": []},
        })
    return row


def _build(rows, **kwargs):
    kwargs.setdefault("selection_attestation", SELECTION)
    kwargs.setdefault("n_simulations", 20)
    return build_strategy_mining_evidence(rows, n_partitions=8, **kwargs)


def test_strategy_evidence_is_pending_when_common_matrix_is_missing():
    out = _build([_row("only", [0.01] * 8, [0.001] * 40)], n_simulations=10)
    assert out["status"] == "pending"
    assert out["pbo"]["status"] == "pending"


def test_strategy_evidence_computes_all_required_evidence():
    rows = [
        _row("steady", [0.02] * 8, [0.001] * 40),
        _row("weak", [-0.01] * 8, [-0.0005] * 40),
        _row("mixed", [0.01, 0.02, 0.01, 0.02, 0.01, 0.02, 0.01, 0.02], [0.0007] * 40),
    ]
    out = _build(rows)
    assert out["pbo"]["method"] == "cscv_rank_logit"
    assert out["pbo"]["sample"] == "selection"
    assert out["walk_forward"]["method"] == "attested_front_embargo_expanding_selection_v3"
    assert out["walk_forward"]["purge_attestation"]["payload_checksum"] == SELECTION["payload_checksum"]
    assert out["multiple_testing"]["method"] == "holm_bonferroni"
    assert out["multiple_testing"]["family_size"] == 3
    assert out["candidate_evidence"]["steady"]["monte_carlo"]["method"] == "regime_block_bootstrap"
    assert out["candidate_evidence"]["steady"]["multiple_testing"]["passed"] is True
    assert out["candidate_evidence"]["steady"]["status"] == "pass"


def test_strategy_evidence_rejects_misaligned_regimes_without_bypass():
    row = _row("bad", [0.01] * 8, [0.001] * 40)
    row["holdout_regimes"] = ["bull"]
    out = _build([row, _row("good", [0.02] * 8, [0.001] * 40)], n_simulations=10)
    assert out["common_candidate_matrix"]["rejected"]["bad"] == "holdout_regime_alignment_unmet"
    assert "bad" not in out["candidate_evidence"]


def test_strategy_evidence_rejects_missing_or_tampered_purge_lineage():
    missing = _row("missing", [0.01] * 8, [0.001] * 40)
    missing.pop("pbo_purge_attestation")
    tampered = _row("tampered", [0.02] * 8, [0.001] * 40)
    tampered["pbo_purge_attestation"]["embargo_sessions"] = 0
    out = _build([missing, tampered, _row("good", [0.03] * 8, [0.001] * 40)], n_simulations=10)
    rejected = out["common_candidate_matrix"]["rejected"]
    assert rejected["missing"] == "purge_attestation_missing_or_invalid"
    assert rejected["tampered"] == "purge_attestation_missing_or_invalid"
    assert set(out["candidate_evidence"]) == {"good"}


def test_strategy_evidence_rejects_missing_or_foreign_selection_attestation():
    rows = [_row("a", [0.02] * 8, [0.001] * 40), _row("b", [0.01] * 8, [0.001] * 40)]
    out = _build(rows, selection_attestation=None)
    assert out["status"] == "pending"
    assert out["common_candidate_matrix"]["rejected"]["a"] == "selection_attestation_missing_or_invalid"
    rows[1]["selection_attestation_checksum"] = "0" * 64
    out = _build(rows)
    assert out["common_candidate_matrix"]["rejected"]["b"] == "selection_attestation_mismatch"


def test_strategy_evidence_fails_null_candidate_after_family_wise_adjustment():
    oscillating = [0.002 if index % 2 == 0 else -0.002 for index in range(40)]
    rows = [
        _row("strong", [0.02] * 8, [0.001] * 40),
        _row("null", [0.001, -0.001] * 4, oscillating),
    ]
    out = _build(rows)
    null_test = out["candidate_evidence"]["null"]["multiple_testing"]
    assert null_test["adjustment_method"] == "holm_bonferroni"
    assert null_test["family_size"] == 2
    assert null_test["passed"] is False
    assert "holdout_hac_holm_bonferroni" in out["candidate_evidence"]["null"]["failed_gates"]


def test_holm_family_includes_prior_runs_on_the_same_holdout():
    rows = [_row("a", [0.02] * 8, [0.001] * 40), _row("b", [0.01] * 8, [0.0008] * 40)]
    alone = _build(rows)
    pooled = _build(rows, prior_holdout_family_size=10)
    assert pooled["multiple_testing"]["family_size"] == 12
    assert pooled["multiple_testing"]["prior_runs_family_size"] == 10
    for cid in ("a", "b"):
        assert (
            pooled["multiple_testing"]["adjusted_p_values"][cid]
            >= alone["multiple_testing"]["adjusted_p_values"][cid]
        )


def test_finlab_confirm_and_blocking_gates_are_gate_inputs():
    rows = [
        _row("steady", [0.02] * 8, [0.001] * 40, finlab="failed"),
        _row("other", [0.01] * 8, [0.001] * 40),
    ]
    out = _build(rows)
    assert "finlab_confirm" in out["candidate_evidence"]["steady"]["failed_gates"]
    blocked = _build(rows, blocking_gates=["feature_triage_window_overlaps_evaluation"])
    assert blocked["status"] == "failed"
    for item in blocked["candidate_evidence"].values():
        assert "feature_triage_window_overlaps_evaluation" in item["failed_gates"]


def test_non_finalists_count_in_pbo_but_get_no_holdout_evidence():
    rows = [
        _row("finalist", [0.02] * 8, [0.001] * 40),
        _row("searched_a", [0.01] * 8, [], finalist=False),
        _row("searched_b", [-0.01] * 8, [], finalist=False),
    ]
    out = _build(rows)
    assert out["common_candidate_matrix"]["candidate_count"] == 3
    assert set(out["candidate_evidence"]) == {"finalist"}
    assert out["multiple_testing"]["family_size"] == 1


def test_finalist_without_attested_selection_lineage_gets_no_holdout_evidence():
    rows = [_row("a", [0.02] * 8, [0.001] * 40), _row("b", [0.01] * 8, [0.001] * 40),
            _row("c", [0.015] * 8, [0.001] * 40)]
    rows[0]["selection_attestation_checksum"] = "0" * 64
    out = _build(rows)
    assert "a" not in out["candidate_evidence"]
    # Its holdout look still counts in the Holm family.
    assert out["multiple_testing"]["family_size"] == 3
