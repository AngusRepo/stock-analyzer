import type { Bindings } from '../types'

type Env = Pick<Bindings, 'ML_CONTROLLER_URL' | 'ML_CONTROLLER_SECRET'>

export async function executionSubmissionControl(
  env: Env,
  command: { request_id: string; reason: string } | null,
  fetchFn: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const base = env.ML_CONTROLLER_URL?.trim().replace(/\/$/, '')
  const token = env.ML_CONTROLLER_SECRET?.trim()
  if (!base || !token) return { status: 'blocked', reason: 'execution_control_config_incomplete' }
  if (command && (!command.request_id.trim() || command.request_id.length > 128
    || !command.reason.trim() || command.reason.length > 500)) {
    return { status: 'blocked', reason: 'paper_return_request_invalid' }
  }
  try {
    const response = await fetchFn(`${base}/finlab/execution/${command ? 'return-to-paper' : 'submission-state'}`, {
      method: command ? 'POST' : 'GET',
      headers: { 'X-Controller-Token': token, 'Content-Type': 'application/json' },
      ...(command ? { body: JSON.stringify(command) } : {}),
      signal: AbortSignal.timeout(5000),
    })
    const payload = await response.json() as Record<string, unknown>
    if (response.ok && payload && typeof payload === 'object'
      && ['live_submission_paused', 'not_paused', 'blocked', 'unknown'].includes(String(payload.status))) {
      const receipt = payload.receipt as Record<string, unknown> | undefined
      if (payload.status === 'live_submission_paused' && !receipt?.sha256) {
        return { status: 'unknown', reason: 'paper_return_receipt_missing' }
      }
      return payload
    }
  } catch { /* A lost ACK must remain unconfirmed; never enable Live or retry orders. */ }
  return { status: 'unknown', reason: 'paper_return_unconfirmed_read_submission_state' }
}
