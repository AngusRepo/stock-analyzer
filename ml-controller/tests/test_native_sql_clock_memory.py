"""Restore sealed SQL without per-character regex stack amplification."""
import tracemalloc

import pytest

from services.native_paper_sandbox import clock_sql


@pytest.mark.parametrize('literal', [
    "'CURRENT_TIMESTAMP datetime(''now'')'",
    '"CURRENT_TIMESTAMP ""date"" (\'now\')"',
    '`CURRENT_TIMESTAMP ``date`` (\'now\')`',
    '[CURRENT_TIMESTAMP]',
])
def test_quoted_content_is_not_rewritten(literal):
    sql = f"SELECT {literal}, date(/* clock */ 'now'), CURRENT_TIMESTAMP;"
    assert clock_sql(sql) == f"SELECT {literal}, date(/* clock */ native_now()), (native_now());"


def test_large_sealed_json_literal_has_bounded_memory():
    # The old tokenizer required ~124 MB for only 1 MB of quoted data. Use an
    # input-relative budget, not elapsed time or available machine memory.
    sql = "INSERT INTO t VALUES('" + 'x' * 1_000_000 + "''CURRENT_TIMESTAMP');"
    tracemalloc.start()
    try:
        actual = clock_sql(sql)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert actual == sql
    assert peak < 8 * len(sql)


def test_comments_and_statement_boundaries_preserve_clock_context():
    sql = "-- CURRENT_TIMESTAMP\nSELECT strftime('%Y', /* keep */ 'now'); SELECT 'now';"
    assert clock_sql(sql) == "-- CURRENT_TIMESTAMP\nSELECT strftime('%Y', /* keep */ native_now()); SELECT 'now';"


@pytest.mark.parametrize('identifier', [
    'load_extension', '"load_extension"', '`load_extension`', '[load_extension]',
    "'load_extension'", '"READFILE"', '[writefile]',
])
def test_quoted_function_cannot_bypass_read_only_source_guard(identifier):
    from services.native_paper_source_capture import read_only_sql
    with pytest.raises(ValueError, match='forbidden'):
        read_only_sql(f"SELECT {identifier} /* ignored */ ('fixture')")


def test_read_only_source_guard_preserves_data_and_safe_quoted_functions():
    from services.native_paper_source_capture import read_only_sql
    sql = "SELECT 'load_extension', 'delete', length('x'), \"coalesce\"(a,0) FROM t"
    assert read_only_sql(sql) == sql
