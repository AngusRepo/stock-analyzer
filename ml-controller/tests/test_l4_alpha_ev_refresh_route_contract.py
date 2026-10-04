import asyncio
from pathlib import Path
import pytest
from fastapi import HTTPException
from routers.l4_alpha_ev import L4AlphaEvRefreshReq, refresh_l4_alpha_ev_artifact


@pytest.mark.parametrize('promote,dry_run', [(False,False),(True,False),(False,True)])
def test_old_api_is_permanently_gone_without_config_database_or_fit(promote,dry_run):
    with pytest.raises(HTTPException) as error:
        asyncio.run(refresh_l4_alpha_ev_artifact(L4AlphaEvRefreshReq(promote=promote,dry_run=dry_run)))
    assert error.value.status_code==410
    assert error.value.detail=='legacy_ev_refresh_retired_use_l4_distribution'


def test_retired_router_has_no_runtime_training_or_database_imports():
    source=(Path(__file__).parents[1]/'routers/l4_alpha_ev.py').read_text()
    assert 'from services' not in source and 'import services' not in source
