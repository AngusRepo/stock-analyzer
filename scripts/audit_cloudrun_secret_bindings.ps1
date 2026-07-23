param(
  [string]$Region = 'asia-east1',
  [int]$ExecutionLimit = 1000,
  [switch]$SkipExecutions
)

$ErrorActionPreference = 'Stop'

$SecretEnvNames = @(
  'ANTHROPIC_API_KEY',
  'CF_API_TOKEN',
  'EXECUTION_GATEWAY_SERVICE_TOKEN',
  'FINLAB_API_KEY',
  'LIVE_EXECUTION_HMAC_SECRET',
  'PROXY_SERVICE_TOKEN',
  'SHIOAJI_ACCOUNT_ID',
  'SHIOAJI_API_KEY',
  'SHIOAJI_CERT_PASSWORD',
  'SHIOAJI_CERT_PERSON_ID',
  'SHIOAJI_PERSON_ID',
  'SHIOAJI_SECRET_KEY',
  'GEMINI_API_KEY',
  'GITHUB_TOKEN',
  'ML_CONTROLLER_SECRET',
  'ML_SERVICE_SECRET',
  'MODAL_TOKEN_ID',
  'MODAL_TOKEN_SECRET',
  'STOCKVISION_AUTH_TOKEN'
)

function Invoke-GcloudText([string[]]$Arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = @(& gcloud @Arguments 2>$null)
    if ($LASTEXITCODE -ne 0) {
      throw "gcloud failed: $($Arguments -join ' ')"
    }
    return [string]::Join("`n", $lines)
  } finally {
    $ErrorActionPreference = $previous
  }
}

function ConvertFrom-GcloudJson([string[]]$Arguments) {
  $raw = Invoke-GcloudText -Arguments $Arguments
  if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
  $parsed = $raw | ConvertFrom-Json
  return @($parsed | ForEach-Object { $_ })
}

function Get-SecretReferenceNames($Document) {
  $names = New-Object System.Collections.ArrayList

  function Visit($Node) {
    if ($null -eq $Node) { return }
    if ($Node -is [System.Array]) {
      foreach ($item in $Node) { Visit $item }
      return
    }
    if ($Node -isnot [pscustomobject]) { return }

    $properties = @($Node.PSObject.Properties.Name)
    $hasSecretReference =
      ($properties -contains 'name') -and
      (
        ($Node.valueFrom -and $Node.valueFrom.secretKeyRef) -or
        ($Node.valueSource -and $Node.valueSource.secretKeyRef)
      )
    if ($hasSecretReference) {
      [void]$names.Add([string]$Node.name)
    }

    foreach ($property in $Node.PSObject.Properties) {
      Visit $property.Value
    }
  }

  Visit $Document
  return @($names | Sort-Object -Unique)
}

function Get-LiteralSecretNames($Document) {
  $names = New-Object System.Collections.ArrayList

  function Visit($Node) {
    if ($null -eq $Node) { return }
    if ($Node -is [System.Array]) {
      foreach ($item in $Node) { Visit $item }
      return
    }
    if ($Node -isnot [pscustomobject]) { return }

    $properties = @($Node.PSObject.Properties.Name)
    $isLiteralEnv =
      ($properties -contains 'name') -and
      ($properties -contains 'value') -and
      ($SecretEnvNames -contains [string]$Node.name) -and
      ($null -ne $Node.value) -and
      ([string]$Node.value).Length -gt 0
    if ($isLiteralEnv) {
      [void]$names.Add([string]$Node.name)
    }

    foreach ($property in $Node.PSObject.Properties) {
      Visit $property.Value
    }
  }

  Visit $Document
  return @($names | Sort-Object -Unique)
}

$findings = @()
$jobs = @((Invoke-GcloudText @('run', 'jobs', 'list', "--region=$Region", '--format=value(metadata.name)')).Split("`n") |
  ForEach-Object { $_.Trim() } | Where-Object { $_ })
$services = @((Invoke-GcloudText @('run', 'services', 'list', "--region=$Region", '--format=value(metadata.name)')).Split("`n") |
  ForEach-Object { $_.Trim() } | Where-Object { $_ })

$discoveredSecretEnvNames = @()
foreach ($job in $jobs) {
  $document = @(ConvertFrom-GcloudJson @('run', 'jobs', 'describe', $job, "--region=$Region", '--format=json'))[0]
  $discoveredSecretEnvNames += @(Get-SecretReferenceNames $document)
}
foreach ($service in $services) {
  $document = @(ConvertFrom-GcloudJson @('run', 'services', 'describe', $service, "--region=$Region", '--format=json'))[0]
  $discoveredSecretEnvNames += @(Get-SecretReferenceNames $document)
}
$SecretEnvNames = @($SecretEnvNames + $discoveredSecretEnvNames | Sort-Object -Unique)

foreach ($job in $jobs) {
  $document = @(ConvertFrom-GcloudJson @('run', 'jobs', 'describe', $job, "--region=$Region", '--format=json'))[0]
  $literalNames = @(Get-LiteralSecretNames $document)
  if ($literalNames.Count -gt 0) {
    $findings += [pscustomobject]@{ kind = 'job'; resource = $job; execution = $null; env_names = $literalNames }
  }
}

foreach ($service in $services) {
  $document = @(ConvertFrom-GcloudJson @('run', 'services', 'describe', $service, "--region=$Region", '--format=json'))[0]
  $literalNames = @(Get-LiteralSecretNames $document)
  if ($literalNames.Count -gt 0) {
    $findings += [pscustomobject]@{ kind = 'service'; resource = $service; execution = $null; env_names = $literalNames }
  }
}

$executionCount = 0
if (-not $SkipExecutions) {
  foreach ($job in $jobs) {
    $executions = @(ConvertFrom-GcloudJson @(
      'run', 'jobs', 'executions', 'list', "--job=$job", "--region=$Region",
      "--limit=$ExecutionLimit", '--format=json'
    ))
    $executionCount += $executions.Count
    foreach ($execution in $executions) {
      $literalNames = @(Get-LiteralSecretNames $execution)
      if ($literalNames.Count -eq 0) { continue }
      $findings += [pscustomobject]@{
        kind = 'execution'
        resource = $job
        execution = [string]$execution.metadata.name
        env_names = $literalNames
      }
    }
  }
}

[pscustomobject]@{
  region = $Region
  jobs_scanned = $jobs.Count
  services_scanned = $services.Count
  executions_scanned = $executionCount
  plaintext_findings = $findings.Count
  findings = $findings
} | ConvertTo-Json -Depth 6

if ($findings.Count -gt 0) {
  throw "Cloud Run plaintext secret audit failed with $($findings.Count) finding(s)"
}
