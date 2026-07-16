const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

assert(!fs.existsSync('../deploy.sh'), 'legacy root deploy.sh should stay removed; use explicit P9 gate and deploy scripts')

const p9GatePath = '../scripts/p9_gate.ps1'
const smokePath = '../scripts/post_deploy_smoke.ps1'
const schedulerSyncPath = '../scripts/sync_gcp_scheduler.ps1'
const schedulerVerifyPath = '../scripts/verify_scheduler_oidc.ps1'
assert(fs.existsSync(p9GatePath), 'P9 gate script should exist as the shared release gate')
assert(fs.existsSync(smokePath), 'post-deploy smoke script should exist as the explicit production verification entrypoint')

const p9Gate = fs.readFileSync(p9GatePath, 'utf8')
const smoke = fs.readFileSync(smokePath, 'utf8')
const schedulerSync = fs.readFileSync(schedulerSyncPath, 'utf8')
const schedulerVerify = fs.readFileSync(schedulerVerifyPath, 'utf8')
const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
assert(p9Gate.includes('worker type-check'), 'P9 gate should run worker type-check')
assert(p9Gate.includes('worker contract tests'), 'P9 gate should run worker contract tests')
assert(p9Gate.includes('frontend build'), 'P9 gate should run frontend build unless explicitly skipped')
assert(p9Gate.includes('(Resolve-Path -LiteralPath $ControllerPython).Path'), 'P9 gate must resolve the controller Python before changing working directory')
assert(smoke.includes('/api/health'), 'post-deploy smoke should verify Worker health')
assert(smoke.includes('/health'), 'post-deploy smoke should verify ml-controller health')
assert(smoke.includes('/api/admin/gate/predeploy?live=1&date=$Date'), 'post-deploy smoke must execute the dated live deployment gate')
assert(smoke.includes("$gate.decision -eq 'PASS'"), 'post-deploy smoke must fail closed unless the live deployment gate passes')
assert(smoke.indexOf('/api/admin/gate/predeploy?live=1&date=$Date') < smoke.indexOf('if (-not $RunTriggers)'), 'live deployment gate must run before the optional trigger branch')
assert(smoke.includes('mlServiceAuthConfigured'), 'post-deploy smoke must verify controller-to-ML auth wiring')
assert(smoke.includes("$mlServiceBase/bandit/stats"), 'post-deploy smoke must exercise a protected ML endpoint')
assert(smoke.includes('$invalidMlStatus -eq 401'), 'post-deploy smoke must reject an invalid ML service token')
assert(smoke.includes('$validMlStatus -eq 200'), 'post-deploy smoke must accept the deployed ML service token')
assert(schedulerSync.includes('--oidc-service-account-email'), 'Scheduler sync must authenticate Worker calls with OIDC')
assert(schedulerSync.includes('--oidc-token-audience'), 'Scheduler sync must bind OIDC tokens to the Worker audience')
assert(!schedulerSync.includes('SCHEDULER_AUTH_TOKEN'), 'Scheduler sync must not persist a static bearer token in job headers')
assert(smoke.includes('verify_scheduler_oidc.ps1'), 'post-deploy smoke must enforce Scheduler OIDC desired state')
assert(schedulerVerify.includes('static_authorization_header:'), 'Scheduler drift gate must reject static Authorization headers')
assert(schedulerVerify.includes('unmanaged_worker_job:'), 'Scheduler drift gate must reject unmanaged Worker jobs')
assert(!adminControlRoutes.includes('const authError = requireServiceToken(c)'), 'async shared service auth must always be awaited')

const workflowPath = '../.github/workflows/p9-gate.yml'
const retentionWorkflowPath = '../.github/workflows/ghcr-retention.yml'
const retentionScriptPath = '../scripts/cleanup_ghcr_ci_images.py'
assert(fs.existsSync(workflowPath), 'P9 GitHub Actions workflow should exist')
assert(fs.existsSync(retentionWorkflowPath), 'GHCR retention workflow should exist')
assert(fs.existsSync(retentionScriptPath), 'GHCR retention policy implementation should exist')

