# StockVision 架構升級計畫

> 基於 Claude Code 架構模式 + LangGraph 整合方案
> 日期：2026-04-01
> 更新：2026-04-01（v4 — 融合 v12 營運藍圖：基礎設施分級、AutoML、5 層熔斷）

---

## 更新記錄

| 版本 | 日期 | 說明 |
|------|------|------|
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

安全防護三層架構：
- **模式 7** = 「這個工具誰能用」（身份/角色層）
- **模式 12** = 「這筆操作合不合規」（業務規則層 + 攻擊偵測）
- **模式 14** = 「整個系統是否該停止」（硬編碼熔斷層，不可覆寫） `[v4 新增]`

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
                }
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

未來進階：紅軍不只用 LLM 模擬，而是接入真實回測引擎（Modal），用歷史極端行情數據跑策略。

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
├── services/            # 現有服務（不動）
│   ├── modal_client.py  # 呼叫 Modal
│   ├── scorer.py        # 評分邏輯
│   └── adaptive.py      # 自適應參數
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

## 六、導入路徑 `[v4 更新]`

| Phase | 項目 | 涵蓋模式 | 說明 |
|-------|------|---------|------|
| **Phase 1** | 基礎建設 | 模式 1, 6, 8, 9, 13 | Tool System + Feature Flags + JSON Schema + PARITY.md + 數據分級路由 `[v4 更新]` |
| **Phase 2** | 辯論 + 權限 + 安全 | 模式 3, 7, 12, 14 | Coordinator 辯論 + 權限分級 + 安全防護 + 5 層 Circuit Breaker `[v4 更新]` |
| **Phase 3** | 任務鏈 + Skill | 模式 5, 10 | 每日 Cron pipeline + checkpointer + Skill 工作流模板化 |
| **Phase 4** | 智能互動 + 記憶 | 模式 2, 4, 11 | ToolSearch + Chat compaction + Session 記憶持久化 |
| **Phase 5** | 自我演化 | 模式 15, 16 | Optuna 自動調參 + 週報 AI 審計。需 Modal Optuna 先部署 `[v4 新增]` |
| **Phase 6** | 對抗訓練 | 模式 17 | 紅藍軍 Multi-Agent 對抗。需 Phase 5 穩定後再導入 `[v4 新增]` |

### Phase 間的依賴關係

```
Phase 1（基礎建設 + 數據分級）
  │
  ├──→ Phase 2（辯論 + 權限 + 5 層熔斷）
  │       │
  │       ├──→ Phase 3（任務鏈 + Skill）
  │       │       │
  │       │       └──→ Phase 5（Optuna + 週報審計）
  │       │               │
  │       │               └──→ Phase 6（紅藍軍對抗）
  │       │
  │       └──→ Phase 5（可與 Phase 3 平行，但需 Phase 2 的安全層）
  │
  └──→ Phase 4（智能互動 + 記憶）← 可與 Phase 2-6 獨立平行
```

### 時程對應 v12 藍圖

| v12 藍圖章節 | 對應 Phase | 狀態 |
|-------------|-----------|------|
| 一、基礎設施：極簡化與數據分級 | Phase 1 (數據分級) + 既有架構 | 架構已完成，分級路由待導入 |
| 二、決策維度：AI 代理與高平原審計 | Phase 2 (辯論) + Phase 5 (週報審計) | 待導入 |
| 三、進化維度：神經網路自動調參 | Phase 5 (Optuna skill) | 待導入 |
| 四、未來優化路徑 | Phase 6 (對抗訓練) | 規劃中 |
| 五、風控底線 | Phase 2 (Circuit Breaker) | 待導入，最高優先 |

