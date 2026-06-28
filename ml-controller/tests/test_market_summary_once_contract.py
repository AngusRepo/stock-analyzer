from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "materialize_market_summary_once.py"


def test_market_summary_once_is_dry_run_by_default_and_targets_summary_only() -> None:
    source = TOOL.read_text(encoding="utf-8")
    assert "fetch_official_market_summary_frames" in source
    assert '"mode": "apply" if args.apply else "dry_run"' in source
    assert 'parser.add_argument("--apply", action="store_true"' in source
    assert 'datasets=["canonical_market_summary_daily"]' in source
    assert "batch_execute" in source
    assert source.index("if args.apply:") < source.index("batch_execute")
