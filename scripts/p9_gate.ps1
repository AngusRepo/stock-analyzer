param(
  [switch]$SkipFrontendBuild,
  [switch]$SkipBugHunter,
  [switch]$SkipFinLabBackfillJobGuard,
  [int]$BugHunterMaxAgeHours = 48,
  [switch]$LiveSmoke,
  [string]$ApiBase = $env:STOCKVISION_API_BASE,
  [string]$AuthToken = $env:STOCKVISION_AUTH_TOKEN,
  [string]$GcpRegion = $(if ($env:GCP_REGION) { $env:GCP_REGION } else { 'asia-east1' }),
  [string]$FinLabBackfillJobName = 'finlab-v4-backfill'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

function Resolve-GCloudCommand {
  $Cmd = Get-Command gcloud.cmd -ErrorAction SilentlyContinue
  if (-not $Cmd) {
    $Cmd = Get-Command gcloud -ErrorAction SilentlyContinue
  }
  return $Cmd
}

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
$WorkerTestSources = Get-ChildItem -Path (Join-Path (Get-Location) 'src\lib') -Filter '*.test.ts' |
  Sort-Object Name |
  ForEach-Object { "src/lib/$($_.Name)" }

$TscArgs = @(
  '--target', 'ES2022',
  '--module', 'commonjs',
  '--moduleResolution', 'node',
  '--lib', 'ES2022,WebWorker',
  '--esModuleInterop',
  '--allowSyntheticDefaultImports',
  '--strict', 'false',
  '--skipLibCheck',
  '--rootDir', 'src',
  '--outDir', '.tmp-test-run',
  '--noEmit', 'false',
  'src/cf-types.d.ts'
) + $WorkerTestSources

npx tsc @TscArgs
if ($LASTEXITCODE -ne 0) { throw "worker contract test compile failed" }
foreach ($testSource in $WorkerTestSources) {
  $testName = [System.IO.Path]::GetFileNameWithoutExtension($testSource)
  $testJs = Join-Path $TestOut (Join-Path 'lib' "$testName.js")
  node $testJs
  if ($LASTEXITCODE -ne 0) { throw "$testName failed" }
}
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
& $ControllerPython -m pytest tests\test_verify_pipeline_graph.py tests\test_p6_emerging_ml_contract.py tests\test_p7_model_upgrade_research_track.py tests\test_p8_adaptive_meta_contract.py tests\test_market_segment_policy.py tests\test_model_ic_tracker.py tests\test_train_serve_parity_contract.py tests\test_sector_flow_proxy.py tests\test_pipeline_callback_contract.py tests\test_retrain_followup_telemetry.py tests\test_admin_modal_deploy_staging.py -q
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

  if (-not $SkipFinLabBackfillJobGuard) {
    Write-Host '[P9 gate] FinLab backfill job guard'
    $GCloudCommand = Resolve-GCloudCommand
    if (-not $GCloudCommand) {
      throw 'FinLab backfill job guard requires gcloud. Use -SkipFinLabBackfillJobGuard only for non-GCP local smoke.'
    }
    $GuardScript = Join-Path $Root 'tools\finlab_backfill_job_guard.py'
    if (-not (Test-Path $GuardScript -PathType Leaf)) {
      throw "FinLab backfill job guard not found: $GuardScript"
    }
    $JobJson = & $GCloudCommand.Source run jobs describe $FinLabBackfillJobName --region=$GcpRegion --format=json
    if ($LASTEXITCODE -ne 0) {
      throw "gcloud run jobs describe failed for $FinLabBackfillJobName in $GcpRegion"
    }
    $JobJson | & $ControllerPython $GuardScript -
    if ($LASTEXITCODE -ne 0) {
      throw "FinLab backfill job guard failed for $FinLabBackfillJobName. Expected --write-d1 jobs to include --apply-canonical-d1."
    }
  }
  Write-Host "[P9 gate] live smoke passed decision=$($Gate.decision) status=$($Gate.status)"
}

Write-Host '[P9 gate] local checks passed'
