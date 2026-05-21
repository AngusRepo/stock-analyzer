from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_weekly_audit_uses_score_v2_decision_attribution() -> None:
    source = read("ml-controller/graphs/weekly_audit_graph.py")

    assert "score_components" in source
    assert "Score V2 payload coverage" in source
    assert "avg_ml_edge_contribution" in source
    assert "avg_chip_flow_contribution" in source
    assert "avg_technical_structure_contribution" in source
    assert "avg_fundamental_quality_contribution" in source
    assert "avg_news_theme_contribution" in source
    assert "ML Edge" in source
    assert "Chip Flow" in source
    assert "Technical Structure" in source
    assert "Fundamental Quality" in source
    assert "News/Theme" in source
    assert "avg_chip_contribution" not in source
    assert "avg_tech_contribution" not in source
    assert "avg_ml_contribution" not in source
    assert "Avg contribution: Chip" not in source
    assert "Dominant factor:" not in source


def test_decision_logs_persist_score_v2_payload_for_audit() -> None:
    migration = read("worker/migration_decision_logs_score_v2.sql")
    paper_entry_tasks = read("worker/src/lib/paperEntryTasks.ts")

    assert "ALTER TABLE decision_logs ADD COLUMN score_components TEXT" in migration
    assert "date, symbol, action, score_components, chip_score" in paper_entry_tasks
    assert "decisionScoreComponents" in paper_entry_tasks
    assert "finalScore: scoreV2.finalScore" in paper_entry_tasks
    assert "alphaAdjustment: scoreV2.alphaAdjustment" in paper_entry_tasks


def test_weekly_review_template_renders_score_v2_average_attribution() -> None:
    template = read("ml-controller/templates/weekly_review.md.j2")

    assert "| Factor | Avg Contribution |" in template
    assert "f.avg_pct" in template
    assert "Win Contribution" not in template
    assert "Loss Contribution" not in template
