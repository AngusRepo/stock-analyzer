"""StockVision Modal ML service.

Modal owns heavy ML compute functions such as prediction, retraining, feature
selection, walk-forward validation, and health/audit endpoints. Cloud Run
controllers call Modal functions through `.map()`, `.remote()`, or `.spawn()`.

Common local commands:
  cd ml-service && python -m modal deploy modal_app.py
  cd ml-service && python -m modal serve modal_app.py
"""
import math
import os
import modal
from datetime import datetime, timezone
from pathlib import Path
from app.runtime_env import get_gcs_bucket_name, setup_modal_container_env
from app.callback_security import (
    normalize_callback_token,
    sanitize_callback_error,
    sanitize_callback_url,
)

# Local code mounted into the Modal image during deploy.
_LOCAL_APP_DIR     = Path(__file__).parent / "app"
_LOCAL_SCRIPTS_DIR = Path(__file__).parent / "scripts"  # optuna routes import scripts/optuna_*.py
_LOCAL_REQ         = Path(__file__).parent / "requirements.txt"
_LOCAL_SOURCE_ROOT = Path(__file__).resolve().parent


def _resolve_local_repo_root() -> Path:
    env_root = os.environ.get("STOCKVISION_MODAL_REPO_ROOT", "").strip()
    candidates = [
        Path(env_root) if env_root else None,
        _LOCAL_SOURCE_ROOT if (_LOCAL_SOURCE_ROOT / "tools").exists() else _LOCAL_SOURCE_ROOT.parent,
        Path.cwd(),
        Path("/app"),
    ]
    for candidate in candidates:
        if candidate is None:
            continue
        if (candidate / "tools").exists() and (candidate / "data" / "feature_registry").exists():
            return candidate
    return _LOCAL_SOURCE_ROOT if (_LOCAL_SOURCE_ROOT / "tools").exists() else _LOCAL_SOURCE_ROOT.parent


_LOCAL_REPO_ROOT   = _resolve_local_repo_root()
_LOCAL_TOOLS_DIR   = _LOCAL_REPO_ROOT / "tools"
_LOCAL_DATA_FEATURE_REGISTRY_DIR = _LOCAL_REPO_ROOT / "data" / "feature_registry"
_LOCAL_FINLAB_SOURCE_CONTRACT = _LOCAL_REPO_ROOT / "data" / "finlab_source_contract.json"
_LOCAL_STRATEGY_MINING_JOB = next(
    (
        candidate
        for candidate in (
            _LOCAL_REPO_ROOT / "strategy_mining_job_main.py",
            _LOCAL_REPO_ROOT / "ml-controller" / "strategy_mining_job_main.py",
        )
        if candidate.exists()
    ),
    _LOCAL_REPO_ROOT / "ml-controller" / "strategy_mining_job_main.py",
)
_LOCAL_STRATEGY_MINING_ARTIFACT_FILES = [
    _LOCAL_REPO_ROOT / "output" / "feature_universe_triage" / "formal137_pairwise_similarity_long_20260617.csv",
]
_LOCAL_CONTROLLER_SERVICES_DIR = (
    _LOCAL_REPO_ROOT / "services"
    if (_LOCAL_REPO_ROOT / "services").exists()
    else _LOCAL_REPO_ROOT / "ml-controller" / "services"
)


def _controller_callback_token() -> str:
    return normalize_callback_token([
        os.environ.get("ML_CONTROLLER_TOKEN"),
        os.environ.get("INTERNAL_TOKEN"),
        os.environ.get("ML_CONTROLLER_SECRET"),
        os.environ.get("STOCKVISION_AUTH_TOKEN"),
    ])


def _retrain_followup_token() -> str:
    return normalize_callback_token([
        os.environ.get("RETRAIN_CALLBACK_TOKEN"),
        _controller_callback_token(),
    ])

# Modal image built with the v1.x API.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgomp1", "ocl-icd-libopencl1")  # OpenMP + OpenCL ICD loader (NVIDIA driver provides libOpenCL at runtime)
    .pip_install_from_requirements(str(_LOCAL_REQ))
    .env({"PYTHONHASHSEED": "42", "CUBLAS_WORKSPACE_CONFIG": ":4096:8", "TORCH_FLOAT32_MATMUL_PRECISION": "high"})
    .add_local_dir(str(_LOCAL_SCRIPTS_DIR), remote_path="/root/scripts")
    .add_local_dir(str(_LOCAL_TOOLS_DIR), remote_path="/root/tools")
    .add_local_dir(str(_LOCAL_CONTROLLER_SERVICES_DIR), remote_path="/root/services")
    .add_local_dir(str(_LOCAL_DATA_FEATURE_REGISTRY_DIR), remote_path="/root/data/feature_registry")
    .add_local_file(str(_LOCAL_FINLAB_SOURCE_CONTRACT), remote_path="/root/data/finlab_source_contract.json")
    .add_local_file(str(_LOCAL_STRATEGY_MINING_JOB), remote_path="/root/strategy_mining_job_main.py")
    .add_local_file(str(_LOCAL_STRATEGY_MINING_ARTIFACT_FILES[0]), remote_path="/root/output/feature_universe_triage/formal137_pairwise_similarity_long_20260617.csv")
    .add_local_dir(str(_LOCAL_APP_DIR), remote_path="/root/app")  # must be last
)

# The Modal writer is a dedicated service account with bucket-level
# roles/storage.objectAdmin only. Never bind project Editor to this identity.
MODAL_GCS_WRITER_SECRET = os.environ.get(
    "MODAL_GCS_WRITER_SECRET",
    "stockvision-modal-gcs-writer",
).strip()
gcs_secret = modal.Secret.from_name(MODAL_GCS_WRITER_SECRET)
finlab_secret = modal.Secret.from_name("stockvision-finlab")

# stockvision-cf can be created manually with:
#   modal secret create stockvision-cf \
#     CF_API_TOKEN=<cloudflare-api-token> \
#     CF_ACCOUNT_ID=<cloudflare-account-id> \
#     CF_D1_DB_ID=<cloudflare-d1-db-id> \
#     CF_D1_LEARNING_DB_ID=<cloudflare-learning-d1-db-id> \
#     STOCKVISION_AUTH_TOKEN=<stockvision-auth-token> \
#     STOCKVISION_WORKER_URL=<stockvision-worker-url>
# If the secret is missing, keep deploy importable but Optuna routes will fail.
try:
    cf_secret = modal.Secret.from_name("stockvision-cf")
except Exception:
    print("[modal_app] stockvision-cf secret not found, Optuna routes will fail")
    cf_secret = modal.Secret.from_dict({})

try:
    retrain_callback_secret = modal.Secret.from_name("stockvision-retrain-callback")
except Exception:
    print("[modal_app] stockvision-retrain-callback secret not found, legacy retrain callback auth remains active")
    retrain_callback_secret = modal.Secret.from_dict({})

runtime_env_secret = modal.Secret.from_dict({
    key: value
    for key, value in {
        "GCS_BUCKET_NAME": os.environ.get("GCS_BUCKET_NAME", "stockvision-models").strip(),
        "FINLAB_API_KEY": os.environ.get("FINLAB_API_KEY", "").strip(),
        "FINLAB_REFRESH_TOKEN": os.environ.get("FINLAB_REFRESH_TOKEN", "").strip(),
        "FINLAB_SESSION_ID": os.environ.get("FINLAB_SESSION_ID", "").strip(),
        "STOCKVISION_SOURCE_SHA": os.environ.get("STOCKVISION_SOURCE_SHA", "").strip(),
        "STOCKVISION_SOURCE_TREE_SHA": os.environ.get("STOCKVISION_SOURCE_TREE_SHA", "").strip(),
    }.items()
    if value
})

# Modal application definition.
app = modal.App(
    name="stockvision-ml",
    image=image,
    secrets=[gcs_secret, cf_secret, finlab_secret, retrain_callback_secret, runtime_env_secret],
)

# Shared container environment setup.
def _setup_env():
    """Set up Modal container environment."""
    return setup_modal_container_env()


def _get_gcs_bucket_name() -> str | None:
    return get_gcs_bucket_name()


def _load_sequence_records_from_gcs(gcs_prefix: str, batch_count: int) -> list[dict]:
    """Load v2 sequence records for universal sequence-model lifecycle training."""
    import io
    import numpy as np
    from google.cloud import storage
    from app.gcs_batch_io import download_existing_blobs

    bucket_name = _get_gcs_bucket_name()
    if not bucket_name:
        raise RuntimeError("GCS bucket not configured")

    bucket = storage.Client().bucket(bucket_name)
    all_records: list[dict] = []
    keys = [f"{gcs_prefix}/prep/batch_{i}.npz" for i in range(batch_count)]
    for key, raw in download_existing_blobs(bucket, keys, max_workers=4):
        if raw is None:
            continue
        buf = io.BytesIO(raw)
        data = np.load(buf, allow_pickle=True)
        if "sequence_records" in data.files:
            batch_records = data["sequence_records"].tolist()
            for row in batch_records:
                if isinstance(row, dict) and row.get("close") and row.get("dates"):
                    all_records.append(row)
            continue
        if "series_close" in data.files:
            batch_series = data["series_close"].tolist()
            for idx, row in enumerate(batch_series):
                if not row:
                    continue
                all_records.append({
                    "symbol": f"legacy_{key.split('/')[-1]}_{idx}",
                    "market_type": "unknown",
                    "close": [float(v) for v in row],
                    "dates": [],
                })
    return all_records


def _load_oos_rank_payload_from_gcs(path: str) -> dict:
    """Load one split-job OOS rank artifact for final stacker training."""
    import io
    import numpy as np
    from google.cloud import storage

    bucket_name = _get_gcs_bucket_name()
    if not bucket_name:
        raise RuntimeError("GCS bucket not configured")

    bucket = storage.Client().bucket(bucket_name)
    blob = bucket.blob(path)
    if not blob.exists():
        raise FileNotFoundError(f"OOS artifact not found: {path}")

    buf = io.BytesIO()
    blob.download_to_file(buf)
    buf.seek(0)
    data = np.load(buf, allow_pickle=True)
    model_names = [str(name) for name in data["model_names"].tolist()]
    pred_matrix = np.asarray(data["pred_matrix"], dtype=float)
    predictions = {
        name: pred_matrix[idx]
        for idx, name in enumerate(model_names)
    }
    return {
        "group": str(data["group"].tolist()),
        "version": str(data["version"].tolist()),
        "predictions": predictions,
        "y_test": np.asarray(data["y_test"], dtype=float),
        "dates_test": np.asarray(data["dates_test"]) if "dates_test" in data.files else np.asarray([], dtype=object),
        "feature_names": (
            np.asarray(data["feature_names"], dtype=object)
            if "feature_names" in data.files
            else np.asarray([], dtype=object)
        ),
        "path": path,
    }


def _truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "on", "enabled"}


def _tree_model_split_enabled(payload: dict) -> bool:
    return _truthy(payload.get("tree_model_split")) or _truthy(os.environ.get("UNIVERSAL_TREE_MODEL_SPLIT"))


def _save_oos_rank_payload_to_gcs(path: str, payload: dict) -> dict:
    """Persist a combined OOS rank payload with the same npz contract."""
    import io
    import numpy as np
    from google.cloud import storage

    bucket_name = _get_gcs_bucket_name()
    if not bucket_name:
        raise RuntimeError("GCS bucket not configured")

    model_names = list(payload.get("model_order") or payload.get("predictions", {}).keys())
    pred_matrix = np.vstack([
        np.clip(np.asarray(payload["predictions"][name], dtype=float).reshape(-1), 0.0, 1.0)
        for name in model_names
    ])
    buf = io.BytesIO()
    np.savez_compressed(
        buf,
        group=np.array(payload["group"]),
        version=np.array(payload["version"]),
        model_names=np.asarray(model_names, dtype=object),
        pred_matrix=pred_matrix,
        y_test=np.asarray(payload["y_test"], dtype=float).reshape(-1),
        dates_test=np.asarray(payload.get("dates_test", [])),
        feature_names=np.asarray(payload.get("feature_names", []), dtype=object),
    )
    buf.seek(0)
    storage.Client().bucket(bucket_name).blob(path).upload_from_file(
        buf,
        content_type="application/octet-stream",
    )
    return {
        "path": path,
        "group": str(payload["group"]),
        "version": str(payload["version"]),
        "models": model_names,
        "samples": int(len(payload["y_test"])),
    }


def _combine_tree_child_oos_artifacts(child_results: dict[str, dict], payload: dict) -> tuple[dict | None, str | None]:
    from app.training_finalizer import build_oos_artifact_path, combine_oos_rank_payloads

    try:
        artifact_paths = []
        for partial in (child_results or {}).values():
            if not isinstance(partial, dict):
                continue
            artifact = partial.get("oos_artifact")
            if isinstance(artifact, dict) and artifact.get("path"):
                artifact_paths.append(artifact["path"])
        if not artifact_paths:
            return None, "missing_tree_child_oos_artifacts"
        payloads = [_load_oos_rank_payload_from_gcs(path) for path in artifact_paths]
        version = (
            payload.get("output_model_version")
            or next((p.get("candidate_version") for p in (child_results or {}).values() if p.get("candidate_version")), None)
        )
        if not version:
            return None, "missing_tree_candidate_version"
        gcs_prefix = payload.get("gcs_prefix") or "universal"
        combined = combine_oos_rank_payloads(payloads, group="tree", version=str(version))
        path = build_oos_artifact_path(gcs_prefix, str(version), "tree")
        return _save_oos_rank_payload_to_gcs(path, combined), None
    except Exception as exc:
        return None, str(exc)


# Modal functions called by Cloud Run Controller through `.map()` / `.remote()`.

# Flow B retrain orchestrator: Cloud Run dispatches the Modal chain for prep,
# feature selection, training, and SHAP audit.

