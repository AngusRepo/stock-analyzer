import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'

const ACCOUNT_ID = '619a83ac9f20847d9e2f2920823b727d'
const MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct'
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL}`

function tokenFromToml(text) {
  const match = text.match(/^oauth_token\s*=\s*"([^"]+)"/m)
  if (!match) throw new Error('wrangler_oauth_token_not_found')
  return match[1]
}

function parseJson(value) {
  if (value && typeof value === 'object') return value
  const text = String(value ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text)
}

const stringArray = { type: 'array', items: { type: 'string' }, maxItems: 8 }
const schema = {
  type: 'object', additionalProperties: false,
  required: ['strategy_reviews', 'system_findings', 'prioritized_actions', 'limitations'],
  properties: {
    strategy_reviews: {
      type: 'array', maxItems: 26, items: {
        type: 'object', additionalProperties: false,
        required: ['handle', 'diagnosis', 'optimization_actions', 'falsification_tests', 'confidence'],
        properties: {
          handle: { type: 'string' },
          diagnosis: { type: 'string' },
          optimization_actions: stringArray,
          falsification_tests: stringArray,
          confidence: { enum: ['low', 'medium', 'high'] },
        },
      },
    },
    system_findings: stringArray,
    prioritized_actions: stringArray,
    limitations: stringArray,
  },
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function main() {
  const reportPath = resolve(process.argv[2] ?? '')
  if (!reportPath) throw new Error('pymoo_report_path_required')
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const failed = report.strategies.filter((row) => row.gate_class !== 'pass')
  const handleMap = Object.fromEntries(failed.map((row, index) => [row.strategy_id, `S${String(index + 1).padStart(2, '0')}`]))
  const payload = {
    schema_version: 'stockvision-anonymous-strategy-health-review-v1',
    evidence_cutoff: report.as_of_date,
    method: report.method,
    instruction: [
      'Diagnose each failed strategy from aggregate evidence only.',
      'Separate evidence insufficiency from economic failure.',
      'Recommend bounded changes and executable falsification tests.',
      'Do not recommend relaxing production gates, automatic promotion, weight changes, or retraining from this evidence alone.',
      'Treat Pareto rank as diagnostic, not proof of alpha.',
    ],
    strategies: failed.map((row) => ({
      handle: handleMap[row.strategy_id],
      lifecycle: row.status,
      bucket: row.alpha_bucket,
      gate_class: row.gate_class,
      evidence_failures: row.evidence_failures,
      economic_failures: row.economic_failures,
      pareto_rank: row.pymoo_pareto_rank,
      evidence_shape: {
        evaluable_decisions: row.evaluable_decisions,
        unavailable_decisions: row.unavailable_decisions,
        match_rate: row.match_rate,
        samples: row.samples,
        mature_dates: row.mature_dates,
      },
      economics: {
        hit_rate: row.hit_rate,
        avg_cost_net_return: row.avg_return,
        max_drawdown: row.max_drawdown,
        date_return_lcb90: row.date_return_lcb90,
        max_abs_return_correlation: row.max_abs_return_correlation,
      },
    })),
  }
  const configPath = join(process.env.APPDATA ?? '', 'xdg.config', '.wrangler', 'config', 'default.toml')
  const token = tokenFromToml(await readFile(configPath, 'utf8'))
  const messages = [
    { role: 'system', content: 'You are an independent quantitative-strategy health reviewer. All identifiers are opaque. Your output is an E0/E1 hypothesis until repository and executable-test verification. Return exactly one JSON object matching the guided schema; do not use Markdown.' },
    { role: 'user', content: JSON.stringify(payload) },
  ]
  const response = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens: 2400, temperature: 0.1, guided_json: schema }),
  })
  const envelope = await response.json()
  if (!response.ok || envelope.success === false) {
    throw new Error(`mistral_call_failed:${response.status}:${JSON.stringify(envelope.errors ?? envelope)}`)
  }
  const transport = envelope.result ?? envelope
  const rawValue = transport.response ?? transport.result ?? transport.choices?.[0]?.message?.content ?? transport
  const rawOutputPath = resolve(dirname(reportPath), 'mistral-strategy-health-review.raw.txt')
  await writeFile(rawOutputPath, typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue, null, 2), 'utf8')
  const parsed = parseJson(rawValue)
  const allowed = new Set(Object.values(handleMap))
  if (!Array.isArray(parsed.strategy_reviews) || parsed.strategy_reviews.some((row) => !allowed.has(row.handle))) {
    throw new Error('mistral_schema_or_handle_validation_failed')
  }
  const reverse = Object.fromEntries(Object.entries(handleMap).map(([id, handle]) => [handle, id]))
  const result = {
    schema_version: 'stockvision-mistral-strategy-health-review-v1',
    generated_at: new Date().toISOString(),
    source_type: 'REAL',
    evidence_level: 'E0_E1_HYPOTHESIS',
    model_id: MODEL,
    input_hash: sha256(JSON.stringify(payload)),
    outbound_privacy: 'anonymous_handles_and_aggregate_metrics_only',
    strategy_reviews: parsed.strategy_reviews.map((row) => ({ ...row, strategy_id: reverse[row.handle] })),
    system_findings: parsed.system_findings,
    prioritized_actions: parsed.prioritized_actions,
    limitations: parsed.limitations,
    usage: transport.usage ?? null,
  }
  const outputPath = resolve(dirname(reportPath), 'mistral-strategy-health-review.json')
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ output_path: outputPath, reviews: result.strategy_reviews.length, model: MODEL }))
}

await main()
