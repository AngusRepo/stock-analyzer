import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "data", "finlab_research");
const INDEX_PATH = path.join(OUT_DIR, "article_index.json");
const NOTES_PATH = path.join(OUT_DIR, "article_notes.json");
const DIGEST_PATH = path.join(ROOT, "FINLAB_RESEARCH_DIGEST.md");

const TOPIC_KEYWORDS = [
  ["data / factor", ["因子", "指標", "factor", "資料", "欄位", "特徵", "feature", "估值", "本益", "淨值", "殖利率"]],
  ["screener", ["選股", "篩選", "股票池", "創新高", "排行", "清單", "screener"]],
  ["chips / institutional flow", ["籌碼", "三大法人", "外資", "投信", "自營", "融資", "融券", "分點", "券商", "大戶"]],
  ["fundamentals / revenue", ["營收", "財報", "基本面", "eps", "毛利", "現金流", "存貨", "ROE", "股利", "ETF"]],
  ["regime / macro", ["大盤", "總經", "景氣", "PMI", "匯率", "利率", "市場", "趨勢", "轉折", "regime", "macro"]],
  ["backtest", ["回測", "績效", "夏普", "報酬", "勝率", "最大回落", "最佳化", "調校", "backtest"]],
  ["execution", ["下單", "交易", "委託", "成交", "流動性", "漲停", "跌停", "交割", "處置", "全額交割", "實戰"]],
  ["ML / AI", ["AI", "ML", "機器學習", "深度學習", "神經", "模型", "預測", "理專", "LLM"]],
  ["risk / portfolio", ["風險", "資金", "部位", "投組", "portfolio", "再平衡", "分散", "停損", "波動", "避險"]],
];

const PRIORITY_WEIGHTS = new Map([
  ["data / factor", 3],
  ["screener", 3],
  ["chips / institutional flow", 3],
  ["fundamentals / revenue", 3],
  ["regime / macro", 3],
  ["backtest", 3],
  ["execution", 3],
  ["ML / AI", 2],
  ["risk / portfolio", 3],
]);

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CDP websocket timeout")), 10000);
      this.ws.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.ws.onerror = (event) => {
        clearTimeout(timeout);
        reject(new Error(`CDP websocket error: ${event.message || "unknown"}`));
      };
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}: ${JSON.stringify(msg.error.data || "")}`));
        else resolve(msg.result);
      }
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP command timeout: ${method}`));
        }
      }, 60000);
    });
  }

  close() {
    this.ws?.close();
  }
}

function stripHtml(input = "") {
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#038;/g, "&")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyTopic(article) {
  const text = `${article.title} ${article.section || ""} ${article.tags?.join(" ") || ""}`.toLowerCase();
  const scores = [];
  for (const [topic, words] of TOPIC_KEYWORDS) {
    let score = 0;
    for (const word of words) {
      if (text.includes(word.toLowerCase())) score += 1;
    }
    if (score) scores.push([topic, score]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  return scores.length ? scores[0][0] : "other";
}

function scorePriority(article) {
  let score = PRIORITY_WEIGHTS.get(article.topic) || 1;
  const text = `${article.title} ${article.section} ${article.tags.join(" ")}`;
  if (/VIP|限定|量化平台|策略|回測|籌碼|營收|流動性|風險|大盤|AI|機器學習/.test(text)) score += 1;
  if (/公告|徵稿|課程|活動|關於/.test(text)) score -= 2;
  if (/ETF|0056|00919|00900/.test(text)) score -= 1;
  if (/下單|流動性|交割|處置|全額交割/.test(text)) score += 2;
  if (/籌碼|三大法人|外資|投信|券商/.test(text)) score += 2;
  if (/營收|財報|基本面|因子|feature|指標/.test(text)) score += 1;
  return score >= 5 ? "P0" : score >= 3 ? "P1" : score >= 1 ? "P2" : "Reject";
}

function detectAccess(article) {
  const text = `${article.section} ${article.tags.join(" ")} ${article.title}`;
  if (/VIP文章|VIP限定|限定/.test(text)) return "vip_tagged";
  return "public_or_unknown";
}

async function getFinlabTarget() {
  const targets = await fetch("http://127.0.0.1:9222/json/list").then((r) => r.json());
  const pages = targets.filter((target) => target.type === "page" && target.url?.startsWith("https://www.finlab.tw/"));
  if (!pages.length) {
    throw new Error("No https://www.finlab.tw/ page found in Chrome on port 9222.");
  }
  return pages[0];
}

async function evalValue(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result.value;
}

async function waitReady(client) {
  for (let i = 0; i < 60; i += 1) {
    const ready = await evalValue(client, "document.readyState");
    if (ready === "complete" || ready === "interactive") return;
    await sleep(500);
  }
}

async function navigate(client, url) {
  await client.send("Page.enable");
  await client.send("Page.navigate", { url });
  await waitReady(client);
}

async function wpFetch(client, urlPath) {
  const expr = `fetch(${JSON.stringify(urlPath)}, { credentials: "include" }).then(async (r) => ({ status: r.status, headers: Object.fromEntries(r.headers.entries()), body: await r.text() }))`;
  const response = await evalValue(client, expr);
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, status: response.status, headers: response.headers, body: response.body };
  }
  return { ok: true, status: response.status, headers: response.headers, body: JSON.parse(response.body) };
}

