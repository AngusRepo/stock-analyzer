[CmdletBinding()]
param(
  [ValidateSet('Preflight', 'Rotate', 'Finalize')]
  [string]$Mode = 'Preflight',
  [switch]$Apply,
  [switch]$DryRun,
  [switch]$DrainVerified,
  [string]$Project = $env:GOOGLE_CLOUD_PROJECT,
  [string]$Location = 'asia-east1',
  [string]$WorkerName = 'stockvision-worker',
  [string]$WorkerBaseUrl = $env:STOCKVISION_WORKER_BASE_URL,
  [string]$ExpectedSourceSha = $env:STOCKVISION_RELEASE_SHA,
  [string]$ManifestPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'infra/gcp-scheduler-jobs.json'),
  [string]$WranglerConfig = (Join-Path (Split-Path -Parent $PSScriptRoot) 'worker/wrangler.toml'),
  [string]$ModalPython = (Join-Path (Split-Path -Parent $PSScriptRoot) 'ml-service/.venv/Scripts/python.exe'),
  [string]$ModalSecretName = 'stockvision-cf',
  [string]$ModalEnvironment = $env:MODAL_ENVIRONMENT,
  [string]$AuthSecretId = 'stockvision-stockvision-auth-token',
  [string]$CloudflareApiSecretId = 'stockvision-cf-api-token',
  [string]$CloudflareAccountId = $env:CF_ACCOUNT_ID,
  [string]$D1DatabaseId = $env:CF_D1_DB_ID,
  [string]$KvNamespaceId = $env:CF_KV_NAMESPACE_ID,
  [string]$WorkerProbePath = '',
  [string]$PreviousSecretVersion = '',
  [string[]]$AllowedSchedulerCreateIds = @(
    'screener-v2-watchdog',
    'data-domain-shadow-backfill-ops'
  ),
  [int]$ExpectedSchedulerCount = 54
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'

if ($Apply -and $DryRun) { throw 'rotation_mode_conflict:Apply_and_DryRun' }
if ($Mode -eq 'Preflight' -and $Apply) { throw 'rotation_mode_conflict:Preflight_cannot_apply' }
if (-not $Project) {
  $Project = (& gcloud config get-value project 2>$null).Trim()
}
if (-not $WorkerProbePath) {
  $WorkerProbePath = "/api/admin/cron-logs?date=$((Get-Date).ToString('yyyy-MM-dd'))"
}

function Write-RotationLog([string]$Message) {
  Write-Host "[auth-rotation] $Message"
}

function Assert-NonEmpty([string]$Name, [string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw "rotation_preflight_missing:$Name" }
}

function Assert-ReleaseInputs {
  Assert-NonEmpty 'Project' $Project
  Assert-NonEmpty 'WorkerBaseUrl' $WorkerBaseUrl
  Assert-NonEmpty 'ExpectedSourceSha' $ExpectedSourceSha
  Assert-NonEmpty 'CloudflareAccountId' $CloudflareAccountId
  Assert-NonEmpty 'D1DatabaseId' $D1DatabaseId
  Assert-NonEmpty 'KvNamespaceId' $KvNamespaceId
  if ($ExpectedSourceSha -notmatch '^[0-9a-f]{40}$') { throw 'rotation_preflight_invalid:ExpectedSourceSha' }
  if (-not $WorkerBaseUrl.StartsWith('https://')) { throw 'rotation_preflight_invalid:WorkerBaseUrl_must_be_https' }
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw 'rotation_preflight_missing:ManifestPath' }
  if (-not (Test-Path -LiteralPath $WranglerConfig -PathType Leaf)) { throw 'rotation_preflight_missing:WranglerConfig' }
  if (-not (Test-Path -LiteralPath $ModalPython -PathType Leaf)) { throw 'rotation_preflight_missing:ModalPython' }
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $authSource = Get-Content -LiteralPath (Join-Path $repoRoot 'worker/src/lib/auth.ts') -Raw
  if ($authSource -notmatch 'STOCKVISION_AUTH_TOKEN_PREVIOUS') {
    throw 'rotation_preflight_invalid:dual_token_worker_source_missing'
  }
}

function Get-GoogleAccessToken {
  $prior = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = @(& gcloud auth print-access-token --quiet 2>$null)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prior
  }
  if ($exitCode -ne 0) { throw 'rotation_google_auth_failed' }
  $token = ([string]::Join('', @($lines))).Trim()
  if (-not $token) { throw 'rotation_google_auth_empty' }
  return $token
}

