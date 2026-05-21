from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_weekly_obsidian_sync_reads_current_weekly_audit_schema() -> None:
    source = read("ml-controller/services/obsidian_writer.py")

    assert "ORDER BY report_date DESC LIMIT 1" in source
    assert 'audit.get("l1_json")' in source
    assert 'audit.get("l2_json")' in source
    assert 'audit.get("l3_json")' in source
    assert "weekly_audit_reports ORDER BY date DESC LIMIT 1" not in source
    assert "l1_performance" not in source
    assert "l2_decisions" not in source
    assert "l3_model_health" not in source


def test_trade_template_renders_score_v2_five_dimension_attribution() -> None:
    source = read("ml-controller/services/obsidian_writer.py")
    template = read("ml-controller/templates/trade.md.j2")

    assert "def score_v2_component_pct" in source
    assert "score_v2_component_pct=score_v2_component_pct" in source

    assert "score_v2_component_pct(decision, 'mlEdge')" in template
    assert "score_v2_component_pct(decision, 'chipFlow')" in template
    assert "score_v2_component_pct(decision, 'technicalStructure')" in template
    assert "score_v2_component_pct(decision, 'fundamentalQuality')" in template
    assert "score_v2_component_pct(decision, 'newsTheme')" in template
    assert "decision.chip_pct" not in template
    assert "decision.tech_pct" not in template
    assert "decision.ml_pct" not in template
