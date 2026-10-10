# TabPack official core, budget16 median contract

Upstream: `yandex-research/tabpack` at `05a89e21b955f12de84889d662e15ca534019aaa`.
The vendored 35-file manifest remains unchanged. This is an official-core
implementation with explicit budget and financial-data adaptations, not an
identical reproduction of every official benchmark setting.

## Preserved core

- Real upstream ModelPack and training loop; MuonAdamWPack with shared step.
- Width384, ReLU, depth1–4 and original RandomSampler distributions for depth,
  dropout, learning rates and weight decay.
- BF16 training setting, unlimited epoch setting, per-model patience16.
- Online greedy selection: latest update, current ensemble in the pool,
  patience32, maximum32 checkpoint states. Sixteen search models do not imply
  a maximum of sixteen selected checkpoint states.
- Upstream validation-driven stopping and checkpoint selection; no
  post-selection refit. External timeout fails incomplete runs closed.

## Explicit adaptations

- Search budget64 →16 for each seed42/43/44; predictions use the per-symbol
  median of three residual corrections plus the shared Anchor prediction.
  This is not the upstream benchmark wrapper's five-seed evaluation.
- All-numeric34-dimensional financial residual inputs, causal Anchor features,
  chronological80/20 inner split, purge and later untouched holdout.
- Existing train-only feature scaling, official target standardization,
  numeric preprocessing disabled, binary extraction disabled, batch1024.
  Official benchmarks choose preprocessing and batch sizes per dataset.
- Shared prepared inputs across the three seeds, with exact source hashes;
  complete prior models are reused and missing/failed seeds block publication.

## Evidence and limits

R125:143 Python tests,26 Worker tests and production TypeScript compilation.
R126: fixed official Linux runtime (Python3.13.7, Torch2.7.1), six upstream
integration tests and actual16-model forward/export checks for all three seeds.
Maximum FP32 export error was1.8801074475049973e-8 standardized units.
Those checks used initialized weights, not fitted models; they do not establish
new-model profitability, GPU/BF16 trained-checkpoint parity or production
admission. The earlier bounded8-member research performance cannot be assigned
to this recipe.

Release order: verify new image/source identity, deploy authorized code,
materialize the clean131 monthly cohort, train and validate the new median,
publish the approved Paper bundle, then continue the unfinished evening chain.
Runtime admission must use the new exact identity; no maturity transfer or
source-equivalence shortcut is permitted.
