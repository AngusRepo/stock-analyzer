"""Authenticated source and private execution endpoints; no formal account writes."""
import asyncio
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, ConfigDict

from services.paper_corporate_source import materialize_corporate_source, production_objects

router = APIRouter(prefix='/paper', tags=['paper-source'])


class NativeTickRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    session_date: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')


@router.post('/native-execution-tick')
async def native_execution_tick(request: NativeTickRequest):
    # The former paired scheduler has no execution authority after single-B cutover.
    # Historical accounting/replay functions remain available to their explicit owners.
    return {'status': 'disabled_by_single_b_policy', 'pairs': [], 'executed': 0}


class CorporateSourceRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    session_date: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
    scope_id: str = Field(pattern=r'^(paper-account-1|paired-[a-f0-9]{64})$')
    symbols: list[str] = Field(max_length=2000)
    outstanding_action_ids: list[str] = Field(max_length=2000)
    historical_cash_dates: dict[str, list[str]] | None = Field(default=None, max_length=2000)


@router.post('/corporate-source')
async def corporate_source(request: CorporateSourceRequest):
    try:
        return await asyncio.to_thread(materialize_corporate_source,
            **request.model_dump(), objects=production_objects())
    except ValueError as exc:
        # Source parsers use bounded reason codes, not raw credential responses.
        raise HTTPException(status_code=409, detail=str(exc)) from None
