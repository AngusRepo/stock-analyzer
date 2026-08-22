function Get-SchedulerOptionalValue {
  param(
    [Parameter(Mandatory = $true)][object]$Object,
    [Parameter(Mandatory = $true)][string]$Name,
    [AllowNull()][object]$Default = $null
  )
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return $Default }
  return $property.Value
}

function ConvertTo-SchedulerHeaderMap {
  param([AllowNull()][object]$HeaderObject)
  $map = @{}
  if ($null -eq $HeaderObject) { return $map }
  if ($HeaderObject -is [System.Collections.IDictionary]) {
    foreach ($key in $HeaderObject.Keys) {
      $map[[string]$key] = [string]$HeaderObject[$key]
    }
    return $map
  }
  foreach ($property in $HeaderObject.PSObject.Properties) {
    $map[[string]$property.Name] = [string]$property.Value
  }
  return $map
}

function Get-SchedulerResourceName([string]$Id) {
  if ($Id -notmatch '^[a-z][a-z0-9-]{0,499}$') { throw 'rotation_scheduler_invalid_id' }
  return "projects/$Project/locations/$Location/jobs/$Id"
}

function Get-SchedulerDefinitionHeaders([object]$Definition, [string]$Token) {
  if ([string]::IsNullOrWhiteSpace($Token)) { throw 'rotation_scheduler_token_empty' }
  $headers = @{ Authorization = "Bearer $Token" }
  $custom = Get-SchedulerOptionalValue -Object $Definition -Name 'headers'
  if ($null -eq $custom) { return $headers }
  foreach ($property in $custom.PSObject.Properties) {
    $name = [string]$property.Name
    $value = [string]$property.Value
    $lower = $name.ToLowerInvariant()
    if ($name -notmatch '^[A-Za-z0-9-]+$' -or
        $lower -in @('authorization', 'host', 'user-agent', 'content-length') -or
        $lower.StartsWith('x-google-') -or
        $lower.StartsWith('x-appengine-') -or
        $lower.StartsWith('x-cloudscheduler-') -or
        $value.Contains("`r") -or $value.Contains("`n")) {
      throw "rotation_scheduler_manifest_invalid_header:$([string]$Definition.id)"
    }
    $headers[$name] = $value
  }
  return $headers
}

function Assert-SchedulerDuration([string]$Value, [string]$Field, [string]$Id) {
  if ($Value -notmatch '^[0-9]+(?:\.[0-9]{1,9})?s$') {
    throw "rotation_scheduler_manifest_invalid_duration:$Id`:$Field"
  }
}

