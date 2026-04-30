# OSV Remediation Result

## 1. Summary

- Date: 2026-04-30
- Repository: `stockvision-cloudflare-v12`
- Original report: `osv-report-before.json` copied from `osv-report.json`
- New reports: `osv-report-after.json`, `osv-report-after.html`
- Total vulnerable packages before: 31
- Total vulnerable packages after: 2
- High severity packages before: 20
- Critical severity packages before: 4
- High severity packages after: 1
- Critical severity packages after: 0

Impact summary:

- Fixed Worker runtime/dev-tool vulnerabilities around Hono, Wrangler, Miniflare, Undici, Defu, and Esbuild.
- Fixed backend runtime vulnerabilities in `aiohttp`, `Starlette`, `Jinja2`, `Mako`, `Pillow`, `zipp`, `tqdm`, and `langsmith`.
- Fixed Shioaji proxy dependency risks from very old `requests`, `orjson`, and `filelock`.
- Frontend build-tool vulnerabilities were mostly fixed, but `lodash` remains blocked because the OSV patched `4.18.0` release breaks the current Workbox/Vite PWA build.
- Upgraded `torch` and LangGraph-family packages after compatibility review; `transformers` remains intentionally unchanged because Chronos requires `transformers <5`.

## 2. Changed Files

```text
frontend/package.json
frontend/package-lock.json
worker/package.json
worker/package-lock.json
ml-service/requirements.txt
ml-controller/requirements.txt
ml-controller/graphs/daily_pipeline_v2.py
shioaji-proxy/requirements.txt
osv-report-after.json
osv-report-after.html
osv-report-before.json
OSV_REMEDIATION_RESULT.md
```

## 3. Fixed Packages

| Area | Package | Before | After | Direct/Transitive | Reason |
|---|---:|---:|---|---|---|
| worker | hono | 4.12.8 | 4.12.14 | Direct | Runtime router package; patched request handling vulnerabilities. |
| worker | wrangler | 3.x / vulnerable tree | 4.86.0 | Direct devDependency | Updates Worker tooling tree and removes vulnerable `defu` path; also matches repo runtime baseline using Wrangler 4. |
| worker | undici | 5.29.0 | 7.24.8 | Transitive | Removed vulnerable HTTP client version via Wrangler 4 dependency tree. |
| worker | esbuild | 0.17.19 | 0.27.3 | Transitive | Removes vulnerable dev server/build binary path. |
| worker | defu | 6.1.4 | removed from tree | Transitive | Vulnerable transitive package no longer installed after Wrangler 4 update. |
| frontend | vite | 7.3.1 | 7.3.2 | Direct devDependency | Nearest patched Vite 7.x release; avoids jumping framework major. |
| frontend | serialize-javascript | 6.0.2 | 7.0.5 | Transitive override | Fixes serialization XSS/prototype pollution risk in Workbox/Terser path. |
| frontend | picomatch | 4.0.3 | 4.0.4 | Transitive override | Fixes glob pattern ReDoS risk. |
| frontend | postcss | 8.5.8 | 8.5.10 | Transitive override | Fixes stylesheet parser vulnerability. |
| frontend | brace-expansion | 2.0.2 | 2.0.3 | Transitive override | Fixes brace pattern ReDoS risk. |
| ml-controller | fastapi | 0.115.6 | 0.121.0 | Direct | Parent framework updated to allow patched Starlette 0.49.1. |
| ml-controller | starlette | 0.41.3 / 0.47.2 | 0.49.1 | Direct pin added | Fixes multipart/form parsing DoS risk reported by OSV. |
| ml-controller | aiohttp | 3.9.5 | 3.13.5 | Direct | Fixes HTTP client/server parsing and request handling vulnerabilities. |
| ml-controller | Jinja2 | 3.1.4 | 3.1.6 | Direct | Fixes template sandbox/security advisory. |
| ml-controller | Mako | 1.3.9 | 1.3.11 | Direct | Fixes template handling advisory. |
| ml-controller | tqdm | 4.9.0 | 4.66.3 | Direct | Fixes terminal escape/control sequence advisory. |
| ml-controller | langsmith | 0.7.9 | 0.7.31 | Direct | Fixes LangSmith client advisory. |
| ml-controller | langchain-core | 0.3.84 | 1.2.28 | Direct pin added | Fixes LangChain Core advisories while keeping Python 3.11+ compatibility. |
| ml-controller | langgraph | 0.2.74 | 1.0.10 | Direct | Fixes LangGraph checkpoint-loading advisory; graph compile smoke passed. |
| ml-controller | langgraph-checkpoint | 2.1.2 | 4.0.0 | Transitive to direct | Fixes checkpoint deserialization/RCE advisories. |
| ml-controller | langgraph-checkpoint-sqlite | 2.0.11 | removed | Direct removed | Package was imported but unused; sqlite checkpointing is disabled and not durable in Cloud Run `/tmp`. Removing it avoids an unused vulnerable owner. |
| ml-service | fastapi | 0.115.0 | 0.121.0 | Direct | Parent framework updated to allow patched Starlette 0.49.1. |
| ml-service | starlette | 0.38.6 / 0.47.2 | 0.49.1 | Direct pin added | Fixes multipart/form parsing DoS risk reported by OSV. |
| ml-service | aiohttp | 3.9.5 | 3.13.5 | Direct | Fixes HTTP client/server parsing and request handling vulnerabilities. |
| ml-service | Pillow | 9.5.0 / >=10.3.0 | >=12.2.0 | Direct | Fixes image parsing vulnerabilities. |
| ml-service | Mako | 1.3.9 | 1.3.11 | Direct | Fixes template handling advisory. |
| ml-service | zipp | 3.9.1 | >=3.19.1 | Direct | Fixes archive path traversal related advisory. |
| ml-service | torch | 2.3.1 | 2.8.0 | Direct | Fixes remaining PyTorch advisories while preserving `transformers==4.57.6` via Chronos constraints. |
| shioaji-proxy | requests | 2.9.2 | 2.33.0 | Direct | Fixes very old HTTP client vulnerabilities and TLS handling issues. |
| shioaji-proxy | orjson | 3.9.9 | 3.11.6 | Direct | Fixes JSON parser advisory. |
| shioaji-proxy | filelock | 3.9.1 | 3.20.3 | Direct | Fixes lockfile/symlink related advisory. |