@app.function(
    cpu=4,
    memory=8192,
    timeout=18000,              # 300 min: selection, train, SHAP, and regime-history buffer
    scaledown_window=60,
    max_containers=1,
)
def retrain_orchestrator(payload: dict) -> dict:
    """Flow B: prep, optional feature selection, train, then SHAP audit.

    Cloud Run dispatches one Modal orchestration chain.
    Cloud Run does not wait for training completion; followup callback closes the loop.

    payload:
        batch_count: int - number of prep batches.
        is_monthly: bool - whether to run monthly feature selection.
        selection_params: dict - max_rounds, alpha, required_power, icir_weight.
    """
    _setup_env()
    import time
    t0 = time.time()

    batch_count = payload.get("batch_count", 5)
    is_monthly = payload.get("is_monthly", False)
    followup_webhook_url = payload.get("followup_webhook_url")
    gcs_prefix = payload.get("gcs_prefix", "universal")
    data_slice = payload.get("data_slice") if isinstance(payload.get("data_slice"), dict) else {}
    sequence_gcs_prefix = (
        payload.get("sequence_gcs_prefix")
        or data_slice.get("sequence_gcs_prefix")
        or gcs_prefix
    )
    sequence_batch_count = int(
        payload.get("sequence_batch_count")
        or data_slice.get("sequence_batch_count")
        or payload.get("batch_count")
        or 5
    )
    window_id = payload.get("window_id")
    run_id = payload.get("run_id")
    lock_key = payload.get("lock_key")
    run_date = payload.get("run_date")
    artifact_lifecycle_only = bool(payload.get("artifact_lifecycle_only"))
    from app.training_policy import (
        FeatureSelectionPolicy,
        PREDICT_ONLY_MODEL_NOTES,
        UniversalTrainingPolicy,
        build_feature_selection_run_kwargs,
        build_group_train_payload,
        dedupe_train_groups_for_artifact_lifecycle,
        models_for_training_group,
        training_group_feature_policy,
    )
    training_policy = UniversalTrainingPolicy.from_env()
    selection_params = FeatureSelectionPolicy.from_env().to_selection_params(payload.get("selection_params"))

    # P0-3: Defensive GCS batch count validation.
    # Cloud Run may pass stale/wrong batch_count (e.g. "1" when actual prep wrote 5).
    # Check actual .npz files in GCS and use the larger value.
    try:
        from google.cloud import storage as _gcs_chk
        _bucket_name = _get_gcs_bucket_name()
        if not _bucket_name:
            raise RuntimeError("GCS bucket not configured")
        _bucket_chk = _gcs_chk.Client().bucket(_bucket_name)
        actual_batch_count = sum(
            1 for i in range(20)  # cap at 20 to avoid excessive API calls
            if _bucket_chk.blob(f"{gcs_prefix}/prep/batch_{i}.npz").exists()
        )
        if actual_batch_count > 0 and actual_batch_count != batch_count:
            print(
                f"[Orchestrator] P0-3 batch_count mismatch: "
                f"payload={batch_count} vs GCS={actual_batch_count} -> using max"
            )
            batch_count = max(batch_count, actual_batch_count)
        else:
            print(f"[Orchestrator] GCS batch count verified: {actual_batch_count} batches")
    except Exception as _e:
        print(f"[Orchestrator] GCS batch count check failed (using payload value {batch_count}): {_e}")

    if (
        not payload.get("sequence_batch_count")
        and not data_slice.get("sequence_batch_count")
        and str(sequence_gcs_prefix).strip().rstrip("/") == str(gcs_prefix).strip().rstrip("/")
    ):
        sequence_batch_count = int(batch_count)

    result = {
        "stages": {
            "dataset_snapshot": payload.get("dataset_snapshot"),
        }
    }
    partial_results: dict[str, dict] = {}
    monthly_training_contract = payload.get("monthly_training_contract")
    artifact_lifecycle_targets = [
        str(target)
        for target in (payload.get("artifact_lifecycle_targets") or [])
        if str(target or "").strip()
    ]
    if is_monthly:
        from services.active8_monthly_training_contract import (
            MONTHLY_ARTIFACT_LIFECYCLE_TARGETS,
            MONTHLY_TRAIN_GROUPS,
            validate_monthly_training_contract,
        )
        from services.active8_monthly_model_profiles import monthly_model_payload

        verified_monthly_contract = validate_monthly_training_contract(monthly_training_contract)
        if str(verified_monthly_contract.get("run_date") or "") != str(run_date or ""):
            raise RuntimeError("monthly_training_contract_run_date_mismatch")
        payload["train_model_groups"] = list(MONTHLY_TRAIN_GROUPS)
        artifact_lifecycle_targets = list(MONTHLY_ARTIFACT_LIFECYCLE_TARGETS)
        payload["artifact_lifecycle_targets"] = artifact_lifecycle_targets
        result["stages"]["monthly_training_contract"] = {
            "status": "verified",
            "checksum": verified_monthly_contract["contract_checksum"],
            "models": verified_monthly_contract["models"],
            "configuration_selection": verified_monthly_contract["configuration_selection"],
        }
    artifact_lifecycle_contracts = payload.get("artifact_lifecycle_contracts") or {}
    if artifact_lifecycle_targets:
        result["stages"]["artifact_lifecycle"] = {
            "status": "planned",
            "targets": artifact_lifecycle_targets,
            "contracts": artifact_lifecycle_contracts,
            "note": (
                "Formal artifact targets are tracked separately from train_model_groups; "
                "the retrain orchestrator runs artifact-specific trainers instead of routing them into tree retrain."
            ),
        }

    # Stage 1: Feature Selection (monthly only).
    if is_monthly and not artifact_lifecycle_only:
        print(f"[Orchestrator] Monthly -> running feature selection (max {selection_params['max_rounds']} rounds)")
        try:
            from app.feature_selection import run_feature_selection_pipeline

            fs_result = run_feature_selection_pipeline(**build_feature_selection_run_kwargs(selection_params))
            fs_pool = fs_result.get("feature_pool", {}) if isinstance(fs_result.get("feature_pool"), dict) else {}
            fs_target_perm = fs_result.get("target_permutation", {}) if isinstance(fs_result.get("target_permutation"), dict) else {}
            fs_k_sweep = fs_result.get("k_sweep", {}) if isinstance(fs_result.get("k_sweep"), dict) else {}
            result["stages"]["feature_selection"] = {
                "status": "ok" if "error" not in fs_result else "error",
                "active_count": len(fs_pool.get("active", [])),
                "reserve_count": len(fs_pool.get("reserve", [])),
                "tree_active_count": len(fs_pool.get("tree_active", []) or fs_pool.get("active", [])),
                "target_permutation_n": fs_target_perm.get("n_permutations"),
                "k_sweep_trials": fs_k_sweep.get("actual_trials") or fs_k_sweep.get("n_trials"),
                "objective_cache_hits": fs_k_sweep.get("objective_cache_hits"),
                "algorithm_profile": fs_result.get("algorithm_profile"),
                "algorithm_evidence": fs_result.get("algorithm_evidence"),
                "stage_checkpoints": fs_result.get("stage_checkpoints"),
                "elapsed_s": fs_result.get("elapsed_s", 0),
            }
            if "error" in fs_result:
                print(f"[Orchestrator] Feature selection error: {fs_result['error']}")
        except Exception as e:
            print(f"[Orchestrator] Feature selection failed: {e}")
            result["stages"]["feature_selection"] = {"status": "error", "error": str(e)}
    else:
        skip_reason = "artifact_lifecycle_only" if artifact_lifecycle_only else "non_monthly"
        print(f"[Orchestrator] Skip feature selection ({skip_reason})")
        result["stages"]["feature_selection"] = {"status": "skipped", "reason": skip_reason}

    # Stage 2: Train production groups; retired FT endpoints remain fail-closed.
    from app.training_finalizer import (
        build_suppressed_legacy_challenger_registrations,
        build_retrain_followup_payload,
        expected_oos_artifact_groups,
        merge_oos_rank_payloads,
        missing_expected_oos_groups,
        reduce_training_group_results,
        summarize_training_stage_status,
    )

    raw_requested_train_groups = training_policy.requested_groups(payload)
    requested_train_groups, suppressed_train_groups = dedupe_train_groups_for_artifact_lifecycle(
        raw_requested_train_groups,
        artifact_lifecycle_targets,
        allow_duplicate=bool(payload.get("allow_duplicate_artifact_lifecycle_train_groups")),
    )
    if suppressed_train_groups:
        print(f"[Orchestrator] Suppressed duplicate train groups: {suppressed_train_groups}")
    print(f"[Orchestrator] Training from {batch_count} GCS batches (groups={requested_train_groups})...")
    sequence_records = list(payload.get("sequence_records") or [])
    sequence_required = (
        any(g in requested_train_groups for g in ("dlinear", "patchtst"))
        or "PatchTST" in set(artifact_lifecycle_targets)
        or "iTransformer" in set(artifact_lifecycle_targets)
    )
    if not sequence_records and sequence_required:
        try:
            sequence_records = _load_sequence_records_from_gcs(sequence_gcs_prefix, sequence_batch_count)
            print(
                f"[Orchestrator] Loaded {len(sequence_records)} sequence records from "
                f"GCS prefix={sequence_gcs_prefix} batches={sequence_batch_count}"
            )
        except Exception as e:
            print(f"[Orchestrator] sequence records load failed: {e}")
            sequence_records = []
    sequence_report = {
        "input_series": len(sequence_records),
        "valid_series": sum(
            1
            for row in sequence_records
            if isinstance(row, dict)
            and len(row.get("close") or []) >= training_policy.sequence_min_length(payload)
            and len(row.get("dates") or []) == len(row.get("close") or [])
        ),
        "min_len": training_policy.sequence_min_length(payload),
        "contract": "sequence_records_v3",
        "source_gcs_prefix": sequence_gcs_prefix,
        "batch_count": sequence_batch_count,
    }
    if any(g in requested_train_groups for g in ("dlinear", "patchtst")):
        print(f"[Orchestrator] sequence series validation: {sequence_report}")
    candidate_version = payload.get("candidate_version") or datetime.now(timezone.utc).strftime("v%Y%m%d%H%M%S")
    base_train_payload = training_policy.to_base_train_payload(
        {
            **payload,
            "batch_count": batch_count,
            "label_horizon_days": selection_params.get("label_horizon_days"),
        },
        candidate_version=candidate_version,
    )
    if is_monthly:
        base_train_payload.update(monthly_model_payload("LightGBM"))

    def _train_group_seq_len(group: str) -> int:
        key = f"{group}_seq_len"
        if payload.get(key):
            return int(payload[key])
        if payload.get("sequence_seq_len"):
            return int(payload["sequence_seq_len"])
        if group == "itransformer":
            return 1024
        return 512

    train_group_specs = {
        "tree": {
            "spawn": lambda p: (
                train_tree_models_split_parent.spawn(p)
                if _tree_model_split_enabled(p)
                else train_tree_models.spawn(p)
            ),
            "payload": lambda: build_group_train_payload(base_train_payload, "tree"),
            "mergeable": training_group_feature_policy("tree").mergeable_oos,
            "models": models_for_training_group("tree"),
            "note": training_group_feature_policy("tree").note,
        },
        "dlinear": {
            "spawn": lambda p: train_dlinear_universal.spawn(p),
            "payload": lambda: {
                **(monthly_model_payload("DLinear") if is_monthly else {}),
                "candidate_type": payload.get("candidate_type"),
                "monthly_training_contract": monthly_training_contract,
                "dataset_snapshot": payload.get("dataset_snapshot"),
                "run_date": run_date,
                "sequence_records": sequence_records,
                "device": payload.get("sequence_device") or "cuda",
                "version": candidate_version,
                "sequence_gcs_prefix": sequence_gcs_prefix,
                "sequence_batch_count": sequence_batch_count,
                "seq_len": _train_group_seq_len("dlinear"),
            },
            "mergeable": training_group_feature_policy("dlinear").mergeable_oos,
            "models": models_for_training_group("dlinear"),
            "note": training_group_feature_policy("dlinear").note,
        },
        "patchtst": {
            "spawn": lambda p: train_patchtst_universal.spawn(p),
            "payload": lambda: {
                **(monthly_model_payload("PatchTST") if is_monthly else {}),
                "candidate_type": payload.get("candidate_type"),
                "monthly_training_contract": monthly_training_contract,
                "dataset_snapshot": payload.get("dataset_snapshot"),
                "run_date": run_date,
                "sequence_records": sequence_records,
                "device": payload.get("sequence_device") or "cuda",
                "version": candidate_version,
                "sequence_gcs_prefix": sequence_gcs_prefix,
                "sequence_batch_count": sequence_batch_count,
                "seq_len": _train_group_seq_len("patchtst"),
            },
            "mergeable": training_group_feature_policy("patchtst").mergeable_oos,
            "models": models_for_training_group("patchtst"),
            "note": training_group_feature_policy("patchtst").note,
        },
    }
    predict_only_models = dict(PREDICT_ONLY_MODEL_NOTES)
    try:
        # Spawn requested training groups in parallel
        handles: dict[str, object] = {}
        coverage: dict[str, dict] = {}
        aux_train = {}
        for group in requested_train_groups:
            spec = train_group_specs.get(group)
            if spec is None:
                coverage[group] = {"status": "unknown_group"}
                print(f"[Orchestrator] Unknown train group skipped: {group}")
                continue
            group_payload = spec["payload"]()
            if group in {"dlinear", "patchtst"} and not group_payload.get("sequence_records"):
                coverage[group] = {
                    "status": "skipped",
                    "models": spec["models"],
                    "reason": "missing_sequence_records_artifact",
                    "sequence_report": sequence_report,
                    "note": spec["note"],
                }
                print(f"[Orchestrator] {group} skipped: missing sequence records artifact")
                continue
            handles[group] = spec["spawn"](group_payload)
            coverage[group] = {
                "status": "running",
                "models": spec["models"],
                "mergeable": spec["mergeable"],
                "note": spec["note"],
            }
            print(f"[Orchestrator] Spawned group={group} models={spec['models']}")

        tree_result = {}
        aux_train = {}
        if handles.get("tree") is not None:
            tree_result = handles["tree"].get()
            partial_results["tree"] = tree_result
            coverage["tree"] = {
                **coverage.get("tree", {}),
                "status": "error" if tree_result.get("error") else "ok",
                "elapsed_s": tree_result.get("elapsed_s"),
                "error": tree_result.get("error"),
                "gcs_io": tree_result.get("gcs_io"),
                "child_errors": tree_result.get("child_errors") or [],
            }
        for group in ("dlinear", "patchtst"):
            if handles.get(group) is not None:
                aux_train[group] = handles[group].get()
                partial_results[group] = aux_train[group]
                coverage[group] = {
                    **coverage.get(group, {}),
                    "status": "error" if aux_train[group].get("error") else "ok",
                    "elapsed_s": aux_train[group].get("elapsed_s"),
                    "error": aux_train[group].get("error"),
                }
                if aux_train[group].get("error"):
                    print(f"[Orchestrator] Partial train error ({group}): {aux_train[group]['error']}")

        # Merge results + IC tracking from spawned groups. Kept side-effect free
        # so a detached finalizer can reuse the same contract later.
        reduced_train = reduce_training_group_results(tree_result, aux_train)
        merged_results = reduced_train["merged_results"]
        merged_ic = reduced_train["merged_ic"]
        circuit_breaker = reduced_train["circuit_breaker"]
        total_samples = reduced_train["total_samples"]
        for partial_error in reduced_train["partial_errors"]:
            print(
                f"[Orchestrator] Partial train error ({partial_error.get('group')}): "
                f"{partial_error.get('error')}"
        )

        challenger_registrations = {}
        suppressed_legacy_challenger_registrations = build_suppressed_legacy_challenger_registrations(
            register_challengers=payload.get("register_challengers") is True,
            candidate_models=reduced_train["candidate_models"],
            existing_registrations=tree_result.get("challenger_registrations") or {},
            candidate_version=candidate_version,
        )

        artifact_registrations = dict(tree_result.get("artifact_registrations") or {})
        for model_name, group_name in (("DLinear", "dlinear"), ("PatchTST", "patchtst")):
            aux_result = aux_train.get(group_name) or {}
            aux_saved = aux_result.get("saved") or {}
            aux_metadata = aux_saved.get("metadata") or aux_result.get("metadata") or {}
            if aux_saved and aux_metadata:
                artifact_registrations[model_name] = {
                    "status": "registered",
                    "version": aux_result.get("version") or candidate_version,
                    "gcs_path": aux_saved.get("weights_path") or aux_metadata.get("artifact_path"),
                    "metadata_path": aux_saved.get("metadata_path") or aux_metadata.get("metadata_path"),
                    "checksum": aux_saved.get("checksum") or aux_metadata.get("checksum"),
                    "feature_policy_version": aux_metadata.get("feature_policy_schema_version"),
                    "feature_policy": aux_metadata.get("feature_policy"),
                    "model_cpcv": aux_metadata.get("model_cpcv"),
                    "oos_ic": (aux_result.get("ic_tracking", {}).get(model_name) or {}).get("oos_ic"),
                    "metadata": aux_metadata,
                }

        result["stages"]["train"] = {
            "status": summarize_training_stage_status(coverage),
            "requested_groups": requested_train_groups,
            "raw_requested_groups": raw_requested_train_groups,
            "suppressed_train_groups": suppressed_train_groups,
            "candidate_version": candidate_version,
            "group_coverage": coverage,
            "predict_only_models": predict_only_models,
            "sequence_report": sequence_report,
            "total_samples": total_samples,
            "ic_tracking": merged_ic,
            "circuit_breaker": circuit_breaker,
            "challenger_registrations": {
                **(tree_result.get("challenger_registrations") or {}),
                **challenger_registrations,
            },
            "artifact_registrations": artifact_registrations,
            "suppressed_legacy_challenger_registrations": suppressed_legacy_challenger_registrations,
            "tree_elapsed_s": tree_result.get("elapsed_s"),
            "aux_train": {
                k: {
                    "status": "ok" if "error" not in v else "error",
                    "metadata": v.get("metadata"),
                    "saved": v.get("saved"),
                    "version": v.get("version"),
                    "ic_tracking": v.get("ic_tracking"),
                    "elapsed_s": v.get("elapsed_s"),
                    "type": v.get("type"),
                }
                for k, v in aux_train.items()
            },
        }
        if artifact_lifecycle_only and not requested_train_groups:
            result["stages"]["train"]["status"] = "ok"
            result["stages"]["train"]["reason"] = "artifact_lifecycle_only_no_train_groups"

        if artifact_lifecycle_targets:
            lifecycle_results: dict[str, dict] = {}
            lifecycle_errors: dict[str, str] = {}
            lifecycle_t0 = time.time()

            def _base_artifact_payload(model_name: str) -> dict:
                promote_to_active = payload.get("artifact_lifecycle_promote_to_active", False)
                if not isinstance(promote_to_active, bool):
                    raise RuntimeError("artifact_lifecycle_promote_to_active must be an explicit boolean")
                artifact_payload = {
                    **(monthly_model_payload(model_name) if is_monthly else {}),
                    "gcs_prefix": gcs_prefix,
                    "batch_count": batch_count,
                    "output_model_version": candidate_version,
                    "promote_to_active": promote_to_active,
                    "run_date": run_date,
                    "candidate_type": payload.get("candidate_type"),
                    "monthly_training_contract": monthly_training_contract,
                    "dataset_snapshot": payload.get("dataset_snapshot"),
                    "as_of_date": payload.get("as_of_date"),
                    "max_prep_stale_days": payload.get("max_prep_stale_days"),
                    "label_horizon_days": selection_params.get("label_horizon_days"),
                }
                if promote_to_active:
                    artifact_payload["promotion_reason"] = (
                        payload.get("artifact_lifecycle_promotion_reason")
                        or payload.get("promotion_reason")
                        or (
                            f"formal artifact lifecycle target={model_name} "
                            f"run_id={run_id or candidate_version}"
                        )
                    )
                return artifact_payload

            def _sequence_seq_len_for_target(model_name: str) -> int:
                key = f"{model_name.lower()}_seq_len"
                if payload.get(key):
                    return int(payload[key])
                if payload.get("sequence_seq_len"):
                    return int(payload["sequence_seq_len"])
                from app.neuralforecast_sequence_runtime import default_seq_len_for_model
                return default_seq_len_for_model(model_name)

            def _validate_timesfm_config() -> dict:
                import json
                from app.model_pool import load_pool
                from google.cloud import storage as _gcs

                pool = load_pool() or {}
                entry = (pool.get("models") or {}).get("TimesFM") or {}
                version = str(entry.get("version") or "").strip()
                gcs_path = str(entry.get("gcs_path") or "").strip()
                if not version or not gcs_path:
                    raise RuntimeError("TimesFM model_pool entry missing version or gcs_path")
                bucket_name = _get_gcs_bucket_name()
                if not bucket_name:
                    raise RuntimeError("GCS bucket not configured")
                bucket = _gcs.Client().bucket(bucket_name)
                config_blob = bucket.blob(gcs_path)
                if not config_blob.exists():
                    raise RuntimeError(f"TimesFM config artifact missing in GCS: {gcs_path}")

                def _load_json_blob(path: str, *, required: bool) -> dict:
                    if not path:
                        if required:
                            raise RuntimeError("TimesFM required JSON artifact path is empty")
                        return {}
                    blob = bucket.blob(path)
                    if not blob.exists():
                        if required:
                            raise RuntimeError(f"TimesFM required JSON artifact missing in GCS: {path}")
                        return {}
                    try:
                        loaded = json.loads(blob.download_as_text())
                    except Exception as exc:
                        if required:
                            raise RuntimeError(f"TimesFM JSON artifact invalid: {path}: {exc}") from exc
                        return {}
                    if not isinstance(loaded, dict):
                        if required:
                            raise RuntimeError(f"TimesFM JSON artifact is not an object: {path}")
                        return {}
                    return loaded

                config = _load_json_blob(gcs_path, required=True)
                explicit_metadata_path = (
                    str(entry.get("metadata_path") or "").strip()
                    or str(config.get("metadata_path") or "").strip()
                )
                metadata_path = (
                    explicit_metadata_path
                    or f"universal/timesfm/metadata_{version}.json"
                )
                metadata = _load_json_blob(metadata_path, required=bool(explicit_metadata_path))
                evidence = {}
                for candidate in (
                    config.get("last_artifact_evidence"),
                    metadata.get("last_artifact_evidence"),
                    config.get("benchmark_evidence"),
                    metadata.get("benchmark_evidence"),
                ):
                    if isinstance(candidate, dict) and (candidate.get("oos_ic") is not None or candidate.get("after_oos_ic") is not None):
                        evidence = dict(candidate)
                        break
                oos_ic = None
                if evidence:
                    oos_ic = evidence.get("oos_ic") if evidence.get("oos_ic") is not None else evidence.get("after_oos_ic")
                model_cpcv = (
                    evidence.get("model_cpcv")
                    or config.get("model_cpcv")
                    or metadata.get("model_cpcv")
                    or metadata.get("cpcv_evidence")
                )
                metrics = {
                    key: evidence.get(key)
                    for key in (
                        "oos_ic",
                        "after_oos_ic",
                        "direction_accuracy",
                        "oos_samples",
                        "pbo",
                        "price_mae",
                        "price_rmse",
                        "p10_p90_coverage",
                    )
                    if evidence.get(key) is not None
                }
                if oos_ic is not None:
                    metrics["oos_ic"] = oos_ic
                result = {
                    "status": "ok" if evidence else "warning",
                    "model": "TimesFM",
                    "version": version,
                    "artifact_path": gcs_path,
                    "metadata_path": metadata_path if metadata else None,
                    "artifact_type": "foundation_forecast_config",
                    "note": "TimesFM is config-backed foundation runtime; no local retrain is run.",
                }
                if not evidence:
                    result["warning"] = "timesfm_oos_evidence_missing"
                    result["validation_status"] = "evidence_missing_non_blocking"
                if metrics:
                    result["metrics"] = metrics
                if oos_ic is not None:
                    result["oos_ic"] = oos_ic
                    result["last_artifact_evidence"] = evidence
                if isinstance(model_cpcv, dict):
                    result["model_cpcv"] = model_cpcv
                return result

            for target in artifact_lifecycle_targets:
                target = str(target).strip()
                if not target:
                    continue
                target_t0 = time.time()
                try:
                    if target == "GNN":
                        train_payload = _base_artifact_payload(target)
                        lifecycle_results[target] = train_gnn_graphsage_universal.remote(train_payload)
                    elif target == "TabM":
                        train_payload = _base_artifact_payload(target)
                        lifecycle_results[target] = train_tabm_universal.remote(train_payload)
                    elif target == "PatchTST":
                        if not sequence_records:
                            raise RuntimeError("missing_sequence_records_artifact")
                        train_payload = {
                            **_base_artifact_payload(target),
                            "sequence_records": sequence_records,
                            "seq_len": _sequence_seq_len_for_target(target),
                            "device": payload.get("sequence_device") or "cuda",
                            "sequence_gcs_prefix": sequence_gcs_prefix,
                            "sequence_batch_count": sequence_batch_count,
                        }
                        lifecycle_results[target] = train_patchtst_universal.remote(train_payload)
                    elif target == "iTransformer":
                        if not sequence_records:
                            raise RuntimeError("missing_sequence_records_artifact")
                        train_payload = {
                            **_base_artifact_payload(target),
                            "sequence_records": sequence_records,
                            "seq_len": _sequence_seq_len_for_target(target),
                            "device": payload.get("sequence_device") or "cuda",
                            "sequence_gcs_prefix": sequence_gcs_prefix,
                            "sequence_batch_count": sequence_batch_count,
                        }
                        lifecycle_results[target] = train_itransformer_universal.remote(train_payload)
                    elif target == "TimesFM":
                        lifecycle_results[target] = _validate_timesfm_config()
                    else:
                        lifecycle_results[target] = {
                            "status": "skipped",
                            "model": target,
                            "reason": "unsupported_artifact_lifecycle_target",
                        }
                    if isinstance(lifecycle_results.get(target), dict) and lifecycle_results[target].get("error"):
                        raise RuntimeError(str(lifecycle_results[target].get("error")))
                    lifecycle_results[target]["elapsed_s"] = round(time.time() - target_t0, 3)
                    print(f"[Orchestrator] Artifact lifecycle ok target={target}")
                except Exception as e:
                    lifecycle_errors[target] = str(e)
                    lifecycle_results[target] = {
                        "status": "error",
                        "model": target,
                        "error": str(e),
                        "elapsed_s": round(time.time() - target_t0, 3),
                    }
                    print(f"[Orchestrator] Artifact lifecycle failed target={target}: {e}")

            result["stages"]["artifact_lifecycle"] = {
                "status": "error" if lifecycle_errors else "ok",
                "targets": artifact_lifecycle_targets,
                "contracts": artifact_lifecycle_contracts,
                "results": lifecycle_results,
                "errors": lifecycle_errors,
                "elapsed_s": round(time.time() - lifecycle_t0, 3),
                "model_pool_write_mode": "sequential",
            }
            partial_results["artifact_lifecycle"] = {
                "elapsed_s": result["stages"]["artifact_lifecycle"]["elapsed_s"],
                "results": lifecycle_results,
            }
            if lifecycle_errors:
                result["stages"]["train"]["status"] = "error"
                result["stages"]["train"]["error"] = "artifact_lifecycle_failed"

        try:
            from app.stacking import save_meta_learner, train_rank_stacker_oof

            oos_payloads = []
            for group, partial in (("tree", tree_result),):
                artifact = (partial or {}).get("oos_artifact") or {}
                artifact_path = artifact.get("path")
                if not artifact_path:
                    continue
                oos_payload = _load_oos_rank_payload_from_gcs(artifact_path)
                oos_payloads.append(oos_payload)
                print(f"[Orchestrator] Loaded OOS artifact for stacker: {artifact_path}")

            expected_oos_groups = expected_oos_artifact_groups(requested_train_groups)
            missing_oos_groups = missing_expected_oos_groups(expected_oos_groups, oos_payloads)
            if missing_oos_groups:
                result["stages"]["rank_stacker"] = {
                    "status": "skipped",
                    "reason": "missing_oos_artifacts",
                    "missing_groups": missing_oos_groups,
                    "expected_groups": expected_oos_groups,
                    "loaded_groups": [p.get("group") for p in oos_payloads],
                }
            else:
                rows, y_rank, stack_model_order = merge_oos_rank_payloads(oos_payloads)
                if rows:
                    rank_bundle = train_rank_stacker_oof(
                        rows,
                        y_rank,
                        model_order=stack_model_order,
                        min_samples=80,
                    )
                    if rank_bundle:
                        saved = save_meta_learner(rank_bundle, 0)
                        result["stages"]["rank_stacker"] = {
                            "status": "ok" if saved else "error",
                            "saved": bool(saved),
                            "oos_ic": rank_bundle.get("eval_ic"),
                            "eval_rmse": rank_bundle.get("eval_rmse"),
                            "train": rank_bundle.get("train_samples"),
                            "test": rank_bundle.get("eval_samples"),
                            "model_order": stack_model_order,
                            "artifacts": [p.get("path") for p in oos_payloads],
                        }
                        merged_results["StackingRank"] = {
                            "trained": True,
                            "saved": bool(saved),
                            "oos_ic": rank_bundle.get("eval_ic"),
                            "eval_rmse": rank_bundle.get("eval_rmse"),
                        }
                        if rank_bundle.get("eval_ic") is not None:
                            merged_ic["StackingRank"] = {
                                "oos_ic": rank_bundle.get("eval_ic"),
                                "oos_samples": rank_bundle.get("eval_samples"),
                                "passed": float(rank_bundle.get("eval_ic") or 0.0) > 0,
                            }
                    else:
                        result["stages"]["rank_stacker"] = {
                            "status": "skipped",
                            "reason": "insufficient_oos_rank_samples",
                            "model_order": stack_model_order,
                            "samples": int(len(y_rank)),
                        }
                else:
                    result["stages"]["rank_stacker"] = {
                        "status": "skipped",
                        "reason": "missing_oos_artifacts",
                        "expected_groups": expected_oos_groups,
                    }
        except Exception as e:
            result["stages"]["rank_stacker"] = {"status": "error", "error": str(e)}
            print(f"[Orchestrator] Rank stacker finalizer failed: {e}")

        stacker_status = (result["stages"].get("rank_stacker") or {}).get("status")
        if stacker_status != "ok" and result["stages"]["train"].get("status") == "ok" and not artifact_lifecycle_only:
            result["stages"]["train"]["status"] = "degraded"
            result["stages"]["train"]["degraded_reason"] = f"rank_stacker_{stacker_status or 'missing'}"

        if circuit_breaker:
            print("[Orchestrator] Circuit breaker: weak model IC detected; ensemble will auto-zero-weight affected models")

        # Write merged ic_tracking.json to GCS (both containers skip GCS write when models_filter set)
        try:
            from google.cloud import storage as _gcs
            import json as _json
            from datetime import datetime as _dt, timezone as _tz
            _bucket_name = _get_gcs_bucket_name()
            if not _bucket_name:
                raise RuntimeError("GCS bucket not configured")
            _bucket = _gcs.Client().bucket(_bucket_name)
            _now_utc = _dt.now(_tz.utc)
            _ic_record = {
                "computed_at": _now_utc.isoformat().replace("+00:00", "Z"),
                "models": merged_ic,
                "circuit_breaker": circuit_breaker,
                "total_samples": total_samples,
                "source": "orchestrator_merged",
            }
            _ic_json = _json.dumps(_ic_record, indent=2)
            _bucket.blob(f"{gcs_prefix}/ic_tracking.json").upload_from_string(
                _ic_json, content_type="application/json"
            )
            _month = _now_utc.strftime("%Y-%m")
            _bucket.blob(f"{gcs_prefix}/ic_history/{_month}.json").upload_from_string(
                _ic_json, content_type="application/json"
            )
            print(f"[Orchestrator] IC tracking saved (breaker={'ON' if circuit_breaker else 'OFF'}, {len(merged_ic)} models)")
        except Exception as e:
            print(f"[Orchestrator] IC tracking GCS save failed: {e}")

        # SHAP audit is governance evidence, not a blocker for model artifacts.
        # Default to deferred spawn so monthly retrain callback is not held by
        # a dashboard audit that can be inspected separately.
        try:
            shap_mode = str(
                payload.get("shap_audit_mode")
                or os.environ.get("UNIVERSAL_SHAP_AUDIT_MODE", "deferred")
            ).strip().lower()
            if artifact_lifecycle_only and not payload.get("shap_audit_mode"):
                shap_mode = "skip"
            print(f"[Orchestrator] Auto-triggering SHAP audit mode={shap_mode}...")
            shap_t0 = time.time()
            if shap_mode == "skip":
                result["stages"]["shap"] = {
                    "status": "skipped",
                    "mode": "skip",
                    "reason": "artifact_lifecycle_only",
                    "elapsed_s": round(time.time() - shap_t0, 1),
                }
            elif shap_mode == "inline":
                shap_result = shap_feature_audit.remote({"shap_samples": 10000})
                result["stages"]["shap"] = {
                    "status": "ok",
                    "mode": "inline",
                    "elapsed_s": round(time.time() - shap_t0, 1),
                    "keep_count": shap_result.get("keep_count"),
                }
            else:
                shap_feature_audit.spawn({"shap_samples": 10000})
                result["stages"]["shap"] = {
                    "status": "deferred",
                    "mode": "spawn",
                    "elapsed_s": round(time.time() - shap_t0, 1),
                }
        except Exception as e:
            print(f"[Orchestrator] SHAP failed (non-blocking): {e}")
            result["stages"]["shap"] = {"status": "error", "error": str(e)}

    except Exception as e:
        print(f"[Orchestrator] Train failed: {e}")
        result["stages"]["train"] = {"status": "error", "error": str(e)}

    if is_monthly:
        try:
            from services.active8_monthly_training_contract import (
                ACTIVE8_MODEL_NAMES,
                normalize_monthly_raw_artifact_receipt,
                validate_monthly_artifact_receipts,
            )
            registrations = dict(((result.get("stages") or {}).get("train") or {}).get("artifact_registrations") or {})
            lifecycle = dict(((result.get("stages") or {}).get("artifact_lifecycle") or {}).get("results") or {})
            receipts = {}
            for model_name in ACTIVE8_MODEL_NAMES:
                receipts[model_name] = normalize_monthly_raw_artifact_receipt(
                    registrations.get(model_name) or lifecycle.get(model_name)
                )
            result["stages"]["monthly_model_completion"] = validate_monthly_artifact_receipts(
                contract=monthly_training_contract,
                receipts=receipts,
            )
        except Exception as exc:
            result.setdefault("stages", {})["monthly_model_completion"] = {"status": "error", "error": str(exc)}
            result.setdefault("stages", {}).setdefault("train", {})["status"] = "error"
            result["stages"]["train"]["error"] = "monthly_active8_completion_incomplete"

    elapsed = round(time.time() - t0, 1)
    result["total_elapsed_s"] = elapsed
    payload_out = build_retrain_followup_payload(
        run_id=run_id,
        lock_key=lock_key,
        run_date=run_date,
        is_monthly=bool(is_monthly),
        batch_count=batch_count,
        gcs_prefix=gcs_prefix,
        candidate_version=candidate_version,
        window_id=window_id,
        result=result,
        partial_results=partial_results,
        elapsed_s=elapsed,
        candidate_type=payload.get("candidate_type"),
        promotion_allowed_models=payload.get("promotion_allowed_models"),
        oof_promotion_evidence=payload.get("oof_promotion_evidence"),
        oof_lifecycle_resume=payload.get("oof_lifecycle_resume"),
    )
    result["durable_followup_payload"] = payload_out
    if followup_webhook_url:
        try:
            import httpx
            headers = {"Content-Type": "application/json"}
            token = _retrain_followup_token()
            if token:
                headers["X-Service-Token"] = token
            resp = httpx.post(
                followup_webhook_url,
                json=payload_out,
                headers=headers,
                timeout=httpx.Timeout(120.0, connect=15.0),
                follow_redirects=True,
            )
            if resp.status_code < 200 or resp.status_code >= 300:
                raise RuntimeError(f"followup webhook returned HTTP {resp.status_code}")
            result["followup"] = {
                "status_code": resp.status_code,
                "url": sanitize_callback_url(resp.url),
                "payload_status": payload_out["status"],
            }
            print(f"[Orchestrator] followup webhook -> HTTP {resp.status_code}")
        except Exception as e:
            safe_error = sanitize_callback_error(e, locals().get("token"))
            result["followup"] = {
                "error": safe_error,
                "url": sanitize_callback_url(followup_webhook_url),
            }
            print(f"[Orchestrator] followup webhook failed: {safe_error}")
    print(f"[Orchestrator] Flow B complete in {elapsed}s")
    return result


