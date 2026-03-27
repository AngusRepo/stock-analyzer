#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  StockVision v12 — 一鍵部署腳本                                         ║
# ║                                                                          ║
# ║  執行前提：                                                              ║
# ║    1. Node.js 18+  （node -v 確認）                                      ║
# ║    2. npm install -g wrangler && wrangler login                          ║
# ║    3. （選用）pip install modal && modal setup，如需部署 ML 服務                 ║
# ║                                                                          ║
# ║  用法：chmod +x deploy.sh && ./deploy.sh                                 ║
# ╚══════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[INFO]${RESET} $1"; }
success() { echo -e "${GREEN}[ OK ]${RESET} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET} $1"; }
error()   { echo -e "${RED}[ERR ]${RESET} $1"; exit 1; }
step()    { echo -e "\n${BOLD}━━━ $1 ━━━${RESET}"; }
ask()     { echo -ne "${YELLOW}?${RESET} $1 "; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$SCRIPT_DIR/worker"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
ML_DIR="$SCRIPT_DIR/ml-service"

WORKER_URL=""; PAGES_URL=""; ML_URL=""; CONTROLLER_URL=""
CONTROLLER_DIR="$SCRIPT_DIR/ml-controller"

# ── 產生獨立 ML 更新腳本 ─────────────────────────────────────────────────────
generate_ml_script() {
  cat > "$SCRIPT_DIR/deploy-ml.sh" << 'MLEOF'
#!/usr/bin/env bash
# StockVision — ML 服務單獨更新腳本（Modal）
# 用法：./deploy-ml.sh
set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[INFO]${RESET} $1"; }
success() { echo -e "${GREEN}[ OK ]${RESET} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET} $1"; }
error()   { echo -e "${RED}[ERR ]${RESET} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ML_DIR="$SCRIPT_DIR/ml-service"
WORKER_DIR="$SCRIPT_DIR/worker"

command -v modal &>/dev/null || error "找不到 modal CLI。請先執行：pip install modal && modal setup"

echo -e "\n${BOLD}  StockVision ML — Modal 更新部署${RESET}\n"

info "部署 ML 服務到 Modal（約 30 秒）..."
cd "$ML_DIR"
MODAL_OUT=$(modal deploy modal_app.py 2>&1)
echo "$MODAL_OUT" | tail -5

ML_URL=$(echo "$MODAL_OUT" | grep -oE 'https://[a-z0-9-]+\.modal\.run' | head -1)
if [ -z "$ML_URL" ]; then
  ML_URL=$(modal app list 2>/dev/null | grep stockvision-ml | grep -oE 'https://[^ ]+' | head -1)
fi

if [ -n "$ML_URL" ]; then
  success "ML 服務已更新：$ML_URL"
  # 若 wrangler.toml 有舊 URL 也一起更新
  if [ -f "$WORKER_DIR/wrangler.toml" ]; then
    sed -i.bak "s|ML_SERVICE_URL = \"https://.*\\.modal\\.run\"|ML_SERVICE_URL = \"$ML_URL\"|" \
      "$WORKER_DIR/wrangler.toml" 2>/dev/null || true
    cd "$WORKER_DIR" && wrangler deploy --silent
    success "Worker 重新部署完成"
  fi
else
  warn "無法自動取得 URL，請手動查詢：modal app list"
fi

echo -e "\n${GREEN}${BOLD}✅ ML 更新完成${RESET}"
[ -n "$ML_URL" ] && echo -e "   URL: ${CYAN}$ML_URL/health${RESET}\n"
MLEOF
  chmod +x "$SCRIPT_DIR/deploy-ml.sh"
  success "已產生 deploy-ml.sh（Modal 版）"
}

# ── 最終摘要 ─────────────────────────────────────────────────────────────────
print_summary() {
  find "$SCRIPT_DIR" -name "*.bak" -delete 2>/dev/null || true
  echo ""
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════╗${RESET}"
  echo -e "${GREEN}${BOLD}║          🎉  StockVision 部署完成！                  ║${RESET}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════╝${RESET}"
  echo ""
  [ -n "$PAGES_URL"      ] && echo -e "  ${BOLD}前端：${RESET}       ${GREEN}$PAGES_URL${RESET}"
  [ -n "$WORKER_URL"     ] && echo -e "  ${BOLD}API：${RESET}        ${GREEN}$WORKER_URL${RESET}"
  [ -n "$CONTROLLER_URL" ] && echo -e "  ${BOLD}Controller：${RESET} ${GREEN}$CONTROLLER_URL${RESET}"
  [ -n "$ML_URL"         ] && echo -e "  ${BOLD}ML：${RESET}         ${GREEN}$ML_URL${RESET}"
  echo ""
  echo -e "  ${YELLOW}⚠  必做：設定 Google OAuth redirect URI${RESET}"
  echo -e "     ${CYAN}https://console.cloud.google.com/apis/credentials${RESET}"
  echo -e "     加入 Authorized redirect URI："
  echo -e "     ${CYAN}${WORKER_URL}/api/auth/callback${RESET}"
  echo ""
  echo -e "  ${YELLOW}首次上線後執行歷史回填：${RESET}"
  echo -e "     ${CYAN}cd scripts && cp .env.example .env  # 填入 token${RESET}"
  echo -e "     ${CYAN}npx ts-node backfill.ts${RESET}"
  echo ""
  [ -n "$ML_URL" ] && echo -e "  ${YELLOW}之後只更新 ML 程式碼：${RESET}${CYAN}./deploy-ml.sh${RESET}  （Modal，約 30 秒）\n"
}

# ════════════════════════════════════════════════════════════════════════════
# ★  STEP 0：集中收集所有輸入（後面全自動）
# ════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║           StockVision v12 — 一鍵部署                ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  所有資訊在此步驟一次輸入，之後${GREEN}全程自動執行${RESET}。"
echo ""

step "前置工具檢查"
command -v node     &>/dev/null || error "找不到 node，請安裝 Node.js 18+：https://nodejs.org"
command -v npm      &>/dev/null || error "找不到 npm"
command -v wrangler &>/dev/null || npm install -g wrangler --silent
node -e "if(parseInt(process.versions.node)<18)process.exit(1)" \
  2>/dev/null || error "Node.js 需要 18+，目前：$(node -v)"
wrangler whoami &>/dev/null || error "請先執行：wrangler login"
success "工具檢查通過 ✓"

step "收集必要資訊（輸入時不顯示內容）"
echo ""

# JWT_SECRET 自動建議值
SUGGESTED_JWT="SV2024-$(openssl rand -hex 20 2>/dev/null || date +%s%N | sha256sum | head -c 40)"

ask "[1/8] JWT_SECRET  (Enter = 自動產生)"
echo -e "\n      ${CYAN}建議值：$SUGGESTED_JWT${RESET}"
read -r -s INPUT_JWT; echo ""; INPUT_JWT="${INPUT_JWT:-$SUGGESTED_JWT}"

ask "[2/8] GOOGLE_CLIENT_ID"
echo -e "\n      ${CYAN}→ console.cloud.google.com → APIs & Services → Credentials${RESET}"
read -r -s INPUT_GOOGLE_ID; echo ""

ask "[3/8] GOOGLE_CLIENT_SECRET"
echo -e "\n      ${CYAN}→ 同上頁面的 Client Secret${RESET}"
read -r -s INPUT_GOOGLE_SECRET; echo ""

ask "[4/8] ANTHROPIC_API_KEY"
echo -e "\n      ${CYAN}→ console.anthropic.com → API Keys${RESET}"
read -r -s INPUT_ANTHROPIC; echo ""

ask "[5/8] FINMIND_TOKEN"
echo -e "\n      ${CYAN}→ finmindtrade.com 免費註冊 → 帳號設定 → API Token${RESET}"
read -r -s INPUT_FINMIND; echo ""

ask "[6/8] RESEND_API_KEY  (Enter = 跳過，審核 Email 停用)"
echo -e "\n      ${CYAN}→ resend.com 免費，100封/天${RESET}"
read -r -s INPUT_RESEND; echo ""

ask "[7/8] ADMIN_EMAIL（首次登入此 email 的用戶自動成為 admin）"
echo -e "\n      ${CYAN}→ 填入你自己的 Google 帳號 email${RESET}"
read -r INPUT_ADMIN_EMAIL
while [ -z "$INPUT_ADMIN_EMAIL" ]; do
  ask "ADMIN_EMAIL 不能空白，請輸入："
  read -r INPUT_ADMIN_EMAIL
done

INPUT_ML_SECRET="$(openssl rand -hex 24 2>/dev/null || date +%s | sha256sum | head -c 48)"
INPUT_CTRL_SECRET="$(openssl rand -hex 24 2>/dev/null || date +%s | sha256sum | head -c 48)"
echo -e "\n  [8/9] ML_SERVICE_SECRET → 自動產生（${CYAN}${INPUT_ML_SECRET:0:8}...${RESET}）"
echo -e "  [9/9] ML_CONTROLLER_SECRET → 自動產生（${CYAN}${INPUT_CTRL_SECRET:0:8}...${RESET}）"

echo ""
ask "是否部署 ML 服務到 Modal？（需 pip install modal && modal setup）[y/N]"
read -r DEPLOY_ML; echo ""

GCP_PROJECT=""
if [[ "$DEPLOY_ML" =~ ^[Yy]$ ]]; then
  if ! command -v modal &>/dev/null; then
    warn "找不到 modal CLI，跳過 ML 部署。安裝後執行 ./deploy-ml.sh"
    warn "  pip install modal && modal setup"
    DEPLOY_ML="n"
  else
    modal token list &>/dev/null 2>&1 || {
      warn "Modal 未登入，跳過 ML 部署。請先執行：modal setup"
      DEPLOY_ML="n"
    }
    [[ "$DEPLOY_ML" =~ ^[Yy]$ ]] && info "Modal CLI 已就緒"
  fi
fi

echo ""
success "資訊收集完畢，開始自動部署..."

# ════════════════════════════════════════════════════════════════════════════
# STEP 1：D1 資料庫
# ════════════════════════════════════════════════════════════════════════════
step "STEP 1 / 6　D1 資料庫"

D1_OUT=$(wrangler d1 create stockvision-db 2>&1 || true)
if echo "$D1_OUT" | grep -q "database_id"; then
  D1_ID=$(echo "$D1_OUT" | grep 'database_id' | grep -o '"[^"]*"' | tail -1 | tr -d '"')
  success "D1 建立完成：$D1_ID"
elif echo "$D1_OUT" | grep -qi "already exists"; then
  D1_ID=$(wrangler d1 list 2>&1 | grep 'stockvision-db' | grep -oE '[0-9a-f-]{36}' | head -1)
  [ -z "$D1_ID" ] && error "無法取得 D1 ID：wrangler d1 list"
  success "D1 已存在：$D1_ID"
else
  error "D1 建立失敗：$D1_OUT"
fi

sed -i.bak "s/database_id = \"REPLACE_WITH_YOUR_D1_ID\"/database_id = \"$D1_ID\"/" \
  "$WORKER_DIR/wrangler.toml"
success "wrangler.toml 已更新 database_id"

# ════════════════════════════════════════════════════════════════════════════
# STEP 2：KV
# ════════════════════════════════════════════════════════════════════════════
step "STEP 2 / 6　KV 快取空間"

KV_OUT=$(wrangler kv namespace create stockvision-kv 2>&1 || true)
if echo "$KV_OUT" | grep -q '"id"'; then
  KV_ID=$(echo "$KV_OUT" | grep '"id"' | grep -oE '"[0-9a-f]{32}"' | tr -d '"' | head -1)
  success "KV 建立完成：$KV_ID"
elif echo "$KV_OUT" | grep -qi "already exists"; then
  KV_ID=$(wrangler kv namespace list 2>&1 | python3 -c "
import sys,json
try:
  data=json.loads(sys.stdin.read())
  [print(n['id']) for n in data if n.get('title','') in ['stockvision-kv','worker-stockvision-kv']]
except:pass
" 2>/dev/null | head -1)
  [ -z "$KV_ID" ] && error "無法取得 KV ID：wrangler kv namespace list"
  success "KV 已存在：$KV_ID"
else
  error "KV 建立失敗：$KV_OUT"
fi

KV_PREV_OUT=$(wrangler kv namespace create stockvision-kv --preview 2>&1 || true)
KV_PREV_ID=$(echo "$KV_PREV_OUT" | grep '"id"' | grep -oE '"[0-9a-f]{32}"' | tr -d '"' | head -1 || echo "$KV_ID")
[ -z "$KV_PREV_ID" ] && KV_PREV_ID="$KV_ID"

sed -i.bak "s/id = \"REPLACE_WITH_YOUR_KV_ID\"/id = \"$KV_ID\"/" "$WORKER_DIR/wrangler.toml"
sed -i.bak "s/preview_id = \"REPLACE_WITH_YOUR_KV_PREVIEW_ID\"/preview_id = \"$KV_PREV_ID\"/" \
  "$WORKER_DIR/wrangler.toml"
success "KV IDs 已寫入"

# ════════════════════════════════════════════════════════════════════════════
# STEP 2.5：Queues
# ════════════════════════════════════════════════════════════════════════════
step "STEP 2.5 / 6　Cloudflare Queues"

# Phase 3: ML_QUEUE 已移除，只建 UPDATE_QUEUE
for Q in stockvision-update-queue stockvision-update-queue-dlq; do
  OUT=$(wrangler queues create "$Q" 2>&1 || true)
  if echo "$OUT" | grep -qi "already exists\|already a queue"; then
    warn "$Q 已存在，略過"
  else
    success "$Q 建立完成"
  fi
done

# ════════════════════════════════════════════════════════════════════════════
# STEP 3：Secrets
# ════════════════════════════════════════════════════════════════════════════
step "STEP 3 / 6　寫入 Secrets"

cd "$WORKER_DIR"

set_secret() {
  local name="$1" value="$2"
  [ -z "$value" ] && { warn "跳過 $name（未提供）"; return; }
  printf '%s' "$value" | wrangler secret put "$name" --no-interactive 2>/dev/null \
    && success "Secret: $name ✓" \
    || warn "Secret $name 設定失敗（可能需要互動式輸入，請手動執行）"
}

set_secret "JWT_SECRET"           "$INPUT_JWT"
set_secret "GOOGLE_CLIENT_ID"     "$INPUT_GOOGLE_ID"
set_secret "GOOGLE_CLIENT_SECRET" "$INPUT_GOOGLE_SECRET"
set_secret "ANTHROPIC_API_KEY"    "$INPUT_ANTHROPIC"
set_secret "FINMIND_TOKEN"        "$INPUT_FINMIND"
set_secret "RESEND_API_KEY"       "$INPUT_RESEND"
set_secret "ADMIN_EMAIL"          "$INPUT_ADMIN_EMAIL"
set_secret "ML_SERVICE_SECRET"    "$INPUT_ML_SECRET"
set_secret "ML_CONTROLLER_SECRET" "$INPUT_CTRL_SECRET"

# ════════════════════════════════════════════════════════════════════════════
# STEP 4：Worker 部署
# ════════════════════════════════════════════════════════════════════════════
step "STEP 4 / 6　部署 Cloudflare Worker"

cd "$WORKER_DIR"
info "安裝依賴..."; npm install --silent

info "初始化 D1 Schema..."
wrangler d1 execute stockvision-db --remote --file=./schema.sql 2>&1 | tail -3 \
  || warn "schema 部分語句可能已存在（正常）"
success "D1 Schema 完成"

# v12 migration（若已初次建立 schema.sql 包含新表則跳過）
wrangler d1 execute stockvision-db --remote --file=./migration_v12.sql 2>&1 | tail -3 \
  || warn "v12 migration 部分語句已存在（正常）"
success "v12 Migration 完成"

info "部署 Worker..."
DEPLOY_OUT=$(wrangler deploy 2>&1)
echo "$DEPLOY_OUT" | grep -E "Deployed|Published|Error|error" | head -5

WORKER_URL=$(echo "$DEPLOY_OUT" | grep -oE 'https://[^ ]+\.workers\.dev' | head -1)
[ -z "$WORKER_URL" ] && error "無法取得 Worker URL，查看輸出：$DEPLOY_OUT"
success "Worker 部署完成：$WORKER_URL"

# ════════════════════════════════════════════════════════════════════════════
# STEP 5：前端
# ════════════════════════════════════════════════════════════════════════════
step "STEP 5 / 6　Build & 部署前端"

cd "$FRONTEND_DIR"
printf "VITE_API_URL=%s/api\n" "$WORKER_URL" > .env.production
info "安裝依賴..."; npm install --silent
info "Build..."; npm run build
echo "/* /index.html 200" > dist/_redirects
success "Build 完成"

info "部署到 Cloudflare Pages..."
PAGES_OUT=$(wrangler pages deploy dist --project-name=stockvision 2>&1)
echo "$PAGES_OUT" | grep -E "pages\.dev|Error|error" | head -3

PAGES_URL=$(echo "$PAGES_OUT" | grep -oE 'https://[^ ]+\.pages\.dev' | head -1)
[ -z "$PAGES_URL" ] && PAGES_URL="https://stockvision.pages.dev"
success "前端部署完成：$PAGES_URL"

# PAGES_ORIGIN 自動回填到 wrangler.toml（精確 CORS 白名單）
cd "$WORKER_DIR"
sed -i.bak "s|PAGES_ORIGIN = \"REPLACE_WITH_YOUR_PAGES_URL\".*|PAGES_ORIGIN = \"$PAGES_URL\"|" \
  wrangler.toml 2>/dev/null || true
info "重新部署 Worker（更新 PAGES_ORIGIN）..."
wrangler deploy --silent
success "Worker CORS 白名單已更新為 $PAGES_URL"

# ════════════════════════════════════════════════════════════════════════════
# STEP 6：ML 服務（Modal）
# ════════════════════════════════════════════════════════════════════════════
step "STEP 6 / 6　ML 預測服務（Modal）"

if [[ ! "$DEPLOY_ML" =~ ^[Yy]$ ]]; then
  warn "跳過 ML 部署。之後執行 ./deploy-ml.sh"
  generate_ml_script
  print_summary
  exit 0
fi

if ! command -v modal &>/dev/null; then
  error "找不到 modal CLI。請先執行：pip install modal && modal setup"
fi

if ! modal token list &>/dev/null 2>&1; then
  error "Modal 未登入。請先執行：modal setup"
fi

info "建立 Modal GCS Secret（若已存在則更新）..."
ask "請提供 GCS Service Account JSON 檔案路徑（用於 modal_app.py 存取 GCS 模型）："
read -r GCS_SA_JSON_PATH
while [ ! -f "$GCS_SA_JSON_PATH" ]; do
  warn "找不到檔案：$GCS_SA_JSON_PATH"
  ask "請重新輸入路徑（或按 Enter 跳過，之後手動設定）："
  read -r GCS_SA_JSON_PATH
  [ -z "$GCS_SA_JSON_PATH" ] && break
done

if [ -f "$GCS_SA_JSON_PATH" ]; then
  GCS_CREDS_JSON=$(cat "$GCS_SA_JSON_PATH")
  # 建立或更新 Modal Secret
  echo "$GCS_CREDS_JSON" | modal secret create gcs-credentials \
    GOOGLE_APPLICATION_CREDENTIALS_JSON="$GCS_CREDS_JSON" \
    GCS_BUCKET_NAME="stockvision-models" \
    ML_SERVICE_SECRET="$INPUT_ML_SECRET" \
    --force 2>/dev/null \
  && success "Modal Secret gcs-credentials 已設定" \
  || warn "Modal Secret 建立失敗，請手動執行：modal secret create gcs-credentials ..."
else
  warn "跳過 GCS Secret 設定。請部署後手動執行："
  warn "  modal secret create gcs-credentials \\"
  warn "    GOOGLE_APPLICATION_CREDENTIALS_JSON=\"\$(cat your-sa.json)\" \\"
  warn "    GCS_BUCKET_NAME=stockvision-models \\"
  warn "    ML_SERVICE_SECRET=$INPUT_ML_SECRET"
fi

info "部署 ML 服務到 Modal（首次約 3-5 分鐘，之後約 30 秒）..."
cd "$ML_DIR"
MODAL_DEPLOY_OUT=$(modal deploy modal_app.py 2>&1)
echo "$MODAL_DEPLOY_OUT" | tail -5

# 從 modal deploy 輸出取得 endpoint URL
ML_URL=$(echo "$MODAL_DEPLOY_OUT" | grep -oE 'https://[a-z0-9-]+\.modal\.run' | head -1)
if [ -z "$ML_URL" ]; then
  # 備用：從 modal app list 取
  ML_URL=$(modal app list 2>/dev/null | grep stockvision-ml | grep -oE 'https://[^ ]+' | head -1)
fi
if [ -z "$ML_URL" ]; then
  warn "無法自動取得 Modal endpoint URL"
  ask "請手動貼上 Modal 給的 Web Endpoint URL："
  read -r ML_URL
fi
[ -z "$ML_URL" ] && error "沒有 ML_URL，部署中止"
success "Modal 部署完成：$ML_URL"

# 健康檢查
sleep 5
HEALTH=$(curl -sf --max-time 30 "$ML_URL/health" 2>/dev/null || echo "")
if echo "$HEALTH" | grep -q "ok"; then
  success "ML 服務健康檢查通過"
else
  warn "ML 服務還在冷啟動（Modal 首次啟動約 30-60 秒），稍後可手動確認：curl $ML_URL/health"
fi

# 把 Modal URL 寫回 wrangler.toml
cd "$WORKER_DIR"
sed -i.bak "s|ML_SERVICE_URL = \"REPLACE_WITH_YOUR_CLOUD_RUN_URL\".*|ML_SERVICE_URL = \"$ML_URL\"|" \
  wrangler.toml 2>/dev/null || true
sed -i.bak "s|ML_SERVICE_URL = \"https://.*\\.modal\\.run\"|ML_SERVICE_URL = \"$ML_URL\"|" \
  wrangler.toml 2>/dev/null || true
sed -i.bak "s|ML_SERVICE_URL = \"https://.*\\.run\\.app\"|ML_SERVICE_URL = \"$ML_URL\"|" \
  wrangler.toml 2>/dev/null || true
info "重新部署 Worker（更新 ML URL → Modal）..."
wrangler deploy --silent
success "Worker 已更新 ML_SERVICE_URL = $ML_URL"

# ════════════════════════════════════════════════════════════════════════════
# STEP 6.5：ML Controller（Cloud Run）
# ════════════════════════════════════════════════════════════════════════════
step "STEP 6.5　ML Controller（Cloud Run）"

if command -v gcloud &>/dev/null && [ -d "$CONTROLLER_DIR" ]; then
  GCP_PROJECT=$(gcloud config get-value project 2>/dev/null)
  GCP_REGION="asia-east1"
  info "部署 ML Controller 到 Cloud Run（$GCP_REGION）..."

  cd "$CONTROLLER_DIR"
  CTRL_OUT=$(gcloud run deploy ml-controller \
    --source . \
    --region "$GCP_REGION" \
    --platform managed \
    --allow-unauthenticated \
    --cpu 1 --memory 512Mi \
    --min-instances 0 --max-instances 2 \
    --timeout 300 \
    --set-env-vars "ML_SERVICE_URL=$ML_URL,ML_SERVICE_SECRET=$INPUT_ML_SECRET,ML_CONTROLLER_SECRET=$INPUT_CTRL_SECRET" \
    --quiet 2>&1)
  echo "$CTRL_OUT" | tail -3

  CONTROLLER_URL=$(echo "$CTRL_OUT" | grep -oE 'https://[^ ]+\.run\.app' | head -1)
  if [ -n "$CONTROLLER_URL" ]; then
    success "Controller 部署完成：$CONTROLLER_URL"
    # 設定 Worker 的 ML_CONTROLLER_URL
    cd "$WORKER_DIR"
    printf '%s' "$CONTROLLER_URL" | wrangler secret put ML_CONTROLLER_URL --no-interactive 2>/dev/null \
      && success "Worker ML_CONTROLLER_URL 已設定" \
      || warn "請手動執行：echo '$CONTROLLER_URL' | wrangler secret put ML_CONTROLLER_URL"
    wrangler deploy --silent
    success "Worker 重新部署（已連接 Controller）"
  else
    warn "Controller 部署失敗，請手動部署 ml-controller/"
  fi
else
  warn "跳過 Controller 部署（缺少 gcloud CLI 或 ml-controller/ 目錄）"
fi

generate_ml_script
print_summary
