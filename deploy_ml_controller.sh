#!/usr/bin/env bash
# Release ml-controller and its Cloud Run Jobs from one attested source.
#
# Safety contracts:
#   - production deploys require an explicit matching PRODUCTION_BRANCH;
#   - dirty or detached source trees are rejected;
#   - Service and Jobs use dedicated runtime service accounts;
#   - Git commit/tree and Scheduler manifest hashes are injected into runtime;
#   - --with-modal deploys directly from ml-service/.venv with the same Git tag;
#   - no serving endpoint can execute a Modal deployment.
#
# Usage:
#   GCS_BUCKET_NAME=stockvision-models PRODUCTION_BRANCH=<approved-branch> \
#     bash deploy_ml_controller.sh [--check-only] [--with-modal]
#
# This script mutates production unless --check-only is supplied.

set -euo pipefail

REGION="asia-east1"
SERVICE="ml-controller"
JOB="pipeline-v2"
ML_CONTROLLER_URL_DEFAULT="https://ml-controller-530028717113.asia-east1.run.app"
ML_CONTROLLER_PUBLIC_URL="${ML_CONTROLLER_PUBLIC_URL:-$ML_CONTROLLER_URL_DEFAULT}"
SHIOAJI_PROXY_URL="${SHIOAJI_PROXY_URL:-https://shioaji-proxy-530028717113.asia-east1.run.app}"
GCS_BUCKET_NAME="${GCS_BUCKET_NAME:-}"
RETRAIN_LOCK_BUCKET="${RETRAIN_LOCK_BUCKET:-${GCS_BUCKET_NAME}}"
GCP_PROJECT_ID="${GCP_PROJECT_ID:-gen-lang-client-0602998820}"
GCP_REGION="${GCP_REGION:-asia-east1}"
SERVICE_RUNTIME_SERVICE_ACCOUNT="${SERVICE_RUNTIME_SERVICE_ACCOUNT:-stockvision-ml-controller@${GCP_PROJECT_ID}.iam.gserviceaccount.com}"
JOB_RUNTIME_SERVICE_ACCOUNT="${JOB_RUNTIME_SERVICE_ACCOUNT:-stockvision-pipeline@${GCP_PROJECT_ID}.iam.gserviceaccount.com}"
BUILD_SERVICE_ACCOUNT="${BUILD_SERVICE_ACCOUNT:-stockvision-cloudrun-builder@${GCP_PROJECT_ID}.iam.gserviceaccount.com}"
PRODUCTION_BRANCH="${PRODUCTION_BRANCH:-}"
CANONICAL_PRODUCTION_BRANCH="${CANONICAL_PRODUCTION_BRANCH:-main}"
ALLOW_NON_MAIN_PRODUCTION_DEPLOY="${ALLOW_NON_MAIN_PRODUCTION_DEPLOY:-0}"
PIPELINE_JOB_NAME="${PIPELINE_JOB_NAME:-pipeline-v2}"
VERIFY_JOB_NAME="${VERIFY_JOB_NAME:-verify-v2}"
SCREENER_JOB_NAME="${SCREENER_JOB_NAME:-screener-v2}"
S12_STRUCTURE_JOB_NAME="${S12_STRUCTURE_JOB_NAME:-s12-structure-batch}"
OPTUNA_JOB_NAME="${OPTUNA_JOB_NAME:-optuna-research-sweep}"
OOF_MATERIALIZE_JOB_NAME="${OOF_MATERIALIZE_JOB_NAME:-active8-oof-materialize}"
DATASET_SNAPSHOT_JOB_NAME="${DATASET_SNAPSHOT_JOB_NAME:-dataset-snapshot-export}"
OPTUNA_JOB_TIMEOUT="${OPTUNA_JOB_TIMEOUT:-10800s}"
OOF_MATERIALIZE_JOB_TIMEOUT="${OOF_MATERIALIZE_JOB_TIMEOUT:-3600s}"
DATASET_SNAPSHOT_JOB_TIMEOUT="${DATASET_SNAPSHOT_JOB_TIMEOUT:-3600s}"
SCREENER_JOB_TIMEOUT="${SCREENER_JOB_TIMEOUT:-7200s}"
S12_STRUCTURE_JOB_TIMEOUT="${S12_STRUCTURE_JOB_TIMEOUT:-21600s}"
STRATEGY_MINING_JOB_TIMEOUT="${STRATEGY_MINING_JOB_TIMEOUT:-28800s}"
STOCKVISION_WORKER_URL="${STOCKVISION_WORKER_URL:-https://stockvision-worker.angus-solo-dev.workers.dev}"
CF_D1_DB_ID="${CF_D1_DB_ID:-6401a5f6-5767-4fa8-a1a7-ec8d4739ac79}"
CF_D1_LEARNING_DB_ID="${CF_D1_LEARNING_DB_ID:-73599848-b73b-4bac-9144-df638b877dbc}"
CF_D1_OPS_DB_ID="${CF_D1_OPS_DB_ID:-d9914406-bb36-45a4-bdc4-fe565ed910d3}"
CF_D1_EXECUTION_DB_ID="${CF_D1_EXECUTION_DB_ID:-731b3c7e-ad14-4e0e-b38e-4de53c5a83fa}"
CF_D1_PAPER_DB_ID="${CF_D1_PAPER_DB_ID:-bd0a99b2-077b-4d57-8971-07ff8c7f19e1}"
CF_D1_RESEARCH_DB_ID="${CF_D1_RESEARCH_DB_ID:-9332506a-ef37-43d4-9ea3-5aa70b1561d2}"
MULTI_D1_ACTIVE_DOMAINS="${MULTI_D1_ACTIVE_DOMAINS:-learning,ops,execution,paper,research}"
MULTI_D1_STRICT="${MULTI_D1_STRICT:-true}"
MULTI_D1_LEARNING_ROUTING_CONTRACT="${MULTI_D1_LEARNING_ROUTING_CONTRACT:-learning-single-writer-epoch-v1}"
MULTI_D1_LEARNING_CUTOVER_RECEIPT_ID="${MULTI_D1_LEARNING_CUTOVER_RECEIPT_ID:-data-domain-cutover-probe:learning:6a148fc0-6cc5-4347-9de6-87a689e097a2}"
MULTI_D1_LEARNING_WRITER_EPOCH="${MULTI_D1_LEARNING_WRITER_EPOCH:-260906}"
MULTI_D1_EXECUTION_ROUTING_CONTRACT="${MULTI_D1_EXECUTION_ROUTING_CONTRACT:-execution-single-writer-epoch-v1}"
MULTI_D1_EXECUTION_CUTOVER_RECEIPT_ID="${MULTI_D1_EXECUTION_CUTOVER_RECEIPT_ID:-data-domain-cutover-probe:execution:775a2afb-bd4a-4f9c-8313-d0f6f4a88db8}"
MULTI_D1_EXECUTION_WRITER_EPOCH="${MULTI_D1_EXECUTION_WRITER_EPOCH:-2}"
MULTI_D1_PAPER_ROUTING_CONTRACT="${MULTI_D1_PAPER_ROUTING_CONTRACT:-paper-single-writer-epoch-v1}"
MULTI_D1_PAPER_CUTOVER_RECEIPT_ID="${MULTI_D1_PAPER_CUTOVER_RECEIPT_ID:-data-domain-cutover-probe:paper:fecbbe3d-b491-4c70-8aee-e45ce4dd5f26}"
MULTI_D1_PAPER_WRITER_EPOCH="${MULTI_D1_PAPER_WRITER_EPOCH:-6}"
MULTI_D1_RESEARCH_ROUTING_CONTRACT="${MULTI_D1_RESEARCH_ROUTING_CONTRACT:-research-single-writer-epoch-v1}"
MULTI_D1_RESEARCH_CUTOVER_RECEIPT_ID="${MULTI_D1_RESEARCH_CUTOVER_RECEIPT_ID:-data-domain-cutover-probe:research:5f34d52d-c437-41e1-9c67-c4a97f30a281}"
MULTI_D1_RESEARCH_WRITER_EPOCH="${MULTI_D1_RESEARCH_WRITER_EPOCH:-2}"
CF_D1_CORE_DB_ID="${CF_D1_CORE_DB_ID:-8cc0ab1f-088c-4c21-b282-bcd4c790c7da}"
CF_D1_MARKET_DB_ID="${CF_D1_MARKET_DB_ID:-067bbeb0-1247-416a-96dd-138315345319}"
CF_KV_NAMESPACE_ID="${CF_KV_NAMESPACE_ID:-39dcebcf5b6848c98f269ef9a48dc3f8}"
CF_API_TOKEN_SECRET="${CF_API_TOKEN_SECRET:-stockvision-cf-api-token:latest}"
STOCKVISION_AUTH_TOKEN_SECRET="${STOCKVISION_AUTH_TOKEN_SECRET:-stockvision-stockvision-auth-token:latest}"
STRATEGY_MINING_CALLBACK_TOKEN_SECRET="${STRATEGY_MINING_CALLBACK_TOKEN_SECRET:-stockvision-strategy-mining-callback-token:latest}"
RETRAIN_CALLBACK_TOKEN_SECRET="${RETRAIN_CALLBACK_TOKEN_SECRET:-stockvision-retrain-callback-token:latest}"
ML_CONTROLLER_SECRET_SECRET="${ML_CONTROLLER_SECRET_SECRET:-stockvision-ml-controller-secret:latest}"
MODAL_TOKEN_ID_SECRET="${MODAL_TOKEN_ID_SECRET:-stockvision-modal-token-id:latest}"
MODAL_TOKEN_SECRET_SECRET="${MODAL_TOKEN_SECRET_SECRET:-stockvision-modal-token-secret:latest}"
FINLAB_API_KEY_SECRET="${FINLAB_API_KEY_SECRET:-finlab-api-key:latest}"
FINLAB_REFRESH_TOKEN_SECRET="${FINLAB_REFRESH_TOKEN_SECRET:-finlab-refresh-token:latest}"
FINLAB_SESSION_ID_SECRET="${FINLAB_SESSION_ID_SECRET:-finlab-session-id:latest}"
SHIOAJI_API_KEY_SECRET="${SHIOAJI_API_KEY_SECRET:-stockvision-finlab-exec-shioaji-api-key:latest}"
SHIOAJI_SECRET_KEY_SECRET="${SHIOAJI_SECRET_KEY_SECRET:-stockvision-finlab-exec-shioaji-secret-key:latest}"
SHIOAJI_ACCOUNT_ID_SECRET="${SHIOAJI_ACCOUNT_ID_SECRET:-stockvision-finlab-exec-shioaji-account-id:latest}"
SHIOAJI_CERT_PERSON_ID_SECRET="${SHIOAJI_CERT_PERSON_ID_SECRET:-stockvision-finlab-exec-shioaji-cert-person-id:latest}"
SHIOAJI_CERT_PASSWORD_SECRET="${SHIOAJI_CERT_PASSWORD_SECRET:-stockvision-finlab-exec-shioaji-cert-password:latest}"
SHIOAJI_CERT_PFX_SECRET="${SHIOAJI_CERT_PFX_SECRET:-stockvision-finlab-exec-shioaji-cert-pfx:latest}"
PROXY_SERVICE_TOKEN_SECRET="${PROXY_SERVICE_TOKEN_SECRET:-stockvision-shioaji-proxy-service-token:latest}"
SHIOAJI_CERT_MOUNT_PATH="${SHIOAJI_CERT_MOUNT_PATH:-/secrets/shioaji/cert.pfx}"
FINLAB_SECRET_BINDINGS="FINLAB_API_KEY=${FINLAB_API_KEY_SECRET},FINLAB_REFRESH_TOKEN=${FINLAB_REFRESH_TOKEN_SECRET},FINLAB_SESSION_ID=${FINLAB_SESSION_ID_SECRET}"
BASE_SECRET_BINDINGS="${FINLAB_SECRET_BINDINGS},CF_API_TOKEN=${CF_API_TOKEN_SECRET},STOCKVISION_AUTH_TOKEN=${STOCKVISION_AUTH_TOKEN_SECRET},ML_CONTROLLER_SECRET=${ML_CONTROLLER_SECRET_SECRET},MODAL_TOKEN_ID=${MODAL_TOKEN_ID_SECRET},MODAL_TOKEN_SECRET=${MODAL_TOKEN_SECRET_SECRET}"
STRATEGY_MINING_SECRET_BINDINGS="${FINLAB_SECRET_BINDINGS},STRATEGY_MINING_CALLBACK_TOKEN=${STRATEGY_MINING_CALLBACK_TOKEN_SECRET}"
SHIOAJI_SECRET_BINDINGS="SHIOAJI_API_KEY=${SHIOAJI_API_KEY_SECRET},SHIOAJI_SECRET_KEY=${SHIOAJI_SECRET_KEY_SECRET},SHIOAJI_ACCOUNT_ID=${SHIOAJI_ACCOUNT_ID_SECRET},SHIOAJI_CERT_PERSON_ID=${SHIOAJI_CERT_PERSON_ID_SECRET},SHIOAJI_CERT_PASSWORD=${SHIOAJI_CERT_PASSWORD_SECRET},${SHIOAJI_CERT_MOUNT_PATH}=${SHIOAJI_CERT_PFX_SECRET}"
RUN_SECRET_BINDINGS="${BASE_SECRET_BINDINGS},${SHIOAJI_SECRET_BINDINGS}"
SERVICE_SECRET_BINDINGS="${RUN_SECRET_BINDINGS},RETRAIN_CALLBACK_TOKEN=${RETRAIN_CALLBACK_TOKEN_SECRET}"
S12_STRUCTURE_SECRET_BINDINGS="CF_API_TOKEN=${CF_API_TOKEN_SECRET},STOCKVISION_AUTH_TOKEN=${STOCKVISION_AUTH_TOKEN_SECRET},PROXY_SERVICE_TOKEN=${PROXY_SERVICE_TOKEN_SECRET}"
PIPELINE_STATE_SPACE_OVERLAY_MODE="${PIPELINE_STATE_SPACE_OVERLAY_MODE:-disabled}"
PIPELINE_STATE_SPACE_OVERLAY_SOFT_DEADLINE_SECONDS="${PIPELINE_STATE_SPACE_OVERLAY_SOFT_DEADLINE_SECONDS:-120}"
MODAL_PREDICT_BATCH_SIZE_CANDIDATES="${MODAL_PREDICT_BATCH_SIZE_CANDIDATES:-80|120|160}"
MODAL_PREDICT_BATCH_SIZE_OBSERVATION_SOURCE="${MODAL_PREDICT_BATCH_SIZE_OBSERVATION_SOURCE:-auto}"
TIMESFM_MIN_SEQUENCE_COVERAGE="${TIMESFM_MIN_SEQUENCE_COVERAGE:-0.80}"
TIMESFM_MIN_SEQUENCE_POINTS="${TIMESFM_MIN_SEQUENCE_POINTS:-50}"
FINLAB_BACKFILL_EXECUTOR="${FINLAB_BACKFILL_EXECUTOR:-modal}"
STRATEGY_MINING_JOB_NAME="${STRATEGY_MINING_JOB_NAME:-strategy-mining-research}"
STRATEGY_MINING_EXECUTION_ENABLED="${STRATEGY_MINING_EXECUTION_ENABLED:-true}"
STRATEGY_MINING_BACKEND="${STRATEGY_MINING_BACKEND:-modal}"
RUNTIME_ENV_VARS="GCS_BUCKET_NAME=${GCS_BUCKET_NAME},RETRAIN_LOCK_BUCKET=${RETRAIN_LOCK_BUCKET},GCP_PROJECT_ID=${GCP_PROJECT_ID},GCP_REGION=${GCP_REGION},PIPELINE_JOB_NAME=${PIPELINE_JOB_NAME},VERIFY_JOB_NAME=${VERIFY_JOB_NAME},SCREENER_JOB_NAME=${SCREENER_JOB_NAME},S12_STRUCTURE_JOB_NAME=${S12_STRUCTURE_JOB_NAME},OPTUNA_JOB_NAME=${OPTUNA_JOB_NAME},OOF_MATERIALIZE_JOB_NAME=${OOF_MATERIALIZE_JOB_NAME},STOCKVISION_WORKER_URL=${STOCKVISION_WORKER_URL},ML_CONTROLLER_PUBLIC_URL=${ML_CONTROLLER_PUBLIC_URL},CF_D1_DB_ID=${CF_D1_DB_ID},CF_KV_NAMESPACE_ID=${CF_KV_NAMESPACE_ID},S12_RESEARCH_KBARS_URL=https://shioaji-research-530028717113.asia-east1.run.app,SHIOAJI_CERT_PATH=${SHIOAJI_CERT_MOUNT_PATH},PIPELINE_STATE_SPACE_OVERLAY_MODE=${PIPELINE_STATE_SPACE_OVERLAY_MODE},PIPELINE_STATE_SPACE_OVERLAY_SOFT_DEADLINE_SECONDS=${PIPELINE_STATE_SPACE_OVERLAY_SOFT_DEADLINE_SECONDS},MODAL_PREDICT_BATCH_SIZE_CANDIDATES=${MODAL_PREDICT_BATCH_SIZE_CANDIDATES},MODAL_PREDICT_BATCH_SIZE_OBSERVATION_SOURCE=${MODAL_PREDICT_BATCH_SIZE_OBSERVATION_SOURCE},TIMESFM_MIN_SEQUENCE_COVERAGE=${TIMESFM_MIN_SEQUENCE_COVERAGE},TIMESFM_MIN_SEQUENCE_POINTS=${TIMESFM_MIN_SEQUENCE_POINTS},FINLAB_BACKFILL_EXECUTOR=${FINLAB_BACKFILL_EXECUTOR},STRATEGY_MINING_JOB_NAME=${STRATEGY_MINING_JOB_NAME},STRATEGY_MINING_EXECUTION_ENABLED=${STRATEGY_MINING_EXECUTION_ENABLED},STRATEGY_MINING_BACKEND=${STRATEGY_MINING_BACKEND}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},DATASET_SNAPSHOT_JOB_NAME=${DATASET_SNAPSHOT_JOB_NAME}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},CF_D1_LEARNING_DB_ID=${CF_D1_LEARNING_DB_ID}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},CF_D1_OPS_DB_ID=${CF_D1_OPS_DB_ID}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},CF_D1_EXECUTION_DB_ID=${CF_D1_EXECUTION_DB_ID}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},CF_D1_PAPER_DB_ID=${CF_D1_PAPER_DB_ID}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},CF_D1_RESEARCH_DB_ID=${CF_D1_RESEARCH_DB_ID}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},MULTI_D1_ACTIVE_DOMAINS=${MULTI_D1_ACTIVE_DOMAINS}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},MULTI_D1_STRICT=${MULTI_D1_STRICT}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},MULTI_D1_LEARNING_ROUTING_CONTRACT=${MULTI_D1_LEARNING_ROUTING_CONTRACT}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},MULTI_D1_LEARNING_CUTOVER_RECEIPT_ID=${MULTI_D1_LEARNING_CUTOVER_RECEIPT_ID}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},MULTI_D1_LEARNING_WRITER_EPOCH=${MULTI_D1_LEARNING_WRITER_EPOCH}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},MULTI_D1_EXECUTION_ROUTING_CONTRACT=${MULTI_D1_EXECUTION_ROUTING_CONTRACT}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},MULTI_D1_EXECUTION_CUTOVER_RECEIPT_ID=${MULTI_D1_EXECUTION_CUTOVER_RECEIPT_ID}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},MULTI_D1_EXECUTION_WRITER_EPOCH=${MULTI_D1_EXECUTION_WRITER_EPOCH}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},MULTI_D1_PAPER_ROUTING_CONTRACT=${MULTI_D1_PAPER_ROUTING_CONTRACT}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},MULTI_D1_PAPER_CUTOVER_RECEIPT_ID=${MULTI_D1_PAPER_CUTOVER_RECEIPT_ID}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},MULTI_D1_PAPER_WRITER_EPOCH=${MULTI_D1_PAPER_WRITER_EPOCH}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},MULTI_D1_RESEARCH_ROUTING_CONTRACT=${MULTI_D1_RESEARCH_ROUTING_CONTRACT}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},MULTI_D1_RESEARCH_CUTOVER_RECEIPT_ID=${MULTI_D1_RESEARCH_CUTOVER_RECEIPT_ID}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},MULTI_D1_RESEARCH_WRITER_EPOCH=${MULTI_D1_RESEARCH_WRITER_EPOCH}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},CF_D1_CORE_DB_ID=${CF_D1_CORE_DB_ID}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},CF_D1_MARKET_DB_ID=${CF_D1_MARKET_DB_ID}"
RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},SHIOAJI_PROXY_URL=${SHIOAJI_PROXY_URL}"
if [ -n "${CF_ACCOUNT_ID:-}" ]; then
  RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},CF_ACCOUNT_ID=${CF_ACCOUNT_ID}"
