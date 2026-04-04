"""
model_lifecycle.py — Model Lifecycle Management (P1#8)

Monitors model health and automatically manages model weights:
  - Downweight: 30d accuracy < degrade_threshold for 2 consecutive weeks → 0.05x
  - Restore: accuracy recovers > restore_threshold → back to 1.0x
  - Shadow: quarantined models predict but don't vote in ensemble
  - Replace: match degradation cause → candidate model from substitute library

Thresholds are searched by Optuna (degrade: 0.40-0.50, restore: 0.50-0.60).
Balance guard: requires >= 3 price models + >= 3 feature models active.

Data flow:
  Worker daily verify → D1 model_accuracy updated →
  Weekly lifecycle check → KV ml:model_lifecycle updated →
  Next predict: ensemble reads lifecycle weights
"""
import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_D1_DB_ID = os.environ.get("CF_D1_DB_ID", "")
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "")
D1_API = (
    f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}"
    f"/d1/database/{CF_D1_DB_ID}/query"
)

# ── Default Thresholds (can be overridden by Optuna results in KV) ────────────
DEFAULT_DEGRADE_THRESHOLD = 0.45    # 30d accuracy below this = degraded
DEFAULT_RESTORE_THRESHOLD = 0.55    # 30d accuracy above this = restored
CONSECUTIVE_WEEKS_TO_DEGRADE = 2    # must be below threshold this many weeks
DOWNWEIGHT_FACTOR = 0.05            # weight multiplier when degraded
MIN_PRICE_MODELS = 3                # balance guard: min active price models
MIN_FEATURE_MODELS = 3              # balance guard: min active feature models

# ── Model Registry ────────────────────────────────────────────────────────────
PRICE_MODELS = {"KalmanFilter", "DLinear", "MarkovSwitching", "PatchTST", "Chronos"}
FEATURE_MODELS = {"XGBoost", "CatBoost", "ExtraTrees", "LightGBM", "FT-Transformer"}
ALL_MODELS = PRICE_MODELS | FEATURE_MODELS

# ── Substitute Library: degradation cause → candidate replacement ─────────────
# When a model degrades, match the cause to find a suitable replacement
MODEL_CANDIDATES = {
    "KalmanFilter": {
        "when_useful": "smooth trend-following markets",
        "weakness": "mean-reverting or choppy markets",
        "substitutes": ["DLinear", "PatchTST"],
    },
    "DLinear": {
        "when_useful": "linear trend decomposition",
        "weakness": "non-linear regime changes",
        "substitutes": ["PatchTST", "Chronos"],
    },
    "MarkovSwitching": {
        "when_useful": "regime transitions",
        "weakness": "stable single-regime periods",
        "substitutes": ["KalmanFilter", "DLinear"],
    },
    "PatchTST": {
        "when_useful": "long-range temporal patterns",
        "weakness": "insufficient data (<100 bars)",
        "substitutes": ["Chronos", "DLinear"],
    },
    "Chronos": {
        "when_useful": "zero-shot forecasting, new stocks",
        "weakness": "well-established stocks with rich history",
        "substitutes": ["PatchTST", "KalmanFilter"],
    },
    "XGBoost": {
        "when_useful": "structured feature-driven markets",
        "weakness": "feature drift, stale features",
        "substitutes": ["CatBoost", "LightGBM"],
    },
    "CatBoost": {
        "when_useful": "categorical features, robust to overfitting",
        "weakness": "very small datasets",
        "substitutes": ["XGBoost", "ExtraTrees"],
    },
    "ExtraTrees": {
        "when_useful": "noisy features, fast training",
        "weakness": "complex non-linear interactions",
        "substitutes": ["LightGBM", "CatBoost"],
    },
    "LightGBM": {
        "when_useful": "large datasets, fast iteration",
        "weakness": "overfitting on small/noisy data",
        "substitutes": ["CatBoost", "ExtraTrees"],
    },
    "FT-Transformer": {
        "when_useful": "high-dimensional feature interactions",
        "weakness": "small datasets, slow training",
        "substitutes": ["XGBoost", "CatBoost"],
    },
}


