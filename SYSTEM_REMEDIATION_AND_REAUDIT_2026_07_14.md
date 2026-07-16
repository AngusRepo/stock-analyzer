# StockVision 全系統修補與深度複檢報告

日期：2026-07-14（Asia/Taipei）
狀態：歷史修補檢查點；PyMOO freshness 與後續 real-trading hardening 現況以 `docs/REAL_TRADING_DATABASE_SECURITY_REVIEW_2026-07-16.md` 為準。
範圍：Cloudflare Worker、Frontend、D1/KV/R2/Queue、GCP Cloud Run Service/Jobs、Modal、ML service、Shioaji proxy、跨 process contract、依賴供應鏈、部署與資料庫治理。

## 1. Executive status

### 1.1 結論

- **Source closure：完成。** 本次找到的 P0/P1 source-level auth bypass、privileged SSRF、credential forwarding、partial-write contract bypass、silent true-batch downgrade、dataset snapshot bypass、artifact evidence version drift、raw error disclosure、unsafe model loading與 route policy 缺口均已修補，並以全局 middleware、policy registry、typed contract 與靜態 coverage gate 系統性落地。
- **Regression closure：完成。** Controller 1250 passed、ML service 329 passed、Shioaji 21 passed；Worker 226 個非 E2E 測試檔、Frontend 24 個測試檔、TypeScript type-check、Frontend production build、Python compileall 全部通過。
- **Production closure：未完成。** 未執行 deploy、retrain、commit、push。線上 GCP 仍是舊 revision、default Compute service account 與舊 concurrency；兩個預定 dedicated service accounts 尚不存在；Modal legacy app 仍部署；Pymoo monthly runtime artifact 仍 stale。以上不是 source 漏修，而是尚未獲授權或尚未具備外部資源的 runtime blocker。
- **不能宣稱「零已知 advisory」。** `pytorch-lightning==2.5.6` 被 `PYSEC-2026-3043 / CVE-2026-31221` 標記；官方 advisory 對 `<=2.6.0` 無 patched version。專案未呼叫受影響的 `load_from_checkpoint()`，並新增 CI 禁止規則，故目前是有 compensating control 的上游風險，不是 scanner zero。

### 1.2 無降規格原則

- Auth 改為 fail-closed，但保留既有 route 與 service-to-service flows。
- Callback 改為 server-owned capability registry；保留全部 callback 功能，不再接受 payload 自訂 destination/token。
- D1 改為 strict atomic cohort；沒有刪除 prediction、audit、recommendation 或 rerank writes。
- True-batch fallback 仍可供 non-formal path 使用，但必須回報 `serial_fallback` 與 `contract_passed=false`；formal path 不再把 fallback 偽裝為 true batch。
- Retrain 維持完整能力，但 immutable dataset snapshot 改為預設必填。
- GCP source 設定由 `40 concurrency × 5 instances = 200` 改為 `8 × 25 = 200`，總並行容量不降；另加 min instance 與 startup CPU boost，降低單 instance 爭用及冷啟動。
- 沒有移除模型、route、策略、風控 gate 或 evidence requirement。

## 2. Review baseline 與複檢方法

初始掃描基線：

| 面向 | 初始結果 | 複檢策略 |
|---|---:|---|
| Route registrations | 377（Worker 196、Python 181） | Worker 以 route-policy coverage test 枚舉；Python 以 app-level middleware 保護所有現有與未來 route |
| Outbound HTTP syntactic calls | 150（TS 110、Python 40） | 區分 fixed-origin、server-configured、payload-controlled、credential-bearing，不以字串搜尋直接判定 SSRF |
| Broad/bare exception handlers | 598 | 逐 layer 判定 recover、degrade、translate、cleanup/re-raise、terminal；不機械替換 |
| Python `response_model` | 1 / 181 | 以共用 error envelope、typed domain contract 與 contract tests 補足，不大規模破壞既有 response schema |
| D1 local schema | 69 tables / 83 indexes | 改以 production read-only inventory 與 governance baseline 為準 |

