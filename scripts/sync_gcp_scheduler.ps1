param(
  [string]$Project = $env:GOOGLE_CLOUD_PROJECT,
  [string]$Location = 'asia-east1',
  [string]$ManifestPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'infra/gcp-scheduler-jobs.json'),
  [string]$WorkerBaseUrl = $env:STOCKVISION_WORKER_BASE_URL,
  [string]$AuthToken = $env:SCHEDULER_AUTH_TOKEN,
  [switch]$DryRun,
  [switch]$DeleteStale
)

$ErrorActionPreference = 'Stop'

if (-not $Project) {
  $Project = (gcloud config get-value project 2>$null)
}
if (-not $Project) { throw 'Missing GCP project. Set GOOGLE_CLOUD_PROJECT or gcloud config project.' }
if ($DryRun -and -not $WorkerBaseUrl) {
  $WorkerBaseUrl = 'https://dry-run-worker-base-url.invalid'
}
if ($DryRun -and -not $AuthToken) {
  $AuthToken = 'DRY_RUN_AUTH_TOKEN_PLACEHOLDER'
}
if (-not $WorkerBaseUrl) { throw 'Missing STOCKVISION_WORKER_BASE_URL.' }
if (-not $AuthToken) { throw 'Missing SCHEDULER_AUTH_TOKEN.' }

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if (-not $DryRun -and $null -ne $manifest.mutationAllowed -and -not [bool]$manifest.mutationAllowed) {
  throw "Manifest blocks production mutation: $ManifestPath"
}
$base = $WorkerBaseUrl.TrimEnd('/')
$managedIds = [System.Collections.Generic.HashSet[string]]::new()
$deleteIds = [System.Collections.Generic.HashSet[string]]::new()
if ($manifest.deleteJobIds) {
  foreach ($jobId in $manifest.deleteJobIds) {
    if ($jobId) { [void]$deleteIds.Add([string]$jobId) }
  }
}
$currentIds = [System.Collections.Generic.HashSet[string]]::new()

function New-SchedulerHeaderArg {
  param([object]$Job)

  $pairs = [System.Collections.Generic.List[string]]::new()
  [void]$pairs.Add("Authorization=Bearer $AuthToken")

  if ($Job.headers) {
    foreach ($prop in $Job.headers.PSObject.Properties) {
      $name = [string]$prop.Name
      $value = [string]$prop.Value
      if ($name -match '[=,]' -or $value -match ',') {
        throw "Invalid scheduler header for job $($Job.id): $name"
      }
      [void]$pairs.Add("$name=$value")
    }
  }

  return ($pairs -join ',')
}

$currentJobs = @()
$currentJobs = gcloud scheduler jobs list --project $Project --location $Location --format 'value(name.basename())'
if ($LASTEXITCODE -ne 0) { throw 'gcloud scheduler jobs list failed' }
foreach ($jobId in $currentJobs) {
  if ($jobId) { [void]$currentIds.Add([string]$jobId) }
}

foreach ($job in $manifest.jobs) {
  [void]$managedIds.Add([string]$job.id)
  $uriPath = if ($job.uriPath) { [string]$job.uriPath } else { "/api/admin/trigger/$($job.task)" }
  if (-not $uriPath.StartsWith('/api/admin/')) {
    throw "Invalid scheduler URI path for job $($job.id): $uriPath"
  }
  $uri = "$base$uriPath"
  $query = [string]$job.query
  if ($query) {
    $uri = "$uri`?$query"
  }
  $description = [string]$job.description
  $timeZone = if ($job.timeZone) { [string]$job.timeZone } else { [string]$manifest.timeZone }
  $headers = New-SchedulerHeaderArg -Job $job
  $exists = $currentIds.Contains([string]$job.id)

  if ($exists) {
    $args = @(
      'scheduler', 'jobs', 'update', 'http', $job.id,
      '--project', $Project,
      '--location', $Location,
      '--schedule', $job.schedule,
      '--time-zone', $timeZone,
      '--uri', $uri,
      '--http-method', 'POST',
      '--update-headers', $headers,
      '--attempt-deadline', '300s',
      '--description', $description,
      '--format', 'none'
    )
  } else {
    $args = @(
      'scheduler', 'jobs', 'create', 'http', $job.id,
      '--project', $Project,
      '--location', $Location,
      '--schedule', $job.schedule,
      '--time-zone', $timeZone,
      '--uri', $uri,
      '--http-method', 'POST',
      '--headers', $headers,
      '--attempt-deadline', '300s',
      '--description', $description,
      '--format', 'none'
    )
  }

  if ($null -ne $job.maxRetryAttempts) {
    $args += @('--max-retry-attempts', [string]$job.maxRetryAttempts)
  }
  if ($job.minBackoff) {
    $args += @('--min-backoff', [string]$job.minBackoff)
  }
  if ($job.maxBackoff) {
    $args += @('--max-backoff', [string]$job.maxBackoff)
  }
  if ($job.maxRetryDuration) {
    $args += @('--max-retry-duration', [string]$job.maxRetryDuration)
  }

  $action = if ($exists) { 'update' } else { 'create' }
  Write-Host "[scheduler-sync] $action $($job.id) -> $uri @ $($job.schedule) tz=$timeZone"
  if (-not $DryRun) {
    & gcloud @args *> $null
    if ($LASTEXITCODE -ne 0) { throw "gcloud scheduler sync failed for $($job.id)" }
  }

  foreach ($legacyId in @($job.legacyIds)) {
    $legacyId = [string]$legacyId
    if (-not $legacyId -or $legacyId -eq [string]$job.id -or -not $currentIds.Contains($legacyId)) {
      continue
    }
    Write-Host "[scheduler-sync] replace legacy $legacyId -> $($job.id)"
    if (-not $DryRun) {
      $previousErrorActionPreference = $ErrorActionPreference
      try {
        # gcloud.ps1 writes a successful delete confirmation to stderr on Windows.
        $ErrorActionPreference = 'Continue'
        & gcloud scheduler jobs delete $legacyId --project $Project --location $Location --quiet *> $null
        $deleteExitCode = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousErrorActionPreference
      }
      if ($deleteExitCode -ne 0) { throw "gcloud scheduler legacy replacement failed for $legacyId" }
    }
  }
}

if ($DeleteStale) {
  foreach ($jobId in $currentJobs) {
    if (-not $managedIds.Contains($jobId) -and $deleteIds.Contains($jobId)) {
      Write-Host "[scheduler-sync] delete stale $jobId"
      if (-not $DryRun) {
        $previousErrorActionPreference = $ErrorActionPreference
        try {
          # gcloud.ps1 writes a successful delete confirmation to stderr on Windows.
          $ErrorActionPreference = 'Continue'
          & gcloud scheduler jobs delete $jobId --project $Project --location $Location --quiet *> $null
          $deleteExitCode = $LASTEXITCODE
        } finally {
          $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($deleteExitCode -ne 0) { throw "gcloud scheduler delete failed for $jobId" }
      }
    } elseif (-not $managedIds.Contains($jobId)) {
      Write-Host "[scheduler-sync] preserve unmanaged $jobId"
    }
  }
}

Write-Host "[scheduler-sync] complete owner=$($manifest.owner) jobs=$($manifest.jobs.Count) dryRun=$DryRun"
