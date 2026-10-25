# KV config as code (Phase E-7)

- Values of the config KV keys live only in private GCS (`store` in `manifest.json`), one object per
  version: `<store><key>/<digest>.json`. This public repo holds no values.
- `manifest.json` pins each key's digest: HMAC-SHA256 of the canonical JSON (sorted keys, no
  whitespace) after removing `runtime_owned` paths. The HMAC key is the KV value `kv-config:digest-key`.
- `runtime_owned` paths are published by runtime code (OPB NAV publication / retirement) and are not
  config changes.
- Worker task `kv-config-drift` (scheduler, nightly) digests the live KV values against this file on
  `main` and fails, raising the scheduler alert, on drift.
- Digest a value: `cd worker && npx tsx scripts/kvConfigDigest.ts <kv-key> <value-file> <digest-key-file>`.
