param(
  [string]$Project = $env:GOOGLE_CLOUD_PROJECT,
  [string]$Location = 'asia-east1',
  [string]$ManifestPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'infra/gcp-scheduler-jobs.json'),
  [string]$WorkerBaseUrl = $env:STOCKVISION_WORKER_BASE_URL,
  [string]$SchedulerServiceAccount = $env:GOOGLE_SCHEDULER_SERVICE_ACCOUNT,
  [string]$OidcAudience = $env:GOOGLE_SCHEDULER_AUDIENCE,
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
if ($DryRun -and -not $SchedulerServiceAccount) {
  $SchedulerServiceAccount = "stockvision-scheduler@$Project.iam.gserviceaccount.com"
}
if (-not $WorkerBaseUrl) { throw 'Missing STOCKVISION_WORKER_BASE_URL.' }
if (-not $SchedulerServiceAccount) { throw 'Missing GOOGLE_SCHEDULER_SERVICE_ACCOUNT.' }
if ($SchedulerServiceAccount -notmatch "^[^@]+@$([regex]::Escape($Project))\.iam\.gserviceaccount\.com$") {
  throw 'GOOGLE_SCHEDULER_SERVICE_ACCOUNT must be a dedicated service account in the scheduler project.'
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$base = $WorkerBaseUrl.TrimEnd('/')
if (-not $OidcAudience) { $OidcAudience = $base }
if ($OidcAudience -ne $base) { throw 'GOOGLE_SCHEDULER_AUDIENCE must equal STOCKVISION_WORKER_BASE_URL without query parameters.' }
$managedIds = [System.Collections.Generic.HashSet[string]]::new()
$currentIds = [System.Collections.Generic.HashSet[string]]::new()

function New-SchedulerHeaderArg {
  param([object]$Job)

  $pairs = [System.Collections.Generic.List[string]]::new()
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
  $uri = "$base/api/admin/trigger/$($job.task)"
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
      '--oidc-service-account-email', $SchedulerServiceAccount,
      '--oidc-token-audience', $OidcAudience,
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
      '--oidc-service-account-email', $SchedulerServiceAccount,
      '--oidc-token-audience', $OidcAudience,
      '--attempt-deadline', '300s',
      '--description', $description,
      '--format', 'none'
    )
  }

  if ($headers) {
    $headerFlag = if ($exists) { '--update-headers' } else { '--headers' }
    $args += @($headerFlag, $headers)
  } elseif ($exists) {
    $args += '--clear-headers'
  }

  $action = if ($exists) { 'update' } else { 'create' }
  Write-Host "[scheduler-sync] $action $($job.id) -> $uri @ $($job.schedule) tz=$timeZone"
  if (-not $DryRun) {
    & gcloud @args *> $null
    if ($LASTEXITCODE -ne 0) { throw "gcloud scheduler sync failed for $($job.id)" }
  }
}

if ($DeleteStale) {
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
