from services.no_lookahead_audit import CHECKS


def test_strategy_selection_and_outcome_lineage_are_in_fail_closed_audit() -> None:
    checks = {name: sql for name, sql, _ in CHECKS}

    assert "canonical_selection_label" in checks
    assert "outcome_known_date < exit_date" in checks["canonical_selection_label"]
    assert "date(created_at) < outcome_known_date" in checks["canonical_selection_label"]
    assert "strategy_matrix_lineage" in checks
    assert "strategy_matrix_status <> 'ready'" in checks["strategy_matrix_lineage"]
    assert "strategy_registry_checksum <>" in checks["strategy_matrix_lineage"]
