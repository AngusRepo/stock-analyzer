# Official TabPack / B monthly candidate workflow

## Scope and status

This implements the official **single-run TabPack base training and online
ensemble selection**. No retraining, model promotion or deployment was performed
during local verification. The released v1 checkpoint remains supported.

Upstream: https://github.com/yandex-research/tabpack/tree/05a89e21b955f12de84889d662e15ca534019aaa

`ml-service/vendor/tabpack/UPSTREAM.json` binds all 35 upstream source/config/lock
files byte for byte. The algorithms are unmodified. The image uses upstream
`uv.lock` in a separate Python 3.12 / NumPy 2 environment; the other eight models'
shared NumPy 1.26 runtime is unchanged.

## Training contract

- Invoke `lib.experiment.run(project.tabpack.main, ...)`, using the actual
  `experiments/tabpack/make.py:make_config` factory.
- 64 parallel models, width 384, depths 1–4, ReLU, official hyperparameter sampler,
  MuonAdamWPack, per-model patience 16, online greedy patience 32 / maximum 32
  members, bfloat16 training/evaluation. No custom fit loop, fixed 30 epochs,
  global best-epoch refit or hidden smaller fallback.
- Seed 42 is predeclared, not selected by held-out P&L. The upstream paper's
  additional five-seed **benchmark repetition** is not automatically added to
  each monthly job. It is not part of a single model's fit/selection algorithm.
- Finance adaptation: 30 native L3 coordinates plus four three-head outputs;
  target is realized gross return minus three-head EV. Three-head training inputs
  are themselves expanding, purged OOF predictions.
- Inner train / validation / outer test are separated by label-known dates.
  Input scalers and residual mean/std are fitted on inner train only. Validation
  selects members; outer test is evaluation only. The loss is official unweighted
  MSE, not the old custom date-weighted loss.
- Preserve official removal of train-constant columns. Export maps the retained
  first-layer coordinates back into the stable 34-input serving contract.

The original checkpoint stores predictions/experiment state but not all selected
model weights. A passive observer copies state **after** official updates. It
retains best/latest/selected checkpoints, including the same model at different
steps; it does not change gradients, randomness, early stopping or selection.
It restores the original functions on exit. Repeated selections merge their
weights using upstream's normalized averaging semantics.

## Export and serving

Schema: `l4-three-head-residual-tabpack-official-v2`.

- FP32 arrays are stored as a content-addressed, immutable NPZ under
  `l4_distribution/tabpack_weights/<sha256>.npz`.
- KV carries the small artifact contract/reference rather than a potentially
  oversized JSON matrix. The loader enforces path, SHA256, byte limits,
  non-pickle arrays, finite FP32 weights and layer dimensions; two blobs are
  cached per process. Missing/corrupt weights fail closed.
- NumPy serving output is compared with the reconstructed **official ModelPack
  FP32 forward pass**. Standardized-output tolerance: atol 2e-6, rtol 2e-5.
  This is not a claim of bitwise equality to bfloat16 validation predictions.
- De-standardization includes BOTH residual mean and standard deviation.
- Official config/report, hyperparameters, ensemble history, predictions,
  causal fold evidence and export verification are retained in immutable GCS
  training objects. Training-manifest SHA256 is the actual canonical JSON bytes.
- Worker config admission accepts v1 and official v2; MLP remains invalid in
  single-B mode. Runtime and allocator identities now include the weight loader.

## Canonical monthly event chain

1. Worker reads single-B mode and sends `v4-timexer-exo137`, not hardcoded price/A.
2. Controller rejects an explicit A profile or continuation into an old A cohort.
3. Verified OOF/full-fit produces the **new B L3 candidate identity**.
4. L4 prepares the three-head anchor from that parent's exact OOF evidence.
5. An atomic GCS claim dispatches CPU `train_l4_tabpack_candidate` once.
   It prepares causal three-head residual arrays, seals prepared.npz and its
   receipt, then dispatches `fit_l4_tabpack_gpu`. GPU completion seals the official
   outputs before dispatching CPU `finalize_l4_tabpack_candidate`. Cloud Run
   returns pending. Missing handoffs resume from receipts without repeating fits.
