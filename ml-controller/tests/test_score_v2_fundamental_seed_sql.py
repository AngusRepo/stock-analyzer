from __future__ import annotations

import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SQL_PATH = ROOT / "worker" / "repair_score_v2_fundamental_seed_from_d1.sql"


def _connect() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        CREATE TABLE financials (
          stock_id INTEGER NOT NULL,
          period TEXT NOT NULL,
          period_type TEXT NOT NULL,
          revenue REAL,
          revenue_growth_yoy REAL,
          eps REAL,
          roe REAL,
          pe REAL,
          pb REAL,
          dividend_yield REAL,
          created_at TEXT NOT NULL,
          operating_income REAL,
          total_assets REAL,
          total_liabilities REAL
        );
        CREATE TABLE canonical_revenue_monthly (
          stock_id TEXT NOT NULL,
          revenue_month TEXT NOT NULL,
          market_segment TEXT,
          yoy REAL
        );
        CREATE TABLE canonical_fundamental_features (
          stock_id TEXT NOT NULL,
          period TEXT NOT NULL,
          market_segment TEXT,
          report_date TEXT,
          available_date TEXT NOT NULL,
          revenue_growth_yoy REAL,
          gross_margin REAL,
          operating_margin REAL,
          roe REAL,
          eps REAL,
          pe REAL,
          pb REAL,
          dividend_yield REAL,
          debt_ratio REAL,
          current_ratio REAL,
          operating_cash_flow REAL,
          industry_quality_percentile REAL,
          source TEXT NOT NULL,
          lineage_json TEXT NOT NULL,
          as_of_date TEXT NOT NULL,
          PRIMARY KEY(stock_id, period, source)
        );
        """
    )
    return db


def test_fundamental_seed_sql_populates_canonical_rows_with_no_lookahead_dates() -> None:
    db = _connect()
    db.execute(
        """
        INSERT INTO financials (
          stock_id, period, period_type, revenue, revenue_growth_yoy, eps, roe,
          pe, pb, dividend_yield, created_at, operating_income, total_assets,
          total_liabilities
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (2330, "2025Q4", "quarterly", 1000, None, 3.2, 18.5, 20, 4.1, 2.5, "2026-03-27 15:28:46", 250, 2000, 500),
    )
    db.execute(
        """
        INSERT INTO canonical_revenue_monthly (stock_id, revenue_month, market_segment, yoy)
        VALUES (?, ?, ?, ?)
        """,
        ("2330", "2026-05-11", "LISTED_OTC", 12.5),
    )

    db.executescript(SQL_PATH.read_text(encoding="utf-8"))
    row = db.execute("SELECT * FROM canonical_fundamental_features").fetchone()

    assert row["stock_id"] == "2330"
    assert row["period"] == "2025Q4"
    assert row["market_segment"] == "LISTED_OTC"
    assert row["report_date"] == "2025-12-31"
    assert row["available_date"] == "2026-03-27"
    assert row["revenue_growth_yoy"] == 12.5
    assert row["operating_margin"] == 25.0
    assert row["debt_ratio"] == 25.0
    assert row["source"] == "d1.financials_seed"
    assert "score-v2-fundamental-seed-v1" in row["lineage_json"]


def test_fundamental_seed_sql_has_no_destructive_statements() -> None:
    source = "\n".join(
        line for line in SQL_PATH.read_text(encoding="utf-8").upper().splitlines()
        if not line.strip().startswith("--")
    )

    assert "INSERT OR REPLACE INTO CANONICAL_FUNDAMENTAL_FEATURES" in source
    assert "DROP " not in source
    assert "DELETE " not in source
    assert "UPDATE " not in source
    assert "TRUNCATE" not in source
