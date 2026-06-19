"""
admin.py — ml-controller misc admin endpoints.

Currently provides:
  POST /admin/modal-deploy              — Deploy ml-service/modal_app.py to Modal cloud
  POST /admin/migration_safety_check    — 3-layer validation for signal-migration safety

Why (2026-04-21 T1.0 Option A):
  Modal CLI was considered "local-only" because deployment needs the modal_app.py
  source file + MODAL_TOKEN env + `modal` package. ml-controller container
  already has modal==1.4.0 and MODAL_TOKEN_{ID,SECRET} env — the only missing
  piece was the source file. Root Dockerfile now COPYs ml-service/ into the
  image, so this endpoint can subprocess-call `modal deploy /app/ml-service/
  modal_app.py` from anywhere (cron, deploy script, CI, manual curl).

  The endpoint is retained for controlled Modal redeploys of active training
  and inference functions. Retired model research paths are not redeployed
  through this route.

Migration safety harness (2026-04-21 #11 / M33):
  /admin/migration_safety_check runs 3 parity layers when swapping signal
  sources in the recommendation pipeline, to catch the class of bug that
  caused Migration C 4/17 (ensemble_v2 shift → bot 0 buys 4 days because
  threshold 0.70 unreachable under CLT-compressed rank-avg distribution).
  "Threshold parity verified" must mean all three: label, behavioral, and
  distributional parity.
"""
from __future__ import annotations

import json as _json
import logging
import os
import shlex
import shutil
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel, Field

from services.design_review_client import call_gemini_design_review

router = APIRouter(prefix="/admin", tags=["admin"])
logger = logging.getLogger(__name__)

_MODAL_STABLE_MTIME = 1767225600  # 2026-01-01 UTC


def _prepare_stable_modal_source(app_path: str) -> tuple[str, str]:
    """Copy deploy inputs to /tmp with normalized mtimes for Modal CLI."""
    src_file = Path(app_path).resolve()
    src_dir = src_file.parent
    stable_dir = Path("/tmp/modal_deploy") / src_file.stem
    if stable_dir.exists():
        shutil.rmtree(stable_dir)
    stable_dir.mkdir(parents=True, exist_ok=True)

    stable_file = stable_dir / src_file.name
    shutil.copy2(src_file, stable_file)

    for rel_dir in ("app", "scripts"):
        src_rel = src_dir / rel_dir
        if src_rel.exists():
            shutil.copytree(src_rel, stable_dir / rel_dir, dirs_exist_ok=True)

    repo_root = src_dir.parent
    extra_dirs = {
        "tools": [repo_root / "tools"],
        "services": [
            repo_root / "services",
            repo_root / "ml-controller" / "services",
        ],
    }
    for rel_dir, candidates in extra_dirs.items():
        src_rel = next((candidate for candidate in candidates if candidate.exists()), None)
        if src_rel is not None:
            shutil.copytree(src_rel, stable_dir / rel_dir, dirs_exist_ok=True)

    data_registry = repo_root / "data" / "feature_registry"
    if data_registry.exists():
        shutil.copytree(data_registry, stable_dir / "data" / "feature_registry", dirs_exist_ok=True)

    formal137_pairs = repo_root / "output" / "feature_universe_triage" / "formal137_pairwise_similarity_long_20260617.csv"
    if formal137_pairs.exists():
        target = stable_dir / "output" / "feature_universe_triage" / formal137_pairs.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(formal137_pairs, target)

    strategy_mining_job = next(
        (
            candidate
            for candidate in (
                repo_root / "strategy_mining_job_main.py",
                repo_root / "ml-controller" / "strategy_mining_job_main.py",
            )
            if candidate.exists()
        ),
        None,
    )
    if strategy_mining_job is not None:
        shutil.copy2(strategy_mining_job, stable_dir / "strategy_mining_job_main.py")

    req_file = src_dir / "requirements.txt"
    if req_file.exists():
        shutil.copy2(req_file, stable_dir / "requirements.txt")

    targets = [stable_dir, stable_file]
    targets.extend(stable_dir.rglob("*"))
    for target in targets:
        os.utime(target, (_MODAL_STABLE_MTIME, _MODAL_STABLE_MTIME))

    return str(stable_file), str(stable_dir)

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


