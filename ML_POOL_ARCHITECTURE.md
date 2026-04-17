# ML Model Pool Architecture — Champion-Challenger + Decay Detection

**Status**: Design draft — 待 user review
**觸發方式**: 表現驅動（不是日曆驅動）— 不每天換、不每週換

---

## 📌 Current Implementation Status (2026-04-17)

**Phase**: **Not Started** — entire architecture still design-only.

| Phase | Description | Status |
|---|---|---|
| P1 | GCS versioning `v{N}.joblib` + `model_pool.json` state machine | ❌ NOT STARTED |
| P2 | Weekly IC tracker cron + Decay Detection | ❌ NOT STARTED |
| P3 | Challenger shadow mode | ❌ NOT STARTED |
| P4 | Auto-promote gate + lifecycle_events audit | ❌ NOT STARTED |
| P5 | Discord alerts + dashboard query | ❌ NOT STARTED |

**What exists today**:
- Single-model training per retrain (Run #3 at 2026-04-16 18:29 UTC) — no version history, old GCS artifacts overwritten
- Basic `ic_tracking.json` with 5 models' last-run IC, no historical trend
- No shadow/challenger mechanism — retrained model goes straight to production

**Blocker**: `predict_stock_v2` crash (OPEN ISSUE §3.1 in `memory/project_handoff_to_gpt.md`) must be resolved before model pool work starts — otherwise scaffolding on broken predict path.

Estimated effort when unblocked: **4.5 days** (P1-P5).

---

## 業界主流做法比較

| 模式 | 誰用 | 替換頻率 | 優點 | 缺點 |
|------|------|---------|------|------|
| **Champion-Challenger** | AWS SageMaker, Snowflake | 證明更好才換 | 最安全 | Shadow 期間資源雙倍 |
| **Canary (漸進)** | Google Vertex AI | 1%→5%→20%→100% | 風險漸進 | 金融不能 A/B split traffic |
| **Rolling Decay** | Qlib (Microsoft) | 每月 blend 新舊版本 | 平滑過渡 | 同跑 3-4 版成本高 |
| **Regime-Dependent** | 學術 / hedge fund | Regime 變才換權重 | 適應性強 | Regime 判斷錯全盤皆錯 |
| **Alpha Decay Triggered** | 量化圈 | IC 衰退才換 | 最少不必要動作 | 反應可能略慢 |

**我們的選擇：Champion-Challenger + Alpha Decay（混合）**

---

## Model Pool 狀態機

```
                    ┌──────────────────────┐
                    │     Monthly/Weekly    │
                    │       Retrain         │
                    └──────────┬───────────┘
                               │ 產出新 model version
                               ▼
                    ┌──────────────────────┐
                    │     Challenger        │
                    │  (shadow mode 4 週)   │
                    │  投票權 = 0           │
                    │  預測記錄但不影響決策  │
                    └──────────┬───────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
            4 週 IC > Active        4 週 IC ≤ Active
            + margin 0.01           或 IC < 0
                    │                     │
                    ▼                     ▼
         ┌──────────────────┐  ┌──────────────────┐
         │     Active        │  │    Retired         │
         │  投票權 = 1.0     │  │  不跑 inference    │
         │  參與 ensemble    │  │  GCS 保留 artifact │
         └────────┬─────────┘  └──────────────────┘
                  │
        ┌─────────┴──────────┐
        │                    │
   IC 連 3 週 < 0      IC 正常
        │                    │
        ▼                    │
  ┌──────────────┐          │
  │  Degraded     │          │
  │  投票權 0.1x  │          │
  └──────┬───────┘          │
         │                   │
   ┌─────┴─────┐            │
   │           │             │
IC 連 6 週<0  IC 恢復>0     │
   │        連 2 週          │
   ▼           │             │
Retired    ◄───┘      stays Active
```

---

## 四個狀態定義

| 狀態 | 投票權 | Inference | 何時進入 | 何時離開 |
|------|--------|-----------|---------|---------|
| **Challenger** | 0（shadow） | ✅ 跑但不計入 | Retrain 產出新版本 | 4 週 IC gate 通過 → Active；失敗 → Retired |
| **Active** | 1.0 × IC weight × regime mult | ✅ | Challenger promote | IC 連 3 週 < 0 → Degraded |
| **Degraded** | 0.1 × IC weight × regime mult | ✅ | Active 衰退 | IC 恢復 → Active；連 6 週 < 0 → Retired |
| **Retired** | 0 | ❌ | Challenger 沒過 gate / Degraded 持續衰退 | 手動重啟 or 新 retrain 覆蓋 |

---

## Promote / Demote 觸發條件

### Challenger → Active (Promote)

```
條件（ALL 必須滿足）：
  1. Shadow 期間 ≥ 4 週（20 個交易日）
  2. Challenger 4 週 IC > 同期 Active 同名 model IC + 0.01（margin）
  3. Challenger 4 週 IC > 0（絕對正 IC）
  4. Challenger 4 週 win_rate > 50%
  5. 同 model family balance guard：promote 後 active 仍 ≥ 3 price + 3 feature

動作：
  - Active 版降為 Retired（GCS 保留 artifact）
  - Challenger 升為 Active
  - 寫 model_lifecycle_events 審計記錄
```

### Active → Degraded (Decay Detection)

```
條件：
  - 滾動 weekly IC（每週五計算）連續 3 週 < 0

動作：
  - weight_mult 從 1.0 降為 0.1
  - 寫 event log
  - Discord alert: "⚠️ {model_name} IC 連 3 週為負，已降權"
```

### Degraded → Retired (Extended Decay)

```
條件：
  - 滾動 weekly IC 連續 6 週 < 0（從首次降權算起）

動作：
  - 停止 inference（不再浪費 GPU/CPU）
  - GCS artifact 保留但標記 retired
  - 下次 retrain 自動產出新 Challenger 填補
```

### Degraded → Active (Recovery)

```
條件：
  - IC 連續 2 週 > 0

動作：
  - weight_mult 恢復 1.0
  - 寫 event log
```

---

## 判斷指標：為什麼用 IC 不用 Accuracy

| 指標 | 優點 | 缺點 |
|------|------|------|
| **Accuracy**（現在用的） | 直覺、好解釋 | Binary（對/錯），不區分「大對小錯」vs「小對大錯」|
| **IC (Spearman rank corr)** | 連續值、區分排序品質 | 需要足夠樣本（≥ 20 per week）|
| **Profit Factor** | 直接反映 PnL | 受 position sizing 影響，不純粹反映 model 品質 |

**結論**：週度 IC 是最適合的 model-level 指標：
- 不受 position sizing / risk management 影響（純 prediction quality）
- 連續值 → 能偵測「漸進衰退」而非等到 binary flip
- Spearman → 不假設線性關係（rank-based）
- López de Prado (2018) AFML: *"IC and ICIR are the gold standard for evaluating alpha signals"*

---

## 投票權計算（三層相乘）

```python
def compute_model_weight(model_name, ic_tracking, lifecycle_state, regime_config):
    # Layer 1: IC-based weight（反映預測品質）
    ic_weight = max(0.0, ic_tracking.get(model_name, 0.0))

    # Layer 2: Lifecycle multiplier（反映穩定性）
    status = lifecycle_state.get(model_name, {}).get("status", "active")
    lifecycle_mult = {
        "challenger": 0.0,   # shadow — 不投票
        "active":     1.0,
        "degraded":   0.1,
        "retired":    0.0,
    }.get(status, 0.0)

    # Layer 3: Regime multiplier（反映市況適應）
    regime_mult = regime_config.get(model_name, 1.0)  # 已有 regime.py

    return ic_weight * lifecycle_mult * regime_mult
```

---

## GCS 版本化存儲

```
gs://stockvision-models/
  universal/
    feature_pool.json          ← 不變
    model_pool.json            ← NEW: 狀態機 snapshot
    xgboost/
      v1.joblib                ← retired
      v2.joblib                ← retired
      v3.joblib                ← active
      v4.joblib                ← challenger (shadow)
      meta_v3.json             ← training date, IC, features used
      meta_v4.json
    catboost/
      v1.joblib → v2.joblib → ...
    ft_transformer/
      v1.pt → v2.pt → ...
    ...
```

### `model_pool.json` 範例

```json
{
  "last_updated": "2026-04-17T18:30:00+08:00",
  "models": {
    "XGBoost": {
      "status": "active",
      "version": "v3",
      "gcs_path": "universal/xgboost/v3.joblib",
      "promoted_at": "2026-04-01",
      "weekly_ic": [0.042, 0.038, 0.051, 0.029],
      "ic_4w_avg": 0.040
    },
    "FT-Transformer": {
      "status": "challenger",
      "version": "v2",
      "gcs_path": "universal/ft_transformer/v2.pt",
      "shadow_since": "2026-04-15",
      "weekly_ic": [0.018],
      "remaining_shadow_weeks": 3
    },
    "DLinear": {
      "status": "degraded",
      "version": "v1",
      "degraded_since": "2026-04-10",
      "weekly_ic": [-0.01, -0.02, -0.005],
      "consecutive_negative_weeks": 3
    }
  }
}
```

---

## Weekly IC Computation（新 cron）

```
觸發：每週五 18:30 TW（pipeline 完成後）
位置：ml-controller/services/model_ic_tracker.py

for model_name in ALL_MODELS:
    # 查本週 predictions vs actuals
    preds = d1_query("""
        SELECT predicted_direction, actual_return_pct
        FROM predictions
        WHERE model_name = ? AND direction_correct IN (0, 1)
        AND generated_at >= date('now', '-7 days')
    """, [model_name])

    # Spearman IC
    weekly_ic = spearmanr(preds.predicted_score, preds.actual_return)

    # 更新 model_pool.json
    pool[model_name].weekly_ic.append(weekly_ic)

    # 檢查 trigger conditions
    if is_challenger(model_name):
        check_promote_gate(model_name)
    elif is_active(model_name):
        check_decay_trigger(model_name)
    elif is_degraded(model_name):
        check_extended_decay_or_recovery(model_name)
```

---

## 與現有系統的整合

| 現有模組 | 改動 |
|---------|------|
| `model_lifecycle.py` | 加 `challenger` 狀態 + IC trend 判斷（取代純 accuracy） |
| `ensemble.py` | `load_ic_weights()` 改讀 `model_pool.json` 的 status → weight |
| `modal_app.py` | retrain 產出存 `v{N}.joblib` 而非覆蓋；新版本自動 enter challenger |
| `retrain_trigger.py` | 觸發 retrain 後寫 `model_pool.json` 新增 challenger entry |
| `wrangler.toml` | 新 cron：weekly IC tracker（週五 18:30） |
| `daily_pipeline_v2.py` | `node_ml_predict` 讀 `model_pool.json` 決定跑哪些 model + 記錄 shadow predictions |

---

## 實作 Phase

| Phase | 內容 | 工作量 |
|-------|------|--------|
| 1 | GCS 版本化（`v{N}.joblib` + `model_pool.json`） | 1 天 |
| 2 | Weekly IC tracker cron + decay detection | 1 天 |
| 3 | Challenger shadow mode（predict 但不投票） | 1 天 |
| 4 | Auto-promote gate + lifecycle events | 1 天 |
| 5 | Discord alerts + dashboard query | 0.5 天 |
| **合計** | | **~4.5 天** |

---

## References

- [AWS SageMaker Champion-Challenger](https://aws.amazon.com/blogs/machine-learning/a-b-testing-ml-models-in-production-using-amazon-sagemaker/)
- [Snowflake Automated Model Retraining](https://www.snowflake.com/en/developers/guides/ml-champion-challenger-model-deployment/)
- [Qlib Online Model Management](https://qlib.readthedocs.io/)
- [VertoxQuant Strategy Decay Detection](https://www.vertoxquant.com/p/strategy-decay-detection)
- [Wallaroo Shadow Deployments](https://wallaroo.ai/ai-production-experiments-the-art-of-a-b-testing-and-shadow-deployments/)
- López de Prado (2018) "Advances in Financial Machine Learning" — IC/ICIR as gold standard
