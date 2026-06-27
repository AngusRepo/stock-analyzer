import type { Bindings } from '../types'
import { runBottomUpScreener } from '../lib/marketScreener'
import { RestD1Database, RestKVNamespace, createNoopQueue } from './cloudflareRestBindings'

type Args = {
  date?: string
  runId?: string
  json: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--date') args.date = argv[++i]
    else if (arg === '--run-id') args.runId = argv[++i]
    else if (arg === '--json') args.json = true
  }
  return args
}

function twToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

function resolveRunDate(value?: string): string {
  const trimmed = (value || '').trim()
  if (!trimmed) return twToday()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`Invalid screener date: ${trimmed}; expected YYYY-MM-DD`)
  }
  return trimmed
}

function buildBindings(): Bindings {
  const env = process.env
  return {
    DB: RestD1Database.fromEnv(),
    KV: RestKVNamespace.fromEnv(),
    UPDATE_QUEUE: createNoopQueue(),
    NEWS_QUEUE: createNoopQueue(),
    JWT_SECRET: env.JWT_SECRET ?? '',
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID ?? '',
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET ?? '',
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? '',
    GEMINI_API_KEY: env.GEMINI_API_KEY ?? '',
    FINMIND_TOKEN: env.FINMIND_TOKEN ?? '',
    ML_SERVICE_URL: env.ML_SERVICE_URL ?? '',
    ML_CONTROLLER_URL: env.ML_CONTROLLER_URL || env.ML_CONTROLLER_PUBLIC_URL || '',
    ML_CONTROLLER_SECRET: env.ML_CONTROLLER_SECRET ?? '',
    ADMIN_EMAIL: env.ADMIN_EMAIL ?? '',
    RESEND_API_KEY: env.RESEND_API_KEY ?? '',
    ENVIRONMENT: env.ENVIRONMENT ?? 'production',
    STOCKVISION_AUTH_TOKEN: env.STOCKVISION_AUTH_TOKEN ?? '',
    DISCORD_WEBHOOK_URL: env.DISCORD_WEBHOOK_URL ?? '',
    FINLAB_DAILY_PRICE_PRIMARY_ENABLED: env.FINLAB_DAILY_PRICE_PRIMARY_ENABLED,
    FINLAB_BACKFILL_MODAL_TRIGGER_ENABLED: env.FINLAB_BACKFILL_MODAL_TRIGGER_ENABLED,
    FINLAB_V4_BACKFILL_MODAL_TRIGGER_ENABLED: env.FINLAB_V4_BACKFILL_MODAL_TRIGGER_ENABLED,
    FINLAB_BACKFILL_YEARS: env.FINLAB_BACKFILL_YEARS,
    FINLAB_BACKFILL_CANONICAL_WINDOW_DAYS: env.FINLAB_BACKFILL_CANONICAL_WINDOW_DAYS,
    FINLAB_BACKFILL_GCS_BUCKET: env.FINLAB_BACKFILL_GCS_BUCKET,
    FINLAB_BACKFILL_GCS_PREFIX: env.FINLAB_BACKFILL_GCS_PREFIX,
    FINLAB_BACKFILL_CANONICAL_START_DATE: env.FINLAB_BACKFILL_CANONICAL_START_DATE,
    FINLAB_BACKFILL_CANONICAL_END_DATE: env.FINLAB_BACKFILL_CANONICAL_END_DATE,
    FINLAB_BACKFILL_CANONICAL_DATASETS: env.FINLAB_BACKFILL_CANONICAL_DATASETS,
    FINLAB_BACKFILL_CANONICAL_LIMIT_PER_DATASET: env.FINLAB_BACKFILL_CANONICAL_LIMIT_PER_DATASET,
    FINLAB_BACKFILL_CANONICAL_D1_CHUNK_SIZE: env.FINLAB_BACKFILL_CANONICAL_D1_CHUNK_SIZE,
    FINLAB_BACKFILL_LANES: env.FINLAB_BACKFILL_LANES,
    FINLAB_BACKFILL_SKIP_DIFF_COUNTS: env.FINLAB_BACKFILL_SKIP_DIFF_COUNTS,
    FINLAB_DAILY_PRICE_CANONICAL_DATASETS: env.FINLAB_DAILY_PRICE_CANONICAL_DATASETS,
    FINLAB_DAILY_PRICE_LANES: env.FINLAB_DAILY_PRICE_LANES,
    FINLAB_DAILY_PRICE_KEEP_DIFF_COUNTS: env.FINLAB_DAILY_PRICE_KEEP_DIFF_COUNTS,
  } as unknown as Bindings
}

async function latestFunnelRun(env: Bindings, date: string): Promise<{
  run_id?: string
  universe_count?: number
  candidate_count?: number
  final_count?: number
  emerging_count?: number
} | null> {
  return env.DB.prepare(`
    SELECT run_id, universe_count, candidate_count, final_count, emerging_count
      FROM screener_funnel_runs
     WHERE date = ?
       AND status = 'success'
     ORDER BY created_at DESC
     LIMIT 1
  `).bind(date).first<{
    run_id?: string
    universe_count?: number
    candidate_count?: number
    final_count?: number
    emerging_count?: number
  }>()
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const runDate = resolveRunDate(args.date)
  const runId = args.runId || `screener-node-${Date.now()}`
  const env = buildBindings()

  const startedAt = Date.now()
  const result = await runBottomUpScreener(env, runDate)
  const funnel = await latestFunnelRun(env, runDate)
  const elapsedMs = Date.now() - startedAt
  const summary = [
    `run_id=${runId}`,
    funnel?.run_id ? `screener_funnel_run_id=${funnel.run_id}` : null,
    `universe=${Number(funnel?.universe_count ?? 0)}`,
    `candidates=${Number(funnel?.candidate_count ?? 0)}`,
    `final=${Number(funnel?.final_count ?? result.candidates.length ?? 0)}`,
    `emerging=${Number(funnel?.emerging_count ?? result.emergingResearchCandidates?.length ?? 0)}`,
    `hot_sectors=${result.hotSectors.length}`,
    `duration_ms=${elapsedMs}`,
  ].filter(Boolean).join(' ')

  const payload = {
    task: 'screener',
    status: 'success',
    summary,
    duration_ms: elapsedMs,
    run_id: runId,
    run_date: runDate,
    metrics: {
      screener_funnel_run_id: funnel?.run_id ?? null,
      universe_count: Number(funnel?.universe_count ?? 0),
      candidate_count: Number(funnel?.candidate_count ?? 0),
      final_count: Number(funnel?.final_count ?? result.candidates.length ?? 0),
      emerging_count: Number(funnel?.emerging_count ?? result.emergingResearchCandidates?.length ?? 0),
      hot_sector_count: result.hotSectors.length,
      debug_log_count: result.debugLog?.length ?? 0,
    },
  }

  console.log(JSON.stringify(payload))
}

main().catch((error) => {
  const payload = {
    task: 'screener',
    status: 'error',
    summary: error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180),
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  }
  console.error(payload.error)
  console.log(JSON.stringify(payload))
  process.exitCode = 1
})
