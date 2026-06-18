#!/usr/bin/env bash
# deploy_ml_controller.sh — one-shot deploy for Cloud Run Service + Job image sync.
#
# Why this script exists (M31 2026-04-21):
#   Cloud Run Service `ml-controller` and Cloud Run Job `pipeline-v2` share the
#   same source but manage image pointers INDEPENDENTLY. `gcloud run deploy` only
#   updates the Service; the Job silently keeps running the old image until a
#   manual `gcloud run jobs update pipeline-v2 --image=<sha>` lands. Prior
#   sessions shipped code, deployed Service, assumed `pipeline-v2` Job ran the
#   new code — but Job stayed on old image for WEEKS (T2.1/T2.4 4/19 commits
#   never reached production until 4/21). See mistake.md M31.
#
# 2026-04-21 T1.0 Option A update:
#   Build context moved to repo root so Dockerfile can COPY both ml-controller/
#   and ml-service/ into the image. This enables the new POST /admin/modal-deploy
#   endpoint (ml-controller/routers/admin.py) to subprocess `modal deploy` from
#   Cloud Run itself. Script now supports --with-modal flag to trigger Modal
#   redeploy as the final verification step (absorbs roadmap #13).
#
# What this script does:
#   1. Deploy ml-controller Service from REPO ROOT (root Dockerfile)
#   2. Read back the new container image URI from Service spec
#   3. Update pipeline-v2 Job image to match
#   4. Verify Service + Job image match (fail loudly if not)
#   5. (Optional, --with-modal) Trigger POST /admin/modal-deploy to refresh
#      ml-service/modal_app.py on Modal cloud
#
# Usage:
#   bash /path/to/stockvision-cloudflare-v12/deploy_ml_controller.sh [--check-only] [--with-modal]
#
# Flags:
#   --check-only    Run local/live preflight checks only. Do not deploy.
#   --with-modal    After Cloud Run deploy + Job sync, trigger Modal redeploy
#                   via /admin/modal-deploy endpoint. ~3-5 min extra wall-clock.
#
# Exit codes:
#   0 — Service + Job (+ Modal if --with-modal) all live on new code
#   1 — sanity check failed (wrong dir / missing gcloud)
#   2 — Service deploy failed
#   3 — image SHA extraction failed
#   4 — Job update failed
#   5 — verification mismatch
#   6 — Modal deploy failed (only with --with-modal)
#   7 — preflight check failed
#
# Dependencies: gcloud CLI authenticated with project gen-lang-client-0602998820.
#               curl (for --with-modal).

set -euo pipefail

