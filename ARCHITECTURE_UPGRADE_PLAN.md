# StockVision 架構升級計畫

> 基於 Claude Code 架構模式 + LangGraph 整合方案
> 日期：2026-04-01
> 更新：2026-04-02（v7 — Screener 重構整併：Bottom-up 多因子 + RRG 產業輪動）

---

## 更新記錄

| 版本 | 日期 | 說明 |
|------|------|------|
| v7 | 2026-04-02 | 整併 Screener 重構計畫（§九），新增 Phase 0，刪除 DATA_CLEANSING_PLAN.md |
| v6 | 2026-04-02 | 新增 §八 Failure Mode Map（17 種失效模式 × 防禦方案），補強：跌停鎖死、Gap Stop、流動性過濾、模型共錯偵測、Prompt 版控、Agent 限制為只扣分、服務降級、資料驗證層 |
| v5 | 2026-04-02 | 外部審查修正：新增 Decision Authority Layer（決策權限分層）、Checkpointer 改 GCS/Postgres、Optuna 加 out-of-sample lock、紅軍加 historical replay 必要條件、Session Memory 限制範圍、Phase 2.5 新增 |
| v4 | 2026-04-01 | 融合 StockVision v12 營運藍圖，新增：模式 13（數據冷熱分級）、模式 14（5 層 Circuit Breaker）、模式 15（Optuna 自動調參 Skill）、模式 16（週報 AI 審計 Graph）、模式 17（Multi-Agent 對抗訓練），更新架構圖、安全防護、導入路徑 |
| v3 | 2026-04-01 | 融合 [Everything Claude Code](https://github.com/affaan-m/everything-claude-code) 分析，新增：模式 10（Skill 工作流模板）、模式 11（Session 記憶持久化）、模式 12（Agent 安全防護），更新辯論 agent prompt 結構、更新導入路徑 |
| v2 | 2026-04-01 | 融合 [instructkr/claw-code](https://github.com/instructkr/claw-code) 分析，新增：模式 7（Tool 權限分級）、模式 8（Tool Schema JSON 規格化）、模式 9（Parity 追蹤）、更新目錄結構、更新導入路徑 |
| v1 | 2026-04-01 | 初版，基於 claude-code-sourcemap 萃取 6 個設計模式 |

---

## 一、背景

透過分析 Claude Code 逆向工程專案與 StockVision v12 營運藍圖，萃取設計模式，結合 LangGraph 框架，融入現有 MVC 架構。 `[v4 更新]`

### 參考來源

| 專案 | 性質 | 價值 |
|------|------|------|
| [ChinaSiro/claude-code-sourcemap](https://github.com/ChinaSiro/claude-code-sourcemap) | 原始碼直接提取（TypeScript） | 原廠設計圖：看內部實作細節、prompt 組裝、tool schema |
| [instructkr/claw-code](https://github.com/instructkr/claw-code) | 逆向後用 Python/Rust 重寫 | 仿造經驗：tool 權限模型、JSON schema 規格化、parity 追蹤方法論 |
| [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) | 生產級 agent 配置套件（129K stars） | 操作層最佳實踐：skill 模板、session 記憶、安全防護、agent prompt 結構 `[v3 新增]` |
| StockVision v12 營運藍圖 | 業務策略與風控規劃 | 數據分級、AutoML、Circuit Breaker、Multi-Agent 對抗、參數高平原方法論 `[v4 新增]` |

### 核心原則

- **claude-code-sourcemap** → 提供設計模式（tool 抽象、coordinator、compaction、task 管理）
- **claw-code** → 補強實作細節（權限分級、JSON schema 驅動、進度追蹤） `[v2 新增]`
- **Everything Claude Code** → 操作層優化（skill 工作流、session 記憶、安全防護、agent prompt 結構） `[v3 新增]`
- **v12 營運藍圖** → 業務層約束（冷熱數據、5 層熔斷、AutoML、Human-in-the-Loop） `[v4 新增]`
- **LangGraph** → 實作框架（state graph、checkpointer、conditional edges）
- **StockVision** → 落地場景

---

## 二、系統架構 `[v4 更新]`

```
┌─────────────────────────────────────────────────────────────┐
│  View     │  Frontend (Vite + React)                         │
├───────────┼──────────────────────────────────────────────────┤
│  Router   │  Worker (Cloudflare)                             │
│           │  • API 路由、Cron 排程觸發                         │
│           │  • D1/KV 資料存取（熱數據）、Queue                  │
├───────────┼──────────────────────────────────────────────────┤
│Controller │  GCP Cloud Run（<200MB 輕量容器）                  │
│           │  • ml-controller (FastAPI + LangGraph)            │
│           │  • 風控攔截、5 層 Circuit Breaker                  │
│           │  • GCS 權重讀取 + 參數載入                          │
│           │  ⚠ 嚴禁執行任何 ML 訓練任務                         │
├───────────┼──────────────────────────────────────────────────┤
│  Model    │  Modal (重型算力)                                  │
│           │  • ML 推論 (10 模型 Ensemble)                      │
│           │  • 模型訓練 + Optuna 自動調參                       │
│           │  • 回測引擎                                        │
├───────────┼──────────────────────────────────────────────────┤
│  Data     │  Shioaji Proxy (即時報價)                          │
│  Layer    │  GCS (冷數據：模型權重、參數配置、歷史歸檔)           │
└───────────┴──────────────────────────────────────────────────┘
```

### 各層職責切割

| 層 | 負責 | 不該做的 |
|---|---|---|
| **Worker (CF)** | 路由、排程觸發、D1/KV 存取（熱數據）、Queue | 不做 ML 推論、不做 LLM 呼叫 |
| **Controller (GCP)** | 編排邏輯、LangGraph 流程、LLM 呼叫、風控攔截、GCS 讀取 | 不存交易數據、不做 ML 訓練、不直接面對前端 |
| **Model (Modal)** | ML 推論、模型訓練、Optuna 調參、回測 | 不做業務邏輯、不做編排 |
| **Shioaji Proxy** | 即時報價轉發 | 只做 quote，不做分析 |
| **Frontend** | UI 渲染 | 不直接 call Modal/GCP |

### 數據冷熱分級 `[v4 新增]`

| 類型 | 存儲 | 內容 | 存取頻率 |
|------|------|------|---------|
| **熱數據** | Cloudflare D1 / KV | 盤中即時訊號、當前持倉、近 60 天特徵（38 張表） | 每秒~每分鐘 |
| **溫數據** | GCS (active) | 模型權重 (.npz/.pkl)、active_config.json、當週 Debate Logs | 每日 |
| **冷數據** | GCS (archive) | 每月 D1 備份 (Parquet/CSV)、歷史回測結果、舊版模型權重 | 每週~每月 |

### Decision Authority Layer（決策權限分層） `[v5 新增]`

**核心原則：LLM 永遠不能是 final authority。**

交易系統中，「誰可以改變決策」必須鎖死：

| 層 | 身份 | 可以做 | 不可以做 |
|---|---|---|---|
| **ML 模型** | 信號產生器 | 出信號、機率、信心度 | 不可改風控規則、不可決定部位 |
| **LLM Agent** | 顧問 / 評論者 | 加 flag、調信心度 ±x%、寫評論、建議停損價 | 不可直接決定交易、不可覆寫風控 |
| **Decision Engine** | 決策者（deterministic） | 根據信號 + 閾值決定 entry/exit、部位大小 | — |
| **Risk Engine** | 攔截者 | 停損停利、部位上限、日損熔斷 | 不可被 agent 覆寫 |
| **Circuit Breaker** | 最終權限 | 停止一切交易 | 硬編碼，任何人/AI 皆無權覆寫 |

決策流程：

```
ML 信號 → Decision Engine（deterministic 閾值判斷）
              ↓
         LLM Agent overlay（可選：加 flag、調信心、寫理由）
              ↓
         Risk Engine（攔截不合規交易）
              ↓
         Circuit Breaker（系統層熔斷）
              ↓
         執行 or 拒絕
```

**關鍵**：LLM agent 是 overlay（疊加層），不是 decision maker。即使 agent 建議「強烈買入」，Decision Engine 的閾值沒過就不會交易。

---

## 三、17 個設計模式 × LangGraph 實作

> 模式 1-6 源自 sourcemap，模式 7-9 源自 claw-code，模式 10-12 源自 ECC，模式 13-17 源自 v12 藍圖 `[v4 更新]`

### 模式 1：Tool System — 把現有服務包成 LangGraph Tools

Claude Code 的核心是把所有能力抽象成 Tool。把現有散落各服務的能力統一封裝：

```python
from langchain_core.tools import tool

@tool
def get_stock_prediction(stock_id: str) -> dict:
    """取得股票 ML 預測結果（含 10 模型集成信號、信心度）"""
    return requests.post(f"{ML_CONTROLLER}/batch-predict",
        json={"stock_ids": [stock_id]}).json()

@tool
def get_chip_analysis(stock_id: str) -> dict:
    """取得籌碼分析（外資/投信/自營買賣超、融資融券）"""
    return requests.get(f"{WORKER_API}/api/stocks/{stock_id}/indicators").json()

@tool
def get_news_sentiment(stock_id: str) -> dict:
    """取得近期新聞情緒分析與關鍵字趨勢"""
    return requests.get(f"{WORKER_API}/api/news?stock={stock_id}").json()

@tool
def get_market_risk() -> dict:
    """取得當前市場風險指標（大盤風險分數、波動率）"""
    return requests.get(f"{WORKER_API}/api/market/risk").json()

@tool
def execute_paper_trade(stock_id: str, action: str, shares: int) -> dict:
    """執行模擬交易（買入/賣出）"""
    return requests.post(f"{WORKER_API}/api/paper/orders",
        json={"stock_id": stock_id, "action": action, "shares": shares}).json()

@tool
def get_portfolio() -> dict:
    """取得目前模擬交易持倉與損益"""
    return requests.get(f"{WORKER_API}/api/paper/portfolio").json()

@tool
def get_realtime_quote(stock_id: str) -> dict:
    """取得即時報價（透過永豐 Shioaji）"""
    return requests.get(f"{SHIOAJI_PROXY}/quote/{stock_id}").json()

@tool
def run_screener(criteria: dict) -> list:
    """執行選股篩選器（熱門族群、技術面突破、籌碼集中）"""
    return requests.post(f"{WORKER_API}/api/stocks/screen", json=criteria).json()
```

---

### 模式 2：ToolSearch — 動態工具載入

Claude Code 不把 40+ 工具全塞進 prompt，按需載入省 token：

```python
from langgraph.prebuilt import create_react_agent

TOOL_REGISTRY = {
    "market_data": [get_stock_prediction, get_chip_analysis, get_realtime_quote],
    "sentiment":   [get_news_sentiment],
    "trading":     [execute_paper_trade, get_portfolio],
    "screening":   [run_screener],
    "risk":        [get_market_risk],
}

@tool
def search_tools(query: str) -> str:
    """搜尋可用的分析工具。輸入關鍵字如 '籌碼', '新聞', '交易', '選股'"""
    results = []
    for category, tools in TOOL_REGISTRY.items():
        for t in tools:
            if query in t.name or query in t.description:
                results.append(f"- {t.name}: {t.description}")
    return "\n".join(results) if results else "未找到相關工具"

def create_agent(mode: str = "full"):
    if mode == "chat":
        # 互動模式：先給少量工具 + search_tools，省 token
        return create_react_agent(llm, [search_tools, get_portfolio, get_market_risk])
    else:
        # 自動化模式：全部工具
        all_tools = [t for tools in TOOL_REGISTRY.values() for t in tools]
        return create_react_agent(llm, all_tools)
```

---

### 模式 3：Coordinator + 多 Agent 辯論

研究階段平行、實作階段序列化。Coordinator 不自己做事，只拆解和彙整：

```python
from langgraph.graph import StateGraph, START, END
from typing import Annotated
from operator import add

class AnalysisState(TypedDict):
    stock_id: str
    stock_data: dict
    opinions: Annotated[list, add]  # 各 agent 觀點（reducer: append）
    verdict: str
    confidence: float
    action: str  # BUY / SELL / HOLD

# --- Agent Nodes ---

async def data_collector(state: AnalysisState) -> dict:
    """Phase 1: 收集所有數據"""
    stock_id = state["stock_id"]
    data = {
        "prediction": await get_stock_prediction.ainvoke(stock_id),
        "chips": await get_chip_analysis.ainvoke(stock_id),
        "news": await get_news_sentiment.ainvoke(stock_id),
        "risk": await get_market_risk.ainvoke(),
        "quote": await get_realtime_quote.ainvoke(stock_id),
    }
    return {"stock_data": data}

async def bull_agent(state: AnalysisState) -> dict:
    """做多派：找買入理由"""
    response = await llm.ainvoke([
        SystemMessage("你是積極型投資分析師，專注找買入機會。"
                      "從技術面突破、籌碼集中、ML做多信號中找支持做多的證據。"
                      "但如果真的找不到理由，也要誠實說。"),
        HumanMessage(f"分析 {state['stock_id']}：\n{json.dumps(state['stock_data'])}")
    ])
    return {"opinions": [{"role": "bull", "analysis": response.content}]}

async def bear_agent(state: AnalysisState) -> dict:
    """做空派：找風險"""
    response = await llm.ainvoke([
        SystemMessage("你是風控分析師，專注識別風險。"
                      "從估值過高、主力出貨、負面新聞、市場風險中找做空理由。"),
        HumanMessage(f"分析 {state['stock_id']}：\n{json.dumps(state['stock_data'])}")
    ])
    return {"opinions": [{"role": "bear", "analysis": response.content}]}

async def quant_agent(state: AnalysisState) -> dict:
    """量化派：純數據"""
    response = await llm.ainvoke([
        SystemMessage("你是量化分析師，只看數字不看故事。"
                      "報告：ML信心度、技術指標位置、籌碼變化趨勢、風險報酬比。"),
        HumanMessage(f"分析 {state['stock_id']}：\n{json.dumps(state['stock_data'])}")
    ])
    return {"opinions": [{"role": "quant", "analysis": response.content}]}

async def verdict_node(state: AnalysisState) -> dict:
    """Coordinator 彙整最終判斷"""
    opinions_text = "\n---\n".join(
        f"【{o['role']}】{o['analysis']}" for o in state["opinions"]
    )
    response = await llm.ainvoke([
        SystemMessage(
            "你是投資決策者。綜合多空與量化觀點，給出最終判斷。"
            "回傳 JSON: {verdict, confidence, action, reasoning}"
            "action 只能是 BUY / SELL / HOLD"),
        HumanMessage(f"三方觀點：\n{opinions_text}")
    ])
    result = json.loads(response.content)
    return {
        "verdict": result["reasoning"],
        "confidence": result["confidence"],
        "action": result["action"],
    }

# --- 組裝 Graph ---
graph = StateGraph(AnalysisState)

graph.add_node("collect_data", data_collector)
graph.add_node("bull", bull_agent)
graph.add_node("bear", bear_agent)
graph.add_node("quant", quant_agent)
graph.add_node("verdict", verdict_node)

graph.add_edge(START, "collect_data")
graph.add_edge("collect_data", "bull")
graph.add_edge("collect_data", "bear")
graph.add_edge("collect_data", "quant")
graph.add_edge("bull", "verdict")
graph.add_edge("bear", "verdict")
graph.add_edge("quant", "verdict")
graph.add_edge("verdict", END)

stock_analyst = graph.compile()
```

---

### 模式 4：Context Compaction — Chat 上下文壓縮

長對話不截斷，用 AI 摘要壓縮：

```python
async def compact_messages(messages: list) -> list:
    """Claude Code 式的上下文壓縮"""
    if len(messages) < 20:
        return messages

    old = messages[1:-6]
    recent = messages[-6:]

    summary = await llm.ainvoke([
        SystemMessage("用 200 字摘要以下對話的重點，保留所有提到的股票代號和結論"),
        *old
    ])

    return [
        messages[0],  # system prompt
        SystemMessage(f"[先前對話摘要] {summary.content}"),
        *recent
    ]

class ChatState(TypedDict):
    messages: Annotated[list, compact_messages]  # 自動壓縮
    portfolio_context: dict  # 持倉快照，不會被壓縮掉
```

---

### 模式 5：Task Lifecycle — Checkpointer 任務追蹤

LangGraph 內建的 checkpointer 取代自建 task tracker：

```python
# ⚠️ [v5 修正] 不要用 SQLite on Cloud Run（stateless + ephemeral /tmp + 多 instance 會亂）
# Option A（簡單）：GCS JSON checkpoint — 適合 Phase 1~3
# Option B（推薦）：Cloud SQL Postgres — 適合 Phase 4+ 需查歷史 state

# Option A: GCS-based checkpoint
from langgraph.checkpoint.memory import MemorySaver
from google.cloud import storage

class GCSCheckpointer:
    """GCS-based checkpointer for Cloud Run stateless environment"""
    def __init__(self, bucket_name: str, prefix: str = "checkpoints"):
        self.client = storage.Client()
        self.bucket = self.client.bucket(bucket_name)
        self.prefix = prefix
        self._memory = MemorySaver()  # in-memory fallback for current request

    async def save(self, thread_id: str, state: dict):
        blob = self.bucket.blob(f"{self.prefix}/{thread_id}.json")
        blob.upload_from_string(json.dumps(state))

    async def load(self, thread_id: str) -> dict | None:
        blob = self.bucket.blob(f"{self.prefix}/{thread_id}.json")
        if blob.exists():
            return json.loads(blob.download_as_string())
        return None

# Option B: Postgres (Phase 4+)
# from langgraph.checkpoint.postgres import PostgresSaver
# checkpointer = PostgresSaver.from_conn_string(CLOUD_SQL_URL)

checkpointer = GCSCheckpointer(bucket_name="stockvision-state")

daily_pipeline = graph.compile(checkpointer=checkpointer)

# 執行（thread_id = 一個 task instance）
config = {"configurable": {"thread_id": f"daily-{date}"}}
result = await daily_pipeline.ainvoke(initial_state, config)

# 隨時查狀態
state = daily_pipeline.get_state(config)
print(state.next)      # 下一步要跑什麼 node
print(state.values)    # 當前 state

# 失敗後從斷點恢復
result = await daily_pipeline.ainvoke(None, config)  # 自動從上次斷點繼續
```

---

### 模式 6：Feature Flags — Conditional Edges

用 KV 或環境變數即時控制功能開關，不用重新部署：

```python
FLAGS = {
    "enable_debate": True,
    "enable_auto_trade": False,
    "enable_news_sentiment": True,
}

def route_after_prediction(state):
    candidates = state["predictions"]
    high_confidence = [s for s in candidates if s["confidence"] > 0.7]

    if FLAGS["enable_debate"] and len(high_confidence) > 0:
        return ["bull", "bear", "quant"]     # 走辯論
    return ["simple_recommend"]               # 走簡單評分

graph.add_conditional_edges("collect_data", route_after_prediction)
```

---

### 模式 7：Tool 權限分級 `[v2 新增]`

claw-code 的 Rust 實作將工具分成三個權限等級，避免 agent 誤操作。對應到 StockVision，交易類工具必須嚴格管控：

```python
from enum import Enum

class ToolPermission(Enum):
    READ_ONLY = "read_only"           # 只讀，自動放行
    WORKSPACE_WRITE = "workspace_write"  # 可寫，需確認
    DANGER_FULL_ACCESS = "danger"     # 危險操作，需雙重確認

# 工具權限註冊表
TOOL_PERMISSIONS = {
    # 唯讀 — agent 可自由呼叫
    "get_stock_prediction":  ToolPermission.READ_ONLY,
    "get_chip_analysis":     ToolPermission.READ_ONLY,
    "get_news_sentiment":    ToolPermission.READ_ONLY,
    "get_market_risk":       ToolPermission.READ_ONLY,
    "get_realtime_quote":    ToolPermission.READ_ONLY,
    "get_portfolio":         ToolPermission.READ_ONLY,
    "run_screener":          ToolPermission.READ_ONLY,

    # 可寫 — 需要 coordinator 確認
    "execute_paper_trade":   ToolPermission.WORKSPACE_WRITE,
    "update_watchlist":      ToolPermission.WORKSPACE_WRITE,
    "set_alert":             ToolPermission.WORKSPACE_WRITE,

    # 危險 — 需要人工確認或特殊 flag
    "execute_real_trade":    ToolPermission.DANGER_FULL_ACCESS,
    "modify_stop_loss":      ToolPermission.DANGER_FULL_ACCESS,
    "cancel_all_orders":     ToolPermission.DANGER_FULL_ACCESS,
}

# LangGraph 中的權限檢查 node
async def permission_gate(state: dict) -> dict:
    """在工具執行前檢查權限"""
    tool_name = state["pending_tool_call"]["name"]
    permission = TOOL_PERMISSIONS.get(tool_name, ToolPermission.READ_ONLY)

    if permission == ToolPermission.READ_ONLY:
        return {"approved": True}
    elif permission == ToolPermission.WORKSPACE_WRITE:
        # 自動化模式：coordinator 自行判斷
        # 互動模式：通知使用者
        return {"approved": state.get("auto_mode", False)}
    else:
        # DANGER：永遠需要人工確認
        return {"approved": False, "reason": f"危險操作 {tool_name} 需要人工確認"}
```

在 LangGraph 中作為 conditional edge 使用：

```python
graph.add_node("permission_gate", permission_gate)
graph.add_node("execute_tool", execute_tool)
graph.add_node("request_human_approval", request_human_approval)

graph.add_conditional_edges("permission_gate", lambda s:
    "execute_tool" if s["approved"] else "request_human_approval"
)
```

---

### 模式 8：Tool Schema JSON 規格化 `[v2 新增]`

claw-code 將 Claude Code 的 25+ 子系統介面匯出成 JSON schema，用 JSON 驅動工具註冊而非硬編碼。這讓工具定義可以動態載入、版本化、跨服務共享：

```python
# tools/schemas/ 目錄放 JSON 定義檔
# tools/schemas/market_data.json
MARKET_DATA_SCHEMA = {
    "name": "get_stock_prediction",
    "description": "取得股票 ML 預測結果（含 10 模型集成信號、信心度）",
    "permission": "read_only",
    "parameters": {
        "type": "object",
        "properties": {
            "stock_id": {
                "type": "string",
                "description": "台股代號，如 2330"
            }
        },
        "required": ["stock_id"]
    },
    "endpoint": {
        "method": "POST",
        "url": "{ML_CONTROLLER}/batch-predict",
        "body_template": {"stock_ids": ["{stock_id}"]}
    },
    "timeout_ms": 30000,
    "retry": 2
}

# 動態載入 JSON → 自動生成 LangGraph tool
import json
from pathlib import Path

def load_tools_from_schemas(schema_dir: str) -> list:
    """從 JSON schema 動態生成 tools，不用手寫每個 @tool"""
    tools = []
    for schema_file in Path(schema_dir).glob("*.json"):
        schemas = json.loads(schema_file.read_text())
        if isinstance(schemas, dict):
            schemas = [schemas]
        for schema in schemas:
            tools.append(create_tool_from_schema(schema))
    return tools

def create_tool_from_schema(schema: dict):
    """根據 JSON schema 動態建立 tool"""
    @tool(name=schema["name"], description=schema["description"])
    async def dynamic_tool(**kwargs) -> dict:
        endpoint = schema["endpoint"]
        url = endpoint["url"].format(**kwargs, **ENV_VARS)
        body = _render_template(endpoint.get("body_template"), kwargs)

        async with httpx.AsyncClient(timeout=schema.get("timeout_ms", 10000) / 1000) as client:
            for attempt in range(schema.get("retry", 1) + 1):
                try:
                    if endpoint["method"] == "GET":
                        resp = await client.get(url)
                    else:
                        resp = await client.post(url, json=body)
                    return resp.json()
                except httpx.TimeoutException:
                    if attempt == schema.get("retry", 1):
                        raise
    return dynamic_tool

# 使用
all_tools = load_tools_from_schemas("tools/schemas/")
```

好處：
- 新增工具只需加一個 JSON 檔，不用改 Python code
- 前端可以讀取同一份 schema 顯示工具說明
- Worker 和 Controller 共享同一份工具定義，避免不一致
- 可以做版本控制，追蹤工具介面變更

---

### 模式 9：Parity 追蹤 `[v2 新增]`  

claw-code 維護 `PARITY.md` 追蹤與原版的實作差距。StockVision 導入 LangGraph 是分階段的，需要追蹤每個模式的導入進度：

```markdown
<!-- PARITY.md -->
# StockVision LangGraph 導入進度

## 狀態標示
- ✅ 已完成
- 🔧 進行中
- ⬚ 未開始
- ❌ 不適用/暫不導入

## 模式導入狀態

| # | 模式 | 狀態 | 備註 |
|---|------|------|------|
| 1 | Tool System | ⬚ | 待 Phase 1 |
| 2 | ToolSearch 動態載入 | ⬚ | 待 Phase 1，chat 模式時啟用 |
| 3 | Coordinator 辯論 | ⬚ | 待 Phase 2 |
| 4 | Context Compaction | ⬚ | 待 Phase 4 |
| 5 | Task Lifecycle | ⬚ | 待 Phase 3 |
| 6 | Feature Flags | ⬚ | 待 Phase 1，最簡單可先做 |
| 7 | Tool 權限分級 | ⬚ | 待 Phase 2，交易工具上線前必須完成 |
| 8 | Tool Schema JSON | ⬚ | 待 Phase 1，配合 Tool System 一起做 |
| 9 | Parity 追蹤 | ✅ | 就是本文件 |
| 10 | Skill 工作流模板 | ⬚ | 待 Phase 3，配合任務鏈一起做 [v3] |
| 11 | Session 記憶持久化 | ⬚ | 待 Phase 4，配合 Chat compaction [v3] |
| 12 | Agent 安全防護 | ⬚ | 待 Phase 2，交易功能上線前必須完成 [v3] |
| 13 | 數據冷熱分級路由 | ⬚ | 待 Phase 1，配合 Tool Schema 加 data_tier [v4] |
| 14 | 5 層 Circuit Breaker | ⬚ | 待 Phase 2，硬編碼安全紅線 [v4] |
| 15 | Optuna 自動調參 Skill | ⬚ | 待 Phase 5，需 Modal Optuna 先部署 [v4] |
| 16 | 週報 AI 審計 Graph | ⬚ | 待 Phase 5，每週五盤後自動觸發 [v4] |
| 17 | Multi-Agent 對抗訓練 | ⬚ | 待 Phase 6，最後導入 [v4] |

## API 介面相容性

| 端點 | 改動前 | 改動後 | 相容 |
|------|--------|--------|------|
| POST /batch-predict | 直接 call Modal | LangGraph graph | ✅ 對外不變 |
| POST /recommend | scorer + 單次 LLM | 辯論 graph | ✅ 對外不變 |
| POST /risk-assess | 直接計算 | LangGraph graph | ✅ 對外不變 |

## 已知差距 / 待辦

- [ ] 辯論 agent 的 system prompt 需要根據實際勝率調優
- [ ] Checkpointer 在 Cloud Run 無狀態環境的持久化方案待定（SQLite vs GCS vs Cloud SQL）
- [ ] Tool Schema JSON 的版本管理機制待定
- [ ] 權限分級在 Discord bot 互動模式的 UX 待設計
```

---

### 模式 10：Skill 工作流模板 `[v3 新增]`

ECC 將常見工作流封裝為可複用的 skill 定義。對應到 StockVision，把重複的分析/交易流程模板化：

```python
# graphs/skills/ 目錄存放可複用的子 graph 模板

# 範例：個股完整分析 skill
STOCK_ANALYSIS_SKILL = {
    "name": "full_stock_analysis",
    "description": "個股完整分析：技術面 + 籌碼面 + ML預測 + 新聞情緒",
    "steps": [
        {"node": "collect_data", "tools": ["get_chip_analysis", "get_realtime_quote"]},
        {"node": "ml_predict", "tools": ["get_stock_prediction"]},
        {"node": "sentiment", "tools": ["get_news_sentiment"]},
        {"node": "synthesize", "output_format": "analysis_report"},
    ],
    "trigger": ["分析 {stock_id}", "看一下 {stock_id}"],  # 自然語言觸發
    "confidence_threshold": 0.8,  # ECC 的信心評分機制
}

# 範例：每日開盤前檢查 skill
MORNING_CHECK_SKILL = {
    "name": "morning_check",
    "description": "開盤前持倉健檢：停損停利檢查 + 市場風險 + 隔夜美股影響",
    "steps": [
        {"node": "check_portfolio", "tools": ["get_portfolio"]},
        {"node": "check_risk", "tools": ["get_market_risk"]},
        {"node": "check_us_market", "tools": ["get_us_leading_indicators"]},
        {"node": "generate_briefing", "output_format": "morning_briefing"},
    ],
    "schedule": "07:15 Asia/Taipei",  # 可掛到 cron
}

# Skill 載入器：把 skill 定義轉成 LangGraph subgraph
def load_skill_as_subgraph(skill_def: dict) -> StateGraph:
    """將 skill 定義動態轉成 LangGraph 子圖"""
    graph = StateGraph(SkillState)
    prev_node = START
    for step in skill_def["steps"]:
        node_name = step["node"]
        tools = [TOOL_REGISTRY[t] for t in step.get("tools", [])]
        graph.add_node(node_name, create_skill_node(tools, step))
        graph.add_edge(prev_node, node_name)
        prev_node = node_name
    graph.add_edge(prev_node, END)
    return graph.compile()

# 所有 skill 註冊表
SKILL_REGISTRY = {
    s["name"]: load_skill_as_subgraph(s)
    for s in [STOCK_ANALYSIS_SKILL, MORNING_CHECK_SKILL]
}
```

好處：
- 新增分析流程只需定義 JSON/dict，不用寫新的 graph code
- 可以從 session 中自動萃取高頻操作模式轉成 skill（ECC 的持續學習）
- 前端可以列出所有 skill 供使用者一鍵觸發
- Discord bot 可以用自然語言 trigger 匹配 skill

---

### 模式 11：Session 記憶持久化 `[v3 新增]`

ECC 的 hooks 在 session 結束時自動萃取重要資訊存成記憶。對應到 StockVision，讓 AI 分析具有跨 session 連續性：

```python
from langgraph.store.memory import InMemoryStore
# 生產環境可換成 PostgresStore 或 GCS

memory_store = InMemoryStore()

class SessionMemory(TypedDict):
    """跨 session 持久化的記憶"""
    # 使用者偏好
    user_preferences: dict        # 如：偏好科技股、風險承受度中等
    # 歷史決策記錄
    past_decisions: list          # 過去的 BUY/SELL 決策及結果
    # 學到的模式
    learned_patterns: list        # 如：「該使用者問 XX 股時通常想做短線」
    # 持倉快照
    last_portfolio_snapshot: dict # 上次 session 結束時的持倉

# Session 結束時的記憶萃取 hook
async def on_session_end(state: dict, config: dict):
    """從本次對話中萃取值得記住的資訊"""
    user_id = config["configurable"]["user_id"]

    # 用 LLM 萃取本次 session 的關鍵資訊
    extraction = await llm.ainvoke([
        SystemMessage(
            "從以下對話中萃取值得記住的資訊，回傳 JSON：\n"
            "- new_preferences: 使用者表達的新偏好\n"
            "- decisions_made: 本次做的投資決策\n"
            "- patterns_observed: 觀察到的行為模式\n"
            "如果沒有值得記住的就回傳空物件"),
        HumanMessage(str(state["messages"][-20:]))  # 最近 20 則
    ])

    memory = json.loads(extraction.content)
    if memory:
        memory_store.put(
            namespace=("user", user_id),
            key=f"session-{datetime.now().isoformat()}",
            value=memory
        )

# Session 開始時注入歷史記憶
async def on_session_start(state: dict, config: dict):
    """載入使用者的歷史記憶作為 context"""
    user_id = config["configurable"]["user_id"]
    memories = memory_store.search(namespace=("user", user_id), limit=10)

    if memories:
        memory_summary = "\n".join(
            f"- [{m.key}] {json.dumps(m.value, ensure_ascii=False)}"
            for m in memories
        )
        return {"context": f"使用者歷史記憶：\n{memory_summary}"}
    return {}
```

應用場景：
- 使用者上次說「2330 太貴了不想買」→ 這次推薦不會再推 2330
- 追蹤過去推薦的準確率 → 動態調整信心閾值
- 記住使用者偏好的分析深度和風格

**⚠️ 安全限制 `[v5 新增]`**：Session Memory **不可流入交易決策 graph**。

```python
# Memory 只允許影響的範圍
MEMORY_ALLOWED_SCOPE = {
    "ui_personalization": True,   # ✅ 報告措辭、顯示偏好
    "report_wording": True,       # ✅ 分析報告語氣
    "chat_context": True,         # ✅ 對話連續性
    "trading_decision": False,    # ❌ 禁止影響交易決策
    "risk_parameters": False,     # ❌ 禁止影響風控參數
    "model_weights": False,       # ❌ 禁止影響模型權重
}
```

---

### 模式 12：Agent 安全防護 `[v3 新增]`

ECC 的 AgentShield 概念：掃描 agent 配置是否有安全漏洞。對 StockVision 尤其重要，因為涉及交易操作：

```python
# tools/security.py

class AgentSecurityGuard:
    """防止 agent 被 prompt injection 或異常行為影響交易"""

    # 交易類操作的安全規則
    TRADE_RULES = {
        "max_single_trade_amount": 100_000,     # 單筆上限 10 萬
        "max_daily_trades": 10,                  # 每日最多 10 筆
        "max_daily_loss": 50_000,                # 日虧損上限 5 萬
        "blocked_hours": [(0, 8), (14, 24)],     # 非交易時段禁止下單
        "require_human_confirm_above": 50_000,   # 5 萬以上需人工確認
    }

    def validate_trade(self, trade: dict) -> tuple[bool, str]:
        """在工具執行前驗證交易是否合規"""
        # 金額檢查
        amount = trade["price"] * trade["shares"]
        if amount > self.TRADE_RULES["max_single_trade_amount"]:
            return False, f"單筆金額 {amount} 超過上限"

        # 時段檢查
        hour = datetime.now(tz=ZoneInfo("Asia/Taipei")).hour
        for start, end in self.TRADE_RULES["blocked_hours"]:
            if start <= hour < end:
                return False, f"非交易時段 ({hour}:00)，禁止下單"

        # 日損檢查
        daily_loss = self.get_today_realized_loss()
        if daily_loss > self.TRADE_RULES["max_daily_loss"]:
            return False, f"今日已虧損 {daily_loss}，觸發日損上限熔斷"

        return True, "OK"

    def detect_prompt_injection(self, user_input: str) -> bool:
        """偵測可疑的 prompt injection 企圖"""
        suspicious_patterns = [
            r"ignore previous instructions",
            r"you are now",
            r"system:\s*",
            r"買入所有",
            r"全部賣出",
            r"清倉",
        ]
        return any(re.search(p, user_input, re.IGNORECASE) for p in suspicious_patterns)

    def audit_log(self, action: str, details: dict):
        """所有交易相關操作留下審計軌跡"""
        log_entry = {
            "timestamp": datetime.now().isoformat(),
            "action": action,
            "details": details,
            "source": "agent",  # 標記是 agent 觸發的
        }
        # 寫入 D1 audit table，供後續追溯
        requests.post(f"{WORKER_API}/api/system/audit", json=log_entry)

# 在 LangGraph 中作為 guard node
security = AgentSecurityGuard()

async def trade_guard(state: dict) -> dict:
    """交易前的安全閘門"""
    trade = state["pending_trade"]

    # 1. Prompt injection 檢查
    if security.detect_prompt_injection(state.get("original_input", "")):
        security.audit_log("blocked_injection", {"input": state["original_input"]})
        return {"approved": False, "reason": "偵測到可疑指令，已攔截"}

    # 2. 交易規則檢查
    ok, reason = security.validate_trade(trade)
    if not ok:
        security.audit_log("blocked_trade", {"trade": trade, "reason": reason})
        return {"approved": False, "reason": reason}

    security.audit_log("approved_trade", {"trade": trade})
    return {"approved": True}
```

安全防護四層架構 `[v5 更新]`：
- **模式 7** = 「這個工具誰能用」（身份/角色層）
- **模式 12** = 「這筆操作合不合規」（業務規則層 + 攻擊偵測）
- **模式 14** = 「整個系統是否該停止」（硬編碼熔斷層，不可覆寫）
- **Decision Authority** = 「誰有權改變決策」（見 §二 Decision Authority Layer）

---

### 模式 13：數據冷熱分級路由 `[v4 新增]`

Tool Schema（模式 8）加入 `data_tier` 欄位，讓 agent 自動選擇正確的數據源：

```python
# tools/schemas/market_data.json 加入 data_tier
TOOL_DATA_TIERS = {
    "get_realtime_quote":    {"tier": "hot",  "source": "shioaji_proxy"},
    "get_chip_analysis":     {"tier": "hot",  "source": "worker_d1"},
    "get_stock_prediction":  {"tier": "hot",  "source": "worker_kv"},
    "get_model_weights":     {"tier": "warm", "source": "gcs_active"},
    "get_active_config":     {"tier": "warm", "source": "gcs_active"},
    "get_debate_logs":       {"tier": "warm", "source": "gcs_active"},
    "get_backtest_history":  {"tier": "cold", "source": "gcs_archive"},
    "get_monthly_backup":    {"tier": "cold", "source": "gcs_archive"},
}

# LangGraph tool 自動根據 tier 選擇 timeout 和 retry 策略
TIER_CONFIG = {
    "hot":  {"timeout_ms": 5_000,  "retry": 1},  # 即時，快速失敗
    "warm": {"timeout_ms": 30_000, "retry": 2},  # 容許較慢
    "cold": {"timeout_ms": 60_000, "retry": 3},  # 歸檔查詢，可以等
}
```

---

### 模式 14：5 層 Circuit Breaker `[v4 新增]`

v12 藍圖的硬編碼安全紅線，融入 LangGraph 的 guard node。任何 AI 或優化器皆無權覆寫：

```python
# security/circuit_breaker.py

class CircuitBreaker:
    """5 層熔斷機制 — 硬編碼於 GCP Controller，不可被 agent 覆寫"""

    async def check_all(self, state: dict) -> tuple[bool, str]:
        """依序檢查 5 層熔斷器，任一觸發即進入 SafeMode"""

        # Layer 1: 每日下單金額上限
        daily_total = await self.get_today_order_total()
        if daily_total >= 200_000:
            return False, "L1 熔斷：每日 20 萬下單上限已達"

        # Layer 2: 日內虧損上限
        daily_pnl = await self.get_today_realized_pnl()
        if daily_pnl <= -50_000:
            return False, "L2 熔斷：日內虧損超過 5 萬"

        # Layer 3: 大盤系統性風險
        market_risk = await self.get_market_risk_score()
        if market_risk > 80:
            return False, f"L3 熔斷：大盤風險分數 {market_risk} > 80"

        # Layer 4: VIX 飆升（全球恐慌）
        vix = await self.get_vix()
        if vix > 30:
            return False, f"L4 熔斷：VIX {vix} > 30，全球恐慌模式"

        # Layer 5: 連續停損觸發（策略失靈）
        consecutive_stops = await self.get_consecutive_stop_losses()
        if consecutive_stops >= 3:
            return False, f"L5 熔斷：連續 {consecutive_stops} 檔停損，策略可能失靈"

        return True, "OK"

    async def enter_safe_mode(self, reason: str):
        """觸發 SafeMode：停止所有自動交易 + 發 Discord 警報"""
        await self.disable_auto_trading()
        await self.send_discord_alert(f"🚨 SafeMode 啟動：{reason}")
        await self.log_circuit_break(reason)

# LangGraph 整合：每個交易 graph 的入口都必須過 circuit breaker
async def circuit_breaker_node(state: dict) -> dict:
    cb = CircuitBreaker()
    ok, reason = await cb.check_all(state)
    if not ok:
        await cb.enter_safe_mode(reason)
        return {"approved": False, "reason": reason, "safe_mode": True}
    return {"approved": True}

# 在所有交易相關 graph 中，circuit_breaker 是第一個 node
graph.add_edge(START, "circuit_breaker")
graph.add_conditional_edges("circuit_breaker", lambda s:
    "proceed" if s["approved"] else END
)
```

---

### 模式 15：Optuna 自動調參 Skill `[v4 新增]`

將 v12 的雙層優化迴路包成 LangGraph skill，在 Modal 執行：

```python
# skills/weekly_optimization.py

WEEKLY_OPTIMIZATION_SKILL = {
    "name": "weekly_optimization",
    "description": "週報後自動調參：Optuna 在 Modal 跑參數搜尋 → 人工確認 → 寫入 GCS",
    "schedule": "Friday 16:30 Asia/Taipei",
    "steps": [
        {
            "node": "export_weekly_data",
            "description": "從 D1/GCS 匯出本週交易數據、模型權重變化、Debate 紀錄",
            "tools": ["get_backtest_history", "get_debate_logs", "get_portfolio"],
        },
        {
            "node": "run_optuna",
            "description": "在 Modal 啟動 Optuna，搜尋高平原參數組合",
            "tools": ["trigger_modal_optuna"],
            "config": {
                "n_trials": 200,
                # 目標函數包含穩定度懲罰，尋找高平原而非孤峰
                "objective": "mean_returns - 1.5 * std_returns",
                "param_space": {
                    "learning_rate": [0.001, 0.1],
                    "linucb_alpha": [0.1, 2.0],
                    "garch_threshold": [0.01, 0.05],
                    "stop_loss_pct": [0.03, 0.08],
                    "take_profit_pct": [0.05, 0.15],
                },
                # ⚠️ [v5 新增] Out-of-Sample Lock — 防止 Optuna + LLM 雙重 overfit
                "data_split": {
                    "train": 90,       # Optuna 優化用（天）
                    "validation": 30,  # Optuna 可見但不可優化
                    "test": 30,        # Optuna + LLM 皆不可見，僅 human 審查
                },
                # LLM audit 只能看 validation + test 結果，不可看 train performance
                "audit_visible_splits": ["validation", "test"],
            }
        },
        {
            "node": "ai_audit",
            "description": "LLM 審計 Optuna 結果，檢查是否為孤峰而非高平原",
            "tools": [],  # 純 LLM 分析
        },
        {
            "node": "human_approval",
            "description": "Discord 通知，等待人工確認",
            "require_human_confirm": True,
        },
        {
            "node": "apply_config",
            "description": "寫入 GCS active_config.json 生效",
            "tools": ["write_gcs_config"],
        },
    ],
}

# 雙層優化迴路對照：
# 內層 (Daily) = 現有 LinUCB + ARF，每日自動跑，不需 LangGraph 介入
# 外層 (Weekly) = 這個 skill，每週五跑，需要人工確認
```

---

### 模式 16：週報 AI 審計 Graph `[v4 新增]`

v12 的「每週人工呼叫本地 AI Team」結構化為 LangGraph：

```python
# graphs/weekly_audit_graph.py

class WeeklyAuditState(TypedDict):
    week_data: dict              # 本週交易數據包
    logic_audit: str             # 邏輯審計結果
    param_suggestions: dict      # 超參數建議
    debate_review: str           # Debate 品質檢討
    final_report: str            # 週報

graph = StateGraph(WeeklyAuditState)

async def export_week_data(state):
    """匯出本週數據包"""
    data = {
        "trades": await get_weekly_trades(),
        "model_accuracy": await get_weekly_accuracy(),
        "debate_logs": await get_weekly_debates(),
        "portfolio_snapshot": await get_portfolio(),
        "market_context": await get_weekly_market_summary(),
    }
    return {"week_data": data}

async def logic_auditor(state):
    """邏輯審計：檢查 ML 高分但停損的個股，是否有辯論幻覺"""
    response = await llm.ainvoke([
        SystemMessage(
            "你是投資邏輯審計師。分析以下本週交易中「ML 高分但最終停損」的個股。\n"
            "檢查多空辯論（Debate）紀錄中是否存在：\n"
            "1. 邏輯幻覺（看似合理但前提錯誤的推論）\n"
            "2. 資訊遺漏（忽略了關鍵的利空/利多）\n"
            "3. 過度自信（信心度與實際表現嚴重脫節）\n"
            "給出具體案例和改善建議。"),
        HumanMessage(json.dumps(state["week_data"], ensure_ascii=False))
    ])
    return {"logic_audit": response.content}

async def param_advisor(state):
    """超參數建議：根據本週市場環境建議調整"""
    response = await llm.ainvoke([
        SystemMessage(
            "你是量化策略顧問。根據本週市場環境和交易表現，\n"
            "建議下週的超參數調整方向：\n"
            "- LinUCB 探索率 α（目前的探索/利用平衡是否恰當？）\n"
            "- GARCH 門檻（波動率估計是否過敏或過鈍？）\n"
            "- 停損/停利比例（是否需要收緊或放寬？）\n"
            "注意：追求參數高平原，避免孤峰。"),
        HumanMessage(json.dumps(state["week_data"], ensure_ascii=False))
    ])
    return {"param_suggestions": json.loads(response.content)}

async def generate_weekly_report(state):
    """生成最終週報"""
    response = await llm.ainvoke([
        SystemMessage("綜合所有審計結果，生成一份簡潔的週報摘要。"),
        HumanMessage(json.dumps({
            "logic_audit": state["logic_audit"],
            "param_suggestions": state["param_suggestions"],
        }, ensure_ascii=False))
    ])
    return {"final_report": response.content}

graph.add_node("export", export_week_data)
graph.add_node("logic_audit", logic_auditor)
graph.add_node("param_advisor", param_advisor)
graph.add_node("report", generate_weekly_report)

graph.add_edge(START, "export")
graph.add_edge("export", "logic_audit")   # 平行
graph.add_edge("export", "param_advisor") # 平行
graph.add_edge("logic_audit", "report")
graph.add_edge("param_advisor", "report")
graph.add_edge("report", END)

weekly_audit = graph.compile()
```

---

### 模式 17：Multi-Agent 對抗訓練 `[v4 新增]`

v12 的「紅藍軍 AI Team」，用 LangGraph 實作對抗式策略驗證：

```python
# graphs/adversarial_graph.py — 未來 Phase，先定義架構

class AdversarialState(TypedDict):
    strategy: dict                 # 待驗證的策略
    blue_team_result: dict         # 藍軍（優化做多）結果
    red_team_result: dict          # 紅軍（模擬極端做空）結果
    stress_test_passed: bool       # 壓力測試是否通過
    robustness_score: float        # 抗脆弱性評分

async def blue_team(state):
    """藍軍：在正常市場環境下優化策略表現"""
    response = await llm.ainvoke([
        SystemMessage(
            "你是藍軍策略優化師。\n"
            "目標：在正常市場環境下，優化以下策略的 Sharpe Ratio。\n"
            "給出具體的參數微調建議和預期改善。"),
        HumanMessage(json.dumps(state["strategy"]))
    ])
    return {"blue_team_result": json.loads(response.content)}

async def red_team(state):
    """紅軍：模擬極端市場環境，壓力測試策略"""
    response = await llm.ainvoke([
        SystemMessage(
            "你是紅軍壓力測試師。\n"
            "目標：模擬以下極端情境，檢驗策略是否會崩潰：\n"
            "1. 大盤連續 5 日跌停（2020/03 等級）\n"
            "2. 單一持股突發利空（財報造假、下市）\n"
            "3. 流動性枯竭（掛單簿極薄）\n"
            "4. 外資連續大幅賣超（匯率危機）\n"
            "5. 系統性風險（央行升息超預期）\n"
            "每個情境給出策略的預估最大虧損和存活率。"),
        HumanMessage(json.dumps(state["strategy"]))
    ])
    return {"red_team_result": json.loads(response.content)}

async def judge(state):
    """裁判：綜合紅藍軍結果，評估策略抗脆弱性"""
    response = await llm.ainvoke([
        SystemMessage(
            "你是策略審核官。綜合藍軍的優化建議和紅軍的壓力測試結果，\n"
            "評估此策略的抗脆弱性。回傳 JSON：\n"
            "- robustness_score: 0-100 分\n"
            "- stress_test_passed: bool（score > 60 才算通過）\n"
            "- recommendations: 改善建議列表\n"
            "- kill_switch_conditions: 建議新增的熔斷條件"),
        HumanMessage(json.dumps({
            "blue": state["blue_team_result"],
            "red": state["red_team_result"],
        }))
    ])
    result = json.loads(response.content)
    return {
        "robustness_score": result["robustness_score"],
        "stress_test_passed": result["stress_test_passed"],
    }

# Graph 結構：藍紅平行 → 裁判
graph = StateGraph(AdversarialState)
graph.add_node("blue_team", blue_team)
graph.add_node("red_team", red_team)
graph.add_node("judge", judge)

graph.add_edge(START, "blue_team")
graph.add_edge(START, "red_team")
graph.add_edge("blue_team", "judge")
graph.add_edge("red_team", "judge")
graph.add_edge("judge", END)
```

**⚠️ 紅軍升級路徑 `[v5 修正]`**：

LLM 模擬極端市場是不夠的（LLM 不會真正模擬流動性崩潰）。紅軍必須分兩階段升級：

| 階段 | 紅軍能力 | 實作方式 |
|------|---------|---------|
| **Phase 6a（先做）** | Historical Replay | 用 Modal 回測引擎跑歷史極端行情（2020/03 崩盤、2022 熊市、2008 金融海嘯） |
| **Phase 6b（後做）** | Synthetic Shock | 人工合成極端情境：gap down 10%、流動性枯竭、order book 極薄 |
| **LLM 角色** | 輔助分析 | LLM 只負責解讀回測結果、找出策略弱點，不負責模擬市場本身 |

---

## 三.一、辯論 Agent Prompt 結構優化 `[v3 新增]`

參考 ECC 的 36 個 subagent 定義方式，為辯論 agent 設計更結構化的 system prompt：

```python
# ECC 風格的 agent 定義：角色 + 能力邊界 + 輸出格式 + 限制

BULL_AGENT_PROMPT = """## 角色
你是 StockVision 的積極型投資分析師。

## 能力範圍
- 技術分析：均線、KD、MACD、布林通道突破信號
- 籌碼分析：外資/投信連續買超、融資減少
- ML 信號：模型集成做多信號、信心度

## 分析框架
1. 先看 ML 預測方向和信心度
2. 再看技術面是否有突破/支撐
3. 最後看籌碼面是否有主力進場跡象
4. 綜合給出做多理由的強度（1-10 分）

## 輸出格式
{
  "stance": "bullish",
  "score": 1-10,
  "key_reasons": ["理由1", "理由2", "理由3"],
  "risk_acknowledged": "即使看多，最大的風險是...",
  "entry_suggestion": {"price": ..., "stop_loss": ...}
}

## 限制
- 不能忽略明顯的利空訊號，必須在 risk_acknowledged 中提及
- 沒有做多理由時 score 必須 < 3
- 不能建議超過持倉 20% 的單一個股配置
"""

BEAR_AGENT_PROMPT = """## 角色
你是 StockVision 的風控分析師。

## 能力範圍
- 估值分析：本益比位置、股價淨值比、歷史估值區間
- 風險信號：主力出貨、融資暴增、負面新聞密集
- 市場風險：大盤風險分數、類股輪動離場

## 分析框架
1. 先看市場整體風險環境
2. 再看個股估值是否偏高
3. 最後看是否有出貨或利空跡象
4. 綜合給出風險等級（1-10 分）

## 輸出格式
{
  "stance": "bearish",
  "risk_score": 1-10,
  "key_risks": ["風險1", "風險2", "風險3"],
  "upside_acknowledged": "即使看空，可能的做多理由是...",
  "exit_suggestion": {"stop_loss": ..., "take_profit": ...}
}

## 限制
- 不能為了看空而忽略明顯的利多，必須在 upside_acknowledged 中提及
- 純粹因為「漲太多」不算有效看空理由，必須有具體數據支撐
"""
```

## 四、ml-controller 目錄結構變更

```
ml-controller/
├── main.py              # FastAPI 入口（不動）
├── routers/
│   ├── predict.py       # POST /batch-predict（內部改 call graph）
│   ├── recommend.py     # POST /recommend（同上）
│   └── risk.py          # POST /risk-assess（同上）
├── services/            # 現有服務（擴充）
│   ├── modal_client.py  # 呼叫 Modal
│   ├── scorer.py        # 評分邏輯
│   ├── adaptive.py      # 自適應參數
│   ├── portfolio.py     # [v5] 投組建構（sector cap, correlation, risk parity）
│   ├── execution.py     # [v5] 成交模擬（slippage, partial fill, limit lock, gap, 跌停）
│   ├── resilience.py    # [v6] 服務降級管理（FM-11）
│   ├── data_validator.py # [v6] 資料品質驗證（FM-12）
│   ├── ensemble_monitor.py # [v6] 模型共錯偵測（FM-5）
│   └── alignment.py     # [v6] Label 對齊檢查（FM-6）
├── graphs/              # 新增：LangGraph 流程定義
│   ├── predict_graph.py # ML 預測流程 graph
│   ├── recommend_graph.py # 推薦辯論 graph
│   ├── daily_pipeline.py  # 每日完整流程 graph
│   ├── weekly_audit_graph.py  # [v4] 週報 AI 審計
│   └── adversarial_graph.py   # [v4] 紅藍軍對抗驗證
├── tools/               # 新增：把 services 包成 LangGraph tools
│   ├── ml_tools.py      # 包裝 modal_client
│   ├── data_tools.py    # 包裝 Worker API 呼叫
│   ├── trade_tools.py   # 包裝交易相關
│   ├── agent_overlay.py # [v6] Agent 只扣分不加分（FM-9）
│   ├── permissions.py   # [v2] 工具權限分級邏輯
│   └── schemas/         # [v2] JSON schema 驅動工具定義
│       ├── market_data.json
│       ├── trading.json
│       ├── sentiment.json
│       └── risk.json
├── skills/              # [v3] Skill 工作流模板定義
│   ├── stock_analysis.py
│   ├── morning_check.py
│   ├── weekly_optimization.py # [v4] Optuna 自動調參 skill
│   └── loader.py        # skill → subgraph 轉換器
├── memory/              # [v3] Session 記憶持久化
│   ├── store.py         # 記憶存取層
│   └── hooks.py         # session start/end hooks
├── security/            # [v3] Agent 安全防護
│   ├── guard.py         # 交易安全閘門
│   ├── circuit_breaker.py # [v4] 5 層熔斷機制（硬編碼，不可覆寫）
│   ├── injection.py     # prompt injection 偵測
│   ├── prompt_versioning.py # [v6] Prompt 版本控制（FM-8）
│   └── audit.py         # 審計日誌
├── PARITY.md            # [v2] 導入進度追蹤
└── requirements.txt     # 加 langgraph
```

Router 改動範例：

```python
# routers/predict.py

# 改之前
@router.post("/batch-predict")
async def batch_predict(req: PredictRequest):
    results = await modal_client.predict_batch(req.stock_ids)
    scored = scorer.score(results)
    return scored

# 改之後
from graphs.predict_graph import predict_graph

@router.post("/batch-predict")
async def batch_predict(req: PredictRequest):
    result = await predict_graph.ainvoke(
        {"stock_ids": req.stock_ids},
        {"configurable": {"thread_id": f"predict-{req.date}"}}
    )
    return result["final_predictions"]
```

**對外 API 介面完全不變**，Worker 不需要知道 controller 內部改用了 LangGraph。

---

## 五、費用預估

LangGraph 是 Python library，不是 infrastructure，不會產生額外 GCP 費用。

| 項目 | 現在 | 加 LangGraph 後 | 差異 |
|------|------|----------------|------|
| Cloud Run | ~$5/月 | ~$6/月 | +$1（多幾秒運算） |
| Modal (ML) | 現有費用 | 一樣 | 不變 |
| Claude API (LLM) | 現有費用 | +$3~5/月 | 辯論模式（Haiku） |
| Checkpointer | $0 | ~$0 | GCS JSON（幾乎免費）或 Cloud SQL（~$7/月） `[v5 修正]` |
| **合計增量** | | | **+$4~6/月** |

### 省錢策略

```python
# 1. 不是每檔都跑辯論，只有高信心候選才跑
high_confidence = [s for s in candidates if s["confidence"] > 0.7]

# 2. 辯論用 Haiku，最終 verdict 才用 Sonnet
BULL_MODEL = "claude-haiku-4-5-20251001"     # 便宜
BEAR_MODEL = "claude-haiku-4-5-20251001"     # 便宜
VERDICT_MODEL = "claude-sonnet-4-6"           # 只有最後一步用好模型

# 3. [v5 修正] Checkpointer 用 GCS JSON（Cloud Run 不支援 SQLite）
# Phase 1~3: GCS JSON checkpoint（免費）
# Phase 4+: 考慮 Cloud SQL Postgres（~$7/月）
```

---

## 六、系統層補強建議 `[v5 新增]`

以下建議不屬於 LangGraph 模式，但對交易系統的生產品質至關重要：

### 6.1 Portfolio Construction Layer（投組建構層）

目前系統單股決策強，但投資組合層面較薄。建議在 Decision Engine 內加入：

| 機制 | 說明 | 實作位置 |
|------|------|---------|
| **Sector Cap** | 單一類股持倉不超過 30% | ml-controller/services/scorer.py |
| **Correlation Cap** | 高度相關的持股不超過 2 檔 | ml-controller/services/scorer.py |
| **Crowdedness Penalty** | 外資/投信持股比例過高的個股降分 | ml-controller/services/scorer.py |
| **Volatility Scaling** | 根據個股波動率調整部位大小 | ml-controller/services/adaptive.py |
| **Risk Parity** | 等風險貢獻的部位分配 | ml-controller/services/adaptive.py |

```python
# services/portfolio.py（新增）

class PortfolioConstructor:
    """投組建構：從個股信號到部位分配"""

    CONSTRAINTS = {
        "max_sector_weight": 0.30,      # 單一類股 ≤ 30%
        "max_single_stock_weight": 0.15, # 單一個股 ≤ 15%
        "max_correlated_pairs": 2,       # 高相關（>0.7）持股 ≤ 2 檔
        "max_positions": 8,              # 同時持有 ≤ 8 檔
    }

    def construct(self, candidates: list[dict], portfolio_value: float) -> list[dict]:
        """從推薦候選產生最終部位分配"""
        # 1. 依信心度排序
        ranked = sorted(candidates, key=lambda x: x["confidence"], reverse=True)

        # 2. 波動率反比部位 (volatility scaling)
        for c in ranked:
            c["raw_weight"] = 1.0 / max(c["volatility"], 0.01)

        # 3. 套用約束
        selected = []
        sector_weights = {}
        for c in ranked:
            sector = c["sector"]
            current_sector_w = sector_weights.get(sector, 0)

            if current_sector_w + c["raw_weight"] > self.CONSTRAINTS["max_sector_weight"]:
                continue
            if len(selected) >= self.CONSTRAINTS["max_positions"]:
                break

            selected.append(c)
            sector_weights[sector] = current_sector_w + c["raw_weight"]

        # 4. 正規化權重
        total_w = sum(s["raw_weight"] for s in selected)
        for s in selected:
            s["weight"] = min(
                s["raw_weight"] / total_w,
                self.CONSTRAINTS["max_single_stock_weight"]
            )
            s["shares"] = int(portfolio_value * s["weight"] / s["price"] / 1000) * 1000

        return selected
```

### 6.2 Execution Reality Layer（成交模擬層）

目前 paper trading 假設「掛單即成交」，與實盤有落差。建議加入：

| 機制 | 說明 | 影響 |
|------|------|------|
| **Slippage Model** | 模擬實際成交價與掛單價的偏差 | 小型股影響大（0.5~2%） |
| **Partial Fill** | 模擬部分成交（量能不足） | 日均量 < 500 張的股票 |
| **Limit Order Lock** | 限價單未成交時的處理邏輯 | 避免「永遠掛不到」的假象 |
| **Market Impact** | 大單對股價的衝擊估算 | 部位 > 日均量 5% 時需考慮 |

```python
# services/execution.py（新增）

class ExecutionSimulator:
    """模擬實際成交環境，讓 paper trading 更貼近實盤"""

    def simulate_fill(self, order: dict, market_data: dict) -> dict:
        """模擬成交結果"""
        avg_volume = market_data["avg_daily_volume"]
        order_size = order["shares"]

        # 1. Slippage：根據流動性估算滑價
        liquidity_ratio = order_size / max(avg_volume, 1)
        if liquidity_ratio > 0.05:
            slippage_pct = 0.005 + liquidity_ratio * 0.1  # 基礎 0.5% + 衝擊
        else:
            slippage_pct = 0.001  # 高流動性：0.1%

        # 2. 實際成交價
        if order["side"] == "buy":
            fill_price = order["price"] * (1 + slippage_pct)
        else:
            fill_price = order["price"] * (1 - slippage_pct)

        # 3. Partial Fill：日均量不足時部分成交
        max_fillable = int(avg_volume * 0.1)  # 最多吃日均量 10%
        filled_shares = min(order_size, max_fillable)

        # 4. Limit Order：價格偏離過大則不成交
        if order["type"] == "limit":
            current_price = market_data["current_price"]
            if order["side"] == "buy" and order["price"] < current_price * 0.995:
                filled_shares = 0  # 掛太低，沒成交
            elif order["side"] == "sell" and order["price"] > current_price * 1.005:
                filled_shares = 0  # 掛太高，沒成交

        return {
            "filled_shares": filled_shares,
            "fill_price": round(fill_price, 2),
            "slippage_pct": slippage_pct,
            "partial_fill": filled_shares < order_size,
        }
```

### 6.3 三層觀測系統（Observability Stack）

確保系統不會「迷路」，需要三層觀測：

| Level | 觀測什麼 | 指標 | 存儲 |
|-------|---------|------|------|
| **L1 Trade** | 交易表現 | PnL、勝率、MDD、Sharpe | D1 daily_snapshot |
| **L2 Decision** | 決策過程 | 哪個模組影響 decision、threshold 值、bandit weight | GCS debate_logs |
| **L3 Model** | 模型健康 | per-model accuracy、error correlation、drift detection | GCS model_metrics |

---

## 七、導入路徑 `[v7 更新]`

| Phase | 項目 | 涵蓋 | 說明 |
|-------|------|------|------|
| **Phase 0** | **Screener 重構** | **§九** | **最優先：Bottom-up 多因子 + RRG + 去重 + 資料品質。源頭乾淨，後面才有意義** `[v7 新增]` |
| **Phase 1** | 基礎建設 | 模式 1, 6, 8, 9, 13 | Tool System + Feature Flags + JSON Schema + PARITY.md + 數據分級路由 |
| **Phase 2** | 辯論 + 權限 + 安全 | 模式 3, 7, 12, 14 + Decision Authority | Coordinator 辯論 + 權限分級 + 安全防護 + Circuit Breaker + 決策權限分層 |
| **Phase 2.5** | 成交模擬 | §6.2 Execution Reality | Slippage、Partial Fill、Limit Lock |
| **Phase 3** | 任務鏈 + Skill + 投組 | 模式 5, 10 + §6.1 Portfolio | Cron pipeline + checkpointer + Skill + Portfolio Construction |
| **Phase 4** | 智能互動 + 記憶 | 模式 2, 4, 11 | ToolSearch + Chat compaction + Session 記憶（限 UI 範圍） |
| **Phase 5** | 自我演化 | 模式 15, 16 + §6.3 Observability | Optuna（含 OOS lock）+ 週報審計 + 三層觀測系統 |
| **Phase 6** | 對抗訓練 | 模式 17 | 紅藍軍（Historical Replay 優先，LLM 輔助分析） |

### Phase 0 實作順序（Screener 重構）`[v7 新增]`

| 順序 | 項目 | 前置條件 | 說明 |
|------|------|---------|------|
| 0-1 | 擴展資料抓取到 20 日 | 無 | 改 `fetchMultiDayMarketData(5)` → `(20)` |
| 0-2 | Step 2 多因子評分 | 0-1 | 從現有 `filterCandidates` + `scorer.py` 整合 |
| 0-3 | Step 3 RRG 計算 | 0-1 | 新增 RRG 計算函式 + DB migration |
| 0-4 | Step 4 接入 `news.ts` | 無 | 呼叫現有 `analyzeSentiment` |
| 0-5 | Step 5 去重 + 截斷 | 0-2 | 報酬率相關性計算 + top 25 |
| 0-6 | Step 6 資料品質檢查 | 無 | 缺值/異常/時效 |
| 0-7 | 移除舊流程 | 0-2~0-6 全完成 | 刪除 concept heat 選股邏輯（保留前端展示） |

### Phase 間的依賴關係 `[v7 更新]`

```
Phase 0（Screener 重構 — 最先做）
  │
  └──→ Phase 1（基礎建設 + 數據分級）
         │
         ├──→ Phase 2（辯論 + 權限 + 熔斷 + Decision Authority）
         │       │
         │       ├──→ Phase 2.5（成交模擬 — Execution Reality）
         │       │       │
         │       │       └──→ Phase 3（任務鏈 + Skill + 投組建構）
         │       │               │
         │       │               └──→ Phase 5（Optuna + 週報審計 + 觀測系統）
         │       │                       │
         │       │                       └──→ Phase 6（紅藍軍 Historical Replay）
         │       │
         │       └──→ Phase 5（可與 Phase 3 平行）
         │
         └──→ Phase 4（智能互動 + 記憶）← 可獨立平行
```

### 時程對應 v12 藍圖 `[v5 更新]`

| v12 藍圖章節 | 對應 Phase | 補強來源 | 狀態 |
|-------------|-----------|---------|------|
| 一、基礎設施：極簡化與數據分級 | Phase 1 | — | 架構已完成，分級路由待導入 |
| 二、決策維度：AI 代理與高平原審計 | Phase 2 + 5 | v5: Decision Authority Layer | 待導入 |
| 三、進化維度：神經網路自動調參 | Phase 5 | v5: OOS Lock | 待導入 |
| 四、未來優化路徑 | Phase 6 | v5: Historical Replay 必要條件 | 規劃中 |
| 五、風控底線 | Phase 2 | v5: 四層安全架構 | 待導入，最高優先 |
| （外部審查新增）投組建構 | Phase 3 | v5: Portfolio Construction | 待導入 |
| （外部審查新增）成交模擬 | Phase 2.5 | v5: Execution Reality | 待導入，優先於 Phase 3 |
| （外部審查新增）觀測系統 | Phase 5 | v5: 3-Level Observability | 待導入 |
| （Failure Mode Map）成交失效防禦 | Phase 2.5 | v6: FM-1~3 | 最高優先 |
| （Failure Mode Map）模型失效防禦 | Phase 5 | v6: FM-4~6 | 待導入 |
| （Failure Mode Map）Agent 失效防禦 | Phase 2 | v6: FM-7~9 | 待導入 |
| （Failure Mode Map）系統韌性 | Phase 1 | v6: FM-10~12 | 基礎設施一起做 |
| **Screener 重構** | **Phase 0** | **v7: §九** | **最優先，源頭乾淨後面才有意義** |

---

## 八、Failure Mode Map（失效模式防禦） `[v6 新增]`

> 真正會讓你賠錢的不是模型，而是 failure mode。
> 以下 17 種失效模式按危險等級分類，每種附具體防禦方案和實作位置。

### 為什麼需要這個

模型再好，如果成交環境、系統韌性、決策流程有漏洞，績效都是虛的。這份 Map 解決的核心問題：

| 問題 | 不處理的後果 | 處理後的收益 |
|------|------------|------------|
| **成交假設不真實**（FM-1~3） | paper trading 績效好看但實盤賠錢，MDD 被低估 30~50% | 績效數字可信，實盤轉換落差最小化 |
| **模型一起錯**（FM-5） | 10 模型 ensemble 看似分散但同時看錯，單次大虧 | 偵測共錯事件，自動降低相關模型權重 |
| **學的跟做的不一樣**（FM-6） | 模型在回測很強但實盤表現差，找不到原因 | 量化「預測出場 vs 實際出場」的差距，找到模型盲點 |
| **LLM 越幫越忙**（FM-8~9） | prompt 偷偷改壞沒人知道；agent 說「強烈看多」放大部位放大虧損 | prompt 版控可追溯；agent 只能扣分不能加分 |
| **服務掛一半**（FM-11） | Modal cold start → 今天沒預測 → 盲目交易或不交易 | 降級運行，用快取預測撐住，不會全停 |
| **吃到髒資料**（FM-12） | 價格 = 0 或昨天的資料 → ML 信號全錯 → 觸發錯誤交易 | 資料進系統前驗證，髒資料直接擋掉 |

### 覆蓋狀態總覽

| FM | 失效模式 | 類型 | v5 已覆蓋？ | v6 補強 |
|---|---|---|---|---|
| 1 | 跌停鎖死 | 市場 | 部分 | ✅ 新增 |
| 2 | Gap-through Stop | 市場 | ❌ | ✅ 新增 |
| 3 | 流動性幻覺 | 市場 | 部分 | ✅ 補強 |
| 4 | Regime shift | ML | ✅ HMM + CB L5 | — |
| 5 | 模型共錯 | ML | ❌ | ✅ 新增 |
| 6 | Label mismatch | ML | ❌ | ✅ 新增 |
| 7 | LLM hallucination | Agent | ✅ Decision Authority | — |
| 8 | Prompt drift | Agent | ❌ | ✅ 新增 |
| 9 | 過度自信放大 | Agent | ❌ | ✅ 新增 |
| 10 | Checkpointer crash | 系統 | ✅ GCS/Postgres | — |
| 11 | 部分服務掛掉 | 系統 | ❌ | ✅ 新增 |
| 12 | 資料延遲/錯誤 | 系統 | ❌ | ✅ 新增 |
| 13 | 風控被繞過 | 風控 | ✅ 4 層安全架構 | — |
| 14 | 連續虧損 spiral | 風控 | ✅ CB L5 | — |
| 15 | 過度調參 | 風控 | ✅ OOS Lock | — |
| 16 | AutoML drift | 進化 | ✅ Human approval | — |
| 17 | 策略退化 | 進化 | ✅ Weekly audit | — |

---

### 類型 1：市場結構失效（Market Reality）

#### FM-1：跌停鎖死（台股特有）

**情境**：持股 -10% 無量跌停，掛賣單無法成交，連續 2~3 天鎖死。

**目前系統**：paper trading 假設掛單即成交 → MDD 被嚴重低估。

**防禦**：

```python
# services/execution.py 新增

class LockLimitDetector:
    """偵測跌停鎖死風險"""

    async def check_limit_lock(self, stock_id: str, market_data: dict) -> dict:
        price_change_pct = market_data["change_pct"]
        bid_volume = market_data.get("bid_volume", 0)  # 買方掛單量

        is_limit_down = price_change_pct <= -9.5  # 接近跌停
        is_locked = is_limit_down and bid_volume < 100  # 幾乎無買單

        return {
            "is_limit_locked": is_locked,
            "can_exit": not is_locked,
            "estimated_exit_days": 3 if is_locked else 0,  # 假設鎖 3 天
        }

    def adjust_paper_pnl(self, position: dict, lock_info: dict) -> dict:
        """鎖死時用最差情境估算 PnL，而非假設成交"""
        if lock_info["is_limit_locked"]:
            # 假設要等 3 天才能出場，每天再跌 5%
            worst_case_price = position["current_price"] * (0.95 ** 3)
            position["simulated_exit_price"] = worst_case_price
            position["pnl_worst_case"] = (worst_case_price - position["entry_price"]) * position["shares"]
        return position
```

**實作位置**：`services/execution.py` → Phase 2.5

**選股前置過濾**：

```python
# services/scorer.py 新增流動性門檻

LIQUIDITY_FILTERS = {
    "min_avg_daily_volume": 500,      # 日均量 ≥ 500 張
    "min_avg_daily_turnover": 5_000_000,  # 日均成交金額 ≥ 500 萬
    "max_position_vs_volume": 0.05,   # 部位 ≤ 日均量 5%
}

def filter_by_liquidity(candidates: list) -> list:
    """過濾掉流動性不足的標的"""
    return [c for c in candidates if
        c["avg_daily_volume"] >= LIQUIDITY_FILTERS["min_avg_daily_volume"] and
        c["avg_daily_turnover"] >= LIQUIDITY_FILTERS["min_avg_daily_turnover"]]
```

---

#### FM-2：Gap-through Stop

**情境**：昨收 100，SL 設 97，今日開盤直接跳空到 90 → 停損單不會在 97 成交。

**目前系統**：假設 SL = 97 就在 97 出場 → 低估虧損。

**防禦**：

```python
# services/execution.py 新增

def simulate_stop_loss_fill(self, order: dict, market_data: dict) -> dict:
    """模擬停損單在 gap 情境下的實際成交"""
    stop_price = order["stop_price"]
    open_price = market_data["open_price"]
    prev_close = market_data["prev_close"]

    gap_pct = (open_price - prev_close) / prev_close

    if order["side"] == "sell" and open_price < stop_price:
        # Gap through：開盤價已低於停損價
        # 實際成交 = 開盤價（而非停損價）
        fill_price = open_price
        gap_loss = (stop_price - open_price) / stop_price  # 額外損失
        return {
            "fill_price": fill_price,
            "gap_through": True,
            "extra_loss_pct": gap_loss,
            "note": f"Gap-through SL: 預期 {stop_price}, 實際 {fill_price}"
        }

    return {"fill_price": stop_price, "gap_through": False}
```

**額外防禦 — Gap Risk Penalty**：

```python
# services/scorer.py 新增

def apply_gap_risk_penalty(candidate: dict) -> dict:
    """對 gap 風險高的股票降分"""
    # 計算過去 60 天的 gap 頻率
    gap_days = sum(1 for g in candidate["daily_gaps"] if abs(g) > 0.03)
    gap_ratio = gap_days / 60

    if gap_ratio > 0.1:  # 超過 10% 的天數有 >3% gap
        candidate["score"] *= 0.85  # 降 15% 分數
        candidate["flags"].append(f"HIGH_GAP_RISK: {gap_ratio:.0%}")

    return candidate
```

**實作位置**：`services/execution.py` + `services/scorer.py` → Phase 2.5

---

#### FM-3：流動性幻覺（補強）

v5 已有 slippage model，補強 Amihud illiquidity filter：

```python
# services/scorer.py 新增

import numpy as np

def amihud_illiquidity(returns: list, volumes: list) -> float:
    """Amihud (2002) 非流動性指標：|return| / volume"""
    daily_illiq = [abs(r) / max(v, 1) for r, v in zip(returns, volumes)]
    return np.mean(daily_illiq)

def filter_illiquid_stocks(candidates: list, max_amihud: float = 0.001) -> list:
    """過濾 Amihud 非流動性過高的標的"""
    filtered = []
    for c in candidates:
        illiq = amihud_illiquidity(c["returns_60d"], c["volumes_60d"])
        if illiq <= max_amihud:
            filtered.append(c)
        else:
            # 記錄被過濾的原因
            c["filtered_reason"] = f"Amihud illiquidity {illiq:.6f} > {max_amihud}"
    return filtered
```

**實作位置**：`services/scorer.py` → Phase 2.5

---

### 類型 2：模型失效（ML Failure）

#### FM-4：Regime Shift — ✅ 已覆蓋

你已有 HMM regime detection + Circuit Breaker L5（連續停損熔斷）。

---

#### FM-5：模型共錯（Correlated Error）

**情境**：10 個模型同時看多，結果全錯。因為模型共享相似特徵或訓練資料。

**防禦**：

```python
# services/ensemble_monitor.py（新增）

import numpy as np

class EnsembleErrorMonitor:
    """監控模型間的錯誤相關性"""

    def check_error_correlation(self, model_predictions: dict, actual: float) -> dict:
        """計算所有模型的 error correlation matrix"""
        errors = {}
        for model_name, pred in model_predictions.items():
            errors[model_name] = pred["predicted"] - actual

        model_names = list(errors.keys())
        error_matrix = np.array([errors[m] for m in model_names])

        # 計算 error correlation
        if len(error_matrix.shape) == 1:
            error_matrix = error_matrix.reshape(-1, 1)

        corr_matrix = np.corrcoef(error_matrix) if error_matrix.shape[0] > 1 else np.array([[1]])

        # 警告：如果 >60% 模型對的 error correlation > 0.7
        high_corr_pairs = []
        n = len(model_names)
        for i in range(n):
            for j in range(i+1, n):
                if abs(corr_matrix[i][j]) > 0.7:
                    high_corr_pairs.append((model_names[i], model_names[j], corr_matrix[i][j]))

        return {
            "high_correlation_pairs": high_corr_pairs,
            "avg_correlation": float(np.mean(np.abs(corr_matrix[np.triu_indices(n, k=1)]))),
            "alert": len(high_corr_pairs) > n * 0.3,  # 超過 30% 的 pair 高度相關
        }

    def unanimous_wrong_detector(self, predictions: dict, actual_direction: str) -> bool:
        """偵測所有模型是否一致看錯方向"""
        directions = [p["direction"] for p in predictions.values()]
        all_same = len(set(directions)) == 1
        all_wrong = all_same and directions[0] != actual_direction
        return all_wrong  # True = 全體共錯
```

**回饋機制**：共錯事件觸發 ARF bandit 降低相關模型組的權重。

**實作位置**：`ml-service/app/` → Phase 5（觀測系統一起做）

---

#### FM-6：Label Mismatch

**情境**：模型學的是 triple barrier label，但實際出場時機不同（例如被停損或被迫出場），導致模型學到的 pattern 跟實際交易不一致。

**防禦**：

```python
# services/alignment.py（新增）

class LabelAlignmentChecker:
    """檢查模型預測的出場情境 vs 實際出場情境是否一致"""

    def check_alignment(self, predictions: list, actual_trades: list) -> dict:
        """比對 predicted exit 和 actual exit"""
        mismatches = []
        for pred, actual in zip(predictions, actual_trades):
            pred_exit = pred["predicted_exit_type"]    # "take_profit" / "stop_loss" / "timeout"
            actual_exit = actual["actual_exit_type"]

            if pred_exit != actual_exit:
                mismatches.append({
                    "stock_id": pred["stock_id"],
                    "predicted": pred_exit,
                    "actual": actual_exit,
                    "pnl_impact": actual["pnl"] - pred["expected_pnl"],
                })

        mismatch_rate = len(mismatches) / max(len(predictions), 1)

        return {
            "mismatch_rate": mismatch_rate,
            "mismatches": mismatches,
            "alert": mismatch_rate > 0.3,  # 超過 30% 不匹配要警告
            "suggestion": "考慮用 MAE/MFE 替代 triple barrier 作為訓練目標"
                          if mismatch_rate > 0.4 else None
        }
```

**MAE/MFE 指標**：
- **MAE** (Maximum Adverse Excursion)：進場後最大逆向波動
- **MFE** (Maximum Favorable Excursion)：進場後最大順向波動
- 用這兩個指標替代 triple barrier，更貼近實際交易體驗

**實作位置**：`ml-controller/services/` → Phase 5

---

### 類型 3：Agent / LLM 失效

#### FM-7：LLM Hallucination — ✅ 已覆蓋

Decision Authority Layer 確保 LLM 只是 overlay，不是 decision maker。

---

#### FM-8：Prompt Drift

**情境**：隨著 prompt 修改累積，agent 行為逐漸偏移，但沒人注意到。

**防禦**：

```python
# security/prompt_versioning.py（新增）

import hashlib
from datetime import datetime

class PromptVersionControl:
    """所有 agent prompt 版本化，可追溯、可回滾"""

    PROMPT_REGISTRY = {}

    @classmethod
    def register(cls, name: str, prompt: str, version: str):
        prompt_hash = hashlib.sha256(prompt.encode()).hexdigest()[:8]
        cls.PROMPT_REGISTRY[name] = {
            "version": version,
            "hash": prompt_hash,
            "prompt": prompt,
            "registered_at": datetime.now().isoformat(),
        }

    @classmethod
    def get_prompt(cls, name: str) -> str:
        entry = cls.PROMPT_REGISTRY[name]
        # 每次取用時記錄，確保可重現
        return entry["prompt"]

    @classmethod
    def audit_prompts(cls) -> list:
        """列出所有 prompt 版本供審計"""
        return [
            {"name": k, "version": v["version"], "hash": v["hash"]}
            for k, v in cls.PROMPT_REGISTRY.items()
        ]

# 使用方式
PromptVersionControl.register(
    name="bull_agent",
    version="v1.2",
    prompt=BULL_AGENT_PROMPT
)

# 週報審計時可以比對 prompt 是否有變動
# 回測時可以用特定版本的 prompt 重現
```

**實作位置**：`security/` → Phase 2

---

#### FM-9：過度自信放大

**情境**：LLM agent 說「強烈看多」→ 信心度被大幅提升 → 放大部位 → 放大虧損。

**防禦原則**：**Agent 只能扣分，不能加分。**

```python
# tools/agent_overlay.py（新增）

class AgentOverlay:
    """Agent 對決策的影響限制：只能降低信心，不能提升"""

    MAX_PENALTY = 0.30  # 最多降 30% 信心度
    BOOST_ALLOWED = False  # ❌ 禁止正向加分

    def apply_overlay(self, original_score: float, agent_adjustment: float) -> float:
        """套用 agent 的信心度調整"""
        if agent_adjustment > 0 and not self.BOOST_ALLOWED:
            # Agent 想加分 → 忽略，記錄日誌
            return original_score

        # Agent 扣分 → 允許，但有上限
        penalty = min(abs(agent_adjustment), self.MAX_PENALTY)
        adjusted = original_score * (1 - penalty)

        return adjusted

# 使用：
# original_score = 0.85 (ML 信心度)
# agent 說「風險很高」→ adjustment = -0.20
# 結果 = 0.85 * (1 - 0.20) = 0.68
# agent 說「強烈看多」→ adjustment = +0.15
# 結果 = 0.85（忽略加分）
```

**實作位置**：`tools/` → Phase 2

---

### 類型 4：系統層失效

#### FM-10：Checkpointer Crash — ✅ 已覆蓋（v5 改 GCS/Postgres）

---

#### FM-11：部分服務掛掉

**情境**：Modal cold start 太慢、Shioaji Proxy 斷線、GCS 暫時不可用。

**防禦 — Degraded Mode（降級運行）**：

```python
# services/resilience.py（新增）

class DegradedModeManager:
    """服務降級管理：部分服務掛掉時，系統以降級模式繼續運行"""

    SERVICE_FALLBACKS = {
        "modal_ml": {
            "fallback": "use_cached_prediction",  # 用最近一次的預測結果
            "max_stale_hours": 24,                 # 快取最多用 24 小時
            "alert": True,
        },
        "shioaji_proxy": {
            "fallback": "use_twse_api",            # 改用 TWSE 公開 API（延遲較大）
            "max_stale_hours": 0,                  # 報價不能用快取
            "alert": True,
        },
        "gcs": {
            "fallback": "use_last_config",         # 用上次載入的 config
            "max_stale_hours": 168,                # 一週內都可以
            "alert": False,
        },
    }

    async def call_with_fallback(self, service: str, primary_fn, fallback_fn):
        """嘗試主要服務，失敗時降級"""
        try:
            return await asyncio.wait_for(primary_fn(), timeout=30)
        except (asyncio.TimeoutError, Exception) as e:
            config = self.SERVICE_FALLBACKS.get(service, {})
            if config.get("alert"):
                await self.send_alert(f"⚠️ {service} 降級運行：{e}")
            return await fallback_fn()
```

**實作位置**：`services/` → Phase 1（基礎設施一起做）

---

#### FM-12：資料延遲 / 錯誤

**情境**：TWSE API 回傳昨天的資料、資料欄位缺失、數值異常（如價格 = 0）。

**防禦**：

```python
# services/data_validator.py（新增）

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

class DataValidator:
    """資料品質驗證層：進入系統前必須通過"""

    TW_TZ = ZoneInfo("Asia/Taipei")

    def validate_price_data(self, data: dict) -> tuple[bool, list[str]]:
        """驗證價格資料品質"""
        errors = []

        # 1. 時效性檢查
        data_date = data.get("date")
        if data_date:
            age = datetime.now(self.TW_TZ).date() - data_date
            if age > timedelta(days=1):
                errors.append(f"STALE_DATA: 資料日期 {data_date}，已過時 {age.days} 天")

        # 2. 數值合理性
        price = data.get("close", 0)
        if price <= 0:
            errors.append(f"INVALID_PRICE: close = {price}")
        if price > 10000:
            errors.append(f"SUSPICIOUS_PRICE: close = {price}，超過合理範圍")

        # 3. 欄位完整性
        required = ["open", "high", "low", "close", "volume"]
        for field in required:
            if field not in data or data[field] is None:
                errors.append(f"MISSING_FIELD: {field}")

        # 4. 邏輯一致性
        if all(f in data for f in ["high", "low", "close"]):
            if data["close"] > data["high"] or data["close"] < data["low"]:
                errors.append(f"LOGIC_ERROR: close {data['close']} 不在 high/low 範圍內")

        return len(errors) == 0, errors

    def validate_batch(self, batch: list[dict]) -> dict:
        """批次驗證，回傳通過/失敗的資料"""
        passed, failed = [], []
        for item in batch:
            ok, errors = self.validate_price_data(item)
            if ok:
                passed.append(item)
            else:
                item["validation_errors"] = errors
                failed.append(item)

        if len(failed) > len(batch) * 0.1:  # 超過 10% 失敗 → 警告
            # 可能是整批資料有問題（API 異常）
            pass

        return {"passed": passed, "failed": failed, "fail_rate": len(failed) / max(len(batch), 1)}
```

**實作位置**：`services/` → Phase 1（資料進入系統的第一道關卡）

---

### 類型 5：風控失效

#### FM-13：風控被繞過 — ✅ 已覆蓋（4 層安全架構 + Circuit Breaker 最前面）
#### FM-14：連續虧損 Spiral — ✅ 已覆蓋（CB L5 + Dynamic Position Reduction）
#### FM-15：過度調參 — ✅ 已覆蓋（OOS Lock + Rollback Config）

---

### 類型 6：系統進化失控

#### FM-16：AutoML Drift — ✅ 已覆蓋（Human Approval + Config Versioning）
#### FM-17：策略靜默退化 — ✅ 已覆蓋（Weekly Audit Graph + Performance Alert）

---

### 失效模式 × Phase 對照

| 優先順序 | Failure Mode | 對應 Phase | 實作位置 |
|---------|---|---|---|
| 🥇 | FM-1 跌停鎖死 | Phase 2.5 | services/execution.py + services/scorer.py |
| 🥇 | FM-2 Gap-through Stop | Phase 2.5 | services/execution.py + services/scorer.py |
| 🥇 | FM-3 流動性幻覺 | Phase 2.5 | services/scorer.py (Amihud filter) |
| 🥈 | FM-9 過度自信放大 | Phase 2 | tools/agent_overlay.py |
| 🥈 | FM-8 Prompt drift | Phase 2 | security/prompt_versioning.py |
| 🥈 | FM-11 服務降級 | Phase 1 | services/resilience.py |
| 🥈 | FM-12 資料驗證 | Phase 1 | services/data_validator.py |
| 🥉 | FM-5 模型共錯 | Phase 5 | ml-service/app/ (ensemble_monitor) |
| 🥉 | FM-6 Label mismatch | Phase 5 | services/alignment.py |

---

## 九、Screener 重構：Bottom-up 多因子 + RRG 產業輪動 `[v7 新增]`

> 核心變更：從 top-down（先選概念族群）翻轉為 bottom-up（先評個股）
> 這是整個系統最根本的改動 — 源頭乾淨了，後面的 ML 和 meta 才有意義。

### 9.1 現況問題

現有流程是 top-down：概念族群熱度 top 8 → 從族群內挑個股 → 放寬加入族群所有成員 → ~45 檔

問題：
1. **概念族群是入口門檻**：不在 hot concept 裡的好股票直接被排除
2. **放寬太鬆**：hot concept 成員幾乎全加入（只過濾股價 < 10）→ 膨脹主因
3. **概念標籤是手動維護的**（`seed_concept_tags.py` 28 個概念）→ 不準、不即時
4. **新聞情緒沒用到**：`news.ts` 有鉅亨網 + Yahoo 爬蟲但 screener 沒接
5. **RRG 沒接入**：前端有 RRG 四象限圖但 screener 沒用

業界共識：
- 板塊配置只貢獻 9% 報酬（vs 個股選擇 12%）
- 量化系統主流是 bottom-up 多因子為主，top-down 為輔
- 報酬率聚類比 GICS/概念標籤更準（RMSE 低 15.9%）
- 台股概念股分類全部是人工維護（CMoney、Goodinfo、鉅亨網皆是）

### 9.2 重構後完整流程

```
Step 1: Universe 定義（全市場流動性門檻）
│
│   資料來源：
│   ├── TWSE/TPEx 全市場 20 日 OHLCV
│   ├── 三大法人籌碼
│   ├── 鉅亨網 + Yahoo 新聞
│   └── PTT 熱門概念
│
│   產業分類：FMStockInfo.industry_category
│   ├── TWSE 上市：33 類
│   ├── TPEx 上櫃：30 類
│   └── 合計約 38 個不重複產業別（OpenAPI 直接取得，不需維護）
│
│   Hard filter：
│   ├── close >= 15
│   ├── close <= 2000
│   ├── 20 日均量 >= 300,000
│   ├── 最新日 volume > 0
│   └── 排除處置股（punishedSet）
│
│   → ~800-1000 檔通過，每檔自帶官方產業別
│
      ▼
Step 2: 多因子評分（Bottom-up 主篩選，每檔獨立評分）
│
│   籌碼面 (0-40)：
│   ├── 外資+投信 5 日淨買超量 → 分級給分
│   │   > 10 億 = 36, > 5 億 = 28, > 2 億 = 20, > 0 = 12, > -2 億 = 5, else 0
│   └── 法人連續買超天數
│       >= 5 天 +4, >= 3 天 +2
│
│   技術面 (0-30)：
│   ├── RSI 14：55-70 = 12, 50-55 = 8, 45-50 = 4, >70 = 5
│   ├── MACD histogram：> 0 = +8, > -0.5 = +3
│   ├── 均線排列：MA5 +3, MA20 +4, MA60 +3
│   └── 肯特納通道突破：close > MA20 + 1.5×ATR = +6
│
│   動能面 (0-20)：
│   ├── 5 日報酬率 vs 大盤 (0-10)
│   ├── 量能比：近 3 日 vs 20 日均量 (0-7)
│   └── RSI 鈍化：RSI > 80 連 3+ 天 = +3
│
│   → 每檔得到 base_score (0-90)
│
      ▼
Step 3: RRG 產業輪動定位（官方 38 產業別）
│
│   RS-Ratio 計算：
│   ├── 每個產業的成員市值加權平均報酬（20 日窗口）
│   ├── ÷ 大盤（TWII/TPEx）同期報酬
│   └── EMA(10) 平滑 × 100（100 = 與大盤同步）
│
│   RS-Momentum 計算：
│   └── RS-Ratio(today) - RS-Ratio(10 days ago)
│
│   四象限分類 + 加分：
│   ├── Leading   (Ratio > 100, Momentum > 0) → +10 分
│   ├── Improving (Ratio < 100, Momentum > 0) → +7 分
│   ├── Weakening (Ratio > 100, Momentum < 0) → +0 分
│   └── Lagging   (Ratio < 100, Momentum < 0) → -5 分
│
│   每檔股票依其官方產業別獲得 RRG bonus/penalty
│   38 類粒度足夠：RRG 看「產業層級順逆風」，個股精細度靠 Step 2 + Step 5 補足
│
      ▼
Step 4: 情緒面加分（多源彙整）
│
│   新聞情緒 bonus (0-10)：← 現有 news.ts，目前 screener 沒接
│   ├── 鉅亨網 RSS → analyzeSentiment()
│   ├── Yahoo Finance → analyzeSentiment()
│   └── positive = +5~10, neutral = 0, negative = -5
│
│   PTT buzz bonus (0-5)：← 從主角降為配角
│   └── mentionCount + sentimentAvg → 加分
│
│   概念標籤 bonus (0-5)：← 降為最低權重，不影響選股
│   └── 屬於 hot concept → +3~5（僅前端展示用）
│
│   → total_score = base_score + rrg_bonus + 情緒 bonus (0-120)
│
      ▼
Step 5: 排序 + 去重 + 截斷
│
│   5a. 全部候選按 total_score 排序
│   5b. 同產業上限 5 檔（用官方產業別）
│   5c. 報酬率相關性去重
│       60 日報酬相關性 > 0.8 的只留最高分
│       用簡易 Pearson 相關性（~50 檔 = 1,225 次計算，Worker 跑得動）
│       不需概念標籤，數據驅動
│   5d. 取 top 25（硬上限）
│
      ▼
Step 6: 資料品質檢查（輕量清洗）
│
│   ├── 缺值：close / volume = 0 或 null → 排除
│   ├── 異常值：單日漲跌 > 10%（非漲跌停日）→ 標記
│   └── 資料時效：超過 1 天 → 排除
│
      ▼
~20-25 檔 → 寫 D1 → ML pipeline（10 模型 Ensemble）
```

### 9.3 分類體系角色對照

| 分類來源 | 數量 | 在流程中的角色 | 維護方式 |
|---------|------|--------------|---------|
| **官方產業別** | TWSE 33 + TPEx 30 ≈ 38 不重複 | Step 3 RRG 計算 + Step 5 同產業上限 | 不需維護，OpenAPI 直接取 |
| **報酬率相關性分群** | 動態（每週變） | Step 5 去重 | 每週自動計算 |
| **概念標籤** | 現有 28 個 | Step 4 輕量加分 + 前端展示 | 偶爾手動更新 |

**選股邏輯不再依賴概念標籤的準確度。** 標籤分錯最多影響 ±5 分（滿分 120），不會決定一檔股票進不進候選。

### 9.4 跟現有流程的差異

| | 現在 | 重構後 |
|---|---|---|
| **架構** | Top-down（概念族群 → 個股） | Bottom-up（個股評分 → 產業加分） |
| **入口** | 先選 8 個 hot concept | 全市場每檔都評分 |
| **概念族群** | 第一道門檻（決定 universe） | 降為 Step 4 加分項（+0~5） |
| **RRG** | 沒有 | Step 3 用官方 38 產業計算四象限 |
| **新聞情緒** | `news.ts` 沒接入 screener | Step 4 鉅亨+Yahoo 情感加分 |
| **PTT** | 概念熱度主來源 (0-30) | 降為輔助 (0-5) |
| **候選膨脹** | 放寬 concept 成員 + 動量 15 檔 → ~45 | top 25 硬截斷 |
| **動量突破** | 獨立掃描加 15 檔 | 併入 Step 2 動能面 |
| **去重** | 沒有 | Step 5 報酬率相關性去重 |
| **資料品質** | 沒有 | Step 6 缺值/異常/時效檢查 |
| **產業分類** | 手動 28 概念標籤 | 官方 38 產業（自動）+ 報酬率聚類（自動） |
| **控制數量** | 靠 topNPerSector × 族群數（不穩定） | top 25 硬截斷（穩定） |

### 9.5 RRG 計算細節

| 資料 | 來源 | 現有？ |
|------|------|--------|
| 每檔股票的官方產業別 | `FMStockInfo.industry_category` | ✅ 已有 |
| 每檔股票的 20 日 OHLCV | TWSE/TPEx API | ✅ 已有（目前抓 5 日，需擴到 20 日） |
| 大盤指數日報酬 | TWII / TPEx 指數 | ✅ 已有（`usLeading.ts` 有抓） |
| 每檔股票的市值 | TWSE BWIBBU API | ✅ 已有（`twseApi.ts`） |

```
計算步驟：
1. 每日：計算每個產業的市值加權平均報酬
   industry_return[i] = Σ(stock_return × market_cap) / Σ(market_cap)

2. 每日：計算相對強度
   relative_strength[i] = industry_cumulative_return(20d) / market_cumulative_return(20d)

3. RS-Ratio = EMA(relative_strength, 10) × 100
   → > 100 表示該產業強於大盤

4. RS-Momentum = RS-Ratio[today] - RS-Ratio[10d ago]
   → > 0 表示動能正在增加

5. 四象限 = f(RS-Ratio, RS-Momentum)
```

DB 變更：`sector_heat` 表新增欄位

```sql
ALTER TABLE sector_heat ADD COLUMN rs_ratio REAL;
ALTER TABLE sector_heat ADD COLUMN rs_momentum REAL;
ALTER TABLE sector_heat ADD COLUMN quadrant TEXT;  -- 'Leading'|'Improving'|'Weakening'|'Lagging'
```

### 9.6 改動範圍

| 檔案 | 改動 | 大小 |
|------|------|------|
| `marketScreener.ts` | 重構主流程 | 大（核心） |
| `news.ts` | 新增 `batchSentiment(symbols)` | 小 |
| `tradingConfig.ts` | 新增 `maxCandidates: 25`、`maxPerSector: 5` | 小 |
| `finmind.ts` 或 `twseApi.ts` | 擴展抓 20 日資料（目前 5 日） | 小 |
| `schema.sql` + migration | `sector_heat` 加 `rs_ratio`、`rs_momentum`、`quadrant` | 小 |
| `dailyRecommendation.ts` | `sector_flow` 寫入時一併算 RRG 座標 | 中 |
| `scorer.py` | 不動（ML 階段評分邏輯不變） | 無 |

### 9.7 預期效果

| 指標 | 現在 | 重構後 |
|------|------|--------|
| 候選數量 | ~45（不穩定） | ~25（穩定，硬上限） |
| ML timeout | 偶發 | 應消除 |
| 漏選好股票 | 不在 hot concept = 被排除 | 全市場都評分，不會漏 |
| 同質重複 | 多（同概念走勢一樣） | 報酬率去重消除 |
| 新聞情緒 | 沒用到 | 接入加分 |
| RRG 輪動 | 前端有但 screener 沒用 | 接入 Step 3 |
| 分類維護成本 | 手動維護 28 概念 | 官方產業別自動取得 |
