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
# What this script does:
#   1. Deploy ml-controller Service from ml-controller/ source
#   2. Read back the new container image URI from Service spec
#   3. Update pipeline-v2 Job image to match
#   4. Verify Service + Job image match (fail loudly if not)
#
# Usage:
#   From anywhere in the repo (or outside):
#     bash /path/to/stockvision-cloudflare-v12/deploy_ml_controller.sh
#
# Exit codes:
#   0 — Service + Job both live on new image
#   1 — sanity check failed (wrong dir / missing gcloud)
#   2 — Service deploy failed
#   3 — image SHA extraction failed
#   4 — Job update failed
#   5 — verification mismatch
#
# Dependencies: gcloud CLI authenticated with project gen-lang-client-0602998820.

set -euo pipefail

REGION="asia-east1"
SERVICE="ml-controller"
JOB="pipeline-v2"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MLC_DIR="$SCRIPT_DIR/ml-controller"

# ── Sanity checks ────────────────────────────────────────────────────────────
if ! command -v gcloud >/dev/null 2>&1; then
  echo "❌ ERROR: gcloud CLI not found in PATH" >&2
  exit 1
fi
if [ ! -d "$MLC_DIR" ] || [ ! -f "$MLC_DIR/main.py" ]; then
  echo "❌ ERROR: ml-controller source not found at $MLC_DIR" >&2
  exit 1
fi

# ── Step 1/4: Deploy Service ─────────────────────────────────────────────────
cd "$MLC_DIR"
echo "=== Step 1/4: Deploy Service $SERVICE (CWD=$MLC_DIR) ==="
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
echo "=== Deploy Summary ==="
echo "  Service revision : $SERVICE_REV"
echo "  Image            : $SERVICE_IMG"
echo "  Job synced       : yes"
echo ""
echo "Next step: trigger pipeline-v2 to verify new code path executes. Example:"
echo "  curl -sX POST 'https://ml-controller-530028717113.asia-east1.run.app/pipeline/v2/run?date=\$(date +%F)' \\"
echo "       -H 'X-Controller-Token: \$CTOKEN' -H 'Content-Length: 0' -d ''"
