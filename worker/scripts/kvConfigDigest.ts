// Operator CLI for KV config as code (Phase E-7): hash a KV value the same way the nightly task does.
//   npx tsx scripts/kvConfigDigest.ts <kv-key> <value-file> <digest-key-file>
// Prints the digest to pin in config/kv/manifest.json (runtime-owned paths come from the manifest).
// The digest key is the KV value `kv-config:digest-key`; keep its file out of the repo.
import { readFileSync } from 'node:fs'
import { kvConfigDigest, parseKvConfigManifest } from '../src/lib/kvConfigDigest'

async function main() {
  const [key, file, keyFile] = process.argv.slice(2)
  if (!key || !file || !keyFile) throw new Error('usage: kvConfigDigest.ts <kv-key> <value-file> <digest-key-file>')
  const manifest = parseKvConfigManifest(JSON.parse(readFileSync(new URL('../../config/kv/manifest.json', import.meta.url), 'utf8')))
  const entry = manifest.keys[key]
  if (!entry) throw new Error('kv_config_key_not_in_manifest:' + key)
  const digest = await kvConfigDigest(readFileSync(file, 'utf8'), entry.runtime_owned, readFileSync(keyFile, 'utf8').trim())
  console.log(JSON.stringify({ key, digest, pinned: entry.digest, match: digest === entry.digest }))
}

void main().catch((error) => { throw error })
