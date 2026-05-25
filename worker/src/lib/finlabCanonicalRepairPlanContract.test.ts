const fs = require('fs')
const path = require('path')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = path.join(process.cwd(), '..')
const scriptPath = path.join(root, 'scripts', 'finlab_canonical_d1_repair_plan.ps1')

assert(fs.existsSync(scriptPath), 'FinLab canonical D1 repair plan script should exist')

const script = fs.readFileSync(scriptPath, 'utf8')

assert(script.includes('[switch]$ApplyJobUpdate'), 'repair script must require explicit switch before updating job')
assert(script.includes('[switch]$ExecuteBackfill'), 'repair script must require explicit switch before executing backfill')
assert(script.includes('[switch]$VerifyD1'), 'repair script should expose strict read-only D1 verification')
assert(script.includes('$RequiredConfirm'), 'repair script must require a confirmation phrase for production mutation')
assert(script.includes('[PLAN ONLY] No production mutation performed.'), 'repair script should default to plan-only mode')
assert(script.includes('gcloud.cmd'), 'repair script should prefer gcloud.cmd on Windows to avoid the PowerShell SDK wrapper env bug')
assert(script.includes('npx.cmd'), 'repair script should prefer npx.cmd for Windows D1 verification')
assert(script.includes('tools\\finlab_backfill_job_guard.py'), 'repair script should run the same local guard as P9 live smoke')
assert(script.includes('tools\\finlab_canonical_d1_verify.py'), 'repair script should call the strict D1 freshness verifier')
assert(script.includes('--stdin'), 'repair script should feed wrangler JSON to the verifier instead of spawning wrangler from Python')
assert(script.includes('Backfill execution always runs this verifier after the job finishes.'), 'repair script should document post-backfill D1 verification')
assert(script.includes('$VerifyD1 -or $ExecuteBackfill'), 'repair script should run strict D1 verification automatically after backfill execution')
assert(script.includes('FinLab canonical D1 verifier did not pass after repair'), 'repair script should fail closed when post-repair D1 verification fails')
assert(script.includes('FinLab backfill job guard still failed after update'), 'repair script should re-check Cloud Run job args after updating them')
assert(script.includes('gcloud run jobs update'), 'repair script should print/apply the job update command')
assert(script.includes('gcloud run jobs execute'), 'repair script should print/apply the manual backfill command')
assert(script.includes('--apply-canonical-d1'), 'repair script should add canonical D1 apply arg')
assert(script.includes('--canonical-window-days'), 'repair script should add canonical window arg')
assert(script.includes('finlab_materialization_manifest'), 'repair script should print manifest readback SQL')
assert(script.includes('canonical_chip_daily'), 'repair script should print canonical chip readback SQL')
