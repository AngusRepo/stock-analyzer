export type ExecutionEventKind = 'execution' | 'debate'

export interface StructuredExecutionEvent {
  kind: ExecutionEventKind
  status: string
  reason: string
  detail?: string | null
}

function cleanPart(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, '_')
    .replace(/:/g, '-')
    .trim()
}

export function formatExecutionEvent(event: StructuredExecutionEvent): string {
  const base = `${cleanPart(event.kind)}:${cleanPart(event.status)}:${cleanPart(event.reason)}`
  const detail = cleanPart(event.detail)
  return detail ? `${base}:${detail}` : base
}

export function formatExecutionStatusEvent(status: string, reason: string, detail?: string | null): string {
  return formatExecutionEvent({ kind: 'execution', status, reason, detail })
}

export function formatDebateEvent(status: string, reason: string, detail?: string | null): string {
  return formatExecutionEvent({ kind: 'debate', status, reason, detail })
}

export function parseExecutionEvent(raw: string): StructuredExecutionEvent | null {
  const [kind, status, reason, ...detailParts] = raw.split(':')
  if ((kind !== 'execution' && kind !== 'debate') || !status || !reason) return null
  return {
    kind,
    status,
    reason,
    detail: detailParts.length > 0 ? detailParts.join(':') : null,
  }
}