修補後 broad/bare handler 重掃：production services 500（controller 279、ML 210、Shioaji 11），scripts/tools 97，合計 597。數量幾乎不變是預期結果：安全性來自正確語意與 boundary control，不是把 `except Exception` 換成另一個字串。

## 3. 全局控制面修補

### 3.1 Route/auth policy

#### Cloudflare Worker

- 新增 deny-by-default `RoutePolicy` middleware，所有 `/api/*` 必須命中 explicit policy。
- Policy 以 method + path 判斷 public、user、admin、service、admin-or-service；public mutation 不可因 path prefix 誤放行。
- `/auth/csrf`、login/exchange/logout 等 auth route 精確註冊；unsafe cookie mutation 採 double-submit CSRF。
- JWT 強制 `exp`；service token 使用 constant-time comparison。
- 新增 static coverage test，直接掃描 route registration；新 route 未登錄 policy 會使 CI 失敗。

核心檔案：`worker/src/lib/routePolicy.ts`、`worker/src/lib/routePolicyCoverage.test.ts`、`worker/src/index.ts`。

#### ML service / Controller / Shioaji

- 三個 FastAPI process 均改為 application-level auth middleware，只有 health/OPTIONS explicit public。
- Production secret 缺失不再 fail-open；local bypass 只允許 explicit local/test 且排除 cloud runtime markers。
- Controller callback auth 統一使用 `ML_CONTROLLER_SECRET` / `X-Controller-Token`，移除各 router 重複且不一致的 token parsing。
- Shioaji `/twse-chips`、`/tpex-chips` 與未來新增 route 同樣受全局 HMAC middleware 保護；cloud docs 預設關閉。

核心檔案：`ml-service/app/service_auth.py`、`ml-controller/services/controller_auth.py`、`shioaji-proxy/main.py`。

### 3.2 Session、CSRF 與瀏覽器邊界

- Frontend 不再把 JWT 寫入 `sessionStorage`，不再自行組 Bearer header。
- Worker 使用 `HttpOnly; Secure; SameSite` session cookie；unsafe cookie request 要求 CSRF cookie/header 一致。
- Fetch 統一 `credentials: include`，auth restore 先取得 CSRF state。
- Cloudflare Pages 新增 CSP、frame、nosniff、referrer 與 permissions headers。

核心檔案：`frontend/src/lib/api.ts`、`frontend/src/_core/hooks/useAuth.ts`、`worker/src/routes/auth.ts`、`frontend/public/_headers`。

### 3.3 SSRF / egress policy

原始要求所稱「65 個 SSRF 點」不能等同 65 個漏洞；初始實際 syntactic outbound call site 為 150。複檢依 destination ownership 與 credential flow 分類後，最高風險是 Modal/controller callback：payload 可同時引入 URL 與 token，且部分 client 跟隨 redirect。

修補：

- 新增 server-owned callback capability registry。Payload 只能選 capability，不能引入 destination 或 credential。
- Callback path 固定、HTTPS required、userinfo/query/fragment/private/link-local/metadata target 禁止、redirect 禁止、timeout/retry bounded。
- Modal、daily pipeline、FinLab、state-space、retrain follow-up 全部改走同一 registry。
- Retrain follow-up 不再由 request `Host` / `base_url` 推導 production callback；production 必須使用明確 service URL。
- Worker 全局驗證 configured egress origins；Discord/GitHub helper 在真正送出前再次驗證，避免只靠 startup check。
- Controller 同步驗證 service endpoints 與 Discord webhook。

核心檔案：`ml-service/app/callback_policy.py`、`worker/src/lib/egressPolicy.ts`、`ml-controller/services/service_endpoint_policy.py`。

複檢結論：已審查路徑中沒有剩餘的「外部 payload 控制 destination + privileged credential forwarding」sink。固定官方 API origin、server-owned URL 與不帶 credential 的 public fetch 不列為 SSRF vulnerability。

### 3.4 Error/exception policy

統一語意：

