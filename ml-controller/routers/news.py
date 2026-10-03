"""Bounded, authenticated news inference using the shared Workers AI budget."""
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from services.llm_debate_client import call_llm, provider_error_code, MISTRAL_MODEL, GPT_OSS_MODEL

router = APIRouter()


class NewsAnalysisRequest(BaseModel):
    system_prompt: str = Field(min_length=1, max_length=16000)
    user_prompt: str = Field(min_length=1, max_length=48000)
    temperature: float = Field(default=0.2, ge=0, le=1)
    model: Literal[MISTRAL_MODEL, GPT_OSS_MODEL] = MISTRAL_MODEL


@router.post('/news/analyze')
async def analyze_news(req: NewsAnalysisRequest):
    try:
        text, source = await call_llm(req.system_prompt, req.user_prompt,
            temperature=req.temperature, max_tokens=2048, role='news', model=req.model)
    except RuntimeError as exc:
        raise HTTPException(status_code=503,
            detail=provider_error_code(exc, 'news_inference_unavailable')) from None
    return {'text': text, 'source': source}
