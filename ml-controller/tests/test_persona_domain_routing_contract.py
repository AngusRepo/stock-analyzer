from pathlib import Path


def test_daily_pipeline_persona_writer_uses_learning_domain_client() -> None:
    source = Path("ml-controller/graphs/daily_pipeline_v2.py").read_text(encoding="utf-8")
    assert "from services.d1_domain_client import D1DataDomain, client_for_domain" in source
    assert (
        "write_persona_opinions(client_for_domain(D1DataDomain.LEARNING), opinions)"
        in source
    )
    assert "write_persona_opinions(d1_client, opinions)" not in source