REGION="asia-east1"
SERVICE="ml-controller"
JOB="pipeline-v2"
ML_CONTROLLER_URL_DEFAULT="https://ml-controller-530028717113.asia-east1.run.app"
ML_CONTROLLER_PUBLIC_URL="${ML_CONTROLLER_PUBLIC_URL:-$ML_CONTROLLER_URL_DEFAULT}"
GCS_BUCKET_NAME="${GCS_BUCKET_NAME:-}"
RETRAIN_LOCK_BUCKET="${RETRAIN_LOCK_BUCKET:-${GCS_BUCKET_NAME}}"
GCP_PROJECT_ID="${GCP_PROJECT_ID:-gen-lang-client-0602998820}"
GCP_REGION="${GCP_REGION:-asia-east1}"
PIPELINE_JOB_NAME="${PIPELINE_JOB_NAME:-pipeline-v2}"
VERIFY_JOB_NAME="${VERIFY_JOB_NAME:-verify-v2}"
OPTUNA_JOB_NAME="${OPTUNA_JOB_NAME:-optuna-research-sweep}"
OPTUNA_JOB_TIMEOUT="${OPTUNA_JOB_TIMEOUT:-7200s}"
STRATEGY_MINING_JOB_TIMEOUT="${STRATEGY_MINING_JOB_TIMEOUT:-28800s}"
STOCKVISION_WORKER_URL="${STOCKVISION_WORKER_URL:-https://stockvision-worker.angus-solo-dev.workers.dev}"
CF_API_TOKEN_SECRET="${CF_API_TOKEN_SECRET:-stockvision-cf-api-token:latest}"
STOCKVISION_AUTH_TOKEN_SECRET="${STOCKVISION_AUTH_TOKEN_SECRET:-stockvision-stockvision-auth-token:latest}"
ML_CONTROLLER_SECRET_SECRET="${ML_CONTROLLER_SECRET_SECRET:-stockvision-ml-controller-secret:latest}"
MODAL_TOKEN_ID_SECRET="${MODAL_TOKEN_ID_SECRET:-stockvision-modal-token-id:latest}"
MODAL_TOKEN_SECRET_SECRET="${MODAL_TOKEN_SECRET_SECRET:-stockvision-modal-token-secret:latest}"
SHIOAJI_API_KEY_SECRET="${SHIOAJI_API_KEY_SECRET:-stockvision-finlab-exec-shioaji-api-key:latest}"
SHIOAJI_SECRET_KEY_SECRET="${SHIOAJI_SECRET_KEY_SECRET:-stockvision-finlab-exec-shioaji-secret-key:latest}"
SHIOAJI_ACCOUNT_ID_SECRET="${SHIOAJI_ACCOUNT_ID_SECRET:-stockvision-finlab-exec-shioaji-account-id:latest}"
SHIOAJI_CERT_PERSON_ID_SECRET="${SHIOAJI_CERT_PERSON_ID_SECRET:-stockvision-finlab-exec-shioaji-cert-person-id:latest}"
SHIOAJI_CERT_PASSWORD_SECRET="${SHIOAJI_CERT_PASSWORD_SECRET:-stockvision-finlab-exec-shioaji-cert-password:latest}"
SHIOAJI_CERT_PFX_SECRET="${SHIOAJI_CERT_PFX_SECRET:-stockvision-finlab-exec-shioaji-cert-pfx:latest}"
SHIOAJI_CERT_MOUNT_PATH="${SHIOAJI_CERT_MOUNT_PATH:-/secrets/shioaji/cert.pfx}"
BASE_SECRET_BINDINGS="CF_API_TOKEN=${CF_API_TOKEN_SECRET},STOCKVISION_AUTH_TOKEN=${STOCKVISION_AUTH_TOKEN_SECRET},ML_CONTROLLER_SECRET=${ML_CONTROLLER_SECRET_SECRET},MODAL_TOKEN_ID=${MODAL_TOKEN_ID_SECRET},MODAL_TOKEN_SECRET=${MODAL_TOKEN_SECRET_SECRET}"
SHIOAJI_SECRET_BINDINGS="SHIOAJI_API_KEY=${SHIOAJI_API_KEY_SECRET},SHIOAJI_SECRET_KEY=${SHIOAJI_SECRET_KEY_SECRET},SHIOAJI_ACCOUNT_ID=${SHIOAJI_ACCOUNT_ID_SECRET},SHIOAJI_CERT_PERSON_ID=${SHIOAJI_CERT_PERSON_ID_SECRET},SHIOAJI_CERT_PASSWORD=${SHIOAJI_CERT_PASSWORD_SECRET},${SHIOAJI_CERT_MOUNT_PATH}=${SHIOAJI_CERT_PFX_SECRET}"
RUN_SECRET_BINDINGS="${BASE_SECRET_BINDINGS},${SHIOAJI_SECRET_BINDINGS}"
PIPELINE_STATE_SPACE_OVERLAY_MODE="${PIPELINE_STATE_SPACE_OVERLAY_MODE:-shadow}"
PIPELINE_STATE_SPACE_OVERLAY_SOFT_DEADLINE_SECONDS="${PIPELINE_STATE_SPACE_OVERLAY_SOFT_DEADLINE_SECONDS:-120}"
MODAL_PREDICT_BATCH_SIZE_CANDIDATES="${MODAL_PREDICT_BATCH_SIZE_CANDIDATES:-80|120|160}"
MODAL_PREDICT_BATCH_SIZE_OBSERVATION_SOURCE="${MODAL_PREDICT_BATCH_SIZE_OBSERVATION_SOURCE:-auto}"
TIMESFM_MIN_SEQUENCE_COVERAGE="${TIMESFM_MIN_SEQUENCE_COVERAGE:-0.80}"
TIMESFM_MIN_SEQUENCE_POINTS="${TIMESFM_MIN_SEQUENCE_POINTS:-50}"
FINLAB_BACKFILL_EXECUTOR="${FINLAB_BACKFILL_EXECUTOR:-modal}"
STRATEGY_MINING_JOB_NAME="${STRATEGY_MINING_JOB_NAME:-strategy-mining-research}"
STRATEGY_MINING_EXECUTION_ENABLED="${STRATEGY_MINING_EXECUTION_ENABLED:-false}"
RUNTIME_ENV_VARS="GCS_BUCKET_NAME=${GCS_BUCKET_NAME},RETRAIN_LOCK_BUCKET=${RETRAIN_LOCK_BUCKET},GCP_PROJECT_ID=${GCP_PROJECT_ID},GCP_REGION=${GCP_REGION},PIPELINE_JOB_NAME=${PIPELINE_JOB_NAME},VERIFY_JOB_NAME=${VERIFY_JOB_NAME},OPTUNA_JOB_NAME=${OPTUNA_JOB_NAME},STOCKVISION_WORKER_URL=${STOCKVISION_WORKER_URL},ML_CONTROLLER_PUBLIC_URL=${ML_CONTROLLER_PUBLIC_URL},SHIOAJI_CERT_PATH=${SHIOAJI_CERT_MOUNT_PATH},PIPELINE_STATE_SPACE_OVERLAY_MODE=${PIPELINE_STATE_SPACE_OVERLAY_MODE},PIPELINE_STATE_SPACE_OVERLAY_SOFT_DEADLINE_SECONDS=${PIPELINE_STATE_SPACE_OVERLAY_SOFT_DEADLINE_SECONDS},MODAL_PREDICT_BATCH_SIZE_CANDIDATES=${MODAL_PREDICT_BATCH_SIZE_CANDIDATES},MODAL_PREDICT_BATCH_SIZE_OBSERVATION_SOURCE=${MODAL_PREDICT_BATCH_SIZE_OBSERVATION_SOURCE},TIMESFM_MIN_SEQUENCE_COVERAGE=${TIMESFM_MIN_SEQUENCE_COVERAGE},TIMESFM_MIN_SEQUENCE_POINTS=${TIMESFM_MIN_SEQUENCE_POINTS},FINLAB_BACKFILL_EXECUTOR=${FINLAB_BACKFILL_EXECUTOR},STRATEGY_MINING_JOB_NAME=${STRATEGY_MINING_JOB_NAME},STRATEGY_MINING_EXECUTION_ENABLED=${STRATEGY_MINING_EXECUTION_ENABLED}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MLC_DIR="$SCRIPT_DIR/ml-controller"
MLS_DIR="$SCRIPT_DIR/ml-service"
ROOT_DOCKERFILE="$SCRIPT_DIR/Dockerfile"
PYTHON_BIN=""