function New-SchedulerDesiredJob {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][object]$Definition,
    [Parameter(Mandatory = $true)][string]$Token
  )
  $id = [string]$Definition.id
  $name = Get-SchedulerResourceName -Id $id
  $task = [string](Get-SchedulerOptionalValue -Object $Definition -Name 'task' -Default '')
  $uriPath = [string](Get-SchedulerOptionalValue -Object $Definition -Name 'uriPath' -Default '')
  if (-not $uriPath) { $uriPath = "/api/admin/trigger/$task" }
  if (-not $task -or -not $uriPath.StartsWith('/api/admin/', [System.StringComparison]::Ordinal) -or
      $uriPath.Contains("`r") -or $uriPath.Contains("`n") -or $uriPath.Contains('?') -or $uriPath.Contains('#')) {
    throw "rotation_scheduler_manifest_invalid_uri_path:$id"
  }
  $uri = $WorkerBaseUrl.TrimEnd('/') + $uriPath
  $query = [string](Get-SchedulerOptionalValue -Object $Definition -Name 'query' -Default '')
  if ($query) {
    if ($query.Contains("`r") -or $query.Contains("`n") -or $query.Contains('#')) {
      throw "rotation_scheduler_manifest_invalid_query:$id"
    }
    $uri = "$uri`?$query"
  }
  if ($uri.Length -gt 2083 -or -not [uri]::IsWellFormedUriString($uri, [System.UriKind]::Absolute)) {
    throw "rotation_scheduler_manifest_invalid_uri:$id"
  }

  $schedule = [string](Get-SchedulerOptionalValue -Object $Definition -Name 'schedule' -Default '')
  $timeZone = [string](Get-SchedulerOptionalValue -Object $Definition -Name 'timeZone' -Default ([string]$Manifest.timeZone))
  $description = [string](Get-SchedulerOptionalValue -Object $Definition -Name 'description' -Default '')
  if (-not $schedule -or $schedule.Contains("`r") -or $schedule.Contains("`n")) {
    throw "rotation_scheduler_manifest_invalid_schedule:$id"
  }
  if (-not $timeZone -or $timeZone -notmatch '^[A-Za-z0-9_+\-/]+$') {
    throw "rotation_scheduler_manifest_invalid_time_zone:$id"
  }
  if ($description.Length -gt 500) { throw "rotation_scheduler_manifest_invalid_description:$id" }

  $attemptDeadline = [string](Get-SchedulerOptionalValue -Object $Definition -Name 'attemptDeadline' -Default '300s')
  Assert-SchedulerDuration -Value $attemptDeadline -Field 'attemptDeadline' -Id $id
  $deadlineSeconds = [double]$attemptDeadline.TrimEnd('s')
  if ($deadlineSeconds -lt 15 -or $deadlineSeconds -gt 1800) {
    throw "rotation_scheduler_manifest_invalid_attempt_deadline:$id"
  }

  $body = [ordered]@{
    name = $name
    description = $description
    schedule = $schedule
    timeZone = $timeZone
    attemptDeadline = $attemptDeadline
    httpTarget = [ordered]@{
      uri = $uri
      httpMethod = 'POST'
      headers = Get-SchedulerDefinitionHeaders -Definition $Definition -Token $Token
    }
  }

  $retry = [ordered]@{}
  $retryCountValue = Get-SchedulerOptionalValue -Object $Definition -Name 'maxRetryAttempts'
  if ($null -ne $retryCountValue -and [string]$retryCountValue -ne '') {
    $retryCount = 0
    if (-not [int]::TryParse([string]$retryCountValue, [ref]$retryCount) -or $retryCount -lt 0 -or $retryCount -gt 5) {
      throw "rotation_scheduler_manifest_invalid_retry_count:$id"
    }
    $retry.retryCount = $retryCount
  }
  foreach ($mapping in @(
    @('maxRetryDuration', 'maxRetryDuration'),
    @('minBackoff', 'minBackoffDuration'),
    @('maxBackoff', 'maxBackoffDuration')
  )) {
    $value = [string](Get-SchedulerOptionalValue -Object $Definition -Name $mapping[0] -Default '')
    if ($value) {
      Assert-SchedulerDuration -Value $value -Field $mapping[0] -Id $id
      $retry[$mapping[1]] = $value
    }
  }
  if ($retry.Count -gt 0) { $body.retryConfig = $retry }
  return $body
}

function Get-SchedulerLiveJobs([string]$AccessToken) {
  $jobs = @{}
  $prefix = "projects/$Project/locations/$Location/jobs/"
  $pageToken = ''
  do {
    $uri = "https://cloudscheduler.googleapis.com/v1/projects/$Project/locations/$Location/jobs?pageSize=500"
    if ($pageToken) { $uri += '&pageToken=' + [uri]::EscapeDataString($pageToken) }
    $response = Invoke-GoogleJson -Method GET -Uri $uri -AccessToken $AccessToken -Operation 'scheduler_list_inventory'
    $responseJobs = @()
    if ($response.PSObject.Properties['jobs']) { $responseJobs = @($response.jobs) }
    foreach ($job in $responseJobs) {
      $name = [string]$job.name
      if (-not $name.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
        throw 'rotation_scheduler_inventory_invalid_resource_name'
      }
      $id = $name.Substring($prefix.Length)
      if ($id -notmatch '^[a-z][a-z0-9-]{0,499}$' -or $jobs.ContainsKey($id)) {
        throw 'rotation_scheduler_inventory_invalid_or_duplicate_id'
      }
      $jobs[$id] = $job
    }
    $pageToken = ''
    if ($response.PSObject.Properties['nextPageToken']) { $pageToken = [string]$response.nextPageToken }
  } while ($pageToken)
  return $jobs
}

