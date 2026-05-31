from verify_job_main import build_verify_callback_metadata, classify_verify_callback_status, format_verify_summary


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


def test_verify_job_all_pending_without_bars_is_skipped_not_error():
    result = {
        "status": "ok",
        "pending": 336,
        "verified": 0,
        "metrics": {"verified_rows_written": 0, "skipped_no_bars": 336},
        "errors": [],
    }

    status, error = classify_verify_callback_status(result)

    assert status == "skipped"
    assert "OHLC bars are missing" in error


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


def test_verify_callback_metadata_enables_historical_learning_catchup_only_for_backfill_dates():
    historical = build_verify_callback_metadata("2026-05-29", today="2026-05-31")
    current = build_verify_callback_metadata("2026-05-31", today="2026-05-31")

    assert historical["allow_historical_learning_catchup"] is True
    assert historical["learning_catchup_scope"] == "meta_learning_shadow_and_strategy_learning_only"
    assert current["allow_historical_learning_catchup"] is False