REQUIRED_ENV_VARS=(
  GCS_BUCKET_NAME
  RETRAIN_LOCK_BUCKET
  GCP_PROJECT_ID
  GCP_REGION
  PIPELINE_JOB_NAME
  VERIFY_JOB_NAME
  OPTUNA_JOB_NAME
  STRATEGY_MINING_JOB_NAME
  STRATEGY_MINING_EXECUTION_ENABLED
  STOCKVISION_WORKER_URL
)

# ── Parse flags ──────────────────────────────────────────────────────────────
WITH_MODAL=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=1 ;;
    --with-modal) WITH_MODAL=1 ;;
    *) echo "Unknown flag: $arg (supported: --check-only, --with-modal)" >&2; exit 1 ;;
  esac
done

require_nonempty() {
  local var_name="$1"
  local hint="$2"
  local value="${!var_name:-}"
  if [ -z "$value" ]; then
    echo "❌ ERROR: $var_name is required. $hint" >&2
    exit 7
  fi
}

print_preflight_value() {
  local var_name="$1"
  printf '  %-20s %s\n' "$var_name" "${!var_name}"
}

detect_python() {
  if command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
  elif command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
  else
    echo "❌ ERROR: python/python3 not found in PATH (needed for preflight JSON parsing)" >&2
    exit 1
  fi
}

load_live_missing_envs() {
  local service_json
  service_json=$(gcloud run services describe "$SERVICE" \
    --region="$REGION" \
    --format=json 2>/dev/null || true)
  if [ -z "$service_json" ]; then
    return 0
  fi

  LIVE_MISSING_ENV_NAMES=$(SERVICE_JSON="$service_json" "$PYTHON_BIN" - <<'PY'
import json
import os

required = [
    "GCS_BUCKET_NAME",
    "RETRAIN_LOCK_BUCKET",
    "GCP_PROJECT_ID",
    "GCP_REGION",
    "PIPELINE_JOB_NAME",
    "VERIFY_JOB_NAME",
    "OPTUNA_JOB_NAME",
    "STOCKVISION_WORKER_URL",
    "CF_API_TOKEN",
    "STOCKVISION_AUTH_TOKEN",
    "MODAL_TOKEN_ID",
    "MODAL_TOKEN_SECRET",
    "SHIOAJI_API_KEY",
    "SHIOAJI_SECRET_KEY",
    "SHIOAJI_ACCOUNT_ID",
    "SHIOAJI_CERT_PERSON_ID",
    "SHIOAJI_CERT_PASSWORD",
    "SHIOAJI_CERT_PATH",
]

raw = os.environ.get("SERVICE_JSON", "")
if not raw.strip():
    print("")
    raise SystemExit(0)

doc = json.loads(raw)
containers = (
    doc.get("spec", {})
    .get("template", {})
    .get("spec", {})
    .get("containers", [])
)
envs = containers[0].get("env", []) if containers else []
present = {}
for item in envs:
    if not isinstance(item, dict) or not item.get("name"):
        continue
    if str(item.get("value", "")).strip() or item.get("valueFrom"):
        present[item["name"]] = True
missing = [name for name in required if not present.get(name)]
print(", ".join(missing))
PY
)
}

load_live_runtime_settings() {
  local service_json
  service_json=$(gcloud run services describe "$SERVICE" \
    --region="$REGION" \
    --format=json 2>/dev/null || true)
  LIVE_SERVICE_CPU_THROTTLING=""
  LIVE_SERVICE_CPU=""
  LIVE_SERVICE_MEMORY=""
  LIVE_SERVICE_CONCURRENCY=""
  LIVE_SERVICE_MIN_SCALE=""
  LIVE_SERVICE_MAX_SCALE=""
  if [ -z "$service_json" ]; then
    return 0
  fi

  while IFS='=' read -r key value; do
    value="${value%$'\r'}"
    case "$key" in
      CPU_THROTTLING) LIVE_SERVICE_CPU_THROTTLING="$value" ;;
      CPU) LIVE_SERVICE_CPU="$value" ;;
      MEMORY) LIVE_SERVICE_MEMORY="$value" ;;
      CONCURRENCY) LIVE_SERVICE_CONCURRENCY="$value" ;;
      MIN_SCALE) LIVE_SERVICE_MIN_SCALE="$value" ;;
      MAX_SCALE) LIVE_SERVICE_MAX_SCALE="$value" ;;
    esac
  done < <(SERVICE_JSON="$service_json" "$PYTHON_BIN" - <<'PY'
import json
import os

raw = os.environ.get("SERVICE_JSON", "")
if not raw.strip():
    raise SystemExit(0)

doc = json.loads(raw)
template = doc.get("spec", {}).get("template", {}) or {}
metadata = template.get("metadata", {}) or {}
annotations = metadata.get("annotations", {}) or {}
spec = template.get("spec", {}) or {}
containers = spec.get("containers", []) or []
container = containers[0] if containers else {}
limits = (container.get("resources", {}) or {}).get("limits", {}) or {}

print(f'CPU_THROTTLING={annotations.get("run.googleapis.com/cpu-throttling", "default")}')
print(f'CPU={limits.get("cpu", "")}')
print(f'MEMORY={limits.get("memory", "")}')
print(f'CONCURRENCY={spec.get("containerConcurrency", "")}')
print(f'MIN_SCALE={annotations.get("autoscaling.knative.dev/minScale", "")}')
print(f'MAX_SCALE={annotations.get("autoscaling.knative.dev/maxScale", "")}')
PY
)
}