function Assert-SchedulerJobParity {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][object]$Actual,
    [Parameter(Mandatory = $true)][object]$Desired
  )
  if ([string]$Actual.name -ne [string]$Desired.name) { throw "rotation_scheduler_name_mismatch:$Id" }
  if ([string]$Actual.schedule -ne [string]$Desired.schedule) { throw "rotation_scheduler_schedule_mismatch:$Id" }
  if ([string]$Actual.timeZone -ne [string]$Desired.timeZone) { throw "rotation_scheduler_time_zone_mismatch:$Id" }
  if ([string]$Actual.description -ne [string]$Desired.description) { throw "rotation_scheduler_description_mismatch:$Id" }
  if ([string]$Actual.attemptDeadline -ne [string]$Desired.attemptDeadline) { throw "rotation_scheduler_attempt_deadline_mismatch:$Id" }
  if ([string]$Actual.httpTarget.uri -ne [string]$Desired.httpTarget.uri) { throw "rotation_scheduler_uri_mismatch:$Id" }
  if ([string]$Actual.httpTarget.httpMethod -ne 'POST') { throw "rotation_scheduler_http_method_mismatch:$Id" }
  foreach ($field in @('body', 'oauthToken', 'oidcToken')) {
    $property = $Actual.httpTarget.PSObject.Properties[$field]
    if ($null -ne $property -and $null -ne $property.Value -and [string]$property.Value -ne '') {
      throw "rotation_scheduler_unexpected_http_target_field:$Id`:$field"
    }
  }
  $actualHeaders = ConvertTo-SchedulerHeaderMap -HeaderObject $Actual.httpTarget.headers
  [void]$actualHeaders.Remove('User-Agent')
  $desiredHeaders = ConvertTo-SchedulerHeaderMap -HeaderObject $Desired.httpTarget.headers
  if ($actualHeaders.Count -ne $desiredHeaders.Count) { throw "rotation_scheduler_header_set_mismatch:$Id" }
  foreach ($name in $desiredHeaders.Keys) {
    if (-not $actualHeaders.ContainsKey($name)) { throw "rotation_scheduler_header_missing:$Id`:$name" }
    if ([string]$actualHeaders[$name] -ne [string]$desiredHeaders[$name]) {
      throw "rotation_scheduler_header_value_mismatch:$Id`:$name"
    }
  }
}

function Test-SchedulerJobParity {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][object]$Actual,
    [Parameter(Mandatory = $true)][object]$Desired
  )
  try { Assert-SchedulerJobParity -Id $Id -Actual $Actual -Desired $Desired; return $true }
  catch { return $false }
}

function ConvertTo-SchedulerRollbackJob([object]$Job) {
  $headers = ConvertTo-SchedulerHeaderMap -HeaderObject $Job.httpTarget.headers
  [void]$headers.Remove('User-Agent')
  $httpTarget = [ordered]@{
    uri = [string]$Job.httpTarget.uri
    httpMethod = [string]$Job.httpTarget.httpMethod
    headers = $headers
  }
  foreach ($field in @('body', 'oauthToken', 'oidcToken')) {
    $property = $Job.httpTarget.PSObject.Properties[$field]
    if ($null -ne $property -and $null -ne $property.Value -and [string]$property.Value -ne '') {
      $httpTarget[$field] = $property.Value
    }
  }
  $body = [ordered]@{
    name = [string]$Job.name
    description = [string]$Job.description
    schedule = [string]$Job.schedule
    timeZone = [string]$Job.timeZone
    attemptDeadline = [string]$Job.attemptDeadline
    httpTarget = $httpTarget
  }
  $retryProperty = $Job.PSObject.Properties['retryConfig']
  if ($null -ne $retryProperty -and $null -ne $retryProperty.Value) {
    $body.retryConfig = $retryProperty.Value
  }
  return $body
}

