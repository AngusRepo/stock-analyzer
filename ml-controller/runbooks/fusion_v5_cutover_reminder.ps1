$ErrorActionPreference = 'Stop'

$runbook = Join-Path $PSScriptRoot 'FUSION_V5_CUTOVER_2026_07_15.md'
$message = 'StockVision: review Fusion V5 cutover readiness today. Follow the recorded PASS-only cutover and post-cutover checklist.'

& "$env:WINDIR\System32\msg.exe" * $message
Start-Process -FilePath 'notepad.exe' -ArgumentList @($runbook)
