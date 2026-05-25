param(
  [string]$ProjectId = $env:GCP_PROJECT_ID,
  [string]$Region = "asia-east1",
  [string]$Service = "ml-controller",
  [string]$SecretPrefix = "stockvision-finlab-exec",
  [string]$CertMountPath = "/secrets/shioaji-finlab-cert.pfx",
  [switch]$UpdateCloudRunService,
  [switch]$Apply
)

$ErrorActionPreference = "Stop"

$EnvSecretMap = @(
  @{ LocalEnv = "FINLAB_EXECUTION_SHIOAJI_API_KEY"; RuntimeEnv = "SHIOAJI_API_KEY"; SecretSuffix = "shioaji-api-key"; Required = $true },
  @{ LocalEnv = "FINLAB_EXECUTION_SHIOAJI_SECRET_KEY"; RuntimeEnv = "SHIOAJI_SECRET_KEY"; SecretSuffix = "shioaji-secret-key"; Required = $true },
  @{ LocalEnv = "FINLAB_EXECUTION_SHIOAJI_CERT_PERSON_ID"; RuntimeEnv = "SHIOAJI_CERT_PERSON_ID"; SecretSuffix = "shioaji-cert-person-id"; Required = $true },
  @{ LocalEnv = "FINLAB_EXECUTION_SHIOAJI_CERT_PASSWORD"; RuntimeEnv = "SHIOAJI_CERT_PASSWORD"; SecretSuffix = "shioaji-cert-password"; Required = $true },
  @{ LocalEnv = "FINLAB_EXECUTION_SHIOAJI_ACCOUNT_ID"; RuntimeEnv = "SHIOAJI_ACCOUNT_ID"; SecretSuffix = "shioaji-account-id"; Required = $true }
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

function Get-SecretId([string]$Suffix) {
  return "$SecretPrefix-$Suffix"
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

function Ensure-SecretFileVersion([string]$GCloud, [string]$SecretId, [string]$FilePath) {
  if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    throw "Certificate file not found: $FilePath"
  }

  $existsCode = Invoke-QuietNative { & $GCloud secrets describe $SecretId "--project=$ProjectId" "--format=value(name)" }
  if ($existsCode -ne 0) {
    $createCode = Invoke-QuietNative { & $GCloud secrets create $SecretId "--project=$ProjectId" "--replication-policy=automatic" --quiet }
    if ($createCode -ne 0) {
      throw "Failed to create secret $SecretId"
    }
  }

  $versionCode = Invoke-QuietNative { & $GCloud secrets versions add $SecretId "--project=$ProjectId" "--data-file=$FilePath" --quiet }
  if ($versionCode -ne 0) {
    throw "Failed to add secret version for $SecretId from certificate file"
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

function Build-UpdateSecretsArg {
  $parts = @()
  foreach ($item in $EnvSecretMap) {
    $parts += "$($item.RuntimeEnv)=$(Get-SecretId $item.SecretSuffix):latest"
  }
  $parts += "$CertMountPath=$(Get-SecretId 'shioaji-cert-pfx'):latest"
  return ($parts -join ",")
}

function Build-UpdateEnvVarsArg {
  return "SHIOAJI_CERT_PATH=$CertMountPath,FINLAB_EXECUTION_LANE_ENABLED=shadow"
}

if (-not $ProjectId) {
  throw "ProjectId is required. Pass -ProjectId or set GCP_PROJECT_ID."
}

$missing = @()
foreach ($item in $EnvSecretMap) {
  if ($item.Required -and -not [Environment]::GetEnvironmentVariable($item.LocalEnv)) {
    $missing += $item.LocalEnv
  }
}

$certFile = [Environment]::GetEnvironmentVariable("FINLAB_EXECUTION_SHIOAJI_CERT_FILE")
if (-not $certFile) {
  $missing += "FINLAB_EXECUTION_SHIOAJI_CERT_FILE"
}

$gcloud = Resolve-GCloudCommand
$certSecretId = Get-SecretId "shioaji-cert-pfx"

if (-not $Apply) {
  Write-Host "[finlab-exec-secret-ref] dry-run only"
  Write-Host "[finlab-exec-secret-ref] project=$ProjectId region=$Region service=$Service"
  foreach ($item in $EnvSecretMap) {
    Write-Host "[finlab-exec-secret-ref] target $($item.RuntimeEnv) -> $(Get-SecretId $item.SecretSuffix):latest"
  }
  Write-Host "[finlab-exec-secret-ref] target $CertMountPath -> ${certSecretId}:latest"
  Write-Host "[finlab-exec-secret-ref] update-cloud-run-service=$UpdateCloudRunService"
  if ($missing.Count -gt 0) {
    Write-Host "[finlab-exec-secret-ref] missing local env vars/files: $($missing -join ', ')"
  }
  exit 0
}

if ($missing.Count -gt 0) {
  throw "Refusing to apply without required values: $($missing -join ', ')"
}

$serviceAccountEmail = Get-ServiceAccountEmail $gcloud
foreach ($item in $EnvSecretMap) {
  $secretId = Get-SecretId $item.SecretSuffix
  $value = [Environment]::GetEnvironmentVariable($item.LocalEnv)
  Ensure-SecretVersion -GCloud $gcloud -SecretId $secretId -Value $value
  Ensure-SecretAccessor -GCloud $gcloud -SecretId $secretId -ServiceAccountEmail $serviceAccountEmail
  Write-Host "[finlab-exec-secret-ref] updated secret version $secretId and accessor for $serviceAccountEmail"
}

Ensure-SecretFileVersion -GCloud $gcloud -SecretId $certSecretId -FilePath $certFile
Ensure-SecretAccessor -GCloud $gcloud -SecretId $certSecretId -ServiceAccountEmail $serviceAccountEmail
Write-Host "[finlab-exec-secret-ref] updated certificate secret $certSecretId and accessor for $serviceAccountEmail"

if ($UpdateCloudRunService) {
  $secretRefs = Build-UpdateSecretsArg
  $envVars = Build-UpdateEnvVarsArg
  & $gcloud run services update $Service `
    "--project=$ProjectId" `
    "--region=$Region" `
    "--update-secrets=$secretRefs" `
    "--update-env-vars=$envVars" `
    --quiet
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to update Cloud Run service $Service with FinLab execution secret refs"
  }
  Write-Host "[finlab-exec-secret-ref] updated Cloud Run service $Service with FinLab execution secret refs"
} else {
  Write-Host "[finlab-exec-secret-ref] secrets updated; rerun with -UpdateCloudRunService to attach them to $Service"
}
