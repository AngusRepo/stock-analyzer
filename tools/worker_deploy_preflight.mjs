export const PRODUCTION_WORKER_HEALTH_URL = 'https://stockvision-worker.angus-solo-dev.workers.dev/api/health'
export const PRODUCTION_PAGES_PROVENANCE_URL = 'https://stockvision-frontend.pages.dev/production-provenance.json'

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

function requireFreshMain({ run, sourceSha, canonicalProductionBranch, productionBranch }) {
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
  return mainSha
}

async function readLive(fetchImpl, url, unavailable) {
  try {
    const response = await fetchImpl(url, {
      redirect: 'error', cache: 'no-store', headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error('live_http_failure')
    return await response.json()
  } catch {
    throw new Error(unavailable)
  }
}

export async function captureWorkerDeployGuard({ run, sourceSha, canonicalProductionBranch, productionBranch, fetchImpl = fetch }) {
  const mainSha = requireFreshMain({ run, sourceSha, canonicalProductionBranch, productionBranch })
  const health = await readLive(fetchImpl, PRODUCTION_WORKER_HEALTH_URL, 'production Worker health attestation unavailable; deployment blocked')
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

// Pages had no live check: a main deploy could replace a Pages build from a commit main never merged.
export async function capturePagesDeployGuard({ run, sourceSha, canonicalProductionBranch, productionBranch, fetchImpl = fetch }) {
  const mainSha = requireFreshMain({ run, sourceSha, canonicalProductionBranch, productionBranch })
  const live = await readLive(fetchImpl, PRODUCTION_PAGES_PROVENANCE_URL, 'production Pages provenance unavailable; deployment blocked')
  if (live?.schema !== 'v1' || live?.provider !== 'cloudflare-pages' || !/^[a-f0-9]{40}$/.test(live?.sourceSha ?? '')) {
    throw new Error('production Pages source is not attested; deployment blocked')
  }
  requireLocalCommit(run, live.sourceSha, 'live Pages')
  requireAncestor(run, live.sourceSha, sourceSha, 'live Pages')
  return { mainSha, pagesSourceSha: live.sourceSha }
}

function requireUnchanged(baseline, current) {
  for (const key of Object.keys(baseline)) {
    if (current[key] !== baseline[key]) throw new Error(`production changed during deployment gates: ${key}; recheck and review before deploying`)
  }
  return current
}

export async function assertWorkerDeployGuardUnchanged(baseline, options) {
  return requireUnchanged(baseline, await captureWorkerDeployGuard(options))
}

export async function assertPagesDeployGuardUnchanged(baseline, options) {
  return requireUnchanged(baseline, await capturePagesDeployGuard(options))
}
