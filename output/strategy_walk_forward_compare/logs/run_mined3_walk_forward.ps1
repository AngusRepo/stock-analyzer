$ErrorActionPreference='Stop'
$repo=(Resolve-Path "$PSScriptRoot\..\..\..").Path
Set-Location $repo
$env:CF_ACCOUNT_ID='619a83ac9f20847d9e2f2920823b727d'
$env:CF_D1_DB_ID='6401a5f6-5767-4fa8-a1a7-ec8d4739ac79'
$env:CF_KV_NAMESPACE_ID='39dcebcf5b6848c98f269ef9a48dc3f8'
$env:GCS_BUCKET_NAME='stockvision-models'
$env:ML_SERVICE_URL='https://wayne60619--stockvision-ml-fastapi-app.modal.run'
$env:STOCKVISION_WORKER_URL='https://stockvision-worker.angus-solo-dev.workers.dev'
$env:PYTHONIOENCODING='utf-8'
$env:CF_API_TOKEN=(& gcloud secrets versions access latest --secret=stockvision-cf-api-token).Trim()
$env:STOCKVISION_AUTH_TOKEN=(& gcloud secrets versions access latest --secret=stockvision-stockvision-auth-token).Trim()
$env:ML_CONTROLLER_SECRET=(& gcloud secrets versions access latest --secret=stockvision-ml-controller-secret).Trim()
$env:FINLAB_API_KEY=(& gcloud secrets versions access latest --secret=finlab-api-key).Trim()
$dates=@('2026-06-12','2026-06-15','2026-06-16')
foreach ($d in $dates) {
  Write-Host "=== mined3 dry-run $d ==="
  & (Join-Path $repo 'ml-service\.venv\Scripts\python.exe') tools\pymoo_l0_l4_dry_run_compare.py --run-date $d --l1-mode full_affinity --log-level INFO
  if ($LASTEXITCODE -ne 0) { throw "dry-run failed $d exit=$LASTEXITCODE" }
}
Write-Host '=== strategy walk-forward compare ==='
& (Join-Path $repo 'ml-service\.venv\Scripts\python.exe') tools\strategy_walk_forward_compare.py --date 2026-06-12 --date 2026-06-15 --date 2026-06-16
if ($LASTEXITCODE -ne 0) { throw "compare failed exit=$LASTEXITCODE" }
