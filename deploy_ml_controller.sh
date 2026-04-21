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
#   bash /path/to/stockvision-cloudflare-v12/deploy_ml_controller.sh [--with-modal]
#
# Flags:
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
#
# Dependencies: gcloud CLI authenticated with project gen-lang-client-0602998820.
#               curl (for --with-modal).

set -euo pipefail

REGION="asia-east1"
SERVICE="ml-controller"
JOB="pipeline-v2"
ML_CONTROLLER_URL_DEFAULT="https://ml-controller-530028717113.asia-east1.run.app"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MLC_DIR="$SCRIPT_DIR/ml-controller"
MLS_DIR="$SCRIPT_DIR/ml-service"
ROOT_DOCKERFILE="$SCRIPT_DIR/Dockerfile"

# ── Parse flags ──────────────────────────────────────────────────────────────
WITH_MODAL=0
for arg in "$@"; do
  case "$arg" in
    --with-modal) WITH_MODAL=1 ;;
    *) echo "Unknown flag: $arg (supported: --with-modal)" >&2; exit 1 ;;
  esac
done

# ── Sanity checks ────────────────────────────────────────────────────────────
if ! command -v gcloud >/dev/null 2>&1; then
  echo "❌ ERROR: gcloud CLI not found in PATH" >&2
  exit 1
fi
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

# ── Step 1/4: Deploy Service (from repo root so Dockerfile sees ml-service/) ─
cd "$SCRIPT_DIR"
echo "=== Step 1/4: Deploy Service $SERVICE (CWD=$SCRIPT_DIR, Dockerfile=repo root) ==="
if ! gcloud run deploy "$SERVICE" \
    --source . \
    --region="$REGION" \
    --timeout=3600 \
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

# ── Step 3/4: Update Job image ───────────────────────────────────────────────
echo "=== Step 3/4: Update Job $JOB image to match Service ==="
if ! gcloud run jobs update "$JOB" \
    --region="$REGION" \
    --image="$NEW_IMAGE"; then
  echo "❌ Job update failed" >&2
  exit 4
fi
echo "✅ Job update succeeded"
echo ""

# ── Step 4/4: Verify ─────────────────────────────────────────────────────────
echo "=== Step 4/4: Verify Service and Job image match ==="
SERVICE_IMG=$(gcloud run services describe "$SERVICE" --region="$REGION" \
  --format="value(spec.template.spec.containers[0].image)")
JOB_IMG=$(gcloud run jobs describe "$JOB" --region="$REGION" \
  --format="value(spec.template.spec.template.spec.containers[0].image)")

if [ "$SERVICE_IMG" != "$JOB_IMG" ]; then
  echo "❌ VERIFICATION FAILED — images differ:" >&2
  echo "  Service: $SERVICE_IMG" >&2
  echo "  Job    : $JOB_IMG" >&2
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
  CTOKEN="${ML_CONTROLLER_TOKEN:-sv-controller-2026-prod}"
  URL="${ML_CONTROLLER_URL:-$ML_CONTROLLER_URL_DEFAULT}/admin/modal-deploy"
  NOTE_JSON=$(printf '{"note":"deploy_ml_controller.sh rev=%s"}' "$SERVICE_REV")
  # Modal deploy can take 3-5 min; local curl timeout 600s
  echo "POST $URL"
  set +e
  HTTP_STATUS=$(curl -sS -o /tmp/modal_deploy_resp.json -w "%{http_code}" \
      -X POST "$URL" \
      -H "X-Controller-Token: $CTOKEN" \
      -H "Content-Type: application/json" \
      --max-time 650 \
      -d "$NOTE_JSON")
  CURL_RC=$?
  set -e
  if [ "$CURL_RC" -ne 0 ] || [ "$HTTP_STATUS" != "200" ]; then
    echo "❌ Modal deploy endpoint failed (curl_rc=$CURL_RC http=$HTTP_STATUS)" >&2
    echo "Response body:" >&2
    cat /tmp/modal_deploy_resp.json >&2 || true
    echo "" >&2
    exit 6
  fi
  MODAL_DURATION=$(python -c "import json,sys; print(json.load(open('/tmp/modal_deploy_resp.json')).get('duration_sec','?'))" 2>/dev/null || echo "?")
  echo "✅ Modal deploy succeeded (duration ${MODAL_DURATION}s)"
  MODAL_RESULT="Modal         : redeployed (${MODAL_DURATION}s)"
  echo ""
fi

echo "=== Deploy Summary ==="
echo "  Service revision : $SERVICE_REV"
echo "  Image            : $SERVICE_IMG"
echo "  Job synced       : yes"
[ -n "$MODAL_RESULT" ] && echo "  $MODAL_RESULT"
echo ""
echo "Next step: trigger pipeline-v2 to verify new code path executes. Example:"
echo "  curl -sX POST '$ML_CONTROLLER_URL_DEFAULT/pipeline/v2/run?date=\$(date +%F)' \\"
echo "       -H 'X-Controller-Token: \$CTOKEN' -H 'Content-Length: 0' -d ''"