@app.function(
    cpu=2,
    memory=8192,
    gpu="L4",
    timeout=7200,
    scaledown_window=60,
    max_containers=1,
)
def research_model_benchmark(payload: dict) -> dict:
    """Run research-only model-family benchmark executor.

    This function may use GPU for benchmark adapters, but it must never promote
    models or mutate production artifacts. Results are returned to the
    controller as fold metrics / PBO / cost / data-slice evidence.
    """
    _setup_env()
    from app.research_model_benchmark_runtime import run_research_model_benchmark

    return run_research_model_benchmark(payload)


@app.function(
    cpu=1,
    memory=1024,
    timeout=600,
    scaledown_window=60,
    max_containers=2,
)
def breeze2_research_context(payload: dict) -> dict:
    """Build Breeze2 research-context evidence for debate/screener callers."""
    _setup_env()
    from app.breeze2_context import build_breeze2_research_context

    return build_breeze2_research_context({
        **payload,
        "allowed_use": "research_context_only",
        "mutation_allowed": False,
    })


@app.function(
    cpu=2,
    memory=16384,
    gpu="L4",
    timeout=900,
    scaledown_window=60,
    max_containers=1,
)
def breeze2_reason_generation(payload: dict) -> dict:
    """Generate Breeze2 shadow reasons; never writes trading state."""
    _setup_env()
    from app.breeze2_reason_generation import generate_breeze2_reason_generation

    return generate_breeze2_reason_generation({
        **payload,
        "allowed_use": "reason_shadow_only",
        "mutation_allowed": False,
        "real_trading_allowed": False,
    })


@app.function(
    cpu=1,                       # 1 CPU per prediction container.
    memory=2048,                 # 2GB is sufficient for CPU prediction runtime.
    timeout=300,                 # 5 min buffer for tail inference and cold start.
    min_containers=0,            # Scale to zero outside scheduled warmup windows.
    scaledown_window=900,        # Keep warmup containers alive through the TW 22:00 pipeline.
    max_containers=20,           # Bound fan-out to control Modal concurrency and cost.
)
def predict_single_stock(payload: dict) -> dict:
    """Prediction v2: regression models plus IC-weighted rank-to-signal.
    No v1 fallback: v2 failures must surface as errors for control-plane visibility.
    """
    _setup_env()
    from app.use_cases import predict_stock_v2, PredictRequest
    try:
        req = PredictRequest(**payload)
        return predict_stock_v2(req)
    except Exception as e_v2:
        import traceback
        print(f"[predict_single_stock] v2 failed for {payload.get('symbol', '?')}: {type(e_v2).__name__}: {e_v2}")
        print(traceback.format_exc())
        return {
            "stock_id": payload.get("stock_id", 0),
            "symbol": payload.get("symbol", "?"),
            "error": f"v2: {type(e_v2).__name__}: {e_v2}",
            "signal": "NO_SIGNAL",
            "direction": "neutral",
            "confidence": 0.0,
        }


@app.function(
    cpu=2,
    memory=8192,
    timeout=900,
    min_containers=0,
    scaledown_window=900,
    max_containers=4,
)
def predict_batch_v2(payload: dict) -> dict:
    """Chunked v2 prediction.

    Production controller uses this chunked contract by default. Set
    MODAL_PREDICT_BATCH_V2=0 only as an emergency fallback to single-stock map.
    """
    _setup_env()
    from app.batch_prediction import predict_stock_v2_batch_with_metrics

    payloads = payload.get("payloads") or []
    batch = predict_stock_v2_batch_with_metrics(payloads)
    results = batch["results"]
    return {
        "results": results,
        "n_input": len(payloads),
        "n_error": sum(1 for r in results if r.get("error")),
        "metrics": batch.get("metrics", {}),
    }


def _persist_pipeline_prediction_bundle(input_payload: dict, bundle: dict) -> dict:
    import hashlib
    import json
    import re
    from google.api_core.exceptions import PreconditionFailed
    from google.cloud import storage

    bucket_name = _get_gcs_bucket_name()
    if not bucket_name:
        raise RuntimeError("pipeline_modal_result_bucket_missing")
    run_date = str(input_payload.get("run_date") or bundle.get("run_date") or "unknown")[:10]
    run_id = re.sub(
        r"[^A-Za-z0-9._-]+",
        "-",
        str(input_payload.get("run_id") or bundle.get("run_id") or "unknown"),
    ).strip("-")[:160]
    encoded = json.dumps(bundle, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    checksum = hashlib.sha256(encoded).hexdigest()
    path = f"pipeline-v2/modal-results/{run_date}/{run_id}-{checksum[:16]}.json"
    blob = storage.Client().bucket(bucket_name).blob(path)
    try:
        blob.upload_from_string(
            encoded,
            content_type="application/json",
            if_generation_match=0,
        )
    except PreconditionFailed:
        existing = blob.download_as_bytes()
        if hashlib.sha256(existing).hexdigest() != checksum:
            raise ValueError("pipeline_modal_result_idempotency_checksum_mismatch")
    return {
        "schema_version": "pipeline-modal-result-reference-v1",
        "result_gcs_uri": f"gs://{bucket_name}/{path}",
        "result_checksum": checksum,
        "result_bytes": len(encoded),
    }

def _post_pipeline_prediction_callback(input_payload: dict, bundle: dict, elapsed_s: float) -> dict:
    import json
    import time
    import urllib.error
    import urllib.request

    callback_url = str(input_payload.get("callback_url") or "").strip()
    token = str(input_payload.get("callback_token") or _controller_callback_token()).strip()
    if not callback_url or not token:
        return {"status": "skipped", "reason": "callback_url_or_token_missing"}
    body = {
        "schema_version": "pipeline-modal-prediction-callback-v2",
        "run_date": input_payload.get("run_date"),
        "run_id": input_payload.get("run_id"),
        "state_gcs_uri": input_payload.get("state_gcs_uri"),
        "elapsed_s": elapsed_s,
        "result_gcs_uri": bundle["durable_handoff"]["result_gcs_uri"],
        "result_checksum": bundle["durable_handoff"]["result_checksum"],
        "result_summary": {
            "n_input": bundle.get("n_input"),
            "stage_timings": bundle.get("stage_timings") or {},
            "capacity_contract": bundle.get("capacity_contract") or {},
            "request_transport": bundle.get("request_transport") or {},
        },
    }
    req = urllib.request.Request(
        callback_url,
        data=json.dumps(body, ensure_ascii=False, default=str).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "X-Service-Token": token,
        },
        method="POST",
    )
    last_error: dict | None = None
    for attempt in range(1, 4):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                text = resp.read().decode("utf-8", errors="replace")
                return {"status": "ok", "code": resp.status, "attempt": attempt, "text": text[:500]}
        except urllib.error.HTTPError as exc:
            last_error = {
                "status": "error",
                "code": exc.code,
                "attempt": attempt,
                "text": exc.read().decode("utf-8", errors="replace")[:500],
            }
        except Exception as exc:
            last_error = {
                "status": "error",
                "attempt": attempt,
                "error": sanitize_callback_error(exc, token),
            }
        time.sleep(min(attempt * 2, 5))
    return last_error or {"status": "error", "error": "unknown_callback_failure"}


def _post_pipeline_prediction_error_callback(input_payload: dict, error: Exception, elapsed_s: float) -> dict:
    import json
    import time
    import urllib.error
    import urllib.request

    callback_url = str(input_payload.get("callback_url") or "").strip()
    token = str(input_payload.get("callback_token") or _controller_callback_token()).strip()
    if not callback_url or not token:
        return {"status": "skipped", "reason": "callback_url_or_token_missing"}
    safe_error = sanitize_callback_error(error, token)
    body = {
        "schema_version": "pipeline-modal-prediction-callback-v2",
        "status": "error",
        "run_date": input_payload.get("run_date"),
        "run_id": input_payload.get("run_id"),
        "state_gcs_uri": input_payload.get("state_gcs_uri"),
        "elapsed_s": elapsed_s,
        "error": safe_error,
        "summary": f"Modal prediction failed: {safe_error[:300]}",
    }
    req = urllib.request.Request(
        callback_url,
        data=json.dumps(body, ensure_ascii=False, default=str).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "X-Service-Token": token,
        },
        method="POST",
    )
    last_error: dict | None = None
    for attempt in range(1, 4):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                text = resp.read().decode("utf-8", errors="replace")
                return {"status": "ok", "code": resp.status, "attempt": attempt, "text": text[:500]}
        except urllib.error.HTTPError as exc:
            last_error = {
                "status": "error",
                "code": exc.code,
                "attempt": attempt,
                "text": exc.read().decode("utf-8", errors="replace")[:500],
            }
        except Exception as exc:
            last_error = {
                "status": "error",
                "attempt": attempt,
                "error": sanitize_callback_error(exc, token),
            }
        time.sleep(min(attempt * 2, 5))
    return last_error or {"status": "error", "error": "unknown_callback_failure"}


def _hydrate_pipeline_prediction_request_reference(payload: dict) -> dict:
    if payload.get("schema_version") == "pipeline-modal-prediction-request-v1":
        return payload
    if payload.get("schema_version") != "pipeline-modal-prediction-request-ref-v1":
        raise ValueError("pipeline_modal_request_reference_schema_invalid")

    import gzip
    import hashlib
    import json
    from google.cloud import storage

    run_date = str(payload.get("run_date") or "")[:10]
    run_id = str(payload.get("run_id") or "").strip()
    state_gcs_uri = str(payload.get("state_gcs_uri") or "").strip()
    expected_source_sha = str(payload.get("expected_source_sha") or "").strip().lower()
    request_gcs_uri = str(payload.get("request_gcs_uri") or "").strip()
    request_sha = str(payload.get("request_sha256") or "").strip().lower()
    compressed_sha = str(payload.get("request_compressed_sha256") or "").strip().lower()
    callback_url = str(payload.get("callback_url") or "").strip()
    callback_token = str(payload.get("callback_token") or "").strip()
    try:
        generation = int(payload.get("request_generation"))
        compressed_bytes = int(payload.get("request_compressed_bytes"))
        uncompressed_bytes = int(payload.get("request_uncompressed_bytes"))
        n_input = int(payload.get("n_input"))
        max_symbols = int(payload.get("max_symbols"))
    except (TypeError, ValueError) as exc:
        raise ValueError("pipeline_modal_request_reference_numeric_invalid") from exc
    if (
        len(run_date) != 10
        or not run_id
        or not state_gcs_uri.startswith("gs://")
        or len(expected_source_sha) != 40
        or any(character not in "0123456789abcdef" for character in expected_source_sha)
        or len(request_sha) != 64
        or len(compressed_sha) != 64
        or any(character not in "0123456789abcdef" for character in request_sha + compressed_sha)
        or not callback_url
        or not callback_token
        or generation <= 0
        or compressed_bytes <= 0
        or compressed_bytes > 96 * 1024 * 1024
        or uncompressed_bytes <= 0
        or uncompressed_bytes > 512 * 1024 * 1024
        or n_input <= 0
        or max_symbols <= 0
        or max_symbols > 2000
        or n_input > max_symbols
    ):
        raise ValueError("pipeline_modal_request_reference_identity_invalid")

    bucket_name = get_gcs_bucket_name()
    prefix = f"gs://{bucket_name}/"
    safe_run_id = "".join(
        character if character.isalnum() or character in {"-", "_", "."} else "_"
        for character in run_id
    )
    expected_path_fragment = f"/{run_date}/{safe_run_id}/modal_request/{request_sha}.json.gz"
    if not request_gcs_uri.startswith(prefix) or expected_path_fragment not in request_gcs_uri:
        raise ValueError("pipeline_modal_request_reference_uri_invalid")
    blob_name = request_gcs_uri.removeprefix(prefix)
    compressed = storage.Client().bucket(bucket_name).blob(blob_name).download_as_bytes(
        if_generation_match=generation,
    )
    if len(compressed) != compressed_bytes:
        raise ValueError("pipeline_modal_request_reference_compressed_size_mismatch")
    if hashlib.sha256(compressed).hexdigest() != compressed_sha:
        raise ValueError("pipeline_modal_request_reference_compressed_checksum_mismatch")
    raw = gzip.decompress(compressed)
    if len(raw) != uncompressed_bytes:
        raise ValueError("pipeline_modal_request_reference_size_mismatch")
    if hashlib.sha256(raw).hexdigest() != request_sha:
        raise ValueError("pipeline_modal_request_reference_checksum_mismatch")
    durable = json.loads(raw)
    if (
        durable.get("schema_version") != "pipeline-modal-prediction-request-v1"
        or durable.get("callback_url") is not None
        or durable.get("callback_token") is not None
        or str(durable.get("run_date") or "")[:10] != run_date
        or str(durable.get("run_id") or "").strip() != run_id
        or str(durable.get("state_gcs_uri") or "").strip() != state_gcs_uri
        or str(durable.get("expected_source_sha") or "").strip().lower() != expected_source_sha
        or len(durable.get("payloads") or []) != n_input
    ):
        raise ValueError("pipeline_modal_request_reference_payload_mismatch")
    return {
        **durable,
        "callback_url": callback_url,
        "callback_token": callback_token,
        "request_transport": {
            "schema_version": "pipeline-modal-prediction-request-ref-v1",
            "request_gcs_uri": request_gcs_uri,
            "request_generation": str(generation),
            "request_sha256": request_sha,
            "request_compressed_sha256": compressed_sha,
            "request_uncompressed_bytes": uncompressed_bytes,
            "request_compressed_bytes": compressed_bytes,
            "n_input": n_input,
            "max_symbols": max_symbols,
        },
    }



