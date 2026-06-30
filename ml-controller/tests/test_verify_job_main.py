from verify_job_main import classify_verify_callback_status, format_verify_summary
from datetime import datetime, timezone


def test_verify_job_zero_written_rows_is_not_success_when_pending_exists():
    result = {
        "status": "ok",
        "pending": 12,
        "verified": 12,
        "metrics": {"verified_rows_written": 0},
        "errors": [],
    }

    status, error = classify_verify_callback_status(result)

    assert status == "error"
    assert "verified_rows_written=0" in error


def test_verify_job_zero_pending_is_skipped_not_success():
    result = {
        "status": "ok",
        "pending": 0,
        "verified": 0,
        "metrics": {"verified_rows_written": 0},
        "errors": [],
    }

    status, error = classify_verify_callback_status(result)

    assert status == "skipped"
    assert "no pending predictions" in error


def test_verify_job_unmatured_replay_zero_written_rows_is_skipped():
    result = {
        "status": "ok",
        "run_date": "2026-06-29",
        "pending": 9,
        "verified": 0,
        "metrics": {"verified_rows_written": 0},
        "errors": [],
    }

    status, error = classify_verify_callback_status(
        result,
        run_date="2026-06-29",
        tw_now=datetime(2026, 6, 30, 4, 30, tzinfo=timezone.utc),
    )

    assert status == "skipped"
    assert "no matured outcome writes yet" in error


def test_verify_summary_includes_durable_write_count():
    result = {
        "pending": 12,
        "verified": 12,
        "correct": 8,
        "total_pnl_pct": 0.013,
        "arf_updated": 2,
        "metrics": {"verified_rows_written": 12},
    }

    summary = format_verify_summary(result)

    assert "verified 12/12" in summary
    assert "written 12" in summary
