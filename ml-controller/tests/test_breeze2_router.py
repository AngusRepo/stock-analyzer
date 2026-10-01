from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers.breeze2 import Breeze2FactCheckRequest, breeze2_fact_check  # noqa: E402


def test_breeze2_router_retired_for_local_and_modal_requests():
    from fastapi import HTTPException
    import pytest

    for execute_modal in (False, True):
        req = Breeze2FactCheckRequest(symbol="2330", execute_modal=execute_modal)
        with pytest.raises(HTTPException) as error:
            asyncio.run(breeze2_fact_check(req))
        assert error.value.status_code == 410
        assert error.value.detail == "breeze2_retired"


def test_breeze2_router_rejects_mutating_or_real_trade_scope():
    req = Breeze2FactCheckRequest(
        symbol="2330",
        trigger="screener_enrichment",
        reason="bad_scope",
        mutation_allowed=True,
    )

    try:
        asyncio.run(breeze2_fact_check(req))
    except Exception as exc:  # noqa: BLE001 - route raises HTTPException.
        assert "cannot mutate" in str(exc).lower()
    else:
        raise AssertionError("breeze2 route must reject mutating scope")
