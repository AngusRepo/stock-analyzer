import type { Bindings } from '../types'
import { STRATEGY_DISCOVERY_SCHEMA_VERSION } from './config'
import { StrategyDiscoveryArtifacts } from './artifacts'
import { buildCodexConclusion, validateCodexResultZip } from './codexResult'
import { contentAddressedKey, sha256Hex, stableStringify } from './hashing'
import { StrategyDiscoveryRepository, type ArtifactManifestInput } from './repositories'

export async function importCodexResult(input: { env: Bindings; runId: string; idempotencyKey: string; bytes: Uint8Array }) {
  const repository = new StrategyDiscoveryRepository(input.env.DB)
  const replay = await repository.codexImportByIdempotency(input.runId, input.idempotencyKey)
  if (replay) return { run_id: input.runId, status: 'RESULT_READY', result_hash: replay.result_hash, idempotent_replay: true }
  const run = await repository.getRun(input.runId)
  if (!run) throw new Error('codex_run_not_found')
  if (!['CODEX_HANDOFF_READY', 'AWAITING_RESULT'].includes(run.status)) throw new Error(`codex_run_not_importable:${run.status}`)
  const bundleArtifact = await repository.artifact(input.runId, 'jury-bundle')
  if (!bundleArtifact) throw new Error('codex_jury_bundle_missing')
  const artifactStore = new StrategyDiscoveryArtifacts(input.env.ARTIFACTS, repository)
  const bundleBytes = await artifactStore.getBytes(bundleArtifact.r2_key, bundleArtifact.artifact_hash)
  const validated = await validateCodexResultZip({ runId: input.runId, resultBytes: input.bytes, bundleBytes })
  const resultHash = String(validated.manifest.result_hash)
  const duplicate = await repository.codexImportByResultHash(input.runId, resultHash)
  if (duplicate) return { run_id: input.runId, status: 'RESULT_READY', result_hash: duplicate.result_hash, idempotent_replay: true }
  const conclusion = buildCodexConclusion(validated)
  const conclusionBytes = new TextEncoder().encode(stableStringify(conclusion))
  const zipHash = await sha256Hex(input.bytes)
  const conclusionHash = await sha256Hex(conclusionBytes)
  const resultKey = contentAddressedKey(input.runId, 'codex-result', zipHash, 'zip')
  const conclusionKey = contentAddressedKey(input.runId, 'codex-conclusion', conclusionHash, 'json')
  const bucket = input.env.ARTIFACTS
  if (!bucket) throw new Error('strategy_discovery_r2_binding_missing')
  const put = async (key: string, bytes: Uint8Array, contentType: string, artifactType: string, hash: string) => {
    await bucket.put(key, bytes, { httpMetadata: { contentType }, customMetadata: { sha256: hash, runId: input.runId, artifactType } })
    const head = await bucket.head(key)
    if (!head || Number(head.size) !== bytes.byteLength) throw new Error(`codex_r2_write_verification_failed:${artifactType}`)
  }
  await put(resultKey, input.bytes, 'application/zip', 'codex-result', zipHash)
  try { await put(conclusionKey, conclusionBytes, 'application/json', 'codex-conclusion', conclusionHash) }
  catch (error) { await bucket.delete?.(resultKey).catch(() => undefined); throw error }
  const manifest = (artifactType: string, key: string, hash: string, contentType: string, size: number): ArtifactManifestInput => ({
    artifact_id: `${input.runId}:${artifactType}:${hash.slice(0, 16)}`, run_id: input.runId, artifact_type: artifactType,
    r2_key: key, artifact_hash: hash, content_type: contentType, byte_size: size, schema_version: STRATEGY_DISCOVERY_SCHEMA_VERSION,
    metadata: { bundle_hash: validated.manifest.bundle_hash, result_hash: resultHash },
  })
  try {
    await repository.persistCodexImport({ runId: input.runId, importId: `${input.runId}:import:${resultHash.slice(0, 16)}`,
      idempotencyKey: input.idempotencyKey, resultHash, bundleHash: validated.manifest.bundle_hash,
      resultArtifact: manifest('codex-result', resultKey, zipHash, 'application/zip', input.bytes.byteLength),
      conclusionArtifact: manifest('codex-conclusion', conclusionKey, conclusionHash, 'application/json', conclusionBytes.byteLength),
      strategyVerdicts: validated.strategyVerdicts, candidateVerdicts: validated.candidateVerdicts, issueVerdicts: validated.issueVerdicts,
      modelAccuracy: conclusion.red_team_accuracy })
  } catch (error) {
    await Promise.all([bucket.delete?.(resultKey), bucket.delete?.(conclusionKey)].filter(Boolean)).catch(() => undefined)
    const race = await repository.codexImportByIdempotency(input.runId, input.idempotencyKey).catch(() => null)
    if (race) return { run_id: input.runId, status: 'RESULT_READY', result_hash: race.result_hash, idempotent_replay: true }
    throw error
  }
  return { run_id: input.runId, status: 'RESULT_READY', result_hash: resultHash, idempotent_replay: false }
}