function Invoke-GoogleJson {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$AccessToken,
    [AllowNull()][object]$Body = $null,
    [Parameter(Mandatory = $true)][string]$Operation
  )
  $params = @{
    Method = $Method
    Uri = $Uri
    Headers = @{ Authorization = "Bearer $AccessToken" }
    TimeoutSec = 120
    ErrorAction = 'Stop'
  }
  if ($null -ne $Body) {
    $params.ContentType = 'application/json'
    $params.Body = ($Body | ConvertTo-Json -Compress -Depth 20)
  }
  try {
    return Invoke-RestMethod @params
  } catch {
    throw "rotation_google_api_failed:$Operation"
  }
}

function Get-SecretMaterial {
  param(
    [Parameter(Mandatory = $true)][string]$SecretId,
    [string]$Version = 'latest',
    [Parameter(Mandatory = $true)][string]$AccessToken
  )
  if ($SecretId -notmatch '^[a-zA-Z0-9_-]+$') { throw 'rotation_secret_invalid:id' }
  if ($Version -notmatch '^(latest|[0-9]+)$') { throw 'rotation_secret_invalid:version' }
  $uri = "https://secretmanager.googleapis.com/v1/projects/$Project/secrets/$SecretId/versions/$Version`:access"
  $response = Invoke-GoogleJson -Method GET -Uri $uri -AccessToken $AccessToken -Operation "secret_access:$SecretId"
  $encoded = [string]$response.payload.data
  if (-not $encoded) { throw "rotation_secret_empty:$SecretId" }
  try {
    $value = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
  } catch {
    throw "rotation_secret_decode_failed:$SecretId"
  }
  if (-not $value) { throw "rotation_secret_empty:$SecretId" }
  return [pscustomobject]@{ Name = [string]$response.name; Value = $value }
}

function Add-SecretVersion {
  param(
    [Parameter(Mandatory = $true)][string]$SecretId,
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$AccessToken
  )
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Value))
  $uri = "https://secretmanager.googleapis.com/v1/projects/$Project/secrets/$SecretId`:addVersion"
  $response = Invoke-GoogleJson -Method POST -Uri $uri -AccessToken $AccessToken -Body @{ payload = @{ data = $encoded } } -Operation "secret_add_version:$SecretId"
  if (-not $response.name) { throw "rotation_secret_add_version_missing_name:$SecretId" }
  return [string]$response.name
}

function Disable-SecretVersion {
  param(
    [Parameter(Mandatory = $true)][string]$VersionName,
    [Parameter(Mandatory = $true)][string]$AccessToken
  )
  if ($VersionName -notmatch "^projects/[^/]+/secrets/$([regex]::Escape($AuthSecretId))/versions/[0-9]+$") {
    throw 'rotation_secret_disable_invalid_version_name'
  }
  [void](Invoke-GoogleJson -Method POST -Uri "https://secretmanager.googleapis.com/v1/$VersionName`:disable" -AccessToken $AccessToken -Body @{} -Operation 'secret_disable_previous')
}

function Enable-SecretVersion {
  param(
    [Parameter(Mandatory = $true)][string]$VersionName,
    [Parameter(Mandatory = $true)][string]$AccessToken
  )
  if ($VersionName -notmatch "^projects/[^/]+/secrets/$([regex]::Escape($AuthSecretId))/versions/[0-9]+$") {
    throw 'rotation_secret_enable_invalid_version_name'
  }
  [void](Invoke-GoogleJson -Method POST -Uri "https://secretmanager.googleapis.com/v1/$VersionName`:enable" -AccessToken $AccessToken -Body @{} -Operation 'secret_enable_previous')
}

function New-ServiceToken {
  $bytes = New-Object byte[] 48
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Invoke-SafeNative {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [AllowNull()][string]$StandardInput = $null,
    [Parameter(Mandatory = $true)][string]$Operation
  )
  $prior = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($null -eq $StandardInput) {
      $captured = @(& $FilePath @Arguments 2>&1)
    } else {
      $captured = @($StandardInput | & $FilePath @Arguments 2>&1)
    }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prior
  }
  if ($exitCode -ne 0) { throw "rotation_native_failed:$Operation`:exit=$exitCode" }
  return [string]::Join("`n", @($captured | ForEach-Object { [string]$_ }))
}