@dataclass
class ModelState:
    """Per-model lifecycle state."""
    model_name: str
    status: str = "active"             # active | degraded | shadow
    weight_mult: float = 1.0           # lifecycle weight multiplier
    accuracy_30d: float = 0.0
    accuracy_90d: float = 0.0
    consecutive_weeks_below: int = 0   # weeks below degrade threshold
    degraded_at: Optional[str] = None  # ISO date when degraded
    restored_at: Optional[str] = None
    reason: str = ""


@dataclass
class LifecycleResult:
    """Result of weekly lifecycle check."""
    models: dict[str, ModelState] = field(default_factory=dict)
    events: list[dict] = field(default_factory=list)  # lifecycle events log
    active_price_count: int = 0
    active_feature_count: int = 0
    balance_guard_triggered: bool = False


async def _d1_query(client: httpx.AsyncClient, sql: str, params: list = None) -> list[dict]:
    if not CF_API_TOKEN:
        return []
    body = {"sql": sql}
    if params:
        body["params"] = params
    resp = await client.post(
        D1_API, json=body,
        headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"},
        timeout=30.0,
    )
    if resp.status_code != 200:
        return []
    data = resp.json()
    if not data.get("success"):
        return []
    results = data.get("result", [])
    if results and isinstance(results, list) and "results" in results[0]:
        return results[0]["results"]
    return []


async def _d1_exec(client: httpx.AsyncClient, sql: str, params: list = None) -> bool:
    if not CF_API_TOKEN:
        return False
    body = {"sql": sql}
    if params:
        body["params"] = params
    resp = await client.post(
        D1_API, json=body,
        headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"},
        timeout=30.0,
    )
    return resp.status_code == 200 and resp.json().get("success", False)


def _evaluate_model(
    model_name: str,
    accuracy_30d: float,
    accuracy_90d: float,
    prev_state: dict,
    degrade_threshold: float,
    restore_threshold: float,
) -> ModelState:
    """Evaluate a single model's lifecycle state."""
    state = ModelState(
        model_name=model_name,
        accuracy_30d=accuracy_30d,
        accuracy_90d=accuracy_90d,
    )

    prev_status = prev_state.get("status", "active")
    prev_weeks_below = prev_state.get("consecutive_weeks_below", 0)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    if accuracy_30d < degrade_threshold:
        state.consecutive_weeks_below = prev_weeks_below + 1
    else:
        state.consecutive_weeks_below = 0

    if prev_status == "active":
        # Check if should degrade
        if state.consecutive_weeks_below >= CONSECUTIVE_WEEKS_TO_DEGRADE:
            state.status = "degraded"
            state.weight_mult = DOWNWEIGHT_FACTOR
            state.degraded_at = today
            state.reason = (
                f"30d accuracy {accuracy_30d:.1%} < {degrade_threshold:.1%} "
                f"for {state.consecutive_weeks_below} consecutive weeks"
            )
        else:
            state.status = "active"
            state.weight_mult = 1.0

    elif prev_status in ("degraded", "shadow"):
        # Check if should restore
        if accuracy_30d >= restore_threshold:
            state.status = "active"
            state.weight_mult = 1.0
            state.restored_at = today
            state.reason = f"30d accuracy recovered to {accuracy_30d:.1%} >= {restore_threshold:.1%}"
        else:
            state.status = prev_status
            state.weight_mult = DOWNWEIGHT_FACTOR
            state.degraded_at = prev_state.get("degraded_at")
            state.reason = prev_state.get("reason", "")

    return state


