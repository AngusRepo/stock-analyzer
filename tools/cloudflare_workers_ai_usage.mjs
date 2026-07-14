import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ACCOUNT_ID = '619a83ac9f20847d9e2f2920823b727d'
const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql'

function tokenFromToml(text) {
  const match = text.match(/^oauth_token\s*=\s*"([^"]+)"/m)
  if (!match) throw new Error('wrangler_oauth_token_not_found')
  return match[1]
}

async function graphql(token, query, variables = {}) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })
  const payload = await response.json()
  if (!response.ok || payload.errors?.length) {
    throw new Error(`cloudflare_graphql_failed:${response.status}:${JSON.stringify(payload.errors ?? payload)}`)
  }
  return payload.data
}

function unwrap(type) {
  let current = type
  while (current?.ofType) current = current.ofType
  return current?.name ?? null
}

async function main() {
  const configPath = join(process.env.APPDATA ?? '', 'xdg.config', '.wrangler', 'config', 'default.toml')
  const token = tokenFromToml(await readFile(configPath, 'utf8'))
  const now = new Date()
  const start = new Date(now)
  start.setUTCHours(0, 0, 0, 0)
  const usage = await graphql(token, `query WorkersAiUsage($accountTag: string, $start: Time, $end: Time) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        aiInferenceAdaptiveGroups(limit: 1, filter: { datetime_geq: $start, datetime_leq: $end }) {
          count
          sum { totalNeurons totalInputTokens totalOutputTokens }
        }
      }
    }
  }`, { accountTag: ACCOUNT_ID, start: start.toISOString(), end: now.toISOString() })
  const row = usage.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups?.[0]
  if (!row) throw new Error('workers_ai_usage_row_not_found')
  if (process.argv[2] !== '--schema') {
    process.stdout.write(`${JSON.stringify({
      status: 'PASS',
      source: 'Cloudflare GraphQL aiInferenceAdaptiveGroups',
      account_id: ACCOUNT_ID,
      period_start_utc: start.toISOString(),
      observed_at_utc: now.toISOString(),
      inference_count: Number(row.count ?? 0),
      total_neurons: Number(row.sum?.totalNeurons ?? 0),
      input_tokens: Number(row.sum?.totalInputTokens ?? 0),
      output_tokens: Number(row.sum?.totalOutputTokens ?? 0),
    }, null, 2)}\n`)
    return
  }
  const viewer = await graphql(token, `{
    __type(name: "viewer") {
      fields { name type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }
    }
  }`)
  const accountsField = viewer.__type?.fields?.find((field) => field.name === 'accounts')
  const accountType = unwrap(accountsField?.type)
  if (!accountType) {
    throw new Error(`cloudflare_accounts_type_not_found:${JSON.stringify(viewer.__type?.fields ?? [])}`)
  }
  const account = await graphql(token, `query AccountType($name: String!) {
    __type(name: $name) {
      fields { name description args { name type { kind name ofType { kind name } } } type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }
    }
  }`, { name: accountType })
  const aiFields = (account.__type?.fields ?? []).filter((field) => /(^ai|ai[A-Z]|inference|neuron)/i.test(field.name))
  const inferenceGroups = aiFields.find((field) => field.name === 'aiInferenceAdaptiveGroups')
  const inferenceType = unwrap(inferenceGroups?.type)
  const inference = inferenceType ? await graphql(token, `query InferenceType($name: String!) {
    __type(name: $name) {
      fields { name description type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
    }
  }`, { name: inferenceType }) : null
  const inferenceDetails = await graphql(token, `{
    sum: __type(name: "AccountAiInferenceAdaptiveGroupsSum") {
      fields { name description type { kind name ofType { kind name } } }
    }
    dimensions: __type(name: "AccountAiInferenceAdaptiveGroupsDimensions") {
      fields { name description type { kind name ofType { kind name } } }
    }
    filter: __type(name: "AccountAiInferenceAdaptiveGroupsFilter_InputObject") {
      inputFields { name description type { kind name ofType { kind name ofType { kind name } } } }
    }
  }`)
  process.stdout.write(`${JSON.stringify({
    status: 'SCHEMA_DISCOVERED',
    account_id: ACCOUNT_ID,
    account_type: accountType,
    ai_fields: aiFields.map((field) => ({ name: field.name, description: field.description, type: unwrap(field.type) })),
    inference_groups_args: inferenceGroups?.args ?? [],
    inference_groups_fields: inference?.__type?.fields ?? [],
    inference_sum_fields: inferenceDetails.sum?.fields ?? [],
    inference_dimension_fields: inferenceDetails.dimensions?.fields ?? [],
    inference_filter_fields: inferenceDetails.filter?.inputFields ?? [],
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