function Get-WranglerCommand {
  $node = (Get-Command node -ErrorAction Stop).Source
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $cli = Join-Path $repoRoot 'worker/node_modules/wrangler/bin/wrangler.js'
  if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'rotation_preflight_missing:locked_wrangler' }
  return [pscustomobject]@{ Node = $node; Cli = $cli }
}

function Get-WranglerJson([string[]]$Arguments, [string]$Operation) {
  $command = Get-WranglerCommand
  $nativeArguments = @($command.Cli) + $Arguments
  $prior = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    # Wrangler may emit non-JSON notices on stderr even with --json. Keep stdout
    # as the strict JSON channel and discard stderr; exit status remains binding.
    $output = @(& $command.Node @nativeArguments 2>$null)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prior
  }
  if ($exitCode -ne 0) {
    throw "rotation_native_failed:$Operation`:exit=$exitCode"
  }
  $payload = [string]::Join("`n", @($output | ForEach-Object { [string]$_ })).Trim()
  if (-not $payload) { throw "rotation_wrangler_json_empty:$Operation" }
  try { return (ConvertFrom-Json -InputObject $payload -ErrorAction Stop) }
  catch { throw "rotation_wrangler_json_failed:$Operation" }
}

function Assert-WorkerVersionBaseline {
  $versions = @(Get-WranglerJson -Arguments @('versions', 'list', '--json', '--name', $WorkerName, '--config', $WranglerConfig) -Operation 'wrangler_versions_list')
  $deployments = @(Get-WranglerJson -Arguments @('deployments', 'list', '--json', '--name', $WorkerName, '--config', $WranglerConfig) -Operation 'wrangler_deployments_list')
  if ($versions.Count -eq 0 -or $deployments.Count -eq 0) { throw 'rotation_worker_version_state_empty' }
  $latestDeployment = @($deployments | Sort-Object { [datetime]$_.created_on })[-1]
  $traffic = @($latestDeployment.versions)
  if ($traffic.Count -ne 1 -or [double]$traffic[0].percentage -ne 100) { throw 'rotation_worker_traffic_not_single_100_percent' }
  $deployedVersionId = [string]$traffic[0].version_id
  $deployedVersions = @($versions | Where-Object { [string]$_.id -eq $deployedVersionId })
  if ($deployedVersions.Count -ne 1) { throw 'rotation_worker_deployed_version_not_in_recent_versions' }
  $deployedVersion = $deployedVersions[0]
  $tag = [string]$deployedVersion.annotations.'workers/tag'
  if ($tag -ne $ExpectedSourceSha) { throw 'rotation_worker_deployed_tag_mismatch' }

  # versions secret bulk copies the newest uploaded version, not necessarily the
  # deployed one. Fail closed if a different, undeployed upload is newer.
  $latestUploaded = @($versions | Sort-Object { [datetime]$_.metadata.created_on })[-1]
  if ([string]$latestUploaded.id -ne $deployedVersionId) { throw 'rotation_worker_latest_uploaded_not_deployed' }
}

function Publish-WorkerSecretVersion {
  param(
    [Parameter(Mandatory = $true)][string]$CurrentToken,
    [Parameter(Mandatory = $true)][string]$PreviousToken,
    [Parameter(Mandatory = $true)][string]$Message,
    [switch]$AllowLatestUndeployed
  )
  if (-not $AllowLatestUndeployed) { Assert-WorkerVersionBaseline }
  $command = Get-WranglerCommand
  $stdin = @{ STOCKVISION_AUTH_TOKEN = $CurrentToken; STOCKVISION_AUTH_TOKEN_PREVIOUS = $PreviousToken } | ConvertTo-Json -Compress
  $output = Invoke-SafeNative -FilePath $command.Node -Arguments @(
    $command.Cli, 'versions', 'secret', 'bulk', '--name', $WorkerName,
    '--tag', $ExpectedSourceSha, '--message', $Message, '--config', $WranglerConfig
  ) -StandardInput $stdin -Operation 'wrangler_secret_bulk'
  $match = [regex]::Match($output, 'Created version\s+([0-9a-fA-F-]{32,40})')
  if (-not $match.Success) { throw 'rotation_worker_secret_version_id_missing' }
  $versionId = $match.Groups[1].Value
  [void](Invoke-SafeNative -FilePath $command.Node -Arguments @(
    $command.Cli, 'versions', 'deploy', "$versionId@100%", '--yes', '--name', $WorkerName,
    '--message', $Message, '--config', $WranglerConfig
  ) -Operation 'wrangler_versions_deploy')
  return $versionId
}