6. Existing bounded continuation reads the completed candidate receipt. It never
   rebuilds the anchor or dispatches a second training call for the same run key.
7. Only a validated official-v2 candidate receipt makes this stage materialized.
   Missing L3 or running TabPack is pending; preparation/training failure is failed.
   No serving pointer is changed.

The same existing candidate owner also handles weekly cadence. This patch does
not create schedules. An independent legacy L4 refresh is skipped in single-B
mode, because it does not own the new L3 parent. Direct B requests must supply
the parent explicitly. A price-profile parent cannot masquerade as B merely
because it has the same eight model names.

## Cost and crash behavior

Three owners: CPU prepare (8 CPU/8 GiB/3,600s), L4 GPU fit
(8 CPU/8 GiB/3,600s), CPU finalize (8 CPU/8 GiB/1,800s). Each has maximum one
container and no automatic retry. Official subprocess is capped at 3,300s and
the remaining GPU-stage deadline minus a 120s persistence reserve. CPU causal
preparation and candidate evaluation no longer hold a GPU. Official export
remains with its trainer so exact selected checkpoints survive.
These are ceilings, not measured runtime or a dollar estimate. No cloud image
was built and no actual training was executed during this change.

Dispatch claim, dispatch call ID, training claim, completion and failure are
separate immutable records under `l4_distribution/tabpack_runs/<run_key>/`.
The key binds parent, OOF manifest, as-of, cadence, recipe and source revision.
Known preparation failures are recorded immediately. A lost dispatch response
retains its claim; an ambiguous retry cannot create another paid run. Each phase has its own claim and completion timeout. A queued or ambiguously
dispatched phase may become overdue for operator review; it is never silently
redispatched. Prepared/GPU receipts allow the watchdog to dispatch a next phase
only when that next phase has no dispatch claim.

Recovery must first inspect the recorded Modal call and GCS receipts. Do not
delete claims or invent a new key to bypass an uncertain in-flight call. Retry
after a confirmed failure requires explicit retrain authorization and a reviewed
recovery action. Serving remains on the incumbent throughout candidate failure.

## Release gates (not executed)

1. Reconcile with latest production and preserve other sessions' patches.
2. Obtain commit/push/deploy approval; publish matching Worker, Controller / OOF
   and L4 Jobs, and Modal sources. Confirm the Modal function/source SHA exists
   before allowing the canonical monthly run to reach the new trainer.
3. Recompute exact native Paper identity and obtain the dedicated KV approval
   required by `docs/PAPER_RUNTIME_REAPPROVAL.md`.
4. Obtain retrain authorization; run one candidate with the declared ceilings.
   Verify data sufficiency, GPU duration/memory, selected checkpoints, held-out
   metrics, weight-object readback and complete monthly closure receipt.
5. Apply existing Paper acceptance/release controls to the actual candidate.
   Do not promote based on code tests or architecture compliance alone. No new
   formal account, paired shadow schedule or live trading is enabled.

Rollback: retain the current v1 artifact and exact approved production revision.
Restoring code/config requires the normal release approvals; keep candidate and
failure evidence intact. A candidate training failure itself requires no serving
rollback because it never changes the serving pointer.


## OOF preparation and accounting separation

Weekly/monthly preparation reuses the pipeline input-event batch implementation
(maximum three CPU prep containers). Its authenticated OOF callback owns the
original cadence/date/profile/scheduler ticket; it never resumes the daily L2
pipeline. Canonical adjusted preparation is also a CPU event. Atomic results
are sealed before notification; watchdog reconciliation consumes them if the
callback is lost. Unknown launches are held, not blindly repeated.

The native OOF index has a checksum-bound receipt plus fresh D1 projection
verification. A continuation with an unchanged projection does not reload OOF
predictions or rewrite the index; missing or changed evidence fails visibly.

Weekly/monthly training no longer invokes paired NAV maturity. Its receipt
explicitly says accounting_verified=false and promotion_allowed=false. Daily
accounting and the paired L3/L4 Paper release acceptance remain their original
owners. A missing historical execution receipt is not synthesized or cleared.
