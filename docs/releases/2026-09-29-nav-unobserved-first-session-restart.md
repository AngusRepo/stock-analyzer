# September 29 NAV first-session loss and restart proposal

## Observed failure

The approved September 29 release restored the Paper runtime grant and the
evening pipeline resumed. Its Modal continuation completed 670 recommendations
and 11,714 prediction writes, then failed at `node_write_d1` with a `KeyError`
for `paired_nav_collection.snapshot_id`. Learning D1 has no September 29
`allocation_context` manifest. `run_and_capture_allocation` can return a
sanitized failed collection without a snapshot; the L4 publisher dereferenced
it after serving writes, hiding the earlier NAV source failure.

The still-active ensemble registration
`cd0eaa2d8aca42a082c94ace8c2bab2d10e0778a3879469f2a0062bb0593b66c`
and route registration
`b95d998645eaa5681fefd5e35cc566769038d22c658cea85b32b124c67717b9e`
were frozen on September 24 for the September 29 session. Both schedule their
first frame at 07:15 Asia/Taipei on September 29. The immutable ensemble packet
requires Native Paper owner
`native-paper-v1:1d1b83a62975363db5e7384fe64bbd48ae8fabc9ee6e86e877a9e126b3973d0e`.
The 07:15 request ran on Controller revision
`ml-controller-perf-b88d07e8-0929`, source `b88d07e8`, whose declared Native
Paper owner is
`native-paper-v1:3bb2cb595b064b4900627f292c4d252ed03ecc4d607f1a984a26e559904264aa`.
The native runner requires exact raw owner equality. Every sampled 07:15–08:00
Controller request returned HTTP 409. Neither active pair has a first-frame
GCS delivery, an execution receipt, or a daily journal. The original 07:15
quotes and model reads cannot be captured after their deadlines. September 29
A/B NAV is permanently unobserved and must receive zero NAV maturity credit.

The September 29 pipeline selected the pinned old ensemble comparison. Its
strategy context requests original native carry from the September 29 journal;
none exists. That failed the `allocation_context` seal, which the later
`snapshot_id` access masked. This is the current continuation blocker.

## Proposed exact recovery

1. Install Learning D1 migration 0059. It adds an append-only
   `paired_nav_unobserved_pairs_v1` receipt with update/delete/overwrite guards.
2. Certify only the two execution snapshot IDs above. Before writing each
   receipt, verify the full original snapshot, expired first frame, absent
   first-frame delivery, no execution receipt or journal, and no committed
   prestart successor. Record the original checksum, first-frame delivery ID,
   deadline, and zero NAV credit. Never synthesize a frame, fill, return, or
   journal. The read-only default and `--apply` entrypoint are
   `ml-controller/scripts/certify_unobserved_first_session.py`; its exact
   Learning D1 checksums are `93a2d47b33522bb9f50cdf5c9acb8bee5710b0e55dec2996b9013dcaa7488018`
   (ensemble) and `cbc28338f019b72b7938b79e413df4d85fe530abcbd026f1bef21d0cb8fa4a50`
   (route).
3. Keep both old pairs in the population as `unobserved_closed`, with their
   missed session dates visible. Exclude them from *future carry* and from
   accounting's missing-receipt retry loop. Continue all actually observed
   journal verification unchanged. Six earlier prestart-superseded registrations
   also remain visible and do not require execution receipts.
4. Require a frozen allocation-context snapshot before any L4 serving D1 write
   or Paper plan publication. Surface the sanitized upstream stage/reason.
5. Reuse the existing September 29 Modal prediction bundle to resume only the
   failed downstream pipeline. The September 30 07:15 first phase has now
   passed. The existing `missed_execution_window` path must persist its
   immutable zero-NAV receipt and permit evening-chain closure without creating
   a late execution pair. Verify the terminal callback, root ticket and KV
   closure receipt. A fresh prospective comparison can begin only in a later
   evening chain before its next session's first phase; verify its raw owner
   against the deployed Controller and require the actual first-frame delivery.

The missed September 30 first phase yields no NAV observation. A later new
comparison epoch is not a continuation of the unobserved September 29 result.
The new Native Paper source fingerprint is pinned in
`native_execution_behavior_release.json` as
`native-paper-v1:4625d891394904b5081cee9c431df4d8b79a2e35001914754cef65663da43be6`;
the existing supplemental Paper
runtime approval must be renewed for its exact current configuration. No
retrain, real order, inherited NAV sample, promotion, or live flag change is
part of this proposal.

## Approval boundary

AGENTS.md requires Wei's explicit approval before commit, push, deploy, or any
production mutation. The user-approved September 29 six-file release did not
authorize this later policy. Keep this branch local until the exact migration,
two zero-NAV receipts, new fingerprint/Paper runtime approval, release, and
downstream recovery are approved together.
