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

foreach ($property in $contract.service_accounts.PSObject.Properties) {
  Ensure-ServiceAccount $property.Name
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
    $actual = (& gcloud run services describe $entry.Name --project=$project --region=$region --format="value(spec.template.spec.serviceAccountName)").Trim()
    if ($actual -eq $email) {
      Write-Host "[identity-cutover] service already correct $($entry.Name) -> $email"
      continue
    }
  }
  Invoke-Gcloud @(
    "run", "services", "update", $entry.Name,
    "--project=$project", "--region=$region", "--service-account=$email", "--quiet"
  )
}

foreach ($entry in $contract.jobs.PSObject.Properties) {
  $email = Get-ServiceAccount ([string]$entry.Value)
  if ($Apply) {
    $actual = (& gcloud run jobs describe $entry.Name --project=$project --region=$region --format="value(spec.template.spec.template.spec.serviceAccountName)").Trim()
    if ($actual -eq $email) {
      Write-Host "[identity-cutover] job already correct $($entry.Name) -> $email"
      continue
    }
  }
  Invoke-Gcloud @(
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
