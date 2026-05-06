export const WORKER_RUNTIME_VERSION = 'worker-mvc-refactor-2026-04-25'
export const CONTROL_PLANE_VERSION = 'control-plane-cutover-2026-04-25'
export const SCHEDULER_MODEL_VERSION = 'scheduler-status-v2'

export function buildWorkerHealthPayload() {
  return {
    status: 'ok' as const,
    time: new Date().toISOString(),
    runtimeVersion: WORKER_RUNTIME_VERSION,
    controlPlaneVersion: CONTROL_PLANE_VERSION,
    schedulerModelVersion: SCHEDULER_MODEL_VERSION,
  }
}