fi

gcloud_runtime_env_vars() {
  local comma_placeholder="__STOCKVISION_ACTIVE_DOMAIN_COMMA__"
  local active_pair="MULTI_D1_ACTIVE_DOMAINS=${MULTI_D1_ACTIVE_DOMAINS}"
  local encoded_active="${MULTI_D1_ACTIVE_DOMAINS//,/${comma_placeholder}}"
  local encoded
  if [[ "$RUNTIME_ENV_VARS" != *"$active_pair"* ]]; then
    echo "ERROR: active-domain env pair missing from runtime env vars" >&2
    return 1
  fi
  encoded="${RUNTIME_ENV_VARS/${active_pair}/MULTI_D1_ACTIVE_DOMAINS=${encoded_active}}"
  if [[ "$encoded" == *"@"* ]]; then
    echo "ERROR: runtime env value contains reserved gcloud delimiter @" >&2
    return 1
  fi
  encoded="${encoded//,/@}"
  encoded="${encoded//${comma_placeholder}/,}"
  printf '^@^%s' "$encoded"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MLC_DIR="$SCRIPT_DIR/ml-controller"
MLS_DIR="$SCRIPT_DIR/ml-service"
ROOT_DOCKERFILE="$SCRIPT_DIR/Dockerfile"
PYTHON_BIN=""
MODAL_PYTHON_BIN="${MODAL_PYTHON_BIN:-}"
SOURCE_SHA=""
SOURCE_TREE_SHA=""
SOURCE_BRANCH=""
SCHEDULER_MANIFEST_SHA256=""
PROVENANCE_LABELS=""

REQUIRED_ENV_VARS=(
  GCS_BUCKET_NAME
  RETRAIN_LOCK_BUCKET
  GCP_PROJECT_ID
  GCP_REGION
  SHIOAJI_PROXY_URL
  PIPELINE_JOB_NAME
  VERIFY_JOB_NAME
  SCREENER_JOB_NAME
  S12_STRUCTURE_JOB_NAME
  OPTUNA_JOB_NAME
  OOF_MATERIALIZE_JOB_NAME
  DATASET_SNAPSHOT_JOB_NAME
  STRATEGY_MINING_JOB_NAME
  STRATEGY_MINING_EXECUTION_ENABLED
  STRATEGY_MINING_BACKEND
  STOCKVISION_WORKER_URL
  CF_D1_DB_ID
  CF_D1_LEARNING_DB_ID
  CF_D1_OPS_DB_ID
  CF_D1_EXECUTION_DB_ID
  CF_D1_PAPER_DB_ID
  CF_D1_RESEARCH_DB_ID
  MULTI_D1_ACTIVE_DOMAINS
  MULTI_D1_STRICT
  MULTI_D1_LEARNING_ROUTING_CONTRACT
  MULTI_D1_LEARNING_CUTOVER_RECEIPT_ID
  MULTI_D1_LEARNING_WRITER_EPOCH
  MULTI_D1_EXECUTION_ROUTING_CONTRACT
  MULTI_D1_EXECUTION_CUTOVER_RECEIPT_ID
  MULTI_D1_EXECUTION_WRITER_EPOCH
  MULTI_D1_PAPER_ROUTING_CONTRACT
  MULTI_D1_PAPER_CUTOVER_RECEIPT_ID
  MULTI_D1_PAPER_WRITER_EPOCH
  MULTI_D1_RESEARCH_ROUTING_CONTRACT
  MULTI_D1_RESEARCH_CUTOVER_RECEIPT_ID
  MULTI_D1_RESEARCH_WRITER_EPOCH
  CF_D1_CORE_DB_ID
  CF_D1_MARKET_DB_ID
  CF_KV_NAMESPACE_ID
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

load_release_provenance() {
  if ! command -v git >/dev/null 2>&1; then
    echo "ERROR: git is required for immutable release provenance" >&2
    exit 7
  fi

  SOURCE_SHA=$(git -C "$SCRIPT_DIR" rev-parse HEAD)
  SOURCE_TREE_SHA=$(git -C "$SCRIPT_DIR" rev-parse 'HEAD^{tree}')
  SOURCE_BRANCH=$(git -C "$SCRIPT_DIR" branch --show-current)
  if ! command -v sha256sum >/dev/null 2>&1; then
    echo "ERROR: sha256sum is required for Scheduler manifest provenance" >&2
    exit 7
  fi
  SCHEDULER_MANIFEST_SHA256=$(sha256sum "$SCRIPT_DIR/infra/gcp-scheduler-jobs.json" | awk '{print $1}')

  if [ -z "$SOURCE_BRANCH" ]; then
    echo "ERROR: detached HEAD is not an approved production source" >&2
    exit 7
  fi
  if [ "$CHECK_ONLY" != "1" ]; then
    require_nonempty "PRODUCTION_BRANCH" "Set the explicitly approved production branch"
    if [ "$SOURCE_BRANCH" != "$PRODUCTION_BRANCH" ]; then
      echo "ERROR: source branch $SOURCE_BRANCH does not match PRODUCTION_BRANCH=$PRODUCTION_BRANCH" >&2
      exit 7
    fi
    CANONICAL_REMOTE_REF="refs/remotes/origin/$CANONICAL_PRODUCTION_BRANCH"
    if ! git -C "$SCRIPT_DIR" show-ref --verify --quiet "$CANONICAL_REMOTE_REF"; then
      echo "ERROR: $CANONICAL_REMOTE_REF is missing; fetch origin before production deploy" >&2
      exit 7
    fi
    CANONICAL_REMOTE_SHA=$(git -C "$SCRIPT_DIR" rev-parse "$CANONICAL_REMOTE_REF")
    if [ "$PRODUCTION_BRANCH" = "$CANONICAL_PRODUCTION_BRANCH" ]; then
      if [ "$SOURCE_SHA" != "$CANONICAL_REMOTE_SHA" ]; then
        echo "ERROR: canonical production deploy requires HEAD=$CANONICAL_REMOTE_REF ($CANONICAL_REMOTE_SHA), got $SOURCE_SHA" >&2
        exit 7
      fi
    elif [ "$ALLOW_NON_MAIN_PRODUCTION_DEPLOY" != "1" ]; then
      echo "ERROR: non-canonical production branch $PRODUCTION_BRANCH is blocked; merge to $CANONICAL_PRODUCTION_BRANCH first" >&2
      exit 7
    elif ! git -C "$SCRIPT_DIR" merge-base --is-ancestor "$CANONICAL_REMOTE_REF" "$SOURCE_SHA"; then
      echo "ERROR: emergency production branch $PRODUCTION_BRANCH does not contain latest $CANONICAL_REMOTE_REF" >&2
      exit 7
    fi
    if [ -n "$(git -C "$SCRIPT_DIR" status --porcelain --untracked-files=all)" ]; then
      echo "ERROR: production source tree is dirty; deploy from a clean, reviewed worktree" >&2
      exit 7
    fi
  elif [ -n "$(git -C "$SCRIPT_DIR" status --porcelain --untracked-files=all)" ]; then
    echo "  Source tree           : DIRTY (deploy would be blocked)"
  fi

  case "$SERVICE_RUNTIME_SERVICE_ACCOUNT,$JOB_RUNTIME_SERVICE_ACCOUNT,$BUILD_SERVICE_ACCOUNT" in
    *-compute@developer.gserviceaccount.com*)
      echo "ERROR: default Compute Engine identity is forbidden for StockVision runtime" >&2
      exit 7
      ;;
  esac

  for account in "$SERVICE_RUNTIME_SERVICE_ACCOUNT" "$JOB_RUNTIME_SERVICE_ACCOUNT" "$BUILD_SERVICE_ACCOUNT"; do
    if ! gcloud iam service-accounts describe "$account" --project="$GCP_PROJECT_ID" --format="value(email)" >/dev/null 2>&1; then
      echo "ERROR: required dedicated service account does not exist: $account" >&2
      echo "Run scripts/cutover_gcp_runtime_identities.ps1 without -Apply to review the IAM plan." >&2
      exit 7
    fi
  done

  RUNTIME_ENV_VARS="${RUNTIME_ENV_VARS},STOCKVISION_SOURCE_SHA=${SOURCE_SHA},STOCKVISION_SOURCE_TREE_SHA=${SOURCE_TREE_SHA},STOCKVISION_SOURCE_BRANCH=${SOURCE_BRANCH},STOCKVISION_SCHEDULER_MANIFEST_SHA256=${SCHEDULER_MANIFEST_SHA256},STOCKVISION_PROVENANCE_SCHEMA=v1"
  PROVENANCE_LABELS="stockvision-source-sha=${SOURCE_SHA},stockvision-provenance-schema=v1"
}

detect_modal_python() {
  if [ -n "$MODAL_PYTHON_BIN" ] && [ -x "$MODAL_PYTHON_BIN" ]; then
    return
  fi
  if [ -x "$MLS_DIR/.venv/Scripts/python.exe" ]; then
    MODAL_PYTHON_BIN="$MLS_DIR/.venv/Scripts/python.exe"
  elif [ -x "$MLS_DIR/.venv/bin/python" ]; then
    MODAL_PYTHON_BIN="$MLS_DIR/.venv/bin/python"
  else
    echo "ERROR: --with-modal requires ml-service/.venv Python; global Modal CLI is not accepted" >&2
    exit 6
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
    "SCREENER_JOB_NAME",
    "OPTUNA_JOB_NAME",
    "STOCKVISION_WORKER_URL",
    "CF_API_TOKEN",
    "CF_ACCOUNT_ID",
    "CF_D1_DB_ID",
    "CF_KV_NAMESPACE_ID",
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
service_annotations = (doc.get("metadata", {}) or {}).get("annotations", {}) or {}
min_scale = service_annotations.get("run.googleapis.com/minScale", annotations.get("autoscaling.knative.dev/minScale", ""))
max_scale = service_annotations.get("run.googleapis.com/maxScale", annotations.get("autoscaling.knative.dev/maxScale", ""))
spec = template.get("spec", {}) or {}
containers = spec.get("containers", []) or []
container = containers[0] if containers else {}
limits = (container.get("resources", {}) or {}).get("limits", {}) or {}

print(f'CPU_THROTTLING={annotations.get("run.googleapis.com/cpu-throttling", "default")}')
print(f'CPU={limits.get("cpu", "")}')
print(f'MEMORY={limits.get("memory", "")}')
print(f'CONCURRENCY={spec.get("containerConcurrency", "")}')
print(f'MIN_SCALE={min_scale}')
print(f'MAX_SCALE={max_scale}')
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
  LIVE_SCREENER_JOB_IMG=$(gcloud run jobs describe "$SCREENER_JOB_NAME" \
    --region="$REGION" \
    --format="value(spec.template.spec.template.spec.containers[0].image)" 2>/dev/null || true)
  LIVE_SCREENER_JOB_ENTRYPOINT=$(gcloud run jobs describe "$SCREENER_JOB_NAME" \
    --region="$REGION" \
    --format="value(spec.template.spec.template.spec.containers[0].command[0],spec.template.spec.template.spec.containers[0].args)" 2>/dev/null || true)
  LIVE_OPTUNA_JOB_IMG=$(gcloud run jobs describe "$OPTUNA_JOB_NAME" \
    --region="$REGION" \
    --format="value(spec.template.spec.template.spec.containers[0].image)" 2>/dev/null || true)
  LIVE_OPTUNA_JOB_ENTRYPOINT=$(gcloud run jobs describe "$OPTUNA_JOB_NAME" \
    --region="$REGION" \
    --format="value(spec.template.spec.template.spec.containers[0].command[0],spec.template.spec.template.spec.containers[0].args)" 2>/dev/null || true)
  LIVE_OOF_MATERIALIZE_JOB_IMG=$(gcloud run jobs describe "$OOF_MATERIALIZE_JOB_NAME" \
    --region="$REGION" \
    --format="value(spec.template.spec.template.spec.containers[0].image)" 2>/dev/null || true)
  LIVE_OOF_MATERIALIZE_JOB_ENTRYPOINT=$(gcloud run jobs describe "$OOF_MATERIALIZE_JOB_NAME" \
    --region="$REGION" \
    --format="value(spec.template.spec.template.spec.containers[0].command[0],spec.template.spec.template.spec.containers[0].args)" 2>/dev/null || true)
  LIVE_DATASET_SNAPSHOT_JOB_IMG=$(gcloud run jobs describe "$DATASET_SNAPSHOT_JOB_NAME" \
    --region="$REGION" \
    --format="value(spec.template.spec.template.spec.containers[0].image)" 2>/dev/null || true)
  LIVE_DATASET_SNAPSHOT_JOB_ENTRYPOINT=$(gcloud run jobs describe "$DATASET_SNAPSHOT_JOB_NAME" \
    --region="$REGION" \
    --format="value(spec.template.spec.template.spec.containers[0].command[0],spec.template.spec.template.spec.containers[0].args)" 2>/dev/null || true)
}

build_verify_job_env_file() {
  local env_file="$1"
  local meta_file="$2"
  local pipeline_job_json
  local service_json
  pipeline_job_json=$(gcloud run jobs describe "$JOB" \
    --region="$REGION" \
    --format=json)
  service_json=$(gcloud run services describe "$SERVICE" \
    --region="$REGION" \
    --format=json)

  PIPELINE_JOB_JSON="$pipeline_job_json" \
  SERVICE_JSON="$service_json" \
  VERIFY_JOB_NAME="$VERIFY_JOB_NAME" \
  SCREENER_JOB_NAME="$SCREENER_JOB_NAME" \
  STRATEGY_MINING_JOB_NAME="$STRATEGY_MINING_JOB_NAME" \
  STRATEGY_MINING_EXECUTION_ENABLED="$STRATEGY_MINING_EXECUTION_ENABLED" \
  STRATEGY_MINING_BACKEND="$STRATEGY_MINING_BACKEND" \
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

service_doc = json.loads(os.environ["SERVICE_JSON"])
service_containers = (
    service_doc.get("spec", {})
    .get("template", {})
    .get("spec", {})
    .get("containers", [])
)
service_container = service_containers[0] if service_containers else {}
for item in service_container.get("env", []):
    name = item.get("name")
    if not name or "value" not in item:
        continue
    envs[name] = item.get("value", "")

envs["VERIFY_JOB_NAME"] = os.environ["VERIFY_JOB_NAME"]
envs["SCREENER_JOB_NAME"] = os.environ["SCREENER_JOB_NAME"]
envs["OPTUNA_JOB_NAME"] = os.environ.get("OPTUNA_JOB_NAME", "optuna-research-sweep")
envs["STRATEGY_MINING_JOB_NAME"] = os.environ["STRATEGY_MINING_JOB_NAME"]
envs["STRATEGY_MINING_EXECUTION_ENABLED"] = os.environ["STRATEGY_MINING_EXECUTION_ENABLED"]
envs["STRATEGY_MINING_BACKEND"] = os.environ["STRATEGY_MINING_BACKEND"]
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
  # Never inherit the live template identity: legacy templates may still use
  # the broad default Compute Engine service account.
  VERIFY_JOB_SERVICE_ACCOUNT="$JOB_RUNTIME_SERVICE_ACCOUNT"
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
        --update-labels="$PROVENANCE_LABELS" \
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
        --labels="$PROVENANCE_LABELS" \
        --set-secrets="$RUN_SECRET_BINDINGS" \
        --env-vars-file="$env_file"; then
      echo "??Verify job create failed" >&2
      exit 4
    fi
    echo "??Verify job create succeeded"
  fi
  echo ""
}

sync_screener_job() {
  local env_file="$1"
  local service_account_args=()
  local screener_cpu="${SCREENER_JOB_CPU:-${VERIFY_JOB_CPU:-4}}"
  local screener_memory="${SCREENER_JOB_MEMORY:-8Gi}"
  if [ -n "${VERIFY_JOB_SERVICE_ACCOUNT:-}" ]; then
    service_account_args=(--service-account="$VERIFY_JOB_SERVICE_ACCOUNT")
  fi

  if gcloud run jobs describe "$SCREENER_JOB_NAME" \
      --region="$REGION" \
      --format="value(metadata.name)" >/dev/null 2>&1; then
    echo "=== Step 3c/4: Update Job $SCREENER_JOB_NAME image + entrypoint ==="
    if ! gcloud run jobs update "$SCREENER_JOB_NAME" \
        --region="$REGION" \
        --image="$NEW_IMAGE" \
        --command=python \
        --args=-m \
        --args=screener_job_main \
        --cpu="$screener_cpu" \
        --memory="$screener_memory" \
        --task-timeout="$SCREENER_JOB_TIMEOUT" \
        --max-retries=0 \
        "${service_account_args[@]}" \
        --update-labels="$PROVENANCE_LABELS" \
        --update-secrets="$RUN_SECRET_BINDINGS" \
        --env-vars-file="$env_file"; then
      echo "??Screener job update failed" >&2
      exit 4
    fi
    echo "??Screener job update succeeded"
  else
    echo "=== Step 3c/4: Create Job $SCREENER_JOB_NAME ==="
    if ! gcloud run jobs create "$SCREENER_JOB_NAME" \
        --region="$REGION" \
        --image="$NEW_IMAGE" \
        --command=python \
        --args=-m \
        --args=screener_job_main \
        --cpu="$screener_cpu" \
        --memory="$screener_memory" \
        --task-timeout="$SCREENER_JOB_TIMEOUT" \
        --max-retries=0 \
        "${service_account_args[@]}" \
        --labels="$PROVENANCE_LABELS" \
        --set-secrets="$RUN_SECRET_BINDINGS" \
        --env-vars-file="$env_file"; then
      echo "??Screener job create failed" >&2
      exit 4
    fi
    echo "??Screener job create succeeded"
  fi
  echo ""
}

sync_s12_structure_job() {
  local env_file="$1"
  local service_account_args=()
  if [ -n "${VERIFY_JOB_SERVICE_ACCOUNT:-}" ]; then
    service_account_args=(--service-account="$VERIFY_JOB_SERVICE_ACCOUNT")
  fi
  if gcloud run jobs describe "$S12_STRUCTURE_JOB_NAME" \
      --region="$REGION" --format="value(metadata.name)" >/dev/null 2>&1; then
    echo "=== Update Job $S12_STRUCTURE_JOB_NAME image + entrypoint ==="
    gcloud run jobs update "$S12_STRUCTURE_JOB_NAME" \
      --region="$REGION" \
      --image="$NEW_IMAGE" \
      --command=python \
      --args=-m \
      --args=s12_structure_job_main \
      --cpu="${S12_STRUCTURE_JOB_CPU:-2}" \
      --memory="${S12_STRUCTURE_JOB_MEMORY:-2Gi}" \
      --task-timeout="$S12_STRUCTURE_JOB_TIMEOUT" \
      --max-retries=1 \
      "${service_account_args[@]}" \
      --update-labels="$PROVENANCE_LABELS" \
      --update-secrets="$S12_STRUCTURE_SECRET_BINDINGS" \
      --env-vars-file="$env_file"
  else
    echo "=== Create Job $S12_STRUCTURE_JOB_NAME ==="
    gcloud run jobs create "$S12_STRUCTURE_JOB_NAME" \
      --region="$REGION" \
      --image="$NEW_IMAGE" \
      --command=python \
      --args=-m \
      --args=s12_structure_job_main \
      --cpu="${S12_STRUCTURE_JOB_CPU:-2}" \
      --memory="${S12_STRUCTURE_JOB_MEMORY:-2Gi}" \
      --task-timeout="$S12_STRUCTURE_JOB_TIMEOUT" \
      --max-retries=1 \
      "${service_account_args[@]}" \
      --labels="$PROVENANCE_LABELS" \
      --set-secrets="$S12_STRUCTURE_SECRET_BINDINGS" \
      --env-vars-file="$env_file"
  fi
  local controller_member="serviceAccount:${SERVICE_RUNTIME_SERVICE_ACCOUNT}"
  for role in \
    "projects/${GCP_PROJECT_ID}/roles/stockvisionJobOverrideRunner" \
    "roles/run.invoker" \
    "roles/run.viewer"; do
    gcloud run jobs add-iam-policy-binding "$S12_STRUCTURE_JOB_NAME" \
      --region="$REGION" \
      --member="$controller_member" \
      --role="$role" \
      --quiet >/dev/null
  done
  echo "S12 structure job sync + controller IAM succeeded"
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
    echo "=== Step 3d/4: Update Job $OPTUNA_JOB_NAME image + entrypoint ==="
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
        --update-labels="$PROVENANCE_LABELS" \
        --update-secrets="$RUN_SECRET_BINDINGS" \
        --env-vars-file="$env_file"; then
      echo "??Optuna job update failed" >&2
      exit 4
    fi
    echo "??Optuna job update succeeded"
  else
    echo "=== Step 3d/4: Create Job $OPTUNA_JOB_NAME from $JOB template ==="
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
        --labels="$PROVENANCE_LABELS" \
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
  local mining_memory="${STRATEGY_MINING_JOB_MEMORY:-16Gi}"
  if [ -n "${VERIFY_JOB_SERVICE_ACCOUNT:-}" ]; then
    service_account_args=(--service-account="$VERIFY_JOB_SERVICE_ACCOUNT")
  fi

  if gcloud run jobs describe "$STRATEGY_MINING_JOB_NAME" \
      --region="$REGION" \
      --format="value(metadata.name)" >/dev/null 2>&1; then
    echo "=== Step 3e/4: Update Job $STRATEGY_MINING_JOB_NAME image + entrypoint ==="
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
        --update-labels="$PROVENANCE_LABELS" \
        --set-secrets="$STRATEGY_MINING_SECRET_BINDINGS" \
        --env-vars-file="$env_file"; then
      echo "??Strategy mining job update failed" >&2
      exit 4
    fi
    echo "??Strategy mining job update succeeded"
  else
    echo "=== Step 3e/4: Create Job $STRATEGY_MINING_JOB_NAME ==="
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
        --labels="$PROVENANCE_LABELS" \
        --set-secrets="$STRATEGY_MINING_SECRET_BINDINGS" \
        --env-vars-file="$env_file"; then
      echo "??Strategy mining job create failed" >&2
      exit 4
    fi
    echo "??Strategy mining job create succeeded"
  fi
  echo ""
}

sync_oof_materialize_job() {
  local env_file="$1"
  local service_account_args=()
  if [ -n "${VERIFY_JOB_SERVICE_ACCOUNT:-}" ]; then
    service_account_args=(--service-account="$VERIFY_JOB_SERVICE_ACCOUNT")
  fi

  if gcloud run jobs describe "$OOF_MATERIALIZE_JOB_NAME" \
      --region="$REGION" \
      --format="value(metadata.name)" >/dev/null 2>&1; then
    echo "=== Step 3f/4: Update Job $OOF_MATERIALIZE_JOB_NAME ==="
    if ! gcloud run jobs update "$OOF_MATERIALIZE_JOB_NAME" \
        --region="$REGION" \
        --image="$NEW_IMAGE" \
        --command=python \
        --args=-m \
        --args=oof_materialize_job_main \
        --cpu="${OOF_MATERIALIZE_JOB_CPU:-4}" \
        --memory="${OOF_MATERIALIZE_JOB_MEMORY:-8Gi}" \
        --task-timeout="$OOF_MATERIALIZE_JOB_TIMEOUT" \
        --max-retries=0 \
        "${service_account_args[@]}" \
        --update-labels="$PROVENANCE_LABELS" \
        --update-secrets="$RUN_SECRET_BINDINGS" \
        --env-vars-file="$env_file"; then
      echo "OOF materialize job update failed" >&2
      exit 4
    fi
  else
    echo "=== Step 3f/4: Create Job $OOF_MATERIALIZE_JOB_NAME ==="
    if ! gcloud run jobs create "$OOF_MATERIALIZE_JOB_NAME" \
        --region="$REGION" \
        --image="$NEW_IMAGE" \
        --command=python \
        --args=-m \
        --args=oof_materialize_job_main \
        --cpu="${OOF_MATERIALIZE_JOB_CPU:-4}" \
        --memory="${OOF_MATERIALIZE_JOB_MEMORY:-8Gi}" \
        --task-timeout="$OOF_MATERIALIZE_JOB_TIMEOUT" \
        --max-retries=0 \
        "${service_account_args[@]}" \
        --labels="$PROVENANCE_LABELS" \
        --set-secrets="$RUN_SECRET_BINDINGS" \
        --env-vars-file="$env_file"; then
      echo "OOF materialize job create failed" >&2
      exit 4
    fi
  fi
  echo "OOF materialize job sync succeeded"
  echo ""
}

sync_dataset_snapshot_job() {
  local env_file="$1"
  local service_account_args=()
  if [ -n "${VERIFY_JOB_SERVICE_ACCOUNT:-}" ]; then
    service_account_args=(--service-account="$VERIFY_JOB_SERVICE_ACCOUNT")
  fi

  if gcloud run jobs describe "$DATASET_SNAPSHOT_JOB_NAME" \
      --region="$REGION" \
      --format="value(metadata.name)" >/dev/null 2>&1; then
    echo "=== Step 3g/4: Update Job $DATASET_SNAPSHOT_JOB_NAME ==="
    if ! gcloud run jobs update "$DATASET_SNAPSHOT_JOB_NAME" \
        --region="$REGION" \
        --image="$NEW_IMAGE" \
        --command=python \
        --args=-m \
        --args=dataset_snapshot_job_main \
        --cpu="${DATASET_SNAPSHOT_JOB_CPU:-4}" \
        --memory="${DATASET_SNAPSHOT_JOB_MEMORY:-8Gi}" \
        --task-timeout="$DATASET_SNAPSHOT_JOB_TIMEOUT" \
        --max-retries=0 \
        "${service_account_args[@]}" \
        --update-labels="$PROVENANCE_LABELS" \
        --update-secrets="$RUN_SECRET_BINDINGS" \
        --env-vars-file="$env_file"; then
      echo "Dataset snapshot job update failed" >&2
      exit 4
    fi
  else
    echo "=== Step 3g/4: Create Job $DATASET_SNAPSHOT_JOB_NAME ==="
    if ! gcloud run jobs create "$DATASET_SNAPSHOT_JOB_NAME" \
        --region="$REGION" \
        --image="$NEW_IMAGE" \
        --command=python \
        --args=-m \
        --args=dataset_snapshot_job_main \
        --cpu="${DATASET_SNAPSHOT_JOB_CPU:-4}" \
        --memory="${DATASET_SNAPSHOT_JOB_MEMORY:-8Gi}" \
        --task-timeout="$DATASET_SNAPSHOT_JOB_TIMEOUT" \
        --max-retries=0 \
        "${service_account_args[@]}" \
        --labels="$PROVENANCE_LABELS" \
        --set-secrets="$RUN_SECRET_BINDINGS" \
        --env-vars-file="$env_file"; then
      echo "Dataset snapshot job create failed" >&2
      exit 4
    fi
  fi
  echo "Dataset snapshot job sync succeeded"
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
  require_nonempty "SCREENER_JOB_NAME" "Required by ml-controller /screener/v2/run Cloud Run Job trigger"
  require_nonempty "OPTUNA_JOB_NAME" "Required by ml-controller /optuna/research_sweep/run Cloud Run Job trigger"
  require_nonempty "OOF_MATERIALIZE_JOB_NAME" "Required by Active-8 OOF durable materialization"
  require_nonempty "DATASET_SNAPSHOT_JOB_NAME" "Required by deferred research snapshot export"
  require_nonempty "CF_API_TOKEN_SECRET" "Secret Manager reference for Cloudflare API token, e.g. stockvision-cf-api-token:latest"
  require_nonempty "STOCKVISION_AUTH_TOKEN_SECRET" "Secret Manager reference for Worker service token, e.g. stockvision-stockvision-auth-token:latest"
  require_nonempty "STRATEGY_MINING_CALLBACK_TOKEN_SECRET" "Secret Manager reference for the dedicated Pymoo callback token"
  require_nonempty "FINLAB_API_KEY_SECRET" "Secret Manager reference for FinLab SDK auth, e.g. finlab-api-key:latest"
  require_nonempty "FINLAB_REFRESH_TOKEN_SECRET" "Secret Manager reference for FinLab 2.x refresh token"
  require_nonempty "FINLAB_SESSION_ID_SECRET" "Secret Manager reference for FinLab 2.x session id"
  require_nonempty "ML_CONTROLLER_SECRET_SECRET" "Secret Manager reference for ml-controller auth token, e.g. stockvision-ml-controller-secret:latest"
  require_nonempty "RETRAIN_CALLBACK_TOKEN_SECRET" "Dedicated Secret Manager reference for Modal POST /retrain/followup"
  require_nonempty "MODAL_TOKEN_ID_SECRET" "Secret Manager reference for Modal token id, e.g. stockvision-modal-token-id:latest"
  require_nonempty "MODAL_TOKEN_SECRET_SECRET" "Secret Manager reference for Modal token secret, e.g. stockvision-modal-token-secret:latest"

  for var_name in "${REQUIRED_ENV_VARS[@]}"; do
    print_preflight_value "$var_name"
  done
  print_preflight_value "CF_API_TOKEN_SECRET"
  print_preflight_value "STOCKVISION_AUTH_TOKEN_SECRET"
  print_preflight_value "STRATEGY_MINING_CALLBACK_TOKEN_SECRET"
  print_preflight_value "FINLAB_API_KEY_SECRET"
  print_preflight_value "FINLAB_REFRESH_TOKEN_SECRET"
  print_preflight_value "FINLAB_SESSION_ID_SECRET"
  print_preflight_value "ML_CONTROLLER_SECRET_SECRET"
  print_preflight_value "RETRAIN_CALLBACK_TOKEN_SECRET"
  print_preflight_value "MODAL_TOKEN_ID_SECRET"
  print_preflight_value "MODAL_TOKEN_SECRET_SECRET"
  print_preflight_value "SCREENER_JOB_TIMEOUT"
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
  if [ -n "${LIVE_SCREENER_JOB_IMG:-}" ]; then
    echo "  Live screener image   : ${LIVE_SCREENER_JOB_IMG}"
    echo "  Live screener entrypt : ${LIVE_SCREENER_JOB_ENTRYPOINT:-unknown}"
  fi
  if [ -n "${LIVE_OPTUNA_JOB_IMG:-}" ]; then
    echo "  Live optuna image     : ${LIVE_OPTUNA_JOB_IMG}"
    echo "  Live optuna entrypoint: ${LIVE_OPTUNA_JOB_ENTRYPOINT:-unknown}"
  fi
  if [ -n "${LIVE_OOF_MATERIALIZE_JOB_IMG:-}" ]; then
    echo "  Live OOF materialize  : ${LIVE_OOF_MATERIALIZE_JOB_IMG}"
    echo "  Live OOF entrypoint   : ${LIVE_OOF_MATERIALIZE_JOB_ENTRYPOINT:-unknown}"
  fi
  if [ -n "${LIVE_DATASET_SNAPSHOT_JOB_IMG:-}" ]; then
    echo "  Live snapshot image   : ${LIVE_DATASET_SNAPSHOT_JOB_IMG}"
    echo "  Live snapshot entrypt : ${LIVE_DATASET_SNAPSHOT_JOB_ENTRYPOINT:-unknown}"
  fi

  if [ -z "${LIVE_SERVICE_IMG:-}" ] || [ -z "${LIVE_JOB_IMG:-}" ] || [ -z "${LIVE_VERIFY_JOB_IMG:-}" ] || [ -z "${LIVE_SCREENER_JOB_IMG:-}" ] || [ -z "${LIVE_OPTUNA_JOB_IMG:-}" ] || [ -z "${LIVE_OOF_MATERIALIZE_JOB_IMG:-}" ] || [ -z "${LIVE_DATASET_SNAPSHOT_JOB_IMG:-}" ]; then
    echo "  Unable to fully verify Service / Job image drift from current environment."
  elif [ "$LIVE_SERVICE_IMG" = "$LIVE_JOB_IMG" ] && [ "$LIVE_SERVICE_IMG" = "$LIVE_VERIFY_JOB_IMG" ] && [ "$LIVE_SERVICE_IMG" = "$LIVE_SCREENER_JOB_IMG" ] && [ "$LIVE_SERVICE_IMG" = "$LIVE_OPTUNA_JOB_IMG" ] && [ "$LIVE_SERVICE_IMG" = "$LIVE_OOF_MATERIALIZE_JOB_IMG" ] && [ "$LIVE_SERVICE_IMG" = "$LIVE_DATASET_SNAPSHOT_JOB_IMG" ]; then
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
load_release_provenance
if [ ! -d "$MLC_DIR" ] || [ ! -f "$MLC_DIR/main.py" ]; then
  echo "❌ ERROR: ml-controller source not found at $MLC_DIR" >&2
  exit 1
fi
if [ "$WITH_MODAL" = "1" ] && { [ ! -d "$MLS_DIR" ] || [ ! -f "$MLS_DIR/modal_app.py" ] || [ ! -f "$MLS_DIR/modal_strategy_mining_app.py" ]; }; then
  echo "❌ ERROR: ml-service source not found at $MLS_DIR (required only by --with-modal)" >&2
  exit 1
fi
if [ ! -f "$ROOT_DOCKERFILE" ]; then
  echo "❌ ERROR: root Dockerfile not found at $ROOT_DOCKERFILE" >&2
  exit 1
fi

run_preflight
GCLOUD_RUNTIME_ENV_VARS="$(gcloud_runtime_env_vars)"
if [ "$CHECK_ONLY" = "1" ]; then
  echo "✅ Preflight passed (--check-only). No deploy performed."
  exit 0
fi

# ── Step 1/4: Deploy Service (from repo root so Dockerfile sees ml-service/) ─
cd "$SCRIPT_DIR"
echo "=== Step 1/4: Deploy Service $SERVICE (CWD=$SCRIPT_DIR, Dockerfile=repo root) ==="
if ! gcloud run deploy "$SERVICE" \
    --source . \
    --build-service-account="projects/${GCP_PROJECT_ID}/serviceAccounts/${BUILD_SERVICE_ACCOUNT}" \
    --region="$REGION" \
    --timeout=3600 \
    --service-account="$SERVICE_RUNTIME_SERVICE_ACCOUNT" \
    --update-labels="$PROVENANCE_LABELS" \
    --update-env-vars="$GCLOUD_RUNTIME_ENV_VARS" \
    --update-secrets="$SERVICE_SECRET_BINDINGS" \
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
OOF_MATERIALIZE_JOB_ENV_FILE=$(mktemp -t oof_materialize_job_env.XXXXXX.yaml 2>/dev/null || echo "/tmp/oof_materialize_job_env.$$.yaml")
STRATEGY_MINING_JOB_ENV_FILE=$(mktemp -t strategy_mining_job_env.XXXXXX.yaml 2>/dev/null || echo "/tmp/strategy_mining_job_env.$$.yaml")
trap 'rm -f "$VERIFY_JOB_ENV_FILE" "$VERIFY_JOB_META_FILE" "$OOF_MATERIALIZE_JOB_ENV_FILE" "$STRATEGY_MINING_JOB_ENV_FILE"' EXIT
build_verify_job_env_file "$VERIFY_JOB_ENV_FILE" "$VERIFY_JOB_META_FILE"
cp "$VERIFY_JOB_ENV_FILE" "$OOF_MATERIALIZE_JOB_ENV_FILE"
cp "$VERIFY_JOB_ENV_FILE" "$STRATEGY_MINING_JOB_ENV_FILE"
printf 'STRATEGY_MINING_D1_WORKER_ONLY: "1"\n' >> "$STRATEGY_MINING_JOB_ENV_FILE"
printf 'OOF_MATERIALIZE_JOB_EXECUTION: "1"\n' >> "$OOF_MATERIALIZE_JOB_ENV_FILE"
load_verify_job_template "$VERIFY_JOB_META_FILE"

# ── Step 3/4: Update Job image ───────────────────────────────────────────────
echo "=== Step 3/4: Update Job $JOB image to match Service ==="
if ! gcloud run jobs update "$JOB" \
    --region="$REGION" \
    --image="$NEW_IMAGE" \
    --service-account="$JOB_RUNTIME_SERVICE_ACCOUNT" \
    --update-labels="$PROVENANCE_LABELS" \
    --update-secrets="$RUN_SECRET_BINDINGS" \
    --update-env-vars="$GCLOUD_RUNTIME_ENV_VARS"; then
  echo "❌ Job update failed" >&2
  exit 4
fi
echo "✅ Job update succeeded"
echo ""

# ── Step 4/4: Verify ─────────────────────────────────────────────────────────
sync_verify_job "$VERIFY_JOB_ENV_FILE"
sync_screener_job "$VERIFY_JOB_ENV_FILE"
sync_s12_structure_job "$VERIFY_JOB_ENV_FILE"
sync_optuna_job "$VERIFY_JOB_ENV_FILE"
sync_strategy_mining_job "$STRATEGY_MINING_JOB_ENV_FILE"
sync_oof_materialize_job "$OOF_MATERIALIZE_JOB_ENV_FILE"
sync_dataset_snapshot_job "$VERIFY_JOB_ENV_FILE"

echo "=== Step 4/4: Verify Service and Job image match ==="
SERVICE_IMG=$(gcloud run services describe "$SERVICE" --region="$REGION" \
  --format="value(spec.template.spec.containers[0].image)")
JOB_IMG=$(gcloud run jobs describe "$JOB" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].image)")
VERIFY_JOB_IMG=$(gcloud run jobs describe "$VERIFY_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].image)")
SCREENER_JOB_IMG=$(gcloud run jobs describe "$SCREENER_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].image)")
S12_STRUCTURE_JOB_IMG=$(gcloud run jobs describe "$S12_STRUCTURE_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].image)")
OPTUNA_JOB_IMG=$(gcloud run jobs describe "$OPTUNA_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].image)")
STRATEGY_MINING_JOB_IMG=$(gcloud run jobs describe "$STRATEGY_MINING_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].image)")
OOF_MATERIALIZE_JOB_IMG=$(gcloud run jobs describe "$OOF_MATERIALIZE_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].image)")
DATASET_SNAPSHOT_JOB_IMG=$(gcloud run jobs describe "$DATASET_SNAPSHOT_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].image)")
VERIFY_JOB_COMMAND=$(gcloud run jobs describe "$VERIFY_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].command[0])")
VERIFY_JOB_ARGS=$(gcloud run jobs describe "$VERIFY_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].args)")
SCREENER_JOB_COMMAND=$(gcloud run jobs describe "$SCREENER_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].command[0])")
SCREENER_JOB_ARGS=$(gcloud run jobs describe "$SCREENER_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].args)")
S12_STRUCTURE_JOB_COMMAND=$(gcloud run jobs describe "$S12_STRUCTURE_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].command[0])")
S12_STRUCTURE_JOB_ARGS=$(gcloud run jobs describe "$S12_STRUCTURE_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].args)")
OPTUNA_JOB_COMMAND=$(gcloud run jobs describe "$OPTUNA_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].command[0])")
OPTUNA_JOB_ARGS=$(gcloud run jobs describe "$OPTUNA_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].args)")
STRATEGY_MINING_JOB_COMMAND=$(gcloud run jobs describe "$STRATEGY_MINING_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].command[0])")
STRATEGY_MINING_JOB_ARGS=$(gcloud run jobs describe "$STRATEGY_MINING_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].args)")
OOF_MATERIALIZE_JOB_COMMAND=$(gcloud run jobs describe "$OOF_MATERIALIZE_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].command[0])")
OOF_MATERIALIZE_JOB_ARGS=$(gcloud run jobs describe "$OOF_MATERIALIZE_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].args)")
DATASET_SNAPSHOT_JOB_COMMAND=$(gcloud run jobs describe "$DATASET_SNAPSHOT_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].command[0])")
DATASET_SNAPSHOT_JOB_ARGS=$(gcloud run jobs describe "$DATASET_SNAPSHOT_JOB_NAME" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].args)")

