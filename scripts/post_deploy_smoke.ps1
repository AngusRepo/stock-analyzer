param(
  [Parameter(Mandatory = $true)]
  [string]$WorkerUrl,

  [Parameter(Mandatory = $true)]
  [string]$ControllerUrl,

  [string]$WorkerToken = $env:STOCKVISION_AUTH_TOKEN,
  [string]$ControllerToken = $env:ML_CONTROLLER_TOKEN,
  [string]$Date = (Get-Date -Format 'yyyy-MM-dd'),
  [switch]$RunTriggers,
  [switch]$WaitCallback,
  [int]$CallbackTimeoutSec = 900
)

$ErrorActionPreference = 'Stop'

function Invoke-Json {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Url,
    [hashtable]$Headers = @{},
    [object]$Body = $null,
    [int]$TimeoutSec = 60
  )

  $params = @{
    Method = $Method
    Uri = $Url
    Headers = $Headers
    TimeoutSec = $TimeoutSec
  }
  if ($null -ne $Body) {
    $params.ContentType = 'application/json'
    $params.Body = ($Body | ConvertTo-Json -Depth 8)
  }
  Invoke-RestMethod @params
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) {
    throw $Message
  }
}

$workerBase = $WorkerUrl.TrimEnd('/')
$controllerBase = $ControllerUrl.TrimEnd('/')
$workerHeaders = @{}
$controllerHeaders = @{}
if ($WorkerToken) { $workerHeaders.Authorization = "Bearer $WorkerToken" }
if ($ControllerToken) { $controllerHeaders['X-Controller-Token'] = $ControllerToken }

Write-Host "== Post-deploy smoke =="
Write-Host "Worker     : $workerBase"
Write-Host "Controller : $controllerBase"

$workerHealth = Invoke-Json -Method GET -Url "$workerBase/api/health" -Headers $workerHeaders
Assert-True ($null -ne $workerHealth) 'Worker /api/health returned empty payload'
Write-Host "[OK] Worker /api/health"

$controllerHealth = Invoke-Json -Method GET -Url "$controllerBase/health" -Headers $controllerHeaders
Assert-True ($controllerHealth.status -eq 'ok') "Controller /health status is not ok: $($controllerHealth.status)"
Assert-True ([bool]$controllerHealth.callbackConfigured) 'Controller callbackConfigured=false'
Assert-True ([bool]$controllerHealth.pipelineJobConfigured) 'Controller pipelineJobConfigured=false'
Assert-True ([bool]$controllerHealth.verifyJobConfigured) 'Controller verifyJobConfigured=false'
Write-Host "[OK] Controller /health + callback/job config"

if (-not $RunTriggers) {
  Write-Host "[SKIP] Trigger smoke disabled. Add -RunTriggers to trigger pipeline/verify jobs."
  exit 0
}

$pipeline = Invoke-Json -Method POST -Url "$controllerBase/pipeline/v2/run?date=$Date" -Headers $controllerHeaders -TimeoutSec 120
Assert-True ($pipeline.status -eq 'triggered') "Pipeline trigger did not return triggered: $($pipeline | ConvertTo-Json -Depth 4)"
Write-Host "[OK] Pipeline trigger accepted: $($pipeline.run_id)"

$verify = Invoke-Json -Method POST -Url "$controllerBase/verify/run" -Headers $controllerHeaders -Body @{
  run_date = $Date
  lookback_days = 5
  limit = 200
  async_mode = $true
  callback_task = 'verify-v2'
} -TimeoutSec 120
Assert-True ($verify.status -eq 'triggered') "Verify trigger did not return triggered: $($verify | ConvertTo-Json -Depth 4)"
Write-Host "[OK] Verify trigger accepted: $($verify.run_id)"

if (-not $WaitCallback) {
  Write-Host "[SKIP] Callback wait disabled. Add -WaitCallback to poll /api/admin/cron-logs."
  exit 0
}

$deadline = (Get-Date).AddSeconds($CallbackTimeoutSec)
$seen = @{
  pipeline = $false
  'verify-v2' = $false
}

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 20
  $logs = Invoke-Json -Method GET -Url "$workerBase/api/admin/cron-logs?date=$Date" -Headers $workerHeaders -TimeoutSec 60
  $items = @($logs.logs)
  foreach ($item in $items) {
    if ($item.task -eq 'pipeline' -and $item.run_id -eq $pipeline.run_id -and $item.status -in @('success', 'error')) {
      $seen.pipeline = $true
    }
    if ($item.task -eq 'verify-v2' -and $item.run_id -eq $verify.run_id -and $item.status -in @('success', 'error')) {
      $seen['verify-v2'] = $true
    }
  }
  if ($seen.pipeline -and $seen['verify-v2']) {
    Write-Host "[OK] Callback logs landed for pipeline and verify-v2"
    exit 0
  }
}

throw "Timed out waiting for callback logs. pipeline=$($seen.pipeline) verify-v2=$($seen['verify-v2'])"
