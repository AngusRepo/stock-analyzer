export const PRODUCTION_WORKER_HEALTH_URL = 'https://stockvision-worker.angus-solo-dev.workers.dev/api/health'

function requireLocalCommit(run, sha, owner) {
  try {
    run('git', ['cat-file', '-e', `${sha}^{commit}`], { capture: true })
  } catch {
    throw new Error(`${owner} commit ${sha} is missing locally; fetch and review it before deploying`)
  }
}

function requireAncestor(run, ancestor, sourceSha, owner) {
  try {
    run('git', ['merge-base', '--is-ancestor', ancestor, sourceSha], { capture: true })
  } catch {
    throw new Error(`${owner} source ${ancestor} is not an ancestor of candidate ${sourceSha}; merge and review it before deploying`)
  }
}

export async function captureWorkerDeployGuard({ run, sourceSha, canonicalProductionBranch, productionBranch, fetchImpl = fetch }) {
  const remoteRef = `refs/heads/${canonicalProductionBranch}`
  const remoteOutput = run('git', ['ls-remote', 'origin', remoteRef], { capture: true })
  const rows = remoteOutput.trim().split(/\r?\n/).filter(Boolean)
  const [mainSha, returnedRef, extra] = (rows[0] ?? '').split(/\s+/)
  if (rows.length !== 1 || !/^[a-f0-9]{40}$/.test(mainSha ?? '') || returnedRef !== remoteRef || extra) {
    throw new Error(`fresh remote ${remoteRef} could not be verified`)
  }
  requireLocalCommit(run, mainSha, 'remote production branch')
  if (productionBranch === canonicalProductionBranch && sourceSha !== mainSha) {
    throw new Error(`canonical production deploy requires HEAD=fresh origin/${canonicalProductionBranch} (${mainSha}), got ${sourceSha}`)
  }
  requireAncestor(run, mainSha, sourceSha, 'fresh remote production branch')

  let health
  try {
    const response = await fetchImpl(PRODUCTION_WORKER_HEALTH_URL, {
      redirect: 'error', cache: 'no-store', headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error('health_http_failure')
    health = await response.json()
  } catch {
    throw new Error('production Worker health attestation unavailable; deployment blocked')
  }
  const provenance = health?.provenance
  if (health?.status !== 'ok' || provenance?.schema !== 'v1' || provenance?.provider !== 'cloudflare-workers'
    || provenance?.attested !== true || !/^[a-f0-9]{40}$/.test(provenance?.sourceSha ?? '')
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(provenance?.versionId ?? '')) {
    throw new Error('production Worker source/version is not attested; deployment blocked')
  }
  requireLocalCommit(run, provenance.sourceSha, 'live Worker')
  requireAncestor(run, provenance.sourceSha, sourceSha, 'live Worker')
  return { mainSha, workerSourceSha: provenance.sourceSha, workerVersionId: provenance.versionId }
}

export async function assertWorkerDeployGuardUnchanged(baseline, options) {
  const current = await captureWorkerDeployGuard(options)
  for (const key of ['mainSha', 'workerSourceSha', 'workerVersionId']) {
    if (current[key] !== baseline[key]) throw new Error(`production changed during deployment gates: ${key}; recheck and review before deploying`)
  }
  return current
}
