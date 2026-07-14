import { validateBundle } from './bundle-contract'

async function main() {
  const input = process.argv[2]
  if (!input) throw new Error('usage: validate-bundle.ts <jury-bundle.zip-or-directory>')
  const bundle = await validateBundle(input)
  console.log(JSON.stringify({ status: 'PASS', run_id: bundle.manifest.run_id, bundle_hash: bundle.manifest.bundle_hash,
    candidates: bundle.candidates.length, strategies: bundle.strategies.length, issues: bundle.issues.length, source: bundle.source }, null, 2))
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
