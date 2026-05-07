param(
  [string]$AccountId = $env:CLOUDFLARE_ACCOUNT_ID,
  [string]$ApiToken = $env:CLOUDFLARE_API_TOKEN,
  [string]$ScriptName = 'stockvision-worker',
  [switch]$DryRun,
  [switch]$Clear
)

$ErrorActionPreference = 'Stop'

if (-not $AccountId) { throw 'Missing CLOUDFLARE_ACCOUNT_ID.' }
if (-not $ApiToken) { throw 'Missing CLOUDFLARE_API_TOKEN.' }

$headers = @{
  Authorization = "Bearer $ApiToken"
  'Content-Type' = 'application/json'
}
$uri = "https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/scripts/$ScriptName/schedules"

$current = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers
if (-not $current.success) {
  throw "Cloudflare schedule read failed: $($current.errors | ConvertTo-Json -Compress)"
}

$schedules = @($current.result.schedules)
Write-Host "[cf-schedules] script=$ScriptName current=$($schedules.Count) dryRun=$DryRun clear=$Clear"
foreach ($schedule in $schedules) {
  Write-Host "[cf-schedules] existing $($schedule.cron)"
}

if (-not $Clear) {
  Write-Host '[cf-schedules] no mutation requested; pass -Clear to remove Worker cron triggers.'
  exit 0
}

if ($DryRun) {
  Write-Host '[cf-schedules] dry-run clear: would PUT []'
  exit 0
}

$updated = Invoke-RestMethod -Method Put -Uri $uri -Headers $headers -Body '[]'
if (-not $updated.success) {
  throw "Cloudflare schedule clear failed: $($updated.errors | ConvertTo-Json -Compress)"
}

Write-Host "[cf-schedules] cleared script=$ScriptName"