load_live_image_state() {
  LIVE_SERVICE_REV=$(gcloud run services describe "$SERVICE" \
    --region="$REGION" \
    --format="value(status.latestReadyRevisionName)" 2>/dev/null || true)
  LIVE_SERVICE_IMG=$(gcloud run services describe "$SERVICE" \
    --region="$REGION" \
    --format="value(spec.template.spec.containers[0].image)" 2>/dev/null || true)
  LIVE_JOB_IMG=$(gcloud run jobs describe "$JOB" \
    --region="$REGION" \
    --format="value(spec.template.spec.template.spec.containers[0].image)" 2>/dev/null || true)
  LIVE_VERIFY_JOB_IMG=$(gcloud run jobs describe "$VERIFY_JOB_NAME" \
    --region="$REGION" \
    --format="value(spec.template.spec.template.spec.containers[0].image)" 2>/dev/null || true)
  LIVE_VERIFY_JOB_ENTRYPOINT=$(gcloud run jobs describe "$VERIFY_JOB_NAME" \
    --region="$REGION" \
    --format="value(spec.template.spec.template.spec.containers[0].command[0],spec.template.spec.template.spec.containers[0].args)" 2>/dev/null || true)
  LIVE_OPTUNA_JOB_IMG=$(gcloud run jobs describe "$OPTUNA_JOB_NAME" \
    --region="$REGION" \
    --format="value(spec.template.spec.template.spec.containers[0].image)" 2>/dev/null || true)
  LIVE_OPTUNA_JOB_ENTRYPOINT=$(gcloud run jobs describe "$OPTUNA_JOB_NAME" \
    --region="$REGION" \
    --format="value(spec.template.spec.template.spec.containers[0].command[0],spec.template.spec.template.spec.containers[0].args)" 2>/dev/null || true)
}

build_verify_job_env_file() {
  local env_file="$1"
  local meta_file="$2"
  local pipeline_job_json
  pipeline_job_json=$(gcloud run jobs describe "$JOB" \
    --region="$REGION" \
    --format=json)

  PIPELINE_JOB_JSON="$pipeline_job_json" \
  VERIFY_JOB_NAME="$VERIFY_JOB_NAME" \
  STOCKVISION_WORKER_URL="$STOCKVISION_WORKER_URL" \
  VERIFY_ENV_FILE="$env_file" \
  "$PYTHON_BIN" - <<'PY' > "$meta_file"
import json
import os

doc = json.loads(os.environ["PIPELINE_JOB_JSON"])
spec = (
    doc.get("spec", {})
    .get("template", {})
    .get("spec", {})
)
container = (spec.get("template", {}) or {}).get("spec", {}).get("containers", [{}])[0]
envs = {}
for item in container.get("env", []):
    name = item.get("name")
    if not name:
        continue
    # Keep Secret Manager bindings out of --env-vars-file. Writing a secret
    # backed env var as a literal makes gcloud reject the job update.
    if "value" not in item:
        continue
    envs[name] = item.get("value", "")

envs["VERIFY_JOB_NAME"] = os.environ["VERIFY_JOB_NAME"]
envs["OPTUNA_JOB_NAME"] = os.environ.get("OPTUNA_JOB_NAME", "optuna-research-sweep")
envs["VERIFY_CALLBACK_TASK"] = "verify-v2"
envs["STOCKVISION_WORKER_URL"] = os.environ["STOCKVISION_WORKER_URL"]

with open(os.environ["VERIFY_ENV_FILE"], "w", encoding="utf-8") as fh:
    for key in sorted(envs):
        value = str(envs[key]).replace("\\", "\\\\").replace('"', '\\"')
        fh.write(f'{key}: "{value}"\n')

resources = container.get("resources", {}).get("limits", {})
print(f'CPU={resources.get("cpu", "4")}')
print(f'MEMORY={resources.get("memory", "4Gi")}')
print(f'SERVICE_ACCOUNT={spec.get("serviceAccountName", "")}')
print(f'MAX_RETRIES={spec.get("maxRetries", 3)}')
PY
}

load_verify_job_template() {
  local meta_file="$1"
  VERIFY_JOB_CPU=""
  VERIFY_JOB_MEMORY=""
  VERIFY_JOB_SERVICE_ACCOUNT=""
  VERIFY_JOB_MAX_RETRIES=""
  while IFS='=' read -r key value; do
    value="${value%$'\r'}"
    case "$key" in
      CPU) VERIFY_JOB_CPU="$value" ;;
      MEMORY) VERIFY_JOB_MEMORY="$value" ;;
      SERVICE_ACCOUNT) VERIFY_JOB_SERVICE_ACCOUNT="$value" ;;
      MAX_RETRIES) VERIFY_JOB_MAX_RETRIES="$value" ;;
    esac
  done < "$meta_file"
  # Verify is idempotent-ish but expensive: retries re-read/re-write D1 and can
  # multiply Cloud Run cost. Let the scheduler surface one failed execution
  # instead of retrying the full graph three more times.
  VERIFY_JOB_MAX_RETRIES="${VERIFY_JOB_MAX_RETRIES_OVERRIDE:-0}"
}

