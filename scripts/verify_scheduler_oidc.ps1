param(
  [string]$Project = $env:GOOGLE_CLOUD_PROJECT,
  [string]$Location = 'asia-east1',
  [string]$ManifestPath,
  [Parameter(Mandatory = $true)][string]$WorkerBaseUrl,
  [string]$SchedulerServiceAccount = $env:GOOGLE_SCHEDULER_SERVICE_ACCOUNT,
  [string]$OidcAudience = $env:GOOGLE_SCHEDULER_AUDIENCE,
  [int]$MaxViolationDetails = 20
)

$ErrorActionPreference = 'Stop'
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ManifestPath) { $ManifestPath = Join-Path (Split-Path -Parent $ScriptRoot) 'infra/gcp-scheduler-jobs.json' }
if (-not $Project) { $Project = (gcloud config get-value project 2>$null) }
if (-not $Project) { throw 'Missing GCP project.' }
if (-not $SchedulerServiceAccount) { throw 'Missing GOOGLE_SCHEDULER_SERVICE_ACCOUNT.' }

$base = $WorkerBaseUrl.TrimEnd('/')
if (-not $OidcAudience) { $OidcAudience = $base }
if ($OidcAudience -ne $base) { throw 'GOOGLE_SCHEDULER_AUDIENCE must equal WorkerBaseUrl without query parameters.' }

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$managedIds = @($manifest.jobs | ForEach-Object { [string]$_.id })
$jobsRaw = gcloud scheduler jobs list --project $Project --location $Location --format json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'gcloud scheduler jobs list failed' }
$jobs = @($jobsRaw | ForEach-Object { $_ })
$byId = @{}
foreach ($job in $jobs) { $byId[([string]$job.name -split '/')[-1]] = $job }

$violations = [System.Collections.Generic.List[string]]::new()
foreach ($jobId in $managedIds) {
  $job = $byId[$jobId]
  if (-not $job) {
    [void]$violations.Add("missing:$jobId")
    continue
  }
  if (-not ([string]$job.httpTarget.uri).StartsWith("$base/api/admin/trigger/")) {
    [void]$violations.Add("target_drift:$jobId")
  }
  if ($job.httpTarget.headers.Authorization) {
    [void]$violations.Add("static_authorization_header:$jobId")
  }
  if ([string]$job.httpTarget.oidcToken.serviceAccountEmail -ne $SchedulerServiceAccount) {
    [void]$violations.Add("oidc_service_account_drift:$jobId")
  }
  if ([string]$job.httpTarget.oidcToken.audience -ne $OidcAudience) {
    [void]$violations.Add("oidc_audience_drift:$jobId")
  }
}

foreach ($job in $jobs) {
  $jobId = ([string]$job.name -split '/')[-1]
  if (([string]$job.httpTarget.uri).StartsWith("$base/") -and $jobId -notin $managedIds) {
    [void]$violations.Add("unmanaged_worker_job:$jobId")
  }
}

if ($violations.Count) {
  $violations | Sort-Object | Select-Object -First $MaxViolationDetails | ForEach-Object { Write-Host "[scheduler-oidc] BLOCK $_" }
  if ($violations.Count -gt $MaxViolationDetails) {
    Write-Host "[scheduler-oidc] BLOCK additional_violations=$($violations.Count - $MaxViolationDetails)"
  }
  throw "Scheduler OIDC drift gate failed with $($violations.Count) violation(s)."
}

Write-Host "[scheduler-oidc] PASS jobs=$($managedIds.Count) service_account=$SchedulerServiceAccount audience=$OidcAudience"