class DesignReviewArtifact(BaseModel):
    name: str = Field(..., min_length=1, max_length=160)
    kind: Literal["code", "diff", "markdown", "route_map", "screenshot_note", "text"] = "text"
    content: str = Field(..., min_length=1, max_length=24_000)


class DesignReviewRequest(BaseModel):
    objective: str = Field(..., min_length=1, max_length=1_000)
    focus: list[str] = Field(default_factory=list, max_items=10)
    current_notes: Optional[str] = Field(default=None, max_length=4_000)
    artifacts: list[DesignReviewArtifact] = Field(default_factory=list, max_items=8)
    temperature: float = Field(default=0.35, ge=0.0, le=0.8)
    max_output_tokens: int = Field(default=2048, ge=512, le=3072)


@router.post("/design-review")
async def design_review(req: DesignReviewRequest):
    """Bounded Gemini UI/UX reviewer.

    This endpoint deliberately accepts curated UI/UX artifacts instead of free
    chat. The Gemini key remains server-side in Cloud Run.
    """
    try:
        result = await call_gemini_design_review(
            req.dict(),
            temperature=req.temperature,
            max_output_tokens=req.max_output_tokens,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("[admin/design-review] unexpected failure")
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}") from exc
    return {
        "ok": True,
        "artifact_count": len(req.artifacts),
        **result,
    }


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

    stable_app_path, stable_dir = _prepare_stable_modal_source(app_path)
    cmd = ["modal", "deploy", Path(stable_app_path).name]
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
            cwd=stable_dir,
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
        "stable_app_path": stable_app_path,
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


# ─── /admin/quantaalpha-* (#11 Phase 1 T1.4 — 2026-04-21) ────────────────────
# Three endpoints bootstrapping + running QuantaAlpha POC entirely from cloud.
# Reuses same modal CLI / MODAL_TOKEN setup as /admin/modal-deploy above.

class QuantaAlphaBootstrapReq(BaseModel):
    force_secret_update: bool = Field(default=False)
    timeout_sec: int = Field(default=900, ge=60, le=3600)