sync_verify_job() {
  local env_file="$1"
  local service_account_args=()
  if [ -n "${VERIFY_JOB_SERVICE_ACCOUNT:-}" ]; then
    service_account_args=(--service-account="$VERIFY_JOB_SERVICE_ACCOUNT")
  fi

  if gcloud run jobs describe "$VERIFY_JOB_NAME" \
      --region="$REGION" \
      --format="value(metadata.name)" >/dev/null 2>&1; then
    echo "=== Step 3b/4: Update Job $VERIFY_JOB_NAME image + entrypoint ==="
    if ! gcloud run jobs update "$VERIFY_JOB_NAME" \
        --region="$REGION" \
        --image="$NEW_IMAGE" \
        --command=python \
        --args=-m \
        --args=verify_job_main \
        --cpu="$VERIFY_JOB_CPU" \
        --memory="$VERIFY_JOB_MEMORY" \
        --max-retries="$VERIFY_JOB_MAX_RETRIES" \
        "${service_account_args[@]}" \
        --update-secrets="$RUN_SECRET_BINDINGS" \
        --env-vars-file="$env_file"; then
      echo "??Verify job update failed" >&2
      exit 4
    fi
    echo "??Verify job update succeeded"
  else
    echo "=== Step 3b/4: Create Job $VERIFY_JOB_NAME from $JOB template ==="
    if ! gcloud run jobs create "$VERIFY_JOB_NAME" \
        --region="$REGION" \
        --image="$NEW_IMAGE" \
        --command=python \
        --args=-m \
        --args=verify_job_main \
        --cpu="$VERIFY_JOB_CPU" \
        --memory="$VERIFY_JOB_MEMORY" \
        --max-retries="$VERIFY_JOB_MAX_RETRIES" \
        "${service_account_args[@]}" \
        --set-secrets="$RUN_SECRET_BINDINGS" \
        --env-vars-file="$env_file"; then
      echo "??Verify job create failed" >&2
      exit 4
    fi
    echo "??Verify job create succeeded"
  fi
  echo ""
}

sync_optuna_job() {
  local env_file="$1"
  local service_account_args=()
  if [ -n "${VERIFY_JOB_SERVICE_ACCOUNT:-}" ]; then
    service_account_args=(--service-account="$VERIFY_JOB_SERVICE_ACCOUNT")
  fi

  if gcloud run jobs describe "$OPTUNA_JOB_NAME" \
      --region="$REGION" \
      --format="value(metadata.name)" >/dev/null 2>&1; then
    echo "=== Step 3c/4: Update Job $OPTUNA_JOB_NAME image + entrypoint ==="
    if ! gcloud run jobs update "$OPTUNA_JOB_NAME" \
        --region="$REGION" \
        --image="$NEW_IMAGE" \
        --command=python \
        --args=-m \
        --args=optuna_job_main \
        --cpu="$VERIFY_JOB_CPU" \
        --memory="$VERIFY_JOB_MEMORY" \
        --task-timeout="$OPTUNA_JOB_TIMEOUT" \
        --max-retries=0 \
        "${service_account_args[@]}" \
        --update-secrets="$RUN_SECRET_BINDINGS" \
        --env-vars-file="$env_file"; then
      echo "??Optuna job update failed" >&2
      exit 4
    fi
    echo "??Optuna job update succeeded"
  else
    echo "=== Step 3c/4: Create Job $OPTUNA_JOB_NAME from $JOB template ==="
    if ! gcloud run jobs create "$OPTUNA_JOB_NAME" \
        --region="$REGION" \
        --image="$NEW_IMAGE" \
        --command=python \
        --args=-m \
        --args=optuna_job_main \
        --cpu="$VERIFY_JOB_CPU" \
        --memory="$VERIFY_JOB_MEMORY" \
        --task-timeout="$OPTUNA_JOB_TIMEOUT" \
        --max-retries=0 \
        "${service_account_args[@]}" \
        --set-secrets="$RUN_SECRET_BINDINGS" \
        --env-vars-file="$env_file"; then
      echo "??Optuna job create failed" >&2
      exit 4
    fi
    echo "??Optuna job create succeeded"
  fi
  echo ""
}

sync_strategy_mining_job() {
  local env_file="$1"
  local service_account_args=()
  local mining_cpu="${STRATEGY_MINING_JOB_CPU:-${VERIFY_JOB_CPU:-2}}"
  local mining_memory="${STRATEGY_MINING_JOB_MEMORY:-${VERIFY_JOB_MEMORY:-4Gi}}"
  if [ -n "${VERIFY_JOB_SERVICE_ACCOUNT:-}" ]; then
    service_account_args=(--service-account="$VERIFY_JOB_SERVICE_ACCOUNT")
  fi

  if gcloud run jobs describe "$STRATEGY_MINING_JOB_NAME" \
      --region="$REGION" \
      --format="value(metadata.name)" >/dev/null 2>&1; then
    echo "=== Step 3d/4: Update Job $STRATEGY_MINING_JOB_NAME image + entrypoint ==="
    if ! gcloud run jobs update "$STRATEGY_MINING_JOB_NAME" \
        --region="$REGION" \
        --image="$NEW_IMAGE" \
        --command=python \
        --args=-m \
        --args=strategy_mining_job_main \
        --cpu="$mining_cpu" \
        --memory="$mining_memory" \
        --task-timeout="$STRATEGY_MINING_JOB_TIMEOUT" \
        --max-retries=0 \
        "${service_account_args[@]}" \
        --update-secrets="$RUN_SECRET_BINDINGS" \
        --env-vars-file="$env_file"; then
      echo "??Strategy mining job update failed" >&2
      exit 4
    fi
    echo "??Strategy mining job update succeeded"
  else
    echo "=== Step 3d/4: Create Job $STRATEGY_MINING_JOB_NAME ==="
    if ! gcloud run jobs create "$STRATEGY_MINING_JOB_NAME" \
        --region="$REGION" \
        --image="$NEW_IMAGE" \
        --command=python \
        --args=-m \
        --args=strategy_mining_job_main \
        --cpu="$mining_cpu" \
        --memory="$mining_memory" \
        --task-timeout="$STRATEGY_MINING_JOB_TIMEOUT" \
        --max-retries=0 \
        "${service_account_args[@]}" \
        --set-secrets="$RUN_SECRET_BINDINGS" \
        --env-vars-file="$env_file"; then
      echo "??Strategy mining job create failed" >&2
      exit 4
    fi
    echo "??Strategy mining job create succeeded"
  fi
  echo ""
}

