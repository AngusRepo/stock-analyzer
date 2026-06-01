param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
  $global:PSNativeCommandUseErrorActionPreference = $false
}

$criticalFiles = @(
  'ml-controller/routers/finlab.py',
  'ml-controller/services/finlab_production_simulated_loop.py',
  'ml-controller/services/finlab_sinopac_l5_market_data.py',
  'ml-controller/tests/test_finlab_production_simulated_loop.py',
  'ml-controller/tests/test_finlab_sinopac_l5_market_data.py',
  'worker/src/index.ts',
  'worker/src/routes/finlabExecutionLoopRoutes.ts',
  'worker/src/routes/adminReadRoutes.ts',
  'worker/src/lib/executionPrePilotEvidence.ts',
  'worker/src/lib/executionPrePilotEvidence.test.ts',
  'worker/src/lib/executionReleaseClosureContract.test.ts',
  'scripts/verify_execution_release_closure.ps1'
)

$missing = @()
foreach ($file in $criticalFiles) {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  git -C $Root ls-files --error-unmatch $file 2>$null | Out-Null
  $ErrorActionPreference = $previousErrorActionPreference
  if ($LASTEXITCODE -ne 0) {
    $missing += $file
  }
}

if ($missing.Count -gt 0) {
  throw "Execution release closure failed: critical production-simulated execution files are not git-tracked: $($missing -join ', ')"
}

$manifest = Get-Content -LiteralPath (Join-Path $Root 'infra/gcp-scheduler-jobs.json') -Raw | ConvertFrom-Json
$intradayJobs = @($manifest.jobs | Where-Object { [string]$_.task -eq 'intraday-check' })
if ($intradayJobs.Count -ne 2) {
  throw "Execution release closure failed: intraday-check must be split into two Scheduler jobs, got $($intradayJobs.Count)"
}
foreach ($intraday in $intradayJobs) {
  if ($intraday.path -ne '/finlab/execution/production-simulated-loop') {
    throw "Execution release closure failed: $($intraday.id) path is $($intraday.path)"
  }
}
$intradaySchedules = @($intradayJobs | ForEach-Object { [string]$_.schedule })
if (-not ($intradaySchedules -contains '* 1-4 * * 1-5') -or -not ($intradaySchedules -contains '0-30 5 * * 1-5')) {
  throw "Execution release closure failed: intraday-check schedules must cover TW 09:00-13:30 only; got $($intradaySchedules -join ', ')"
}
if ($intradaySchedules -contains '* 1-5 * * 1-5') {
  throw 'Execution release closure failed: intraday-check must not run until TW 13:59'
}

$router = Get-Content -LiteralPath (Join-Path $Root 'ml-controller/routers/finlab.py') -Raw
if ($router -notmatch '@router\.post\("/execution/production-simulated-loop"\)') {
  throw 'Execution release closure failed: ml-controller router does not expose /execution/production-simulated-loop'
}

$workerIndex = Get-Content -LiteralPath (Join-Path $Root 'worker/src/index.ts') -Raw
if ($workerIndex -notmatch 'finlabExecutionLoopRoutes') {
  throw 'Execution release closure failed: Worker index does not mount finlabExecutionLoopRoutes'
}

Write-Host '[execution-release-closure] ok'
