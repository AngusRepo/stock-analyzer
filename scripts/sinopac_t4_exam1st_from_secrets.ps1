param(
  [string]$ProjectId = $env:GCP_PROJECT_ID,
  [string]$T4VbaPath = ".\.tmp\sinopac-t4\T4_10142\T4_10142\VBA",
  [string]$LoginId = $env:SINOPAC_T4_LOGIN_ID,
  [string]$LoginPassword = $env:SINOPAC_T4_LOGIN_PASSWORD,
  [string]$Branch = "S9A9L",
  [string]$AccountId = "",
  [string]$PersonId = "",
  [string]$StockContent = "B,2890,15.0,1,LMT,ROD",
  [switch]$ProbeOnly,
  [switch]$SubmitExam
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

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

function Get-SecretValue([string]$GCloud, [string]$SecretId) {
  $value = & $GCloud secrets versions access latest "--project=$ProjectId" "--secret=$SecretId"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to access secret $SecretId"
  }
  return ($value | Out-String).TrimEnd("`r", "`n")
}

function Mask([string]$Value, [int]$Keep = 3) {
  if (-not $Value) {
    return ""
  }
  if ($Value.Length -le ($Keep * 2)) {
    return "***"
  }
  return "$($Value.Substring(0, $Keep))...$($Value.Substring($Value.Length - $Keep))"
}

function Resolve-T4StockAccount([string]$RawBranch, [string]$RawAccountId) {
  $branch = ""
  if ($RawBranch) {
    $branch = $RawBranch.Trim().ToUpperInvariant()
  }
  $account = ""
  if ($RawAccountId) {
    $account = $RawAccountId.Trim().ToUpperInvariant()
  }
  $source = "raw"

  if ($account -match "^([A-Z0-9]+)-([0-9]{7})$") {
    $broker = $Matches[1].ToUpperInvariant()
    $account = $Matches[2]
    if (-not $branch -or $branch -eq "S9A9L") {
      $branch = "S$broker"
    }
    $source = "broker_account_secret"
  } elseif ($account -match "^S?([A-Z0-9]{4,5})([0-9]{7})$") {
    $broker = $Matches[1].ToUpperInvariant()
    $account = $Matches[2]
    if (-not $branch -or $branch -eq "S9A9L") {
      $branch = "S$broker"
    }
    $source = "compact_broker_account"
  } elseif ($account -match "^[0-9]{7}$") {
    $source = "seven_digit_account"
  }

  if ($branch -and $branch -notmatch "^[SF][A-Z0-9]+$") {
    throw "T4 Branch must start with market prefix S/F, e.g. S9A9L. Got: $branch"
  }
  if ($account -and $account -notmatch "^[0-9]{7}$") {
    throw "T4 Account must be the 7-digit account only, e.g. 0475784. Got masked: $(Mask $account)"
  }
  [pscustomobject]@{
    Branch = $branch
    Account = $account
    Source = $source
  }
}

function Is-ExpectedFirstT4InitResult([string]$Value) {
  $expected = -join ([char[]](0x4E0B, 0x55AE, 0x5E33, 0x865F, 0x53D6, 0x5F97, 0x5931, 0x6557))
  return [bool]($Value -and $Value.Contains($expected))
}

if (-not $ProjectId) {
  throw "ProjectId is required. Pass -ProjectId or set GCP_PROJECT_ID."
}

$resolvedT4Path = Resolve-Path -LiteralPath (Join-Path $Root $T4VbaPath)
$dllPath = Join-Path $resolvedT4Path.Path "t4x64.dll"
if (-not (Test-Path -LiteralPath $dllPath)) {
  throw "T4 x64 DLL not found: $dllPath"
}

$gcloud = Resolve-GCloudCommand
if (-not $PersonId) {
  $PersonId = Get-SecretValue $gcloud "stockvision-finlab-exec-shioaji-cert-person-id"
}
if (-not $AccountId) {
  $AccountId = Get-SecretValue $gcloud "stockvision-finlab-exec-shioaji-account-id"
}
$resolvedAccount = Resolve-T4StockAccount $Branch $AccountId
$Branch = $resolvedAccount.Branch
$AccountId = $resolvedAccount.Account

if (-not $LoginId) {
  $LoginId = $PersonId
}
if (-not $LoginPassword -and -not $ProbeOnly) {
  $securePassword = Read-Host "Sinopac T4 login password" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  try {
    $LoginPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

$escapedDllPath = $dllPath.Replace("\", "\\")
$code = @"
using System;
using System.Runtime.InteropServices;

public static class SinopacT4Exam {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool SetDllDirectory(string lpPathName);

  [DllImport("$escapedDllPath", SetLastError=true, CharSet=CharSet.Ansi, CallingConvention=CallingConvention.StdCall)]
  [return: MarshalAs(UnmanagedType.AnsiBStr)]
  public static extern string show_version();

  [DllImport("$escapedDllPath", SetLastError=true, CharSet=CharSet.Ansi, CallingConvention=CallingConvention.StdCall)]
  [return: MarshalAs(UnmanagedType.AnsiBStr)]
  public static extern string init_t4(string login_id, string login_pass, string dll_path);

  [DllImport("$escapedDllPath", SetLastError=true, CharSet=CharSet.Ansi, CallingConvention=CallingConvention.StdCall)]
  [return: MarshalAs(UnmanagedType.AnsiBStr)]
  public static extern string exam1st(string user_id, string branch, string account, string content);

  [DllImport("$escapedDllPath", SetLastError=true, CharSet=CharSet.Ansi, CallingConvention=CallingConvention.StdCall)]
  [return: MarshalAs(UnmanagedType.I4)]
  public static extern int log_out();
}
"@

Add-Type -TypeDefinition $code
[SinopacT4Exam]::SetDllDirectory($resolvedT4Path.Path) | Out-Null

$version = [SinopacT4Exam]::show_version()
$initResult = ""
$examResult = "skipped: pass -SubmitExam to submit T4 first-login validation"
$logoutResult = $null

if ($ProbeOnly) {
  [pscustomobject]@{
    mode = "sinopac_t4_probe"
    live_order_function_called = $false
    submit_exam = $false
    t4_version = $version
    t4_vba_path = $resolvedT4Path.Path
  } | ConvertTo-Json -Depth 4
  return
}

Push-Location $resolvedT4Path.Path
try {
  $initResult = [SinopacT4Exam]::init_t4($LoginId, $LoginPassword, $resolvedT4Path.Path)
  if ($SubmitExam) {
    $examResult = [SinopacT4Exam]::exam1st($PersonId, $Branch, $AccountId, $StockContent)
  }
} finally {
  try {
    $logoutResult = [SinopacT4Exam]::log_out()
  } catch {
    $logoutResult = "logout_error"
  }
  Pop-Location
}

[pscustomobject]@{
  mode = "sinopac_t4_exam1st"
  live_order_function_called = $false
  submit_exam = [bool]$SubmitExam
  t4_version = $version
  login_id_mask = (Mask $LoginId)
  person_id_mask = (Mask $PersonId)
  branch = $Branch
  account_id_mask = (Mask $AccountId)
  account_normalization = $resolvedAccount.Source
  stock_content = $StockContent
  init_result = $initResult
  init_result_expected_for_first_test = (Is-ExpectedFirstT4InitResult $initResult)
  exam_result = $examResult
  logout_result = $logoutResult
} | ConvertTo-Json -Depth 4