run_preflight() {
  echo "=== Preflight: local deploy inputs ==="
  require_nonempty "GCS_BUCKET_NAME" "Example: export GCS_BUCKET_NAME=stockvision-models"
  require_nonempty "RETRAIN_LOCK_BUCKET" "Usually mirror GCS_BUCKET_NAME for retrain locking"
  require_nonempty "GCP_PROJECT_ID" "Required by ml-controller /pipeline/v2/run Cloud Run Job trigger"
  require_nonempty "GCP_REGION" "Required by ml-controller /pipeline/v2/run Cloud Run Job trigger"
  require_nonempty "PIPELINE_JOB_NAME" "Required by ml-controller /pipeline/v2/run Cloud Run Job trigger"
  require_nonempty "VERIFY_JOB_NAME" "Required by ml-controller /verify/run Cloud Run Job trigger"
  require_nonempty "OPTUNA_JOB_NAME" "Required by ml-controller /optuna/research_sweep/run Cloud Run Job trigger"
  require_nonempty "CF_API_TOKEN_SECRET" "Secret Manager reference for Cloudflare API token, e.g. stockvision-cf-api-token:latest"
  require_nonempty "STOCKVISION_AUTH_TOKEN_SECRET" "Secret Manager reference for Worker service token, e.g. stockvision-stockvision-auth-token:latest"
  require_nonempty "ML_CONTROLLER_SECRET_SECRET" "Secret Manager reference for ml-controller auth token, e.g. stockvision-ml-controller-secret:latest"
  require_nonempty "MODAL_TOKEN_ID_SECRET" "Secret Manager reference for Modal token id, e.g. stockvision-modal-token-id:latest"
  require_nonempty "MODAL_TOKEN_SECRET_SECRET" "Secret Manager reference for Modal token secret, e.g. stockvision-modal-token-secret:latest"

  for var_name in "${REQUIRED_ENV_VARS[@]}"; do
    print_preflight_value "$var_name"
  done
  print_preflight_value "CF_API_TOKEN_SECRET"
  print_preflight_value "STOCKVISION_AUTH_TOKEN_SECRET"
  print_preflight_value "ML_CONTROLLER_SECRET_SECRET"
  print_preflight_value "MODAL_TOKEN_ID_SECRET"
  print_preflight_value "MODAL_TOKEN_SECRET_SECRET"
  print_preflight_value "OPTUNA_JOB_TIMEOUT"
  echo ""

  echo "=== Preflight: current live service env drift ==="
  load_live_missing_envs
  if [ -z "${LIVE_MISSING_ENV_NAMES:-}" ]; then
    echo "  Live service already has all required env keys."
  else
    echo "  Live service missing required env keys: $LIVE_MISSING_ENV_NAMES"
    echo "  Deploy is expected to repair this via --update-env-vars / --update-secrets."
  fi
  echo ""

  echo "=== Preflight: Cloud Run runtime cost settings ==="
  load_live_runtime_settings
  echo "  cpu-throttling     : ${LIVE_SERVICE_CPU_THROTTLING:-unknown}"
  echo "  cpu / memory       : ${LIVE_SERVICE_CPU:-unknown} / ${LIVE_SERVICE_MEMORY:-unknown}"
  echo "  concurrency        : ${LIVE_SERVICE_CONCURRENCY:-unknown}"
  echo "  min / max scale    : ${LIVE_SERVICE_MIN_SCALE:-default} / ${LIVE_SERVICE_MAX_SCALE:-default}"
  echo "  Note: this script only reports runtime settings; keep quality first and change CPU policy only after P2/P4 batch metrics prove idle cost."
  echo ""

  echo "=== Preflight: Service / Job image sync ==="
  load_live_image_state
  if [ -n "${LIVE_SERVICE_REV:-}" ]; then
    echo "  Live service revision : ${LIVE_SERVICE_REV}"
  fi
  if [ -n "${LIVE_SERVICE_IMG:-}" ]; then
    echo "  Live service image    : ${LIVE_SERVICE_IMG}"
  fi
  if [ -n "${LIVE_JOB_IMG:-}" ]; then
    echo "  Live job image        : ${LIVE_JOB_IMG}"
  fi
  if [ -n "${LIVE_VERIFY_JOB_IMG:-}" ]; then
    echo "  Live verify image     : ${LIVE_VERIFY_JOB_IMG}"
    echo "  Live verify entrypoint: ${LIVE_VERIFY_JOB_ENTRYPOINT:-unknown}"
  fi
  if [ -n "${LIVE_OPTUNA_JOB_IMG:-}" ]; then
    echo "  Live optuna image     : ${LIVE_OPTUNA_JOB_IMG}"
    echo "  Live optuna entrypoint: ${LIVE_OPTUNA_JOB_ENTRYPOINT:-unknown}"
  fi

  if [ -z "${LIVE_SERVICE_IMG:-}" ] || [ -z "${LIVE_JOB_IMG:-}" ] || [ -z "${LIVE_VERIFY_JOB_IMG:-}" ] || [ -z "${LIVE_OPTUNA_JOB_IMG:-}" ]; then
    echo "  Unable to fully verify Service / Job image drift from current environment."
  elif [ "$LIVE_SERVICE_IMG" = "$LIVE_JOB_IMG" ] && [ "$LIVE_SERVICE_IMG" = "$LIVE_VERIFY_JOB_IMG" ] && [ "$LIVE_SERVICE_IMG" = "$LIVE_OPTUNA_JOB_IMG" ]; then
    echo "  Service / Job image sync: OK"
  else
    echo "  Service / Job image sync: DRIFT DETECTED"
    echo "  Deploy should re-sync the Job image after Service deploy."
  fi
  echo ""
}

