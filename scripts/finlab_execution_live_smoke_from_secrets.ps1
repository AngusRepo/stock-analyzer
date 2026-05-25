param(
  [string]$ProjectId = $env:GCP_PROJECT_ID,
  [string]$PythonPath = ".\ml-service\.venv\Scripts\python.exe",
  [string]$SecretPrefix = "stockvision-finlab-exec",
  [string]$FinLabApiSecret = "finlab-api-key",
  [switch]$SkipPreviewNoop
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

function Resolve-GCloudCommand {
  $cmd = Get-Command gcloud.cmd -ErrorAction SilentlyContinue
  if (-not $cmd) {
    $cmd = Get-Command gcloud -ErrorAction SilentlyContinue
  }
  if (-not $cmd) {
    throw "gcloud command not found"
  }
  return $cmd.Source
}

function Get-SecretValue([string]$GCloud, [string]$SecretId) {
  $value = & $GCloud secrets versions access latest "--project=$ProjectId" "--secret=$SecretId"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to access secret $SecretId"
  }
  return ($value | Out-String).TrimEnd("`r", "`n")
}

if (-not $ProjectId) {
  throw "ProjectId is required. Pass -ProjectId or set GCP_PROJECT_ID."
}

$gcloud = Resolve-GCloudCommand
$certDir = Join-Path $Root ".tmp\finlab-exec-live-smoke"
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
$certPath = Join-Path $certDir "shioaji-finlab-cert.pfx"

try {
  & $gcloud secrets versions access latest "--project=$ProjectId" "--secret=$SecretPrefix-shioaji-cert-pfx" "--out-file=$certPath" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to access certificate secret"
  }

  $env:SHIOAJI_API_KEY = Get-SecretValue $gcloud "$SecretPrefix-shioaji-api-key"
  $env:SHIOAJI_SECRET_KEY = Get-SecretValue $gcloud "$SecretPrefix-shioaji-secret-key"
  $env:SHIOAJI_CERT_PERSON_ID = Get-SecretValue $gcloud "$SecretPrefix-shioaji-cert-person-id"
  $env:SHIOAJI_CERT_PASSWORD = Get-SecretValue $gcloud "$SecretPrefix-shioaji-cert-password"
  $env:SHIOAJI_ACCOUNT_ID = Get-SecretValue $gcloud "$SecretPrefix-shioaji-account-id"
  $env:SHIOAJI_CERT_PATH = $certPath
  $env:FINLAB_API_KEY = Get-SecretValue $gcloud $FinLabApiSecret
  $env:FINLAB_EXECUTION_LANE_ENABLED = "shadow"

  $args = @((Join-Path $Root "tools\finlab_execution_smoke.py"), "--allow-broker-login")
  if ($SkipPreviewNoop) {
    $args += "--skip-preview-noop"
  }
  & $PythonPath @args
  exit $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $certPath -Force -ErrorAction SilentlyContinue
  foreach ($name in @(
    "SHIOAJI_API_KEY",
    "SHIOAJI_SECRET_KEY",
    "SHIOAJI_CERT_PERSON_ID",
    "SHIOAJI_CERT_PASSWORD",
    "SHIOAJI_ACCOUNT_ID",
    "SHIOAJI_CERT_PATH",
    "FINLAB_API_KEY",
    "FINLAB_EXECUTION_LANE_ENABLED"
  )) {
    Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
  }
}