function New-SchedulerInventoryPlan {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][string]$AccessToken,
    [Parameter(Mandatory = $true)][string]$ExpectedToken,
    [switch]$LogPlan
  )
  $liveJobs = Get-SchedulerLiveJobs -AccessToken $AccessToken
  $missing = [System.Collections.Generic.List[string]]::new()
  $existing = [System.Collections.Generic.List[string]]::new()
  $drift = [System.Collections.Generic.List[string]]::new()
  $rollbackById = @{}
  foreach ($definition in @($Manifest.jobs)) {
    $id = [string]$definition.id
    $desired = New-SchedulerDesiredJob -Manifest $Manifest -Definition $definition -Token $ExpectedToken
    if ($liveJobs.ContainsKey($id)) {
      [void]$existing.Add($id)
      if (-not (Test-SchedulerJobParity -Id $id -Actual $liveJobs[$id] -Desired $desired)) {
        [void]$drift.Add($id)
      }
      $rollbackById[$id] = ConvertTo-SchedulerRollbackJob -Job $liveJobs[$id]
    } else {
      [void]$missing.Add($id)
    }
  }
  $missingIds = @($missing | Sort-Object)
  $existingIds = @($existing | Sort-Object)
  $driftIds = @($drift | Sort-Object)
  if (($missingIds.Count + $existingIds.Count) -ne $ExpectedSchedulerCount) {
    throw 'rotation_scheduler_inventory_accounting_mismatch'
  }
  if ($LogPlan) {
    $missingText = if ($missingIds.Count -gt 0) { [string]::Join(',', $missingIds) } else { 'none' }
    $driftText = if ($driftIds.Count -gt 0) { [string]::Join(',', $driftIds) } else { 'none' }
    Write-RotationLog "scheduler_inventory existing=$($existingIds.Count) planned_create=$($missingIds.Count) expected=$ExpectedSchedulerCount"
    Write-RotationLog "scheduler_planned_create ids=$missingText"
    Write-RotationLog "scheduler_planned_patch_drift ids=$driftText"
  }
  return [pscustomobject]@{
    MissingIds = $missingIds
    ExistingIds = $existingIds
    DriftIds = $driftIds
    RollbackById = $rollbackById
  }
}

function Assert-SchedulerCreatePlanAllowed {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][object]$Plan,
    [Parameter(Mandatory = $true)][string[]]$AllowedCreateIds
  )
  $manifestIds = [System.Collections.Generic.HashSet[string]]::new(
    [string[]]@($Manifest.jobs | ForEach-Object { [string]$_.id })
  )
  $allowed = [System.Collections.Generic.HashSet[string]]::new()
  foreach ($idValue in @($AllowedCreateIds)) {
    $id = [string]$idValue
    if ($id -notmatch '^[a-z][a-z0-9-]{0,499}$' -or -not $allowed.Add($id)) {
      throw 'rotation_scheduler_allowed_create_invalid_or_duplicate_id'
    }
    if (-not $manifestIds.Contains($id)) { throw "rotation_scheduler_allowed_create_not_in_manifest:$id" }
  }
  foreach ($id in @($Plan.MissingIds)) {
    if (-not $allowed.Contains([string]$id)) { throw "rotation_scheduler_create_not_allowed:$id" }
  }
}

function Assert-SchedulerPlanBaseline {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][object]$Plan,
    [Parameter(Mandatory = $true)][string]$AccessToken
  )
  $liveJobs = Get-SchedulerLiveJobs -AccessToken $AccessToken
  $actualMissing = @(
    @($Manifest.jobs) |
      ForEach-Object { [string]$_.id } |
      Where-Object { -not $liveJobs.ContainsKey($_) } |
      Sort-Object
  )
  $expected = @($Plan.MissingIds | Sort-Object)
  if ([string]::Join(',', $actualMissing) -ne [string]::Join(',', $expected)) {
    throw "rotation_scheduler_inventory_drift:expected_missing=$([string]::Join(',', $expected))`:actual_missing=$([string]::Join(',', $actualMissing))"
  }
  foreach ($id in @($Plan.ExistingIds)) {
    if (-not $liveJobs.ContainsKey($id)) { throw "rotation_scheduler_inventory_drift:missing_existing:$id" }
    if (-not $Plan.RollbackById.ContainsKey($id)) { throw "rotation_scheduler_rollback_snapshot_missing:$id" }
    if (-not (Test-SchedulerJobParity -Id $id -Actual $liveJobs[$id] -Desired $Plan.RollbackById[$id])) {
      throw "rotation_scheduler_inventory_drift:changed_existing:$id"
    }
  }
  return $liveJobs
}

