param(
  [string]$ManifestPath = (Join-Path $PSScriptRoot "..\infra\gcp-runtime-scaling.json"),
  [switch]$DryRun,
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
if ($Apply -eq $DryRun) {
  throw "Specify exactly one of -DryRun or -Apply"
}

$manifest = Get-Content -Raw $ManifestPath | ConvertFrom-Json
$project = [string]$manifest.project_id
$region = [string]$manifest.region
$timezone = [string]$manifest.timezone
$serviceAccount = [string]$manifest.scaler_service_account
$image = "gcr.io/google.com/cloudsdktool/cloud-sdk:slim"

function Invoke-Gcloud([string[]]$Arguments) {
  Write-Host ("gcloud " + ($Arguments -join " "))
  if (-not $Apply) { return }
  & gcloud @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "gcloud failed ($LASTEXITCODE): $($Arguments -join ' ')"
  }
}

function New-ScalerScript($job) {
  $desired = [int]$job.desired_min
  $targets = @()
  foreach ($serviceName in $job.services) {
    $policy = $manifest.service_policies.PSObject.Properties[$serviceName].Value
    if (-not [bool]$policy.warm_enabled -and $desired -gt 0) {
      throw "warm-disabled service cannot be in min-1 job: $serviceName"
    }
    $targets += ("{0}:{1}:{2}" -f $serviceName, [int]$policy.max, [string]$policy.cpu_allocation)
  }
  if ($targets.Count -eq 0) { throw "scaler job has no services" }
  $calendar = if ([string]$job.calendar_gate -eq "twse_fail_open_min_1") {
@'
status="$(python3 -c 'import datetime,json,urllib.request; now=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).date(); roc=f"{now.year-1911:03d}{now:%m%d}"; rows=json.load(urllib.request.urlopen("https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule",timeout=5)); valid=isinstance(rows,list) and len(rows)>10 and all(isinstance(r,dict) and "Date" in r for r in rows); print("unknown" if not valid else ("closed" if any(str(r.get("Date","")).strip()==roc for r in rows) else "open"))')" || status="unknown"
case "$status" in
  open) desired=1 ;;
  closed) desired=0 ;;
  *) desired=1; echo "TWSE calendar unavailable; fail-open min=1" >&2 ;;
esac
'@
  } elseif ([string]$job.calendar_gate -eq "first_saturday_only") {
    $firstSaturday = @'
day="$(TZ=Asia/Taipei date +%d)"
if [ "$day" -gt 7 ]; then
  echo "not first Saturday in Asia/Taipei; no scaling mutation"
  exit 0
fi
desired=__DESIRED__
'@
    $firstSaturday.Replace("__DESIRED__", [string]$desired)
  } else {
    "desired=$desired"
  }
  $script = @'
set -euo pipefail
__CALENDAR__
for target in __TARGETS__; do
  IFS=: read -r service max cpu_policy <<< "$target"
  gcloud run services update "$service" --project=__PROJECT__ --region=__REGION__ --min="$desired" --max="$max" --quiet
  service_json="$(gcloud run services describe "$service" --project=__PROJECT__ --region=__REGION__ --format=json)"
  SERVICE="$service" SERVICE_JSON="$service_json" DESIRED="$desired" MAX="$max" CPU_POLICY="$cpu_policy" python3 - <<'PY'
import json, os
doc = json.loads(os.environ["SERVICE_JSON"])
annotations = doc.get("metadata", {}).get("annotations", {})
template_annotations = doc.get("spec", {}).get("template", {}).get("metadata", {}).get("annotations", {})
errors = []
if int(annotations.get("run.googleapis.com/minScale", "0")) != int(os.environ["DESIRED"]):
    errors.append("service_min_mismatch")
if int(annotations.get("run.googleapis.com/maxScale", "0")) != int(os.environ["MAX"]):
    errors.append("service_max_mismatch")
if os.environ["CPU_POLICY"] == "continuous" and template_annotations.get("run.googleapis.com/cpu-throttling") != "false":
    errors.append("continuous_cpu_disabled")
if errors:
    raise SystemExit(os.environ["SERVICE"] + ":" + "|".join(errors))
print(json.dumps({"service": os.environ["SERVICE"], "min": int(os.environ["DESIRED"]), "status": "verified"}))
PY
done
'@
  return $script.
    Replace("__CALENDAR__", $calendar).
    Replace("__TARGETS__", ($targets -join " ")).
    Replace("__PROJECT__", $project).
    Replace("__REGION__", $region)
}

foreach ($entry in $manifest.scaler_jobs.PSObject.Properties) {
  $jobName = [string]$entry.Name
  $script = New-ScalerScript $entry.Value
  $scriptB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
  $verb = "create"
  if ($Apply) {
    & gcloud run jobs describe $jobName --project=$project --region=$region --format="value(metadata.name)" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $verb = "update" }
  }
  Invoke-Gcloud @(
    "run", "jobs", $verb, $jobName,
    "--project=$project", "--region=$region", "--image=$image",
    "--command=bash", '--args=-c,echo "$SCALER_SCRIPT_B64" | base64 -d | bash',
    "--cpu=1", "--memory=512Mi", "--task-timeout=300s", "--max-retries=1",
    "--service-account=$serviceAccount",
    "--set-env-vars=SCALER_SCRIPT_B64=$scriptB64",
    "--labels=stockvision-owner=runtime-scaling-manifest-v1", "--quiet"
  )
}

foreach ($schedule in $manifest.schedules) {
  $uri = "https://$region-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$project/jobs/$($schedule.job):run"
  Invoke-Gcloud @(
    "scheduler", "jobs", "update", "http", [string]$schedule.name,
    "--project=$project", "--location=$region",
    "--schedule=$([string]$schedule.cron)", "--time-zone=$timezone",
    "--uri=$uri", "--http-method=POST",
    "--oauth-service-account-email=$serviceAccount",
    "--oauth-token-scope=https://www.googleapis.com/auth/cloud-platform",
    "--quiet"
  )
}
