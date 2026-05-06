param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

Push-Location $Root
try {
  $trackedFiles = git ls-files
  if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed' }

  $excludedPathPatterns = @(
    '^package-lock\.json$',
    '^osv-report\.json$',
    '^frontend/dist/',
    '^worker/\.tmp-test-run/',
    '^worker/\.tmp-p12-'
  )

  $secretPatterns = @(
    @{ Name = 'anthropic_api_key'; Pattern = 'sk-ant-api[0-9A-Za-z_\-]+' },
    @{ Name = 'github_pat'; Pattern = 'github_pat_[0-9A-Za-z_]+' },
    @{ Name = 'cloudflare_user_token'; Pattern = 'cfut_[0-9A-Za-z]+' },
    @{ Name = 'google_api_key'; Pattern = 'AIza[0-9A-Za-z_\-]{20,}' },
    @{ Name = 'modal_token_secret'; Pattern = 'as-[0-9A-Za-z]{20,}' }
  )

  $allowlistFragments = @(
    '...',
    'example',
    'placeholder',
    'your-',
    '$env:',
    'os.environ.get',
    'MODAL_TOKEN_SECRET',
    'CF_API_TOKEN',
    'GITHUB_TOKEN',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY'
  )

  $violations = @()

  foreach ($file in $trackedFiles) {
    if ($excludedPathPatterns | Where-Object { $file -match $_ }) { continue }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }

    $lineNumber = 0
    foreach ($line in [System.IO.File]::ReadLines((Resolve-Path -LiteralPath $file))) {
      $lineNumber += 1
      foreach ($rule in $secretPatterns) {
        if ($line -match $rule.Pattern) {
          $allowed = $false
          foreach ($fragment in $allowlistFragments) {
            if ($line -like "*$fragment*") {
              $allowed = $true
              break
            }
          }
          if (-not $allowed) {
            $violations += [pscustomobject]@{
              File = $file
              Line = $lineNumber
              Rule = $rule.Name
            }
          }
        }
      }
    }
  }

  if ($violations.Count -gt 0) {
    Write-Host '[P12 secret scan] potential tracked secret leaks detected:'
    $violations | Format-Table -AutoSize
    throw 'P12 secret scan failed'
  }

  Write-Host '[P12 secret scan] no tracked secret leaks detected'
}
finally {
  Pop-Location
}
