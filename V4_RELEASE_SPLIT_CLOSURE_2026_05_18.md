# V4 Release Split Closure - 2026-05-18

## Scope

This file records the release split for the current V4/V4.1 worktree so CPD,
docs, data artifacts, and git release governance do not get mixed together.

- Workspace: `C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12`
- Branch: `feature/ml-pool-v1`
- HEAD at audit time: `fa17986f2b12ea3dcef7837932f5b2666b367d53`
- Audit time: `2026-05-18 14:09:46 +08:00`
- Policy: no deploy, retrain, commit, push, or real order action without Wei's explicit approval.

## Obsidian Recall Receipt

`wiki_tool.py start-task --project-slug v4-refactor --query "V4 release split CPD closure ml-controller modal docs data"` returned:

- status: `ready`
- guard: `ok`
- latest session: `02_Products/StockVision/Sessions/2026-05-17-v4-30-ops-safety-contract.draft.md`
- graphify latest: `03_Tooling/Graphify/stockvision-v4-poc-20260516-104828/GRAPH_REPORT.md`
- receipt citations:
  - `02_Products/StockVision/.../MOC-StockVision.md`
  - `06_MOC/MOC-Home.md`
  - `02_Products/StockVision/Sessions/2026-05-16-v4-22-ml-research-challenger-registry.draft.md`
  - `02_Products/StockVision/Sessions/2026-05-16-v4-27a-p1a-data-quality-visual-workbench.draft.md`
  - `02_Products/StockVision/Sessions/2026-05-16-v4-dagster-read-only-asset-check-functions.draft.md`

## Worktree Inventory

Current tracked diff:

- `95` tracked files changed.
- Prefix breakdown: `worker=43`, `ml-controller=30`, `frontend=15`, `ml-service=2`, root docs/config files.

Current untracked deploy/doc candidates:

- `169` untracked files after artifact ignore cleanup.
- Prefix breakdown: `ml-controller=69`, `worker=26`, `frontend=21`, `tools=15`, `data=10`, `ml-service=1`, root markdown docs.

Ignored local artifacts now include:

- `.tmp/`
- `worker/.tmp/`
- `data/tmp/`
- `data/finlab_remote_backfill/`
- `data/finlab_canonical_materialized/`

These ignored paths are intentionally not runtime source-of-truth. Large
backfill/materialization files should be promoted to GCS/R2 or regenerated from
the recorded source manifests, not committed to git.

## Stream 1 - Runtime Deployable

### Worker / Pages Runtime

Local runtime changes include:

- FinLab canonical-first market/chip loading.
- Emerging broker proxy chip scoring.
- Daily recommendation response enrichment that replaces V3-style institutional wording for emerging names when broker evidence exists.
- Scheduler, paper-active challenger, dashboard, market regime, Breeze2, and evidence wiring touched across worker/frontend.

Local verification:

- `worker`: `npm run type-check` passed.
- `frontend`: `npm run build` passed outside sandbox after sandbox-only esbuild `spawn EPERM`.

CPD status:

- `pending_approval`.
- The local fix is buildable, but this manifest does not claim Pages/Worker production parity because no deploy was executed in this closure step.

### ml-controller Runtime

Local runtime changes include:

- FinLab canonical/backfill/materialization services.
- Dagster asset/check runtime definitions.
- Breeze2 router and Modal client hook.
- Paper challenger and promotion metadata.
- Market regime V4 evidence and regime producer wiring.
- Recommendation payload and scoring changes for FinLab broker proxy chip evidence.

Local verification:

- Targeted pytest passed: `29 passed`.
- Covered files/tests:
  - `test_recommendation_provenance.py`
  - `test_finlab_canonical_materializer.py`
  - `test_finlab_dagster_runtime_contract.py`
  - `test_external_evidence_runtime.py`
  - `test_breeze2_router.py`
  - `test_breeze2_modal_contract.py`
- `deploy_ml_controller.sh --check-only` passed.