async function loadPaged(client, endpoint, maxPages = 50) {
  const all = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const sep = endpoint.includes("?") ? "&" : "?";
    const result = await wpFetch(client, `${endpoint}${sep}per_page=100&page=${page}`);
    if (!result.ok) break;
    if (!Array.isArray(result.body) || result.body.length === 0) break;
    all.push(...result.body);
    const totalPages = Number(result.headers["x-wp-totalpages"] || 0);
    if (totalPages && page >= totalPages) break;
  }
  return all;
}

async function buildIndex() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const target = await getFinlabTarget();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();

  try {
    await navigate(client, "https://www.finlab.tw/");

    const [categoriesRaw, tagsRaw, postsRaw] = await Promise.all([
      loadPaged(client, "/wp-json/wp/v2/categories?orderby=name"),
      loadPaged(client, "/wp-json/wp/v2/tags?orderby=count&order=desc"),
      loadPaged(client, "/wp-json/wp/v2/posts?_embed=1&orderby=date&order=desc"),
    ]);

    const categories = new Map(categoriesRaw.map((cat) => [cat.id, stripHtml(cat.name)]));
    const tags = new Map(tagsRaw.map((tag) => [tag.id, stripHtml(tag.name)]));

    const articles = postsRaw.map((post) => {
      const section = (post.categories || []).map((id) => categories.get(id)).filter(Boolean);
      const tagNames = (post.tags || []).map((id) => tags.get(id)).filter(Boolean);
      const article = {
        id: post.id,
        date: post.date,
        title: stripHtml(post.title?.rendered || ""),
        url: post.link,
        section,
        tags: tagNames,
        visible_access_level: "public_or_unknown",
        topic: "other",
        priority_for_stockvision: "P2",
        status: "indexed",
      };
      article.topic = classifyTopic(article);
      article.priority_for_stockvision = scorePriority(article);
      article.visible_access_level = detectAccess(article);
      return article;
    });

    await fs.writeFile(INDEX_PATH, JSON.stringify({ generated_at: new Date().toISOString(), count: articles.length, articles }, null, 2), "utf8");

    const byTopic = articles.reduce((acc, article) => {
      acc[article.topic] = (acc[article.topic] || 0) + 1;
      return acc;
    }, {});
    const byPriority = articles.reduce((acc, article) => {
      acc[article.priority_for_stockvision] = (acc[article.priority_for_stockvision] || 0) + 1;
      return acc;
    }, {});
    const byAccess = articles.reduce((acc, article) => {
      acc[article.visible_access_level] = (acc[article.visible_access_level] || 0) + 1;
      return acc;
    }, {});

    await writeDigestSkeleton(articles, { byTopic, byPriority, byAccess });
    console.log(JSON.stringify({ index_path: INDEX_PATH, digest_path: DIGEST_PATH, count: articles.length, byTopic, byPriority, byAccess }, null, 2));
  } finally {
    client.close();
  }
}

