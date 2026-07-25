from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_oof_materialized_policy_migration_preserves_superseded_artifacts():
    sql = (
        ROOT
        / "worker"
        / "migrations"
        / "0083_oof_materialized_artifact_policy_lineage.sql"
    ).read_text()

    assert "eligibility_policy_version" in sql
    assert "date_set_checksum" in sql
    assert "active8_oof_materialized_artifact_history" in sql
    assert "replaced_by_checksum" in sql
    assert "replacement_reason" in sql
    assert "PRIMARY KEY (cohort_id, artifact_kind, artifact_checksum)" in sql


def test_oof_policy_tables_exist_in_main_and_learning_domain_schemas():
    for relative in ("worker/schema.sql", "worker/domain-schemas/learning.sql"):
        sql = (ROOT / relative).read_text(encoding="utf-8")
        assert "eligibility_policy_version TEXT NOT NULL" in sql
        assert "CREATE TABLE IF NOT EXISTS active8_oof_materialized_artifact_history" in sql
        assert "CREATE TABLE IF NOT EXISTS active8_oof_date_eligibility" in sql
        assert "CREATE TABLE IF NOT EXISTS active8_oof_retention_ledger" in sql