// NEW-1030-22 operator dry run: turn a read-only dump of stuck post-verify receipts into CAS statements.
//   npx tsx scripts/postVerifyReceiptReconcile.ts <receipts.json> <stages.json> [<verdicts.json> <YYYYMMDD>] > reconcile.sql
// Inputs are `wrangler d1 execute ... --json` outputs of the two SELECTs in post-verify-receipt-dryrun.sh. The optional
// verdicts file is a JSON array of { receipt_key, verdict: 'no-effect' | 'keep-error', reason, critical? } for receipts
// that need a manual judgment (EC-F), and the date stamps the settled receipts (Taiwan date the operator decided).
// Writes nothing: prints a report on stderr and the guarded UPDATEs on stdout. Running them needs Wei go.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { POST_VERIFY_RETRY_SAFE_TASKS, closeExpiredPostVerifyReceipt } from '../src/lib/postVerifyTaskCheckpoint'
import { postVerifyDigest } from '../src/lib/postVerifyEffectScope'

const RUNNING = 'post_verify_task_v1:running'
const ERROR = 'post_verify_task_v1:error'
const UNCERTAIN = 'post_verify_task_v1:uncertain'

function rows<T>(file: string): T[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  // wrangler --json prints [{ results: [...], success, meta }]
  const results = Array.isArray(parsed) ? parsed.flatMap((entry: any) => entry?.results ?? []) : parsed?.results
  if (!Array.isArray(results)) throw new Error(`unexpected wrangler json: ${file}`)
  return results as T[]
}
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`
// Same rule as the checkpoint's lease reclaim: flagged retry-safe, or a task on the list whatever an earlier revision
// stored (EC-F: the 11/2 strategy-evidence-current claim was stored as retrySafe:false).
// An independent-effect claim (LIVE-AUTH-B) closes as an ERROR the non-retry-safe task never reruns, as in the checkpoint.
const reclaimable = (receipt: { task?: string; retrySafe?: boolean; independentEffect?: boolean }) =>
  receipt.retrySafe === true || receipt.independentEffect === true || POST_VERIFY_RETRY_SAFE_TASKS.includes(String(receipt.task))

export type ReceiptRow = { receipt_key: string; state: string; business_date: string; receipt_json: string; updated_at?: string }
export type StageRow = { business_date: string; status: string; lease_owner: string | null; lease_live: number }
export type Verdict = { receipt_key: string; verdict: 'no-effect' | 'keep-error'; reason: string; critical?: boolean }

/** The operator's terminal receipt: an ERROR result naming the verdict, reason and what the producer had reported, with a
 * fresh checksum so the checkpoint accepts it (identity, task and predecessor are unchanged). The digest of the original
 * receipt links it back to the dump, since the row itself is overwritten. */
async function operatorSettledReceipt(receiptJson: string, verdict: Verdict['verdict'], reason: string,
  critical: boolean | undefined): Promise<string> {
  const { checksum: _stale, ...receipt } = JSON.parse(receiptJson) as Record<string, any>
  const previous = receipt.result as { status?: string; summary?: string } | undefined
  const settled: Record<string, any> = { ...receipt, result: { task: receipt.task, status: 'error',
    ...(critical === undefined ? {} : { critical }),
    // sha256 of the raw receipt_json bytes, so `shasum -a 256` over the dumped value matches.
    evidence: { operator_verdict: verdict, original_receipt_sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(receiptJson))), byte => byte.toString(16).padStart(2, '0')).join('') },
    summary: `post_verify_operator_settled_${verdict.replace('-', '_')}:${receipt.task}:${reason.slice(0, 512)}; original=`
      + (previous ? `${previous.status}: ${previous.summary}` : `running lease_owner=${receipt.leaseOwner}`).slice(0, 1024) } }
  settled.checksum = await postVerifyDigest(settled)
  return JSON.stringify(settled)
}

/** Guarded CAS statements closing running receipts of retry-safe tasks whose stage lease is not live, plus one report
 * line each. A task that is not retry-safe may have half-applied effects, and an uncertain one has an unknown outcome:
 * both stay blocked until the operator judges them with a verdict.
 * - no-effect: the producer changed nothing. The receipt moves to an archive key as ERROR, so the task runs again.
 * - keep-error: the date keeps this task as failed. The receipt is closed in place as ERROR and the task does not rerun
 *   while the checkpoint identity (source, version, root ticket, trading:config) is unchanged; a critical task then
 *   leaves that date's chain in error, while the claim no longer blocks the other tasks. The chain counts a result
 *   without `critical` as critical, so a running receipt (which has no result yet) needs it in the verdict. A retry-safe
 *   task reruns over any ERROR receipt, so it takes only no-effect.
 * An invalid verdict (unknown key, receipt that is not waiting for one, missing reason) fails the whole batch. */
export async function reconcileStatements(receipts: ReceiptRow[], stageRows: StageRow[], verdicts: Verdict[] = [],
  settledOn = ''): Promise<{ statements: string[]; report: Record<string, unknown>[] }> {
  const stages = new Map(stageRows.map(row => [row.business_date, row]))
  const statements: string[] = [], report: Record<string, unknown>[] = []
  const judged = new Map<string, Verdict>()
  for (const entry of verdicts) {
    if (!['no-effect', 'keep-error'].includes(entry?.verdict)) throw new Error(`verdict_unknown:${entry?.receipt_key}:${entry?.verdict}`)
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) throw new Error(`verdict_reason_missing:${entry.receipt_key}`)
    if (judged.has(entry.receipt_key)) throw new Error(`verdict_duplicate:${entry.receipt_key}`)
    const row = receipts.find(receipt => receipt.receipt_key === entry.receipt_key)
    if (!row) throw new Error(`verdict_receipt_not_in_dump:${entry.receipt_key}`)
    const stored = JSON.parse(row.receipt_json) as { task?: string; retrySafe?: boolean; result?: { critical?: boolean } }
    if (row.state !== UNCERTAIN && !(row.state === RUNNING && !reclaimable(stored))) {
      throw new Error(`verdict_receipt_needs_no_judgment:${entry.receipt_key}:${row.state}`)
    }
    if (entry.critical !== undefined && typeof entry.critical !== 'boolean') throw new Error(`verdict_critical_invalid:${entry.receipt_key}`)
    if (entry.verdict === 'keep-error') {
      if (POST_VERIFY_RETRY_SAFE_TASKS.includes(String(stored.task))) throw new Error(`verdict_keep_error_on_retry_safe_task:${entry.receipt_key}`)
      const recorded = stored.result?.critical
      if (recorded === undefined && entry.critical === undefined) throw new Error(`verdict_critical_missing:${entry.receipt_key}`)
      if (recorded !== undefined && entry.critical !== undefined && entry.critical !== recorded) {
        throw new Error(`verdict_critical_conflicts_with_receipt:${entry.receipt_key}`)
      }
    }
    judged.set(entry.receipt_key, { ...entry, reason: entry.reason.trim() })
  }
  if (judged.size && !/^\d{8}$/.test(settledOn)) throw new Error(`verdict_settled_date_invalid:${settledOn}`)
  for (const row of receipts) {
    const stage = stages.get(row.business_date)
    // Operator closes only while no post-verify run of the date holds a live lease (its own reclaim may be under way).
    const liveLease = Boolean(stage && stage.status === 'running' && Number(stage.lease_live) === 1)
    const verdict = judged.get(row.receipt_key)
    if (verdict) {
      const stale = JSON.parse(row.receipt_json) as { task?: string; claim?: unknown; result?: { critical?: boolean } }
      const settled = await operatorSettledReceipt(row.receipt_json, verdict.verdict, verdict.reason,
        stale.result?.critical ?? (verdict.verdict === 'keep-error' ? verdict.critical : undefined))
      // The claim id keeps a second settlement of the same task on the same day from colliding with the first.
      const suffix = typeof stale.claim === 'string' && stale.claim ? stale.claim : await postVerifyDigest(row.receipt_json)
      const archiveKey = `${row.receipt_key}:operator-settled-no-effect:${settledOn}:${suffix.slice(0, 8)}`
      report.push({ business_date: row.business_date, receipt_key: row.receipt_key, task: stale.task ?? null, state: row.state,
        verdict: verdict.verdict, reason: verdict.reason, ...(verdict.verdict === 'no-effect' ? { archive_key: archiveKey } : {}),
        action: liveLease ? 'skip: the date\'s post_verify_chain lease is live'
          : verdict.verdict === 'no-effect' ? 'archive as ERROR so the task runs again (CAS below)'
          : 'close in place as ERROR; the task does not run again (CAS below)' })
      if (liveLease) continue
      statements.push(`UPDATE post_verify_task_receipts_v1 SET ${verdict.verdict === 'no-effect' ? `receipt_key=${literal(archiveKey)},` : ''}`
        + `state=${literal(ERROR)},receipt_json=${literal(settled)},updated_at=CURRENT_TIMESTAMP
 WHERE receipt_key=${literal(row.receipt_key)} AND state=${literal(row.state)} AND receipt_json=${literal(row.receipt_json)}
   AND NOT EXISTS(SELECT 1 FROM pipeline_stage_runs WHERE business_date=${literal(row.business_date)} AND stage='post_verify_chain'
     AND status='running' AND lease_expires_at>=CURRENT_TIMESTAMP)
 RETURNING receipt_key;`)
      continue
    }
    // An uncertain receipt blocks the date as well, but its outcome is unknown: report it, never close it without a verdict.
    if (row.state === UNCERTAIN) {
      const task = (JSON.parse(row.receipt_json) as { task?: string }).task ?? null
      report.push({ business_date: row.business_date, receipt_key: row.receipt_key, task, state: row.state,
        action: 'report only: uncertain receipt still blocks this date; settle it with a verdict' })
      continue
    }
    if (row.state !== RUNNING) continue
    const closed = await closeExpiredPostVerifyReceipt(row.receipt_json)
    const flag = (JSON.parse(row.receipt_json) as { retrySafe?: boolean }).retrySafe
    const retrySafe = reclaimable(JSON.parse(row.receipt_json))
    report.push({ business_date: row.business_date, receipt_key: row.receipt_key, task: closed.task,
      lease_owner: closed.leaseOwner, retry_safe: flag ?? 'legacy',
      stage_status: stage?.status ?? 'missing', stage_lease_owner: stage?.lease_owner ?? null,
      action: !retrySafe ? 'skip: not retry-safe, settle its effects with a verdict'
        : liveLease ? 'skip: the date\'s post_verify_chain lease is live' : 'close as ERROR (CAS below)' })
    if (!retrySafe || liveLease) continue
    // Same transition as the checkpoint's own lease reclaim: exact old row, and no live post-verify lease at all.
    statements.push(`UPDATE post_verify_task_receipts_v1 SET state=${literal(ERROR)},receipt_json=${literal(closed.receiptJson)},updated_at=CURRENT_TIMESTAMP
 WHERE receipt_key=${literal(row.receipt_key)} AND state=${literal(RUNNING)} AND receipt_json=${literal(row.receipt_json)}
   AND NOT EXISTS(SELECT 1 FROM pipeline_stage_runs WHERE business_date=${literal(row.business_date)} AND stage='post_verify_chain'
     AND status='running' AND lease_expires_at>=CURRENT_TIMESTAMP)
 RETURNING receipt_key;`)
  }
  return { statements, report }
}

async function main() {
  const [receiptsFile, stagesFile, verdictsFile, settledOn] = process.argv.slice(2)
  if (!receiptsFile || !stagesFile) throw new Error('usage: postVerifyReceiptReconcile.ts <receipts.json> <stages.json> [<verdicts.json> <YYYYMMDD>]')
  const verdicts = verdictsFile ? JSON.parse(readFileSync(verdictsFile, 'utf8')) as Verdict[] : []
  if (!Array.isArray(verdicts)) throw new Error(`verdicts must be a JSON array: ${verdictsFile}`)
  const { statements, report } = await reconcileStatements(rows<ReceiptRow>(receiptsFile), rows<StageRow>(stagesFile),
    verdicts, settledOn ?? '')
  for (const line of report) console.error(JSON.stringify(line))
  console.log(statements.join('\n'))
  console.error(JSON.stringify({ cas_statements: statements.length }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch((error) => { throw error })
