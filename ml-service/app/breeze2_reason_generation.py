from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
import hashlib
import json
import os
import re


REPORT_SCHEMA_VERSION = "breeze2-reason-generation-v1"
DEFAULT_MODEL_ID = "MediaTek-Research/Llama-Breeze2-3B-Instruct-v0_1"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_json(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _candidate_symbol(candidate: dict[str, Any]) -> str:
    return str(candidate.get("symbol") or "").strip()


def _candidate_name(candidate: dict[str, Any]) -> str:
    symbol = _candidate_symbol(candidate)
    return str(candidate.get("name") or candidate.get("stock_name") or symbol).strip()


def _score_v2_summary(candidate: dict[str, Any]) -> dict[str, Any]:
    payload = candidate.get("score_components") or candidate.get("score_v2")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            payload = {}
    if not isinstance(payload, dict):
        return {}
    components = payload.get("components")
    return components if isinstance(components, dict) else {}


def _clean_text(value: Any, max_len: int = 260) -> str:
    text = str(value or "").strip()
    text = re.sub(r"\s+", " ", text)
    return text[:max_len]


def _candidate_prompt_row(candidate: dict[str, Any]) -> dict[str, Any]:
    points = [_clean_text(point, 140) for point in _as_list(candidate.get("watch_points")) if str(point).strip()]
    evidence_items = [
        {
            "source": _clean_text(item.get("source"), 60),
            "snippet": _clean_text(item.get("snippet") or item.get("title") or item.get("summary"), 120),
        }
        for item in _as_list(candidate.get("evidence_items"))
        if isinstance(item, dict) and (item.get("snippet") or item.get("title") or item.get("summary"))
    ][:4]
    return {
        "symbol": _candidate_symbol(candidate),
        "name": _candidate_name(candidate),
        "signal": candidate.get("signal"),
        "score": candidate.get("score"),
        "score_v2": _score_v2_summary(candidate),
        "reason_seed": _clean_text(candidate.get("reason"), 220),
        "watch_points_seed": points[:6],
        "theme": candidate.get("theme") if isinstance(candidate.get("theme"), dict) else {},
        "news": candidate.get("news") if isinstance(candidate.get("news"), (dict, list)) else {},
        "evidence_items": evidence_items,
    }


def build_breeze2_reason_generation_prompt(payload: dict[str, Any]) -> str:
    candidates = [
        _candidate_prompt_row(candidate)
        for candidate in _as_list(payload.get("candidates"))
        if isinstance(candidate, dict) and _candidate_symbol(candidate)
    ]
    run_date = str(payload.get("run_date") or payload.get("date") or "")
    return (
        "你是 StockVision 的台灣股市推薦理由 shadow writer。"
        "請使用繁體中文，語氣像專業投資平台的研究摘要，內容要比摘要卡更完整。\n"
        "限制：只能產生研究摘要，不得下單、不得要求真實交易、不得改寫系統狀態。\n"
        "分析要求：每檔都要說清楚 1) 入選主因 2) Score V2 五構面的強弱 3) 題材是否有可追溯佐證 4) 需要等待的價量或風險確認。\n"
        "如果新聞題材分數是 0，請說明是「缺少可信且未過期的題材加分」，不是直接判定利空。\n"
        "如果基本面分數偏低，請用營收、獲利、估值、財務安全或產業相對位置解釋，不要只列英文欄位。\n"
        "輸出必須是 JSON array；每個元素格式："
        '{"symbol":"2330","reason":"180到320字理由","watchPoints":["觀察1","觀察2","觀察3"]}。\n'
        "watchPoints 最多 3 條，每條 40 到 90 字，要具體、可觀察，優先包含價量、籌碼、技術、題材佐證或風險觸發條件。\n"
        f"run_date={run_date}\n"
        f"candidates={json.dumps(candidates, ensure_ascii=False, separators=(',', ':'))}"
    )


def parse_breeze2_reason_generation_text(text: str) -> dict[str, dict[str, Any]]:
    match = re.search(r"\[[\s\S]*\]", text or "")
    if not match:
        return {}
    try:
        parsed = json.loads(match.group(0))
    except Exception:
        return {}
    if not isinstance(parsed, list):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for item in parsed:
        if not isinstance(item, dict):
            continue
        symbol = str(item.get("symbol") or "").strip()
        reason = _clean_text(item.get("reason"), 420)
        if not symbol or not reason:
            continue
        points = [
            _clean_text(point, 180)
            for point in _as_list(item.get("watchPoints"))
            if str(point).strip()
        ][:3]
        out[symbol] = {
            "source": "breeze2_generation_shadow",
            "reason": reason,
            "watchPoints": points,
        }
    return out


def build_fallback_breeze2_reason_generation(
    payload: dict[str, Any],
    *,
    model_id: str | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    reasons: dict[str, dict[str, Any]] = {}
    for candidate in _as_list(payload.get("candidates")):
        if not isinstance(candidate, dict):
            continue
        symbol = _candidate_symbol(candidate)
        if not symbol:
            continue
        name = _candidate_name(candidate)
        components = _score_v2_summary(candidate)
        ml_edge = components.get("mlEdge", "n/a")
        chip_flow = components.get("chipFlow", "n/a")
        tech = components.get("technicalStructure", "n/a")
        fundamental = components.get("fundamentalQuality", "n/a")
        news_theme = components.get("newsTheme", "n/a")
        reasons[symbol] = {
            "source": "breeze2_generation_fallback",
            "reason": (
                f"Breeze2 shadow fallback：{name} 目前只能用結構化資料產生研究摘要。"
                f"Score V2 顯示模型 {ml_edge}/25、籌碼 {chip_flow}/25、技術 {tech}/25、基本面 {fundamental}/20、新聞題材 {news_theme}/5。"
                "若模型、籌碼與技術同向，候選理由較完整；若新聞題材或基本面偏低，代表缺少可追溯題材或中長期品質支撐，應等待價量確認。"
            ),
            "watchPoints": [
                "觀察 Score V2 的模型、籌碼與技術是否同步轉強，若只有單一構面強，追價權重應降低。",
                "若突破時成交量沒有放大，或法人與券商分點沒有延續，先把它視為觀察名單而不是立即進場。",
                "新聞題材需要可追溯來源；若題材分數仍為 0，代表目前沒有足夠可信且未過期的題材加分。",
            ],
        }
    prompt = build_breeze2_reason_generation_prompt(payload)
    report = {
        "schema_version": REPORT_SCHEMA_VERSION,
        "generated_at": _utc_now(),
        "model_id": model_id or DEFAULT_MODEL_ID,
        "allowed_use": "reason_shadow_only",
        "decision_effect": "advisory_only",
        "primary_candidate_source_allowed": False,
        "mutation_allowed": False,
        "real_trading_allowed": False,
        "reason_source": "fallback",
        "reasons": reasons,
        "prompt_checksum": _sha256_json({"prompt": prompt}),
    }
    if error:
        report["error"] = _clean_text(error, 320)
    return report


def validate_breeze2_reason_generation_report(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema_version") != REPORT_SCHEMA_VERSION:
        errors.append("schema_version_invalid")
    if report.get("allowed_use") != "reason_shadow_only":
        errors.append("allowed_use_invalid")
    if report.get("decision_effect") != "advisory_only":
        errors.append("decision_effect_invalid")
    if report.get("primary_candidate_source_allowed") is not False:
        errors.append("primary_candidate_source_allowed_invalid")
    if report.get("mutation_allowed") is not False:
        errors.append("mutation_allowed_invalid")
    if report.get("real_trading_allowed") is not False:
        errors.append("real_trading_allowed_invalid")
    if not isinstance(report.get("reasons"), dict):
        errors.append("reasons_invalid")
    return errors


def _breeze2_prompt(prompt: str) -> tuple[str, Any, Any]:
    try:
        from mtkresearch.llm.prompt import MRPromptV3  # type: ignore
    except Exception:
        return prompt, None, None

    prompt_engine = MRPromptV3()
    conversations = [
        {
            "role": "system",
            "content": "你是使用繁體中文的台灣股市研究助理，只輸出 JSON。",
        },
        {"role": "user", "content": prompt},
    ]
    built = prompt_engine.get_prompt(conversations)
    if isinstance(built, tuple):
        return str(built[0]), built[1] if len(built) > 1 else None, prompt_engine
    return str(built), None, prompt_engine


def _load_breeze2_model(model_id: str):
    from transformers import AutoModel  # type: ignore
    import torch

    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    kwargs = {
        "torch_dtype": dtype,
        "low_cpu_mem_usage": True,
        "device_map": "auto",
        "trust_remote_code": True,
        "img_context_token_id": 128212,
    }
    try:
        return AutoModel.from_pretrained(model_id, **kwargs).eval()
    except TypeError:
        kwargs.pop("img_context_token_id", None)
        return AutoModel.from_pretrained(model_id, **kwargs).eval()


def _decode_breeze2_output(raw_text: str, prompt_engine: Any) -> str:
    if prompt_engine is None:
        return raw_text
    try:
        parsed = prompt_engine.parse_generated_str(raw_text)
    except Exception:
        return raw_text
    if isinstance(parsed, dict):
        return str(parsed.get("content") or raw_text)
    return raw_text


def _generate_with_transformers(payload: dict[str, Any], model_id: str, prompt: str) -> dict[str, dict[str, Any]]:
    from transformers import AutoTokenizer, GenerationConfig  # type: ignore
    import torch

    prompt_text, pixel_values, prompt_engine = _breeze2_prompt(prompt)
    tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True, use_fast=False)
    model = _load_breeze2_model(model_id)
    inputs = tokenizer(prompt_text, return_tensors="pt").to(model.device)
    generation_config = GenerationConfig(
        max_new_tokens=int(payload.get("max_new_tokens") or 1400),
        temperature=float(payload.get("temperature") or 0.01),
        top_p=float(payload.get("top_p") or 0.01),
        repetition_penalty=float(payload.get("repetition_penalty") or 1.1),
        do_sample=bool(payload.get("do_sample", False)),
        eos_token_id=int(payload.get("eos_token_id") or 128009),
        pad_token_id=tokenizer.eos_token_id or 128009,
    )
    generate_kwargs = {"generation_config": generation_config}
    if pixel_values is not None:
        generate_kwargs["pixel_values"] = pixel_values.to(model.device, dtype=model.dtype)
    with torch.no_grad():
        output = model.generate(**inputs, **generate_kwargs)
    raw_text = tokenizer.decode(output[0], skip_special_tokens=False)
    text = _decode_breeze2_output(raw_text, prompt_engine)
    if not text or text == raw_text:
        input_len = int(inputs["input_ids"].shape[-1])
        text = tokenizer.decode(output[0][input_len:], skip_special_tokens=True)
    return parse_breeze2_reason_generation_text(text)


def generate_breeze2_reason_generation(payload: dict[str, Any]) -> dict[str, Any]:
    model_id = str(payload.get("model_id") or os.environ.get("BREEZE2_REASON_MODEL_ID") or DEFAULT_MODEL_ID)
    prompt = build_breeze2_reason_generation_prompt(payload)
    if payload.get("execute_model") is False:
        return build_fallback_breeze2_reason_generation(payload, model_id=model_id, error="execute_model_false")
    try:
        reasons = _generate_with_transformers(payload, model_id, prompt)
    except Exception as exc:  # noqa: BLE001 - shadow provider must fail open to fallback.
        return build_fallback_breeze2_reason_generation(payload, model_id=model_id, error=f"{type(exc).__name__}: {exc}")
    report = {
        "schema_version": REPORT_SCHEMA_VERSION,
        "generated_at": _utc_now(),
        "model_id": model_id,
        "allowed_use": "reason_shadow_only",
        "decision_effect": "advisory_only",
        "primary_candidate_source_allowed": False,
        "mutation_allowed": False,
        "real_trading_allowed": False,
        "reason_source": "model",
        "reasons": reasons,
        "prompt_checksum": _sha256_json({"prompt": prompt}),
    }
    errors = validate_breeze2_reason_generation_report(report)
    if errors or not reasons:
        return build_fallback_breeze2_reason_generation(payload, model_id=model_id, error=";".join(errors or ["empty_model_output"]))
    return report