def _apply_balance_guard(result: LifecycleResult) -> None:
    """
    Ensure minimum model diversity: at least 3 price + 3 feature models active.
    If degrading a model would violate this, force it to stay active with reduced weight.
    """
    active_price = [m for name, m in result.models.items()
                    if name in PRICE_MODELS and m.status == "active"]
    active_feature = [m for name, m in result.models.items()
                      if name in FEATURE_MODELS and m.status == "active"]

    result.active_price_count = len(active_price)
    result.active_feature_count = len(active_feature)

    # If too few active, force-restore the least-degraded model
    for model_set, min_count, category in [
        (PRICE_MODELS, MIN_PRICE_MODELS, "price"),
        (FEATURE_MODELS, MIN_FEATURE_MODELS, "feature"),
    ]:
        active_in_set = [m for name, m in result.models.items()
                         if name in model_set and m.status == "active"]
        if len(active_in_set) < min_count:
            # Find degraded models in this set, sort by accuracy (best first)
            degraded = [m for name, m in result.models.items()
                        if name in model_set and m.status != "active"]
            degraded.sort(key=lambda m: m.accuracy_30d, reverse=True)

            for m in degraded:
                if len(active_in_set) >= min_count:
                    break
                m.status = "active"
                m.weight_mult = 0.3  # reduced but not full
                m.reason = f"Balance guard: min {min_count} {category} models required"
                active_in_set.append(m)
                result.balance_guard_triggered = True
                result.events.append({
                    "type": "balance_guard",
                    "model": m.model_name,
                    "detail": m.reason,
                })