if [ "$SERVICE_IMG" != "$JOB_IMG" ] || [ "$SERVICE_IMG" != "$VERIFY_JOB_IMG" ] || [ "$SERVICE_IMG" != "$SCREENER_JOB_IMG" ] || [ "$SERVICE_IMG" != "$S12_STRUCTURE_JOB_IMG" ] || [ "$SERVICE_IMG" != "$OPTUNA_JOB_IMG" ] || [ "$SERVICE_IMG" != "$STRATEGY_MINING_JOB_IMG" ] || [ "$SERVICE_IMG" != "$OOF_MATERIALIZE_JOB_IMG" ]; then
  echo "❌ VERIFICATION FAILED — images differ:" >&2
  echo "  Service: $SERVICE_IMG" >&2
  echo "  Job    : $JOB_IMG" >&2
  echo "  Verify : $VERIFY_JOB_IMG" >&2
  echo "  Screener: $SCREENER_JOB_IMG" >&2
  echo "  S12 structure: $S12_STRUCTURE_JOB_IMG" >&2
  echo "  Optuna : $OPTUNA_JOB_IMG" >&2
  echo "  Mining : $STRATEGY_MINING_JOB_IMG" >&2
  echo "  OOF    : $OOF_MATERIALIZE_JOB_IMG" >&2
  exit 5