async function extractArticle(client) {
  const expr = `(() => {
    const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
    const article = document.querySelector("article") || document.querySelector(".entry-content") || document.body;
    const title = clean((document.querySelector("h1.entry-title") || document.querySelector("h1") || {}).innerText);
    const meta = clean((document.querySelector(".entry-meta") || {}).innerText);
    const categories = Array.from(document.querySelectorAll('a[rel="category tag"], .cat-links a')).map(a => clean(a.innerText)).filter(Boolean);
    const tags = Array.from(document.querySelectorAll('.tags-links a, a[rel="tag"]')).map(a => clean(a.innerText)).filter(Boolean);
    const headings = Array.from(article.querySelectorAll("h2,h3,h4")).map(h => clean(h.innerText)).filter(Boolean).slice(0, 80);
    const text = clean(article.innerText || "");
    const paragraphs = Array.from(article.querySelectorAll("p,li"))
      .map(el => clean(el.innerText))
      .filter(s => s.length >= 24 && !/^Continue Reading$/i.test(s));
    const accessNotice = /此文章為VIP限定|VIP限定|登出/.test(text) ? "vip_visible_or_unlocked" : "public_visible";
    const codeHints = Array.from(article.querySelectorAll("code, pre"))
      .map(el => clean(el.innerText))
      .filter(Boolean)
      .slice(0, 10)
      .map(s => s.slice(0, 180));
    const keyParas = paragraphs
      .filter(s => /(策略|回測|資料|因子|營收|籌碼|外資|投信|大盤|風險|流動性|下單|AI|模型|波動|指標|特徵|清洗|交易|績效|ETF)/.test(s))
      .slice(0, 14)
      .map(s => s.slice(0, 260));
    return { url: location.href, title, meta, categories, tags, headings, accessNotice, textLength: text.length, keyParas, codeHints };
  })()`;
  return evalValue(client, expr);
}

