# September 29 evening pipeline NAV approval closure

## Incident and exact drift

`pipeline-v2-5dx5q` started at 2026-09-29 14:02 UTC and failed at 14:03 UTC in
`node_load_market_env`. `payload_builder._load_lifecycle_weights_from_registry`
called the L3 serving grant, which rejected the Paper runtime configuration with
`active8_nav_current_configuration_changed_or_unverified`. The job callback
reported an error, so the evening chain could not close.

The active supplemental Paper approval was signed on September 26 for Native
Paper owner `native-paper-v1:1d1b83a62975363db5e7384fe64bbd48ae8fabc9ee6e86e877a9e126b3973d0e`.
The current Controller source has the separately reviewed owner
`native-paper-v1:d82a2b99b2ba0c671dca95d113427fb31c1caa04cd5827f360dc462a5b9f016e`.
The Worker source context also now contains
`FINLAB_L5_ODD_LOT_MAX_QUOTE_AGE_MS="10000"`, absent from the signed approval.
This controls Paper odd-lot quote freshness and is a real execution policy
change. All other fields in the projected current configuration matched the
approval in the September 29 read-only comparison. The `pipeline-v2` job was
still on source `48f08719`, while the serving Controller and OOF job were on
`25a924f2`; the source mismatch must also be closed.

## Repair boundary

The supplemental approval validator permits exactly the new odd-lot setting
only when the approval checksum covers the complete current configuration and
an `approved_execution_policy_change` declaration naming absent -> `"10000"`.
Every other execution variable, risk/trading config, source identity, and
unknown field remains checked. This code does not create an approval. The
original Paper admission, immutable D1 publication and NAV maturity remain
unchanged. Live submission flags remain disabled.

Before any production mutation, re-read the original admission, pointer,
existing supplemental approval and Worker context. Verify the drift is still
exactly the two reviewed fields plus the validator's own permitted source hash.
Prepare the new complete supplemental record with the exact source reference,
timestamp, declaration and checksum; validate it locally. The September 29
read-only dry run injected only this proposed record in process: the committed
Paper serving grant succeeded, all eight model observations were eligible,
and the existing KV approval remained unchanged.

The September 29 screener and post-screener continuation stages already have
durable success. Their pipeline execution stage alone is error. The screener
watchdog now accepts this exact failure for a one-time release recovery only
when KV contains the new Paper policy declaration with an approval timestamp
after the failure and the Worker version was deployed after the failure. It
uses the existing CAS-fenced post-screener continuation; it cannot mark the
root chain successful by itself.

After Wei explicitly approves this exact Paper policy change and release,
commit/push the tested source and require green CI. Build a no-traffic
Controller candidate and verify source and Native Paper owner. Update only the `pipeline-v2` and
`active8-oof-materialize` jobs to the same image, preserving their resources,
secrets and other settings; deploy the two Modal apps from the same source.
The unaffected `verify-v2` and other jobs retain their images. Verify the
new supplemental KV record's exact readback, candidate Paper-only grant and
eight-model readiness before cutting Controller traffic. Deploy Worker last,
after the Controller cutover; its new version is the watchdog's release
boundary, so recovery cannot start midway through rollout. Recover tonight's
original evening-chain run through the screener watchdog's idempotent
release-recovery path, with no retrain and no overwrite of completed upstream
data. Require actual terminal callbacks and root closure; never infer success
from a Cloud Run process exit.

Rollback before a new private Paper pair is registered: restore the archived
supplemental approval and the previous Controller/job revisions together.
After any new registration, preserve its immutable history and use the native
prestart successor procedure; never erase NAV history to obtain a green run.
