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
  src/lib/adminCronCallbackRoutes.test.ts `
  src/lib/adminGateRoutes.test.ts `
  src/lib/dataQualityMonitor.test.ts `
  src/lib/deployGate.test.ts `
  src/lib/p6DataQualityUiContract.test.ts `
  src/lib/p9DeploymentContract.test.ts `
  src/lib/p9GateScriptContract.test.ts `
  src/lib/paperIntradayData.test.ts `
  src/lib/paperTradeMath.test.ts `
  src/lib/repoOwnerContract.test.ts `
  src/lib/schedulerOwnerContract.test.ts `
  src/lib/screenerOwnerContract.test.ts `
  src/lib/screenerSeedQuality.test.ts `
  src/lib/technicalIndicators.test.ts
if ($LASTEXITCODE -ne 0) { throw "worker contract test compile failed" }
node .tmp-test-run/lib/adminCronCallbackRoutes.test.js
if ($LASTEXITCODE -ne 0) { throw "adminCronCallbackRoutes.test failed" }
node .tmp-test-run/lib/adminGateRoutes.test.js
if ($LASTEXITCODE -ne 0) { throw "adminGateRoutes.test failed" }
node .tmp-test-run/lib/dataQualityMonitor.test.js
if ($LASTEXITCODE -ne 0) { throw "dataQualityMonitor.test failed" }
node .tmp-test-run/lib/deployGate.test.js
if ($LASTEXITCODE -ne 0) { throw "deployGate.test failed" }
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
node .tmp-test-run/lib/repoOwnerContract.test.js
if ($LASTEXITCODE -ne 0) { throw "repoOwnerContract.test failed" }
node .tmp-test-run/lib/schedulerOwnerContract.test.js
if ($LASTEXITCODE -ne 0) { throw "schedulerOwnerContract.test failed" }
node .tmp-test-run/lib/screenerOwnerContract.test.js
if ($LASTEXITCODE -ne 0) { throw "screenerOwnerContract.test failed" }
node .tmp-test-run/lib/screenerSeedQuality.test.js
if ($LASTEXITCODE -ne 0) { throw "screenerSeedQuality.test failed" }
node .tmp-test-run/lib/technicalIndicators.test.js
if ($LASTEXITCODE -ne 0) { throw "technicalIndicators.test failed" }
if (Test-Path $TestOut) {
  Remove-Item -LiteralPath $TestOut -Recurse -Force
}
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