function deriveNotes(article, extracted) {
  const corpus = `${article.title}\n${article.section.join(" ")}\n${article.tags.join(" ")}\n${extracted.headings.join("\n")}\n${extracted.keyParas.join("\n")}`.toLowerCase();
  const has = (regex) => regex.test(corpus);
  const notes = {
    key_idea: "",
    useful_datasets: [],
    possible_feature: [],
    cleaning_rule: [],
    backtest_design: [],
    production_risk: [],
    adoption_priority: article.priority_for_stockvision,
  };

  if (has(/流動性|成交量|成交金額|漲停|跌停|處置|全額交割|交割/)) {
    notes.key_idea = "把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。";
    notes.useful_datasets.push("daily price/volume", "turnover", "注意股/處置股/全額交割", "order feasibility preview");
    notes.possible_feature.push("liquidity_risk_score", "limit_lock_risk", "estimated_fillability", "settlement_cash_pressure");
    notes.cleaning_rule.push("低成交金額或長期量縮標的不得只靠報酬排序進入候選池。");
    notes.backtest_design.push("回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。");
    notes.production_risk.push("若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。");
  } else if (has(/賣出|停損|轉換線|背離|macd|rci|adl|創高家數|波動/)) {
    notes.key_idea = "賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。";
    notes.useful_datasets.push("OHLCV", "market breadth", "new-high/new-low count");
    notes.possible_feature.push("sell_transition_line", "rci_exhaustion", "macd_divergence", "adl_breadth");
    notes.cleaning_rule.push("高波動突破訊號要與低流動性/極端跳空分開處理。");
    notes.backtest_design.push("比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。");
    notes.production_risk.push("退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。");
  } else if (has(/營收|財報|毛利|eps|roe|股利|基本面|0056|00919|00900|etf/)) {
    notes.key_idea = "基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。";
    notes.useful_datasets.push("monthly revenue", "financial_statement", "dividend", "index constituents/weights", "valuation");
    notes.possible_feature.push("revenue_momentum", "quality_growth_composite", "dividend_stability", "fundamental_rank_delta");
    notes.cleaning_rule.push("財報與月營收需用公告可得日對齊，避免 look-ahead。");
    notes.backtest_design.push("用 walk-forward 排名與成分股回溯，測不同再平衡頻率。");
    notes.production_risk.push("ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。");
  } else if (has(/ai|機器學習|模型|預測|神經|理專/)) {
    notes.key_idea = "AI/ML 類文章適合做 research benchmark，不直接進 production decision。";
    notes.useful_datasets.push("FinLab normalized factors", "price/chip/fundamental feature panels");
    notes.possible_feature.push("model_confidence_delta", "feature_importance_stability", "regime_conditioned_prediction");
    notes.cleaning_rule.push("模型特徵必須走同一套 feature freshness / leakage 檢查。");
    notes.backtest_design.push("只和現有 ML pool 做 challenger shadow test。");
    notes.production_risk.push("範例模型若未處理時序切分與交易摩擦，容易高估效果。");
  } else if (has(/籌碼|三大法人|外資|投信|自營|融資|融券|券商|分點/)) {
    notes.key_idea = "籌碼訊號應轉成主題/產業層級流向與個股異常，而不是只看單日買賣超。";
    notes.useful_datasets.push("institutional net buy/sell", "margin balance", "broker branch flow", "stock tags");
    notes.possible_feature.push("theme_institutional_flow", "foreign_trust_alignment", "margin_heat", "broker_concentration");
    notes.cleaning_rule.push("法人與券商資料需處理拆分、缺值、興櫃覆蓋差異與極端值 winsorize。");
    notes.backtest_design.push("分別測個股流、產業流、主題流的 forward return 與 turnover。");
    notes.production_risk.push("籌碼資料容易追高或反映已發生事件，需要和價格位置/流動性一起 gate。");
  } else if (has(/回測|績效|夏普|最佳化|調校|參數|報酬/)) {
    notes.key_idea = "回測文章主要價值在驗證框架與防過擬合 checklist。";
    notes.useful_datasets.push("price", "benchmark", "transaction cost assumptions");
    notes.possible_feature.push("strategy_robustness_score", "turnover_penalty", "parameter_stability");
    notes.cleaning_rule.push("所有策略需記錄資料可得日、再平衡日、交易假設。");
    notes.backtest_design.push("walk-forward、rolling window、不同成本假設、容量壓力測試。");
    notes.production_risk.push("文章中的漂亮績效不能直接進 pending buy，必須 shadow test。");
  } else {
    notes.key_idea = "低直接採納價值；保留為研究背景或產品參考。";
    notes.production_risk.push("與 StockVision 前段資料清洗、因子或交易風控關聯較低。");
    if (article.priority_for_stockvision !== "Reject") notes.adoption_priority = "P2";
  }

  return notes;
}

