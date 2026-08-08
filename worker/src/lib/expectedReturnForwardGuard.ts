export type ExpectedReturnForwardGuardState = {
  model_name: 'allocator_ev_fusion'
  artifact_id: string
  model_fingerprint: string
  model_version: string
  state: 'monitoring' | 'residual_bypass'
  evaluable_date_count: number
  degraded_streak: number
  recovery_streak: number
  last_prediction_date: string
  evidence_json: string
  updated_at: string
}

export async function loadExpectedReturnForwardGuard(
  db: D1Database,
): Promise<ExpectedReturnForwardGuardState | null> {
  try {
    return await db.prepare(`
      SELECT model_name, artifact_id, model_fingerprint, model_version, state,
             evaluable_date_count, degraded_streak, recovery_streak,
             last_prediction_date, evidence_json, updated_at
        FROM expected_return_forward_guard_state
       WHERE model_name = 'allocator_ev_fusion'
       LIMIT 1
    `).first<ExpectedReturnForwardGuardState>()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table: expected_return_forward_guard_state')) return null
    throw error
  }
}

export function isExactActiveForwardGuard(
  guard: ExpectedReturnForwardGuardState | null | undefined,
  artifactId: string | null | undefined,
  modelFingerprint: string | null | undefined,
): boolean {
  return Boolean(
    guard?.state === 'residual_bypass'
    && artifactId
    && modelFingerprint
    && guard.artifact_id === artifactId
    && guard.model_fingerprint === modelFingerprint
  )
}
