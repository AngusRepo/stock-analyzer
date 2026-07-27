param(
  [string]$ContractPath = "$PSScriptRoot/../infra/gcp-runtime-identities.json",
  [switch]$Apply,
  [switch]$RemoveDefaultComputeRoles
)

$ErrorActionPreference = "Stop"
$contract = Get-Content -LiteralPath $ContractPath -Raw | ConvertFrom-Json
$project = [string]$contract.project_id
$region = [string]$contract.region
$bucket = [string]$contract.bucket

function Invoke-Gcloud([string[]]$Arguments) {
  $display = "gcloud " + ($Arguments -join " ")
  if (-not $Apply) {
    Write-Host "[dry-run] $display"
    return
  }
  & gcloud @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Failed: $display" }
}

function Invoke-GcloudWithRetry([string[]]$Arguments, [int]$MaxAttempts = 5) {
  if (-not $Apply) {
    Invoke-Gcloud $Arguments
    return
  }
  $display = "gcloud " + ($Arguments -join " ")
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    & gcloud @Arguments
    if ($LASTEXITCODE -eq 0) { return }
    if ($attempt -eq $MaxAttempts) { throw "Failed after $MaxAttempts attempts: $display" }
    $delaySeconds = [Math]::Min(5 * [Math]::Pow(2, $attempt - 1), 30)
    Write-Warning "Attempt $attempt failed; retrying in $delaySeconds seconds: $display"
    Start-Sleep -Seconds $delaySeconds
  }
}

function Ensure-CustomRole([string]$RoleId, [object]$Definition) {
  $permissions = @($Definition.permissions) -join ","
  $arguments = @(
    "iam", "roles", "update", $RoleId,
    "--project=$project", "--title=$([string]$Definition.title)",
    "--stage=$([string]$Definition.stage)", "--permissions=$permissions", "--quiet"
  )
  if ($Apply) {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      & gcloud iam roles describe $RoleId --project=$project --format="value(name)" *> $null
      $exists = $LASTEXITCODE -eq 0
    } finally {
      $ErrorActionPreference = $previousPreference
    }
    if (-not $exists) { $arguments[2] = "create" }
  }
  Invoke-Gcloud $arguments
}

function Get-ServiceAccount([string]$Alias) {
  return [string]$contract.service_accounts.$Alias
}

function Ensure-ServiceAccount([string]$Alias) {
  $email = Get-ServiceAccount $Alias
  if (-not $Apply) {
    Write-Host "[dry-run] ensure service account $email"
    return
  }
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & gcloud iam service-accounts describe $email --project=$project --format="value(email)" *> $null
    $describeCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($describeCode -eq 0) { return }
  $accountId = $email.Split("@")[0]
  Invoke-Gcloud @("iam", "service-accounts", "create", $accountId, "--project=$project", "--display-name=StockVision $Alias runtime", "--quiet")
}

function Get-LiveSecretReferences([string]$Kind, [string]$Name) {
  if ($Kind -eq "service") {
    $resourceJson = & gcloud run services describe $Name --project=$project --region=$region --format=json
  } elseif ($Kind -eq "job") {
    $resourceJson = & gcloud run jobs describe $Name --project=$project --region=$region --format=json
  } else {
    throw "Unsupported Cloud Run resource kind: $Kind"
  }
  if ($LASTEXITCODE -ne 0) { throw "Failed to inspect live $Kind $Name before IAM cutover" }

  $resource = $resourceJson | ConvertFrom-Json
  if ($Kind -eq "service") {
    $runtimeSpec = $resource.spec.template.spec
  } else {
    $runtimeSpec = $resource.spec.template.spec.template.spec
  }

  $references = @()
  foreach ($container in @($runtimeSpec.containers)) {
    foreach ($environmentVariable in @($container.env)) {
      $secretName = [string]$environmentVariable.valueFrom.secretKeyRef.name
      if ($secretName) { $references += $secretName }
    }
  }
  foreach ($volume in @($runtimeSpec.volumes)) {
    $secretName = [string]$volume.secret.secretName
    if ($secretName) { $references += $secretName }
  }
  return @($references | Sort-Object -Unique)
}

