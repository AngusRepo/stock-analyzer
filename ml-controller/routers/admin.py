"""
admin.py — ml-controller misc admin endpoints.

Currently provides:
  POST /admin/modal-deploy     — Deploy ml-service/modal_app.py to Modal cloud

Why (2026-04-21 T1.0 Option A):
  Modal CLI was considered "local-only" because deployment needs the modal_app.py
  source file + MODAL_TOKEN env + `modal` package. ml-controller container
  already has modal==1.4.0 and MODAL_TOKEN_{ID,SECRET} env — the only missing
  piece was the source file. Root Dockerfile now COPYs ml-service/ into the
  image, so this endpoint can subprocess-call `modal deploy /app/ml-service/
  modal_app.py` from anywhere (cron, deploy script, CI, manual curl).

  First use case: absorbs roadmap #13 (#29a.4 Modal redeploy — surface FT-T
  Optuna crash fixes from ml-service/app/optuna_fttransformer_arch.py). Future:
  #14 FT-T arch Optuna monthly cron can auto-redeploy Modal when arch search
  space params change, no manual intervention.
"""
from __future__ import annotations

import logging
import os
import shlex
import subprocess
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/admin", tags=["admin"])
logger = logging.getLogger(__name__)

_DEFAULT_MODAL_APP_PATH = "/app/ml-service/modal_app.py"
_DEFAULT_TIMEOUT_SEC = 600  # 10 min — typical Modal deploy is 2-5 min


class ModalDeployRequest(BaseModel):
    """Trigger a `modal deploy` for an app file inside the container.

    `app_path` defaults to /app/ml-service/modal_app.py (the one shipped via
    the root Dockerfile). Override only for experimental deploys.
    """
    app_path: str = Field(default=_DEFAULT_MODAL_APP_PATH)
    timeout_sec: int = Field(default=_DEFAULT_TIMEOUT_SEC, ge=60, le=3600)
    note: Optional[str] = Field(default=None, max_length=200)


@router.post("/modal-deploy")
def modal_deploy(req: ModalDeployRequest = Body(default=ModalDeployRequest())):
    """Synchronous `modal deploy <app_path>` subprocess invocation.

    Preconditions (all handled at Dockerfile / Cloud Run env level):
      - modal==1.4.0 installed (ml-controller/requirements.txt)
      - MODAL_TOKEN_ID + MODAL_TOKEN_SECRET env vars set (gcloud run services
        describe shows both present)
      - /app/ml-service/modal_app.py ships in image (root Dockerfile COPY)

    Returns: status, duration, modal CLI stdout/stderr, exit code.
    """
    app_path = req.app_path
    if not Path(app_path).is_file():
        raise HTTPException(
            status_code=400,
            detail=f"Modal app file not found at {app_path}. "
                   f"Check image build: ml-service/ must be COPYed via root Dockerfile.",
        )

    # Sanity — modal CLI must exist
    if subprocess.run(["which", "modal"], capture_output=True).returncode != 0:
        raise HTTPException(
            status_code=500,
            detail="modal CLI not in PATH. Check ml-controller/requirements.txt "
                   "includes modal==1.4.0 and that pip install succeeded.",
        )

    token_id = os.environ.get("MODAL_TOKEN_ID", "")
    token_secret = os.environ.get("MODAL_TOKEN_SECRET", "")
    if not token_id or not token_secret:
        raise HTTPException(
            status_code=500,
            detail="MODAL_TOKEN_ID / MODAL_TOKEN_SECRET not set in Cloud Run env.",
        )

    cmd = ["modal", "deploy", app_path]
    logger.info(
        f"[admin/modal-deploy] launching: {' '.join(shlex.quote(p) for p in cmd)} "
        f"(timeout={req.timeout_sec}s note={req.note!r})"
    )
    start = time.time()
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=req.timeout_sec,
            # modal CLI reads MODAL_TOKEN_{ID,SECRET} from env automatically
            env={**os.environ},
            cwd=str(Path(app_path).parent),  # modal deploy reads cwd for relative imports
        )
    except subprocess.TimeoutExpired as e:
        elapsed = time.time() - start
        logger.error(f"[admin/modal-deploy] timeout after {elapsed:.1f}s")
        raise HTTPException(
            status_code=504,
            detail=f"modal deploy timed out after {req.timeout_sec}s. "
                   f"Partial output: {(e.stdout or b'').decode()[:1000]}",
        )

    elapsed = time.time() - start
    # modal CLI prints deploy log + final app URL to stdout; surface both streams
    tail_lines = 40
    stdout_tail = "\n".join((proc.stdout or "").splitlines()[-tail_lines:])
    stderr_tail = "\n".join((proc.stderr or "").splitlines()[-tail_lines:])

    result = {
        "status": "ok" if proc.returncode == 0 else "failed",
        "returncode": proc.returncode,
        "duration_sec": round(elapsed, 1),
        "app_path": app_path,
        "note": req.note,
        "stdout_tail": stdout_tail,
        "stderr_tail": stderr_tail,
    }

    if proc.returncode != 0:
        logger.error(
            f"[admin/modal-deploy] FAILED rc={proc.returncode} duration={elapsed:.1f}s"
        )
        raise HTTPException(status_code=500, detail=result)

    logger.info(f"[admin/modal-deploy] SUCCESS duration={elapsed:.1f}s")
    return result
