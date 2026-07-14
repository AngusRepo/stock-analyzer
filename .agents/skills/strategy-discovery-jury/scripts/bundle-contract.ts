import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { hashJson, sha256Hex } from '../../../../worker/src/strategy-discovery/hashing'
import { parseStoredZip } from '../../../../worker/src/strategy-discovery/zip'

export const REQUIRED_BUNDLE_FILES = [
  'jury-bundle/manifest.json', 'jury-bundle/run-summary.md', 'jury-bundle/feature-registry-summary.json',
  'jury-bundle/feature-clusters.json', 'jury-bundle/portfolio-gap-map.json', 'jury-bundle/existing-strategies.json',
  'jury-bundle/hypotheses.json', 'jury-bundle/candidates.json', 'jury-bundle/candidate-lineage.json',
  'jury-bundle/static-validation.json', 'jury-bundle/issues.json', 'jury-bundle/cross-examination.json',
  'jury-bundle/evidence-requests.json', 'jury-bundle/test-plan.json', 'jury-bundle/source-map.json',
] as const

export const REQUIRED_RESULT_FILES = [
  'final-verdict.json', 'final-report.md', 'strategy-verdicts.json', 'candidate-verdicts.json', 'issue-verdicts.json',
  'tests-executed.json', 'repository-evidence.json', 'unresolved-evidence.json', 'candidate-recommendations.json',
] as const

export interface ValidatedBundle { source: string; files: Map<string, Uint8Array>; manifest: any; candidates: any[]; strategies: any[]; issues: any[] }

function walk(directory: string, root: string, output: Map<string, Uint8Array>) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) walk(path, root, output)
    else output.set(path.slice(root.length + 1).split('\\').join('/'), new Uint8Array(readFileSync(path)))
  }
}

function loadFiles(input: string): Map<string, Uint8Array> {
  const path = resolve(input)
  if (!existsSync(path)) throw new Error(`bundle_not_found:${path}`)
  if (!statSync(path).isDirectory()) return parseStoredZip(new Uint8Array(readFileSync(path)))
  const files = new Map<string, Uint8Array>()
  walk(path, path, files)
  if (files.has('manifest.json')) return new Map([...files].map(([name, bytes]) => [`jury-bundle/${name}`, bytes]))
  return files
}

function json(files: Map<string, Uint8Array>, name: string): any {
  const bytes = files.get(name)
  if (!bytes) throw new Error(`required_file_missing:${name}`)
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new Error(`invalid_json:${name}`) }
}

export async function validateBundle(input: string): Promise<ValidatedBundle> {
  const files = loadFiles(input)
  for (const name of REQUIRED_BUNDLE_FILES) if (!files.has(name)) throw new Error(`required_file_missing:${name}`)
  const manifest = json(files, 'jury-bundle/manifest.json')
  if (!/^RUN-[A-Za-z0-9._-]+$/.test(String(manifest.run_id))) throw new Error('manifest_run_id_invalid')
  if (!/^[a-f0-9]{64}$/.test(String(manifest.bundle_hash))) throw new Error('manifest_bundle_hash_invalid')
  const root = { run_id: manifest.run_id, created_at: manifest.created_at, feature_snapshot_hash: manifest.feature_snapshot_hash,
    strategy_snapshot_hash: manifest.strategy_snapshot_hash, schema_versions: manifest.schema_versions, candidate_hashes: manifest.candidate_hashes,
    required_codex_outputs: manifest.required_codex_outputs, files: manifest.files }
  if (await hashJson(root) !== manifest.bundle_hash) throw new Error('bundle_logical_hash_mismatch')
  for (const [name, expected] of Object.entries(manifest.files ?? {})) {
    const bytes = files.get(name)
    if (!bytes) throw new Error(`manifest_file_missing:${name}`)
    if (await sha256Hex(bytes) !== expected) throw new Error(`manifest_file_hash_mismatch:${name}`)
  }
  const candidates = json(files, 'jury-bundle/candidates.json')
  const strategies = json(files, 'jury-bundle/existing-strategies.json')
  const issues = json(files, 'jury-bundle/issues.json')
  if (!Array.isArray(candidates) || !Array.isArray(strategies) || !Array.isArray(issues)) throw new Error('bundle_array_contract_invalid')
  const candidateIds = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.run_id !== manifest.run_id) throw new Error(`candidate_run_id_mismatch:${candidate.candidate_id}`)
    if (candidateIds.has(candidate.candidate_id)) throw new Error(`candidate_id_duplicate:${candidate.candidate_id}`)
    candidateIds.add(candidate.candidate_id)
    const actual = await hashJson({ ...candidate, candidate_hash: '' })
    if (actual !== candidate.candidate_hash || manifest.candidate_hashes?.[candidate.candidate_id] !== actual) throw new Error(`candidate_hash_mismatch:${candidate.candidate_id}`)
  }
  const issueIds = new Set<string>()
  for (const issue of issues) {
    if (issue.run_id !== manifest.run_id) throw new Error(`issue_run_id_mismatch:${issue.issue_id}`)
    if (issueIds.has(issue.issue_id)) throw new Error(`issue_id_duplicate:${issue.issue_id}`)
    issueIds.add(issue.issue_id)
  }
  if (JSON.stringify([...REQUIRED_RESULT_FILES].sort()) !== JSON.stringify([...(manifest.required_codex_outputs ?? [])].sort())) throw new Error('required_codex_outputs_mismatch')
  return { source: resolve(input), files, manifest, candidates, strategies, issues }
}