def _run_active8_sequence_shadow_candidates(
    *,
    candidate_series_by_model: dict,
    candidate_entries: dict,
    candidate_identities: dict,
    predictors: dict,
) -> dict:
    """Execute registry-owned sequence candidates without serving influence."""
    candidate_outputs: dict[str, dict] = {}
    for model_name, predictor in predictors.items():
        entry = candidate_entries.get(model_name)
        if not isinstance(entry, dict):
            continue
        identity = candidate_identities.get(model_name)
        if not isinstance(identity, dict):
            candidate_outputs[model_name] = {
                "status": "failed",
                "error": "candidate_identity_missing",
                "results": [],
            }
            continue
        series = candidate_series_by_model.get(model_name) or []
        expected_symbols = [
            str(row.get("symbol") or row.get("stock_id") or "").strip()
            for row in series
            if isinstance(row, dict) and (row.get("symbol") or row.get("stock_id"))
        ]
        if not expected_symbols:
            candidate_outputs[model_name] = {
                "status": "insufficient_sequence_input",
                "error": "candidate_sequence_contract_unmet",
                "identity": identity,
                "results": [],
                "n_input": 0,
                "n_success": 0,
            }
            continue
        try:
            results = predictor(
                series_list=series,
                horizon_used=5,
                version=str(identity.get("version") or ""),
                artifact_identity={"model": model_name, **identity},
            )
            observed = [
                str(row.get("symbol") or "").strip()
                for row in results
                if isinstance(row, dict) and not row.get("error")
            ]
            exact = (
                len(results) == len(expected_symbols)
                and len(observed) == len(expected_symbols)
                and len(set(observed)) == len(observed)
                and set(observed) == set(expected_symbols)
            )
            if not exact:
                raise RuntimeError("candidate_sequence_result_cardinality_mismatch")
            enriched = [
                {
                    **row,
                    "artifact_id": identity.get("artifact_id"),
                    "artifact_checksum": identity.get("checksum"),
                    "candidate_type": entry.get("candidate_type"),
                    "production_effect": False,
                    "vote_weight": 0.0,
                }
                for row in results
            ]
            candidate_outputs[model_name] = {
                "status": "complete",
                "identity": identity,
                "results": enriched,
                "n_input": len(expected_symbols),
                "n_success": len(enriched),
            }
        except Exception as exc:  # noqa: BLE001 - shadow cannot block champion.
            candidate_outputs[model_name] = {
                "status": "failed",
                "identity": identity,
                "error": f"{type(exc).__name__}: {exc}",
                "results": [],
                "n_input": len(expected_symbols),
                "n_success": 0,
            }
    return {
        "schema_version": "active8-sequence-shadow-bundle-v1",
        "production_effect": False,
        "vote_weight": 0.0,
        "candidates": candidate_outputs,
    }


def _pipeline_prediction_bundle_impl(payload: dict) -> dict:
    """Run pipeline-v2 raw L3 prediction families inside Modal, then callback controller."""
    _setup_env()
    import time
    import traceback

    from app.batch_prediction import (
        predict_gnn_graphsage_batch,
        predict_stock_v2_chunked_with_metrics,
    )
    from app.dlinear_universal import dlinear_batch_predict
    from app.itransformer_universal import itransformer_batch_predict
    from app.patchtst_universal import patchtst_batch_predict
    from app.state_space_universal import state_space_overlays_batch_predict
    from app.serving_resolver import (
        active8_shadow_candidate_identities,
        build_pool_from_frozen_manifest,
        serving_manifest_coverage,
        serving_manifest_identities,
    )

    started = time.time()
    expected_source_sha = str(payload.get("expected_source_sha") or "").strip()
    modal_source_sha = str(os.environ.get("STOCKVISION_SOURCE_SHA") or "").strip()
    sha_values = (expected_source_sha, modal_source_sha)
    if any(
        len(value) != 40
        or value != value.lower()
        or any(character not in "0123456789abcdef" for character in value)
        for value in sha_values
    ):
        raise ValueError("pipeline_modal_source_sha_missing")
    if modal_source_sha != expected_source_sha:
        raise ValueError("pipeline_modal_source_sha_mismatch")
    payloads = payload.get("payloads") or []
    sequence_model_series_by_model = payload.get("sequence_model_series_by_model") or {}
    sequence_model_contracts = payload.get("sequence_model_contracts") or {}
    sequence_series = payload.get("sequence_series") or []
    active_versions = payload.get("active_versions") or {}
    model_status = payload.get("model_status") or {}
    state_space_models = payload.get("state_space_models") or {}
    state_space_mode = str(payload.get("state_space_overlay_mode") or "blocking").strip().lower()

    serving_manifest = payload.get("serving_manifest")
    serving_manifest_digest = str(payload.get("serving_manifest_digest") or "").strip().lower()
    frozen_pool = build_pool_from_frozen_manifest(
        serving_manifest,
        expected_digest=serving_manifest_digest,
        l2_sidecar_context={"version": active_versions.get("TimesFM")},
    )
    slot_identities = serving_manifest_identities(serving_manifest)
    serving_identities = serving_manifest_identities(serving_manifest, serving_only=True)
    coverage = serving_manifest_coverage(serving_manifest)
    active8_shadow_identities = active8_shadow_candidate_identities(serving_manifest)
    dispatched_slots = payload.get("slot_artifact_identities")
    if not isinstance(dispatched_slots, dict) or dispatched_slots != slot_identities:
        raise ValueError("pipeline_modal_slot_artifact_identity_dispatch_mismatch")
    dispatched_identities = payload.get("active_artifact_identities")
    if not isinstance(dispatched_identities, dict) or dispatched_identities != serving_identities:
        raise ValueError("pipeline_modal_active_artifact_identity_dispatch_mismatch")
    dispatched_shadow_identities = payload.get("active8_shadow_artifact_identities")
    if (
        not isinstance(dispatched_shadow_identities, dict)
        or dispatched_shadow_identities != active8_shadow_identities
    ):
        raise ValueError("pipeline_modal_active8_shadow_identity_dispatch_mismatch")
    if payload.get("serving_coverage") != coverage:
        raise ValueError("pipeline_modal_serving_coverage_dispatch_mismatch")
    serving_versions = {
        model_name: str(identity.get("version") or "")
        for model_name, identity in serving_identities.items()
    }
    manifest_rows = {
        str(row.get("model") or ""): row
        for row in (serving_manifest.get("models") or [])
        if isinstance(row, dict)
    }
    for model_name, row in manifest_rows.items():
        dispatched_status = str(model_status.get(model_name) or "").strip()
        effective_status = str(row.get("effective_status") or "").strip()
        if dispatched_status != effective_status:
            raise ValueError(
                f"pipeline_modal_model_status_dispatch_mismatch:{model_name}"
            )
        expected_version = serving_versions.get(model_name)
        dispatched_version = str(active_versions.get(model_name) or "").strip()
        if expected_version is not None and dispatched_version != expected_version:
            raise ValueError(
                f"pipeline_modal_active_version_dispatch_mismatch:{model_name}"
            )
        if expected_version is None and dispatched_version:
            raise ValueError(
                f"pipeline_modal_excluded_version_dispatch_present:{model_name}"
            )

    def _is_active(model_name: str) -> bool:
        return str(model_status.get(model_name) or "").strip() in {"active", "degraded"}

    def _artifact_identity(model_name: str) -> dict:
        identity = serving_identities.get(model_name)
        if not isinstance(identity, dict):
            raise ValueError(f"pipeline_modal_serving_identity_missing:{model_name}")
        return {"model": model_name, **identity}


    def _skip(reason: str) -> dict:
        return {"error": reason, "results": []}

    def _sequence_input(model_name: str) -> list[dict]:
        rows = sequence_model_series_by_model.get(model_name) or []
        return rows if isinstance(rows, list) else []

    def _sequence_skip(model_name: str) -> dict:
        if not _is_active(model_name):
            return _skip(f"{model_name} retired by model_pool")
        contract = sequence_model_contracts.get(model_name) or {}
        return _skip(
            f"{model_name} sequence contract unmet "
            f"(required={contract.get('seq_len') or 'unknown'} usable=0)"
        )

    def _feature() -> list[dict]:
        raw_chunk_size = payload.get("predict_batch_v2_chunk_size")
        try:
            chunk_size = int(raw_chunk_size or len(payloads) or 1)
        except (TypeError, ValueError):
            chunk_size = len(payloads) or 1
        chunk_size = max(1, chunk_size)
        return predict_stock_v2_chunked_with_metrics(
            payloads,
            chunk_size=chunk_size,
            batch_contract=payload.get("predict_batch_v2_contract") or {},
            pool_snapshot=frozen_pool,
        )

    def _gnn() -> dict:
        if not _is_active("GNN"):
            return _skip("GNN retired by model_pool")
        return predict_gnn_graphsage_batch(payloads, pool_snapshot=frozen_pool)

    def _dlinear() -> dict:
        series = _sequence_input("DLinear")
        if not _is_active("DLinear") or not series:
            return _sequence_skip("DLinear")
        results = dlinear_batch_predict(
            series_list=series,
            horizon_used=5,
            version=active_versions.get("DLinear", "v1"),
            artifact_identity=_artifact_identity("DLinear"),
        )
        return {"results": results, "n_input": len(series), "n_success": sum(1 for r in results if not r.get("error"))}

    def _patchtst() -> dict:
        series = _sequence_input("PatchTST")
        if not _is_active("PatchTST") or not series:
            return _sequence_skip("PatchTST")
        results = patchtst_batch_predict(
            series_list=series,
            horizon_used=5,
            version=active_versions.get("PatchTST", "v1"),
            artifact_identity=_artifact_identity("PatchTST"),
        )
        return {"results": results, "n_input": len(series), "n_success": sum(1 for r in results if not r.get("error"))}

    def _itransformer() -> dict:
        series = _sequence_input("iTransformer")
        if not _is_active("iTransformer") or not series:
            return _sequence_skip("iTransformer")
        results = itransformer_batch_predict(
            series_list=series,
            horizon_used=5,
            version=active_versions.get("iTransformer", "v1"),
            artifact_identity=_artifact_identity("iTransformer"),
        )
        return {"results": results, "n_input": len(series), "n_success": sum(1 for r in results if not r.get("error"))}

    def _active8_sequence_shadows() -> dict:
        return _run_active8_sequence_shadow_candidates(
            candidate_series_by_model=(
                payload.get("active8_shadow_sequence_series_by_model") or {}
            ),
            candidate_entries=frozen_pool.get("active8_shadow_candidates") or {},
            candidate_identities=active8_shadow_identities,
            predictors={
                "DLinear": dlinear_batch_predict,
                "PatchTST": patchtst_batch_predict,
                "iTransformer": itransformer_batch_predict,
            },
        )

    def _state_space() -> dict:
        if not state_space_models:
            return _skip("state-space overlays retired by model_pool")
        if state_space_mode in {"disabled", "shadow"}:
            return _skip(f"state-space overlays {state_space_mode}; not blocking prediction")
        return state_space_overlays_batch_predict(
            model_names=["KalmanFilter", "MarkovSwitching"],
            series_list=sequence_series,
            horizon=5,
            version_by_model=state_space_models,
        )

    stages = {
        "predict_batch_v2": (_feature, True),
        "gnn_graphsage_universal_predict": (_gnn, _is_active("GNN")),
        "dlinear_universal_predict": (_dlinear, _is_active("DLinear")),
        "patchtst_universal_predict": (_patchtst, _is_active("PatchTST")),
        "itransformer_universal_predict": (_itransformer, _is_active("iTransformer")),
        "state_space_universal_predict": (_state_space, False),
        "active8_sequence_shadow_predict": (_active8_sequence_shadows, False),
    }
    outputs: dict[str, object] = {}
    timings: dict[str, dict] = {}

    def _run_stage(name: str, fn, required_alpha: bool):
        t0 = time.time()
        print(
            f"[PipelinePredictionBundle] stage_start name={name} required_alpha={required_alpha}",
            flush=True,
        )
        try:
            result = fn()
            status = "skipped" if isinstance(result, dict) and result.get("error") and result.get("results") == [] else "ok"
            timing = {
                "wall_sec": round(time.time() - t0, 3),
                "required_alpha": required_alpha,
                "status": status,
                "error": result.get("error") if isinstance(result, dict) else None,
            }
            print(
                f"[PipelinePredictionBundle] stage_end name={name} status={status} "
                f"wall_sec={timing['wall_sec']}",
                flush=True,
            )
            return name, result, timing
        except Exception as exc:  # noqa: BLE001
            timing = {
                "wall_sec": round(time.time() - t0, 3),
                "required_alpha": required_alpha,
                "status": "exception",
                "error": f"{type(exc).__name__}: {exc}",
            }
            print(
                f"[PipelinePredictionBundle] stage_end name={name} status=exception "
                f"wall_sec={timing['wall_sec']} error={timing['error']}",
                flush=True,
            )
            return name, {"error": f"{type(exc).__name__}: {exc}", "trace": traceback.format_exc()[:2000], "results": []}, timing

    for name, (fn, required_alpha) in stages.items():
        stage_name, result, timing = _run_stage(name, fn, required_alpha)
        outputs[stage_name] = result
        timings[stage_name] = timing

    expected_symbols = [
        str(row.get("symbol") or row.get("stock_id") or "").strip()
        for row in payloads
        if isinstance(row, dict)
    ]
    expected_symbols = [symbol for symbol in expected_symbols if symbol]
    if (
        not expected_symbols
        or len(set(expected_symbols)) != len(expected_symbols)
    ):
        raise ValueError("pipeline_modal_expected_symbol_contract_invalid")

    feature_output = outputs.get("predict_batch_v2")
    feature_rows = (
        feature_output.get("results")
        if isinstance(feature_output, dict)
        else feature_output
    )
    if not isinstance(feature_rows, list):
        raise ValueError("pipeline_modal_feature_results_not_list")
    feature_models = [
        name for name in ("LightGBM", "XGBoost", "ExtraTrees", "TabM")
        if _is_active(name)
    ]

    def _assert_exact_rows(
        model_name: str,
        rows: object,
        *,
        expected: list[str] | None = None,
        require_rank: bool = False,
    ) -> None:
        model_expected = expected_symbols if expected is None else expected
        model_expected_set = set(model_expected)
        if not model_expected or len(model_expected_set) != len(model_expected):
            raise ValueError(f"pipeline_modal_{model_name.lower()}_expected_symbol_contract_invalid")
        if not isinstance(rows, list):
            raise ValueError(f"pipeline_modal_{model_name.lower()}_results_not_list")
        observed: list[str] = []
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError(f"pipeline_modal_{model_name.lower()}_row_invalid")
            symbol = str(row.get("symbol") or row.get("stock_id") or "").strip()
            if not symbol or row.get("error"):
                raise ValueError(f"pipeline_modal_{model_name.lower()}_row_error:{symbol or '<missing>'}")
            observed.append(symbol)
            if require_rank:
                rank_scores = row.get("rank_scores")
                for feature_model in feature_models:
                    value = rank_scores.get(feature_model) if isinstance(rank_scores, dict) else None
                    try:
                        valid = value is not None and math.isfinite(float(value))
                    except (TypeError, ValueError):
                        valid = False
                    if not valid:
                        raise ValueError(
                            f"pipeline_modal_feature_rank_missing:{symbol}:{feature_model}"
                        )
        if (
            len(rows) != len(model_expected)
            or len(observed) != len(model_expected)
            or len(set(observed)) != len(observed)
            or set(observed) != model_expected_set
        ):
            raise ValueError(f"pipeline_modal_{model_name.lower()}_cardinality_mismatch")

    _assert_exact_rows("feature", feature_rows, require_rank=True)
    runtime_output_keys = {
        "GNN": "gnn_graphsage_universal_predict",
        "DLinear": "dlinear_universal_predict",
        "PatchTST": "patchtst_universal_predict",
        "iTransformer": "itransformer_universal_predict",
    }
    for model_name, output_key in runtime_output_keys.items():
        if not _is_active(model_name):
            continue
        output = outputs.get(output_key)
        rows = output.get("results") if isinstance(output, dict) else None
        model_symbols = [
            str(row.get("symbol") or row.get("stock_id") or "").strip()
            for row in _sequence_input(model_name)
            if isinstance(row, dict)
            and (row.get("symbol") or row.get("stock_id"))
        ]
        _assert_exact_rows(model_name, rows, expected=model_symbols)

    elapsed_s = round(time.time() - started, 3)
    feature_wall_sec = float((timings.get("predict_batch_v2") or {}).get("wall_sec") or 0.0)
    try:
        feature_chunk_size = max(1, int(payload.get("predict_batch_v2_chunk_size") or len(payloads) or 1))
    except (TypeError, ValueError):
        feature_chunk_size = len(payloads) or 1
    capacity_status = "healthy" if elapsed_s <= 900 else ("watch" if elapsed_s <= 1800 else "breached")
    capacity_contract = {
        "schema_version": "pipeline-modal-capacity-v1",
        "status": capacity_status,
        "input_count": len(payloads),
        "max_symbols": 2000,
        "feature_chunk_size": feature_chunk_size,
        "feature_chunk_count": math.ceil(len(payloads) / feature_chunk_size) if payloads else 0,
        "feature_symbols_per_sec": round(len(payloads) / feature_wall_sec, 3) if feature_wall_sec > 0 else None,
        "bundle_timeout_sec": 3600,
        "bundle_elapsed_sec": elapsed_s,
        "timeout_headroom_ratio": round(3600 / elapsed_s, 3) if elapsed_s > 0 else None,
        "request_transport": payload.get("request_transport") or {
            "schema_version": "pipeline-modal-inline-request-v1"
        },
    }
    bundle = {
        "schema_version": "pipeline-modal-prediction-bundle-v1",
        "run_date": payload.get("run_date"),
        "run_id": payload.get("run_id"),
        "state_gcs_uri": payload.get("state_gcs_uri"),
        "serving_manifest_digest": serving_manifest_digest,
        "slot_artifact_identities": slot_identities,
        "active_artifact_identities": serving_identities,
        "active8_shadow_artifact_identities": active8_shadow_identities,
        "active_artifact_versions": serving_versions,
        "serving_coverage": coverage,
        "modal_source_sha": modal_source_sha,
        "elapsed_s": elapsed_s,
        "predict_batch_v2_results": (outputs.get("predict_batch_v2") or {}).get("results") if isinstance(outputs.get("predict_batch_v2"), dict) else (outputs.get("predict_batch_v2") or []),
        "predict_batch_v2_raw": outputs.get("predict_batch_v2") or {},
        "gnn_graphsage_raw": outputs.get("gnn_graphsage_universal_predict") or {"results": []},
        "dlinear_raw": outputs.get("dlinear_universal_predict") or {"results": []},
        "patchtst_raw": outputs.get("patchtst_universal_predict") or {"results": []},
        "itransformer_raw": outputs.get("itransformer_universal_predict") or {"results": []},
        "state_space_raw": outputs.get("state_space_universal_predict") or {"results": []},
        "active8_sequence_shadow_raw": outputs.get("active8_sequence_shadow_predict")
        or {
            "schema_version": "active8-sequence-shadow-bundle-v1",
            "production_effect": False,
            "vote_weight": 0.0,
            "candidates": {},
        },
        "stage_timings": timings,
        "sequence_dataset": payload.get("sequence_dataset_meta") or {},
        "sequence_input_contract": payload.get("sequence_input_contract") or {},
        "n_input": len(payloads),
        "capacity_contract": capacity_contract,
        "request_transport": payload.get("request_transport") or {},
    }
    bundle["durable_handoff"] = _persist_pipeline_prediction_bundle(payload, bundle)
    callback_status = _post_pipeline_prediction_callback(payload, bundle, elapsed_s)


    bundle["callback_status"] = callback_status
    return bundle
@app.function(
    cpu=4,
    memory=8192,
    timeout=3600,
    min_containers=0,
    scaledown_window=900,
    max_containers=2,
)
def pipeline_prediction_bundle(payload: dict) -> dict:
    """Run Modal predictions and always close the parent pipeline on terminal failure."""
    import time

    started = time.time()
    callback_payload = payload or {}
    try:
        # Hydration reads the generation-bound request artifact from GCS, so
        # initialize the Modal GCS credential contract before that first read.
        _setup_env()
        hydrated_payload = _hydrate_pipeline_prediction_request_reference(callback_payload)
        callback_payload = hydrated_payload
        return _pipeline_prediction_bundle_impl(hydrated_payload)
    except Exception as exc:
        callback = _post_pipeline_prediction_error_callback(
            callback_payload,
            exc,
            round(time.time() - started, 3),
        )
        if callback.get("status") != "ok":
            raise RuntimeError(f"pipeline_modal_error_callback_unclosed:{callback}") from exc
        raise




@app.function(
    cpu=1,
    memory=2048,
    timeout=300,
    min_containers=0,
    scaledown_window=900,
    max_containers=2,
)
def strategy_similarity_evidence(payload: dict) -> dict:
    """L1.25 strategy similarity graph evidence owned by Modal/Python."""
    _setup_env()
    from app.strategy_similarity_evidence import build_strategy_similarity_evidence

    return build_strategy_similarity_evidence(payload or {})


@app.function(
    cpu=2,
    memory=8192,
    timeout=900,
    min_containers=0,
    scaledown_window=900,
    max_containers=1,
)
def gnn_graphsage_universal_predict(payload: dict) -> dict:
    """Full-universe GraphSAGE prediction for the GNN alpha family."""
    _setup_env()
    from app.batch_prediction import predict_gnn_graphsage_batch

    return predict_gnn_graphsage_batch(payload.get("payloads") or [])


@app.function(
    cpu=4,
    memory=16384,
    gpu="L4",
    timeout=7200,
    scaledown_window=60,
    max_containers=1,
)
def train_gnn_graphsage_universal(payload: dict) -> dict:
    """Formal GraphSAGE artifact training and model_pool registration."""
    _setup_env()
    from app.gnn_training import train_graphsage_universal

    return train_graphsage_universal(payload or {})


