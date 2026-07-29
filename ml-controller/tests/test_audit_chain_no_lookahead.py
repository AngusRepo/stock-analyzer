from __future__ import annotations

from scripts.audit_chain_no_lookahead import CHECKS, run_audit


def test_chain_no_lookahead_audit_passes_only_when_every_check_is_zero():
    seen = []

    def query(sql, params=None, timeout=60.0):
        seen.append((sql, params, timeout))
        return [{"violations": 0}]

    result = run_audit(query)

    assert result["decision"] == "PASS"
    assert len(result["checks"]) == len(CHECKS)
    assert {row["name"] for row in result["checks"]} >= {
        "active8_oof", "l4_oof", "allocator_oof", "fundamental_pit", "s12_outcome_known",
        "canonical_selection_label"
    }
    assert all(timeout == 120.0 for _, _, timeout in seen)


def test_chain_no_lookahead_audit_fails_closed_on_any_violation():
    def query(sql, params=None, timeout=60.0):
        return [{"violations": 1 if "l4_oof_predictions" in sql else 0}]

    result = run_audit(query)

    assert result["decision"] == "FAIL"
    assert result["failed_checks"] == ["l4_oof"]