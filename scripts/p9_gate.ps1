param(
  [switch]$SkipFrontendBuild,
  [switch]$SkipBugHunter,
  [switch]$RuntimeSecretAudit,
  [int]$BugHunterMaxAgeHours = 48,
  [switch]$LiveSmoke,
  [string]$ApiBase = $env:STOCKVISION_API_BASE,
  [string]$AuthToken = $env:STOCKVISION_AUTH_TOKEN
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

Write-Host '[P9 gate] worker type-check'
Push-Location (Join-Path $Root 'worker')
npm run type-check
if ($LASTEXITCODE -ne 0) { throw "worker type-check failed" }

Write-Host '[P9 gate] worker contract tests'
$RuntimeE2ETests = @(
  'strategyDiscoveryLocalE2E.test.ts',
  'strategyDiscoveryRealModelE2E.test.ts'
)
$WorkerTestSources = Get-ChildItem -Path (Join-Path (Get-Location) 'src\lib') -Filter '*.test.ts' |
  Sort-Object Name |
  Where-Object { $RuntimeE2ETests -notcontains $_.Name } |
  ForEach-Object { "src/lib/$($_.Name)" }
foreach ($testSource in $WorkerTestSources) {
  npx tsx $testSource
  if ($LASTEXITCODE -ne 0) { throw "$testSource failed" }
}
Write-Host '[P9 gate] runtime E2E tests are gated separately with an explicit local server/model runtime'
Pop-Location

Write-Host '[P9 gate] ml-controller contract tests'
$ControllerPython = Join-Path $Root 'ml-controller\.venv\Scripts\python.exe'
if (-not (Test-Path $ControllerPython)) {
  $ControllerPython = Join-Path $Root 'ml-service\.venv\Scripts\python.exe'
}
if (-not (Test-Path $ControllerPython)) {
  throw "controller python not found in ml-controller/.venv or ml-service/.venv"
}
Push-Location (Join-Path $Root 'ml-controller')
& $ControllerPython -m pytest tests\test_verify_pipeline_graph.py tests\test_p6_emerging_ml_contract.py tests\test_p7_model_upgrade_research_track.py tests\test_p8_adaptive_meta_contract.py tests\test_market_segment_policy.py tests\test_model_ic_tracker.py tests\test_train_serve_parity_contract.py tests\test_sector_flow_proxy.py tests\test_pipeline_callback_contract.py tests\test_retrain_followup_telemetry.py -q
if ($LASTEXITCODE -ne 0) { throw "ml-controller contract tests failed" }
Pop-Location

if (-not $SkipFrontendBuild) {
  Write-Host '[P9 gate] frontend build'
  Push-Location (Join-Path $Root 'frontend')
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }
  Pop-Location
}

Write-Host '[P9 gate] diff hygiene'
Push-Location $Root
git diff --check
if ($LASTEXITCODE -ne 0) { throw "git diff --check failed" }
Pop-Location

Write-Host '[P9 gate] P12 secret scan'
& (Join-Path $PSScriptRoot 'p12_secret_scan.ps1') -Root $Root
if ($LASTEXITCODE -ne 0) { throw "P12 secret scan failed" }

if ($RuntimeSecretAudit) {
  Write-Host '[P9 gate] Cloud Run runtime secret audit'
  & (Join-Path $PSScriptRoot 'audit_cloudrun_secret_bindings.ps1')
  if ($LASTEXITCODE -ne 0) { throw "Cloud Run runtime secret audit failed" }
}

Write-Host '[P9 gate] Bug Hunter CPD gate'
& (Join-Path $PSScriptRoot 'bug_hunter_cpd_gate.ps1') -Root $Root -MaxAgeHours $BugHunterMaxAgeHours -Skip:$SkipBugHunter
if ($LASTEXITCODE -ne 0) { throw "Bug Hunter CPD gate failed" }

if ($LiveSmoke) {
  Write-Host '[P9 gate] live smoke'
  if (-not $ApiBase) { throw 'LiveSmoke requires -ApiBase or STOCKVISION_API_BASE' }
  if (-not $AuthToken) { throw 'LiveSmoke requires -AuthToken or STOCKVISION_AUTH_TOKEN' }

  $Base = $ApiBase.TrimEnd('/')
  $Health = Invoke-RestMethod -Method GET -Uri "$Base/api/health"
  if ($Health.status -ne 'ok') {
    throw "worker health failed: $($Health | ConvertTo-Json -Compress)"
  }

  $Headers = @{ Authorization = "Bearer $AuthToken" }
  $Gate = Invoke-RestMethod -Method GET -Uri "$Base/api/admin/gate/predeploy?live=1" -Headers $Headers
  if ($Gate.decision -eq 'BLOCK') {
    throw "live predeploy gate blocked: $($Gate | ConvertTo-Json -Compress -Depth 6)"
  }
  Write-Host "[P9 gate] live smoke passed decision=$($Gate.decision) status=$($Gate.status)"
}

Write-Host '[P9 gate] local checks passed'
