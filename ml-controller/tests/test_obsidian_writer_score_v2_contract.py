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
    assert "storage_projection" not in source
    assert "_rescale_score" not in source
    assert 'return "score_v2" if score_v2_payload(row) else "missing_score_v2"' in source

    assert "score_v2_component_pct(decision, 'mlEdge')" in template
    assert "score_v2_component_pct(decision, 'chipFlow')" in template
    assert "score_v2_component_pct(decision, 'technicalStructure')" in template
    assert "score_v2_component_pct(decision, 'fundamentalQuality')" in template
    assert "score_v2_component_pct(decision, 'newsTheme')" in template
    assert "decision.chip_pct" not in template
    assert "decision.tech_pct" not in template
    assert "decision.ml_pct" not in template


def test_daily_recommendation_note_context_reads_canonical_score_v2_only() -> None:
    source = read("ml-controller/services/obsidian_writer.py")
    start = source.index("recommendations = await _d1_query")
    end = source.index("snapshot = (await _d1_query", start)
    block = source[start:end]

    assert "SELECT date, symbol, name, sector, signal, confidence, reason, score_components " in block
    assert "json_extract(score_components, '$.finalScore')" in block
    assert "ORDER BY score DESC" not in block
    assert "SELECT * FROM daily_recommendations" not in block
    for legacy_column in ("chip_score", "tech_score", "ml_score", "momentum_score"):
        assert legacy_column not in block


def test_obsidian_score_v2_rounding_matches_worker_math_round_semantics() -> None:
    source = read("ml-controller/services/obsidian_writer.py")

    assert "math.floor(float(value) * 10 + 0.5) / 10" in source
    assert "round(float(value) * 10) / 10" not in source


def test_trade_note_decision_context_reads_canonical_score_v2_only() -> None:
    source = read("ml-controller/services/obsidian_writer.py")
    start = source.index("decisions = await _d1_query")
    end = source.index("# T2 pending buys", start)
    block = source[start:end]

    assert "SELECT date, symbol, action, score_components, debate_verdict, " in block
    assert "ml_confidence AS conviction, market_risk, sector, entry_price " in block
    assert "json_extract(score_components, '$.finalScore')" in block
    assert "SELECT * FROM decision_logs" not in block
    for legacy_column in (
        "chip_score",
        "tech_score",
        "ml_score",
        "chip_pct",
        "tech_pct",
        "ml_pct",
        "momentum_score",
        "total_score",
    ):
        assert legacy_column not in block