fi

if [ "$SERVICE_IMG" != "$DATASET_SNAPSHOT_JOB_IMG" ]; then
  echo "VERIFICATION FAILED - dataset snapshot image differs:" >&2
  echo "  Service : $SERVICE_IMG" >&2
  echo "  Snapshot: $DATASET_SNAPSHOT_JOB_IMG" >&2
  exit 5
fi

if [ "$VERIFY_JOB_COMMAND" != "python" ] || [ "$VERIFY_JOB_ARGS" != "-m;verify_job_main" ]; then
  echo "??VERIFICATION FAILED ??verify job entrypoint drift:" >&2
  echo "  command : $VERIFY_JOB_COMMAND" >&2
  echo "  args    : $VERIFY_JOB_ARGS" >&2
  exit 5
fi

if [ "$SCREENER_JOB_COMMAND" != "python" ] || [ "$SCREENER_JOB_ARGS" != "-m;screener_job_main" ]; then
  echo "??VERIFICATION FAILED ??screener job entrypoint drift:" >&2
  echo "  command : $SCREENER_JOB_COMMAND" >&2
  echo "  args    : $SCREENER_JOB_ARGS" >&2
  exit 5
fi

if [ "$S12_STRUCTURE_JOB_COMMAND" != "python" ] || [ "$S12_STRUCTURE_JOB_ARGS" != "-m;s12_structure_job_main" ]; then
  echo "VERIFICATION FAILED: S12 structure job entrypoint drift" >&2
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

