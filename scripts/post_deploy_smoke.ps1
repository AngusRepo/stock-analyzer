param(
  [Parameter(Mandatory = $true)]
  [string]$WorkerUrl,

  [Parameter(Mandatory = $true)]
  [string]$ControllerUrl,

  [string]$WorkerToken = $env:STOCKVISION_AUTH_TOKEN,
  [string]$ControllerToken = $env:ML_CONTROLLER_TOKEN,
  [string]$Date = (Get-Date -Format 'yyyy-MM-dd'),
  [switch]$SkipDeployGate,
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

function Wait-SchedulerCallback {
  param(
    [Parameter(Mandatory = $true)][string]$Task,
    [Parameter(Mandatory = $true)][string[]]$ExpectedIds,
    [Parameter(Mandatory = $true)][datetime]$Deadline
  )

  $expected = ($ExpectedIds | Where-Object { $_ } | ForEach-Object { [string]$_ })
  while ((Get-Date) -lt $Deadline) {
    Start-Sleep -Seconds 20
    $logs = Invoke-Json -Method GET -Url "$workerBase/api/admin/cron-logs?date=$Date" -Headers $workerHeaders -TimeoutSec 60
    $items = @($logs.logs)
    foreach ($item in $items) {
      $itemRunId = [string]$item.run_id
      if ($item.task -eq $Task -and $expected -contains $itemRunId -and $item.status -in @('success', 'error')) {
        if ($item.status -ne 'success') {
          throw "$Task callback landed with status=$($item.status): $($item | ConvertTo-Json -Compress -Depth 5)"
        }
        return $item
      }
    }
  }

  throw "Timed out waiting for $Task callback. expected=$($expected -join ',')"
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

if (-not $SkipDeployGate) {
  $deployGate = Invoke-Json -Method GET -Url "$workerBase/api/admin/gate/predeploy?live=1&date=$Date" -Headers $workerHeaders -TimeoutSec 120
  Assert-True ($null -ne $deployGate) 'Worker predeploy gate returned empty payload'
  if ($deployGate.decision -eq 'BLOCK') {
    throw "Worker predeploy gate blocked post-deploy smoke: $($deployGate | ConvertTo-Json -Compress -Depth 8)"
  }
  Write-Host "[OK] Worker predeploy gate decision=$($deployGate.decision) status=$($deployGate.status)"
} else {
  Write-Host "[SKIP] Worker predeploy gate disabled by -SkipDeployGate"
}

$computeProfiles = Invoke-Json -Method GET -Url "$workerBase/api/admin/compute-profiles?date=$Date&limit=5" -Headers $workerHeaders -TimeoutSec 60
Assert-True ($null -ne $computeProfiles) 'Worker compute profiles endpoint returned empty payload'
Assert-True ($null -ne $computeProfiles.profiles) 'Worker compute profiles endpoint missing profiles array'
Write-Host "[OK] Worker compute profiles readback legacy_columns=$($computeProfiles.legacy_columns) count=$(@($computeProfiles.profiles).Count)"

if (-not $RunTriggers) {
  Write-Host "[SKIP] Trigger smoke disabled. Add -RunTriggers to trigger pipeline/verify jobs."
  exit 0
}

$pipeline = Invoke-Json -Method POST -Url "$controllerBase/pipeline/v2/run?date=$Date" -Headers $controllerHeaders -TimeoutSec 120
Assert-True ($pipeline.status -eq 'triggered') "Pipeline trigger did not return triggered: $($pipeline | ConvertTo-Json -Depth 4)"
$pipelineIds = @($pipeline.run_id, $pipeline.execution_id) | Where-Object { $_ } | ForEach-Object { [string]$_ }
Write-Host "[OK] Pipeline trigger accepted: run_id=$($pipeline.run_id) execution_id=$($pipeline.execution_id)"

if ($WaitCallback) {
  $pipelineDeadline = (Get-Date).AddSeconds($CallbackTimeoutSec)
  $pipelineCallback = Wait-SchedulerCallback -Task 'pipeline' -ExpectedIds $pipelineIds -Deadline $pipelineDeadline
  Write-Host "[OK] Pipeline callback success: run_id=$($pipelineCallback.run_id)"
}

$verify = Invoke-Json -Method POST -Url "$controllerBase/verify/run" -Headers $controllerHeaders -Body @{
  run_date = $Date
  lookback_days = 5
  limit = 200
  async_mode = $true
  callback_task = 'verify-v2'
} -TimeoutSec 120
Assert-True ($verify.status -eq 'triggered') "Verify trigger did not return triggered: $($verify | ConvertTo-Json -Depth 4)"
$verifyIds = @($verify.run_id, $verify.execution_id) | Where-Object { $_ } | ForEach-Object { [string]$_ }
Write-Host "[OK] Verify trigger accepted: run_id=$($verify.run_id) execution_id=$($verify.execution_id)"

if (-not $WaitCallback) {
  Write-Host "[SKIP] Callback wait disabled. Add -WaitCallback to poll /api/admin/cron-logs."
  exit 0
}

$verifyDeadline = (Get-Date).AddSeconds($CallbackTimeoutSec)
$verifyCallback = Wait-SchedulerCallback -Task 'verify-v2' -ExpectedIds $verifyIds -Deadline $verifyDeadline
Write-Host "[OK] Verify callback success: run_id=$($verifyCallback.run_id)"
Write-Host "[OK] Callback logs landed for pipeline and verify-v2"
