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

def test_finlab_ops_metadata_uses_domain_proxy() -> None:
    router = read("ml-controller/routers/finlab.py")
    tool = read("tools/finlab_v4_remote_backfill.py")
    assert "domain: str = 'legacy'" in router
    assert "client = _d1_proxy_client(req.domain)" in router
    assert 'body["domain"] = domain' in tool
    assert 'domain="ops"' in tool
    assert '"data_source_inventory"' in tool
    assert '"finlab_materialization_manifest"' in tool
    assert "partition_finlab_canonical_statements" in tool
