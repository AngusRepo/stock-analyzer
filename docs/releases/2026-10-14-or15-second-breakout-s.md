# OR15 S second breakout

Rule: `atr5-sma-second-breakout-s-v2`; effective full session 2026-10-15 Asia/Taipei.
Legacy sessions through 2026-10-14 retain `atr5-sma-first-signal-v1` and their immutable rows.

First qualified momentum pass is retained. A weak first signal waits for the first subsequent qualified bar whose delta > 1.5 * ATR5 + 1e-10 and close strictly exceeds all highs from the first signal bar through the previous bar. ATR5 includes the current signal. Non-qualified intervening highs count; the current and future bars do not. No tick buffer, new filter, TP, model or exit changes.

Round12 requests common 30 minute missed-entry recovery. The previous production source had only a one-minute authorization; this release implements the requested shared recovery for both first-strong and S triggers. Only a signal observed and persisted within its original first-minute window can be retried. An unobserved historical pass cannot authorize a new order. Deadline is min(signal confirmation + 30 minutes, 13:21), exclusive: preserve the original final 13:20 signal submission cutoff. The stored ORH/ORL and chase ceiling do not move; quotes, limit-up, allocation, slots, account risk and final order/fill guards are still checked. No ATR re-evaluation after authorization. Existing daily fill/holding guards prevent duplicate entry.

Paper 0011 adds independent per-account/date/symbol/version state and immutable per-qualified-bar records through first S or cutoff. It does not alter old vetoes or reset on plan changes. Atomic batch writes precede execution; stale concurrent evaluators cannot revert a pass. Order authorization and paper event evidence carry the rule version and trigger kind. Missing minute/warmup evidence remains unknown rather than a false pass.

Validated genuine case bars: 4991 2026-10-14 (09:35 weak, 10:35 S); 2337 2026-10-14 (09:20 R only at 108 == 108, 09:25 S at 108.5 > 108); 6994 2026-10-05 (first weak, no later qualified signal). Cases are historical tests, not live trades.

Worker baseline 08efa7462eef45c59b8965845e44ddd6ebdecac3. Pages baseline 7ae415bef8d3c35617256dee0040c17bf9379b03; its 9 OBS timing/style changes are carried forward byte-for-byte so the new release does not roll them back.

First live-day evidence is only available after 2026-10-15. Do not label fixtures or replayed historical bars as that evidence. Query paper_second_breakout_signals_v2 by date/account/policy; join state and paper order events to distinguish hypothetical R, actual S authorization and actual fills.
