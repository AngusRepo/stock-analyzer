param(
  [string]$Region = $(if ($env:GCP_REGION) { $env:GCP_REGION } else { 'asia-east1' }),
  [string]$JobName = 'finlab-v4-backfill',
  [int]$Years = 3,
  [int]$CanonicalWindowDays = 7,
  [string]$GcsBucket = 'stockvision-models',
  [string]$OutputDir = '/tmp/finlab_remote_backfill',
  [string]$D1Database = 'stockvision-db',
  [switch]$VerifyD1,
  [switch]$ApplyJobUpdate,
  [switch]$ExecuteBackfill,
  [string]$ConfirmProductionMutation = ''
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $Root 'ml-service\.venv\Scripts\python.exe'
$GuardScript = Join-Path $Root 'tools\finlab_backfill_job_guard.py'
$VerifierScript = Join-Path $Root 'tools\finlab_canonical_d1_verify.py'
$RequiredConfirm = 'I approve finlab canonical D1 production repair'

function Resolve-GCloudCommand {
  $Cmd = Get-Command gcloud.cmd -ErrorAction SilentlyContinue
  if (-not $Cmd) {
    $Cmd = Get-Command gcloud -ErrorAction Stop
  }
  return $Cmd.Source
}

function Resolve-NpxCommand {
  $Cmd = Get-Command npx.cmd -ErrorAction SilentlyContinue
  if (-not $Cmd) {
    $Cmd = Get-Command npx -ErrorAction Stop
  }
  return $Cmd.Source
}

function Invoke-FinLabCanonicalD1Verifier {
  Write-Host "[VERIFY] FinLab canonical D1 strict readback"
  $Npx = Resolve-NpxCommand
  $FreshnessSql = "WITH canonical_latest AS (SELECT MAX(date) AS date FROM canonical_chip_daily), legacy_chip_latest AS (SELECT MAX(date) AS date FROM chip_data), margin_latest AS (SELECT MAX(date) AS date FROM margin_data) SELECT (SELECT date FROM canonical_latest) AS canonical_chip_date, (SELECT COUNT(*) FROM canonical_chip_daily WHERE date = (SELECT date FROM canonical_latest)) AS canonical_chip_rows, (SELECT date FROM legacy_chip_latest) AS legacy_chip_date, (SELECT COUNT(*) FROM chip_data WHERE date = (SELECT date FROM legacy_chip_latest)) AS legacy_chip_rows, (SELECT date FROM margin_latest) AS margin_date, (SELECT COUNT(*) FROM margin_data WHERE date = (SELECT date FROM margin_latest)) AS margin_rows, (SELECT MAX(generated_at) FROM finlab_materialization_manifest WHERE json_extract(row_counts_json, '$.canonical_chip_daily') IS NOT NULL) AS manifest_generated_at"
  Push-Location (Join-Path $Root 'worker')
  try {
    $VerifierOutput = & $Npx wrangler@4 d1 execute $D1Database --remote --json --command $FreshnessSql | & $Python $VerifierScript --stdin
    $VerifierExit = $LASTEXITCODE
    foreach ($Line in $VerifierOutput) {
      Write-Host $Line
    }
    return $VerifierExit
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $Python -PathType Leaf)) {
  throw "Python runtime not found: $Python"
}
if (-not (Test-Path $GuardScript -PathType Leaf)) {
  throw "Guard script not found: $GuardScript"
}
if (($VerifyD1 -or $ExecuteBackfill) -and -not (Test-Path $VerifierScript -PathType Leaf)) {
  throw "Verifier script not found: $VerifierScript"
}
$GCloud = Resolve-GCloudCommand

$DesiredArgs = @(
  '/app/tools/finlab_v4_remote_backfill.py',
  '--years', "$Years",
  '--run-id', 'auto',
  '--write-d1',
  '--gcs-bucket', $GcsBucket,
  '--output-dir', $OutputDir,
  '--apply-canonical-d1',
  '--canonical-window-days', "$CanonicalWindowDays"
)
$DesiredArgsCsv = $DesiredArgs -join ','

Write-Host "== FinLab canonical D1 repair plan =="
Write-Host "Job     : $JobName"
Write-Host "Region  : $Region"
$Mode = 'plan-only'
if ($ApplyJobUpdate -or $ExecuteBackfill) {
  $Mode = 'mutation requested'
}
Write-Host "Mode    : $Mode"
Write-Host ""

Write-Host "[1] Current live job guard"
$JobJson = & $GCloud run jobs describe $JobName --region=$Region --format=json
if ($LASTEXITCODE -ne 0) {
  throw "gcloud run jobs describe failed for $JobName in $Region"
}
$JobJson | & $Python $GuardScript -
$GuardExit = $LASTEXITCODE
if ($GuardExit -eq 0) {
  Write-Host "[OK] Current job already includes canonical D1 apply args"
} else {
  Write-Host "[WARN] Current job is not closed; update command below is required"
}
Write-Host ""

Write-Host "[2] Required job args"
Write-Host $DesiredArgsCsv
Write-Host ""

Write-Host "[3] Update command"
Write-Host "gcloud run jobs update $JobName --region=$Region --args=""$DesiredArgsCsv"""
Write-Host ""

Write-Host "[4] Execute command"
Write-Host "gcloud run jobs execute $JobName --region=$Region --wait"
Write-Host ""

Write-Host "[5] Readback SQL"
Write-Host "npx wrangler@4 d1 execute $D1Database --remote --command ""SELECT MAX(date) AS canonical_chip_max_date, COUNT(*) AS rows FROM canonical_chip_daily;"""
Write-Host "npx wrangler@4 d1 execute $D1Database --remote --command ""SELECT run_id, generated_at, json_extract(row_counts_json, '$.canonical_chip_daily') AS canonical_chip_rows FROM finlab_materialization_manifest ORDER BY generated_at DESC LIMIT 5;"""
Write-Host "npx wrangler@4 d1 execute $D1Database --remote --command ""WITH c AS (SELECT MAX(date) AS d FROM canonical_chip_daily), ch AS (SELECT MAX(date) AS d FROM chip_data), m AS (SELECT MAX(date) AS d FROM margin_data) SELECT (SELECT d FROM c) AS canonical_chip_date, (SELECT d FROM ch) AS chip_data_date, (SELECT d FROM m) AS margin_data_date;"""
Write-Host ""

Write-Host "[6] Strict verifier"
Write-Host "powershell -File scripts\finlab_canonical_d1_repair_plan.ps1 -VerifyD1"
Write-Host "Backfill execution always runs this verifier after the job finishes."
Write-Host ""

$VerifyExit = 0
if ($VerifyD1 -and -not $ApplyJobUpdate -and -not $ExecuteBackfill) {
  $VerifyExit = Invoke-FinLabCanonicalD1Verifier
  if ($VerifyExit -eq 0) {
    Write-Host "[OK] FinLab canonical D1 is aligned with daily source tables"
  } else {
    Write-Host "[WARN] FinLab canonical D1 verifier did not pass"
  }
  Write-Host ""
}

if (-not $ApplyJobUpdate -and -not $ExecuteBackfill) {
  Write-Host "[PLAN ONLY] No production mutation performed."
  if ($GuardExit -ne 0) { exit $GuardExit }
  exit $VerifyExit
}

if ($ConfirmProductionMutation -ne $RequiredConfirm) {
  throw "Production mutation requires -ConfirmProductionMutation '$RequiredConfirm'"
}

if ($ApplyJobUpdate) {
  Write-Host "[MUTATION] Updating Cloud Run Job args"
  & $GCloud run jobs update $JobName --region=$Region --args="$DesiredArgsCsv"
  if ($LASTEXITCODE -ne 0) { throw "gcloud run jobs update failed" }

  Write-Host "[VERIFY] Re-checking Cloud Run Job args"
  $UpdatedJobJson = & $GCloud run jobs describe $JobName --region=$Region --format=json
  if ($LASTEXITCODE -ne 0) { throw "gcloud run jobs describe failed after update" }
  $UpdatedJobJson | & $Python $GuardScript -
  if ($LASTEXITCODE -ne 0) {
    throw "FinLab backfill job guard still failed after update"
  }
}

if ($ExecuteBackfill) {
  Write-Host "[MUTATION] Executing Cloud Run Job"
  & $GCloud run jobs execute $JobName --region=$Region --wait
  if ($LASTEXITCODE -ne 0) { throw "gcloud run jobs execute failed" }
}

if ($VerifyD1 -or $ExecuteBackfill) {
  $VerifyExit = Invoke-FinLabCanonicalD1Verifier
  if ($VerifyExit -ne 0) {
    throw "FinLab canonical D1 verifier did not pass after repair"
  }
  Write-Host "[OK] FinLab canonical D1 is aligned with daily source tables"
}
