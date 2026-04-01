# Everything Claude Code (ECC) 導入指南

> 用 ECC 優化你的 Claude Code 開發體驗
> 日期：2026-04-01
> 來源：[affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)

---

## 一、ECC 是什麼

ECC 不是修改 Claude Code 本身，而是一套**配置層**，透過 agents、skills、commands、hooks、rules 讓 Claude Code 的輸出品質和效率大幅提升。類似於「oh-my-zsh 之於 zsh」。

| 維度 | 原版 Claude Code | + ECC |
|------|-----------------|-------|
| Agent | 通用單一 agent | 36 個專職 subagent（planner、architect、reviewer...） |
| 工作流 | 每次手動描述 | 142+ 個 skill 模板一鍵觸發 |
| 指令 | 內建斜線指令 | +68 個自定義指令（/plan、/tdd、/verify） |
| 程式碼規範 | 無 | 12 語言的 best practice rules |
| Session 管理 | context 滿了就斷 | hooks 自動 compaction + 記憶持久化 |
| 安全 | 基本權限 | AgentShield 配置掃描 |

---

## 二、導入步驟

### Step 1：Clone ECC 到本機

```bash
git clone https://github.com/affaan-m/everything-claude-code.git ~/everything-claude-code
```

### Step 2：挑選需要的模組複製到你的專案

ECC 不需要全裝，按需挑選：

```bash
# 在你的專案根目錄
mkdir -p .claude

# 複製你需要的部分
cp -r ~/everything-claude-code/agents/ .claude/agents/
cp -r ~/everything-claude-code/commands/ .claude/commands/
cp -r ~/everything-claude-code/rules/ .claude/rules/
cp -r ~/everything-claude-code/hooks/ .claude/hooks/
cp -r ~/everything-claude-code/skills/ .claude/skills/
```

### Step 3：按優先順序啟用

不要一次全開，按下面順序逐步啟用：

---

## 三、優先導入項目

### 優先 1：Rules（語言規範）— 立即見效，零風險

**做什麼**：讓 Claude Code 寫出符合語言 best practice 的程式碼。

**你需要的 rules**（根據 StockVision 技術棧）：

| 語言 | 對應服務 | 複製哪個 |
|------|---------|---------|
| TypeScript | Worker (CF) | `rules/typescript/` |
| Python | ml-controller, ml-service, shioaji-proxy | `rules/python/` |
| React/TSX | Frontend | `rules/typescript/` (含 React 規範) |

**操作**：

```bash
# 複製語言規範
cp -r ~/everything-claude-code/rules/typescript/ .claude/rules/typescript/
cp -r ~/everything-claude-code/rules/python/ .claude/rules/python/

# 在 CLAUDE.md 中引用（如果你有的話）
echo "Follow rules in .claude/rules/" >> CLAUDE.md
```

**效果**：Claude Code 寫 TypeScript 時會自動遵循嚴格型別、避免 any、使用 const 等。寫 Python 時會遵循 type hints、docstring 風格等。

---

### 優先 2：Commands（自定義指令）— 高頻操作一鍵化

**挑選對你最有用的指令**：

| 指令 | 做什麼 | 對應場景 |
|------|--------|---------|
| `/plan` | 拆解任務為步驟 | 開發新功能前 |
| `/tdd` | 測試驅動開發流程 | 寫 ml-controller 邏輯 |
| `/verify` | 驗證改動是否破壞既有功能 | 改 Worker cron job |
| `/security-scan` | 安全掃描 | 改交易相關程式碼 |
| `/commit` | 結構化 commit message | 日常 commit |

**操作**：

```bash
# 複製指令定義
cp -r ~/everything-claude-code/commands/ .claude/commands/

# 只保留你需要的，刪掉不相關的
# 看一下有哪些
ls .claude/commands/
# 刪掉不需要的（如特定框架相關的）
```

**使用**：在 Claude Code 中直接打 `/plan 實作 LangGraph 辯論 graph` 即可。

---

### 優先 3：Agents（專職 subagent）— 提升特定任務品質

**挑選對你最有用的 agent**：

| Agent | 做什麼 | 何時觸發 |
|-------|--------|---------|
| `planner` | 大任務拆解 | 開始一個大功能開發 |
| `architect` | 架構設計 | 設計新模組（如 LangGraph 整合） |
| `code-reviewer` | 通用 code review | PR review |
| `python-reviewer` | Python 專屬 review | ml-controller 改動 |

**操作**：

```bash
cp -r ~/everything-claude-code/agents/ .claude/agents/

# 看一下 agent 定義格式，了解 system prompt 結構
cat .claude/agents/planner.md
```

**自定義**：你可以基於 ECC 的格式新增 StockVision 專屬 agent：

```markdown
<!-- .claude/agents/stockvision-analyst.md -->
## 角色
你是 StockVision 台股分析系統的領域專家。

## 背景知識
- 系統架構：Worker (CF) → Controller (GCP) → ML (Modal)
- 資料庫：D1 (SQLite)、KV store
- ML 模型：10 模型集成（XGBoost, CatBoost, Chronos...）
- 交易：模擬交易，有停損停利機制

## 注意事項
- 改動 Worker cron 時要注意 13 個排程的時間依賴關係
- ml-controller 的 API 介面不能改（Worker 依賴）
- 交易相關改動必須考慮安全性
```

