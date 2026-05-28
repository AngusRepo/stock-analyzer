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
$currentJobs = gcloud scheduler jobs list --project $Project --location $Location --format 'value(name.basename())'
if ($LASTEXITCODE -ne 0) { throw 'gcloud scheduler jobs list failed' }
foreach ($jobId in $currentJobs) {
  if ($jobId) { [void]$currentIds.Add([string]$jobId) }
}

$deprecatedHits = @()
if ($manifest.PSObject.Properties.Name -contains 'deprecatedJobs') {
  foreach ($deprecated in @($manifest.deprecatedJobs)) {
    $deprecatedId = [string]$deprecated.id
    if (-not $deprecatedId) { continue }
    if (@($manifest.jobs | Where-Object { [string]$_.id -eq $deprecatedId }).Count -gt 0) {
      throw "[scheduler-sync] deprecated job is still managed by manifest jobs: $deprecatedId"
    }
    if ($currentIds.Contains($deprecatedId)) {
      $reason = [string]$deprecated.reason
      $deprecatedHits += if ($reason) { "$deprecatedId ($reason)" } else { $deprecatedId }
    }
  }
}

if ($deprecatedHits.Count -gt 0) {
  if (-not $DeleteStale) {
    throw "[scheduler-sync] deprecated live Scheduler job(s) still exist: $($deprecatedHits -join '; '). Re-run with -DeleteStale only after production approval."
  }
  foreach ($hit in $deprecatedHits) {
    Write-Host "[scheduler-sync] deprecated live job will be deleted by -DeleteStale: $hit"
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
  $timeZone = if ($job.timeZone) { [string]$job.timeZone } else { [string]$manifest.timeZone }
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

  $action = if ($exists) { 'update' } else { 'create' }
  Write-Host "[scheduler-sync] $action $($job.id) -> $uri @ $($job.schedule) tz=$timeZone"
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
