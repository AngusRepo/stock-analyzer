param(
  [string]$ProjectId = $env:GCP_PROJECT_ID,
  [string]$Region = "asia-east1",
  [string]$Service = "shioaji-proxy",
  [string]$SecretPrefix = "stockvision",
  [switch]$ImportCurrentPlaintextFromService,
  [switch]$Apply
)

$ErrorActionPreference = "Stop"

$SecretEnvNames = @(
  "SHIOAJI_API_KEY",
  "SHIOAJI_SECRET_KEY",
  "SHIOAJI_PERSON_ID",
  "SHIOAJI_ACCOUNT_ID"
)

function Resolve-GCloudCommand {
  $cmd = Get-Command gcloud.cmd -ErrorAction SilentlyContinue
  if (-not $cmd) {
    $cmd = Get-Command gcloud -ErrorAction SilentlyContinue
  }
  if (-not $cmd) {
    throw "gcloud command not found"
  }
  return $cmd.Source
}

function Convert-ToSecretId([string]$Name) {
  return "$SecretPrefix-" + $Name.ToLowerInvariant().Replace("_", "-")
}

function Invoke-QuietNative([scriptblock]$Command) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $Command *> $null
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Ensure-SecretVersion([string]$GCloud, [string]$SecretId, [string]$Value) {
  $existsCode = Invoke-QuietNative { & $GCloud secrets describe $SecretId "--project=$ProjectId" "--format=value(name)" }
  if ($existsCode -ne 0) {
    $createCode = Invoke-QuietNative { & $GCloud secrets create $SecretId "--project=$ProjectId" "--replication-policy=automatic" --quiet }
    if ($createCode -ne 0) {
      throw "Failed to create secret $SecretId"
    }
  }

  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($tmp, $Value, [System.Text.UTF8Encoding]::new($false))
    $versionCode = Invoke-QuietNative { & $GCloud secrets versions add $SecretId "--project=$ProjectId" "--data-file=$tmp" --quiet }
    if ($versionCode -ne 0) {
      throw "Failed to add secret version for $SecretId"
    }
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Ensure-SecretAccessor([string]$GCloud, [string]$SecretId, [string]$ServiceAccountEmail) {
  $grantCode = Invoke-QuietNative {
    & $GCloud secrets add-iam-policy-binding $SecretId `
      "--project=$ProjectId" `
      "--member=serviceAccount:$ServiceAccountEmail" `
      "--role=roles/secretmanager.secretAccessor" `
      --quiet
  }
  if ($grantCode -ne 0) {
    throw "Failed to grant secret accessor for $SecretId to $ServiceAccountEmail"
  }
}

function Get-ServiceAccountEmail([string]$GCloud) {
  $email = & $GCloud run services describe $Service "--project=$ProjectId" "--region=$Region" "--format=value(spec.template.spec.serviceAccountName)"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to describe Cloud Run service $Service"
  }
  $email = ($email | Out-String).Trim()
  if ($email) {
    return $email
  }
  $projectNumber = & $GCloud projects describe $ProjectId "--format=value(projectNumber)"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to resolve project number for default compute service account"
  }
  return "$(($projectNumber | Out-String).Trim())-compute@developer.gserviceaccount.com"
}

function Get-ServicePlaintextEnvMap([string]$GCloud) {
  $raw = & $GCloud run services describe $Service "--project=$ProjectId" "--region=$Region" "--format=json(spec.template.spec.containers[0].env)"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to describe Cloud Run service $Service"
  }
  $doc = $raw | ConvertFrom-Json
  $map = @{}
  foreach ($item in $doc.spec.template.spec.containers[0].env) {
    if ($item.name -and $item.value -and -not $item.valueFrom) {
      $map[$item.name] = [string]$item.value
    }
  }
  return $map
}

function Build-SecretRefs {
  $parts = @()
  foreach ($name in $SecretEnvNames) {
    $parts += "$name=$(Convert-ToSecretId $name):latest"
  }
  return ($parts -join ",")
}

function Build-EnvNamesArg {
  return ($SecretEnvNames -join ",")
}

if (-not $ProjectId) {
  throw "ProjectId is required. Pass -ProjectId or set GCP_PROJECT_ID."
}

$missing = @()
foreach ($name in $SecretEnvNames) {
  if (-not [Environment]::GetEnvironmentVariable($name)) {
    $missing += $name
  }
}

if ($missing.Count -gt 0) {
  Write-Host "[shioaji-secret-ref] missing local env vars: $($missing -join ', ')"
  Write-Host "[shioaji-secret-ref] generate rotated Shioaji credentials first, then set these env vars locally before -Apply."
  if ($Apply -and -not $ImportCurrentPlaintextFromService) {
    throw "Refusing to apply without all rotated Shioaji env values."
  }
}

$gcloud = Resolve-GCloudCommand
$secretRefs = Build-SecretRefs
$inputValues = @{}
foreach ($name in $SecretEnvNames) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value) {
    $inputValues[$name] = $value
  }
}

if ($Apply -and $ImportCurrentPlaintextFromService -and $missing.Count -gt 0) {
  $serviceEnvMap = Get-ServicePlaintextEnvMap $gcloud
  foreach ($name in $missing) {
    if ($serviceEnvMap[$name]) {
      $inputValues[$name] = $serviceEnvMap[$name]
    }
  }
  $missing = @()
  foreach ($name in $SecretEnvNames) {
    if (-not $inputValues[$name]) {
      $missing += $name
    }
  }
  if ($missing.Count -gt 0) {
    throw "Import from service could not resolve: $($missing -join ', ')"
  }
  Write-Host "[shioaji-secret-ref] emergency import from existing Cloud Run plaintext env; this is not key rotation."
}

if ($Apply -and $missing.Count -gt 0) {
  throw "Refusing to apply without all Shioaji env values."
}

if (-not $Apply) {
  Write-Host "[shioaji-secret-ref] dry-run only"
  Write-Host "[shioaji-secret-ref] project=$ProjectId region=$Region service=$Service"
  foreach ($name in $SecretEnvNames) {
    Write-Host "[shioaji-secret-ref] target $name -> $(Convert-ToSecretId $name):latest"
  }
  Write-Host "[shioaji-secret-ref] rerun with -Apply after local env vars contain rotated values."
  exit 0
}

$serviceAccountEmail = Get-ServiceAccountEmail $gcloud
foreach ($name in $SecretEnvNames) {
  $secretId = Convert-ToSecretId $name
  $value = $inputValues[$name]
  Ensure-SecretVersion -GCloud $gcloud -SecretId $secretId -Value $value
  Ensure-SecretAccessor -GCloud $gcloud -SecretId $secretId -ServiceAccountEmail $serviceAccountEmail
  Write-Host "[shioaji-secret-ref] updated secret version $secretId and accessor for $serviceAccountEmail"
}

$envNamesArg = Build-EnvNamesArg
& $gcloud run services update $Service `
  "--project=$ProjectId" `
  "--region=$Region" `
  "--remove-env-vars=$envNamesArg" `
  --quiet
if ($LASTEXITCODE -ne 0) {
  throw "Failed to remove literal env vars from Cloud Run service $Service"
}

& $gcloud run services update $Service `
  "--project=$ProjectId" `
  "--region=$Region" `
  "--update-secrets=$secretRefs" `
  --quiet
if ($LASTEXITCODE -ne 0) {
  throw "Failed to update Cloud Run service $Service secret refs"
}

Write-Host "[shioaji-secret-ref] updated Cloud Run secret refs for $Service"
