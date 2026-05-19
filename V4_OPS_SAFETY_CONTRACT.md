# V4 Ops Safety Contract

## Scope

V4-30 defines the safety boundary for operational actions.

Covered actions:

```text
external_api_fetch
deploy
retrain
commit
push
real_order
live_submit
```

This contract evaluates guardrails only. It does not deploy, retrain, commit,
push, fetch live data, or submit orders.

## Runtime Contract

Implemented in:

```text
ml-controller/services/v4_ops_safety_contract.py
ml-controller/tests/test_v4_ops_safety_contract.py
```

Schema:

```text
schema_version = v4-ops-safety-contract-v1
```

## Secret Policy

FinLab and other paid API keys must stay backend-only.

```text
allowed storage:
  gcp_secret_manager
  cloudflare_secret

frontend_exposure_allowed = false
log_secret_allowed = false
production_auth_flow = python -m finlab login
```

## External API Fetch Policy

External API fetches require:

```text
backend secret
cache_ttl_sec > 0
rate_limit_configured = true
audit_log_enabled = true
```

Missing cache, missing rate limit, missing audit log, or frontend secret
exposure blocks execution.

## Explicit Approval Policy

These actions require explicit Wei approval with a non-empty scope:

```text
deploy
retrain
commit
push
real_order
live_submit
```

The policy intentionally models `commit` and `push` because this repo's V4
worktree is often dirty and StockVision production-sensitive.

## Kill Switch

Real-order paths are blocked when:

```text
KV key = trading:risk_config
path = system.killSwitch
value = true
```

Kill switch blocks even when a human approval string is present.

## Validator

`validate_v4_ops_safety_packet` rejects forged packets that try to turn a
guarded action into executable state without valid approval, or try to execute
real-order paths while kill switch is active.
