import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createStoredZip, type ZipEntryInput } from '../../../../worker/src/strategy-discovery/zip'
import { hashJson, sha256Hex, stableStringify } from '../../../../worker/src/strategy-discovery/hashing'
import { REQUIRED_RESULT_FILES, validateBundle } from './bundle-contract'

const STRATEGY_VERDICTS = new Set(['INVALID', 'BLOCKED', 'RETEST_REQUIRED', 'SURVIVED', 'INSUFFICIENT_EVIDENCE'])
const CANDIDATE_VERDICTS = new Set(['REJECTED', 'BLOCKED', 'RETEST_REQUIRED', 'READY_FOR_LOCKED_TEST', 'INSUFFICIENT_EVIDENCE'])
const ISSUE_VERDICTS = new Set(['CONFIRMED', 'PARTIALLY_CONFIRMED', 'REFUTED', 'UNVERIFIED', 'NOT_APPLICABLE'])
const EVIDENCE_LEVELS = new Set(['E0', 'E1', 'E2', 'E3', 'E4'])

function readJson(directory: string, name: string): any {
  try { return JSON.parse(readFileSync(join(directory, name), 'utf8')) } catch { throw new Error(`invalid_json:${name}`) }
}

function exactIds(rows: any[], key: string, expected: Set<string>, label: string) {
  if (!Array.isArray(rows)) throw new Error(`${label}_array_required`)
  const ids = new Set(rows.map((row) => String(row?.[key] ?? '')))
  if (ids.size !== expected.size || [...expected].some((id) => !ids.has(id))) throw new Error(`${label}_id_coverage_mismatch`)
}

async function main() {
  const directory = resolve(process.argv[2] ?? '')
  const bundleInput = process.argv[3]
  if (!process.argv[2] || !bundleInput) throw new Error('usage: package-result.ts <audits/outbox/RUN_ID> <jury-bundle.zip-or-directory>')
  if (!statSync(directory).isDirectory()) throw new Error('outbox_directory_required')
  for (const name of REQUIRED_RESULT_FILES) try { statSync(join(directory, name)) } catch { throw new Error(`required_output_missing:${name}`) }
  const bundle = await validateBundle(bundleInput)
  if (directory.split(/[\\/]/).pop() !== bundle.manifest.run_id) throw new Error('outbox_run_id_mismatch')
  const finalVerdict = readJson(directory, 'final-verdict.json')
  if (finalVerdict.schema_version !== 'codex-final-verdict-v1' || finalVerdict.run_id !== bundle.manifest.run_id || finalVerdict.bundle_hash !== bundle.manifest.bundle_hash || !finalVerdict.executive_conclusion) throw new Error('final_verdict_contract_invalid')
  const strategyVerdicts = readJson(directory, 'strategy-verdicts.json')
  const candidateVerdicts = readJson(directory, 'candidate-verdicts.json')
  const issueVerdicts = readJson(directory, 'issue-verdicts.json')
  exactIds(strategyVerdicts, 'strategy_id', new Set(bundle.strategies.map((row) => row.strategy_id)), 'strategy_verdicts')
  exactIds(candidateVerdicts, 'candidate_id', new Set(bundle.candidates.map((row) => row.candidate_id)), 'candidate_verdicts')
  exactIds(issueVerdicts, 'issue_id', new Set(bundle.issues.map((row) => row.issue_id)), 'issue_verdicts')
  if (strategyVerdicts.some((row: any) => row.run_id !== bundle.manifest.run_id || !STRATEGY_VERDICTS.has(row.verdict))) throw new Error('strategy_verdict_invalid')
  if (candidateVerdicts.some((row: any) => row.run_id !== bundle.manifest.run_id || !CANDIDATE_VERDICTS.has(row.verdict))) throw new Error('candidate_verdict_invalid')
  for (const row of issueVerdicts) {
    if (row.run_id !== bundle.manifest.run_id || !ISSUE_VERDICTS.has(row.verdict) || !EVIDENCE_LEVELS.has(row.evidence_level)) throw new Error(`issue_verdict_invalid:${row.issue_id}`)
    if (!Array.isArray(row.evidence) || !Array.isArray(row.test_results) || !Array.isArray(row.commands_executed) || !Array.isArray(row.remaining_uncertainty)) throw new Error(`issue_evidence_arrays_required:${row.issue_id}`)
    if (row.verdict === 'CONFIRMED' && row.severity === 'FATAL' && (!['E2', 'E3', 'E4'].includes(row.evidence_level) || (!row.evidence.length && !row.test_results.length))) throw new Error(`confirmed_fatal_evidence_missing:${row.issue_id}`)
    if (['E0', 'E1'].includes(row.evidence_level) && !['UNVERIFIED', 'REFUTED', 'NOT_APPLICABLE'].includes(row.verdict)) throw new Error(`low_evidence_must_not_confirm:${row.issue_id}`)
  }
  for (const name of ['tests-executed.json', 'repository-evidence.json', 'unresolved-evidence.json', 'candidate-recommendations.json']) if (!Array.isArray(readJson(directory, name))) throw new Error(`array_required:${name}`)
  const entries: ZipEntryInput[] = REQUIRED_RESULT_FILES.map((name) => ({ name: `codex-result/${name}`, data: new Uint8Array(readFileSync(join(directory, name))) }))
  const files = Object.fromEntries(await Promise.all(entries.map(async (entry) => [entry.name, await sha256Hex(entry.data)])))
  const manifestRoot = { schema_version: 'codex-result-v1', run_id: bundle.manifest.run_id, bundle_hash: bundle.manifest.bundle_hash,
    candidate_hashes: bundle.manifest.candidate_hashes, generated_at: new Date().toISOString(), final_verdict: finalVerdict.executive_conclusion,
    required_files: [...REQUIRED_RESULT_FILES], files }
  const resultManifest = { ...manifestRoot, result_hash: await hashJson(manifestRoot) }
  entries.push({ name: 'codex-result/manifest.json', data: new TextEncoder().encode(`${stableStringify(resultManifest)}\n`) })
  const output = join(directory, 'codex-result.zip')
  writeFileSync(output, createStoredZip(entries))
  console.log(JSON.stringify({ status: 'PASS', run_id: bundle.manifest.run_id, bundle_hash: bundle.manifest.bundle_hash, result_hash: resultManifest.result_hash, output }, null, 2))
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