const workflow = fs.readFileSync(workflowPath, 'utf8')
const retentionWorkflow = fs.readFileSync(retentionWorkflowPath, 'utf8')
const retentionScript = fs.readFileSync(retentionScriptPath, 'utf8')
assert(workflow.includes('scripts/p9_gate.ps1'), 'P9 workflow should run the same gate script')
assert(workflow.includes('working-directory: worker'), 'P9 workflow should install worker dependencies')
assert(workflow.includes('working-directory: frontend'), 'P9 workflow should install frontend dependencies')
assert(p9Gate.includes("$Gate.decision -ne 'PASS'"), 'P9 live gate must fail closed on WARN and BLOCK')
assert(p9Gate.includes("@('STOCKVISION_AUTH_TOKEN', 'ML_CONTROLLER_SECRET', 'ML_SERVICE_SECRET')"), 'P9 live gate must verify cross-process Worker secret bindings')
assert(workflow.includes('actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065'), 'P9 workflow must provision Python from an immutable action revision')
assert(!/uses:\s+[^\s]+@v\d/.test(workflow), 'P9 workflow actions must be pinned by full commit SHA, not mutable major tags')
assert(workflow.includes('ml-controller/requirements-test.txt'), 'P9 workflow must install controller test dependencies reproducibly')
assert(workflow.includes('pip-audit==2.10.1'), 'P9 workflow must pin and run the Python dependency auditor')
assert(workflow.includes('requirements-neuralforecast.txt'), 'P9 workflow must assemble and audit the final safe NeuralForecast runtime')
assert(workflow.includes('python -m pip_audit --strict --local'), 'P9 workflow must audit the installed production dependency graph')
assert(workflow.includes('npm audit --package-lock-only --audit-level=high'), 'P9 workflow must block high-severity Node dependency findings')
assert(workflow.includes("if: github.event_name != 'pull_request'"), 'PR code must not receive GHCR package write access')
assert(workflow.includes('packages: write'), 'trusted container gates must have scoped GHCR publish permission')
assert(workflow.includes('docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9'), 'GHCR login action must be pinned')
assert(workflow.includes('docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f'), 'Buildx setup action must be pinned')
assert(workflow.includes('docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8'), 'container builder action must be pinned')
assert(workflow.includes('push: true'), 'P9 workflow must push the immutable OCI index so attestations persist')
assert(workflow.includes('sbom: true'), 'P9 workflow must attach an SBOM to the registry image')
assert(workflow.includes('provenance: mode=max'), 'P9 workflow must attach max-mode provenance')
assert(workflow.includes("--format '{{ json .SBOM.SPDX }}'"), 'P9 workflow must read back and verify the registry SBOM')
assert(workflow.includes("--format '{{ json .Provenance.SLSA }}'"), 'P9 workflow must read back and verify registry provenance')
assert(workflow.includes('@${{ steps.build.outputs.digest }}'), 'P9 workflow must scan the immutable build digest')
assert(workflow.includes('dockerfile: ml-service/Dockerfile'), 'P9 workflow must build the ML service image independently')
assert(workflow.includes('dockerfile: Dockerfile.execution-gateway'), 'P9 workflow must build the execution gateway independently')
assert(workflow.includes('retention_class="quarantine"'), 'main images must remain quarantined before all scans pass')
assert(workflow.includes("needs: container-security"), 'candidate promotion must wait for every container security matrix job')
assert(workflow.includes('docker buildx imagetools create --tag "$target_ref" "$source_ref"'), 'candidate promotion must retag the verified OCI index without rebuilding')
assert(workflow.includes('aquasec/trivy@sha256:'), 'P9 workflow must pin the image scanner by immutable digest')
assert(retentionWorkflow.includes("cron: '37 18 * * *'"), 'GHCR retention must run once daily off-hours')
assert(retentionWorkflow.includes('--max-deletes-per-package 25'), 'retention deletion blast radius must be capped per run')
assert(retentionScript.includes('"ci-": 7'), 'feature CI images must expire after seven days')
assert(retentionScript.includes('"quarantine-": 7'), 'failed or incomplete main images must expire after seven days')
assert(retentionScript.includes('"candidate-": 30'), 'fully-passed main candidates must expire after thirty days')
assert(retentionScript.includes('PROTECTED_PREFIXES = ("release-", "prod-")'), 'production and release tags must be protected from automatic deletion')
assert(p9Gate.includes('GHCR retention contract tests'), 'P9 must execute the GHCR retention contract tests')