async function loadJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readBatch(topic, limit = 8) {
  const index = await loadJson(INDEX_PATH, null);
  if (!index) throw new Error(`Missing index. Run: node tools/finlab_article_research.mjs index`);
  const notesDb = await loadJson(NOTES_PATH, { generated_at: null, notes: [] });
  const done = new Set(notesDb.notes.map((note) => note.id));

  const priorityRank = { P0: 0, P1: 1, P2: 2, Reject: 3 };
  const candidates = index.articles
    .filter((article) => !done.has(article.id))
    .filter((article) => !topic || topic === "all" || article.topic === topic)
    .sort((a, b) => (priorityRank[a.priority_for_stockvision] ?? 9) - (priorityRank[b.priority_for_stockvision] ?? 9) || new Date(b.date) - new Date(a.date))
    .slice(0, limit);

  if (!candidates.length) {
    console.log(JSON.stringify({ read: 0, message: "No unread articles for this filter." }, null, 2));
    return;
  }

  const target = await getFinlabTarget();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();

  const newNotes = [];
  try {
    for (const article of candidates) {
      await navigate(client, article.url);
      await sleep(1800 + Math.floor(Math.random() * 1400));
      const extracted = await extractArticle(client);
      const note = {
        id: article.id,
        title: article.title,
        url: article.url,
        date: article.date,
        section: article.section,
        topic: article.topic,
        visible_access_level: extracted.accessNotice || article.visible_access_level,
        priority_for_stockvision: article.priority_for_stockvision,
        read_at: new Date().toISOString(),
        evidence_outline: {
          headings: extracted.headings.slice(0, 30),
          text_length: extracted.textLength,
          code_hints_count: extracted.codeHints.length,
        },
        research_note: deriveNotes(article, extracted),
      };
      newNotes.push(note);
      notesDb.notes.push(note);
      await fs.writeFile(NOTES_PATH, JSON.stringify({ generated_at: new Date().toISOString(), notes: notesDb.notes }, null, 2), "utf8");
    }
  } finally {
    client.close();
  }

  await writeDigestFromState(index.articles, notesDb.notes);
  console.log(JSON.stringify({ read: newNotes.length, notes_path: NOTES_PATH, digest_path: DIGEST_PATH, articles: newNotes.map((note) => ({ title: note.title, topic: note.topic, priority: note.research_note.adoption_priority })) }, null, 2));
}