| Layer | 規則 |
|---|---|
| Route boundary | 4xx 僅允許 stable machine code；5xx 對 client 一律 generic，完整 stack + request ID 留在 server log |
| Service/domain | business absence 回 typed result；invariant/contract failure raise typed exception；不回 HTTP dict |
| Repository/egress | 保留 cause 並 raise typed repository/upstream error；只在 final boundary 記完整 stack，避免重複 log |
| Atomic persistence | 任一 statement contract 不成立即 raise，不回 partial success |
| Per-item batch | 只有明確允許 partial 的 batch 才回 item error + aggregate counts |
| Optional/shadow enrichment | 可 warning + `degraded=true` + provenance；不得改寫 primary mutation success |
| Process/job top level | structured terminal log、error callback、non-zero exit；不得 HTTP 200 包 error dict |

已處理 route 回 HTTP 200 error、`detail=str(exc)`、Modal traceback payload 等問題。Source 仍可看到 `detail=str(exc)` 呼叫，但 global handler 對 5xx 一律遮蔽，4xx 只放行符合 stable-code regex 的內容。

核心檔案：`ml-controller/services/http_error_policy.py`、`ml-service/app/http_error_policy.py`。

## 4. Contract bypass 與跨 layer 修補

### 4.1 D1 transaction / persistence acknowledgement

- 新增 `D1BatchContractError`：HTTP success 不等於 persistence success；逐 statement 驗證 envelope、success、changes 與 statement count。
- 新增 `AtomicWriteCohort` context：daily pipeline prediction、L2/L3 audit、recommendation、filtered marking、rerank 進入同一 Worker D1 batch cohort。
- 任一 error 不 commit；每批最多 500 statements；zero-success/no-op 不再偽造 persisted rows。
- Retrain lock production fail-closed；local-only fallback 必須 explicit opt-in。
- Recommendation writers 不再忽略 `batch_execute()` result。

核心檔案：`ml-controller/services/d1_client.py`、`ml-controller/graphs/daily_pipeline_v2.py`、`ml-controller/services/recommendation_service.py`。

### 4.2 True-batch contract

- Runtime override 失敗時標記 `execution_mode=serial_fallback`、`contract_passed=false`、reason code。
- Formal evidence path 必須 assert true batch；不能用相同 output shape 冒充 true-batch execution。
- Telemetry 從 ML service 傳回 controller/daily pipeline，不再 silent fallback。

### 4.3 Evidence contract version drift

Root cause：artifact builders 已輸出 factor-stable label v2 與 semantic v2，但 Python materializer/producer 及 Worker champion fallback 仍驗 stale v1，導致新 artifact 被拒、舊 fallback 可能被接受。

修補：

- Python canonical constants：`ml-controller/services/evidence_contracts.py`。
- Worker canonical constants：`worker/src/lib/evidenceContracts.ts`。
- Builders、producers、fusion、orchestrator 全部引用 canonical source。
- 新增跨語言 parity test，防止 Python/TypeScript 再次分叉。

Canonical label：`next-session-raw-open-to-fifth-session-raw-close-factor-stable-net-v2`。

### 4.4 Retrain immutable snapshot

- `require_exact_dataset_snapshot` 預設由 false 改為 true。
- 缺 snapshot、版本不符或 lifecycle field 未 forward 均拒絕 retrain。
- Production callback 不再信任 caller Host。

### 4.5 Model supply-chain / deserialization

- GNN、TabM 改用 `torch.load(..., weights_only=True)`。
- CI 禁止 app source 出現 `weights_only=False`、`load_from_checkpoint`、`torch.jit.script`。
- Breeze2 只允許 exact approved model ID，且 revision 必須是 immutable 40-hex commit；任意 `model_id` 或 mutable branch/tag 直接拒絕。
- Breeze2 仍需 `trust_remote_code=True` 才能維持該模型功能，但執行內容已鎖至核准 model + immutable revision，不接受 payload 任意 repo/revision。

核心檔案：`ml-service/app/breeze2_reason_generation.py`、`ml-service/tests/test_torch_deserialization_policy.py`。

## 5. DB 設計與治理

Production D1 read-only inventory：