@router.post("/quantaalpha-bootstrap")
def quantaalpha_bootstrap(req: QuantaAlphaBootstrapReq = Body(default=QuantaAlphaBootstrapReq())):
    """One-shot: (1) create/update modal secret quantaalpha-llm from ml-controller
    env GEMINI_API_KEY, (2) modal deploy modal_app_quantaalpha.py.

    Idempotent — safe to re-run. Returns per-step status.
    """
    results: dict[str, Any] = {}
    start = time.time()

    gemini_key = os.environ.get("GEMINI_API_KEY", "")
    if not gemini_key:
        raise HTTPException(500, "GEMINI_API_KEY not in ml-controller env")
    cf_token = os.environ.get("CF_API_TOKEN", "")
    cf_account = os.environ.get("CF_ACCOUNT_ID", "")
    cf_d1 = os.environ.get("CF_D1_DB_ID", "")
    if not all([cf_token, cf_account, cf_d1]):
        raise HTTPException(500, "CF_* env vars incomplete in ml-controller env")

    def _create_or_noop_secret(name: str, kv_args: list[str]) -> dict:
        cmd = ["modal", "secret", "create", name] + kv_args
        if req.force_secret_update:
            cmd.append("--force")
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  timeout=120, env={**os.environ})
            if proc.returncode == 0:
                return {"status": "ok", "note": "created/updated"}
            combined = (proc.stderr or "") + (proc.stdout or "")
            if "already exists" in combined.lower():
                return {"status": "ok", "note": "already exists (idempotent)"}
            return {"status": "error", "rc": proc.returncode, "stderr": combined[-500:]}
        except Exception as e:
            return {"status": "error", "exception": str(e)}

    # Step 1a: Gemini LLM secret
    results["secret_llm"] = _create_or_noop_secret(
        "quantaalpha-llm",
        [f"GEMINI_API_KEY={gemini_key}"],
    )
    # Step 1b: CF D1 secret (ml-controller's token has verified D1 access; paper-trail:
    # routers/migration_safety_check pulls predictions via same token)
    results["secret_cf"] = _create_or_noop_secret(
        "quantaalpha-cf",
        [f"CF_API_TOKEN={cf_token}",
         f"CF_ACCOUNT_ID={cf_account}",
         f"CF_D1_DB_ID={cf_d1}"],
    )

    # Step 2: modal deploy modal_app_quantaalpha.py
    # Cloud Run 容器 /app/ 下的 filesystem mtime 不穩 → Modal CLI 誤判 "file modified"。
    # 複製到 /tmp 固定 mtime 後 deploy，避開此 issue。
    src_path = "/app/ml-service/modal_app_quantaalpha.py"
    if not Path(src_path).is_file():
        raise HTTPException(500, f"{src_path} not in image — rebuild ml-controller required")
    import shutil
    stable_dir = Path("/tmp/quantaalpha_deploy")
    stable_dir.mkdir(parents=True, exist_ok=True)
    app_path = str(stable_dir / "modal_app_quantaalpha.py")
    shutil.copy2(src_path, app_path)
    # 固定 mtime 到一個過去時間（2026-01-01）讓 Modal hash 穩定
    os.utime(app_path, (1767225600, 1767225600))
    try:
        proc = subprocess.run(
            ["modal", "deploy", "modal_app_quantaalpha.py"],
            capture_output=True, text=True,
            timeout=req.timeout_sec,
            env={**os.environ},
            cwd=str(stable_dir),
        )
        results["deploy"] = {
            "status": "ok" if proc.returncode == 0 else "error",
            "rc": proc.returncode,
            "stdout_tail": (proc.stdout or "")[-800:],
            "stderr_tail": (proc.stderr or "")[-800:],
        }
    except subprocess.TimeoutExpired:
        results["deploy"] = {"status": "timeout", "after_sec": req.timeout_sec}
    except Exception as e:
        results["deploy"] = {"status": "error", "exception": str(e)}

    results["duration_sec"] = round(time.time() - start, 1)
    return results


class QuantaAlphaRunReq(BaseModel):
    step: str = Field(default="full", description="'build_qlib' | 'mine' | 'full' | 'check'")
    direction: str = Field(default="Price-Volume Factor Mining")
    experiment_suffix: str = Field(default="poc1")
    years: int = Field(default=5, ge=1, le=10)
    timeout_sec: int = Field(default=900, ge=60, le=3600,
                             description="Subprocess timeout for spawn/status; actual Modal jobs run asynchronously")