if [ "$OOF_MATERIALIZE_JOB_COMMAND" != "python" ] || [ "$OOF_MATERIALIZE_JOB_ARGS" != "-m;oof_materialize_job_main" ]; then
  echo "VERIFICATION FAILED - OOF materialize job entrypoint drift:" >&2
  echo "  command : $OOF_MATERIALIZE_JOB_COMMAND" >&2
  echo "  args    : $OOF_MATERIALIZE_JOB_ARGS" >&2
  exit 5
fi

if [ "$DATASET_SNAPSHOT_JOB_COMMAND" != "python" ] || [ "$DATASET_SNAPSHOT_JOB_ARGS" != "-m;dataset_snapshot_job_main" ]; then
  echo "VERIFICATION FAILED - dataset snapshot job entrypoint drift:" >&2
  echo "  command : $DATASET_SNAPSHOT_JOB_COMMAND" >&2
  echo "  args    : $DATASET_SNAPSHOT_JOB_ARGS" >&2
  exit 5
fi

SERVICE_REV=$(gcloud run services describe "$SERVICE" --region="$REGION" \
  --format="value(status.latestReadyRevisionName)")

echo "✅ Verification passed — Service and Job on identical image"
echo ""

# Optional Modal release from the approved local release identity. Serving does
# not expose a deployment endpoint and never accepts a user-selected app path.
MODAL_RESULT=""
if [ "$WITH_MODAL" = "1" ]; then
  echo "=== Step 5/5: Deploy Modal from local release identity ==="
  detect_modal_python
  if ! STOCKVISION_SOURCE_SHA="$SOURCE_SHA" \
    STOCKVISION_SOURCE_TREE_SHA="$SOURCE_TREE_SHA" \
    STOCKVISION_SOURCE_BRANCH="$SOURCE_BRANCH" \
    STOCKVISION_SCHEDULER_MANIFEST_SHA256="$SCHEDULER_MANIFEST_SHA256" \
    PYTHONIOENCODING="${PYTHONIOENCODING:-utf-8}" \
    "$MODAL_PYTHON_BIN" -m modal deploy --tag "$SOURCE_SHA" "$MLS_DIR/modal_app.py"; then
    echo "ERROR: direct Modal deploy failed" >&2
    exit 6
  fi
  MODAL_RESULT="Modal         : deployed tag=${SOURCE_SHA}"
  if ! STOCKVISION_SOURCE_SHA="$SOURCE_SHA" \
    STOCKVISION_SOURCE_TREE_SHA="$SOURCE_TREE_SHA" \
    STOCKVISION_SOURCE_BRANCH="$SOURCE_BRANCH" \
    STOCKVISION_SCHEDULER_MANIFEST_SHA256="$SCHEDULER_MANIFEST_SHA256" \
    PYTHONIOENCODING="${PYTHONIOENCODING:-utf-8}" \
    "$MODAL_PYTHON_BIN" -m modal deploy --tag "$SOURCE_SHA" "$MLS_DIR/modal_strategy_mining_app.py"; then
    echo "ERROR: dedicated strategy-mining Modal deploy failed" >&2
    exit 6
  fi
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