function Remove-WorkerPreviousSecret {
  Assert-WorkerVersionBaseline
  $command = Get-WranglerCommand
  $message = "source=$ExpectedSourceSha,stockvision-auth-previous-retired"
  $output = Invoke-SafeNative -FilePath $command.Node -Arguments @(
    $command.Cli, 'versions', 'secret', 'delete', 'STOCKVISION_AUTH_TOKEN_PREVIOUS',
    '--name', $WorkerName, '--tag', $ExpectedSourceSha, '--message', $message,
    '--config', $WranglerConfig
  ) -StandardInput 'y' -Operation 'wrangler_secret_delete_previous'
  $match = [regex]::Match($output, 'Created version\s+([0-9a-fA-F-]{32,40})')
  if (-not $match.Success) { throw 'rotation_worker_finalize_version_id_missing' }
  $versionId = $match.Groups[1].Value
  [void](Invoke-SafeNative -FilePath $command.Node -Arguments @(
    $command.Cli, 'versions', 'deploy', "$versionId@100%", '--yes', '--name', $WorkerName,
    '--message', $message, '--config', $WranglerConfig
  ) -Operation 'wrangler_versions_deploy_finalize')
}

function Invoke-WorkerJson {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [AllowNull()][string]$Token = $null,
    [Parameter(Mandatory = $true)][string]$Operation
  )
  $headers = @{}
  if ($Token) { $headers.Authorization = "Bearer $Token" }
  try {
    return Invoke-RestMethod -Method Get -Uri "$($WorkerBaseUrl.TrimEnd('/'))$Path" -Headers $headers -TimeoutSec 60 -ErrorAction Stop
  } catch {
    throw "rotation_worker_probe_failed:$Operation"
  }
}

function Assert-WorkerSourceSha {
  $health = Invoke-WorkerJson -Path '/api/health' -Operation 'worker_health'
  if ([string]$health.provenance.sourceSha -ne $ExpectedSourceSha) { throw 'rotation_worker_source_sha_mismatch' }
}

function Assert-WorkerToken([string]$Token, [string]$Label) {
  [void](Invoke-WorkerJson -Path $WorkerProbePath -Token $Token -Operation "worker_auth:$Label")
}

function Get-SchedulerManifest {
  $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  $jobs = @($manifest.jobs)
  if ($jobs.Count -ne $ExpectedSchedulerCount) { throw "rotation_scheduler_manifest_count_mismatch:expected=$ExpectedSchedulerCount`:actual=$($jobs.Count)" }
  $seen = [System.Collections.Generic.HashSet[string]]::new()
  foreach ($job in $jobs) {
    $id = [string]$job.id
    if ($id -notmatch '^[a-z][a-z0-9-]{0,499}$' -or -not $seen.Add($id)) { throw 'rotation_scheduler_manifest_invalid_or_duplicate_id' }
  }
  return $manifest
}

$schedulerRestHelper = Join-Path $PSScriptRoot 'auth_rotation_scheduler_rest.ps1'
if (-not (Test-Path -LiteralPath $schedulerRestHelper -PathType Leaf)) {
  throw 'rotation_preflight_missing:scheduler_rest_helper'
}
. $schedulerRestHelper

