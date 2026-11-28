// D1 capacity errors, one list for the Worker's retry predicates (strategyLearningRecoveryWatchdog
// isTransientD1Overload), the scheduler-ticket overload query (/v1/d1/overloaded) and the monitoring panels' reason
// words (errorBrief). Not a native paper identity input (d1TransientRetry.ts is; this file is not imported there).

/** The exact substrings /v1/d1/overloaded matches with instr() in SQL (case-sensitive there). */
export const D1_OVERLOAD_MARKERS = ['D1 DB is overloaded', 'Requests queued for too long'] as const
/** A dropped D1 connection: retried like an overload, but it does not show the database was overloaded. */
export const D1_CONNECTION_LOST = 'Network connection lost'
/** Every D1 capacity message, matched in any case: an overload, a busy or locked database, a storage operation that
 * ran out of time and reset the object, a dropped connection. */
export const D1_CAPACITY_MARKERS = [...D1_OVERLOAD_MARKERS, 'SQLITE_BUSY', 'database is locked', 'storage operation exceeded timeout',
  D1_CONNECTION_LOST] as const
/** The D1 REST API's rate limit and server errors (ml-controller and the tools call D1 over HTTP). */
const D1_HTTP_CAPACITY = /D1 request failed:\s*HTTP\s*(?:429|5\d\d)/i
/** The codes a D1 overload or rate limit is filed under: marketScreener's D1 error classifier (d1_overloaded) and
 * ml-service's serving resolver (d1_rate_limited). */
export const D1_OVERLOAD_CODES = ['d1_overloaded', 'd1_rate_limited'] as const

/** A transient D1 capacity error (retryable). A deterministic D1_ERROR (bad SQL, a constraint) does not match. */
export function isD1CapacityError(message: string): boolean {
  const lower = message.toLowerCase()
  return D1_CAPACITY_MARKERS.some((marker) => lower.includes(marker.toLowerCase())) || D1_HTTP_CAPACITY.test(message)
}