@router.post("/quantaalpha-run")
def quantaalpha_run(req: QuantaAlphaRunReq = Body(default=QuantaAlphaRunReq())):
    """Trigger QuantaAlpha Modal functions. step='build_qlib' builds Qlib binary
    from D1; step='mine' runs 1 mining cycle; step='full' chains both (build
    first, then mine); step='check' reports volume state only.

    Uses `modal run --detach` so Cloud Run request returns quickly while Modal
    executes in background. Poll Modal dashboard for live progress.
    """
    src_path = "/app/ml-service/modal_app_quantaalpha.py"
    if not Path(src_path).is_file():
        raise HTTPException(500, f"{src_path} not in image — rebuild ml-controller required")
    # 同 bootstrap 用 /tmp 固定 mtime 避 "file modified" error
    import shutil
    stable_dir = Path("/tmp/quantaalpha_deploy")
    stable_dir.mkdir(parents=True, exist_ok=True)
    app_path_local = str(stable_dir / "modal_app_quantaalpha.py")
    shutil.copy2(src_path, app_path_local)
    os.utime(app_path_local, (1767225600, 1767225600))

    def _modal_run(func: str, extra_args: list[str] | None = None) -> dict:
        cmd = ["modal", "run", "--detach",
               f"modal_app_quantaalpha.py::{func}"] + (extra_args or [])
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  timeout=req.timeout_sec, env={**os.environ},
                                  cwd=str(stable_dir))
            return {
                "status": "ok" if proc.returncode == 0 else "error",
                "cmd": " ".join(shlex.quote(p) for p in cmd),
                "rc": proc.returncode,
                "stdout_tail": (proc.stdout or "")[-800:],
                "stderr_tail": (proc.stderr or "")[-800:],
            }
        except subprocess.TimeoutExpired:
            return {"status": "timeout", "cmd": " ".join(cmd)}

    def _modal_spawn(func_name: str, kwargs: dict) -> dict:
        """True fire-and-forget via Modal Python SDK .spawn() — returns call_id
        for dashboard lookup; does NOT wait for function completion."""
        try:
            import modal
            fn = modal.Function.from_name("quantaalpha-poc", func_name)
            call = fn.spawn(**kwargs)
            return {
                "status": "spawned",
                "function": func_name,
                "call_id": getattr(call, "object_id", str(call)),
                "dashboard": f"https://modal.com/apps/wayne60619/main (search {func_name})",
            }
        except Exception as e:
            return {"status": "error", "exception": f"{type(e).__name__}: {e}"}

    out: dict[str, Any] = {}
    if req.step in ("check", "full"):
        out["check"] = _modal_run("check_qlib_data")
    if req.step in ("build_qlib", "full"):
        out["build_qlib"] = _modal_run(
            "build_qlib_binary",
            ["--universe-name", "sv_screener_350", "--years", str(req.years)],
        )
    if req.step in ("mine", "full"):
        # Mine cycle 1-6 hr → spawn truly async (CLI --detach 不 detach)
        out["mine"] = _modal_spawn("run_mine_cycle", {
            "research_direction": req.direction,
            "experiment_suffix": req.experiment_suffix,
        })
    return out


class QuantaAlphaStatusReq(BaseModel):
    call_id: str


@router.post("/quantaalpha-logs")
def quantaalpha_logs(timeout_sec: int = 60):
    """Tail recent Modal app logs via CLI — diagnose hung function calls."""
    try:
        proc = subprocess.run(
            ["modal", "app", "logs", "quantaalpha-poc"],
            capture_output=True, text=True,
            timeout=timeout_sec, env={**os.environ},
        )
        return {
            "status": "ok" if proc.returncode == 0 else "error",
            "rc": proc.returncode,
            "stdout_tail": (proc.stdout or "")[-3000:],
            "stderr_tail": (proc.stderr or "")[-1000:],
        }
    except subprocess.TimeoutExpired:
        # modal app logs streams; timeout is normal. return whatever we got.
        return {"status": "streamed_timeout",
                "note": f"CLI ran {timeout_sec}s (log streaming expected)."}
    except Exception as e:
        return {"status": "error", "exception": f"{type(e).__name__}: {e}"}


class QuantaAlphaCancelReq(BaseModel):
    call_id: str


@router.post("/quantaalpha-cancel")
def quantaalpha_cancel(req: QuantaAlphaCancelReq = Body(...)):
    """Cancel a running Modal FunctionCall."""
    try:
        import modal
        call = modal.FunctionCall.from_id(req.call_id)
        call.cancel()
        return {"status": "cancelled", "call_id": req.call_id}
    except Exception as e:
        return {"status": "error", "call_id": req.call_id,
                "exception": f"{type(e).__name__}: {e}"}


