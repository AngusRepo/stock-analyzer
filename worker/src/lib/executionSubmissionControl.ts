import type { Bindings } from '../types'

// R17 Worker client: forwards admin pause/resume/state to the controller, which
// owns the durable chain. A lost ACK is reported as unknown, never as a stop or
// a resume, and the request is never retried here.
type Env = Pick<Bindings, 'ML_CONTROLLER_URL' | 'ML_CONTROLLER_SECRET'>

export type ExecutionControlCommand =
  | { kind: 'state' }
  | { kind: 'pause'; request_id: string; actor: string; reason: string }
  | {
    kind: 'resume'; request_id: string; actor: string; reason: string
    approval_scope: string; approval_expires_at: string; gate_receipt_sha256: string
  }

const STATES = new Set(['live_submission_paused', 'live_submission_open'])
const SHA256 = /^[0-9a-f]{64}$/

function invalid(command: ExecutionControlCommand): boolean {
  if (command.kind === 'state') return false
  const bounded = (value: string, limit: number) => !value.trim() || value.length > limit
  if (bounded(command.request_id, 128) || bounded(command.actor, 160) || bounded(command.reason, 500)) return true
  if (command.kind === 'resume') {
    return bounded(command.approval_scope, 200) || bounded(command.approval_expires_at, 64)
      || !SHA256.test(command.gate_receipt_sha256)
  }
  return false
}

export async function executionSubmissionControl(
  env: Env,
  command: ExecutionControlCommand,
  fetchFn: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const base = env.ML_CONTROLLER_URL?.trim().replace(/\/$/, '')
  const token = env.ML_CONTROLLER_SECRET?.trim()
  if (!base || !token) return { status: 'blocked', reason: 'execution_control_config_incomplete' }
  if (invalid(command)) return { status: 'blocked', reason: 'execution_control_request_invalid' }
  const { kind, ...body } = command
  const path = kind === 'state' ? 'submission-state' : kind === 'pause' ? 'return-to-paper' : 'resume'
  try {
    const response = await fetchFn(`${base}/finlab/execution/${path}`, {
      method: kind === 'state' ? 'GET' : 'POST',
      headers: { 'X-Controller-Token': token, 'Content-Type': 'application/json' },
      ...(kind === 'state' ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    })
    const payload = await response.json() as Record<string, unknown>
    if (response.status === 409) return { status: 'rejected', reason: String(payload?.detail ?? 'execution_control_conflict') }
    if (response.ok && payload && STATES.has(String(payload.status))) {
      const receipt = (kind === 'resume' ? payload.resume_receipt : payload.receipt) as Record<string, unknown> | undefined
      if (kind === 'pause' && (payload.status !== 'live_submission_paused' || !receipt?.sha256
        || receipt.action !== 'pause' || payload.pause_confirmed === false)) {
        return { status: 'unknown', reason: 'paper_return_unconfirmed_read_submission_state', controller: payload }
      }
      if (kind === 'resume' && (!receipt?.sha256 || receipt.action !== 'resume')) {
        return { status: 'unknown', reason: 'resume_unconfirmed_read_submission_state', controller: payload }
      }
      return payload
    }
  } catch { /* fall through: unconfirmed */ }
  return {
    status: 'unknown',
    reason: kind === 'state' ? 'live_submission_state_unavailable' : `${kind}_unconfirmed_read_submission_state`,
  }
}