function Assert-LiveSecretCoverage {
  $gaps = @()
  foreach ($entry in $contract.services.PSObject.Properties) {
    $alias = [string]$entry.Value
    $declared = @($contract.secret_access.$alias)
    $missing = @(Get-LiveSecretReferences "service" $entry.Name | Where-Object { $_ -notin $declared })
    if ($missing.Count -gt 0) { $gaps += "service $($entry.Name) [$alias]: $($missing -join ', ')" }
  }
  foreach ($entry in $contract.jobs.PSObject.Properties) {
    $alias = [string]$entry.Value
    $declared = @($contract.secret_access.$alias)
    $missing = @(Get-LiveSecretReferences "job" $entry.Name | Where-Object { $_ -notin $declared })
    if ($missing.Count -gt 0) { $gaps += "job $($entry.Name) [$alias]: $($missing -join ', ')" }
  }
  if ($gaps.Count -gt 0) {
    throw "IAM contract does not cover live Secret references. No mutations applied.`n$($gaps -join "`n")"
  }
  Write-Host "[preflight] live Secret references are covered by the IAM contract"
}

if ($Apply) {
  Assert-LiveSecretCoverage
}

foreach ($property in $contract.service_accounts.PSObject.Properties) {
  Ensure-ServiceAccount $property.Name
}
foreach ($entry in $contract.custom_roles.PSObject.Properties) {
  Ensure-CustomRole $entry.Name $entry.Value
}

foreach ($entry in $contract.project_roles.PSObject.Properties) {
  $member = "serviceAccount:$(Get-ServiceAccount $entry.Name)"
  foreach ($role in $entry.Value) {
    Invoke-Gcloud @(
      "projects", "add-iam-policy-binding", $project,
      "--member=$member", "--role=$([string]$role)", "--quiet"
    )
  }
}

foreach ($entry in $contract.secret_access.PSObject.Properties) {
  $member = "serviceAccount:$(Get-ServiceAccount $entry.Name)"
  foreach ($secret in $entry.Value) {
    Invoke-Gcloud @(
      "secrets", "add-iam-policy-binding", [string]$secret,
      "--project=$project", "--member=$member",
      "--role=roles/secretmanager.secretAccessor", "--quiet"
    )
  }
}

foreach ($alias in $contract.bucket_object_admin) {
  $member = "serviceAccount:$(Get-ServiceAccount ([string]$alias))"
  Invoke-Gcloud @(
    "storage", "buckets", "add-iam-policy-binding", "gs://$bucket",
    "--member=$member", "--role=roles/storage.objectAdmin", "--quiet"
  )
}

foreach ($entry in $contract.artifact_registry_readers.PSObject.Properties) {
  $member = "serviceAccount:$(Get-ServiceAccount $entry.Name)"
  foreach ($repository in $entry.Value) {
    Invoke-Gcloud @(
      "artifacts", "repositories", "add-iam-policy-binding", [string]$repository,
      "--project=$project", "--location=$region", "--member=$member",
      "--role=roles/artifactregistry.reader", "--quiet"
    )
  }
}


foreach ($entry in $contract.job_invokers.PSObject.Properties) {
  $member = "serviceAccount:$(Get-ServiceAccount $entry.Name)"
  foreach ($job in $entry.Value) {
    foreach ($role in @("roles/run.invoker", "roles/run.viewer")) {
      Invoke-Gcloud @(
        "run", "jobs", "add-iam-policy-binding", [string]$job,
        "--project=$project", "--region=$region", "--member=$member",
        "--role=$role", "--quiet"
      )
    }
  }
}

foreach ($entry in $contract.job_override_invokers.PSObject.Properties) {
  $member = "serviceAccount:$(Get-ServiceAccount $entry.Name)"
  foreach ($jobEntry in $entry.Value.PSObject.Properties) {
    $role = "projects/$project/roles/$([string]$jobEntry.Value)"
    Invoke-Gcloud @(
      "run", "jobs", "add-iam-policy-binding", $jobEntry.Name,
      "--project=$project", "--region=$region", "--member=$member",
      "--role=$role", "--quiet"
    )
  }
}
$scalerEmail = Get-ServiceAccount "scaler"
$scalerMember = "serviceAccount:$scalerEmail"
$scalerJobs = @($contract.scheduler_oauth_callers.PSObject.Properties.Value | Sort-Object -Unique)
foreach ($job in $scalerJobs) {
  Invoke-Gcloud @(
    "run", "jobs", "add-iam-policy-binding", [string]$job,
    "--project=$project", "--region=$region", "--member=$scalerMember",
    "--role=roles/run.invoker", "--quiet"
  )
}

foreach ($entry in $contract.scheduler_oauth_callers.PSObject.Properties) {
  Invoke-Gcloud @(
    "scheduler", "jobs", "update", "http", $entry.Name,
    "--project=$project", "--location=$region",
    "--oauth-service-account-email=$scalerEmail",
    "--oauth-token-scope=https://www.googleapis.com/auth/cloud-platform",
    "--quiet"
  )
}

foreach ($entry in $contract.service_invokers.PSObject.Properties) {
  foreach ($alias in $entry.Value) {
    $member = "serviceAccount:$(Get-ServiceAccount ([string]$alias))"
    Invoke-Gcloud @(
      "run", "services", "add-iam-policy-binding", $entry.Name,
      "--project=$project", "--region=$region", "--member=$member",
      "--role=roles/run.invoker", "--quiet"
    )
  }
}

foreach ($service in $contract.scaler_targets) {
  Invoke-Gcloud @(
    "run", "services", "add-iam-policy-binding", [string]$service,
    "--project=$project", "--region=$region", "--member=$scalerMember",
    "--role=roles/run.developer", "--quiet"
  )
  $runtimeAlias = [string]$contract.services.$service
  $runtimeServiceAccount = Get-ServiceAccount $runtimeAlias
  Invoke-Gcloud @(
    "iam", "service-accounts", "add-iam-policy-binding", $runtimeServiceAccount,
    "--project=$project", "--member=$scalerMember",
    "--role=roles/iam.serviceAccountUser", "--quiet"
  )
}

foreach ($entry in $contract.services.PSObject.Properties) {
  $email = Get-ServiceAccount ([string]$entry.Value)
  if ($Apply) {
    $resource = (& gcloud run services describe $entry.Name --project=$project --region=$region --format=json) | ConvertFrom-Json
    $actual = [string]$resource.spec.template.spec.serviceAccountName
    $ready = [string]($resource.status.conditions | Where-Object type -eq "Ready" | Select-Object -First 1 -ExpandProperty status)
    if ($actual -eq $email -and $ready -eq "True") {
      Write-Host "[identity-cutover] service already correct $($entry.Name) -> $email"
      continue
    }
  }
  Invoke-GcloudWithRetry @(
    "run", "services", "update", $entry.Name,
    "--project=$project", "--region=$region", "--service-account=$email", "--quiet"
  )
}

foreach ($entry in $contract.jobs.PSObject.Properties) {
  $email = Get-ServiceAccount ([string]$entry.Value)
  if ($Apply) {
    $resource = (& gcloud run jobs describe $entry.Name --project=$project --region=$region --format=json) | ConvertFrom-Json
    $actual = [string]$resource.spec.template.spec.template.spec.serviceAccountName
    $ready = [string]($resource.status.conditions | Where-Object type -eq "Ready" | Select-Object -First 1 -ExpandProperty status)
    if ($actual -eq $email -and $ready -eq "True") {
      Write-Host "[identity-cutover] job already correct $($entry.Name) -> $email"
      continue
    }
  }
  Invoke-GcloudWithRetry @(
    "run", "jobs", "update", $entry.Name,
    "--project=$project", "--region=$region", "--service-account=$email", "--quiet"
  )
}

if ($RemoveDefaultComputeRoles) {
  if (-not $Apply) {
    Write-Host "[dry-run] default role removal requires -Apply after identity cutover verification"
  } else {
    $defaultEmail = [string]$contract.default_compute_identity.email
    foreach ($entry in $contract.services.PSObject.Properties) {
      $actual = (& gcloud run services describe $entry.Name --project=$project --region=$region --format="value(spec.template.spec.serviceAccountName)").Trim()
      if ($actual -eq $defaultEmail) { throw "Refusing role removal: service $($entry.Name) still uses $defaultEmail" }
    }
    foreach ($entry in $contract.jobs.PSObject.Properties) {
      $actual = (& gcloud run jobs describe $entry.Name --project=$project --region=$region --format="value(spec.template.spec.template.spec.serviceAccountName)").Trim()
      if ($actual -eq $defaultEmail) { throw "Refusing role removal: job $($entry.Name) still uses $defaultEmail" }
    }
    foreach ($entry in $contract.scheduler_oauth_callers.PSObject.Properties) {
      $actual = (& gcloud scheduler jobs describe $entry.Name --project=$project --location=$region --format="value(httpTarget.oauthToken.serviceAccountEmail)").Trim()
      if ($actual -eq $defaultEmail) { throw "Refusing role removal: scheduler $($entry.Name) still uses $defaultEmail for OAuth" }
    }
    $member = "serviceAccount:$defaultEmail"
    foreach ($role in $contract.default_compute_identity.forbidden_project_roles) {
      Invoke-Gcloud @(
        "projects", "remove-iam-policy-binding", $project,
        "--member=$member", "--role=$([string]$role)", "--quiet"
      )
    }
  }
}

if (-not $Apply) {
  Write-Host "Dry run only. Re-run with -Apply after reviewing this plan."
} elseif (-not $RemoveDefaultComputeRoles) {
  Write-Host "Identity grants and workload cutover applied. Verify production, then run again with -Apply -RemoveDefaultComputeRoles."
}
