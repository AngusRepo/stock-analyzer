// NEW-1030-22 operator dry run: turn a read-only dump of stuck post-verify receipts into CAS statements.
//   npx tsx scripts/postVerifyReceiptReconcile.ts <receipts.json> <stages.json> > reconcile.sql
// Inputs are `wrangler d1 execute ... --json` outputs of the two SELECTs in post-verify-receipt-dryrun.sh.
// Writes nothing: prints a report on stderr and the guarded UPDATEs on stdout. Running them needs Wei go.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { POST_VERIFY_RETRY_SAFE_TASKS, closeExpiredPostVerifyReceipt } from '../src/lib/postVerifyTaskCheckpoint'

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

export type ReceiptRow = { receipt_key: string; state: string; business_date: string; receipt_json: string; updated_at?: string }
export type StageRow = { business_date: string; status: string; lease_owner: string | null; lease_live: number }

/** Guarded CAS statements closing running receipts of retry-safe tasks whose stage lease is not live, plus one report
 * line each. A task that is not retry-safe may have half-applied effects: it is reported for manual reconciliation. */
export async function reconcileStatements(receipts: ReceiptRow[], stageRows: StageRow[]): Promise<{ statements: string[]; report: Record<string, unknown>[] }> {
  const stages = new Map(stageRows.map(row => [row.business_date, row]))
  const statements: string[] = [], report: Record<string, unknown>[] = []
  for (const row of receipts) {
    // An uncertain receipt blocks its task as well, but its outcome is unknown: report it, never close it here.
    if (row.state === UNCERTAIN) {
      const task = (JSON.parse(row.receipt_json) as { task?: string }).task ?? null
      report.push({ business_date: row.business_date, receipt_key: row.receipt_key, task, state: row.state,
        action: 'report only: uncertain receipt still blocks this task; reconcile by hand' })
      continue
    }
    if (row.state !== RUNNING) continue
    const closed = await closeExpiredPostVerifyReceipt(row.receipt_json)
    const stage = stages.get(row.business_date)
    // Operator closes only while no post-verify run of the date holds a live lease (its own reclaim may be under way).
    const liveLease = Boolean(stage && stage.status === 'running' && Number(stage.lease_live) === 1)
    // Same rule as the checkpoint's reclaim: flagged retry-safe, or a legacy receipt of a listed task.
    const flag = (JSON.parse(row.receipt_json) as { retrySafe?: boolean }).retrySafe
    const retrySafe = flag === true || (flag === undefined && POST_VERIFY_RETRY_SAFE_TASKS.includes(closed.task))
    report.push({ business_date: row.business_date, receipt_key: row.receipt_key, task: closed.task,
      lease_owner: closed.leaseOwner, retry_safe: flag ?? 'legacy',
      stage_status: stage?.status ?? 'missing', stage_lease_owner: stage?.lease_owner ?? null,
      action: !retrySafe ? 'skip: not retry-safe, reconcile its effects by hand'
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
  const [receiptsFile, stagesFile] = process.argv.slice(2)
  if (!receiptsFile || !stagesFile) throw new Error('usage: postVerifyReceiptReconcile.ts <receipts.json> <stages.json>')
  const { statements, report } = await reconcileStatements(rows<ReceiptRow>(receiptsFile), rows<StageRow>(stagesFile))
  for (const line of report) console.error(JSON.stringify(line))
  console.log(statements.join('\n'))
  console.error(JSON.stringify({ cas_statements: statements.length }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch((error) => { throw error })
