import { hashJson } from './hashing'
import type { StrategyDiscoveryArtifacts } from './artifacts'
import type { StrategyDiscoveryRepository } from './repositories'

export interface CheckpointExecution<T> { value: T; reused: boolean; inputHash: string; outputHash: string }

export async function runCheckpoint<T>(input: {
  runId: string
  stepId: string
  stepInput: unknown
  repository: Pick<StrategyDiscoveryRepository, 'checkpoint' | 'saveCheckpoint'>
  artifacts: Pick<StrategyDiscoveryArtifacts, 'putJson' | 'getBytes' | 'exists'>
  compute: () => Promise<T>
}): Promise<CheckpointExecution<T>> {
  const inputHash = await hashJson(input.stepInput)
  const existing = await input.repository.checkpoint(input.runId, input.stepId)
  if (existing?.status === 'COMPLETED' && existing.input_hash === inputHash
    && await input.artifacts.exists(existing.artifact_r2_key, existing.artifact_hash)) {
    const bytes = await input.artifacts.getBytes(existing.artifact_r2_key, existing.artifact_hash)
    return { value: JSON.parse(new TextDecoder().decode(bytes)) as T, reused: true, inputHash, outputHash: existing.output_hash }
  }
  const value = await input.compute()
  const outputHash = await hashJson(value)
  const stored = await input.artifacts.putJson(input.runId, `checkpoint-${input.stepId}`, value, { step_id: input.stepId, input_hash: inputHash })
  await input.repository.saveCheckpoint({
    run_id: input.runId,
    step_id: input.stepId,
    input_hash: inputHash,
    output_hash: outputHash,
    artifact_r2_key: stored.key,
    artifact_hash: stored.hash,
    status: 'COMPLETED',
    metadata: { reused: false },
  })
  return { value, reused: false, inputHash, outputHash }
}
