param(
  [switch]$SkipFrontendBuild,
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
$TestOut = Join-Path (Get-Location) '.tmp-test-run'
if (Test-Path $TestOut) {
  $ResolvedTestOut = (Resolve-Path $TestOut).Path
  $ResolvedWorker = (Resolve-Path (Get-Location)).Path
  if (-not $ResolvedTestOut.StartsWith($ResolvedWorker)) {
    throw "Refusing to clean test output outside worker: $ResolvedTestOut"
  }
  Remove-Item -LiteralPath $ResolvedTestOut -Recurse -Force
}
npx tsc --target ES2020 --module commonjs --moduleResolution node --strict false --skipLibCheck --rootDir src --outDir .tmp-test-run --noEmit false `
  src/cf-types.d.ts `
  src/lib/adminTriggerObservabilityContract.test.ts `
  src/lib/adminCronCallbackRoutes.test.ts `
  src/lib/adminGateRoutes.test.ts `
  src/lib/boardTradability.test.ts `
  src/lib/dataQualityMonitor.test.ts `
  src/lib/deployGate.test.ts `
  src/lib/gaOptimizerPush.test.ts `
  src/lib/marketDataReadiness.test.ts `
  src/lib/p6DataQualityUiContract.test.ts `
  src/lib/p9DeploymentContract.test.ts `
  src/lib/p9GateScriptContract.test.ts `
  src/lib/paperIntradayData.test.ts `
  src/lib/paperTradeMath.test.ts `
  src/lib/predictionDateOwnerContract.test.ts `
  src/lib/researchEvaluationPlan.test.ts `
  src/lib/researchEvaluationRunner.test.ts `
  src/lib/researchExperimentRegistry.test.ts `
  src/lib/researchInternGate.test.ts `
  src/lib/repoOwnerContract.test.ts `
  src/lib/schedulerOwnerContract.test.ts `
  src/lib/screenerOwnerContract.test.ts `
  src/lib/screenerFunnelEvidence.test.ts `
  src/lib/screenerMarketDataLanes.test.ts `
  src/lib/screenerPolicy.test.ts `
  src/lib/screenerSeedQuality.test.ts `
  src/lib/screenerTradability.test.ts `
  src/lib/strategySpec.test.ts `
  src/lib/technicalIndicators.test.ts
if ($LASTEXITCODE -ne 0) { throw "worker contract test compile failed" }
node .tmp-test-run/lib/adminTriggerObservabilityContract.test.js
if ($LASTEXITCODE -ne 0) { throw "adminTriggerObservabilityContract.test failed" }
node .tmp-test-run/lib/adminCronCallbackRoutes.test.js
if ($LASTEXITCODE -ne 0) { throw "adminCronCallbackRoutes.test failed" }
node .tmp-test-run/lib/adminGateRoutes.test.js
if ($LASTEXITCODE -ne 0) { throw "adminGateRoutes.test failed" }
node .tmp-test-run/lib/boardTradability.test.js
if ($LASTEXITCODE -ne 0) { throw "boardTradability.test failed" }
node .tmp-test-run/lib/dataQualityMonitor.test.js
if ($LASTEXITCODE -ne 0) { throw "dataQualityMonitor.test failed" }
node .tmp-test-run/lib/deployGate.test.js
if ($LASTEXITCODE -ne 0) { throw "deployGate.test failed" }
node .tmp-test-run/lib/gaOptimizerPush.test.js
if ($LASTEXITCODE -ne 0) { throw "gaOptimizerPush.test failed" }
node .tmp-test-run/lib/marketDataReadiness.test.js
if ($LASTEXITCODE -ne 0) { throw "marketDataReadiness.test failed" }
node .tmp-test-run/lib/p6DataQualityUiContract.test.js
if ($LASTEXITCODE -ne 0) { throw "p6DataQualityUiContract.test failed" }
node .tmp-test-run/lib/p9DeploymentContract.test.js
if ($LASTEXITCODE -ne 0) { throw "p9DeploymentContract.test failed" }
node .tmp-test-run/lib/p9GateScriptContract.test.js
if ($LASTEXITCODE -ne 0) { throw "p9GateScriptContract.test failed" }
node .tmp-test-run/lib/paperIntradayData.test.js
if ($LASTEXITCODE -ne 0) { throw "paperIntradayData.test failed" }
node .tmp-test-run/lib/paperTradeMath.test.js
if ($LASTEXITCODE -ne 0) { throw "paperTradeMath.test failed" }
node .tmp-test-run/lib/predictionDateOwnerContract.test.js
if ($LASTEXITCODE -ne 0) { throw "predictionDateOwnerContract.test failed" }
node .tmp-test-run/lib/researchEvaluationPlan.test.js
if ($LASTEXITCODE -ne 0) { throw "researchEvaluationPlan.test failed" }
node .tmp-test-run/lib/researchEvaluationRunner.test.js
if ($LASTEXITCODE -ne 0) { throw "researchEvaluationRunner.test failed" }
node .tmp-test-run/lib/researchExperimentRegistry.test.js
if ($LASTEXITCODE -ne 0) { throw "researchExperimentRegistry.test failed" }
node .tmp-test-run/lib/researchInternGate.test.js
if ($LASTEXITCODE -ne 0) { throw "researchInternGate.test failed" }
node .tmp-test-run/lib/repoOwnerContract.test.js
if ($LASTEXITCODE -ne 0) { throw "repoOwnerContract.test failed" }
node .tmp-test-run/lib/schedulerOwnerContract.test.js
if ($LASTEXITCODE -ne 0) { throw "schedulerOwnerContract.test failed" }
node .tmp-test-run/lib/screenerOwnerContract.test.js
if ($LASTEXITCODE -ne 0) { throw "screenerOwnerContract.test failed" }
node .tmp-test-run/lib/screenerFunnelEvidence.test.js
if ($LASTEXITCODE -ne 0) { throw "screenerFunnelEvidence.test failed" }
node .tmp-test-run/lib/screenerMarketDataLanes.test.js
if ($LASTEXITCODE -ne 0) { throw "screenerMarketDataLanes.test failed" }
node .tmp-test-run/lib/screenerPolicy.test.js
if ($LASTEXITCODE -ne 0) { throw "screenerPolicy.test failed" }
node .tmp-test-run/lib/screenerSeedQuality.test.js
if ($LASTEXITCODE -ne 0) { throw "screenerSeedQuality.test failed" }
node .tmp-test-run/lib/screenerTradability.test.js
if ($LASTEXITCODE -ne 0) { throw "screenerTradability.test failed" }
node .tmp-test-run/lib/strategySpec.test.js
if ($LASTEXITCODE -ne 0) { throw "strategySpec.test failed" }
node .tmp-test-run/lib/technicalIndicators.test.js
if ($LASTEXITCODE -ne 0) { throw "technicalIndicators.test failed" }
if (Test-Path $TestOut) {
  Remove-Item -LiteralPath $TestOut -Recurse -Force
}
Pop-Location

Write-Host '[P9 gate] ml-controller contract tests'
$ControllerPython = Join-Path $Root 'ml-controller\.venv\Scripts\python.exe'
if (-not (Test-Path $ControllerPython)) {
  throw "ml-controller venv python not found: $ControllerPython"
}
Push-Location (Join-Path $Root 'ml-controller')
& $ControllerPython -m pytest tests\test_verify_pipeline_graph.py tests\test_p6_emerging_ml_contract.py tests\test_market_segment_policy.py tests\test_model_ic_tracker.py tests\test_train_serve_parity_contract.py tests\test_sector_flow_proxy.py -q
if ($LASTEXITCODE -ne 0) { throw "ml-controller contract tests failed" }
Pop-Location

if (-not $SkipFrontendBuild) {
  Write-Host '[P9 gate] frontend build'
  Push-Location (Join-Path $Root 'frontend')
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }
  Pop-Location
}

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