## 4. Remaining Vulnerabilities

| Area | Package | Version | Severity | Reason Not Fixed | Required User Decision |
|---|---:|---:|---:|---|---|
| frontend | lodash | 4.17.21 | 8.1 | OSV patched `4.18.0` is published as a bad release and breaks the current Workbox/Vite PWA build with `assignWith is not defined`. | Decide whether to replace the parent chain (`recharts` / `vite-plugin-pwa` / `workbox-build`) or accept temporary risk until ecosystem fix. |
| ml-service | transformers | 4.57.6 | 6.5 | User explicitly chose not to move it now; resolver confirms `chronos-forecasting` requires `transformers <5`, while OSV fixed version is `5.0.0rc3`. | Decide later whether to isolate Chronos into a separate image/service or accept the temporary exception. |

## 5. Manual Review Required

- `transformers`: fixed version is prerelease `5.0.0rc3`; current Chronos dependency requires `<5`, so do not upgrade inside the same image without redesign.
- Modal torch runtime: `torch==2.8.0` resolves for Linux/Python 3.11/CUDA 12.6, but production deployment still needs Modal image build and model artifact smoke tests.
- `lodash`: patched `4.18.0` was tested and broke frontend production build, so it is documented as blocked rather than force-applied.
- npm overrides: used only for transitive build/dev packages where parent upgrades were not the smallest safe path.

## 6. Test Results

```text
worker npm run type-check: pass
worker contract tests via scripts/p9_gate.ps1: pass
frontend npm run build: pass
ml-controller import smoke test: pass
ml-controller pip check: pass
ml-controller tests/test_verify_pipeline_graph.py: pass
ml-controller daily_pipeline_v2 build_graph smoke: pass
ml-service requirements dry-run for Linux/Python 3.11/CUDA 12.6: pass; resolves torch==2.8.0+cu126 and keeps transformers==4.57.6
ml-service import smoke test: pass
ml-service uv pip check: pass
shioaji-proxy temp venv install/import smoke: pass
osv-scanner re-scan JSON/HTML: generated; scanner exit code remains 1 because 2 documented vulnerabilities remain
scripts/p9_gate.ps1: pass
```

Notes:

- Full `pip install -r ml-controller/requirements.txt` in the local Python 3.14 environment is blocked by `numpy==1.26.4` source build/compiler constraints. The touched packages were installed and verified directly in the project venv instead.
- `uv pip check` initially hit local cache permission denial and passed after rerun with the same command under approved elevated execution.
- Local `ml-service/.venv` does not currently contain `torch`; torch validation was done by resolver against the Modal target platform rather than installing a large local wheel.

## 7. Breaking Change Risk

Low:

- `aiohttp`, `Jinja2`, `Mako`, `Pillow`, `zipp`, `tqdm`, `orjson`, `filelock`, frontend transitive overrides: patch/minor updates validated by import/build checks.

Medium:

- `FastAPI 0.121.0 + Starlette 0.49.1`: framework update required to reach patched Starlette. Import smoke and verify contract tests passed, but full Cloud Run smoke should still be done before production deploy.
- `Wrangler 4.86.0`: dev tooling major update, but it aligns with the documented repo baseline that Wrangler 4 is the working path for remote D1.
- `requests 2.33.0`: large jump from a very old version in Shioaji proxy. Import smoke passed, but live Shioaji proxy endpoint smoke should be done before trading-session reliance.
- `LangGraph 1.0.10 + langchain-core 1.2.28 + checkpoint 4.0.0`: graph compile smoke and verify tests passed; production should still get Cloud Run smoke after deploy approval.

High:

- `torch 2.8.0`: resolves for Modal CUDA 12.6, but can affect FT-Transformer/PatchTST/DLinear/Chronos runtime behavior and image size; deploy requires Modal image build plus batch predict smoke.
- `transformers`: left untouched because Chronos currently blocks the fixed major/prerelease version.

## 8. Next Recommended Action

1. Keep this dependency remediation branch undeployed until normal production deploy approval.
2. Before production deploy, build Modal image and run FT/DLinear/PatchTST/Chronos import + one batch predict smoke.
3. Decide whether `lodash` risk is handled by replacing/upgrading the parent PWA/chart dependency chain or by accepting a temporary documented exception.
4. Decide later whether `transformers` should be isolated with Chronos in a separate image/service.
