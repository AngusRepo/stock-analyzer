# QuantaAlpha POC — Handoff (Full cloud-auto path)

> 2026-04-21 updated；task_plan_quantaalpha.md 對應 Phase 1 T1.1-T1.5

## 背景

Phase 0 precondition locked:
- LLM: Gemini 3.1 Flash Lite
- Platform: Modal
- Universe: Screener ~350 檔
- Cron: Monthly
- Integration: feature_pool.json candidate

## Full cloud-auto 架構

ml-controller Cloud Run 容器內已有 `modal==1.4.0` + `MODAL_TOKEN_ID/SECRET` + `GEMINI_API_KEY` + `CF_*`。全部 POC 執行不需要任何本機工具，透過 HTTP 呼叫 ml-controller endpoints 即可。

```
Claude / Wei → curl ml-controller endpoints
              ↓
              ml-controller subprocess("modal deploy" / "modal run --detach")
              ↓
              Modal cloud: image build → volume persist → run 1 cycle → commit artifacts
```

## 本次交付的 4 個檔

- `ml-service/modal_app_quantaalpha.py` — Modal app: `build_qlib_binary` + `run_mine_cycle` + `check_qlib_data` 3 Modal functions
- `ml-service/scripts/d1_to_qlib_adapter.py` — Standalone local 版本（備援，非主路徑）
- `ml-service/scripts/quantaalpha_verify_ic.py` — POC gate verify
- `ml-controller/routers/admin.py` — +`/admin/quantaalpha-bootstrap` + `/admin/quantaalpha-run`

## 全自動 3 步

```bash
CTOKEN="${ML_CONTROLLER_TOKEN:?set ML_CONTROLLER_TOKEN first}"
URL="${ML_CONTROLLER_URL:?set ML_CONTROLLER_URL first}"

# Step 1: Bootstrap — Modal secret + deploy Modal app
curl -sX POST "$URL/admin/quantaalpha-bootstrap" \
  -H "X-Controller-Token: $CTOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'

# Step 2: Build Qlib binary + run 1 cycle (detached; Modal 背景跑)
curl -sX POST "$URL/admin/quantaalpha-run" \
  -H "X-Controller-Token: $CTOKEN" \
  -H "Content-Type: application/json" \
  -d '{"step":"full","direction":"Price-Volume Factor Mining","years":5}'

# Step 3: 觀察 Modal dashboard 實際進度 — https://modal.com/apps/
# 預期：build_qlib ~30-60 min；mine cycle 1-6 hr
```

## 取回 factor library + verify

Modal Volume `quantaalpha-results` 會累積 `all_factors_library_*.json`。兩條取回路線：

### A. Modal CLI 本機（如果 Wei 有）
```bash
modal volume get quantaalpha-results /latest/all_factors_library_poc1.json ./
python ml-service/scripts/quantaalpha_verify_ic.py \
  --factor-lib ./all_factors_library_poc1.json \
  --output-report verify_ic_report.json \
  --verbose
```

### B. 加個 ml-controller endpoint 把 verify 也雲端化（推薦）
Phase 1 T1.5 延伸任務 — 若 A 不方便可 ship `/admin/quantaalpha-verify` subprocess 呼叫 verify script inside Modal volume mount。

## POC gate 判準（T1.5）

| G# | 條件 | 失敗 → |
|---|---|---|
| G1 | ≥ 3 factors 產生 | STOP |
| G2 | 平均 IC > 0.03 | STOP |
| G3 | 最差 factor IC ≥ 0 | STOP |
| G4 | 1 cycle < 6 hr | 縮 universe 到 50 檔重試 |
| G5 | LLM cost < $5（Gemini console check） | 縮 research direction |

## 已知風險

| 風險 | 應對 |
|---|---|
| QuantaAlpha repo hardcode CSI 300 / 中國股碼 | Modal log 會噴錯，改 configs/ overrides |
| Gemini 3.1 Flash Lite tool-use 表現差 | 改 `CHAT_MODEL=gemini-3.1-pro` 重跑 |
| Image build 失敗 | 降級 requirements.txt install 到最小子集 |
| Modal cycle timeout | 先縮 universe 到 50 檔；逐步擴 |

## Phase 2 自動連鎖

POC `passed: true` 後由 `task_plan_quantaalpha.md` Phase 2 (3b) 接續：
- `scripts/quantaalpha_integrate.py` — factor JSON → feature_pool.json candidate
- D1 `factor_mining_history` table
- Worker `quantaalpha-monthly` cron
