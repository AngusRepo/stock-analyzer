param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [int]$MaxAgeHours = 48,
  [switch]$Skip
)

$ErrorActionPreference = 'Stop'

$RequiredTargets = @(
  'worker/src/routes',
  'worker/src/lib',
  'ml-controller/routers',
  'ml-controller/services',
  'ml-service/app'
)

$SuggestedCommand = "/bug-hunter --scan-only --threat-model $($RequiredTargets -join ' ')"

if ($Skip) {
  Write-Host '[Bug Hunter CPD gate] skipped by explicit gate switch'
  return
}

$BugHunterDir = Join-Path $Root '.bug-hunter'
$RequiredArtifacts = @(
  'report.md',
  'referee.json',
  'triage.json'
)

if (-not (Test-Path $BugHunterDir -PathType Container)) {
  throw "Bug Hunter CPD gate missing artifacts. Run from agent before CPD: $SuggestedCommand"
}

foreach ($artifact in $RequiredArtifacts) {
  $path = Join-Path $BugHunterDir $artifact
  if (-not (Test-Path $path -PathType Leaf)) {
    throw "Bug Hunter CPD gate missing $artifact. Run from agent before CPD: $SuggestedCommand"
  }

  $age = (Get-Date) - (Get-Item $path).LastWriteTime
  if ($age.TotalHours -gt $MaxAgeHours) {
    throw "Bug Hunter CPD gate artifact is stale: $artifact age=$([Math]::Round($age.TotalHours, 1))h max=${MaxAgeHours}h"
  }
}

$fixReport = Join-Path $BugHunterDir 'fix-report.json'
if (Test-Path $fixReport -PathType Leaf) {
  throw 'Bug Hunter CPD gate found fix-report.json; CPD requires a read-only scan artifact set.'
}

$refereePath = Join-Path $BugHunterDir 'referee.json'
$refereeRaw = Get-Content -Raw $refereePath
$referee = @()
if ($refereeRaw.Trim()) {
  $parsedReferee = ConvertFrom-Json $refereeRaw
  if ($null -ne $parsedReferee) {
    $referee = @($parsedReferee)
  }
}

$blocking = @($referee | Where-Object {
  $null -ne $_ -and $_.verdict -ne 'NOT_A_BUG'
})

if ($blocking.Count -gt 0) {
  $summary = $blocking |
    Select-Object bugId, verdict, trueSeverity, confidenceScore |
    ConvertTo-Json -Compress -Depth 4
  throw "Bug Hunter CPD gate blocked by unresolved findings: $summary"
}

Write-Host "[Bug Hunter CPD gate] read-only artifacts accepted; targets=$($RequiredTargets -join ', ')"
