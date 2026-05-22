import importlib.util
import io
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "finlab_canonical_d1_verify",
    ROOT / "tools" / "finlab_canonical_d1_verify.py",
)
assert SPEC and SPEC.loader
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)


def test_build_freshness_check_blocks_stale_canonical():
    check = verify.build_freshness_check(
        {
            "canonical_chip_date": "2026-05-15",
            "canonical_chip_rows": 2629,
            "institutional_amount_date": "2026-05-21",
            "institutional_amount_rows": 5,
            "legacy_chip_date": "2026-05-21",
            "legacy_chip_rows": 15256,
            "margin_date": "2026-05-21",
            "margin_rows": 1839,
        }
    )

    assert check["status"] == "fail"
    assert check["decision"] == "BLOCK"
    assert check["metrics"]["lag_days"] == 6
    assert check["metrics"]["required_job_arg"] == "--apply-canonical-d1"


def test_build_freshness_check_passes_aligned_canonical():
    check = verify.build_freshness_check(
        {
            "canonical_chip_date": "2026-05-21",
            "canonical_chip_rows": 2629,
            "institutional_amount_date": "2026-05-21",
            "institutional_amount_rows": 5,
            "legacy_chip_date": "2026-05-21",
            "legacy_chip_rows": 15256,
            "margin_date": "2026-05-21",
            "margin_rows": 1839,
        }
    )

    assert check["status"] == "ok"
    assert check["decision"] == "PASS"
    assert "lag=0d" in check["summary"]
    assert "amount_lag=0d" in check["summary"]


def test_build_freshness_check_blocks_missing_official_amounts():
    check = verify.build_freshness_check(
        {
            "canonical_chip_date": "2026-05-21",
            "canonical_chip_rows": 2629,
            "legacy_chip_date": "2026-05-21",
            "legacy_chip_rows": 15256,
            "margin_date": "2026-05-21",
            "margin_rows": 1839,
        }
    )

    assert check["status"] == "fail"
    assert check["decision"] == "BLOCK"
    assert "canonical_institutional_amount_daily missing" in check["summary"]


def test_parse_wrangler_results_accepts_array_payload():
    rows = verify.parse_wrangler_results(
        '[{"results":[{"canonical_chip_date":"2026-05-21","canonical_chip_rows":2629}],"success":true}]'
    )

    assert rows == [{"canonical_chip_date": "2026-05-21", "canonical_chip_rows": 2629}]


def test_main_reads_wrangler_json_from_stdin(monkeypatch, capsys):
    payload = json.dumps(
        [
            {
                "results": [
                    {
                        "canonical_chip_date": "2026-05-21",
                        "canonical_chip_rows": 2629,
                        "institutional_amount_date": "2026-05-21",
                        "institutional_amount_rows": 5,
                        "legacy_chip_date": "2026-05-21",
                        "legacy_chip_rows": 15256,
                        "margin_date": "2026-05-21",
                        "margin_rows": 1839,
                    }
                ],
                "success": True,
            }
        ]
    )
    monkeypatch.setattr(verify.sys, "stdin", io.StringIO(payload))

    assert verify.main(["--stdin"]) == 0
    assert '"decision": "PASS"' in capsys.readouterr().out
