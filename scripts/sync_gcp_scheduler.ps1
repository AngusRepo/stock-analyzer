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
if (-not $WorkerBaseUrl) { throw 'Missing STOCKVISION_WORKER_BASE_URL.' }
if (-not $AuthToken) { throw 'Missing SCHEDULER_AUTH_TOKEN.' }

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$base = $WorkerBaseUrl.TrimEnd('/')
$headers = "Authorization=Bearer $AuthToken"
$managedIds = [System.Collections.Generic.HashSet[string]]::new()
$currentIds = [System.Collections.Generic.HashSet[string]]::new()

$currentJobs = @()
if (-not $DryRun) {
  $currentJobs = gcloud scheduler jobs list --project $Project --location $Location --format 'value(name.basename())'
  if ($LASTEXITCODE -ne 0) { throw 'gcloud scheduler jobs list failed' }
  foreach ($jobId in $currentJobs) {
    if ($jobId) { [void]$currentIds.Add([string]$jobId) }
  }
}

foreach ($job in $manifest.jobs) {
  [void]$managedIds.Add([string]$job.id)
  $uri = "$base/api/admin/trigger/$($job.task)"
  $query = [string]$job.query
  if ($query) {
    $uri = "$uri`?$query"
  }
  $description = [string]$job.description
  $exists = $DryRun -or $currentIds.Contains([string]$job.id)

  if ($exists) {
    $args = @(
      'scheduler', 'jobs', 'update', 'http', $job.id,
      '--project', $Project,
      '--location', $Location,
      '--schedule', $job.schedule,
      '--time-zone', $manifest.timeZone,
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
      '--time-zone', $manifest.timeZone,
      '--uri', $uri,
      '--http-method', 'POST',
      '--headers', $headers,
      '--attempt-deadline', '300s',
      '--description', $description,
      '--format', 'none'
    )
  }

  $action = if ($exists) { 'update' } else { 'create' }
  Write-Host "[scheduler-sync] $action $($job.id) -> $uri @ $($job.schedule)"
  if (-not $DryRun) {
    & gcloud @args *> $null
    if ($LASTEXITCODE -ne 0) { throw "gcloud scheduler sync failed for $($job.id)" }
  }
}

if ($DeleteStale -and -not $DryRun) {
  foreach ($jobId in $currentJobs) {
    if (-not $managedIds.Contains($jobId)) {
      Write-Host "[scheduler-sync] delete stale $jobId"
      if (-not $DryRun) {
        gcloud scheduler jobs delete $jobId --project $Project --location $Location --quiet *> $null
        if ($LASTEXITCODE -ne 0) { throw "gcloud scheduler delete failed for $jobId" }
      }
    }
  }
}

Write-Host "[scheduler-sync] complete owner=$($manifest.owner) jobs=$($manifest.jobs.Count) dryRun=$DryRun"
