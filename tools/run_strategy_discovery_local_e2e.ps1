param(
  [string]$PersistName = "strategy-discovery-e2e-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))",
  [switch]$RealModels,
  [Nullable[int]]$ExternalReservedNeurons,
  [switch]$Resume,
  [string]$ResumeRunId,
  [string]$ResumeIdempotencyKey
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$worker = Join-Path $repo 'worker'
$persist = Join-Path $repo ".tmp\$PersistName"
if (-not $persist.StartsWith((Join-Path $repo '.tmp'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Persist path escaped repo .tmp' }
if ($Resume) {
  if (-not $RealModels) { throw 'Resume is supported only for the real-model E2E.' }
  if (-not (Test-Path $persist)) { throw "Resume persist path does not exist: $persist" }
  if (-not $ResumeRunId -or -not $ResumeIdempotencyKey) { throw 'Resume requires -ResumeRunId and -ResumeIdempotencyKey.' }
} elseif (Test-Path $persist) { throw "Persist path already exists: $persist" }
if ($RealModels -and $null -eq $ExternalReservedNeurons) { throw 'RealModels requires explicit -ExternalReservedNeurons from verified account usage.' }
$env:WRANGLER_LOG_PATH = Join-Path $persist 'wrangler-logs'

if ($Resume) {
  # A previous local server can be terminated while Miniflare still persists
  # its Workflow instance as `running`. Preserve that runtime evidence, but do
  # not let the orphan resume concurrently with the new checkpoint attempt.
  $workflowState = Join-Path $persist 'v3\workflows'
  if (Test-Path -LiteralPath $workflowState) {
    $evidenceRoot = Join-Path $persist 'workflow-evidence'
    New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
    $archiveName = "$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
    $archive = Join-Path $evidenceRoot $archiveName
    Move-Item -LiteralPath $workflowState -Destination $archive
    Write-Output "Archived prior local Workflow state: $archive"
  }
}

Push-Location $worker
try {
  if (-not $Resume) {
    & npx.cmd wrangler@4 d1 execute stockvision-db --local --persist-to $persist --file migration_strategy_discovery_lab_2026_07_11.sql
    if ($LASTEXITCODE) { throw 'Lab migration failed' }
    & npx.cmd wrangler@4 d1 execute stockvision-db --local --persist-to $persist --file test-fixtures\strategy-discovery-source-fixture.sql
    if ($LASTEXITCODE) { throw 'Source fixture seed failed' }
  }

  $arguments = @('wrangler@4','dev','--ip','127.0.0.1','--port','8799','--persist-to',$persist,
    '--var','ENVIRONMENT:local','--var','LOCAL_AUTH_BYPASS:1',
    '--var',"STRATEGY_DISCOVERY_FIXTURE_MODE:$($(if($RealModels){'0'}else{'1'}))")
  # `--local` disables every remote binding. Omit it for the real-model path so
  # Wrangler honors `[ai] remote = true` while D1/R2/KV remain locally persisted.
  if (-not $RealModels) { $arguments += '--local' }
  if ($RealModels) {
    $arguments += @('--var','STRATEGY_DISCOVERY_REQUIRE_EXTERNAL_USAGE_RESERVATION:1','--var',"STRATEGY_DISCOVERY_EXTERNAL_RESERVED_NEURONS:$ExternalReservedNeurons")
  }
  $stdout = Join-Path $persist $(if ($Resume) { 'wrangler.resume.out.log' } else { 'wrangler.out.log' })
  $stderr = Join-Path $persist $(if ($Resume) { 'wrangler.resume.err.log' } else { 'wrangler.err.log' })
  $pathValue = $env:Path
  [Environment]::SetEnvironmentVariable('PATH', $null, 'Process')
  [Environment]::SetEnvironmentVariable('Path', $pathValue, 'Process')
  $escapedArguments = $arguments | ForEach-Object { "'$($_.Replace("'", "''"))'" }
  $command = "& 'C:\Program Files\nodejs\npx.cmd' $($escapedArguments -join ' ')"
  $server = Start-Process -FilePath 'C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe' -ArgumentList @('-NoProfile','-Command',$command) -WorkingDirectory $worker -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  try {
    $ready = $false
    for ($i=0; $i -lt 120; $i++) {
      # `/api/health` is intentionally behind the mounted Strategy Discovery
      # admin middleware. Local `/api/auth/me` is the authoritative no-secret
      # readiness probe and exercises the localhost-only auth bypass.
      try { if ((Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8799/api/auth/me' -TimeoutSec 1).StatusCode -eq 200) { $ready = $true; break } } catch {}
      Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw "Wrangler did not become ready. $(Get-Content $stderr -Raw -ErrorAction SilentlyContinue)" }
    $test = if ($RealModels) { 'src/lib/strategyDiscoveryRealModelE2E.test.ts' } else { 'src/lib/strategyDiscoveryLocalE2E.test.ts' }
    $deadlineMinutes = if ($RealModels) { '20' } else { '8' }
    if ($Resume) {
      & .\node_modules\.bin\tsx.cmd $test 'http://127.0.0.1:8799/api' $deadlineMinutes $ResumeIdempotencyKey $ResumeRunId
    } else {
      & .\node_modules\.bin\tsx.cmd $test 'http://127.0.0.1:8799/api' $deadlineMinutes
    }
    if ($LASTEXITCODE) { throw "$test failed" }
  } finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
    try {
      Get-CimInstance Win32_Process -ErrorAction Stop |
        Where-Object { $_.CommandLine -like "*$persist*" -and $_.ProcessId -ne $PID } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch {
      # The direct Start-Process handle above is authoritative. CIM is only an
      # orphan cleanup fallback and may be unavailable in restricted shells.
    }
  }
} finally { Pop-Location }

Write-Output "Strategy Discovery local E2E PASS. Persisted evidence: $persist"
