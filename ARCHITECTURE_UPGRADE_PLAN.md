# StockVision 架構升級計畫

> 基於 Claude Code 架構模式 + LangGraph 整合方案
> 日期：2026-04-01
> 更新：2026-04-01（v2 — 融合 claw-code 補強）

---

## 更新記錄

| 版本 | 日期 | 說明 |
|------|------|------|
| v2 | 2026-04-01 | 融合 [instructkr/claw-code](https://github.com/instructkr/claw-code) 分析，新增：模式 7（Tool 權限分級）、模式 8（Tool Schema JSON 規格化）、模式 9（Parity 追蹤）、更新目錄結構、更新導入路徑 |
| v1 | 2026-04-01 | 初版，基於 claude-code-sourcemap 萃取 6 個設計模式 |

---

## 一、背景

透過分析兩個 Claude Code 逆向工程專案，萃取設計模式，結合 LangGraph 框架，融入 StockVision 現有 MVC 架構。

### 參考來源

| 專案 | 性質 | 價值 |
|------|------|------|
| [ChinaSiro/claude-code-sourcemap](https://github.com/ChinaSiro/claude-code-sourcemap) | 原始碼直接提取（TypeScript） | 原廠設計圖：看內部實作細節、prompt 組裝、tool schema |
| [instructkr/claw-code](https://github.com/instructkr/claw-code) | 逆向後用 Python/Rust 重寫 | 仿造經驗：tool 權限模型、JSON schema 規格化、parity 追蹤方法論 |

### 核心原則

- **claude-code-sourcemap** → 提供設計模式（tool 抽象、coordinator、compaction、task 管理）
- **claw-code** → 補強實作細節（權限分級、JSON schema 驅動、進度追蹤） `[v2 新增]`
- **LangGraph** → 實作框架（state graph、checkpointer、conditional edges）
- **StockVision** → 落地場景

---

## 二、現有架構（不變）

```
┌─────────────────────────────────────────────────┐
│  View     │  Frontend (Vite + React)             │  ← 不動
├───────────┼──────────────────────────────────────┤
│  Router   │  Worker (Cloudflare)                 │  ← 不動
│           │  • API 路由、排程觸發                  │
│           │  • D1/KV 資料存取、Queue               │
├───────────┼──────────────────────────────────────┤
│Controller │  GCP Cloud Run                       │  ← LangGraph 放這裡
│           │  • ml-controller (現有 FastAPI)        │
│           │  • LangGraph Orchestrator (新增)      │
├───────────┼──────────────────────────────────────┤
│  Model    │  Modal (ML Service)                  │  ← 不動
│           │  Shioaji Proxy (Cloud Run)           │  ← 不動
└───────────┴──────────────────────────────────────┘
```

### 各層職責切割

| 層 | 負責 | 不該做的 |
|---|---|---|
| **Worker (CF)** | 路由、排程觸發、D1/KV 存取、Queue | 不做 ML 推論、不做 LLM 呼叫 |
| **Controller (GCP)** | 編排邏輯、LangGraph 流程、LLM 呼叫、評分 | 不存資料、不直接面對前端 |
| **Model (Modal)** | 純 ML 推論、模型訓練 | 不做業務邏輯、不做編排 |
| **Shioaji Proxy** | 即時報價轉發 | 只做 quote，不做分析 |
| **Frontend** | UI 渲染 | 不直接 call Modal/GCP |

---

## 三、9 個 Claude Code 設計模式 × LangGraph 實作

> 模式 1-6 源自 sourcemap 分析，模式 7-9 源自 claw-code 補強 `[v2 更新]`

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
from langgraph.checkpoint.sqlite import SqliteSaver

checkpointer = SqliteSaver.from_conn_string("/tmp/checkpoints.db")

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

## 四、ml-controller 目錄結構變更

```
ml-controller/
├── main.py              # FastAPI 入口（不動）
├── routers/
│   ├── predict.py       # POST /batch-predict（內部改 call graph）
│   ├── recommend.py     # POST /recommend（同上）
│   └── risk.py          # POST /risk-assess（同上）
├── services/            # 現有服務（不動）
│   ├── modal_client.py  # 呼叫 Modal
│   ├── scorer.py        # 評分邏輯
│   └── adaptive.py      # 自適應參數
├── graphs/              # 新增：LangGraph 流程定義
│   ├── predict_graph.py # ML 預測流程 graph
│   ├── recommend_graph.py # 推薦辯論 graph
│   └── daily_pipeline.py  # 每日完整流程 graph
├── tools/               # 新增：把 services 包成 LangGraph tools
│   ├── ml_tools.py      # 包裝 modal_client
│   ├── data_tools.py    # 包裝 Worker API 呼叫
│   ├── trade_tools.py   # 包裝交易相關
│   ├── permissions.py   # [v2] 工具權限分級邏輯
│   └── schemas/         # [v2] JSON schema 驅動工具定義
│       ├── market_data.json
│       ├── trading.json
│       ├── sentiment.json
│       └── risk.json
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
| Checkpointer | $0 | $0 | 用 SQLite，不開新 DB |
| **合計增量** | | | **+$4~6/月** |

### 省錢策略

```python
# 1. 不是每檔都跑辯論，只有高信心候選才跑
high_confidence = [s for s in candidates if s["confidence"] > 0.7]

# 2. 辯論用 Haiku，最終 verdict 才用 Sonnet
BULL_MODEL = "claude-haiku-4-5-20251001"     # 便宜
BEAR_MODEL = "claude-haiku-4-5-20251001"     # 便宜
VERDICT_MODEL = "claude-sonnet-4-6"           # 只有最後一步用好模型

# 3. Checkpointer 用 SQLite，不開新 DB instance
from langgraph.checkpoint.sqlite import SqliteSaver
checkpointer = SqliteSaver.from_conn_string("/tmp/checkpoints.db")
```

---

## 六、導入路徑 `[v2 更新]`

| Phase | 項目 | 涵蓋模式 | 說明 |
|-------|------|---------|------|
| **Phase 1** | 基礎建設 | 模式 1, 6, 8, 9 | Tool System + Feature Flags + JSON Schema + PARITY.md。先把工具層搭好 |
| **Phase 2** | 辯論 + 權限 | 模式 3, 7 | Coordinator 辯論 graph + 工具權限分級。交易工具上線前必須有權限管控 |
| **Phase 3** | 任務鏈 | 模式 5 | 每日 Cron pipeline + checkpointer 斷點恢復 |
| **Phase 4** | 智能互動 | 模式 2, 4 | ToolSearch 動態載入 + Chat compaction。提升 chat 互動體驗 |

### Phase 間的依賴關係

```
Phase 1（基礎建設）
  │
  ├──→ Phase 2（辯論 + 權限）
  │       │
  │       └──→ Phase 3（任務鏈）
  │
  └──→ Phase 4（智能互動）← 可與 Phase 2/3 平行
```

Phase 4 不依賴 Phase 2/3，可以提前或平行開發。

