# Research validation hardening

## Release baseline

This correction is integrated forward from main `681e66f33d336f3b430c76c9e8204273df36e18c`.
The shared legacy checkout is not the deployment source. Current exact DSR v2,
native paired NAV, numeric risk gates and retention changes remain intact.

## Statistical evidence

`services/data_snooping_validation.py` implements Hansen's studentized max
statistic, consistent sample-dependent null centering and stationary bootstrap
population variance (Hansen 2005, section 3). White RC uses the same dependence-
preserving sampling with its unstudentized statistic and zero-mean null.
Candidates share each sampled time index. Missing or invalid observations,
unequal lengths and degenerate variance reject the entire input.

The canonical method identifiers remain compatible with the current main
promotion boundary:

- `hansen_spa_studentized_stationary_bootstrap_v2`
- `white_reality_check_stationary_bootstrap_v2`

Receipts additionally require `data-snooping-evidence-v2`, the implementation
version, bootstrap settings and the tested / searched candidate manifests.
Name-only PASS receipts cannot authorize promotion. `passed` is a statistical
result; `promotion_eligible` also requires complete declared search coverage.
Paired champion / candidate replay alone supplies no complete-search manifest.

The complete-search manifest is currently caller declared. Historical ledger
integration must prove its scope before claiming all research trials were
accounted for. Equal lengths do not establish timestamp identity; callers must
provide identical ordered partitions from the same panel. A family-level SPA
rejection does not prove every candidate individually has an edge.

Mandatory promotion evidence cannot be downgraded using the external-risk
research option. The alpha bundle and parameter gate share this boundary.
Research-only replay retains advisory diagnostics.

## Validation

125 offline pytest cases passed across eight files, including an independent
enumeration of the full stationary-bootstrap distribution for a four-period
fixture, scale invariance, serial dependence, invalid input rejection, complete
receipt acceptance and current exact DSR / native NAV promotion regressions.
Network calls were blocked; only Windows asyncio's internal socketpair was
allowed during socketpair construction.

Receipt: `audits/framework-comparison-20260926/statistical-fix/verification.json`.
Reproduction: run its sibling `verify.py` using the configured test Python.

Reference: https://bashtage.github.io/kevinsheppard.com/files/teaching/mfe/advanced-econometrics/Hansen.pdf

Historical trial ledger, causal replay checks, parameter robustness views and
verified-bundle drift checks are the authorized next phases, not features
already delivered by this initial correction.

## Unstarted native successor chains

The zero-traffic release preflight found that an already replaced first paper session could not receive another execution version. Successors now validate every immutable predecessor plan and receipt, first-phase clock and original comparison. Cycles, missing commits and chains above 32 nodes fail closed. Registration resolves the unique committed leaf; retired nodes remain ineligible. Any ancestor journal, execution receipt or first frame blocks another replacement. Frozen inputs, predictions, schedule and initial assets are retained; maturity is never transferred. Runtime-owner checks and explicit paper runtime approval remain unchanged.

## Research workbench implementation

The isolated implementation adds append-only Research source/run/trial receipts,
explicit terminal-state Optuna capture, a checksum-pinned historical importer,
and the existing StrategyLearningPage workbench. Historical recovery remains
partial: 2,025 known trials, including 11 failed mining runs. Optimization
objective scores are not relabeled as validation. The importer is idempotent;
immutable triggers reject overwrite, update and delete.

Mode A causal audits use a pinned dataset, repeated replay, two prefix cutoffs
and actual future-cell perturbations. Decision traces include simulated entries,
exits, positions and account state before terminal liquidation. Precomputed
upstream features are not recomputed; Mode B unsealed prediction/state inputs
remain INSUFFICIENT. Replay accuracy now requires label and verification clocks
to precede the Taipei entry session; absent legacy timestamps remain unknown.

Parameter neighborhoods require pinned, comparable validation context, unique
parameters and at least five neighbors. Holdout never selects parameters.
Complete bundle views bind six semantic components and use the original immutable
Active-8 publication and exact paper approval; consistency is not efficacy.

The parameter promotion gate additionally re-reads a sealed immutable search,
binds its selected configuration, execution source, costs and dated panels to
the actual candidate/champion replay, and recalculates stationary SPA. Only the
actual tested winner can use the family result. Caller PASS or a declared ID
list alone cannot authorize promotion; historical partial ledgers stay blocked.
These changes grant no training, live order, publisher or paper admission authority.

Release cutover and remote historical import remain separate operator steps.
The first repair release is CI-passed main 4a188d6c; source-compatible paper
runtime/successor approval is still required before its production cutover.
