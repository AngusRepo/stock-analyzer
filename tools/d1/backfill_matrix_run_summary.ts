// Backfill the strategy_label_matrix_runs_v4 count summary (learning 0065) for
// ready runs promoted before it. NOT run automatically; production use needs
// Wei's go. Preconditions: learning migration 0065 applied AND the Worker that
// maintains the summary deployed (an older Worker's challenger projection does
// not clear summaries). Run outside the evening chain / d1-heavy windows.
//
//   npx tsx tools/d1/backfill_matrix_run_summary.ts                 # dry run: lists runs to summarise
//   npx tsx tools/d1/backfill_matrix_run_summary.ts --confirm --limit 20 --pause-ms 3000
//   npx tsx tools/d1/backfill_matrix_run_summary.ts --since 2026-08-18   # frontier start (default)
//
// Each run is one UPDATE that reads that run's cells once through the matrix
// primary key (signal_date leading), about 21k rows, and writes one header row.
// Re-running is safe: only ready runs with summary_version IS NULL are listed.
// Rollback: UPDATE strategy_label_matrix_runs_v4 SET summary_version=NULL
// (readers then count cells again); also required after a Worker rollback.
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  matrixRunSummaryRefreshBinds,
  matrixRunSummaryRefreshSql,
} from '../../worker/src/lib/strategyLabelMatrixRunSummary'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const workerDir = join(root, 'worker')
const DATABASE = 'stockvision-learning-db'

function flag(name: string): string | true | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const next = process.argv[index + 1]
  return next && !next.startsWith('--') ? next : true
}

const confirm = flag('confirm') === true
const limit = Math.max(1, Math.min(200, Number(flag('limit') ?? 20)))
const pauseMs = Math.max(1000, Number(flag('pause-ms') ?? 3000))
const since = String(flag('since') ?? '2026-08-18')
if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`invalid --since ${since}`)

// wrangler d1 execute takes no bind parameters; inline only validated literals.
function literal(value: string): string {
  if (!/^[A-Za-z0-9._|:@-]+$/.test(value)) throw new Error(`unsafe literal: ${value}`)
  return `'${value}'`
}

function bindInline(sql: string, binds: string[]): string {
  let index = 0
  const out = sql.replace(/\?/g, () => {
    if (index >= binds.length) throw new Error('bind count mismatch')
    return literal(binds[index++])
  })
  if (index !== binds.length) throw new Error('bind count mismatch')
  return out
}

function d1(sql: string): Array<Record<string, unknown>> {
  const raw = execFileSync('npx', ['wrangler', 'd1', 'execute', DATABASE, '--remote', '--json', '--command', sql], {
    cwd: workerDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  const parsed = JSON.parse(raw) as Array<{ results?: Array<Record<string, unknown>>; success?: boolean }>
  if (!parsed.every((item) => item.success !== false)) throw new Error(`d1 execute failed: ${raw.slice(0, 500)}`)
  return parsed.flatMap((item) => item.results ?? [])
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function main(): Promise<void> {
  // Header-only listing: idx_strategy_label_matrix_runs_v4_date (signal_date, status, ...).
  const pending = d1(`
    SELECT producer_run_id, signal_date, expected_cell_count
      FROM strategy_label_matrix_runs_v4
     WHERE signal_date>=${literal(since)} AND status='ready' AND summary_version IS NULL
     ORDER BY signal_date DESC
     LIMIT ${limit}
  `)
  console.log(JSON.stringify({ mode: confirm ? 'confirm' : 'dry_run', since, limit, pending: pending.length }))
  for (const run of pending) {
    const producerRunId = String(run.producer_run_id)
    const signalDate = String(run.signal_date)
    if (!confirm) {
      console.log(JSON.stringify({ would_summarise: producerRunId, signalDate, cells: run.expected_cell_count }))
      continue
    }
    d1(bindInline(matrixRunSummaryRefreshSql(' AND mr.summary_version IS NULL'), matrixRunSummaryRefreshBinds(producerRunId, signalDate)))
    const [after] = d1(`
      SELECT summary_version, summary_matrix_rows, summary_contract_rows, expected_cell_count
        FROM strategy_label_matrix_runs_v4 WHERE producer_run_id=${literal(producerRunId)}
    `)
    console.log(JSON.stringify({ summarised: producerRunId, signalDate, ...after }))
    await sleep(pauseMs)
  }
}

void main()