| 指標 | 結果 |
|---|---:|
| Tables | 157 |
| Indexes | 223 |
| Views | 1 |
| Database size | 約 8.86 GB |
| Exact duplicate indexes | 0 |

已建立：

- `worker/schema.production.snapshot.sql`：production baseline snapshot。
- `worker/migrations/0001_governance_baseline.sql`：Wrangler canonical migration baseline。
- `worker/legacy-migrations.manifest.txt`：舊 root migration 明確列管，不再假裝是 canonical ledger。
- `worker/src/lib/databaseGovernanceContract.test.ts`：schema/migration governance gate。
- `package.json` D1 init/list/apply scripts。

未做 destructive schema cleanup。157 tables 代表明顯 legacy/operational sprawl，但在沒有 query frequency、retention、FK reachability、production consumer evidence 前直接 drop/merge 會提高事故風險。後續應做 table ownership + retention + query-plan program，而不是本輪直接刪表。

## 6. GCP、Modal、Docker runtime 複檢

### 6.1 GCP read-only evidence

線上 `ml-controller`：

- 4 vCPU / 4 GiB、container concurrency 40、maxScale 5、timeout 3600。
- CPU throttling true、startup CPU boost true。
- 使用 default Compute service account。

線上 `pipeline-v2`：

- 4 vCPU / 4 GiB、timeout 1800、maxRetries 0。
- 使用 default Compute service account。

Source deploy script 已改為：

- Controller/job 各自 dedicated service account。
- `ENVIRONMENT=production`。
- Controller concurrency 8、min 1、max 25、startup CPU boost。
- 部署前檢查 service account existence。

Runtime blocker：預定的兩個 dedicated service accounts 目前不存在；且未獲 deploy/IAM mutation 授權，所以 production 尚未套用 source 修補。

### 6.2 Modal read-only evidence

- Profile：`wayne60619`。
- Deployed apps：`stockvision-ml` 與 legacy `quantaalpha-poc`。
- 兩者查詢時 tasks 均為 0。

Runtime blocker：`quantaalpha-poc` 尚未 retired。停止 app 是 production mutation，本輪未執行。

### 6.3 Docker

- Root、ML service、execution gateway、Shioaji、Freqtrade images 已加入 non-root UID 10001。
- `deploy_ml_controller.sh` 通過 `bash -n`。
- 本機沒有 `docker` executable，因此無法完成 Linux image build、SBOM 或 image CVE scan。這是 verification gap，不是通過。

## 7. 效能與流程優化

- Cloud Run 將單 instance concurrency 由 40 降至 8，同時 max instances 由 5 提至 25，總並行容量維持 200；避免 4 vCPU container 內 sync/CPU/D1 workload 過度排隊。
- min instance 1 與 startup CPU boost 改善冷啟動，不犧牲功能。
- D1 writes 合併成 atomic cohort，減少多次 REST round trips 與 partial state repair 成本。
- True-batch telemetry 可區分真正 batch 與 serial fallback，讓 latency/cost attribution 不再失真。
- Callback retry bounded 且 redirect disabled，避免 retry amplification 與 credential redirect。
- Frontend build 已 route/chunk split；最大 `vendor-charts` 590.25 kB raw / 165.52 kB gzip。這不是 blocker，但應列入後續圖表 lazy-load 與 bundle budget。
- 大型資料路徑維持 Polars/NumPy；未以 Pandas 取代既有大量資料處理。

## 8. Dependency / supply-chain 結果

| Scope | 結果 |
|---|---|
| Controller `pip-audit` | 0 known vulnerabilities |
| Worker `npm audit --omit=dev` | 0 |
| Frontend `npm audit --omit=dev` | 0 |
| ML service `pip-audit` | 1：`pytorch-lightning 2.5.6 / PYSEC-2026-3043` |
| ML requirements resolver | `pip install --dry-run` 成功，含 Torch 2.13 / Transformers 5.13.1 |

ML 主要更新：FastAPI 0.139、Starlette 1.3.1、aiohttp 3.14.1、cryptography 48.0.1、Ray 2.56、Torch 2.13、Transformers 5.13.1、setuptools 83。