function Invoke-SchedulerPatchBody {
  param(
    [Parameter(Mandatory = $true)][object]$Body,
    [Parameter(Mandatory = $true)][string]$AccessToken,
    [Parameter(Mandatory = $true)][string]$Operation
  )
  $name = [string]$Body.name
  $prefix = "projects/$Project/locations/$Location/jobs/"
  if (-not $name.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
    throw 'rotation_scheduler_patch_invalid_name'
  }
  $fields = [System.Collections.Generic.List[string]]::new()
  foreach ($field in @('description', 'schedule', 'timeZone', 'httpTarget', 'attemptDeadline')) { [void]$fields.Add($field) }
  if ($Body.Contains('retryConfig')) { [void]$fields.Add('retryConfig') }
  $mask = [uri]::EscapeDataString([string]::Join(',', $fields))
  $uri = "https://cloudscheduler.googleapis.com/v1/$name`?updateMask=$mask"
  [void](Invoke-GoogleJson -Method PATCH -Uri $uri -AccessToken $AccessToken -Body $Body -Operation $Operation)
}

function Invoke-SchedulerCreateBody {
  param(
    [Parameter(Mandatory = $true)][object]$Body,
    [Parameter(Mandatory = $true)][string]$AccessToken,
    [Parameter(Mandatory = $true)][string]$Operation
  )
  $uri = "https://cloudscheduler.googleapis.com/v1/projects/$Project/locations/$Location/jobs"
  [void](Invoke-GoogleJson -Method POST -Uri $uri -AccessToken $AccessToken -Body $Body -Operation $Operation)
}

function Invoke-SchedulerDeleteJob {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][string]$AccessToken
  )
  $name = Get-SchedulerResourceName -Id $Id
  [void](Invoke-GoogleJson -Method DELETE -Uri "https://cloudscheduler.googleapis.com/v1/$name" -AccessToken $AccessToken -Operation "scheduler_rollback_delete:$Id")
}

function New-SchedulerSyncState {
  return [pscustomobject]@{
    CreateAttemptedIds = [System.Collections.Generic.List[string]]::new()
    PatchAttemptedIds = [System.Collections.Generic.List[string]]::new()
  }
}

function Sync-SchedulerInventory {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][object]$Plan,
    [Parameter(Mandatory = $true)][object]$State,
    [Parameter(Mandatory = $true)][string]$AccessToken,
    [Parameter(Mandatory = $true)][string]$Token
  )
  [void](Assert-SchedulerPlanBaseline -Manifest $Manifest -Plan $Plan -AccessToken $AccessToken)
  $missingSet = [System.Collections.Generic.HashSet[string]]::new([string[]]@($Plan.MissingIds))
  foreach ($definition in @($Manifest.jobs)) {
    $id = [string]$definition.id
    $desired = New-SchedulerDesiredJob -Manifest $Manifest -Definition $definition -Token $Token
    if ($missingSet.Contains($id)) {
      [void]$State.CreateAttemptedIds.Add($id)
      Invoke-SchedulerCreateBody -Body $desired -AccessToken $AccessToken -Operation "scheduler_create:$id"
    } else {
      [void]$State.PatchAttemptedIds.Add($id)
      Invoke-SchedulerPatchBody -Body $desired -AccessToken $AccessToken -Operation "scheduler_patch:$id"
    }
  }
  Assert-SchedulerState -Manifest $Manifest -AccessToken $AccessToken -ExpectedToken $Token
  Write-RotationLog "scheduler_sync parity=$ExpectedSchedulerCount/$ExpectedSchedulerCount created=$($Plan.MissingIds.Count) patched=$($Plan.ExistingIds.Count)"
}

