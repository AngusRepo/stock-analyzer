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
$intraday = @($manifest.jobs | Where-Object { $_.id -eq 'intraday-check' })[0]
if ($intraday.path -ne '/finlab/execution/production-simulated-loop') {
  throw "Execution release closure failed: intraday-check path is $($intraday.path)"
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