@app.function(
    cpu=4,
    memory=16384,
    gpu="L4",
    timeout=7200,
    scaledown_window=60,
    max_containers=1,
)
def train_tabm_universal(payload: dict) -> dict:
    """Formal TabM torch artifact training and model_pool registration."""
    _setup_env()
    from app.tabm_training import train_tabm_universal as _train_tabm_universal

    try:
        return _train_tabm_universal(payload or {})
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()[:2000], "type": "train_tabm_universal"}


@app.function(
    cpu=1,
    memory=2048,
    timeout=300,
    scaledown_window=60,
    max_containers=10,
)
def retrain_single_stock(payload: dict) -> dict:
    """Retrain a single stock in pure compute mode."""
    _setup_env()
    from app.use_cases import retrain_stock, PredictRequest
    try:
        req = PredictRequest(**payload)
        return retrain_stock(req)
    except Exception as e:
        return {
            "stock_id": payload.get("stock_id", 0),
            "symbol": payload.get("symbol", "?"),
            "error": str(e),
        }


@app.function(
    cpu=1,
    memory=2048,                 # prep: build_feature_matrix for batch payloads.
    timeout=600,                 # 10 min per batch
    scaledown_window=60,
    max_containers=3,            # Parallel prep batches.
)
def prep_universal_batch(payload: dict) -> dict:
    """Prepare universal feature batch and persist npz artifacts."""
    _setup_env()
    from app.use_cases import prep_universal_batch as _prep, UniversalPrepRequest
    try:
        req = UniversalPrepRequest(**payload)
        return _prep(req)
    except Exception as e:
        return {"error": str(e), "batch_index": payload.get("batch_index", -1)}


@app.function(
    gpu="L4",                    # Sequence training can use GPU; tree-only groups run in CPU split jobs.
    memory=4096,
    timeout=7200,
    scaledown_window=60,
    max_containers=1,
)
def train_universal_from_gcs(payload: dict) -> dict:
    """Train all universal models from prepared GCS batches.

    Compatibility single-container path for Cloud Run direct train calls.
    """
    _setup_env()
    from app.use_cases import train_universal_from_gcs as _train, UniversalTrainRequest
    try:
        req = UniversalTrainRequest(**payload)
        train_result = _train(req)
    except Exception as e:
        return {"error": str(e), "type": "universal"}

    # Auto-trigger SHAP dashboard (Modal internal, no Cloud Run dependency)
    auto_audit = payload.get("auto_audit", True)
    if auto_audit and "error" not in train_result:
        try:
            shap_mode = str(
                payload.get("shap_audit_mode")
                or os.environ.get("UNIVERSAL_SHAP_AUDIT_MODE", "deferred")
            ).strip().lower()
            print(f"[TrainUniversal] Auto-triggering SHAP dashboard audit mode={shap_mode}...")
            if shap_mode == "inline":
                shap_result = shap_feature_audit.remote({"shap_samples": 10000})
                train_result["shap_result"] = shap_result
                print(f"[TrainUniversal] SHAP done: {shap_result.get('keep_count', '?')} features kept")
            else:
                shap_feature_audit.spawn({"shap_samples": 10000})
                train_result["shap_result"] = {"status": "deferred", "mode": "spawn"}
        except Exception as e:
            print(f"[TrainUniversal] SHAP auto-trigger failed (non-blocking): {e}")
            train_result["shap_error"] = str(e)

    return train_result


# Split training: tree models run on CPU; sequence models use their own artifact paths.

@app.function(
    cpu=2,
    memory=4096,
    timeout=5400,
    scaledown_window=60,
    max_containers=4,
)
def train_tree_model(payload: dict) -> dict:
    """CPU-only: one governed tree ensemble member for opt-in fan-out."""
    _setup_env()
    from app.use_cases import train_universal_from_gcs as _train, UniversalTrainRequest
    try:
        req = UniversalTrainRequest(**payload)
        return _train(req)
    except Exception as e:
        return {
            "error": str(e),
            "type": "tree_model",
            "tree_split_model": payload.get("tree_split_model"),
        }


@app.function(
    cpu=1,
    memory=1024,
    timeout=1800,
    scaledown_window=60,
    max_containers=2,
)
def train_tree_models_split_parent(payload: dict) -> dict:
    """Low-memory reducer for split tree retrain children."""
    _setup_env()
    from app.training_finalizer import reduce_tree_model_child_results
    from app.training_policy import build_tree_model_child_payloads
    try:
        child_payloads = build_tree_model_child_payloads(payload)
        print(
            "[TrainTreeSplitParent] spawning children="
            f"{list(child_payloads.keys())} version={payload.get('output_model_version')}"
        )
        handles = {
            model_name: train_tree_model.spawn(child_payload)
            for model_name, child_payload in child_payloads.items()
        }
        child_results = {
            model_name: handle.get()
            for model_name, handle in handles.items()
        }
        combined_artifact, artifact_error = _combine_tree_child_oos_artifacts(child_results, payload)
        reduced = reduce_tree_model_child_results(
            child_results,
            combined_oos_artifact=combined_artifact,
            oos_artifact_error=artifact_error,
        )
        print(
            "[TrainTreeSplitParent] reduced children="
            f"{list(child_results.keys())} error={reduced.get('error')}"
        )
        return reduced
    except Exception as e:
        return {"error": str(e), "type": "tree_models_split_parent"}


@app.function(
    cpu=2,
    memory=4096,
    timeout=5400,                # 90 min for four tree models sequentially on CPU.
    scaledown_window=60,
    max_containers=1,
)
def train_tree_models(payload: dict) -> dict:
    """CPU-only: LightGBM + XGBoost + ExtraTrees."""
    _setup_env()
    from app.use_cases import train_universal_from_gcs as _train, UniversalTrainRequest
    from app.training_finalizer import reduce_tree_model_child_results
    from app.training_policy import build_group_train_payload, build_tree_model_child_payloads
    try:
        if _tree_model_split_enabled(payload):
            child_payloads = build_tree_model_child_payloads(payload)
            handles = {
                model_name: train_tree_model.spawn(child_payload)
                for model_name, child_payload in child_payloads.items()
            }
            child_results = {
                model_name: handle.get()
                for model_name, handle in handles.items()
            }
            combined_artifact, artifact_error = _combine_tree_child_oos_artifacts(child_results, payload)
            return reduce_tree_model_child_results(
                child_results,
                combined_oos_artifact=combined_artifact,
                oos_artifact_error=artifact_error,
            )
        req = UniversalTrainRequest(**build_group_train_payload(payload, "tree"))
        return _train(req)
    except Exception as e:
        return {"error": str(e), "type": "tree_models"}


@app.function(
    cpu=2,
    memory=4096,
    timeout=3600,   # 60 min per window for tree models on short train windows.
    scaledown_window=60,
    max_containers=3,   # allow 3 windows in parallel for tree path
)
def train_wf_tree_window(payload: dict) -> dict:
    """CPU-only walk-forward: LightGBM + XGBoost + ExtraTrees for one window.

    payload: window_id, train_start, train_end, test_start, test_end, batch_count,
             feature_pool_path (2026-04-19 N2: per-window pool to eliminate look-ahead)
    """
    _setup_env()
    from app.use_cases import train_universal_from_gcs as _train, UniversalTrainRequest
    try:
        gcs_prefix = str(payload.get("prep_gcs_prefix") or "universal").strip().rstrip("/")
        # 2026-04-19 N2: default to per-window pool path; orchestrator now writes
        # {gcs_prefix}/feature_pool.json before calling this fn.
        feature_pool_path = payload.get("feature_pool_path") or f"{gcs_prefix}/feature_pool.json"
        req = UniversalTrainRequest(
            batch_count=payload.get("batch_count", 5),
            models_filter=["XGBoost", "ExtraTrees", "LightGBM"],
            skip_feature_pool=payload.get("skip_feature_pool", False),
            train_start=payload["train_start"],
            train_end=payload["train_end"],
            test_start=payload["test_start"],
            test_end=payload["test_end"],
            gcs_prefix=gcs_prefix,
            window_id=payload["window_id"],
            skip_weekly_backup=True,
            feature_pool_path=feature_pool_path,
            generation_mode=str(payload.get("generation_mode") or "native"),
            cohort_id=payload.get("cohort_id"),
            fold_id=str(payload.get("fold_id") or payload.get("window_id") or ""),
            output_model_version=payload.get("output_model_version"),
        )
        return _train(req)
    except Exception as e:
        import traceback
        return {
            "error": str(e),
            "trace": traceback.format_exc()[:2000],
            "window_id": payload.get("window_id"),
            "type": "wf_tree",
        }


@app.function(
    cpu=1,
    memory=2048,
    timeout=300,   # 5 min for market-level HMM.
    scaledown_window=60,
    max_containers=3,
)
def train_wf_hmm_window(payload: dict) -> dict:
    """Train HMM on historical window and save snapshot to walk_forward/w{id}/."""
    _setup_env()
    from app.regime import RegimeDetector, build_market_feature_matrix
    try:
        window_id = payload["window_id"]
        train_end = payload["train_end"]
        market_env = payload["market_env"]

        feat_mat = build_market_feature_matrix(market_env)
        if feat_mat is None or len(feat_mat) < 30:
            return {
                "error": f"insufficient history: got {len(feat_mat) if feat_mat is not None else 0}, need >=30",
                "window_id": window_id,
            }

        detector = RegimeDetector().fit(feat_mat)
        if not detector._trained:
            return {"error": "HMM fit did not converge", "window_id": window_id}

        gcs_prefix = f"walk_forward/w{window_id}"
        saved = detector.save_to_gcs(
            gcs_prefix=gcs_prefix,
            extra_metadata={
                "window_id": window_id,
                "train_end": train_end,
                "history_days": len(feat_mat),
            },
        )
        return {
            "window_id": window_id,
            "gcs_prefix": gcs_prefix,
            "n_components": detector.n_components,
            "history_days": len(feat_mat),
            "saved": saved,
        }
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()[:2000], "window_id": payload.get("window_id")}


