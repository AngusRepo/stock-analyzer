# Position exit cooperation and A/B cards
## Explicit scope
Wei authorized commit, push and deploy of these pending changes on 2026-09-25.
This is a Paper execution behavior change, not source equivalence or evidence of investment efficacy.
No real-order enablement, calibration replacement, base-model training or resource increase.

## Behavior
- Intraday reductions use one snapshot: hard risk exit first, otherwise maximum requested shares; never sum proposals.
- S12 position policy wins equal requests; urgent stops do not depend on optional TP1 progress.
- Persist actual cumulative TP1 fills with position/order/T+2 transaction.
- Resume remaining TP1 at EOD; preserve TP1 progress when topping up a position.
- Preserve existing fill/legal/risk constraints, including minimum L4 trade value.
- A/B cards reuse home cards, show each arm target weight and explicitly label B's borrowed A details.

## Qualification
12 focused Node test entries and Worker production/test type checks passed.
Fixtures verify 3999 shares with overlapping TP1/L4 requests, limited depth across polls,
settlement-failure rollback, EOD continuation, top-up preservation and no extra sale.
Frontend build and desktop/mobile preview passed; deployed authenticated detail fetch remains a release check.
This does not certify every cross-writer lease-expiry race.

## Release policy
Keep existing exact-equivalence registry unchanged. The native bundle receives a new raw execution identity.
Use an exact supplementary Paper runtime approval with unchanged risk/model/live-disabled settings.
Configuration-bound NAV pair identity must change; historical NAV maturity must not transfer.
Require full CI, clean merged source, matching candidate image/source and 8-model readiness.
Keep previous image/Worker/Pages versions and previous supplemental approval for coordinated rollback.
