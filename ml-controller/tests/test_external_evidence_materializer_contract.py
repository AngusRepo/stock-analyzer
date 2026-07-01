from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_external_evidence_materializer_uses_dynamic_recommendation_date() -> None:
    source = (ROOT / "tools" / "materialize_external_evidence_once.py").read_text(encoding="utf-8")

    assert 'os.environ.get("TARGET_DATE", "").strip()' in source
    assert 'os.environ.get("AS_OF_DATE", "").strip()' in source
    assert "def resolve_run_dates" in source
    assert 'Path("/app")' in source
    assert 'Path("/root")' in source
    assert "SELECT MAX(date) AS date" in source
    assert "daily_recommendations" in source
    assert '"2026-05-15"' not in source
    assert '"2026-05-18"' not in source


def test_external_evidence_materializer_has_gdelt_global_fallback() -> None:
    source = (ROOT / "tools" / "materialize_external_evidence_once.py").read_text(encoding="utf-8")

    assert "fallback_queries" in source
    assert '"Taiwan stock market" OR TAIEX' in source
    assert '"global market risk" OR "US dollar" OR VIX' in source
    assert "market_risk_context" in source


def test_external_evidence_controller_route_is_daily_materializer_entrypoint() -> None:
    router = (ROOT / "ml-controller" / "routers" / "external_evidence.py").read_text(encoding="utf-8")
    main = (ROOT / "ml-controller" / "main.py").read_text(encoding="utf-8")

    assert '@router.post("/materialize")' in router
    assert 'importlib.import_module("tools.materialize_external_evidence_once")' in router
    assert '"CF_ACCOUNT_ID", "CF_D1_DB_ID", "CF_API_TOKEN"' in router
    assert "external_evidence.router" in main