def _load_verified_oof_resume_windows(
    payload: dict,
    *,
    bucket,
    requested_windows: list[dict],
    models: list[str],
) -> tuple[dict[int, dict], dict | None]:
    """Verify parent fold artifacts before any retraining is spawned."""
    resume_path = str(payload.get("resume_manifest_path") or "").strip()
    if not resume_path:
        return {}, None

    import hashlib
    import io
    import json
    import numpy as np

    parent_raw = bucket.blob(resume_path).download_as_bytes()
    parent = json.loads(parent_raw.decode("utf-8"))
    unsigned = {key: value for key, value in parent.items() if key != "manifest_checksum"}
    expected_manifest_checksum = hashlib.sha256(
        json.dumps(unsigned, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()
    if parent.get("schema_version") != "active8-oof-cohort-manifest-v5":
        raise ValueError("active8_oof_resume_manifest_schema_invalid")
    if parent.get("manifest_checksum") != expected_manifest_checksum:
        raise ValueError("active8_oof_resume_manifest_checksum_mismatch")
    if parent.get("status") != "ready" or parent.get("generation_mode") != "purged_oof":
        raise ValueError("active8_oof_resume_manifest_not_ready")
    if list(parent.get("model_set") or []) != list(models):
        raise ValueError("active8_oof_resume_model_set_mismatch")
    expected_target = "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
    expected_feature_semantic = "formal137-pit-rolling-rank-and-imputation-v2"
    expected_imputation_semantic = "prior_252_row_median_then_zero_v2"
    producer_source_sha = str(os.environ.get("STOCKVISION_SOURCE_SHA") or "").strip().lower()
    if len(producer_source_sha) != 40 or any(char not in "0123456789abcdef" for char in producer_source_sha):
        raise ValueError("active8_oof_resume_source_sha_missing")
    prep_lineage = parent.get("prep_manifest") or {}
    if (
        prep_lineage.get("feature_semantic_version") != expected_feature_semantic
        or prep_lineage.get("feature_imputation_semantic") != expected_imputation_semantic
        or prep_lineage.get("producer_source_sha") != producer_source_sha
    ):
        raise ValueError("active8_oof_resume_feature_lineage_mismatch")
    if parent.get("target_semantic_version") != expected_target:
        raise ValueError("active8_oof_resume_target_semantic_mismatch")
    if parent.get("score_semantic_version") != "same-market-same-date-average-tie-percentile-rank-v2":
        raise ValueError("active8_oof_resume_score_semantic_mismatch")
    parent_prep_prefix = str(parent.get("prep_gcs_prefix") or "").rstrip("/")
    parent_prep_checksum = str((parent.get("prep_manifest") or {}).get("manifest_checksum") or "")
    parent_sequence_prefix = str(parent.get("sequence_gcs_prefix") or "").rstrip("/")
    parent_sequence_checksum = str((parent.get("sequence_manifest") or {}).get("artifact_checksum") or "")
    if (
        not parent_prep_prefix
        or len(parent_prep_checksum) != 64
        or not parent_sequence_prefix
        or len(parent_sequence_checksum) != 64
    ):
        raise ValueError("active8_oof_resume_parent_input_lineage_missing")

    requested_by_split = {
        (
            str(window["train_start"]), str(window["train_end"]),
            str(window["test_start"]), str(window["test_end"]),
        ): window
        for window in requested_windows
    }
    reused: dict[int, dict] = {}
    parent_cohort_id = str(parent.get("cohort_id") or "")
    parent_manifest_checksum = str(parent["manifest_checksum"])
    for parent_window in parent.get("windows") or []:
        train_range = list(parent_window.get("train_range") or [None, None])
        test_range = list(parent_window.get("test_range") or [None, None])
        split = tuple(str(value or "") for value in (*train_range, *test_range))
        requested = requested_by_split.get(split)
        if requested is None:
            raise ValueError(f"active8_oof_resume_fold_split_mismatch:{split}")
        window_id = int(requested["window_id"])
        fold_id = f"w{window_id}"
        source_fold_id = str(
            parent_window.get("source_fold_id") or f"w{int(parent_window['window_id'])}"
        )
        source_cohort_id = str(parent_window.get("source_cohort_id") or parent_cohort_id)
        source_manifest_checksum = str(
            parent_window.get("source_manifest_checksum") or parent_manifest_checksum
        )
        metrics = parent_window.get("model_metrics") or {}
        for model_name in models:
            model = metrics.get(model_name) or {}
            artifact_path = str(model.get("oof_artifact") or "")
            artifact_checksum = str(model.get("artifact_checksum") or "")
            if model.get("status") != "ready" or not artifact_path or len(artifact_checksum) != 64:
                raise ValueError(f"active8_oof_resume_model_missing:{fold_id}:{model_name}")
            try:
                coverage = float(model.get("coverage"))
            except (TypeError, ValueError):
                raise ValueError(
                    f"active8_oof_resume_coverage_missing:{fold_id}:{model_name}"
                ) from None
            if not math.isfinite(coverage) or coverage < 0.0 or coverage > 1.0:
                raise ValueError(
                    f"active8_oof_resume_coverage_invalid:{fold_id}:{model_name}"
                )
            coverage_semantics = str(
                model.get("coverage_gate_semantics") or ""
            ).strip()
            coverage_mode = str(model.get("coverage_mode") or "").strip()
            if not coverage_semantics or coverage_semantics == "unspecified":
                raise ValueError(
                    f"active8_oof_resume_coverage_semantics_missing:{fold_id}:{model_name}"
                )
            if not coverage_mode:
                raise ValueError(
                    f"active8_oof_resume_coverage_mode_missing:{fold_id}:{model_name}"
                )
            artifact_raw = bucket.blob(artifact_path).download_as_bytes()
            if hashlib.sha256(artifact_raw).hexdigest() != artifact_checksum:
                raise ValueError(f"active8_oof_resume_artifact_checksum_mismatch:{fold_id}:{model_name}")
            artifact = np.load(io.BytesIO(artifact_raw), allow_pickle=True)
            metadata = json.loads(str(artifact["metadata"].item()))
            expected_metadata = {
                "schema_version": "active8-oof-predictions-v2",
                "generation_mode": "purged_oof",
                "feature_semantic_version": expected_feature_semantic,
                "feature_imputation_semantic": expected_imputation_semantic,
                "producer_source_sha": producer_source_sha,
                "cohort_id": source_cohort_id,
                "fold_id": source_fold_id,
                "model_name": model_name,
                "target_semantic_version": expected_target,
            }
            for key, value in expected_metadata.items():
                if metadata.get(key) != value:
                    raise ValueError(
                        f"active8_oof_resume_artifact_metadata_mismatch:{fold_id}:{model_name}:{key}"
                    )
        reused_window = json.loads(json.dumps(parent_window, default=str))
        reused_window["window_id"] = window_id
        reused_window["source_fold_id"] = source_fold_id
        reused_window["source_cohort_id"] = source_cohort_id
        reused_window["source_manifest_checksum"] = source_manifest_checksum
        reused_window["source_prep_gcs_prefix"] = str(
            parent_window.get("source_prep_gcs_prefix") or parent_prep_prefix
        )
        reused_window["source_prep_manifest_checksum"] = str(
            parent_window.get("source_prep_manifest_checksum") or parent_prep_checksum
        )
        reused_window["source_sequence_gcs_prefix"] = str(
            parent_window.get("source_sequence_gcs_prefix") or parent_sequence_prefix
        )
        reused_window["source_sequence_manifest_checksum"] = str(
            parent_window.get("source_sequence_manifest_checksum") or parent_sequence_checksum
        )
        reused_window["reused_from_parent"] = True
        reused[window_id] = reused_window

    return reused, {
        "path": resume_path,
        "cohort_id": parent_cohort_id,
        "checksum": parent_manifest_checksum,
        "verified_fold_ids": sorted(reused),
        "verification": "split_model_semantic_artifact_sha256_metadata_v1",
    }

def _oof_coverage_contract(model_cpcv: object) -> dict | None:
    if not isinstance(model_cpcv, dict):
        return None
    raw = model_cpcv.get("coverage_gate_value")
    semantics = str(model_cpcv.get("coverage_gate_semantics") or "").strip()
    if raw is None:
        raw = model_cpcv.get("coverage_mean")
        semantics = semantics or "coverage_mean"
    try:
        coverage = float(raw)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(coverage) or coverage < 0.0 or coverage > 1.0:
        return None
    policy = model_cpcv.get("policy")
    policy = policy if isinstance(policy, dict) else {}
    coverage_mode = str(policy.get("coverage_mode") or "").strip()
    if not semantics or semantics == "unspecified" or not coverage_mode:
        return None
    return {
        "coverage": coverage,
        "coverage_gate_semantics": semantics,
        "coverage_mode": coverage_mode,
    }


@app.function(
    cpu=1,
    memory=2048,
    timeout=28800,   # 8 hour cap after adding per-window feature selection.
                     # 14 windows * max(FS/train) / concurrent=2 needs multi-hour headroom.
                     # 8hr gives headroom for FS variance + late SHAP audit
    scaledown_window=60,
    max_containers=1,   # only one orchestrator at a time
)
def walk_forward_orchestrator(payload: dict) -> dict:
    """Walk-forward orchestrator for active-8 coverage across windows.

    Every Active-8 model is retrained inside each purged fold and must publish
    immutable OOF predictions with symbol/date/label-known lineage.

    payload:
        windows: list of {window_id, train_start, train_end, test_start, test_end}
        market_env: dict (full history; each window filters locally)
        batch_count: int - number of prep batches.
        models: list[str]
        concurrent_windows: int (default 2)
        start_date: str (for GCS path)
        end_date: str

    Returns: {gcs_path, aggregate}
    Fire-and-forget: ml-controller calls .spawn() and returns immediately.
    """
    _setup_env()
    import time
    import json
    import asyncio
    from app.model_pool import ALPHA_PREDICTION_MODELS

    t0 = time.time()
    windows = payload["windows"]
    market_env = payload["market_env"]
    batch_count = payload.get("batch_count", 5)
    active8_models = list(ALPHA_PREDICTION_MODELS)
    native_retrain_models = list(active8_models)
    raw_models = payload.get("models") or active8_models
    models = []
    for model in raw_models:
        name = str(model or "").strip()
        if name and name not in models:
            models.append(name)
    model_coverage = {
        "schema_version": "walk-forward-active8-coverage-v1",
        "requested_models": models,
        "active8_models": active8_models,
        "native_retrain_models": [m for m in models if m in native_retrain_models],
        "artifact_lifecycle_required_models": [],
        "unsupported_models": [m for m in models if m not in active8_models],
        "coverage_mode": (
            "unsupported_models_requested"
            if any(m not in active8_models for m in models)
            else "active8_purged_oof_retrain"
        ),
    }
    concurrent = int(payload.get("concurrent_windows", 2))
    start_date = payload["start_date"]
    end_date = payload["end_date"]
    generation_mode = "purged_oof"
    cohort_id = str(payload.get("cohort_id") or f"active8-oof-{start_date}-{end_date}")

    # Fail before spawning expensive fold jobs when the shared prep artifact is
    # from the legacy era and cannot identify executable OOF outcomes.
    try:
        import io as _io
        import numpy as _np
        from google.cloud import storage as _storage

        prep_prefix = str(payload.get("prep_gcs_prefix") or "universal").strip().rstrip("/")
        prep_bucket = _storage.Client().bucket(_get_gcs_bucket_name())
        import hashlib as _hashlib
        from app.features import FEATURE_IMPUTATION_SEMANTIC_VERSION, FEATURE_SEMANTIC_VERSION

        producer_source_sha = str(os.environ.get("STOCKVISION_SOURCE_SHA") or "").strip().lower()
        if len(producer_source_sha) != 40 or any(char not in "0123456789abcdef" for char in producer_source_sha):
            raise ValueError("active8_oof_source_sha_missing")

        prep_manifest_path = f"{prep_prefix}/prep/manifest.json"
        prep_manifest = json.loads(
            prep_bucket.blob(prep_manifest_path).download_as_text().lstrip("\ufeff")
        )
        prep_unsigned = {
            key: value for key, value in prep_manifest.items() if key != "manifest_checksum"
        }
        prep_manifest_checksum = _hashlib.sha256(
            json.dumps(prep_unsigned, sort_keys=True).encode("utf-8")
        ).hexdigest()
        if (
            prep_manifest.get("schema_version") != "active8-canonical-adjusted-prep-v3"
            or prep_manifest.get("status") != "ready"
            or prep_manifest.get("feature_semantic_version") != FEATURE_SEMANTIC_VERSION
            or prep_manifest.get("feature_imputation_semantic") != FEATURE_IMPUTATION_SEMANTIC_VERSION
            or prep_manifest.get("producer_source_sha") != producer_source_sha
            or prep_manifest.get("output_gcs_prefix") != prep_prefix
            or prep_manifest.get("manifest_checksum") != prep_manifest_checksum
            or prep_manifest.get("target_semantic_version")
            != "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
            or float(prep_manifest.get("roundtrip_cost_bps") or 0.0) != 18.0
        ):
            raise ValueError("active8_oof_prep_manifest_contract_invalid")
        batch_rows = [int(value) for value in (prep_manifest.get("batch_rows") or [])]
        output_checksums = dict(prep_manifest.get("output_checksums") or {})
        expected_paths = [f"{prep_prefix}/prep/batch_{idx}.npz" for idx in range(len(batch_rows))]
        if (
            not batch_rows
            or len(batch_rows) != int(batch_count)
            or sum(batch_rows) != int(prep_manifest.get("output_rows") or 0)
            or sorted(output_checksums) != sorted(expected_paths)
        ):
            raise ValueError("active8_oof_prep_batch_inventory_invalid")
        for path in expected_paths:
            raw = prep_bucket.blob(path).download_as_bytes()
            if _hashlib.sha256(raw).hexdigest() != str(output_checksums.get(path) or ""):
                raise ValueError(f"active8_oof_prep_batch_checksum_mismatch:{path}")
        prep_manifest_evidence = {
            "path": prep_manifest_path,
            "manifest_checksum": prep_manifest_checksum,
            "schema_version": prep_manifest["schema_version"],
            "output_rows": int(prep_manifest.get("output_rows") or 0),
            "batch_count": len(batch_rows),
            "target_semantic_version": prep_manifest["target_semantic_version"],
            "feature_semantic_version": prep_manifest["feature_semantic_version"],
            "feature_imputation_semantic": prep_manifest["feature_imputation_semantic"],
            "producer_source_sha": prep_manifest["producer_source_sha"],
            "roundtrip_cost_bps": float(prep_manifest["roundtrip_cost_bps"]),
            "verification": "manifest_and_all_batch_sha256_v1",
        }
        prep_blob = prep_bucket.blob(f"{prep_prefix}/prep/batch_0.npz")
        if not prep_blob.exists():
            raise ValueError("active8_oof_prep_batch_missing")
        prep_npz = _np.load(_io.BytesIO(prep_blob.download_as_bytes()), allow_pickle=True)
        required_arrays = {
            "X", "y", "target_returns", "dates", "symbols", "markets",
            "label_known_dates",
        }
        missing_arrays = sorted(required_arrays - set(prep_npz.files))
        if missing_arrays:
            raise ValueError(f"active8_oof_prep_lineage_missing:{','.join(missing_arrays)}")
        sequence_prefix = str(
            payload.get("sequence_gcs_prefix") or "universal/sequence_long/latest"
        ).strip().rstrip("/")
        sequence_batch_count = int(payload.get("sequence_batch_count") or 0)
        sequence_manifest_path = f"{sequence_prefix}/prep/sequence_manifest.json"
        sequence_manifest_raw = prep_bucket.blob(sequence_manifest_path).download_as_bytes()
        sequence_manifest = json.loads(sequence_manifest_raw.decode("utf-8").lstrip("\ufeff"))
        if (
            sequence_batch_count < 1
            or sequence_manifest.get("contract") != "sequence_records_v3"
            or sequence_manifest.get("target_semantic_version")
            != "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
            or str(sequence_manifest.get("output_gcs_prefix") or "").rstrip("/")
            != sequence_prefix
        ):
            raise ValueError("active8_oof_sequence_manifest_contract_invalid")
        sequence_batch_checksums = {}
        valid_sequence_records = 0
        for index in range(sequence_batch_count):
            path = f"{sequence_prefix}/prep/batch_{index}.npz"
            raw = prep_bucket.blob(path).download_as_bytes()
            sequence_batch_checksums[path] = _hashlib.sha256(raw).hexdigest()
            sequence_npz = _np.load(_io.BytesIO(raw), allow_pickle=True)
            if "sequence_records" not in sequence_npz.files:
                raise ValueError(f"active8_oof_sequence_v3_records_missing:{path}")
            valid_sequence_records += sum(
                1 for record in list(sequence_npz["sequence_records"])
                if isinstance(record, dict)
                and record.get("symbol")
                and len(record.get("dates") or [])
                == len(record.get("open") or [])
                == len(record.get("close") or [])
                and record.get("target_semantic_version")
                == "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
            )
        if valid_sequence_records < 10:
            raise ValueError("active8_oof_sequence_records_v3_insufficient")
        sequence_manifest_evidence = {
            "path": sequence_manifest_path,
            "artifact_checksum": _hashlib.sha256(sequence_manifest_raw).hexdigest(),
            "schema_version": sequence_manifest.get("schema_version"),
            "contract": sequence_manifest["contract"],
            "target_semantic_version": sequence_manifest["target_semantic_version"],
            "batch_count": sequence_batch_count,
            "batch_checksums": sequence_batch_checksums,
            "valid_records": valid_sequence_records,
            "verification": "manifest_bytes_and_all_batch_sha256_v1",
        }
    except Exception as exc:
        return {
            "status": "failed_preflight",
            "error": str(exc),
            "cohort_id": cohort_id,
            "required_action": "rebuild_universal_prep_with_active8_oof_lineage_v1",
        }

    try:
        reused_windows, parent_manifest = _load_verified_oof_resume_windows(
            payload,
            bucket=prep_bucket,
            requested_windows=windows,
            models=models,
        )
    except Exception as exc:
        return {
            "status": "failed_preflight",
            "error": str(exc),
            "cohort_id": cohort_id,
            "required_action": "repair_or_remove_invalid_resume_manifest",
        }
    try:
        from app.oof_artifact_recovery import recover_completed_oof_windows

        recoverable_windows = [
            window for window in windows if int(window["window_id"]) not in reused_windows
        ]
        artifact_recovered = recover_completed_oof_windows(
            bucket=prep_bucket,
            requested_windows=recoverable_windows,
            models=models,
            cohort_id=cohort_id,
            prep_prefix=prep_prefix,
            prep_manifest_checksum=prep_manifest_checksum,
            sequence_prefix=sequence_prefix,
            sequence_manifest_checksum=sequence_manifest_evidence["artifact_checksum"],
            model_coverage=model_coverage,
        )
        reused_windows.update(artifact_recovered)
    except Exception as exc:
        return {
            "status": "failed_preflight",
            "error": str(exc),
            "cohort_id": cohort_id,
            "required_action": "repair_corrupt_exact_fold_artifacts",
        }
    pending_windows = [
        window for window in windows if int(window["window_id"]) not in reused_windows
    ]

    def _filter_env(end_str: str) -> dict:
        hist = market_env.get("history", {})
        filtered = {d: v for d, v in hist.items() if d <= end_str}
        if not filtered:
            return market_env
        latest_date = max(filtered.keys())
        return {"history": filtered, **filtered[latest_date]}

    # 2026-04-19 N2: per-window FS gates tree training to eliminate look-ahead
    fs_max_rounds = int(payload.get("fs_max_rounds", 60))
    fs_force_refresh = bool(payload.get("fs_force_refresh", False))

    async def _run_one(window: dict) -> dict:
        """Run feature selection, HMM, and tree training for one window."""
        wid = window["window_id"]
        gcs_prefix = f"walk_forward/oof_cohorts/{cohort_id}/w{wid}"
        result = {
            "window_id": wid,
            "train_range": [window["train_start"], window["train_end"]],
            "test_range": [window["test_start"], window["test_end"]],
            "model_metrics": {},
            "model_coverage": model_coverage,
            "source_prep_gcs_prefix": prep_prefix,
            "source_prep_manifest_checksum": prep_manifest_checksum,
            "source_sequence_gcs_prefix": sequence_prefix,
            "source_sequence_manifest_checksum": sequence_manifest_evidence["artifact_checksum"],
        }

        for model_name in model_coverage["unsupported_models"]:
            result["model_metrics"][model_name] = {
                "status": "unsupported",
                "oos_ic": None,
                "reason": "model_not_in_active8_walk_forward_contract",
            }

        # Step 0: per-window feature selection prevents future leakage in the tree path.
        # Tree training requires this pool for the same window.
        fs_ok = False
        try:
            fs_payload = {
                "window_id": wid,
                "train_end_date": window["train_end"],
                "gcs_prefix": gcs_prefix,
                "prep_gcs_prefix": str(payload.get("prep_gcs_prefix") or "universal"),
                "max_rounds": fs_max_rounds,
                "force_refresh": fs_force_refresh,
            }
            fs_result = await feature_selection_per_window.remote.aio(fs_payload)
            result["fs_result"] = fs_result
            fs_ok = not bool(fs_result.get("error"))
            if fs_ok:
                pool_summary = (
                    fs_result.get("feature_pool", {}).get("tree_active")
                    or fs_result.get("feature_pool", {}).get("active")
                    or []
                )
                if not pool_summary and fs_result.get("skipped"):
                    pool_summary = [None] * (fs_result.get("tree_active_count") or 0)
                result["fs_tree_active_count"] = len(pool_summary)
            else:
                print(f"[WF-Orchestrator] w{wid} FS failed: {fs_result.get('error')} -> tree blocked")
        except Exception as e:
            print(f"[WF-Orchestrator] w{wid} FS crashed: {e}")
            result["fs_result"] = {"error": str(e)}

        # Step 1: HMM
        try:
            hmm_payload = {
                "window_id": wid,
                "train_end": window["train_end"],
                "market_env": _filter_env(window["train_end"]),
            }
            result["hmm_result"] = await train_wf_hmm_window.remote.aio(hmm_payload)
        except Exception as e:
            print(f"[WF-Orchestrator] w{wid} HMM crashed: {e}")
            result["hmm_result"] = {"error": str(e)}

        # Step 2+3: active tree family
        train_payload = {
            "window_id": wid,
            "train_start": window["train_start"],
            "train_end": window["train_end"],
            "test_start": window["test_start"],
            "test_end": window["test_end"],
            "batch_count": batch_count,
            "skip_feature_pool": False,
            "generation_mode": generation_mode,
            "cohort_id": cohort_id,
            "fold_id": f"w{wid}",
            "output_model_version": f"{cohort_id}-w{wid}",
            "version": f"{cohort_id}-w{wid}",
            "prep_gcs_prefix": str(payload.get("prep_gcs_prefix") or "universal"),
            "gcs_prefix": str(payload.get("prep_gcs_prefix") or "universal"),
            "sequence_gcs_prefix": str(payload.get("sequence_gcs_prefix") or payload.get("prep_gcs_prefix") or "universal"),
            "sequence_batch_count": int(payload.get("sequence_batch_count") or 5),
            "validation_folds": int(payload.get("sequence_validation_folds") or 8),
            "promote_to_active": False,
            "register_challengers": False,
        }

        requested = set(models)
        need_tree = bool(requested.intersection({"LightGBM", "XGBoost", "ExtraTrees"}))
        tasks = []
        if need_tree:
            if fs_ok:
                tree_payload = dict(train_payload)
                # explicit per-window pool path; train_wf_tree_window also defaults
                # to walk_forward/w{id}/feature_pool.json so this is belt-and-suspenders
                tree_payload["feature_pool_path"] = f"{gcs_prefix}/feature_pool.json"
                tasks.append(("tree", train_wf_tree_window.remote.aio(tree_payload)))
            else:
                result["tree_result"] = {
                    "error": "feature_selection_required",
                    "reason": "per-window feature selection failed or produced no valid pool",
                    "fs_result": result.get("fs_result"),
                }
        family_tasks = (
            ("TabM", train_tabm_universal),
            ("GNN", train_gnn_graphsage_universal),
            ("DLinear", train_dlinear_universal),
            ("PatchTST", train_patchtst_universal),
            ("iTransformer", train_itransformer_universal),
        )
        from services.active8_monthly_model_profiles import monthly_model_payload as active8_model_payload
        for model_name, fn in family_tasks:
            if model_name in requested:
                model_payload = {**train_payload, **active8_model_payload(model_name)}
                tasks.append((model_name, fn.remote.aio(model_payload)))
        if tasks:
            raw = await asyncio.gather(*[t[1] for t in tasks], return_exceptions=True)
            for (kind, _), r in zip(tasks, raw):
                if isinstance(r, BaseException):
                    print(f"[WF-Orchestrator] w{wid} {kind} crashed: {r}")
                    result[f"{kind}_result"] = {"error": str(r)}
                else:
                    result[f"{kind}_result"] = r

        # Consolidate per-model metrics
        for partial in [result.get("tree_result") or {}]:
            if not partial or partial.get("error"):
                continue
            tree_oof = {
                row.get("model_name"): row
                for row in ((partial.get("oos_artifact") or {}).get("individual_artifacts") or [])
            }
            for model_name, m in (partial.get("results") or {}).items():
                if m.get("skipped") or m.get("error"):
                    continue
                artifact = tree_oof.get(model_name) or {}
                coverage = _oof_coverage_contract(m.get("model_cpcv"))
                result["model_metrics"][model_name] = {
                    "status": "ready" if artifact.get("path") and coverage else "failed",
                    "oos_ic": m.get("oos_ic"),
                    "train_samples": m.get("train"),
                    "test_samples": m.get("test"),
                    "oof_artifact": artifact.get("path"),
                    "artifact_checksum": artifact.get("payload_checksum"),
                    **(coverage or {}),
                    "reason": (
                        None if artifact.get("path") and coverage
                        else "oof_coverage_evidence_missing" if artifact.get("path")
                        else "oof_artifact_missing"
                    ),
                }
        for model_name, _fn in family_tasks:
            if model_name not in requested:
                continue
            partial = result.get(f"{model_name}_result") or {}
            tracking = (partial.get("ic_tracking") or {}).get(model_name) or {}
            oof_artifact = partial.get("oof_artifact") or {}
            coverage = _oof_coverage_contract(tracking.get("model_cpcv"))
            if partial.get("error") or not oof_artifact.get("path") or not coverage:
                result["model_metrics"][model_name] = {
                    "status": "failed",
                    "oos_ic": tracking.get("oos_ic"),
                    "reason": (
                        partial.get("error")
                        or ("oof_coverage_evidence_missing" if oof_artifact.get("path") else "oof_artifact_missing")
                    ),
                }
                continue
            result["model_metrics"][model_name] = {
                "status": "ready",
                "oos_ic": tracking.get("oos_ic"),
                "test_samples": tracking.get("oos_samples"),
                "oof_artifact": oof_artifact.get("path"),
                "artifact_checksum": oof_artifact.get("payload_checksum"),
                **coverage,
            }
        from app.oof_forward_source_contract import assess_fold_forward_sources

        missing_models = [
            model_name for model_name in models
            if (result["model_metrics"].get(model_name) or {}).get("status") != "ready"
            or model_name not in result["model_metrics"]
        ]
        forward_source_contract = assess_fold_forward_sources(
            result,
            cohort_id=cohort_id,
        )
        result["forward_source_contract"] = forward_source_contract
        result["fold_blockers"] = list(forward_source_contract["reasons"])
        result["oof_fold_ready"] = not missing_models and forward_source_contract["ready"]
        result["missing_oof_models"] = missing_models
        return result

    async def _orchestrate() -> list[dict]:
        sem = asyncio.Semaphore(concurrent)

        async def _bounded(w):
            async with sem:
                print(f"[WF-Orchestrator] Starting window {w['window_id']}")
                r = await _run_one(w)
                print(f"[WF-Orchestrator] Finished window {w['window_id']} "
                      f"(ic={[(k, v.get('oos_ic')) for k, v in r.get('model_metrics',{}).items()]})")
                return r

        return await asyncio.gather(*[_bounded(w) for w in pending_windows])

    new_results = asyncio.run(_orchestrate())
    new_by_id = {int(row["window_id"]): row for row in new_results}
    all_results = [
        reused_windows.get(int(window["window_id"]))
        or new_by_id[int(window["window_id"])]
        for window in windows
    ]

    # Aggregate
    per_model = {}
    n_err = 0
    for wr in all_results:
        if not wr.get("model_metrics"):
            n_err += 1
            continue
        for mname, m in wr["model_metrics"].items():
            if m.get("oos_ic") is None:
                continue
            per_model.setdefault(mname, []).append(float(m["oos_ic"]))

    summary = {}
    for mname, ics in per_model.items():
        import statistics
        if not ics:
            continue
        summary[mname] = {
            "n_windows": len(ics),
            "mean_ic": sum(ics) / len(ics),
            "std_ic": statistics.stdev(ics) if len(ics) >= 2 else 0.0,
            "min_ic": min(ics),
            "max_ic": max(ics),
            "positive_share": sum(1 for ic in ics if ic > 0) / len(ics),
            "ic_per_window": ics,
        }

    from app.model_validation import build_model_cpcv_evidence
    from app.oof_lineage import oof_date_cluster_rank_ic_from_bytes

    date_ic_cache: dict[str, list[dict]] = {}

    def _date_cluster_ics(path: str) -> list[dict]:
        if path not in date_ic_cache:
            raw = prep_bucket.blob(path).download_as_bytes()
            evidence = oof_date_cluster_rank_ic_from_bytes(raw)
            date_ic_cache[path] = list(evidence.get("date_cluster_ics") or [])
        return date_ic_cache[path]

    per_model_promotion_evidence = {}
    for model_name in active8_models:
        fold_metrics = []
        artifact_contract_gaps = []
        for window_result in all_results:
            metrics = (window_result.get("model_metrics") or {}).get(model_name) or {}
            if metrics.get("oos_ic") is None:
                continue
            artifact_path = str(metrics.get("oof_artifact") or "").strip()
            if metrics.get("status") != "ready" or not artifact_path:
                artifact_contract_gaps.append(f"w{window_result['window_id']}")
                continue
            canonical_date_ics = _date_cluster_ics(artifact_path)
            canonical_fold_ic = (
                sum(float(row["rank_ic"]) for row in canonical_date_ics) / len(canonical_date_ics)
                if canonical_date_ics
                else None
            )
            if canonical_fold_ic is None:
                artifact_contract_gaps.append(f"w{window_result['window_id']}:date_market_ic_missing")
                continue
            fold_metrics.append({
                "fold_id": f"w{window_result['window_id']}",
                "oos_ic": canonical_fold_ic,
                "reported_oos_ic": metrics.get("oos_ic"),
                "test_rows": sum(int(row.get("test_rows") or 0) for row in canonical_date_ics),
                "coverage": float(metrics.get("coverage") or 0.0),
                "coverage_gate_semantics": metrics.get("coverage_gate_semantics"),
                "coverage_mode": metrics.get("coverage_mode"),
                "date_cluster_ics": canonical_date_ics,
                "score_semantic": "same-market-same-date-average-tie-percentile-rank-v2",
            })
        evidence = build_model_cpcv_evidence(
            model=model_name,
            fold_metrics=fold_metrics,
            stage="promotion",
            method="outer_purged_walk_forward_rank_ic",
        )
        if artifact_contract_gaps:
            evidence["decision"] = "FAIL"
            evidence["passed"] = False
            evidence["serving_disposition"] = "FAIL"
            evidence["failed_gates"] = sorted(set([
                *(evidence.get("failed_gates") or []),
                "oof_fold_artifact_contract",
            ]))
            evidence["artifact_contract_gap_folds"] = artifact_contract_gaps
        per_model_promotion_evidence[model_name] = evidence

    # 2026-04-19 N2: aggregate per-window FS stats
    fs_stats = []
    for wr in all_results:
        fs_r = wr.get("fs_result") or {}
        if fs_r.get("error"):
            fs_stats.append({"window_id": wr.get("window_id"), "status": "error", "error": fs_r.get("error")})
        elif fs_r.get("skipped"):
            fs_stats.append({
                "window_id": wr.get("window_id"),
                "status": "cached",
                "tree_active_count": fs_r.get("tree_active_count"),
            })
        elif fs_r:
            pool_active = (
                fs_r.get("feature_pool", {}).get("tree_active")
                or fs_r.get("feature_pool", {}).get("active")
                or []
            )
            fs_stats.append({
                "window_id": wr.get("window_id"),
                "status": "computed",
                "tree_active_count": len(pool_active),
                "elapsed_s": fs_r.get("elapsed_s"),
            })

    aggregate = {
        "n_windows_total": len(all_results),
        "n_windows_errored": n_err,
        "per_model": summary,
        "model_coverage": model_coverage,
        "fs_stats": fs_stats,
        "elapsed_s": round(time.time() - t0, 1),
        "cohort_id": cohort_id,
        "generation_mode": generation_mode,
        "oof_ready_folds": sum(1 for row in all_results if row.get("oof_fold_ready")),
        "oof_failed_folds": [
            row.get("window_id") for row in all_results if not row.get("oof_fold_ready")
        ],
        "reused_fold_ids": sorted(reused_windows),
        "new_fold_ids": sorted(new_by_id),
        "reused_folds": len(reused_windows),
        "new_folds": len(new_by_id),
        "per_model_promotion_evidence": per_model_promotion_evidence,
        "full_fit_eligible_models": [
            model_name
            for model_name, evidence in per_model_promotion_evidence.items()
            if evidence.get("decision") == "PASS"
        ],
        "full_fit_blocked_models": {
            model_name: evidence.get("failed_gates") or []
            for model_name, evidence in per_model_promotion_evidence.items()
            if evidence.get("decision") != "PASS"
        },
    }
    aggregate["oof_cohort_ready"] = (
        aggregate["oof_ready_folds"] == len(all_results)
        and not aggregate["oof_failed_folds"]
        and not model_coverage["unsupported_models"]
        and list(models) == list(active8_models)
    )

    # Persist to GCS
    try:
        from google.cloud import storage
        bucket_name = _get_gcs_bucket_name()
        if not bucket_name:
            raise RuntimeError("GCS bucket not configured")
        bucket = storage.Client().bucket(bucket_name)
        import hashlib
        from app.oof_manifest_publisher import publish_oof_manifest

        manifest = {
            "schema_version": "active8-oof-cohort-manifest-v5",

            "cohort_id": cohort_id,
            "start_date": start_date,
            "end_date": end_date,
            "train_window_days": payload.get("train_window_days", 60),
            "test_window_days": payload.get("test_window_days", 30),
            "generation_mode": generation_mode,
            "target_semantic_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
            "score_semantic_version": "same-market-same-date-average-tie-percentile-rank-v2",
            "model_set": models,
            "prep_gcs_prefix": str(payload.get("prep_gcs_prefix") or "universal"),
            "prep_manifest": prep_manifest_evidence,
            "sequence_gcs_prefix": str(
                payload.get("sequence_gcs_prefix") or "universal/sequence_long/latest"
            ),
            "sequence_batch_count": int(payload.get("sequence_batch_count") or 5),
            "sequence_manifest": sequence_manifest_evidence,
            "model_set_signature": hashlib.sha256("|".join(models).encode("utf-8")).hexdigest(),
            "windows": all_results,
            "parent_manifest": parent_manifest,
            "aggregate": aggregate,
            "status": "ready" if aggregate["oof_cohort_ready"] else "failed",
        }
        publication = publish_oof_manifest(bucket, manifest)
        manifest = publication["manifest"]
        cohort_id = str(manifest["cohort_id"])
        aggregate["cohort_id"] = cohort_id
        gcs_path = str(publication["path"])
        print(
            f"[WF-Orchestrator] Published gs://{bucket.name}/{gcs_path} "
            f"mode={publication['publication_mode']}"
        )
    except Exception as e:
        print(f"[WF-Orchestrator] Persist failed: {e}")
        raise RuntimeError(f"active8_oof_manifest_persist_failed:{e}") from e

    return {
        "gcs_path": gcs_path,
        "aggregate": aggregate,
        "manifest_checksum": manifest["manifest_checksum"],
        "publication_mode": publication["publication_mode"],
        "elapsed_s": round(time.time() - t0, 1),
    }


@app.function(
    gpu="L4",
    memory=4096,
    timeout=1800,                # 30 min for SHAP on selected samples.
    scaledown_window=60,
    max_containers=1,
)
def shap_feature_audit(payload: dict) -> dict:
    """Run SHAP feature importance audit."""
    _setup_env()
    from app.use_cases import run_shap_audit
    try:
        shap_samples = payload.get("shap_samples", 5000)
        return run_shap_audit(shap_samples=shap_samples)
    except Exception as e:
        return {"error": str(e), "type": "shap_audit"}


# Feature Selection Pipeline Modal wrapper.

@app.function(
    cpu=4,                       # Target permutation rounds are CPU-bound.
    memory=8192,                 # Spearman corr + LightGBM on full 960K samples
    timeout=7200,                # 120 min for signal gate, clustering, target permutation, K sweep, and diversity guard.
    scaledown_window=60,
    max_containers=1,
)
def feature_selection_pipeline(payload: dict) -> dict:
    """Run feature selection: signal gate, clustering, target permutation,
    IC/ICIR scoring, Optuna K Pareto sweep, and diversity guard.

    Reads prep .npz from GCS, writes feature_pool.json to GCS.
    """
    _setup_env()
    from app.feature_selection import run_feature_selection_pipeline
    from app.training_policy import FeatureSelectionPolicy, build_feature_selection_run_kwargs
    selection_params = FeatureSelectionPolicy.from_env().to_selection_params(payload)
    try:
        return run_feature_selection_pipeline(
            **build_feature_selection_run_kwargs(selection_params),
            dry_run=payload.get("dry_run", False),
            train_end_date=payload.get("train_end_date"),
            gcs_prefix=payload.get("gcs_prefix"),
        )
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc(), "type": "feature_selection"}


@app.function(
    cpu=2,
    memory=4096,
    timeout=1800,
    scaledown_window=60,
    max_containers=1,
)
def build_finlab_long_sequence_prep(payload: dict) -> dict:
    """Hydrate existing FinLab 3Y/5Y artifacts into sequence-only prep batches."""
    _setup_env()
    from app.long_history_sequence_prep import build_finlab_long_history_sequence_prep

    try:
        return build_finlab_long_history_sequence_prep(payload or {})
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()[:2000], "type": "finlab_long_sequence_prep"}


