param([string]$PersistName = "active13-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))")

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$worker = Join-Path $repo 'worker'
$persist = Join-Path $repo ".tmp\$PersistName"
New-Item -ItemType Directory -Path $persist -Force | Out-Null
$stdout = Join-Path $persist 'wrangler.out.log'
$stderr = Join-Path $persist 'wrangler.err.log'
$arguments = @('wrangler@4','dev','--config','wrangler.active13.toml','--ip','127.0.0.1','--port','8798')
$escapedArguments = $arguments | ForEach-Object { "'$($_.Replace("'", "''"))'" }
$command = "& 'C:\Program Files\nodejs\npx.cmd' $($escapedArguments -join ' ')"
$server = Start-Process -FilePath 'C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe' -ArgumentList @('-NoProfile','-Command',$command) -WorkingDirectory $worker -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
try {
  $ready = $false
  for ($i=0; $i -lt 120; $i++) {
    try { if ((Invoke-RestMethod 'http://127.0.0.1:8798/health' -TimeoutSec 1).ok) { $ready = $true; break } } catch {}
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw "active13 harness not ready: $(Get-Content $stderr -Raw -ErrorAction SilentlyContinue)" }
  $env:ACTIVE13_AI_BASE_URL = 'http://127.0.0.1:8798'
  $env:ACTIVE13_CHECKPOINT_PATH = Join-Path $persist 'checkpoint.json'
  $runnerOutput = & node (Join-Path $repo 'tools\run_active13_workers_ai_e2e.mjs') $repo 2>&1
  $runnerExit = $LASTEXITCODE
  $runnerOutput | ForEach-Object { Write-Output $_ }
  if ($runnerExit) { throw 'active13 runner failed' }
} finally {
  Remove-Item Env:ACTIVE13_AI_BASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:ACTIVE13_CHECKPOINT_PATH -ErrorAction SilentlyContinue
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
}