async def run_lifecycle_check(
    degrade_threshold: float = DEFAULT_DEGRADE_THRESHOLD,
    restore_threshold: float = DEFAULT_RESTORE_THRESHOLD,
) -> dict:
    """
    Weekly model lifecycle check:
    1. Fetch 30d/90d accuracy for all models from D1
    2. Load previous lifecycle state from D1
    3. Evaluate each model: active → degraded → shadow → restore
    4. Apply balance guard (min 3+3)
    5. Write updated state to D1
    6. Return summary with events and replacement suggestions
    """
    if not CF_API_TOKEN:
        return {"error": "CF_API_TOKEN not set", "status": "failed"}

    async with httpx.AsyncClient() as client:
        # ── Step 1: Fetch current model accuracies (global aggregate) ──
        logger.info("[Lifecycle] Fetching model accuracies from D1...")
        rows_30d = await _d1_query(client, """
            SELECT model_name,
                   CAST(SUM(correct_count) AS REAL) / NULLIF(SUM(total_count), 0) as accuracy,
                   SUM(total_count) as total
            FROM model_accuracy
            WHERE period = '30d' AND model_name IN (
                'KalmanFilter','DLinear','MarkovSwitching','PatchTST','Chronos',
                'XGBoost','CatBoost','ExtraTrees','LightGBM','FT-Transformer'
            )
            GROUP BY model_name
        """)

        rows_90d = await _d1_query(client, """
            SELECT model_name,
                   CAST(SUM(correct_count) AS REAL) / NULLIF(SUM(total_count), 0) as accuracy
            FROM model_accuracy
            WHERE period = '90d' AND model_name IN (
                'KalmanFilter','DLinear','MarkovSwitching','PatchTST','Chronos',
                'XGBoost','CatBoost','ExtraTrees','LightGBM','FT-Transformer'
            )
            GROUP BY model_name
        """)

        # VULN-15 fix: models with no accuracy data default to 0.5 (neutral), not 0
        # Prevents fresh install from degrading all models after 2 weeks
        acc_30d = {r["model_name"]: r.get("accuracy") or 0.5 for r in rows_30d}
        acc_90d = {r["model_name"]: r.get("accuracy") or 0.5 for r in rows_90d}

        # ── Step 2: Load previous lifecycle state ──
        prev_row = await _d1_query(client, """
            SELECT state_json FROM model_lifecycle_state
            ORDER BY updated_at DESC LIMIT 1
        """)
        prev_states: dict = {}
        if prev_row and prev_row[0].get("state_json"):
            try:
                prev_states = json.loads(prev_row[0]["state_json"])
            except (json.JSONDecodeError, TypeError):
                pass

        # ── Step 3: Evaluate each model ──
        lifecycle = LifecycleResult()
        for model_name in ALL_MODELS:
            a30 = acc_30d.get(model_name, 0.5)  # default neutral, not degraded
            a90 = acc_90d.get(model_name, 0.5)
            prev = prev_states.get(model_name, {})

            state = _evaluate_model(
                model_name, a30, a90, prev,
                degrade_threshold, restore_threshold,
            )
            lifecycle.models[model_name] = state

            # Log events
            if state.status != prev.get("status", "active"):
                event = {
                    "type": "status_change",
                    "model": model_name,
                    "from": prev.get("status", "active"),
                    "to": state.status,
                    "accuracy_30d": round(a30, 4),
                    "reason": state.reason,
                }
                lifecycle.events.append(event)
                logger.info(f"[Lifecycle] {model_name}: {event['from']} → {event['to']} ({state.reason})")

        # ── Step 4: Balance guard ──
        _apply_balance_guard(lifecycle)

        # ── Step 5: Build replacement suggestions ──
        suggestions = []
        for name, state in lifecycle.models.items():
            if state.status == "degraded" and name in MODEL_CANDIDATES:
                cand = MODEL_CANDIDATES[name]
                # Find best substitute (highest accuracy among candidates)
                best_sub = None
                best_acc = 0
                for sub in cand["substitutes"]:
                    sub_state = lifecycle.models.get(sub)
                    if sub_state and sub_state.status == "active" and sub_state.accuracy_30d > best_acc:
                        best_sub = sub
                        best_acc = sub_state.accuracy_30d
                if best_sub:
                    suggestions.append({
                        "degraded": name,
                        "suggested_replacement": best_sub,
                        "replacement_accuracy": round(best_acc, 4),
                        "weakness": cand["weakness"],
                    })

        # ── Step 6: Write state to D1 ──
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        state_json = json.dumps({
            name: {
                "status": s.status,
                "weight_mult": s.weight_mult,
                "accuracy_30d": round(s.accuracy_30d, 4),
                "accuracy_90d": round(s.accuracy_90d, 4),
                "consecutive_weeks_below": s.consecutive_weeks_below,
                "degraded_at": s.degraded_at,
                "restored_at": s.restored_at,
                "reason": s.reason,
            }
            for name, s in lifecycle.models.items()
        }, ensure_ascii=False)

        events_json = json.dumps(lifecycle.events, ensure_ascii=False) if lifecycle.events else None

        await _d1_exec(client, """
            INSERT OR REPLACE INTO model_lifecycle_state
            (id, state_json, events_json, updated_at)
            VALUES (1, ?, ?, ?)
        """, [state_json, events_json, today])

        # Also log events to audit trail
        for event in lifecycle.events:
            await _d1_exec(client, """
                INSERT INTO model_lifecycle_events
                (event_date, model_name, event_type, from_status, to_status,
                 accuracy_30d, detail)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, [
                today, event.get("model", ""),
                event.get("type", ""),
                event.get("from", ""),
                event.get("to", ""),
                event.get("accuracy_30d"),
                event.get("reason") or event.get("detail", ""),
            ])

        # ── Build summary ──
        weight_overrides = {
            name: s.weight_mult
            for name, s in lifecycle.models.items()
            if s.weight_mult != 1.0
        }

        summary = {
            "status": "success",
            "date": today,
            "models": {
                name: {
                    "status": s.status,
                    "weight": s.weight_mult,
                    "acc_30d": round(s.accuracy_30d, 4),
                }
                for name, s in lifecycle.models.items()
            },
            "events": lifecycle.events,
            "suggestions": suggestions,
            "weight_overrides": weight_overrides,
            "active_price": lifecycle.active_price_count,
            "active_feature": lifecycle.active_feature_count,
            "balance_guard": lifecycle.balance_guard_triggered,
        }

        logger.info(
            f"[Lifecycle] Done: {sum(1 for s in lifecycle.models.values() if s.status == 'active')} active, "
            f"{sum(1 for s in lifecycle.models.values() if s.status == 'degraded')} degraded, "
            f"{len(lifecycle.events)} events"
        )
        return summary