@app.function(
    cpu=4,
    memory=8192,
    timeout=1800,
    scaledown_window=60,
    max_containers=1,
)
def rebuild_canonical_adjusted_prep(payload: dict) -> dict:
    """Rewrite immutable Active-8 labels/ranks from canonical adjusted FinLab bars."""
    _setup_env()
    from app.canonical_adjusted_prep import rebuild_canonical_adjusted_prep as _rebuild

    try:
        return _rebuild(payload or {})
    except Exception as e:
        import traceback
        return {
            "error": str(e),
            "trace": traceback.format_exc()[:4000],
            "type": "canonical_adjusted_prep",
        }


@app.function(
    cpu=4,
    memory=8192,
    timeout=3600,
    scaledown_window=60,
    max_containers=1,
)
def build_frozen_oof_forward_extension(payload: dict) -> dict:
    """Run immutable forward inference only; no training or promotion."""
    _setup_env()
    from app.oof_forward_extension import build_frozen_forward_extension

    try:
        return build_frozen_forward_extension(payload or {})
    except Exception as exc:
        import traceback
        return {
            "error": str(exc),
            "trace": traceback.format_exc()[:4000],
            "type": "frozen_oof_forward_extension",
        }

# 2026-04-19 ML_POOL Stage 0.2: DLinear universal training (one-shot)
@app.function(
    gpu="L4",
    memory=8192,
    timeout=1800,             # 30 min for universal sequence training.
    scaledown_window=60,
    max_containers=1,
)
def train_dlinear_universal(payload: dict) -> dict:
    """One-shot universal DLinear training across all stocks' close series.

    payload:
        series_close: list[list[float]]   raw close per stock
        seq_len/pred_len/kernel/n_epochs/batch_size/lr/val_ratio: hyperparams
        version: GCS save tag (default "v1")
        device: "cuda" (default if GPU avail) or "cpu"

    Returns:
        {"saved": {weights_path, metadata_path}, "metadata": {...}}
    """
    _setup_env()
    from app.dlinear_universal import train_dlinear, save_to_gcs
    try:
        import torch
        device = payload.get("device") or ("cuda" if torch.cuda.is_available() else "cpu")
        sequence_records = payload.get("sequence_records") or []
        if not sequence_records:
            from app.research_benchmarks.common import load_sequence_dataset

            sequence_records = load_sequence_dataset(payload or {}).records
        if str(payload.get("generation_mode") or "native").strip().lower() == "purged_oof":
            import json
            from app.model_store import _get_bucket

            prep_prefix = str(payload.get("gcs_prefix") or "").strip().rstrip("/")
            market_blob = _get_bucket().blob(f"{prep_prefix}/prep/symbol_market.json")
            if not market_blob.exists():
                raise ValueError("dlinear_oof_canonical_market_map_missing")
            market_by_symbol = json.loads(market_blob.download_as_text())
            sequence_records = [
                {**record, "market_type": market_by_symbol.get(str(record.get("symbol") or ""))}
                for record in sequence_records
                if market_by_symbol.get(str(record.get("symbol") or "")) in {"LISTED", "OTC", "EMERGING"}
            ]
        print(
            f"[DLinearTrain] starting series={len(sequence_records)} "
            f"seq_len={payload.get('seq_len', 512)} device={device}"
        )
        result = train_dlinear(
            series_close=payload.get("series_close") or [],
            sequence_records=sequence_records or None,
            seq_len=payload.get("seq_len", 512),
            pred_len=payload.get("pred_len", 5),
            kernel=payload.get("kernel", 25),
            n_epochs=payload.get("n_epochs", 30),
            batch_size=payload.get("batch_size", 256),
            lr=payload.get("lr", 1e-3),
            val_ratio=payload.get("val_ratio", 0.15),
            device=device,
            model_cpcv_policy=payload.get("model_cpcv_policy") or None,
            train_start=payload.get("train_start"),
            train_end=payload.get("train_end"),
            test_start=payload.get("test_start"),
            test_end=payload.get("test_end"),
            seed=int(payload.get("seed") or 42),
        )
        if result.get("error"):
            return result
        from app.training_policy import build_model_training_config_attestation

        training_config_attestation = build_model_training_config_attestation(
            "DLinear",
            payload,
            {
                "seq_len": payload.get("seq_len", 512),
                "pred_len": payload.get("pred_len", 5),
                "kernel": payload.get("kernel", 25),
                "n_epochs": payload.get("n_epochs", 30),
                "batch_size": payload.get("batch_size", 256),
                "lr": payload.get("lr", 1e-3),
                "val_ratio": payload.get("val_ratio", 0.15),
                "device": str(device),
                "seed": int(payload.get("seed") or 42),
                "reproducibility": result["metadata"].get("reproducibility"),
                "target_semantic_version": result["metadata"].get("target_semantic_version"),
            },
        )
        if training_config_attestation is not None:
            result["metadata"]["model_training_config_attestation"] = training_config_attestation
        version = payload.get("output_model_version") or payload.get("version", "v1")
        result["metadata"]["version"] = version
        result["metadata"]["model_pool_version"] = version
        saved = save_to_gcs(result["_state_dict_torch"], result["metadata"], version=version)
        oof_artifact = None
        if str(payload.get("generation_mode") or "native").strip().lower() == "purged_oof":
            import numpy as np
            from app.model_store import _get_bucket
            from app.oof_lineage import save_oof_prediction_artifact

            oof = result.get("oof_predictions") or {}
            oof_artifact = save_oof_prediction_artifact(
                bucket=_get_bucket(),
                gcs_prefix=str(payload.get("gcs_prefix") or "universal"),
                cohort_id=str(payload.get("cohort_id") or ""),
                fold_id=str(payload.get("fold_id") or payload.get("window_id") or ""),
                model_name="DLinear",
                artifact_version=str(version),
                raw_scores=np.asarray(oof.get("raw_scores") or [], dtype=float),
                targets=np.asarray(oof.get("targets") or [], dtype=float),
                dates=np.asarray(oof.get("dates") or [], dtype=object),
                symbols=np.asarray(oof.get("symbols") or [], dtype=object),
                markets=np.asarray(oof.get("markets") or [], dtype=object),
                label_known_dates=np.asarray(oof.get("label_known_dates") or [], dtype=object),
                split_metadata={
                    "method": "explicit_signal_date_with_actual_label_purge",
                    "train_range": [payload.get("train_start"), payload.get("train_end")],
                    "test_range": [payload.get("test_start"), payload.get("test_end")],
                },
            )
        print(
            f"[DLinearTrain] done version={version} "
            f"oos_ic={result.get('ic_tracking', {}).get('DLinear', {}).get('oos_ic')}"
        )
        tracking = dict(result.get("ic_tracking", {}))
        dlinear_tracking = dict(tracking.get("DLinear") or {})
        dlinear_tracking.setdefault("model_cpcv", result["metadata"].get("model_cpcv"))
        tracking["DLinear"] = dlinear_tracking
        return {
            "saved": saved,
            "metadata": result["metadata"],
            "ic_tracking": tracking,
            "version": version,
            "elapsed_s": result["metadata"].get("elapsed_s"),
            "type": "dlinear_universal",
            "oof_artifact": oof_artifact,
        }
    except Exception as e:
        import traceback
        print(f"[DLinearTrain] failed: {e}")
        return {"error": str(e), "trace": traceback.format_exc()[:2000], "type": "train_dlinear_universal"}


# 2026-04-19 ML_POOL Stage 0.2: DLinear batch predict
@app.function(
    cpu=2,
    memory=2048,             # DLinear is tiny, just linear layers
    timeout=300,             # 5 min cap for whole watchlist
    scaledown_window=300,    # keep model warm 5 min
    max_containers=1,
)
def dlinear_universal_predict(payload: dict) -> dict:
    """Batch DLinear forecast for the watchlist.

    payload:
        series_list: list of {symbol: str, prices: list[float]}
        version: GCS model version (default "v1")
        horizon_used: which pred_len step to report (default 5)

    Returns:
        {"results": [{...}], "n_input": int, "n_success": int}
        If model is not in GCS yet, all rows return "weights not in GCS".
    """
    _setup_env()
    from app.dlinear_universal import dlinear_batch_predict
    try:
        results = dlinear_batch_predict(
            series_list=payload.get("series_list") or [],
            horizon_used=payload.get("horizon_used", 5),
            version=payload.get("version", "v1"),
        )
        return {"results": results, "n_input": len(payload.get("series_list") or []),
                "n_success": sum(1 for r in results if not r.get("error"))}
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()[:2000], "type": "dlinear_universal_predict"}


# 2026-04-19 ML_POOL Stage 0.3: PatchTST universal training
@app.function(
    gpu="L4",
    memory=8192,
    timeout=3600,             # 60 min for ~1500 stocks ? ~330k windows ? 30 epochs
    scaledown_window=60,
    max_containers=1,
)
def train_patchtst_universal(payload: dict) -> dict:
    """One-shot NeuralForecast PatchTST training across all stocks' close series."""
    _setup_env()
    from app.patchtst_universal import train_patchtst
    try:
        result = train_patchtst(
            series_close=payload.get("series_close") or [],
            sequence_records=payload.get("sequence_records") or None,
            seq_len=payload.get("seq_len", 512),
            pred_len=payload.get("pred_len", 5),
            n_epochs=payload.get("n_epochs", 30),
            batch_size=payload.get("batch_size", 256),
            val_ratio=payload.get("val_ratio", 0.15),
            version=payload.get("output_model_version") or payload.get("version", "v1"),
            max_steps=payload.get("max_steps"),
            seed=int(payload.get("seed") or 42),
            model_cpcv_policy=payload.get("model_cpcv_policy") or None,
            promote_to_active=payload.get("promote_to_active", False),
            promotion_reason=payload.get("promotion_reason"),
            gcs_prefix=payload.get("gcs_prefix"),
            sequence_gcs_prefix=payload.get("sequence_gcs_prefix"),
            sequence_batch_count=payload.get("sequence_batch_count"),
            batch_count=payload.get("batch_count"),
            max_series=payload.get("max_series"),
            max_prep_stale_days=payload.get("max_prep_stale_days"),
            run_date=payload.get("run_date"),
            as_of_date=payload.get("as_of_date"),
            generation_mode=payload.get("generation_mode"),
            persist_oof_artifact=payload.get("persist_oof_artifact", True),
            research_source_bundle_checksum=payload.get("research_source_bundle_checksum"),
            oof_training_history_mode=payload.get("oof_training_history_mode"),
            trainer_deterministic=payload.get("trainer_deterministic", True),
            learning_rate=payload.get("learning_rate"),
            windows_batch_size=payload.get("windows_batch_size"),
            inference_windows_batch_size=payload.get("inference_windows_batch_size"),
            scaler_type=payload.get("scaler_type"),
            step_size=payload.get("step_size"),
            patch_len=payload.get("patch_len"),
            stride=payload.get("stride"),
            revin=payload.get("revin"),
            candidate_type=payload.get("candidate_type"),
            monthly_training_contract=payload.get("monthly_training_contract"),
            dataset_snapshot=payload.get("dataset_snapshot"),
            cohort_id=payload.get("cohort_id"),
            fold_id=payload.get("fold_id") or payload.get("window_id"),
            train_start=payload.get("train_start"),
            train_end=payload.get("train_end"),
            test_start=payload.get("test_start"),
            test_end=payload.get("test_end"),
            label_horizon_days=payload.get("label_horizon_days") or 5,
        )
        if result.get("error"):
            return result
        return {
            "saved": result.get("saved"),
            "metadata": result["metadata"],
            "ic_tracking": result.get("ic_tracking", {}),
            "version": result.get("version"),
            "elapsed_s": result.get("elapsed_s"),
            "type": result.get("type", "neuralforecast_patchtst_universal"),
            "pool_update": result.get("pool_update"),
            "oof_artifact": result.get("oof_artifact"),
            "allowed_use": result.get("allowed_use"),
            "production_effect": result.get("production_effect"),
            "research_source_bundle_checksum": result.get("research_source_bundle_checksum"),
            "metrics": result.get("metrics"),
        }
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()[:2000], "type": "train_patchtst_universal"}


# 2026-04-19 ML_POOL Stage 0.3: PatchTST batch predict
@app.function(
    cpu=2,
    memory=4096,             # PatchTST is small (~1MB weights), but transformer needs torch overhead
    timeout=300,
    scaledown_window=300,
    max_containers=1,
)
def patchtst_universal_predict(payload: dict) -> dict:
    """Batch PatchTST forecast for the watchlist."""
    _setup_env()
    from app.patchtst_universal import patchtst_batch_predict
    try:
        results = patchtst_batch_predict(
            series_list=payload.get("series_list") or [],
            horizon_used=payload.get("horizon_used", 5),
            version=payload.get("version", "v1"),
        )
        return {"results": results, "n_input": len(payload.get("series_list") or []),
                "n_success": sum(1 for r in results if not r.get("error"))}
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()[:2000], "type": "patchtst_universal_predict"}


# L3 sequence family: iTransformer artifact-backed batch predict.
@app.function(
    cpu=2,
    memory=4096,
    timeout=300,
    scaledown_window=300,
    max_containers=1,
)
def itransformer_universal_predict(payload: dict) -> dict:
    """Batch iTransformer forecast for the watchlist."""
    _setup_env()
    from app.itransformer_universal import itransformer_batch_predict
    try:
        results = itransformer_batch_predict(
            series_list=payload.get("series_list") or [],
            horizon_used=payload.get("horizon_used", 5),
            version=payload.get("version", "v1"),
        )
        return {"results": results, "n_input": len(payload.get("series_list") or []),
                "n_success": sum(1 for r in results if not r.get("error"))}
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()[:2000], "type": "itransformer_universal_predict"}


@app.function(
    gpu="L4",
    memory=8192,
    timeout=3600,
    scaledown_window=60,
    max_containers=1,
)
def train_itransformer_universal(payload: dict) -> dict:
    """Formal iTransformer artifact training and model_pool registration."""
    _setup_env()
    from app.itransformer_training import train_itransformer_universal as _train_itransformer_universal

    try:
        return _train_itransformer_universal(payload or {})
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()[:2000], "type": "train_itransformer_universal"}


# L2 feature sidecar: TimesFM config-backed batch predict.
@app.function(
    gpu="L4",
    memory=8192,
    timeout=600,
    scaledown_window=300,
    max_containers=1,
)
def timesfm_universal_predict(payload: dict) -> dict:
    """Batch TimesFM forecast for the watchlist."""
    _setup_env()
    from app.timesfm_universal import timesfm_batch_predict
    try:
        results = timesfm_batch_predict(
            series_list=payload.get("series_list") or [],
            horizon_used=payload.get("horizon_used", 5),
            version=payload.get("version", "v1"),
            sequence_contract_points=payload.get("sequence_contract_points"),
        )
        return {"results": results, "n_input": len(payload.get("series_list") or []),
                "n_success": sum(1 for r in results if not r.get("error")),
                "n_error": sum(1 for r in results if r.get("error"))}
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()[:2000], "type": "timesfm_universal_predict"}


# 2026-04-20 ML_POOL Stage 6.2: state-space batch predict (KalmanFilter + MarkovSwitching)
def _post_state_space_shadow_callback(input_payload: dict, result: dict, elapsed_s: float) -> dict | None:
    callback_url = str(input_payload.get("callback_url") or "").strip()
    if not callback_url:
        return None
    try:
        import httpx

        headers = {"Content-Type": "application/json"}
        token = str(input_payload.get("callback_token") or "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        payload_out = {
            "schema_version": "state-space-shadow-callback-v1",
            "run_date": input_payload.get("run_date"),
            "run_id": input_payload.get("run_id"),
            "source": "modal_state_space_shadow",
            "function_name": "state_space_universal_predict",
            "function_call_id": input_payload.get("function_call_id"),
            "horizon": input_payload.get("horizon", 5),
            "version_by_model": input_payload.get("version_by_model") or {},
            "elapsed_s": elapsed_s,
            "series_meta": [
                {
                    "symbol": row.get("symbol"),
                    "stock_id": row.get("stock_id"),
                }
                for row in (input_payload.get("series_list") or [])
                if isinstance(row, dict)
            ],
            "result": result,
        }
        resp = httpx.post(
            callback_url,
            json=payload_out,
            headers=headers,
            timeout=20,
            follow_redirects=True,
        )
        if resp.status_code < 200 or resp.status_code >= 300:
            raise RuntimeError(f"shadow callback returned HTTP {resp.status_code}")
        return {"ok": True, "status_code": resp.status_code, "url": sanitize_callback_url(resp.url)}
    except Exception as exc:  # noqa: BLE001 - shadow callback must never hide compute output.
        safe_error = sanitize_callback_error(exc, locals().get("token"))
        print(f"[StateSpaceUniversal] shadow callback failed: {safe_error}")
        return {"ok": False, "error": safe_error, "url": sanitize_callback_url(callback_url)}


