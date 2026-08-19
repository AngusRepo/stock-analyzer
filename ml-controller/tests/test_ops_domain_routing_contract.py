from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def test_retrain_webhook_log_uses_ops_domain_client() -> None:
    trigger = read("ml-controller/routers/retrain_trigger.py")
    followup = read("ml-controller/routers/retrain_followup.py")
    assert "OPS_D1_CLIENT = client_proxy_for_domain(D1DataDomain.OPS)" in trigger
    assert "OPS_D1_CLIENT.execute(\n        sql," in trigger
    assert "OPS_D1_CLIENT = client_proxy_for_domain(D1DataDomain.OPS)" in followup
    assert "OPS_D1_CLIENT.execute(" in followup
    assert "OPS_D1_CLIENT.query(" in followup


def test_walk_forward_splits_webhook_log_from_learning_reads() -> None:
    source = read("ml-controller/routers/walk_forward.py")
    assert "OPS_D1_CLIENT = client_proxy_for_domain(D1DataDomain.OPS)" in source
    assert "webhook = OPS_D1_CLIENT.query(" in source
    assert "OPS_D1_CLIENT.execute(\n                \"\"\"\n                UPDATE webhook_log" in source

def test_obsidian_writer_routes_core_paper_and_ops_reads() -> None:
    source = read("ml-controller/services/obsidian_writer.py")
    assert "domain: D1DataDomain" in source
    assert "client_for_domain(domain).query" in source
    assert "domain=D1DataDomain.CORE" in source
    assert source.count("domain=D1DataDomain.PAPER") >= 6
    assert "domain=D1DataDomain.OPS" in source
