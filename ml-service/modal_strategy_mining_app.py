"""Least-privilege Modal owner for monthly Pymoo research mining."""
from __future__ import annotations

import importlib
import os
from contextlib import contextmanager
from pathlib import Path

import modal


SERVICE_DIR = Path(__file__).resolve().parent
REPO_ROOT = SERVICE_DIR.parent
TOOLS_DIR = REPO_ROOT / "tools"
APP_DIR = SERVICE_DIR / "app"
CONTROLLER_SERVICES_DIR = REPO_ROOT / "ml-controller" / "services"
FEATURE_REGISTRY_DIR = REPO_ROOT / "data" / "feature_registry"
FINLAB_SOURCE_CONTRACT = REPO_ROOT / "data" / "finlab_source_contract.json"
STRATEGY_MINING_JOB = REPO_ROOT / "ml-controller" / "strategy_mining_job_main.py"
SIMILARITY_PAIRS = (
    REPO_ROOT
    / "output"
    / "feature_universe_triage"
    / "formal137_pairwise_similarity_long_20260617.csv"
)
REQUIREMENTS = SERVICE_DIR / "requirements.txt"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgomp1", "ocl-icd-libopencl1")
    .pip_install_from_requirements(str(REQUIREMENTS))
    .add_local_dir(str(TOOLS_DIR), remote_path="/root/tools")
    .add_local_dir(str(APP_DIR), remote_path="/root/app")
    .add_local_dir(str(CONTROLLER_SERVICES_DIR), remote_path="/root/services")
    .add_local_dir(str(FEATURE_REGISTRY_DIR), remote_path="/root/data/feature_registry")
    .add_local_file(str(FINLAB_SOURCE_CONTRACT), remote_path="/root/data/finlab_source_contract.json")
    .add_local_file(str(STRATEGY_MINING_JOB), remote_path="/root/strategy_mining_job_main.py")
    .add_local_file(
        str(SIMILARITY_PAIRS),
        remote_path="/root/output/feature_universe_triage/formal137_pairwise_similarity_long_20260617.csv",
    )
)

app = modal.App(name="stockvision-strategy-mining", image=image)
gcs_secret = modal.Secret.from_name("gcs-credentials")
finlab_secret = modal.Secret.from_name("stockvision-finlab")
strategy_mining_secret = modal.Secret.from_name("stockvision-strategy-mining")


@contextmanager
def patched_env(updates: dict[str, str]):
    previous = {key: os.environ.get(key) for key in updates}
    try:
        for key, value in updates.items():
            os.environ[key] = value
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


@app.function(
    secrets=[gcs_secret, finlab_secret, strategy_mining_secret],
    cpu=4,
    memory=16384,
    timeout=14400,
    scaledown_window=60,
    max_containers=1,
)
def strategy_mining_research(payload: dict) -> dict:
    """Execute research-only Pymoo with a dedicated Worker/D1 gateway token."""
    payload = payload or {}
    env_updates = {
        "GCS_BUCKET_NAME": str(payload.get("gcs_bucket_name") or "stockvision-models"),
        "STRATEGY_MINING_BACKEND": "modal",
        "STRATEGY_MINING_D1_WORKER_ONLY": "1",
        "STRATEGY_MINING_RUN_DATE": str(payload.get("run_date") or ""),
        "STRATEGY_MINING_RUN_ID": str(payload.get("run_id") or ""),
        "STRATEGY_MINING_CADENCE": str(payload.get("cadence") or "monthly"),
        "STRATEGY_MINING_PERSIST": "1" if payload.get("persist", True) else "0",
        "STRATEGY_MINING_TRIGGER_SOURCE": str(payload.get("trigger_source") or "modal_controller"),
    }
    optional_env = {
        "STRATEGY_MINING_OUTPUT_DIR": payload.get("output_dir"),
        "STRATEGY_MINING_FINLAB_CONFIRM_TOP_N": payload.get("finlab_confirm_top_n"),
        "STRATEGY_MINING_PYMOO_POPULATION": payload.get("pymoo_population"),
        "STRATEGY_MINING_PYMOO_GENERATIONS": payload.get("pymoo_generations"),
    }
    for key, value in optional_env.items():
        if value is not None and str(value).strip():
            env_updates[key] = str(value)

    with patched_env(env_updates):
        job = importlib.import_module("strategy_mining_job_main")
        exit_code = int(job.main())
    status = "completed" if exit_code == 0 else "error"
    return {
        "status": status,
        "exit_code": exit_code,
        "backend": "modal",
        "run_id": env_updates["STRATEGY_MINING_RUN_ID"],
    }
