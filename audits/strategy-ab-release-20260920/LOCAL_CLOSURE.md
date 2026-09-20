# Accepted A / B release: local source engineering closure

A keeps eight L3 models, replaces DLinear with official price-only TimeXer, and uses three-head L4. B uses exogenous-137 TimeXer in the same slot and three-head + 34-input scalar EV residual MLP. Both use signed EV, sparse/OPB and original native account execution.

Local source verification is complete. Controller regression: 1,233 passed (1,205 initial passes plus all 28 schema-fixture failures repaired and rerun). Focused history/OOF tests 57 passed; native L4 role/lifecycle tests 26 passed; snapshot/L4 tests 21 passed. Final Worker type-check, 12 contract cases and frontend build pass. Previous desktop/mobile rendering covers ready, empty and misaligned live pairs. Final A/B real frozen native frames and exact retries pass; original zero exposure limits remain zero, with no invented NAV maturity.

Full native CUDA TimeXer jobs validate 268,570 windows per variant: A 3 selected epochs, B 4. B complete three-head -> MLP immutable job and export/evaluator checks pass. These engineering artifacts use a clearly labeled code-inventory identity, never a fabricated Git release identity.

Expanded-history snapshot maps for all 2,789 stocks are byte-logically identical by canonical SHA256. Peak RSS 2,863.61 -> 1,475.91 MiB; time 7.031 -> 5.181 seconds, excluding network. No feature, stock or history truncation. Formal v4 prep preserves full137 tree policy, 1,280-row regime-independent history and expanded source selection. New v4 OOF bootstrap uses new L4 before production activation; B refreshes its MLP.

The page separates frozen research results from prospective A/B accounts. Rebates are max(0, charged-max(20, charged*0.25)), nominal next month day10, receivable only until confirmed payment. A/B must share calendar, baseline and initial capital; cash, holdings and OPB rewards remain independent.

## Deployment and strategy gates

This is code closure, not a claim of production activation or efficacy. Next: commit-pinned source deployment, formal immutable A/B eight-model OOF/full-fit candidates, matched declarations and runtime readback. The accepted A choice does not waive the existing L3 NAV publication gate. Never substitute these engineering artifacts for registered release candidates or claim empty live observations are performance.

Pre-release main210095b7 is an ancestor of session HEAD a7867609; actual Controller9a0299f1 and Worker d85e2c62 are also ancestors. Preserve those commits and use fast-forward push only. Apply paper migration0006 before new Worker activation. Restore exact prior runtime revisions for rollback, retaining append-only account/evidence data.

See LOCAL_CLOSURE.json for test-log digests, native-training-validation.json for GPU jobs, snapshot-memory-before/after.json for complete-data performance.
