#!/usr/bin/env bash
# NEW-1030-22: read-only dry run for post-verify receipts stuck in running (default dates 10/16 and 10/28).
# Runs two SELECTs against the remote ops D1 and writes the guarded CAS UPDATEs to a file. It executes no write;
# applying the SQL (wrangler d1 execute --remote --file) needs Wei go.
#   cd worker && scripts/post-verify-receipt-dryrun.sh <out-dir> [date ...]
set -euo pipefail

# The output directory is required and comes first, so a date is never taken for it.
out="${1:?usage: post-verify-receipt-dryrun.sh <out-dir> [date ...]}"; shift
[[ ! "$out" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "first argument is the output directory, got a date: $out" >&2; exit 1; }
dates=("$@"); [ "${#dates[@]}" -gt 0 ] || dates=(2026-10-16 2026-10-28)
for d in "${dates[@]}"; do [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "bad date: $d" >&2; exit 1; }; done
in_list="$(printf "'%s'," "${dates[@]}")"; in_list="${in_list%,}"
mkdir -p "$out"

# Running receipts of those dates, plus uncertain ones (they block the date too; reported, never closed). Read only.
npx wrangler d1 execute stockvision-ops-db --remote --json --command \
  "SELECT receipt_key,state,business_date,receipt_json,updated_at FROM post_verify_task_receipts_v1
    WHERE business_date IN ($in_list) AND state IN ('post_verify_task_v1:running','post_verify_task_v1:uncertain')
    ORDER BY business_date,receipt_key" \
  > "$out/receipts.json"
# Their post_verify_chain stage rows and whether the lease is live (read only).
npx wrangler d1 execute stockvision-ops-db --remote --json --command \
  "SELECT business_date,canonical_run_id,status,lease_owner,lease_expires_at,attempt_count,
          CASE WHEN lease_expires_at>=CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS lease_live
     FROM pipeline_stage_runs WHERE stage='post_verify_chain' AND business_date IN ($in_list)" \
  > "$out/stages.json"

# Build the CAS statements (report on stderr); nothing is executed.
npx tsx scripts/postVerifyReceiptReconcile.ts "$out/receipts.json" "$out/stages.json" > "$out/reconcile.sql"
echo "dry run written: $out/receipts.json $out/stages.json $out/reconcile.sql (not applied)" >&2