@app.function(
    cpu=2,
    memory=2048,
    timeout=600,             # 10 min for per-stock state-space loop.
    scaledown_window=300,    # keep hyperparam cache warm
    max_containers=1,
)
def state_space_universal_predict(payload: dict) -> dict:
    """Batch state-space forecast (KalmanFilter or MarkovSwitching).

    payload:
        model_name: 'KalmanFilter' or 'MarkovSwitching'
        series_list: list of {symbol: str, prices: list[float]}
        horizon: int (default 5)
        version: hyperparams version (default 'v1')

    Returns: {"results": [...], "n_input": int, "n_success": int}
    """
    _setup_env()
    import time
    from app.state_space_universal import state_space_batch_predict, state_space_overlays_batch_predict
    t0 = time.time()
    try:
        model_names = payload.get("model_names")
        if isinstance(model_names, list) and model_names:
            result = state_space_overlays_batch_predict(
                model_names=[str(name) for name in model_names],
                series_list=payload.get("series_list") or [],
                horizon=payload.get("horizon", 5),
                version_by_model=payload.get("version_by_model") or {},
            )
        else:
            results = state_space_batch_predict(
                model_name=payload.get("model_name", "KalmanFilter"),
                series_list=payload.get("series_list") or [],
                horizon=payload.get("horizon", 5),
                version=payload.get("version", "v1"),
            )
            result = {"results": results, "n_input": len(payload.get("series_list") or []),
                      "n_success": sum(1 for r in results if not r.get("error"))}
    except Exception as e:
        import traceback
        result = {"error": str(e), "trace": traceback.format_exc()[:2000], "type": "state_space_universal_predict"}
    elapsed_s = round(time.time() - t0, 3)
    result["elapsed_s"] = elapsed_s
    callback_status = _post_state_space_shadow_callback(payload, result, elapsed_s)
    if callback_status is not None:
        result["shadow_callback"] = callback_status
    return result


@app.function(
    cpu=4,
    memory=8192,
    timeout=3600,                # 60 min cap for walk-forward window subset.
    scaledown_window=60,
    max_containers=3,            # parallel windows
)
def feature_selection_per_window(payload: dict) -> dict:
    """Walk-forward window-scoped feature selection.

    Filters prep data to train_end_date before running the pipeline,
    so the resulting pool reflects only the train horizon (no look-ahead).
    Writes to {gcs_prefix}/feature_pool.json (no monthly snapshot).

    payload:
        window_id (int)
        train_end_date (str, ISO date)
        gcs_prefix (str, e.g., "walk_forward/w0")
        max_rounds (int, default from FeatureSelectionPolicy window policy)
        force_refresh (bool, default False) - if False and pool already exists, skip
    """
    _setup_env()
    import time
    from app.feature_selection import run_feature_selection_pipeline

    t0 = time.time()
    window_id = payload.get("window_id")
    train_end_date = payload["train_end_date"]
    gcs_prefix = payload["gcs_prefix"].rstrip("/")
    prep_gcs_prefix = str(payload.get("prep_gcs_prefix") or "universal").strip().rstrip("/")
    force = bool(payload.get("force_refresh", False))
    from app.training_policy import FeatureSelectionPolicy, build_feature_selection_run_kwargs
    selection_params = FeatureSelectionPolicy.from_env().to_window_selection_params(payload)

    # Idempotency: skip if pool already exists for this window
    if not force:
        try:
            from google.cloud import storage
            bucket_name = _get_gcs_bucket_name()
            if not bucket_name:
                raise RuntimeError("GCS bucket not configured")
            bucket = storage.Client().bucket(bucket_name)
            existing = bucket.blob(f"{gcs_prefix}/feature_pool.json")
            if existing.exists():
                import json as _json
                pool = _json.loads(existing.download_as_text())
                active = pool.get("tree_active") or pool.get("active", [])
                print(f"[FS-Window] w{window_id} skip: pool exists ({len(active)} tree_active)")
                return {
                    "skipped": True,
                    "window_id": window_id,
                    "gcs_prefix": gcs_prefix,
                    "tree_active_count": len(active),
                    "elapsed_s": round(time.time() - t0, 1),
                }
        except Exception as e:
            print(f"[FS-Window] w{window_id} idempotency check failed ({e}) -> proceeding")

    try:
        result = run_feature_selection_pipeline(
            **build_feature_selection_run_kwargs(selection_params),
            train_end_date=train_end_date,
            gcs_prefix=gcs_prefix,
            prep_gcs_prefix=prep_gcs_prefix,
        )
        # Annotate for orchestrator aggregate
        result["window_id"] = window_id
        result["gcs_prefix"] = gcs_prefix
        result["elapsed_s"] = round(time.time() - t0, 1)
        return result
    except Exception as e:
        import traceback
        return {
            "error": str(e),
            "trace": traceback.format_exc()[:2000],
            "window_id": window_id,
            "gcs_prefix": gcs_prefix,
            "type": "feature_selection_per_window",
        }


@app.function(
    cpu=1,
    memory=1024,
    timeout=60,
    scaledown_window=60,
    max_containers=5,
)
def update_arf_reward(payload: dict) -> dict:
    """Update ARF/LinUCB reward state."""
    _setup_env()
    from app.use_cases import update_arf, ARFUpdateRequest
    try:
        req = ARFUpdateRequest(**payload)
        return update_arf(req)
    except Exception as e:
        return {"error": str(e)}


def _post_worker_scheduler_callback(payload: dict, result: dict, status: str, summary: str, duration_ms: int, error: str | None = None) -> dict:
    import json
    import os
    import time
    import urllib.error
    import urllib.request

    controller_callback_url = str(payload.get("controller_callback_url") or "").strip()
    controller_token = str(payload.get("controller_token") or os.environ.get("ML_CONTROLLER_TOKEN") or os.environ.get("ML_CONTROLLER_SECRET") or "").strip()
    callback_url = controller_callback_url or str(payload.get("callback_url") or "").strip()
    use_controller_callback = bool(controller_callback_url and controller_token)
    if not callback_url:
        worker_url = str(os.environ.get("STOCKVISION_WORKER_URL") or "").strip().rstrip("/")
        if worker_url:
            callback_url = f"{worker_url}/api/admin/scheduler-callback"
    callback_token = str(payload.get("callback_token") or os.environ.get("STOCKVISION_AUTH_TOKEN") or "").strip()
    if not callback_url or not callback_token:
        if not use_controller_callback:
            return {"status": "skipped", "reason": "callback_url_or_token_missing"}

    body = {
        "task": str(payload.get("callback_task") or "finlab-v4-backfill"),
        "status": status,
        "summary": summary,
        "duration_ms": duration_ms,
        "run_id": str(payload.get("run_id") or result.get("run_id") or ""),
        "run_date": payload.get("run_date"),
        "force": bool(payload.get("force")),
        "dispatch_attempt": int(payload.get("dispatch_attempt") or result.get("dispatch_attempt") or 1),
        "continue_evening_chain": bool(payload.get("continue_evening_chain")),
        "daily_source_refresh": bool(payload.get("daily_source_refresh")),
        "callback_mode": payload.get("callback_mode"),
        "result": {
            "run_id": result.get("run_id"),
            "summary": result.get("summary"),
            "requested_lanes": result.get("requested_lanes") or payload.get("lanes"),
            "canonical_d1_apply": result.get("canonical_d1_apply"),
            "force": bool(payload.get("force")),
            "continue_evening_chain": bool(payload.get("continue_evening_chain")),
            "daily_source_refresh": bool(payload.get("daily_source_refresh")),
            "callback_mode": payload.get("callback_mode"),
            "dispatch_attempt": int(payload.get("dispatch_attempt") or result.get("dispatch_attempt") or 1),
        },
        "metadata": {
            "daily_source_refresh": bool(payload.get("daily_source_refresh")),
            "callback_mode": payload.get("callback_mode"),
            "requested_lanes": result.get("requested_lanes") or payload.get("lanes"),
            "dispatch_attempt": int(payload.get("dispatch_attempt") or result.get("dispatch_attempt") or 1),
        },
    }
    if error:
        body["error"] = error
    req = urllib.request.Request(
        callback_url,
        data=json.dumps(body, ensure_ascii=False, default=str).encode("utf-8"),
        headers=(
            {
                "X-Controller-Token": controller_token,
                "Content-Type": "application/json",
            }
            if use_controller_callback
            else {
                "Authorization": f"Bearer {callback_token}",
                "Content-Type": "application/json",
            }
        ),
        method="POST",
    )
    last_error: dict | None = None
    for attempt in range(1, 4):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                text = resp.read().decode("utf-8", errors="replace")
                return {"status": "ok", "code": resp.status, "attempt": attempt, "text": text[:500]}
        except urllib.error.HTTPError as exc:
            last_error = {"status": "error", "code": exc.code, "attempt": attempt, "text": exc.read().decode("utf-8", errors="replace")[:500]}
        except Exception as exc:
            last_error = {
                "status": "error",
                "attempt": attempt,
                "error": sanitize_callback_error(exc, callback_token, controller_token),
            }
        time.sleep(min(attempt * 2, 5))
    return last_error or {"status": "error", "error": "unknown_callback_failure"}


def _write_finlab_macro_context_to_d1() -> dict:
    import json
    import sys

    for path in ("/root", "/root/tools"):
        if path not in sys.path:
            sys.path.insert(0, path)

    from tools import finlab_macro_context_snapshot
    from tools import finlab_v4_remote_backfill

    finlab_macro_context_snapshot.login_finlab()
    rows = finlab_macro_context_snapshot.collect_snapshot()
    canonical_rows = finlab_macro_context_snapshot.collect_canonical_regime_context_rows(rows)
    statements = finlab_macro_context_snapshot.build_d1_upsert_statements(rows, canonical_rows)
    result = finlab_v4_remote_backfill.d1_batch_execute(
        statements,
        timeout=60.0,
        chunk_size=50,
        domain=finlab_v4_remote_backfill.market_owner_domain(),
    )
    return {"rows": len(rows), "canonical_rows": len(canonical_rows), "writeback": result}


def _write_external_evidence_to_d1(payload: dict, result: dict | None = None) -> dict:
    import contextlib
    import io
    import json
    import sys

    for path in ("/root", "/root/tools"):
        if path not in sys.path:
            sys.path.insert(0, path)

    target_date = str(payload.get("run_date") or (result or {}).get("target_date") or "").strip()
    if target_date:
        os.environ["TARGET_DATE"] = target_date
        os.environ.setdefault("AS_OF_DATE", target_date)

    from tools import materialize_external_evidence_once

    if target_date:
        materialize_external_evidence_once.TARGET_DATE = target_date
        materialize_external_evidence_once.AS_OF_DATE = os.environ.get("AS_OF_DATE", target_date)

    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        materialize_external_evidence_once.main()
    output = stdout.getvalue()
    parsed: dict = {}
    for line in reversed([line.strip() for line in output.splitlines() if line.strip()]):
        try:
            candidate = json.loads(line)
        except Exception:
            continue
        if isinstance(candidate, dict):
            parsed = candidate
            break
    return {
        "status": "ok",
        "target_date": materialize_external_evidence_once.TARGET_DATE,
        "as_of_date": materialize_external_evidence_once.AS_OF_DATE,
        "summary": parsed,
        "stdout_tail": output[-4000:],
    }


@app.function(
    cpu=1,
    memory=512,
    timeout=120,
    scaledown_window=30,
    max_containers=1,
)
def gcs_writer_canary(payload: dict | None = None) -> dict:
    """Verify the dedicated Modal writer can create, read, and delete one object."""
    _setup_env()
    from google.cloud import storage
    from app.gcs_preflight import verify_gcs_object_lifecycle

    payload = payload or {}
    bucket_name = str(
        payload.get("gcs_bucket")
        or _get_gcs_bucket_name()
        or ""
    ).strip()
    if not bucket_name:
        raise RuntimeError("modal_gcs_writer_canary_bucket_not_configured")
    return verify_gcs_object_lifecycle(
        storage.Client().bucket(bucket_name),
        workload="modal-gcs-writer",
        run_id=str(payload.get("run_id") or "manual"),
    )


@app.function(
    cpu=2,
    memory=4096,
    timeout=7200,
    scaledown_window=60,
    max_containers=1,
)
def finlab_v4_backfill(payload: dict) -> dict:
    """Run FinLab canonical backfill on Modal and callback Worker on completion."""
    _setup_env()
    import contextlib
    import io
    import json
    import sys
    import time
    import traceback

    for path in ("/root", "/root/tools"):
        if path not in sys.path:
            sys.path.insert(0, path)

    started = time.time()
    run_id = str(payload.get("run_id") or "auto")
    dispatch_attempt = int(payload.get("dispatch_attempt") or 1)
    controller_env = {
        "FINLAB_CONTROLLER_D1_QUERY_URL": payload.get("controller_d1_query_url"),
        "FINLAB_CONTROLLER_D1_BATCH_URL": payload.get("controller_d1_batch_url"),
        "FINLAB_CONTROLLER_TOKEN": payload.get("controller_token"),
        "ML_CONTROLLER_TOKEN": payload.get("controller_token"),
        "CF_D1_MARKET_DB_ID": payload.get("cf_d1_market_db_id"),
        "CF_D1_CORE_DB_ID": payload.get("cf_d1_core_db_id"),
        "MULTI_D1_ACTIVE_DOMAINS": payload.get("multi_d1_active_domains"),
    }
    for key, value in controller_env.items():
        if value:
            os.environ[key] = str(value)
    print(
        f"[finlab_v4_backfill] start run_id={run_id} "
        f"dispatch_attempt={dispatch_attempt} "
        f"controller_proxy={bool(payload.get('controller_d1_query_url') and payload.get('controller_token'))} "
        f"controller_callback={bool(payload.get('controller_callback_url') and payload.get('controller_token'))}",
        flush=True,
    )
    start_callback = _post_worker_scheduler_callback(
        payload,
        {"run_id": run_id, "dispatch_attempt": dispatch_attempt},
        "running",
        f"FinLab V4 backfill started run_id={run_id} dispatch_attempt={dispatch_attempt}",
        0,
    )
    argv = [
        "finlab_v4_remote_backfill.py",
        "--years", str(int(payload.get("years") or 3)),
        "--run-id", run_id,
        "--output-dir", str(payload.get("output_dir") or "/tmp/finlab_remote_backfill"),
        "--gcs-prefix", str(payload.get("gcs_prefix") or "finlab/v4/backfill"),
        "--canonical-window-days", str(int(payload.get("canonical_window_days") or 7)),
        "--canonical-d1-chunk-size", str(int(payload.get("canonical_d1_chunk_size") or 250)),
    ]
    if payload.get("write_d1", True):
        argv.append("--write-d1")
    if payload.get("gcs_bucket"):
        argv.extend(["--gcs-bucket", str(payload["gcs_bucket"])])
    elif payload.get("GCS_BUCKET_NAME"):
        argv.extend(["--gcs-bucket", str(payload["GCS_BUCKET_NAME"])])
    if payload.get("apply_canonical_d1", True):
        argv.append("--apply-canonical-d1")
    if payload.get("canonical_start_date"):
        argv.extend(["--canonical-start-date", str(payload["canonical_start_date"])])
    if payload.get("canonical_end_date"):
        argv.extend(["--canonical-end-date", str(payload["canonical_end_date"])])
    if payload.get("source_start_date"):
        argv.extend(["--source-start-date", str(payload["source_start_date"])])
    if payload.get("source_end_date"):
        argv.extend(["--source-end-date", str(payload["source_end_date"])])
    if payload.get("require_official_market_summary"):
        argv.append("--require-official-market-summary")
    if payload.get("canonical_datasets"):
        argv.extend(["--canonical-datasets", str(payload["canonical_datasets"])])
    if payload.get("canonical_limit_per_dataset"):
        argv.extend(["--canonical-limit-per-dataset", str(int(payload["canonical_limit_per_dataset"]))])
    if payload.get("lanes"):
        argv.extend(["--lanes", str(payload["lanes"])])
    if payload.get("key_scope_json"):
        argv.extend(["--key-scope-json", str(payload["key_scope_json"])])
    if payload.get("reuse_successful_artifacts"):
        argv.append("--reuse-successful-artifacts")
    if payload.get("canonical_dry_run"):
        argv.append("--canonical-dry-run")

    old_argv = sys.argv
    stdout = io.StringIO()
    try:
        from tools import finlab_v4_remote_backfill
        from google.cloud import storage
        from app.gcs_preflight import verify_gcs_object_lifecycle

        bucket_name = str(
            payload.get("gcs_bucket")
            or payload.get("GCS_BUCKET_NAME")
            or _get_gcs_bucket_name()
            or ""
        ).strip()
        if not bucket_name:
            raise RuntimeError("finlab_v4_gcs_bucket_not_configured")
        gcs_preflight = verify_gcs_object_lifecycle(
            storage.Client().bucket(bucket_name),
            workload="finlab-v4-backfill",
            run_id=run_id,
        )

        sys.argv = argv
        with contextlib.redirect_stdout(stdout):
            exit_code = finlab_v4_remote_backfill.main()
        output = stdout.getvalue()
        result = {
            "exit_code": exit_code,
            "stdout_tail": output[-4000:],
            "gcs_preflight": gcs_preflight,
        }
        for line in reversed([line.strip() for line in output.splitlines() if line.strip()]):
            try:
                parsed = json.loads(line)
            except Exception:
                continue
            if isinstance(parsed, dict):
                result.update(parsed)
                break
        if payload.get("write_d1", True):
            try:
                result["macro_context_writeback"] = _write_finlab_macro_context_to_d1()
            except Exception as exc:
                result["macro_context_writeback"] = {"status": "error", "error": f"{type(exc).__name__}: {exc}"}
            try:
                result["external_evidence_writeback"] = _write_external_evidence_to_d1(payload, result)
            except Exception as exc:
                result["external_evidence_writeback"] = {"status": "error", "error": f"{type(exc).__name__}: {exc}"}
        else:
            result["macro_context_writeback"] = {"status": "skipped", "reason": "write_d1_false"}
            result["external_evidence_writeback"] = {"status": "skipped", "reason": "write_d1_false"}
        result["continue_evening_chain"] = bool(payload.get("continue_evening_chain"))
        result["dispatch_attempt"] = dispatch_attempt
        result["start_callback"] = start_callback
        duration_ms = int((time.time() - started) * 1000)
        macro_error = isinstance(result.get("macro_context_writeback"), dict) and result["macro_context_writeback"].get("status") == "error"
        external_error = isinstance(result.get("external_evidence_writeback"), dict) and result["external_evidence_writeback"].get("status") == "error"
        # External evidence is supplemental to the FinLab canonical refresh; do not
        # block the evening-chain callback after canonical D1 apply succeeds.
        backfill_ready = str(result.get("backfill_status") or "").strip().lower() == "ready"
        status = "success" if int(exit_code or 0) == 0 and backfill_ready and not macro_error else "error"
        summary = (
            f"FinLab V4 backfill run_id={result.get('run_id', run_id)} "
            f"status={result.get('backfill_status', 'ready')} "
            f"canonical={result.get('canonical_d1_apply') is not None} "
            f"rows={result.get('summary', {}).get('finlab_rows', 'n/a')} "
            f"macro_context={result.get('macro_context_writeback', {}).get('status', 'ok')} "
            f"external_evidence={result.get('external_evidence_writeback', {}).get('status', 'ok')}"
        )
        callback = _post_worker_scheduler_callback(payload, result, status, summary, duration_ms)
        result["callback"] = callback
        result["status"] = status
        result["duration_ms"] = duration_ms
        return result
    except (Exception, SystemExit) as exc:
        duration_ms = int((time.time() - started) * 1000)
        error = f"{type(exc).__name__}: {exc}"
        result = {
            "status": "error",
            "run_id": run_id,
            "error": error,
            "trace": traceback.format_exc()[-4000:],
            "stdout_tail": stdout.getvalue()[-4000:],
            "continue_evening_chain": bool(payload.get("continue_evening_chain")),
            "duration_ms": duration_ms,
            "dispatch_attempt": dispatch_attempt,
            "start_callback": start_callback,
        }
        result["callback"] = _post_worker_scheduler_callback(payload, result, "error", error, duration_ms, error=error)
        return result
    finally:
        sys.argv = old_argv


# ASGI web endpoint for warmup, health, IC audit, and Optuna routes.

@app.function(
    cpu=2,            # 2026-04-07 bumped: Optuna 200 trials needs CPU
    memory=4096,      # Optuna routes join paper orders and predictions.
    timeout=1800,     # Optuna signal/SLTP trials can take several minutes.
    scaledown_window=60,
    max_containers=2,
)
@modal.concurrent(max_inputs=4)
@modal.asgi_app()
def fastapi_app():
    """ASGI endpoint for warmup, health, IC audit, and Optuna routes."""
    _setup_env()
    from app.main import app as fastapi_application
    return fastapi_application
