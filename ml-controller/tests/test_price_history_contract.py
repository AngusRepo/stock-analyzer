"""ROSTER-PREP-60: one owner (schemas/price-history-eligibility-v1.json) for the screener and R33 prep."""
from __future__ import annotations

import json
import posixpath
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from services import price_history_contract as contract

ROOT = Path(__file__).resolve().parents[2]
OWNER = ROOT / "schemas" / contract.FILE_NAME


def test_loader_reads_the_one_owner():
    assert contract.CONTRACT_PATH == OWNER
    raw = json.loads(OWNER.read_text(encoding="utf-8"))
    assert raw["schema_version"] == contract.SCHEMA_VERSION
    assert contract.MIN_PRICE_ROWS == raw["min_price_rows"] == 60


def test_worker_and_python_read_the_same_file_and_value():
    ts = (ROOT / "worker/src/lib/priceHistoryEligibility.ts").read_text(encoding="utf-8")
    spec = re.search(r"import contractJson from '([^']+)'", ts).group(1)
    assert (ROOT / "worker/src/lib" / spec).resolve() == OWNER.resolve()
    assert f"PRICE_HISTORY_CONTRACT_SCHEMA = '{contract.SCHEMA_VERSION}'" in ts
    assert "historyRows >= minimum" in ts and "minimum: number = MIN_PRICE_ROWS_FOR_SELECTION" in ts
    screener = (ROOT / "worker/src/lib/marketScreener.ts").read_text(encoding="utf-8")
    assert "const historyGate = evaluatePriceHistoryGate(" in screener


def test_screener_counts_the_rows_the_prep_counts():
    """The prep's rows are the price capture's bars with close > 0 up to the run date (FinLab daily
    price, mirrored in canonical_market_daily finlab.price); the screener counts that, not stock_prices."""
    ts = (ROOT / "worker/src/lib/priceHistoryEligibility.ts").read_text(encoding="utf-8")
    sql = re.search(r"const sql = `([^`]+)`", ts).group(1)
    assert "FROM canonical_market_daily" in sql and "source = 'finlab.price'" in sql
    assert "close > 0" in sql and "date <= ?" in sql and "stock_prices" not in sql
    capture = (ROOT / "ml-controller/services/training_price_capture.py").read_text(encoding="utf-8")
    assert 'frame.filter(pl.col("close").is_finite() & (pl.col("close")>0))' in capture
    assert '.filter(pl.col("date")<=run_date)' in capture


@pytest.mark.parametrize("body,error", [
    ({"schema_version": "v0", "min_price_rows": 60}, "version_invalid"),
    ({"schema_version": contract.SCHEMA_VERSION}, "min_price_rows_invalid"),
    ({"schema_version": contract.SCHEMA_VERSION, "min_price_rows": 0}, "min_price_rows_invalid"),
    ({"schema_version": contract.SCHEMA_VERSION, "min_price_rows": 59.5}, "min_price_rows_invalid"),
    ({"schema_version": contract.SCHEMA_VERSION, "min_price_rows": "60"}, "min_price_rows_invalid"),
    ({"schema_version": contract.SCHEMA_VERSION, "min_price_rows": True}, "min_price_rows_invalid"),
    ({"schema_version": contract.SCHEMA_VERSION, "min_price_rows": float("nan")}, "min_price_rows_invalid"),
    ([], "version_invalid"),
])
def test_invalid_contract_fails_closed(tmp_path, body, error):
    path = tmp_path / contract.FILE_NAME
    path.write_text(json.dumps(body), encoding="utf-8")
    with pytest.raises(RuntimeError, match=error):
        contract.load(path)


def test_integral_float_reads_as_the_worker_reads_it(tmp_path):
    path = tmp_path / contract.FILE_NAME
    path.write_text('{"schema_version": "%s", "min_price_rows": 60.0}' % contract.SCHEMA_VERSION, encoding="utf-8")
    loaded = contract.load(path)["min_price_rows"]
    assert loaded == 60 and type(loaded) is int


@pytest.mark.parametrize("with_schemas", [True, False])
def test_deployed_layouts_resolve_or_fail_closed(tmp_path, with_schemas):
    """Controller image (/app/services + /app/schemas) and Modal (/root/services + /root/schemas)."""
    root = tmp_path / "app"
    (root / "services").mkdir(parents=True)
    shutil.copy(ROOT / "ml-controller/services/__init__.py", root / "services/__init__.py")
    shutil.copy(ROOT / "ml-controller/services/price_history_contract.py", root / "services/price_history_contract.py")
    if with_schemas:
        (root / "schemas").mkdir()
        shutil.copy(OWNER, root / "schemas" / contract.FILE_NAME)
    script = ("import sys; sys.path.insert(0, sys.argv[1]); from services import price_history_contract as c; "
              "print(c.MIN_PRICE_ROWS, c.CONTRACT_PATH)")
    result = subprocess.run([sys.executable, "-I", "-c", script, str(root)], cwd=tmp_path,
                            capture_output=True, text=True, timeout=60)
    if with_schemas:
        assert result.returncode == 0, result.stderr
        assert result.stdout.split() == ["60", str(root / "schemas" / contract.FILE_NAME)]
    else:
        assert result.returncode != 0 and "price_history_contract_missing" in result.stderr


def test_images_ship_the_contract():
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    assert f"COPY schemas/{contract.FILE_NAME} /app/schemas/{contract.FILE_NAME}" in dockerfile
    # compiled screener: /app/worker-dist/src/lib/priceHistoryEligibility.js -> ../../../schemas/...
    assert posixpath.normpath(f"/app/worker-dist/src/lib/../../../schemas/{contract.FILE_NAME}") == \
        f"/app/schemas/{contract.FILE_NAME}"
    modal = (ROOT / "ml-service/modal_app.py").read_text(encoding="utf-8")
    assert '.add_local_dir(str(_LOCAL_SCHEMAS_DIR), remote_path="/root/schemas")' in modal
    assert '.add_local_dir(str(_LOCAL_CONTROLLER_SERVICES_DIR), remote_path="/root/services")' in modal


def test_controller_capture_guard_reads_the_contract():
    source = (ROOT / "ml-controller/services/training_price_capture.py").read_text(encoding="utf-8")
    assert "from services.price_history_contract import MIN_PRICE_ROWS" in source
    assert "previous_count>=MIN_PRICE_ROWS and len(rows)<MIN_PRICE_ROWS" in source
    assert "previous_count>=60" not in source


def test_retrain_payload_builder_reads_the_contract():
    """The universal retrain payloads (upstream of the prep) skip by the same minimum."""
    source = (ROOT / "ml-controller/routers/retrain_trigger.py").read_text(encoding="utf-8")
    assert "from services.price_history_contract import MIN_PRICE_ROWS" in source
    assert "if len(px) < MIN_PRICE_ROWS:" in source and "len(px) < 60" not in source
