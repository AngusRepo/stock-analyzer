"""Dedicated private Cloud Run app for StockVision broker execution.

Do not mount this route in the general ml-controller service. Runtime must use
min=1/max=1, continuous CPU and a private invoker before live flags are set.
"""

from __future__ import annotations

import hmac
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from services.broker_execution_repository import D1BrokerExecutionRepository
from services.finlab_execution_gateway import PersistentFinlabExecutionGateway
from services.finlab_live_submit_service import run_finlab_live_submit


SERVICE_ROLE = os.environ.get("EXECUTION_GATEWAY_SERVICE_ROLE", "")
SERVICE_TOKEN = os.environ.get("EXECUTION_GATEWAY_SERVICE_TOKEN", "")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "development")

repository = D1BrokerExecutionRepository()
gateway = PersistentFinlabExecutionGateway(repository, env=os.environ)


class ExecuteRequest(BaseModel):
    packet: dict[str, Any] = Field(default_factory=dict)
    allow_live_submit: bool = False


def _verify_service_token(authorization: str | None) -> None:
    if SERVICE_ROLE != "dedicated_execution_gateway":
        raise HTTPException(503, "dedicated execution gateway role not configured")
    if not SERVICE_TOKEN:
        if ENVIRONMENT == "production":
            raise HTTPException(500, "execution gateway service token not configured")
        raise HTTPException(503, "execution gateway disabled")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "unauthorized")
    if not hmac.compare_digest(authorization[7:], SERVICE_TOKEN):
        raise HTTPException(401, "invalid execution gateway token")


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    gateway.close()


app = FastAPI(title="StockVision Execution Gateway", version="1.0.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, Any]:
    state = gateway.health()
    return {
        "status": "ready" if state.get("healthy") else "disabled_or_not_started",
        "service_role_ready": SERVICE_ROLE == "dedicated_execution_gateway",
        "live_submit_enabled": str(os.environ.get("FINLAB_LIVE_SUBMIT_ENABLED") or "").lower() in {"1", "true", "yes", "enabled"},
        "gateway": state,
    }


@app.post("/v1/execute")
def execute(
    req: ExecuteRequest,
    authorization: str | None = Header(default=None),
    x_execution_signature: str | None = Header(default=None, alias="X-Execution-Signature"),
) -> dict[str, Any]:
    _verify_service_token(authorization)
    return run_finlab_live_submit(
        packet=req.packet or None,
        signature=x_execution_signature,
        allow_live_submit=req.allow_live_submit,
        repository=repository,
        gateway=gateway,
    )


@app.get("/v1/intents/{idempotency_key}")
def intent_status(idempotency_key: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _verify_service_token(authorization)
    lifecycle = repository.intent_lifecycle(idempotency_key)
    if lifecycle is None:
        raise HTTPException(404, "execution intent not found")
    return {"status": "ok", **lifecycle}