function Restore-SchedulerInventory {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][object]$Plan,
    [Parameter(Mandatory = $true)][object]$State,
    [Parameter(Mandatory = $true)][string]$AccessToken,
    [Parameter(Mandatory = $true)][string]$AppliedToken,
    [Parameter(Mandatory = $true)][string]$OriginalToken
  )
  $liveJobs = Get-SchedulerLiveJobs -AccessToken $AccessToken
  $patchIds = [System.Collections.Generic.List[string]]::new()
  $deleteIds = [System.Collections.Generic.List[string]]::new()

  foreach ($id in @($State.PatchAttemptedIds)) {
    if (-not $Plan.RollbackById.ContainsKey($id)) { throw "rotation_scheduler_rollback_snapshot_missing:$id" }
    if (-not $liveJobs.ContainsKey($id)) { throw "rotation_scheduler_rollback_conflict:missing_patched:$id" }
    $original = $Plan.RollbackById[$id]
    if (Test-SchedulerJobParity -Id $id -Actual $liveJobs[$id] -Desired $original) { continue }
    $definition = @($Manifest.jobs | Where-Object { [string]$_.id -eq $id })
    if ($definition.Count -ne 1) { throw "rotation_scheduler_rollback_definition_missing:$id" }
    $appliedDesired = New-SchedulerDesiredJob -Manifest $Manifest -Definition $definition[0] -Token $AppliedToken
    if (-not (Test-SchedulerJobParity -Id $id -Actual $liveJobs[$id] -Desired $appliedDesired)) {
      throw "rotation_scheduler_rollback_conflict:changed_patched:$id"
    }
    [void]$patchIds.Add($id)
  }

  foreach ($id in @($State.CreateAttemptedIds)) {
    if (-not $liveJobs.ContainsKey($id)) { continue }
    $definition = @($Manifest.jobs | Where-Object { [string]$_.id -eq $id })
    if ($definition.Count -ne 1) { throw "rotation_scheduler_rollback_definition_missing:$id" }
    $appliedDesired = New-SchedulerDesiredJob -Manifest $Manifest -Definition $definition[0] -Token $AppliedToken
    if (-not (Test-SchedulerJobParity -Id $id -Actual $liveJobs[$id] -Desired $appliedDesired)) {
      throw "rotation_scheduler_rollback_conflict:changed_created:$id"
    }
    [void]$deleteIds.Add($id)
  }

  foreach ($id in @($patchIds)) {
    Invoke-SchedulerPatchBody -Body $Plan.RollbackById[$id] -AccessToken $AccessToken -Operation "scheduler_rollback_patch:$id"
  }
  foreach ($id in @($deleteIds)) {
    Invoke-SchedulerDeleteJob -Id $id -AccessToken $AccessToken
  }

  $restored = New-SchedulerInventoryPlan -Manifest $Manifest -AccessToken $AccessToken -ExpectedToken $OriginalToken
  if ([string]::Join(',', @($restored.MissingIds)) -ne [string]::Join(',', @($Plan.MissingIds))) {
    throw 'rotation_scheduler_rollback_inventory_mismatch'
  }
  if ([string]::Join(',', @($restored.DriftIds)) -ne [string]::Join(',', @($Plan.DriftIds))) {
    throw 'rotation_scheduler_rollback_drift_mismatch'
  }
}

function Assert-SchedulerState([object]$Manifest, [string]$AccessToken, [string]$ExpectedToken) {
  $plan = New-SchedulerInventoryPlan -Manifest $Manifest -AccessToken $AccessToken -ExpectedToken $ExpectedToken
  if ($plan.MissingIds.Count -gt 0) {
    throw "rotation_scheduler_inventory_missing:$([string]::Join(',', @($plan.MissingIds)))"
  }
  if ($plan.ExistingIds.Count -ne $ExpectedSchedulerCount) {
    throw "rotation_scheduler_inventory_count_mismatch:expected=$ExpectedSchedulerCount`:actual=$($plan.ExistingIds.Count)"
  }
  if ($plan.DriftIds.Count -gt 0) {
    throw "rotation_scheduler_inventory_parity_drift:$([string]::Join(',', @($plan.DriftIds)))"
  }
}