@router.post("/quantaalpha-status")
def quantaalpha_status(req: QuantaAlphaStatusReq = Body(...)):
    """Poll Modal FunctionCall status by call_id returned from /quantaalpha-run."""
    try:
        import modal
        call = modal.FunctionCall.from_id(req.call_id)
        # get with timeout=0 raises TimeoutError if still running
        try:
            result = call.get(timeout=0)
            return {"status": "done", "call_id": req.call_id, "result": result}
        except TimeoutError:
            return {"status": "running", "call_id": req.call_id}
        except modal.exception.OutputExpiredError:
            return {"status": "expired", "call_id": req.call_id,
                    "note": "Output expired (>48h). Check Modal dashboard."}
    except Exception as e:
        return {"status": "error", "call_id": req.call_id,
                "exception": f"{type(e).__name__}: {e}"}


# ─── /admin/migration_safety_check (#11 / M33 2026-04-21) ────────────────────

# Ordinal mapping for signal labels. Higher = more bullish.
_SIGNAL_ORDINAL = {
    "STRONG_BUY":  2,
    "BUY":         1,
    "HOLD":        0,
    "NO_SIGNAL":   0,
    "SELL":       -1,
    "STRONG_SELL": -2,
}


class MigrationSafetyCheckReq(BaseModel):
    """3-layer validation for signal-migration safety (M33).

    Queries predictions.forecast_data JSON over a recent window, compares
    two paths (legacy vs new) across:
      L1 label set parity         — are the distinct value sets compatible?
      L2 behavioral replay parity — per-row label mismatch rate
      L3 distributional parity    — KS-test on ordinal-encoded signals
                                    (+ optional numeric-field paths for
                                    continuous-value comparison, e.g.
                                    ensemble_v2.avg_rank vs legacy_conf)
    """
    legacy_json_path: str = Field(
        ..., description="Dotted path in predictions.forecast_data for legacy signal, "
                         "e.g. 'legacy_signal' or 'signal'.")
    new_json_path: str = Field(
        ..., description="Dotted path for new signal, e.g. 'ensemble_v2.signal'.")
    window_days: int = Field(default=30, ge=7, le=365)
    end_date: Optional[str] = Field(
        default=None, description="Window end (YYYY-MM-DD, inclusive). Default today TW.")
    ks_alpha: float = Field(default=0.05, ge=0.001, le=0.5,
                             description="KS-test significance level.")
    mismatch_threshold: float = Field(
        default=0.10, ge=0.0, le=1.0,
        description="Layer 2 mismatch rate above this = FAIL (default 10%).")
    legacy_numeric_path: Optional[str] = Field(
        default=None, description="Optional continuous-value path for legacy, "
                                   "e.g. 'legacy_confidence'.")
    new_numeric_path: Optional[str] = Field(
        default=None, description="Optional continuous-value path for new, "
                                   "e.g. 'ensemble_v2.avg_rank'.")
    note: Optional[str] = Field(default=None, max_length=200)


def _get_json_path(obj: Any, path: str) -> Any:
    """Traverse dotted path. Returns None on missing/None at any level."""
    cur = obj
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
        if cur is None:
            return None
    return cur


def _tw_today() -> str:
    return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")