Live read-only state:

- Latest ready revision: `ml-controller-00253-wk6`
- Service URL: `https://ml-controller-jnmn3apxvq-de.a.run.app`
- Image digest: `sha256:1a5e8c614e2577d79164317e8ad62b15b578fe464781df109d5e8506257f3d55`
- Service/job/verify/optuna image sync: `OK`
- Runtime resources: `cpu=4`, `memory=4Gi`, `concurrency=40`, `max_scale=5`
- Required env keys present, including `FINLAB_API_KEY`, `CF_API_TOKEN`, `STOCKVISION_AUTH_TOKEN`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`.

CPD status:

- `preflight_closed`, `deploy_pending_approval`.
- The live service is internally synced, but it is not proven to contain every current local file because this closure step did not deploy a new image.

### ml-service / Modal Runtime

Local runtime changes include:

- `ml-service/app/breeze2_context.py`
- `/breeze2/research-context` FastAPI endpoint.
- Modal function `breeze2_research_context`.

Local verification:

- `py_compile` passed for:
  - `ml-service/app/main.py`
  - `ml-service/app/breeze2_context.py`
  - `ml-service/modal_app.py`
- Modal read-only app list works and shows deployed apps for StockVision/QuantaAlpha.

CPD status:

- `local_closed`, `modal_deploy_pending_approval`.
- The local Breeze2 context function is syntactically valid, but deployed Modal function parity has not been proven by this manifest.

## Stream 2 - Docs Commit Candidates

Root markdown candidates are safe to review as repo docs:

- `BACKTEST_REALITY_CONTRACT.md`
- `BREEZE2_RESEARCH_CONTEXT.md`
- `DASHBOARD_V4_CONTRACT.md`
- `DECISION_ENGINE_CONTRACT.md`
- `EXTERNAL_EVIDENCE_CONTRACT.md`
- `FINLAB_*`
- `FRONTEND_LIGHTWEIGHT_CHARTS_AUDIT.md`
- `GLOBAL_CONTEXT_READINESS.md`
- `LANGGRAPH_DEBATE_CONTRACT.md`
- `MARKET_REGIME_STATE_CONTRACT.md`
- `ML_RESEARCH_CHALLENGERS.md`
- `PROMOTION_GATE_CONTRACT.md`
- `STOCKVISION_V4_REFACTOR_ROADMAP.md`
- `V4_CLOSURE_AUDIT.md`
- `V4_DELETION_CANDIDATES.md`
- `V4_OPS_SAFETY_CONTRACT.md`
- `V4_RELEASE_SPLIT_CLOSURE_2026_05_18.md`

Status:

- `ready_for_review`.
- Not committed or pushed in this closure step.

## Stream 3 - Data Artifact Routing

Commit candidate data manifests:

- `data/data_source_inventory.json`
- `data/finlab_research/adoption_plan.json`
- `data/finlab_research/api_fields.json`
- `data/finlab_research/article_index.json`
- `data/finlab_research/article_notes.json`
- `data/finlab_research/dagster_asset_graph.json`
- `data/finlab_research/dagster_definitions_payload.json`
- `data/finlab_research/emerging_watchlist_manifest.json`
- `data/finlab_research/feature_lake_manifest.json`
- `data/finlab_research/sector_flow_shadow_manifest.json`

Non-commit data artifacts:

- `data/finlab_remote_backfill/`
- `data/finlab_canonical_materialized/`
- `data/tmp/`
- `.tmp/`
- `worker/.tmp/`

Status:

- `split_closed`.
- The large/backfill/runtime-output folders are ignored locally and should be moved to GCS/R2 only through an explicit artifact promotion step.

## Stream 4 - Git / Release Governance

Current status:

- Branch is dirty.
- No commit created.
- No push created.
- No merge to `main`.
- No PR created.
- No deploy executed in this closure step.

Release gates still requiring explicit approval:

1. Deploy Worker/Pages runtime.
2. Deploy `ml-controller`.
3. Deploy Modal `ml-service`.
4. Commit selected runtime/docs/data manifests.
5. Push branch or open PR.
6. Delete ignored tmp/backfill local artifacts, if desired.

Recommended release order:

1. Stage and commit the runtime source plus `.gitignore` in a focused commit.
2. Stage and commit docs/data manifests separately.
3. Deploy Worker/Pages and run live smoke tests.
4. Deploy `ml-controller` and verify `/health`, env parity, and 2026-05-15/2026-05-18 readbacks.
5. Deploy Modal Breeze2 context and verify the `breeze2_research_context` path from `ml-controller`.
6. Only after production parity is proven, push/PR/merge according to Wei's chosen release path.

## Verification Evidence

Fresh commands run during this closure:

- `worker`: `npm run type-check` -> passed.
- `frontend`: `npm run build` -> passed outside sandbox; generated production build in `dist/`.
- `ml-controller`: targeted pytest -> `29 passed`.
- `ml-service`: `py_compile` -> passed.
- `ml-controller`: `deploy_ml_controller.sh --check-only` -> passed, no deploy.
- `gcloud run services describe ml-controller ...` -> read-only state captured.
- `modal app list` -> read-only Modal app list captured.

## Final Status

The four streams are now split and auditable:

- Runtime source: local verified, deployment pending approval.
- Docs: ready for review/commit.
- Data artifacts: split into commit candidates vs ignored large runtime outputs.
- Git release: not closed by design because commit/push/merge/deploy require explicit approval.

## CPD-Ready Local Addendum

Updated at: `2026-05-18 14:30 +08:00`

### Packaging Hygiene

CPD packaging was tightened after finding that `gcloud run deploy --source .`
would otherwise upload local caches and data artifacts that are not copied by
the root Dockerfile.

Files updated:

- `.dockerignore`
- `.gcloudignore`

Source upload verification:

- `gcloud meta list-files-for-upload` now reports `250` files.
- Top-level upload scope is limited to:
  - `ml-controller`
  - `ml-service`
  - `Dockerfile`
  - `.dockerignore`
  - `data/finlab_research/dagster_asset_graph.json`
  - `tools/finlab_v4_remote_backfill.py`
- Explicitly absent from the upload sample:
  - `frontend/`
  - `worker/`
  - `.uv-python/`
  - `.uv-cache/`
  - `.venv/`
  - `_external/`
  - `data/finlab_remote_backfill/`
  - `data/finlab_canonical_materialized/`

### Fresh Local Gate Evidence

`scripts/p9_gate.ps1` passed in sandbox-external mode after ignore cleanup:

- Worker type-check: passed.
- Worker contract tests: passed.
- ml-controller contract tests: `39 passed`, `1 warning`.
- Frontend production build: passed.
- `git diff --check`: passed.
- P12 secret scan: no tracked secret leaks detected.

Additional CPD checks:

- `deploy_ml_controller.sh --check-only`: passed, no deploy.
- Live `ml-controller` env drift: no missing required env keys.
- Live service/job/verify/optuna image sync: `OK`.
- Live runtime resources: `cpu=4`, `memory=4Gi`, `concurrency=40`, `max_scale=5`.
- `ml-service` Breeze2 context syntax check: `py_compile` passed.

### Worktree State For CPD

The worktree is intentionally dirty because deployment, commit, and push still
require explicit approval. Current counts after local CPD preparation:

- `git status --short`: `236` status rows.
- tracked diffs: `96` files.
- untracked non-ignored files: `171` files.

This is acceptable for a local CPD run from the current workspace because the
non-source local artifacts are ignored for git and excluded from Cloud Run
source upload. It is not a git-release-complete state.

### CPD Gate

Local state is ready for Wei-approved CPD.

Do not run any of the following without explicit approval:

- Worker deploy.
- Pages deploy.
- `ml-controller` deploy.
- Modal deploy.
- commit.
- push.
- retrain.
- real order action.
