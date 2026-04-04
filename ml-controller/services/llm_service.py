"""
services/llm_service.py — LLM 推薦理由生成

從 routers/recommend.py 抽出的 LLM 呼叫邏輯。
"""

import re
import json
import logging
import httpx

from services.scorer import StockScore

logger = logging.getLogger(__name__)


def generate_reasons(
    api_key: str,
    candidates: list[StockScore],
    sectors: list[dict],
) -> list[dict]:
    """呼叫 Claude Haiku 生成推薦理由（與 dailyRecommendation.ts 邏輯相同）。"""
    top_sectors = "\n".join(
        f"{s['sector']}：外資+投信5日合計 {s.get('total_net', 0):.1f}億，"
        f"平均RSI {s.get('avg_rsi') or 'N/A'}，族群漲跌比 {s.get('up_count', 0)}/{s.get('stock_count', 0)}"
        for s in sectors[:5]
    )

    stock_list = "\n".join(
        f"[{i+1}] {c.symbol} {c.name}（{c.sector or '其他'}）\n"
        f"  綜合分數：{c.total_score} (籌碼{c.chip_score}/40 技術{c.tech_score}/30 ML{c.ml_score}/30)\n"
        f"  外資+投信5日：{c.total_chip_5d/1e8:.2f}億，連買{c.foreign_consecutive}天\n"
        f"  RSI：{c.rsi14 or 'N/A'}，MACD柱：{c.macd_hist or 'N/A'}\n"
        f"  均線：{'MA5✓' if c.above_ma5 else 'MA5✗'} {'MA20✓' if c.above_ma20 else 'MA20✗'} {'MA60✓' if c.above_ma60 else 'MA60✗'}\n"
        f"  ML訊號：{c.ml_signal or 'N/A'}（信心 {f'{c.ml_confidence*100:.0f}%' if c.ml_confidence else 'N/A'}）"
        for i, c in enumerate(candidates)
    )

    prompt = (
        f"你是台灣股市分析師。根據以下量化資料，對每支推薦股票生成分析理由。\n\n"
        f"【當日族群資金流向（前5強）】\n{top_sectors}\n\n"
        f"【推薦候選股票】\n{stock_list}\n\n"
        f"請對每支股票生成 JSON 格式的分析，格式如下（嚴格只回傳 JSON array，不要任何其他文字）：\n"
        f'[\n  {{"reason": "150字以內的推薦理由", "watch_points": ["需注意1", "需注意2"]}}\n]'
    )

    try:
        resp = httpx.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "Content-Type": "application/json",
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
            json={
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 1500,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=30,
        )
        resp.raise_for_status()
        text = resp.json()["content"][0]["text"]
        match = re.search(r"\[[\s\S]*\]", text)
        if match:
            return json.loads(match.group())
    except Exception as e:
        logger.warning(f"LLM reason generation failed: {e}")

    # fallback
    return [{"reason": "量化指標呈現強勢訊號", "watch_points": ["留意大盤整體走勢"]}] * len(candidates)
