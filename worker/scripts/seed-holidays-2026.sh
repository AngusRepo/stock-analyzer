#!/bin/bash
set -e
# 2026 台股休市日（國定假日，週一至週五的部分）
# 來源：臺灣證券交易所 https://www.twse.com.tw/zh/trading/holiday.html
# 週六日本來就不跑 cron，這裡只列「週一到週五但休市」的日期

echo "寫入 2026 年台股休市日到 KV..."

# 元旦
npx wrangler kv:key put --binding KV "holiday:2026-01-01" "元旦"

# 農曆春節（2/12~2/22，其中週一到週五的部分）
npx wrangler kv:key put --binding KV "holiday:2026-02-12" "春節"
npx wrangler kv:key put --binding KV "holiday:2026-02-13" "春節"
npx wrangler kv:key put --binding KV "holiday:2026-02-16" "春節（除夕）"
npx wrangler kv:key put --binding KV "holiday:2026-02-17" "春節（初一）"
npx wrangler kv:key put --binding KV "holiday:2026-02-18" "春節（初二）"
npx wrangler kv:key put --binding KV "holiday:2026-02-19" "春節（初三）"
npx wrangler kv:key put --binding KV "holiday:2026-02-20" "春節補假"

# 和平紀念日
npx wrangler kv:key put --binding KV "holiday:2026-02-27" "和平紀念日補假"

# 兒童節 + 清明節
npx wrangler kv:key put --binding KV "holiday:2026-04-03" "兒童節補假"
npx wrangler kv:key put --binding KV "holiday:2026-04-06" "清明節補假"

# 勞動節
npx wrangler kv:key put --binding KV "holiday:2026-05-01" "勞動節"

# 端午節
npx wrangler kv:key put --binding KV "holiday:2026-06-19" "端午節"

# 中秋節 + 孔子誕辰
npx wrangler kv:key put --binding KV "holiday:2026-09-25" "中秋節"
npx wrangler kv:key put --binding KV "holiday:2026-09-28" "孔子誕辰紀念日"

# 國慶日
npx wrangler kv:key put --binding KV "holiday:2026-10-09" "國慶日補假"

# 台灣光復節
npx wrangler kv:key put --binding KV "holiday:2026-10-26" "台灣光復節補假"

echo "✅ 完成！共 17 個休市日已寫入 KV"
