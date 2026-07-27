import type { Bindings } from '../types'
import { assertAllocatorContractRunDate } from './allocatorContractGuard'
import {
  RestD1Database,
  RestEvidenceArtifactReader,
  RestEvidenceArtifactWriter,
  RestKVNamespace,
  createNoopQueue,
} from './cloudflareRestBindings'
import {
  runS12DurableStructureBatch,
  type S12DurableRunSource,
} from '../lib/s12DurableStructureBatch'

type Args = {
  date?: string
  runId?: string
  source?: S12DurableRunSource
}

function parseArgs(argv: string[]): Args {
  const args: Args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--date') args.date = argv[++i]
    else if (arg === '--run-id') args.runId = argv[++i]
    else if (arg === '--source') args.source = argv[++i] as S12DurableRunSource
  }
  return args
}

function twToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

function buildBindings(): Bindings {
  const env = process.env
  return {
    DB: RestD1Database.fromEnv(),
    KV: RestKVNamespace.fromEnv(),
    EVIDENCE_ARTIFACT_WRITER: RestEvidenceArtifactWriter.fromEnv(),
    EVIDENCE_ARTIFACT_READER: RestEvidenceArtifactReader.fromEnv(),
    UPDATE_QUEUE: createNoopQueue(),
    NEWS_QUEUE: createNoopQueue(),
    JWT_SECRET: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    ANTHROPIC_API_KEY: '',
    GEMINI_API_KEY: '',
    FINMIND_TOKEN: '',
    ML_SERVICE_URL: env.ML_SERVICE_URL ?? '',
    ML_CONTROLLER_URL: env.ML_CONTROLLER_URL || env.ML_CONTROLLER_PUBLIC_URL || '',
    ML_CONTROLLER_SECRET: env.ML_CONTROLLER_SECRET ?? '',
    ADMIN_EMAIL: '',
    RESEND_API_KEY: '',
    ENVIRONMENT: env.ENVIRONMENT ?? 'production',
    STOCKVISION_AUTH_TOKEN: env.STOCKVISION_AUTH_TOKEN ?? '',
    S12_RESEARCH_KBARS_URL: env.S12_RESEARCH_KBARS_URL ?? '',
    PROXY_SERVICE_TOKEN: env.PROXY_SERVICE_TOKEN ?? '',
    S12_INTRADAY_KBARS_ENABLED: 'true',
  } as unknown as Bindings
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const runDate = String(args.date || process.env.S12_STRUCTURE_RUN_DATE || twToday()).slice(0, 10)
  assertAllocatorContractRunDate(runDate, 's12 structure batch node runner')
  const runId = String(
    args.runId || process.env.S12_STRUCTURE_RUN_ID || `s12-structure-${runDate}-${Date.now()}`,
  )
  const source = String(
    args.source || process.env.S12_STRUCTURE_RUN_SOURCE || 'evening_chain',
  ) as S12DurableRunSource
  if (!['evening_chain', 'historical_shadow', 'manual_repair'].includes(source)) {
    throw new Error(`invalid_s12_structure_run_source:${source}`)
  }
  const summary = await runS12DurableStructureBatch(buildBindings(), runDate, {
    runId,
    source,
    shardSize: Number(process.env.S12_STRUCTURE_SHARD_SIZE || 48),
    concurrency: Number(process.env.S12_STRUCTURE_CONCURRENCY || 12),
  })
  console.log(JSON.stringify({
    task: 's12-structure-batch',
    status: 'success',
    run_id: runId,
    run_date: runDate,
    summary,
  }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  console.log(JSON.stringify({
    task: 's12-structure-batch',
    status: 'error',
    run_id: process.env.S12_STRUCTURE_RUN_ID || null,
    run_date: process.env.S12_STRUCTURE_RUN_DATE || null,
    summary: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
  }))
  process.exitCode = 1
})