@router.post("/migration_safety_check")
def migration_safety_check(req: MigrationSafetyCheckReq = Body(default=None)):
    """Run 3-layer parity validation on predictions.forecast_data JSON.

    Returns structured verdict with per-layer PASS/WARN/FAIL + metrics +
    sample mismatches for manual review. Never 500s — monitoring endpoint.

    Recommended harness before ANY signal-source migration landing:
      1. Pre-migration: smoke run with legacy vs legacy (should all PASS)
      2. Post-migration: smoke run with legacy vs new (flags distributional shift)
    """
    if req is None:
        raise HTTPException(400, "Request body required.")

    try:
        from services.d1_client import query as d1_query
    except ImportError as e:
        raise HTTPException(500, f"d1_client import failed: {e}")

    end_date = req.end_date or _tw_today()
    start_date = (datetime.fromisoformat(end_date) - timedelta(days=req.window_days)).strftime("%Y-%m-%d")

    logger.info(
        f"[admin/migration_safety] window={start_date}~{end_date} "
        f"legacy='{req.legacy_json_path}' new='{req.new_json_path}' "
        f"note={req.note!r}"
    )

    # ── Fetch: predictions.model_name='ensemble' only (forecast_data lives there) ─
    rows = d1_query(
        "SELECT stock_id, generated_at, prediction_date, forecast_data FROM predictions "
        "WHERE model_name='ensemble' "
        "AND prediction_date >= ? "
        "AND prediction_date <= ? "
        "ORDER BY generated_at DESC LIMIT 50000",
        [start_date, end_date],
    )
    if not rows:
        return {
            "status": "insufficient_data",
            "reason": f"No predictions rows in {start_date}~{end_date}",
            "window": {"start": start_date, "end": end_date},
            "row_count": 0,
        }

    # Parse forecast_data + extract paths
    legacy_labels: list[str] = []
    new_labels:    list[str] = []
    legacy_nums:   list[float] = []
    new_nums:      list[float] = []
    parse_errors = 0

    for r in rows:
        fd_raw = r.get("forecast_data") or ""
        if not fd_raw:
            continue
        try:
            fd = _json.loads(fd_raw)
        except (ValueError, TypeError):
            parse_errors += 1
            continue

        leg = _get_json_path(fd, req.legacy_json_path)
        new = _get_json_path(fd, req.new_json_path)
        if leg is not None and new is not None:
            legacy_labels.append(str(leg))
            new_labels.append(str(new))

        if req.legacy_numeric_path and req.new_numeric_path:
            leg_n = _get_json_path(fd, req.legacy_numeric_path)
            new_n = _get_json_path(fd, req.new_numeric_path)
            if isinstance(leg_n, (int, float)) and isinstance(new_n, (int, float)):
                legacy_nums.append(float(leg_n))
                new_nums.append(float(new_n))

    n_pairs = len(legacy_labels)
    if n_pairs < 30:
        return {
            "status": "insufficient_data",
            "reason": f"Only {n_pairs} label pairs extracted (need >=30 for meaningful stats)",
            "window": {"start": start_date, "end": end_date},
            "row_count": len(rows),
            "parse_errors": parse_errors,
        }

    # ── Layer 1: Label set parity ───────────────────────────────────────────
    legacy_set = set(legacy_labels)
    new_set    = set(new_labels)
    only_legacy = sorted(legacy_set - new_set)
    only_new    = sorted(new_set - legacy_set)
    label_parity_ok = not (only_legacy or only_new)
    layer1 = {
        "verdict":     "PASS" if label_parity_ok else "WARN",
        "legacy_set":  sorted(legacy_set),
        "new_set":     sorted(new_set),
        "only_in_legacy": only_legacy,
        "only_in_new":    only_new,
    }

    # ── Layer 2: Behavioral replay (mismatch rate) ──────────────────────────
    mismatches = sum(1 for a, b in zip(legacy_labels, new_labels) if a != b)
    mismatch_rate = mismatches / n_pairs
    from collections import Counter
    layer2_transitions = Counter(
        f"{a}→{b}" for a, b in zip(legacy_labels, new_labels) if a != b
    )
    layer2_top = layer2_transitions.most_common(10)
    layer2 = {
        "verdict":        "PASS" if mismatch_rate <= req.mismatch_threshold else "FAIL",
        "n_pairs":        n_pairs,
        "n_mismatches":   mismatches,
        "mismatch_rate":  round(mismatch_rate, 4),
        "threshold":      req.mismatch_threshold,
        "top_transitions": [{"from_to": k, "count": v} for k, v in layer2_top],
    }

    # ── Layer 3: Distributional parity (KS-test on ordinal labels) ──────────
    try:
        import numpy as np
        from scipy import stats
    except ImportError as e:
        return {
            "status": "partial",
            "window": {"start": start_date, "end": end_date},
            "row_count": len(rows),
            "n_pairs": n_pairs,
            "layer1_label_parity": layer1,
            "layer2_behavioral_replay": layer2,
            "layer3_distributional_parity": {
                "verdict": "SKIP",
                "reason": f"scipy/numpy import failed: {e}",
            },
        }

    leg_ord = np.array([_SIGNAL_ORDINAL.get(s, 0) for s in legacy_labels], dtype=float)
    new_ord = np.array([_SIGNAL_ORDINAL.get(s, 0) for s in new_labels],    dtype=float)
    ks_ord = stats.ks_2samp(leg_ord, new_ord)

    # Optional numeric-field KS (catches CLT-compression-class bugs where
    # label distributions look identical but raw values diverge)
    num_ks = None
    if legacy_nums and new_nums and len(legacy_nums) >= 30 and len(new_nums) >= 30:
        leg_arr = np.array(legacy_nums, dtype=float)
        new_arr = np.array(new_nums, dtype=float)
        ks_num  = stats.ks_2samp(leg_arr, new_arr)
        num_ks = {
            "ks_statistic":  round(float(ks_num.statistic), 4),
            "p_value":       round(float(ks_num.pvalue), 4),
            "alpha":         req.ks_alpha,
            "legacy_mean":   round(float(leg_arr.mean()), 4),
            "legacy_std":    round(float(leg_arr.std()), 4),
            "legacy_range":  [round(float(leg_arr.min()), 4), round(float(leg_arr.max()), 4)],
            "new_mean":      round(float(new_arr.mean()), 4),
            "new_std":       round(float(new_arr.std()), 4),
            "new_range":     [round(float(new_arr.min()), 4), round(float(new_arr.max()), 4)],
            "n_legacy":      len(legacy_nums),
            "n_new":         len(new_nums),
            # Same-distribution null hypothesis: fail to reject if p > alpha
            "distributions_differ": bool(ks_num.pvalue < req.ks_alpha),
        }

    # Layer 3 verdict: FAIL if either ordinal or numeric distributions differ
    ord_differ = bool(ks_ord.pvalue < req.ks_alpha)
    num_differ = bool(num_ks and num_ks["distributions_differ"])
    if ord_differ or num_differ:
        l3_verdict = "FAIL"
    elif num_ks is None and ord_differ == False:
        l3_verdict = "PASS_ORDINAL_ONLY"  # ordinal OK but no numeric check available
    else:
        l3_verdict = "PASS"

    layer3 = {
        "verdict":  l3_verdict,
        "ordinal": {
            "ks_statistic":       round(float(ks_ord.statistic), 4),
            "p_value":            round(float(ks_ord.pvalue), 4),
            "alpha":              req.ks_alpha,
            "distributions_differ": ord_differ,
            "signal_ordinal_map": _SIGNAL_ORDINAL,
        },
        "numeric":  num_ks,
        "hint": ("Numeric KS-test not run — pass legacy_numeric_path + new_numeric_path "
                 "to catch CLT-compression bugs (label distributions can agree while raw "
                 "rank/score distributions diverge wildly, which is the Migration C 4/17 class)."
                 if num_ks is None else None),
    }

    overall = ("FAIL" if "FAIL" in (layer1["verdict"], layer2["verdict"], layer3["verdict"])
               else "WARN" if "WARN" in (layer1["verdict"], layer2["verdict"], layer3["verdict"])
               else "PASS")

    return {
        "status": "ok",
        "verdict": overall,
        "window": {"start": start_date, "end": end_date, "days": req.window_days},
        "row_count":     len(rows),
        "n_pairs":       n_pairs,
        "parse_errors":  parse_errors,
        "paths": {
            "legacy_label":   req.legacy_json_path,
            "new_label":      req.new_json_path,
            "legacy_numeric": req.legacy_numeric_path,
            "new_numeric":    req.new_numeric_path,
        },
        "layer1_label_parity":          layer1,
        "layer2_behavioral_replay":     layer2,
        "layer3_distributional_parity": layer3,
        "note": req.note,
    }