# ── Sanity checks ────────────────────────────────────────────────────────────
if ! command -v gcloud >/dev/null 2>&1; then
  echo "❌ ERROR: gcloud CLI not found in PATH" >&2
  exit 1
fi
detect_python
if [ ! -d "$MLC_DIR" ] || [ ! -f "$MLC_DIR/main.py" ]; then
  echo "❌ ERROR: ml-controller source not found at $MLC_DIR" >&2
  exit 1
fi
if [ ! -d "$MLS_DIR" ] || [ ! -f "$MLS_DIR/modal_app.py" ]; then
  echo "❌ ERROR: ml-service source not found at $MLS_DIR (required by root Dockerfile)" >&2
  exit 1
fi
if [ ! -f "$ROOT_DOCKERFILE" ]; then
  echo "❌ ERROR: root Dockerfile not found at $ROOT_DOCKERFILE" >&2
  exit 1
fi
if [ "$WITH_MODAL" = "1" ] && ! command -v curl >/dev/null 2>&1; then
  echo "❌ ERROR: --with-modal needs curl in PATH" >&2
  exit 1
fi

run_preflight
if [ "$CHECK_ONLY" = "1" ]; then
  echo "✅ Preflight passed (--check-only). No deploy performed."
  exit 0
fi

# ── Step 1/4: Deploy Service (from repo root so Dockerfile sees ml-service/) ─
cd "$SCRIPT_DIR"
echo "=== Step 1/4: Deploy Service $SERVICE (CWD=$SCRIPT_DIR, Dockerfile=repo root) ==="
if ! gcloud run deploy "$SERVICE" \
    --source . \
    --region="$REGION" \
    --timeout=3600 \
    --update-env-vars="$RUNTIME_ENV_VARS" \
    --update-secrets="$RUN_SECRET_BINDINGS" \
    --quiet; then
  echo "❌ Service deploy failed" >&2
  exit 2
fi
echo "✅ Service deploy succeeded"
echo ""

# ── Step 2/4: Extract new image SHA ──────────────────────────────────────────
echo "=== Step 2/4: Extract new image SHA from Service ==="
NEW_IMAGE=$(gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --format="value(spec.template.spec.containers[0].image)" 2>/dev/null || true)
if [ -z "${NEW_IMAGE:-}" ]; then
  echo "❌ ERROR: Could not read Service image from describe output" >&2
  exit 3
fi
echo "New Service image: $NEW_IMAGE"
echo ""
VERIFY_JOB_ENV_FILE=$(mktemp -t verify_job_env.XXXXXX.yaml 2>/dev/null || echo "/tmp/verify_job_env.$$.yaml")
VERIFY_JOB_META_FILE=$(mktemp -t verify_job_meta.XXXXXX.txt 2>/dev/null || echo "/tmp/verify_job_meta.$$.txt")
trap 'rm -f "$VERIFY_JOB_ENV_FILE" "$VERIFY_JOB_META_FILE"' EXIT
build_verify_job_env_file "$VERIFY_JOB_ENV_FILE" "$VERIFY_JOB_META_FILE"
load_verify_job_template "$VERIFY_JOB_META_FILE"

# ── Step 3/4: Update Job image ───────────────────────────────────────────────
echo "=== Step 3/4: Update Job $JOB image to match Service ==="
if ! gcloud run jobs update "$JOB" \
    --region="$REGION" \
    --image="$NEW_IMAGE" \
    --update-secrets="$RUN_SECRET_BINDINGS" \
    --update-env-vars="$RUNTIME_ENV_VARS"; then
  echo "❌ Job update failed" >&2
  exit 4
fi
echo "✅ Job update succeeded"
echo ""

# ── Step 4/4: Verify ─────────────────────────────────────────────────────────
sync_verify_job "$VERIFY_JOB_ENV_FILE"
sync_optuna_job "$VERIFY_JOB_ENV_FILE"
sync_strategy_mining_job "$VERIFY_JOB_ENV_FILE"

echo "=== Step 4/4: Verify Service and Job image match ==="
SERVICE_IMG=$(gcloud run services describe "$SERVICE" --region="$REGION" \
  --format="value(spec.template.spec.containers[0].image)")
JOB_IMG=$(gcloud run jobs describe "$JOB" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].image)")
VERIFY_JOB_IMG=$(gcloud run jobs describe "$VERIFY_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].image)")
OPTUNA_JOB_IMG=$(gcloud run jobs describe "$OPTUNA_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].image)")
STRATEGY_MINING_JOB_IMG=$(gcloud run jobs describe "$STRATEGY_MINING_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].image)")
VERIFY_JOB_COMMAND=$(gcloud run jobs describe "$VERIFY_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].command[0])")
VERIFY_JOB_ARGS=$(gcloud run jobs describe "$VERIFY_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].args)")
OPTUNA_JOB_COMMAND=$(gcloud run jobs describe "$OPTUNA_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].command[0])")
OPTUNA_JOB_ARGS=$(gcloud run jobs describe "$OPTUNA_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].args)")
STRATEGY_MINING_JOB_COMMAND=$(gcloud run jobs describe "$STRATEGY_MINING_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].command[0])")
STRATEGY_MINING_JOB_ARGS=$(gcloud run jobs describe "$STRATEGY_MINING_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].args)")

if [ "$SERVICE_IMG" != "$JOB_IMG" ] || [ "$SERVICE_IMG" != "$VERIFY_JOB_IMG" ] || [ "$SERVICE_IMG" != "$OPTUNA_JOB_IMG" ] || [ "$SERVICE_IMG" != "$STRATEGY_MINING_JOB_IMG" ]; then
  echo "❌ VERIFICATION FAILED — images differ:" >&2
  echo "  Service: $SERVICE_IMG" >&2
  echo "  Job    : $JOB_IMG" >&2
  echo "  Verify : $VERIFY_JOB_IMG" >&2
  echo "  Optuna : $OPTUNA_JOB_IMG" >&2
  echo "  Mining : $STRATEGY_MINING_JOB_IMG" >&2
  exit 5
