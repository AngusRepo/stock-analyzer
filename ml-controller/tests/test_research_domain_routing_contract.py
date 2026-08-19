from pathlib import Path


def test_strategy_mining_uses_research_domain_client() -> None:
    source = Path("ml-controller/strategy_mining_job_main.py").read_text(encoding="utf-8")
    assert "class _ResearchD1ClientProxy:" in source
    assert source.count("client_for_domain(D1DataDomain.RESEARCH)") >= 3
    assert "d1_client = _ResearchD1ClientProxy()" in source
    assert "from services import d1_client" not in source


def test_weekly_audit_routes_each_table_owner_explicitly() -> None:
    source = Path("ml-controller/graphs/weekly_audit_graph.py").read_text(encoding="utf-8")
    assert "domain=D1DataDomain.PAPER" in source
    assert source.count("domain=D1DataDomain.RESEARCH") >= 2
    assert "domain=audit_domain" in source
    assert "domain=D1DataDomain.OPS" in source
    assert "client_for_domain(domain).query" in source
    assert "client_for_domain(domain).execute" in source
