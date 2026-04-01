# StockVision 架構升級計畫

> 基於 Claude Code 架構模式 + LangGraph 整合方案
> 日期：2026-04-01

---

## 一、背景

透過分析 [ChinaSiro/claude-code-sourcemap](https://github.com/ChinaSiro/claude-code-sourcemap)（Claude Code v2.1.88 逆向還原），萃取出 6 個關鍵設計模式，結合 LangGraph 框架，融入 StockVision 現有 MVC 架構。

### 核心原則

- **Claude Code sourcemap** → 提供設計模式（tool 抽象、coordinator、compaction、task 管理）
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

## 三、6 個 Claude Code 設計模式 × LangGraph 實作

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
│   └── trade_tools.py   # 包裝交易相關
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

## 六、導入路徑

| Phase | 項目 | 說明 |
|-------|------|------|
| **Phase 1** | ML 預測 graph | 把 `/batch-predict` 改成 LangGraph，最獨立、影響最小 |
| **Phase 2** | 辯論 graph | 加入 bull/bear/quant 辯論替換現有 debate |
| **Phase 3** | Cron 任務鏈 | 每日排程串成 LangGraph pipeline + checkpointer |
| **Phase 4** | Chat compaction | 對話上下文壓縮 |