function summarizeCounts(items, selector) {
  return items.reduce((acc, item) => {
    const key = selector(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

async function writeDigestSkeleton(articles, counts) {
  const lines = [];
  lines.push("# FinLab Research Digest for StockVision");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Scope");
  lines.push("");
  lines.push("- Source: FinLab article site, `https://www.finlab.tw/`.");
  lines.push("- Coverage target: all WordPress posts, not only VIP articles.");
  lines.push("- Storage rule: keep metadata and paraphrased research notes only; do not store article bodies.");
  lines.push("");
  lines.push("## Step 1 Article Index");
  lines.push("");
  lines.push(`Indexed articles: ${articles.length}`);
  lines.push("");
  lines.push("### Counts");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(counts, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("### Full Index");
  lines.push("");
  lines.push(`Full machine-readable index: \`${path.relative(ROOT, INDEX_PATH).replaceAll("\\", "/")}\``);
  lines.push("");
  lines.push("| title | date | section | topic | visible access level | priority |");
  lines.push("|---|---:|---|---|---|---|");
  for (const article of articles) {
    const section = article.section.join(", ").replaceAll("|", "/");
    lines.push(`| [${article.title.replaceAll("|", "/")}](${article.url}) | ${article.date.slice(0, 10)} | ${section} | ${article.topic} | ${article.visible_access_level} | ${article.priority_for_stockvision} |`);
  }
  lines.push("");
  lines.push("## Step 2-4 Reading Notes and Adoption");
  lines.push("");
  lines.push("_Batch reading not started yet._");
  await fs.writeFile(DIGEST_PATH, `${lines.join("\n")}\n`, "utf8");
}

async function writeDigestFromState(articles, notes) {
  const lines = [];
  const counts = {
    byTopic: summarizeCounts(articles, (article) => article.topic),
    byPriority: summarizeCounts(articles, (article) => article.priority_for_stockvision),
    byAccess: summarizeCounts(articles, (article) => article.visible_access_level),
    readByTopic: summarizeCounts(notes, (note) => note.topic),
    readByAdoption: summarizeCounts(notes, (note) => note.research_note.adoption_priority),
  };

  lines.push("# FinLab Research Digest for StockVision");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Scope");
  lines.push("");
  lines.push("- Source: FinLab article site, `https://www.finlab.tw/`.");
  lines.push("- Coverage target: all WordPress posts, not only VIP articles.");
  lines.push("- Storage rule: keep metadata and paraphrased research notes only; do not store article bodies.");
  lines.push("");
  lines.push("## Step 1 Article Index");
  lines.push("");
  lines.push(`Indexed articles: ${articles.length}`);
  lines.push(`Read articles so far: ${notes.length}`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(counts, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(`Full machine-readable index: \`${path.relative(ROOT, INDEX_PATH).replaceAll("\\", "/")}\``);
  lines.push(`Paraphrased notes checkpoint: \`${path.relative(ROOT, NOTES_PATH).replaceAll("\\", "/")}\``);
  lines.push("");
  lines.push("### Full Article Index");
  lines.push("");
  lines.push("| title | date | section | topic | visible access level | priority |");
  lines.push("|---|---:|---|---|---|---|");
  for (const article of articles) {
    const section = article.section.join(", ").replaceAll("|", "/");
    lines.push(`| [${article.title.replaceAll("|", "/")}](${article.url}) | ${article.date.slice(0, 10)} | ${section} | ${article.topic} | ${article.visible_access_level} | ${article.priority_for_stockvision} |`);
  }
  lines.push("");
  lines.push("## Step 2-3 Batch Reading Notes");
  lines.push("");
  for (const note of notes) {
    const rn = note.research_note;
    lines.push(`### ${note.title}`);
    lines.push("");
    lines.push(`- URL: ${note.url}`);
    lines.push(`- Topic: ${note.topic}`);
    lines.push(`- Access: ${note.visible_access_level}`);
    lines.push(`- StockVision priority: ${rn.adoption_priority}`);
    lines.push(`- Key idea: ${rn.key_idea}`);
    lines.push(`- Useful datasets: ${rn.useful_datasets.join("; ") || "N/A"}`);
    lines.push(`- Possible feature: ${rn.possible_feature.join("; ") || "N/A"}`);
    lines.push(`- Cleaning rule: ${rn.cleaning_rule.join("; ") || "N/A"}`);
    lines.push(`- Backtest design: ${rn.backtest_design.join("; ") || "N/A"}`);
    lines.push(`- Production risk: ${rn.production_risk.join("; ") || "N/A"}`);
    if (note.evidence_outline.headings.length) {
      lines.push(`- Outline markers: ${note.evidence_outline.headings.slice(0, 8).join(" / ")}`);
    }
    lines.push("");
  }

  lines.push("## Step 4 StockVision Adoption Recommendations");
  lines.push("");
  lines.push("### P0: Direct Adoption");
  lines.push("");
  lines.push("- Add liquidity / limit-lock / settlement feasibility gates into pre-trade and backtest evaluation where FinLab articles discuss practical strategy tradability.");
  lines.push("- Treat FinLab normalized fundamentals, classification, themes, and chip datasets as sidecar inputs, then map into the existing StockVision feature schema.");
  lines.push("- Keep paper trade ownership in StockVision; use FinLab execution preview only as feasibility/audit until real-submit pilot.");
  lines.push("");
  lines.push("### P1: Shadow Test");
  lines.push("");
  lines.push("- Run FinLab-inspired factor templates such as revenue momentum, quality-growth, dividend stability, low-volatility entry, and institutional theme flow against current 106-feature baseline.");
  lines.push("- Shadow-test technical exit rules and market breadth exits before allowing them to change pending-buy or sell logic.");
  lines.push("");
  lines.push("### P2: Research Benchmark");
  lines.push("");
  lines.push("- Keep ETF replication, AI/ML examples, and parameter optimization articles as benchmark notebooks or challenger research, not direct production logic.");
  lines.push("");
  lines.push("### Reject");
  lines.push("");
  lines.push("- Do not adopt marketing, activity, course, or broad beginner tutorial content as system logic unless it contains a concrete data, cleaning, backtest, or risk-control idea.");
  await fs.writeFile(DIGEST_PATH, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const [, , command, arg1, arg2] = process.argv;
  if (command === "index") {
    await buildIndex();
    return;
  }
  if (command === "read-batch") {
    await readBatch(arg1 || "all", Number(arg2 || 8));
    return;
  }
  console.error("Usage: node tools/finlab_article_research.mjs index | read-batch [topic|all] [limit]");
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
