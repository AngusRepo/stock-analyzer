export const WORKER_RUNTIME_VERSION = 'worker-mvc-refactor-2026-04-25'
export const CONTROL_PLANE_VERSION = 'control-plane-cutover-2026-04-25'
export const SCHEDULER_MODEL_VERSION = 'scheduler-status-v2'

export type WorkerVersionMetadata = {
  id: string
  tag?: string
  timestamp: string
}

export function buildWorkerHealthPayload(metadata?: WorkerVersionMetadata) {
  return {
    status: 'ok' as const,
    time: new Date().toISOString(),
    runtimeVersion: WORKER_RUNTIME_VERSION,
    controlPlaneVersion: CONTROL_PLANE_VERSION,
    schedulerModelVersion: SCHEDULER_MODEL_VERSION,
    provenance: {
      schema: 'v1' as const,
      provider: 'cloudflare-workers' as const,
      versionId: metadata?.id ?? '',
      sourceSha: metadata?.tag ?? '',
      deployedAt: metadata?.timestamp ?? '',
      attested: Boolean(metadata?.id && metadata?.tag),
    },
  }
}
