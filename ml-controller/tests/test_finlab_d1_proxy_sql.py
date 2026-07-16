from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routers.finlab import _validate_d1_proxy_sql


def test_d1_proxy_accepts_terminal_delimiter_for_single_dml_statement() -> None:
    assert _validate_d1_proxy_sql(
        "INSERT INTO sample (id) VALUES (?);",
        allow_read=False,
        allow_dml=True,
    ) == "INSERT"


def test_d1_proxy_rejects_internal_multiple_statements() -> None:
    with pytest.raises(ValueError, match="multiple SQL statements are not allowed"):
        _validate_d1_proxy_sql(
            "DELETE FROM sample; DROP TABLE sample;",
            allow_read=False,
            allow_dml=True,
        )