---

### 優先 4：Hooks（自動化）— 進階優化

**最有價值的 hooks**：

| Hook | 觸發時機 | 做什麼 |
|------|---------|--------|
| Session Start | 開始對話 | 載入上次工作記憶、讀取 PARITY.md |
| Pre-Compact | context 快滿 | 策略性壓縮，保留關鍵資訊 |
| Session End | 結束對話 | 萃取本次 session 學到的模式 |
| Post-Commit | git commit 後 | 自動跑 lint 和 type check |

**操作**：

```bash
cp -r ~/everything-claude-code/hooks/ .claude/hooks/

# 檢查 hooks 設定格式
cat .claude/hooks/session-start.md
```

**注意**：hooks 會自動執行，先在小範圍測試確認行為符合預期。

---

### 優先 5：Skills（工作流模板）— 最後導入

Skills 依賴前面的 agents 和 commands 才能發揮最大效果。

**對 StockVision 有用的 skill 類型**：

| Skill 類型 | 用途 |
|-----------|------|
| Testing | ml-controller 的 API 測試流程 |
| Security | 交易功能的安全審查流程 |
| Debugging | 線上 cron job 異常排查流程 |

---

## 四、StockVision 專屬配置建議

在 `.claude/` 目錄下建立 StockVision 專屬的配置：

```
.claude/
├── agents/
│   ├── planner.md              # (ECC) 通用
│   ├── architect.md            # (ECC) 通用
│   ├── code-reviewer.md        # (ECC) 通用
│   ├── python-reviewer.md      # (ECC) Python 專屬
│   └── stockvision-analyst.md  # (自定義) 領域專家
├── commands/
│   ├── plan.md                 # (ECC)
│   ├── tdd.md                  # (ECC)
│   ├── verify.md               # (ECC)
│   └── security-scan.md        # (ECC)
├── rules/
│   ├── typescript/             # (ECC) Worker + Frontend
│   └── python/                 # (ECC) Controller + ML
├── hooks/
│   ├── session-start.md        # (ECC) 載入記憶
│   ├── pre-compact.md          # (ECC) 策略壓縮
│   └── post-commit.md          # (ECC) 自動檢查
├── skills/
│   └── (按需新增)
└── contexts/
    ├── dev.md                  # 開發模式 prompt
    ├── review.md               # Review 模式 prompt
    └── debug.md                # 除錯模式 prompt
```

---

## 五、Context 模式切換

參考 ECC 的 contexts 機制，為不同工作情境設定不同的 system prompt 注入：

### 開發模式 (.claude/contexts/dev.md)

```markdown
你正在開發 StockVision 系統。
- 大膽嘗試新方案，可以先寫 POC
- 優先讓功能跑起來，之後再優化
- 有不確定的地方直接問我
```

### Review 模式 (.claude/contexts/review.md)

```markdown
你正在 review StockVision 的程式碼。
- 嚴格檢查：型別安全、錯誤處理、邊界條件
- 特別注意交易相關程式碼的安全性
- 檢查 Worker cron 排程的時間依賴是否正確
- 檢查 API 介面相容性（Worker ↔ Controller）
```

### 除錯模式 (.claude/contexts/debug.md)

```markdown
你正在排查 StockVision 的線上問題。
- 先收集資訊，不要急著改 code
- 檢查 cron 任務鏈的上下游依賴
- 看 D1 資料是否一致
- 檢查 Modal/Cloud Run 的 cold start 問題
```

---

## 六、安全注意事項

### AgentShield 掃描

ECC 提供安全掃描工具，建議在導入配置後執行：

```bash
# 掃描你的 .claude/ 配置是否有安全風險
# 檢查項目：
# - hooks 是否可能被 prompt injection 利用
# - agents 的權限範圍是否過大
# - commands 是否有危險操作未加防護
```

### StockVision 特殊注意

由於你的系統涉及交易，額外注意：

1. **不要在 agent prompt 中暴露 API keys 或 tokens** — 用環境變數
2. **交易相關的 command/skill 必須有確認步驟** — 不能一鍵直接下單
3. **hooks 不要自動執行交易操作** — hooks 只做唯讀分析或通知
4. **定期 review .claude/ 配置** — 確保沒有被意外修改

---

## 七、導入檢查清單

按順序執行，每步完成打勾：

- [ ] Clone ECC repo 到本機
- [ ] 閱讀 ECC 的 Shorthand Guide 了解整體概念
- [ ] **Rules**：複製 TypeScript + Python rules，跑幾次開發驗證品質
- [ ] **Commands**：複製 /plan、/tdd、/verify、/commit，試用幾次
- [ ] **Agents**：複製 planner、architect、code-reviewer，試用
- [ ] **Agents**：建立 stockvision-analyst 自定義 agent
- [ ] **Contexts**：建立 dev/review/debug 三個模式
- [ ] **Hooks**：啟用 session-start，測試記憶載入
- [ ] **Hooks**：啟用 pre-compact，測試長 session 品質
- [ ] **Security**：跑 AgentShield 掃描確認配置安全
- [ ] **Skills**：根據實際需求開始建立工作流模板