function Set-ModalSecret([string]$WorkerToken, [string]$CloudflareApiToken) {
  $saved = @{}
  $keys = @(
    'ROTATION_STOCKVISION_AUTH_TOKEN', 'ROTATION_CF_API_TOKEN', 'ROTATION_CF_ACCOUNT_ID',
    'ROTATION_CF_D1_DB_ID', 'ROTATION_CF_KV_NAMESPACE_ID', 'ROTATION_STOCKVISION_WORKER_URL',
    'ROTATION_MODAL_SECRET_NAME', 'ROTATION_MODAL_ENVIRONMENT'
  )
  foreach ($key in $keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
  try {
    $env:ROTATION_STOCKVISION_AUTH_TOKEN = $WorkerToken
    $env:ROTATION_CF_API_TOKEN = $CloudflareApiToken
    $env:ROTATION_CF_ACCOUNT_ID = $CloudflareAccountId
    $env:ROTATION_CF_D1_DB_ID = $D1DatabaseId
    $env:ROTATION_CF_KV_NAMESPACE_ID = $KvNamespaceId
    $env:ROTATION_STOCKVISION_WORKER_URL = $WorkerBaseUrl.TrimEnd('/')
    $env:ROTATION_MODAL_SECRET_NAME = $ModalSecretName
    $env:ROTATION_MODAL_ENVIRONMENT = $ModalEnvironment
    $python = @'
import os
import modal

required = {
    "CF_API_TOKEN": os.environ["ROTATION_CF_API_TOKEN"],
    "CF_ACCOUNT_ID": os.environ["ROTATION_CF_ACCOUNT_ID"],
    "CF_D1_DB_ID": os.environ["ROTATION_CF_D1_DB_ID"],
    "CF_KV_NAMESPACE_ID": os.environ["ROTATION_CF_KV_NAMESPACE_ID"],
    "STOCKVISION_AUTH_TOKEN": os.environ["ROTATION_STOCKVISION_AUTH_TOKEN"],
    "STOCKVISION_WORKER_URL": os.environ["ROTATION_STOCKVISION_WORKER_URL"],
}
if any(not value for value in required.values()):
    raise SystemExit(9)
modal.Secret.create_deployed(
    os.environ["ROTATION_MODAL_SECRET_NAME"],
    required,
    environment_name=(os.environ.get("ROTATION_MODAL_ENVIRONMENT") or None),
    overwrite=True,
)
'@
    [void](Invoke-SafeNative -FilePath $ModalPython -Arguments @('-c', $python) -Operation 'modal_secret_replace')
  } finally {
    foreach ($key in $keys) {
      [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process')
    }
  }
}

function Invoke-RotationPreflight([string]$GoogleToken, [object]$Manifest, [object]$CurrentSecret) {
  Assert-WorkerSourceSha
  Assert-WorkerToken -Token $CurrentSecret.Value -Label 'current'
  Assert-WorkerVersionBaseline
  $plan = New-SchedulerInventoryPlan -Manifest $Manifest -AccessToken $GoogleToken -ExpectedToken $CurrentSecret.Value -LogPlan
  Assert-SchedulerCreatePlanAllowed -Manifest $Manifest -Plan $plan -AllowedCreateIds $AllowedSchedulerCreateIds
  [void](Get-SecretMaterial -SecretId $CloudflareApiSecretId -AccessToken $GoogleToken)
  Write-RotationLog "preflight passed source_sha=$ExpectedSourceSha managed_present=$($plan.ExistingIds.Count) planned_create=$($plan.MissingIds.Count) expected=$ExpectedSchedulerCount"
  return $plan
}

Assert-ReleaseInputs
$googleToken = Get-GoogleAccessToken
$manifest = Get-SchedulerManifest
$currentSecret = Get-SecretMaterial -SecretId $AuthSecretId -AccessToken $googleToken
$schedulerPlan = Invoke-RotationPreflight -GoogleToken $googleToken -Manifest $manifest -CurrentSecret $currentSecret

if ($Mode -eq 'Preflight') { return }
if (-not $Apply -or $DryRun) {
  Write-RotationLog "dry-run mode=$Mode; no token generated and no mutation performed"
  return
}

if ($Mode -eq 'Finalize') {
  if (-not $DrainVerified) { throw 'rotation_finalize_blocked:DrainVerified_required' }
  Assert-NonEmpty 'PreviousSecretVersion' $PreviousSecretVersion
  if ($PreviousSecretVersion -eq $currentSecret.Name) { throw 'rotation_finalize_blocked:previous_equals_latest' }
  $previousVersionId = ($PreviousSecretVersion -split '/')[-1]
  $previousSecret = Get-SecretMaterial -SecretId $AuthSecretId -Version $previousVersionId -AccessToken $googleToken
  Assert-WorkerToken -Token $currentSecret.Value -Label 'latest_before_finalize'
  Assert-SchedulerState -Manifest $manifest -AccessToken $googleToken -ExpectedToken $currentSecret.Value
  $previousDisabled = $false
  $workerPreviousAttempted = $false
  try {
    # Disable the old Secret Manager version first while Worker still accepts
    # the previous token. A failure here cannot strand an old live consumer.
    Disable-SecretVersion -VersionName $PreviousSecretVersion -AccessToken $googleToken
    $previousDisabled = $true
    Assert-WorkerToken -Token $currentSecret.Value -Label 'latest_after_old_sm_disable'
    Assert-SchedulerState -Manifest $manifest -AccessToken $googleToken -ExpectedToken $currentSecret.Value
    $workerPreviousAttempted = $true
    Remove-WorkerPreviousSecret
    Assert-WorkerSourceSha
    Assert-WorkerToken -Token $currentSecret.Value -Label 'latest_after_finalize'
  } catch {
    if ($workerPreviousAttempted) {
      try {
        [void](Publish-WorkerSecretVersion -CurrentToken $currentSecret.Value -PreviousToken $previousSecret.Value -Message "source=$ExpectedSourceSha,stockvision-auth-finalize-rollback" -AllowLatestUndeployed)
      } catch { Write-RotationLog 'finalize rollback Worker previous failed; manual rollback required' }
    }
    if ($previousDisabled) {
      try { Enable-SecretVersion -VersionName $PreviousSecretVersion -AccessToken $googleToken } catch { Write-RotationLog 'finalize rollback GCP previous enable failed; manual rollback required' }
    }
    throw 'rotation_finalize_failed_and_rollback_attempted'
  }
  Write-RotationLog "finalized previous_secret_version=$PreviousSecretVersion"
  return
}

$previousVersionName = $currentSecret.Name
$newToken = New-ServiceToken
$cloudflareSecret = Get-SecretMaterial -SecretId $CloudflareApiSecretId -AccessToken $googleToken
$newVersionName = ''
$workerAttempted = $false
$modalAttempted = $false
$schedulerAttempted = $false
$gcpAttempted = $false
$schedulerState = New-SchedulerSyncState
try {
  $message = "source=$ExpectedSourceSha,stockvision-auth-overlap"
  $workerAttempted = $true
  [void](Publish-WorkerSecretVersion -CurrentToken $newToken -PreviousToken $currentSecret.Value -Message $message)
  Assert-WorkerSourceSha
  Assert-WorkerToken -Token $currentSecret.Value -Label 'previous_overlap'
  Assert-WorkerToken -Token $newToken -Label 'current_overlap'

  $gcpAttempted = $true
  $newVersionName = Add-SecretVersion -SecretId $AuthSecretId -Value $newToken -AccessToken $googleToken
  $modalAttempted = $true
  Set-ModalSecret -WorkerToken $newToken -CloudflareApiToken $cloudflareSecret.Value
  $schedulerAttempted = $true
  Sync-SchedulerInventory -Manifest $manifest -Plan $schedulerPlan -State $schedulerState -AccessToken $googleToken -Token $newToken
  Assert-WorkerToken -Token $newToken -Label 'current_complete'
  Assert-WorkerToken -Token $currentSecret.Value -Label 'previous_complete'
} catch {
  Write-RotationLog 'rotation failed; starting in-memory rollback'
  if ($schedulerAttempted) {
    try {
      Restore-SchedulerInventory -Manifest $manifest -Plan $schedulerPlan -State $schedulerState -AccessToken $googleToken -AppliedToken $newToken -OriginalToken $currentSecret.Value
    } catch { Write-RotationLog 'rollback scheduler failed; manual rollback required' }
  }
  if ($modalAttempted) {
    try { Set-ModalSecret -WorkerToken $currentSecret.Value -CloudflareApiToken $cloudflareSecret.Value } catch { Write-RotationLog 'rollback Modal secret failed; manual rollback required' }
  }
  if ($gcpAttempted) {
    try {
      [void](Add-SecretVersion -SecretId $AuthSecretId -Value $currentSecret.Value -AccessToken $googleToken)
      if ($newVersionName) { Disable-SecretVersion -VersionName $newVersionName -AccessToken $googleToken }
    } catch { Write-RotationLog 'rollback GCP secret failed; manual rollback required' }
  }
  if ($workerAttempted) {
    try { [void](Publish-WorkerSecretVersion -CurrentToken $currentSecret.Value -PreviousToken $currentSecret.Value -Message "source=$ExpectedSourceSha,stockvision-auth-rollback" -AllowLatestUndeployed) } catch { Write-RotationLog 'rollback Worker secret failed; manual rollback required' }
  }
  throw 'rotation_failed_and_rollback_attempted'
} finally {
  $newToken = $null
  $cloudflareSecret = $null
  $googleToken = $null
  $currentSecret = $null
  $schedulerPlan = $null
  $schedulerState = $null
}

Write-RotationLog "rotation overlap ready previous_secret_version=$previousVersionName new_secret_version=$newVersionName schedulers=$ExpectedSchedulerCount"
Write-RotationLog 'do not finalize until Cloud Run/Modal deployment, reject-only canary, zero-401 check, and old-revision drain all pass'
