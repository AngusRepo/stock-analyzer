"""ROSTER-PREP-60: the minimum daily price rows a symbol needs, read from its one owner.

The owner is schemas/price-history-eligibility-v1.json (not KV). The screener (Worker,
worker/src/lib/priceHistoryEligibility.ts) drops a symbol below it from the universe, and the
R33 prep (ml-service universal_training) gives such a symbol no row, so the screener never
selects a name the prep cannot serve. Layouts: the repository (parents[2]), the controller
image (/app/services -> /app/schemas) and Modal (/root/services -> /root/schemas).
"""
from __future__ import annotations

import json
import math
from pathlib import Path

SCHEMA_VERSION = "price-history-eligibility-contract-v1"
FILE_NAME = "price-history-eligibility-v1.json"


def _contract_path() -> Path:
    source = Path(__file__).resolve()
    for candidate in (source.parents[2] / "schemas" / FILE_NAME, source.parents[1] / "schemas" / FILE_NAME):
        if candidate.exists():
            return candidate
    raise RuntimeError("price_history_contract_missing")


def load(path: Path | None = None) -> dict:
    """The validated contract; anything but a positive integer minimum fails closed."""
    contract = json.loads((path or _contract_path()).read_text(encoding="utf-8"))
    if not isinstance(contract, dict) or contract.get("schema_version") != SCHEMA_VERSION:
        raise RuntimeError("price_history_contract_version_invalid")
    minimum = contract.get("min_price_rows")
    # JSON 60.0 is the integer 60 to the Worker's validator; read it the same way here.
    if isinstance(minimum, float) and math.isfinite(minimum) and minimum.is_integer():
        minimum = int(minimum)
    if not isinstance(minimum, int) or isinstance(minimum, bool) or minimum < 1:
        raise RuntimeError("price_history_contract_min_price_rows_invalid")
    return {**contract, "min_price_rows": minimum}


CONTRACT_PATH = _contract_path()
MIN_PRICE_ROWS: int = load(CONTRACT_PATH)["min_price_rows"]
