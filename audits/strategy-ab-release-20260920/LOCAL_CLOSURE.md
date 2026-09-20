# Accepted A / B release: local source engineering closure

A keeps eight L3 models, replaces DLinear with official price-only TimeXer, and uses three-head L4. B uses exogenous-137 TimeXer in the same slot and three-head + 34-input scalar EV residual MLP. Both use signed EV, sparse/OPB and original native account execution.

Initial focused source verification passed; the expanded P9 and formal runtime checks below supersede the initial closure claim. Controller regression: 1,233 passed (1,205 initial passes plus all 28 schema-fixture failures repaired and rerun). Focused history/OOF tests 57 passed; native L4 role/lifecycle tests 26 passed; snapshot/L4 tests 21 passed. Final Worker type-check, 12 contract cases and frontend build pass. Previous desktop/mobile rendering covers ready, empty and misaligned live pairs. Final A/B real frozen native frames and exact retries pass; original zero exposure limits remain zero, with no invented NAV maturity.

Full native CUDA TimeXer jobs validate 268,570 windows per variant: A 3 selected epochs, B 4. B complete three-head -> MLP immutable job and export/evaluator checks pass. These engineering artifacts use a clearly labeled code-inventory identity, never a fabricated Git release identity.

Expanded-history snapshot maps for all 2,789 stocks are byte-logically identical by canonical SHA256. Peak RSS 2,863.61 -> 1,475.91 MiB; time 7.031 -> 5.181 seconds, excluding network. No feature, stock or history truncation. Formal v4 prep preserves full137 tree policy, 1,280-row regime-independent history and expanded source selection. New v4 OOF bootstrap uses new L4 before production activation; B refreshes its MLP.

The page separates frozen research results from prospective A/B accounts. Rebates are max(0, charged-max(20, charged*0.25)), nominal next month day10, receivable only until confirmed payment. A/B must share calendar, baseline and initial capital; cash, holdings and OPB rewards remain independent.

## Deployment and strategy gates

This is code closure, not a claim of production activation or efficacy. Next: commit-pinned source deployment, formal immutable A/B eight-model OOF/full-fit candidates, matched declarations and runtime readback. The accepted A choice does not waive the existing L3 NAV publication gate. Never substitute these engineering artifacts for registered release candidates or claim empty live observations are performance.

Pre-release main210095b7 is an ancestor of session HEAD a7867609; actual Controller9a0299f1 and Worker d85e2c62 are also ancestors. Preserve those commits and use fast-forward push only. Apply paper migration0006 before new Worker activation. Restore exact prior runtime revisions for rollback, retaining append-only account/evidence data.

See LOCAL_CLOSURE.json for test-log digests, native-training-validation.json for GPU jobs, snapshot-memory-before/after.json for complete-data performance.


## Expanded release audit amendment
Formal execution exposed a native-v4 LIMIT 2500 inherited from the legacy trigger: the 2,789-row market inventory lost 289 rows, including 51 four-digit symbols. Cancelled active8-oof-materialize-d9z8f; its partial prep must not qualify as the accepted full-pool candidate. The raw 1,280-day snapshot dataset-snapshot-export-mm8tc succeeded and is reusable. Both native profiles now select the complete inventory, keeping bounded transport and legacy requested limits. 31 focused tests passed.

Manual historical lineage guards now read the Market D1 calendar, matching evening-chain. CI installs the Controller Python dependencies before Worker-to-Python bridges, with explicit absolute module paths. The expanded suite exposed stale schema fixtures, moved source owners and retired L4 UI assumptions; repairs preserve native SQL/CAS checks, original NAV receipts, exact-eight identity and no promotion waiver. Full P9 final run passed: all 536 Worker test files, ten Controller test modules, frontend production build, diff hygiene and P12 secret scan. Existing CI excludes the two separately gated Strategy Discovery runtime E2E tests and explicitly skips Bug Hunter CPD; those unrelated gates are not claimed here. The final Market-calendar Hono route test and paired NAV evidence test also passed separately.

Deployed a32dc4fc by fast-forward only; prior production commits remain ancestors. Formal A/B candidates are not registered yet. Code deployment does not imply active A, a NAV pass or future performance.