Lightning 風險判定：

- [GitHub advisory](https://github.com/advisories/GHSA-75m9-98v2-hjpm) 指出 `<=2.6.0` 的 `load_from_checkpoint()` 會走不受限 pickle，且目前沒有 patched version。
- [NeuralForecast 3.1.9 metadata](https://pypi.org/pypi/neuralforecast/3.1.9/json) 明確要求 `pytorch-lightning<2.6.0`。
- 不能強裝 2.6.1 破壞 resolver contract；且 2.6.2/2.6.3 另有官方確認的 supply-chain compromise。現階段採 API elimination + CI prohibition + verified artifact checksum，並保留 advisory，不做假性 scanner suppression。

## 9. 最終驗證證據

| 驗證 | 結果 |
|---|---|
| ml-controller pytest | 1250 passed, 15 skipped |
| ml-service pytest | 329 passed, 2 skipped |
| shioaji-proxy pytest | 21 passed |
| Worker non-E2E tests | 226 test files passed |
| Worker TypeScript | production + tests tsconfig passed |
| Frontend tests | 24 test files passed |
| Frontend production build | passed，2618 modules transformed |
| Python compileall | passed |
| Deploy script syntax | `bash -n` passed |
| npm audits | Worker 0、Frontend 0 |
| pip audits | Controller 0、ML 1 compensated upstream advisory |
| Requirements dry-run | passed |

未執行：

- Local Worker runtime E2E：需要啟動完整 local bindings/server。
- Real-model E2E / Breeze2 3B inference：涉及外部成本與 runtime credential。
- Production smoke：source 尚未 deploy。
- Docker build/image scan：本機無 Docker。
- Full suite on Linux Torch 2.13 image：dependency resolve 與短路徑 isolated load test已通過，但完整 suite 本輪在本機 Torch 2.12 shared venv 執行。

## 10. 尚未閉環的 blocker

### 需要外部變更授權

1. 建立 controller/job dedicated GCP service accounts，授予最小 IAM。
2. Deploy GCP controller/jobs 與 Cloudflare/Frontend/Modal 修補。
3. 執行 production smoke、auth negative tests、callback/SSRF negative tests、D1 atomic failure injection。
4. 確認 legacy `quantaalpha-poc` 無 consumer 後停止/retire。
5. 在具 Docker 的 Linux builder 執行 image build、SBOM、image vulnerability scan。

### 需要 retrain 授權

6. `local_prod_ready_audit` 目前唯一 blocker：`roadmap:p8:monthly_pymoo_runtime_contract_validation_artifact_fresh`。必須產生新 runtime artifact，不能用降低 freshness gate 或偽造 timestamp 解決。

### 上游限制

7. Lightning CVE 無 patched version且 NeuralForecast 限制 `<2.6.0`。保持禁止危險 API，追蹤 upstream；若要完全移除 advisory，需評估 fork/patch NeuralForecast-Lightning load path 或隔離成只接受內部 verified artifacts 的獨立 runtime。

### 結構性技術債

8. Controller/ML monolith、157-table D1、597 broad/bare handlers 與 legacy migrations 仍需持續拆分；本輪已用 control plane 降低新增 bypass 的機率，但不應把架構債誤報為一次性清零。

## 11. Release gate

目前 gate：**SOURCE_READY / PRODUCTION_BLOCKED**。

允許進入部署前 review 的條件：

- 所有本報告 source tests 維持通過。
- Dedicated service accounts 存在且 IAM diff 經人工核准。
- Docker/Linux image scan 完成。
- Pymoo freshness blocker 以真實 retrain artifact 關閉。
- Deploy plan 含 rollback revision、D1 migration no-op confirmation、auth/callback negative smoke。

在上述條件完成前，不應宣稱「production 已無漏洞」；可準確宣稱的是：「本輪發現的 source-level exploitable findings 已修補並通過 regression，剩餘項目已被明確列為 runtime、verification 或 upstream blocker。」
