from pathlib import Path


def test_ev_refresh_candidate_types_are_registered_by_d1_migration():
    repo = Path(__file__).resolve().parents[2]
    sql = (repo / "worker" / "migration_model_artifact_registry_candidate_type_ev_refresh_2026_07_11.sql").read_text(
        encoding="utf-8"
    )

    assert "'l4_alpha_ev_refresh'" in sql
    assert "'allocator_ev_fusion_refresh'" in sql
    assert "FROM model_artifact_registry" in sql
    assert "ALTER TABLE model_artifact_registry_new RENAME TO model_artifact_registry" in sql


def test_s12_replay_market_backfill_uses_canonical_stock_master():
    repo = Path(__file__).resolve().parents[2]
    sql = (repo / "worker" / "migration_s12_replay_market_backfill_2026_07_11.sql").read_text(
        encoding="utf-8"
    )

    assert "UPDATE s12_replay_trade_outcomes" in sql
    assert "FROM stocks" in sql
    assert "stocks.symbol = s12_replay_trade_outcomes.symbol" in sql
    assert "stocks.market IN ('TWSE', 'OTC', 'US')" in sql
