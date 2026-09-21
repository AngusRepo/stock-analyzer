# A/B native release engineering closure — 2026-09-21

A is the designated primary: price TimeXer replaces DLinear in exactly eight L3 models, followed by three-head L4. B is comparison-only: exo137 TimeXer in the same slot, three-head L4 plus a scalar EV residual MLP consuming 30 L3 signals and four head outputs. A retains the original L3 NAV publication gate. B never automatically replaces serving.

## Actual completion evidence

Both candidates have checksum-verified seven-window OOF manifests (56 arrays and 1,051,887 model-stock-date observations each). Both have eight immutable registered full-fit models, complete native L3/L4 artifacts and actual inference on the same 657-stock routed input. Both preserve all 657 recommendations/allocation rows. Both native Worker account executions reproduce their state checksum exactly on replay. Each candidate passes 21 evidence-bound engineering acceptance checks.

The real frozen account is P5-halted, so cash is the correct observed allocation. Positive fills, partial fills, veto/replanning and structural hard exits are separately verified native synthetic scenarios. These checks do not create historical or prospective NAV credit.

| Held-out diagnostic, equal weight per date | A | B |
| --- | ---: | ---: |
| Dates / observations | 10 / 19,162 | 10 / 19,162 |
| L3 rank IC | 0.066140 | 0.104101 |
| Final L4 rank IC | -0.097794 | 0.102794 |
| Final L4 mean squared error | 0.002808021 | 0.003001421 |

The shared holdout is 2026-08-31 through 2026-09-11. A has lower squared error but adverse ranking; B restores positive ranking while increasing squared error. Neither is proven financially superior. These are prediction diagnostics, not portfolio returns. Source values and weighting are in `nested-AB-matched-diagnostics.json`.

## Repairs included

- Preserve exact TimeXer model roster, checksum and sequence semantics across completion, L3 lineage, serving, forward reuse and whole-strategy NAV.
- Require sufficient initial v4 nested history while preserving immutable reused folds and the original NAV promotion thresholds.
- Permit a genuinely weak observation only under verified whole-strategy authority; keep all eight observations without changing selected L3 weights.
- Bind market risk to the exact signal date and preserve full-pool allocation, native hard exits and order ownership.
- Avoid repeated account-history copying; report the entire paired inference budget. The real-input copy benchmark reduced peak RSS from about 1,509 to 1,209 MiB and elapsed time from 14.84 to 11.33 seconds.
- Persist full-fit run version, child call IDs and completed callback JSON results. A dispatch with unknown outcome stops for explicit reconciliation instead of submitting another paid job.

## Cost incident and recovery

Modal parent preemption restarted the same full-fit input with in-memory-only handles and a newly generated version, repeating completed children. A workspace monthly budget pause then delayed execution. Four obsolete calls were canceled. After the budget was raised, B's parent remained queued without a runner even though its five initial models had completed. The exact original request was reconstructed through the native canonical dispatcher and verified against the dispatch receipt; the stalled parent was canceled. Native control continued locally, reusing all five completed models and dispatching only the missing GNN, TabM and iTransformer. Their call IDs and completed results were persisted in the new journal. The optional extra SHAP audit was not dispatched during recovery. Model algorithms, hyperparameters and data thresholds were unchanged.

Billing reported through approximately 15:00 Taipei: September workspace usage USD 70.16332850; September 20–21 USD 56.74883864. This is metered workspace usage, not final invoiced cost or exact session attribution; the main ML app is shared with production. Final billing is recorded separately after deployment.

## Validation and release boundary

The closure receipt binds all 51 source/test file hashes, actual candidate/account evidence, paired declaration and passed test reports. Baseline regression: 1,263 controller and 152 ML-service cases. Focused follow-ups cover native execution, publication authority, weak observations, reused OOF, memory/capacity and cost recovery; 13 native Worker test files also passed. Counts across these suites overlap and must not be summed as unique tests. The release working tree matches the tested source and passes `git diff --check`; Worker type checking and frontend build passed.

This document records predeployment engineering closure. Deployment, exact production readback, the approved append-only Paper P5 rearm and A/B declaration are separate recorded operations. Original orders are retained. No real trading, shutdown, fabricated NAV maturity or automatic B promotion is authorized by this receipt.
