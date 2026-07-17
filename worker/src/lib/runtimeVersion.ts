export const WORKER_RUNTIME_VERSION = 'worker-s12-stop-latch-2026-07-17'
export const CONTROL_PLANE_VERSION = 'control-plane-cutover-2026-04-25'
export const SCHEDULER_MODEL_VERSION = 'scheduler-status-v2'

type WorkerVersionMetadata = {
  id?: string
  tag?: string
  timestamp?: string
}

export function buildWorkerHealthPayload(version?: WorkerVersionMetadata) {
  return {
    status: 'ok' as const,
    time: new Date().toISOString(),
    runtimeVersion: WORKER_RUNTIME_VERSION,
    controlPlaneVersion: CONTROL_PLANE_VERSION,
    schedulerModelVersion: SCHEDULER_MODEL_VERSION,
    deployment: version ? { id: version.id ?? null, tag: version.tag ?? null, timestamp: version.timestamp ?? null } : null,
  }
}
