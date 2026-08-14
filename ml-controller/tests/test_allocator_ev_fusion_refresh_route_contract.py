import ast
from pathlib import Path


SOURCE = (Path(__file__).resolve().parents[1] / "routers/allocator_ev_fusion.py").read_text(encoding="utf-8")


def test_allocator_ev_fusion_refresh_rejects_direct_promotion_to_active8_owner() -> None:
    assert "promote: bool = False" in SOURCE
    assert "if req.promote:" in SOURCE
    assert "status_code=409" in SOURCE
    assert 'DIRECT_REFRESH_PROMOTION_OWNER = "active8_oof_lifecycle"' in SOURCE
    assert 'DIRECT_REFRESH_PROMOTION_ENDPOINT = "/walk_forward/oof/lifecycle"' in SOURCE
    assert SOURCE.index("if req.promote:") < SOURCE.index("defaults = _defaults_for_cadence")
    assert "_promotion_config_allowed" not in SOURCE


def test_allocator_ev_fusion_refresh_persists_registry_without_direct_config_promotion() -> None:
    tree = ast.parse(SOURCE)
    refresh = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "refresh_allocator_ev_fusion_artifact"
    )
    calls = [
        node.func.id
        for node in ast.walk(refresh)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    ]
    assert "upsert_artifact_record" in calls
    assert "worker_fetch" not in calls
    assert '"/api/admin/config"' not in SOURCE


def test_allocator_ev_fusion_dry_run_does_not_write_registry() -> None:
    assert "if isinstance(artifact, dict) and not req.dry_run:" in SOURCE


def test_allocator_ev_fusion_refresh_never_allows_production_mutation() -> None:
    assert '"production_mutation_allowed": False' in SOURCE
    assert '"production_mutation_allowed": bool(' not in SOURCE
    assert "worker_fetch" not in SOURCE


def test_allocator_ev_fusion_failed_challenger_preserves_existing_champion() -> None:
    assert "existing_champion_preserved" in SOURCE
    assert "allocator_ev_fusion_refresh_failed_validation_clear_stale" not in SOURCE


def test_allocator_ev_fusion_registry_maps_promotion_to_lifecycle_states() -> None:
    tree = ast.parse(SOURCE)
    function = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "_registry_lifecycle_state"
    )
    constants = {
        node.value for node in ast.walk(function)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    }
    assert {"offline_passed", "offline_failed"} <= constants
    assert {"production", "approval_required"}.isdisjoint(constants)


def test_mature_snapshot_query_uses_canonical_writer_contract() -> None:
    assert "SNAPSHOT_BACKFILL_SOURCE" in SOURCE
    assert "trained_until_strictly_before_snapshot_date'" not in SOURCE

    assert "SNAPSHOT_BACKFILL_AS_OF_GUARD" in SOURCE


def test_fusion_registry_envelope_uses_formal_direct_identity_v1() -> None:
    assert '"identity_schema_version": "expected-return-candidate-identity-v1"' in SOURCE
    assert '"identity_schema_version": "expected-return-candidate-identity-v2"' not in SOURCE
    assert '"expected_return_owner": artifact.get("expected_return_owner")' in SOURCE
    assert '"model_version": model_version' in SOURCE
    assert '"artifact_checksum": artifact_checksum' not in SOURCE
    assert '"cadence": cadence' in SOURCE
    assert '"checksum": artifact_checksum' in SOURCE
    assert '"production_mutation_allowed": False' in SOURCE


def test_purged_oof_refresh_is_explicit_and_fail_closed() -> None:
    assert 'evidence_mode: Literal["native", "purged_oof"]' in SOURCE
    assert "purged_oof_requires_knowledge_cutoff_end_date" in SOURCE
    assert "_latest_ready_oof_cohort" in SOURCE
    assert "allocator_ev_fusion_ready_oof_cohort_missing" in SOURCE
    assert "load_allocator_ev_fusion_oof_training_rows" in SOURCE
    assert "allocator_ev_fusion_{req.evidence_mode}_training_rows_empty" in SOURCE
