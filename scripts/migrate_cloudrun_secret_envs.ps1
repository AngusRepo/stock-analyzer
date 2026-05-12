param(
  [string]$Region = "asia-east1",
  [string]$Service = "ml-controller",
  [string[]]$Jobs = @("pipeline-v2", "verify-v2", "optuna-research-sweep"),
  [string]$SecretPrefix = "stockvision",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$secretEnvNames = @(
  "ANTHROPIC_API_KEY",
  "CF_API_TOKEN",
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
  "ML_CONTROLLER_SECRET",
  "ML_SERVICE_SECRET",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "STOCKVISION_AUTH_TOKEN"
)

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

function Get-ServiceEnvMap {
  $raw = gcloud run services describe $Service --region=$Region --format="json(spec.template.spec.containers[0].env)"
  $doc = $raw | ConvertFrom-Json
  $map = @{}
  foreach ($item in $doc.spec.template.spec.containers[0].env) {
    if ($item.name) { $map[$item.name] = $item }
  }
  return $map
}

function Get-ServiceAccountEmail {
  $email = gcloud run services describe $Service --region=$Region --format="value(spec.template.spec.serviceAccountName)"
  if (-not [string]::IsNullOrWhiteSpace($email)) {
    return $email.Trim()
  }

  $projectId = (gcloud config get-value project 2>$null).Trim()
  $projectNumber = (gcloud projects describe $projectId --format="value(projectNumber)").Trim()
  return "$projectNumber-compute@developer.gserviceaccount.com"
}

function Ensure-SecretVersion([string]$SecretId, [string]$Value) {
  if ($DryRun) {
    Write-Host "[secret-migrate] dry-run ensure $SecretId"
    return
  }

  $exists = $true
  $describeCode = Invoke-QuietNative { gcloud secrets describe $SecretId --format="value(name)" }
  if ($describeCode -ne 0) {
    $exists = $false
  }

  if (-not $exists) {
    $createCode = Invoke-QuietNative { gcloud secrets create $SecretId --replication-policy="automatic" --quiet }
    if ($createCode -ne 0) {
      $confirmCode = Invoke-QuietNative { gcloud secrets describe $SecretId --format="value(name)" }
      if ($confirmCode -ne 0) {
        throw "Failed to create secret $SecretId"
      }
    }
  }

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllBytes($tmp, $bytes)
    $versionCode = Invoke-QuietNative { gcloud secrets versions add $SecretId --data-file=$tmp --quiet }
    if ($versionCode -ne 0) {
      throw "Failed to add secret version for $SecretId"
    }
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Ensure-SecretAccessor([string]$SecretId, [string]$ServiceAccountEmail) {
  if ($DryRun) {
    Write-Host "[secret-migrate] dry-run grant accessor $SecretId -> $ServiceAccountEmail"
    return
  }

  $grantCode = Invoke-QuietNative {
    gcloud secrets add-iam-policy-binding $SecretId `
      "--member=serviceAccount:$ServiceAccountEmail" `
      "--role=roles/secretmanager.secretAccessor" `
      --quiet
  }
  if ($grantCode -ne 0) {
    throw "Failed to grant secret accessor for $SecretId to $ServiceAccountEmail"
  }
}

function Build-UpdateSecretsArg([string[]]$Names) {
  $parts = @()
  foreach ($name in $Names) {
    $parts += "$name=$(Convert-ToSecretId $name):latest"
  }
  return ($parts -join ",")
}

function Build-NamesArg([string[]]$Names) {
  return ($Names -join ",")
}

$envMap = Get-ServiceEnvMap
$serviceAccountEmail = Get-ServiceAccountEmail
$migrated = @()

foreach ($name in $secretEnvNames) {
  $item = $envMap[$name]
  if (-not $item) { continue }
  if ($item.valueFrom) {
    Write-Host "[secret-migrate] already-secretRef $name"
    continue
  }
  if (-not $item.value) {
    Write-Host "[secret-migrate] skip-empty $name"
    continue
  }

  $secretId = Convert-ToSecretId $name
  Ensure-SecretVersion -SecretId $secretId -Value ([string]$item.value)
  Ensure-SecretAccessor -SecretId $secretId -ServiceAccountEmail $serviceAccountEmail
  $migrated += $name
  Write-Host "[secret-migrate] migrated $name -> $secretId"
}

foreach ($name in $secretEnvNames) {
  $secretId = Convert-ToSecretId $name
  Ensure-SecretAccessor -SecretId $secretId -ServiceAccountEmail $serviceAccountEmail
}

$targetNames = @($secretEnvNames)
if ($targetNames.Count -eq 0) {
  Write-Host "[secret-migrate] no target envs found"
  exit 0
}

$updateSecrets = Build-UpdateSecretsArg $targetNames
$removeEnvNames = Build-NamesArg $targetNames
if ($DryRun) {
  Write-Host "[secret-migrate] dry-run update service/jobs with secret refs for $($targetNames.Count) envs"
  exit 0
}

$serviceRemoveArgs = @(
  "run", "services", "update", $Service,
  "--region=$Region",
  "--remove-env-vars=$removeEnvNames",
  "--quiet"
)
$serviceRemoveCode = Invoke-QuietNative { gcloud @serviceRemoveArgs }
if ($serviceRemoveCode -ne 0) {
  throw "Failed to remove literal secret envs from service $Service"
}

$serviceUpdateArgs = @(
  "run", "services", "update", $Service,
  "--region=$Region",
  "--update-secrets=$updateSecrets",
  "--quiet"
)
$serviceUpdateCode = Invoke-QuietNative { gcloud @serviceUpdateArgs }
if ($serviceUpdateCode -ne 0) {
  throw "Failed to update service $Service secret refs"
}
Write-Host "[secret-migrate] updated service $Service secret refs: $($targetNames.Count)"

foreach ($job in $Jobs) {
  $exists = $true
  $jobDescribeCode = Invoke-QuietNative { gcloud run jobs describe $job --region=$Region --format="value(metadata.name)" }
  if ($jobDescribeCode -ne 0) {
    $exists = $false
  }
  if (-not $exists) {
    Write-Host "[secret-migrate] skip-missing-job $job"
    continue
  }
  $jobRemoveArgs = @(
    "run", "jobs", "update", $job,
    "--region=$Region",
    "--remove-env-vars=$removeEnvNames",
    "--quiet"
  )
  $jobRemoveCode = Invoke-QuietNative { gcloud @jobRemoveArgs }
  if ($jobRemoveCode -ne 0) {
    throw "Failed to remove literal secret envs from job $job"
  }

  $jobUpdateArgs = @(
    "run", "jobs", "update", $job,
    "--region=$Region",
    "--update-secrets=$updateSecrets",
    "--quiet"
  )
  $jobUpdateCode = Invoke-QuietNative { gcloud @jobUpdateArgs }
  if ($jobUpdateCode -ne 0) {
    throw "Failed to update job $job secret refs"
  }
  Write-Host "[secret-migrate] updated job $job secret refs: $($targetNames.Count)"
}

Write-Host "[secret-migrate] done migrated=$($migrated.Count) targets=$($targetNames.Count)"
