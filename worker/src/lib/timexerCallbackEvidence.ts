/** Reference to Controller's immutable evidence; never infer model health here. */
export interface TimeXerOutcomeReceipt {
  path: string
  checksum: string
  observation_status: 'sealed_l3' | 'l3_evidence_not_recorded'
  pipeline_status: 'success' | 'error'
}

export interface TimeXerCallbackEvidence {
  timexer_evidence_receipt?: TimeXerOutcomeReceipt
  timexer_recorder_error?: string
}

export async function timexerCallbackEvidence(
  body: Record<string, unknown>,
  runDate: string | undefined,
  runId: string | undefined,
): Promise<TimeXerCallbackEvidence> {
  const receipt = body.timexer_evidence_receipt
  const error = body.timexer_recorder_error
  if (receipt === undefined && error === undefined) return {}
  const invalid = () => new Error('timexer_callback_evidence_invalid')
  if (body.task !== 'pipeline' || !['success', 'error'].includes(String(body.status))
      || !runDate || !/^\d{4}-\d{2}-\d{2}$/.test(runDate) || !runId
      || (receipt !== undefined && error !== undefined)) throw invalid()
  if (error !== undefined) {
    if (typeof error !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(error)) throw invalid()
    return { timexer_recorder_error: error }
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw invalid()
  const ref = receipt as Record<string, unknown>
  if (typeof ref.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(ref.checksum)
      || ref.pipeline_status !== body.status
      || !['sealed_l3', 'l3_evidence_not_recorded'].includes(String(ref.observation_status))) throw invalid()
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(runId))
  const runHash = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
  if (ref.path !== `pipeline-v2/premarket/${runDate}/${runHash}/timexer-outcomes/${ref.checksum}.json`) throw invalid()
  return { timexer_evidence_receipt: {
    path: ref.path as string,
    checksum: ref.checksum,
    observation_status: ref.observation_status as TimeXerOutcomeReceipt['observation_status'],
    pipeline_status: ref.pipeline_status as TimeXerOutcomeReceipt['pipeline_status'],
  } }
}