fi

if [ "$VERIFY_JOB_COMMAND" != "python" ] || [ "$VERIFY_JOB_ARGS" != "-m;verify_job_main" ]; then
  echo "??VERIFICATION FAILED ??verify job entrypoint drift:" >&2
  echo "  command : $VERIFY_JOB_COMMAND" >&2
  echo "  args    : $VERIFY_JOB_ARGS" >&2
  exit 5
fi

if [ "$OPTUNA_JOB_COMMAND" != "python" ] || [ "$OPTUNA_JOB_ARGS" != "-m;optuna_job_main" ]; then
  echo "??VERIFICATION FAILED ??optuna job entrypoint drift:" >&2
  echo "  command : $OPTUNA_JOB_COMMAND" >&2
  echo "  args    : $OPTUNA_JOB_ARGS" >&2
  exit 5
fi

if [ "$STRATEGY_MINING_JOB_COMMAND" != "python" ] || [ "$STRATEGY_MINING_JOB_ARGS" != "-m;strategy_mining_job_main" ]; then
  echo "??VERIFICATION FAILED ??strategy mining job entrypoint drift:" >&2
  echo "  command : $STRATEGY_MINING_JOB_COMMAND" >&2
  echo "  args    : $STRATEGY_MINING_JOB_ARGS" >&2
  exit 5
fi

SERVICE_REV=$(gcloud run services describe "$SERVICE" --region="$REGION" \
  --format="value(status.latestReadyRevisionName)")

echo "✅ Verification passed — Service and Job on identical image"
echo ""

# ── Step 5 (optional): Modal deploy via /admin/modal-deploy ──────────────────
MODAL_RESULT=""
if [ "$WITH_MODAL" = "1" ]; then
  echo "=== Step 5/5: Trigger Modal deploy (--with-modal) ==="
  if [ -z "${ML_CONTROLLER_TOKEN:-}" ]; then
    echo "❌ ERROR: ML_CONTROLLER_TOKEN is required for --with-modal" >&2
    exit 6
  fi
  CTOKEN="${ML_CONTROLLER_TOKEN}"
  URL="${ML_CONTROLLER_URL:-$ML_CONTROLLER_URL_DEFAULT}/admin/modal-deploy"
  NOTE_JSON=$(printf '{"note":"deploy_ml_controller.sh rev=%s"}' "$SERVICE_REV")
  # Use mktemp for portable temp file (Windows git-bash /tmp/ may not exist)
  MODAL_RESP_FILE=$(mktemp -t modal_deploy_resp.XXXXXX.json 2>/dev/null || echo "/tmp/modal_deploy_resp.$$.json")
  trap 'rm -f "$MODAL_RESP_FILE"' EXIT
  echo "POST $URL"
  set +e
  HTTP_STATUS=$(curl -sS -o "$MODAL_RESP_FILE" -w "%{http_code}" \
      -X POST "$URL" \
      -H "X-Controller-Token: $CTOKEN" \
      -H "Content-Type: application/json" \
      --max-time 650 \
      -d "$NOTE_JSON")
  CURL_RC=$?
  set -e
  if [ "$CURL_RC" -ne 0 ] || [ "$HTTP_STATUS" != "200" ]; then
    echo "❌ Modal deploy endpoint failed (curl_rc=$CURL_RC http=$HTTP_STATUS)" >&2
    echo "Response body ($MODAL_RESP_FILE):" >&2
    cat "$MODAL_RESP_FILE" >&2 || true
    echo "" >&2
    exit 6
  fi
  # Parse duration from response — surface parse failure instead of silent '?'
  MODAL_RESP_FILE_PY="$MODAL_RESP_FILE"
  if command -v cygpath >/dev/null 2>&1; then
    MODAL_RESP_FILE_PY=$(cygpath -w "$MODAL_RESP_FILE")
  fi
  MODAL_DURATION=$(MODAL_RESP_FILE_PY="$MODAL_RESP_FILE_PY" "$PYTHON_BIN" -c "
import json, os, sys
try:
    with open(os.environ['MODAL_RESP_FILE_PY'], encoding='utf-8') as f:
        d = json.load(f)
    v = d.get('duration_sec')
    print(f'{v:.1f}' if isinstance(v, (int, float)) else str(v))
except Exception as e:
    print(f'parse_err:{type(e).__name__}', file=sys.stderr)
    print('unknown')
" 2>&1)
  echo "✅ Modal deploy succeeded (duration ${MODAL_DURATION}s)"
  MODAL_RESULT="Modal         : redeployed (${MODAL_DURATION}s)"
  echo ""
fi

echo "=== Deploy Summary ==="
echo "  Service revision : $SERVICE_REV"
echo "  Image            : $SERVICE_IMG"
echo "  Pipeline job     : synced"
echo "  Verify job       : synced"
echo "  Optuna job       : synced"
echo "  Strategy mining  : synced"
[ -n "$MODAL_RESULT" ] && echo "  $MODAL_RESULT"
echo ""
echo "Next step: trigger pipeline-v2 to verify new code path executes. Example:"
echo "  curl -sX POST '$ML_CONTROLLER_URL_DEFAULT/pipeline/v2/run?date=\$(date +%F)' \\"
echo "       -H 'X-Controller-Token: \$CTOKEN' -H 'Content-Length: 0' -d ''"
