import json
import os
from typing import Any

import pandas as pd


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    try:
        if pd.isna(value):
            return None
    except Exception:
        pass
    return value


def _summarize_df(df: pd.DataFrame, sample_symbols: list[str] | None = None) -> dict[str, Any]:
    info: dict[str, Any] = {
        "type": type(df).__name__,
        "shape": list(df.shape),
        "columns": [str(c) for c in list(df.columns)[:30]],
        "index_name": str(df.index.name),
    }

    samples: dict[str, Any] = {}
    for symbol in sample_symbols or []:
        try:
            rows = None
            if "stock_id" in df.columns:
                rows = df[df["stock_id"].astype(str) == symbol].head(5)
            elif "symbol" in df.columns:
                rows = df[df["symbol"].astype(str) == symbol].head(5)
            elif symbol in df.columns:
                rows = df[[symbol]].dropna().tail(3)

            if rows is not None:
                samples[symbol] = _json_safe(
                    json.loads(rows.astype(str).to_json(orient="records", force_ascii=False))
                )
        except Exception as exc:
            samples[symbol] = {
                "error": f"{type(exc).__name__}: {str(exc)[:160]}",
            }

    if samples:
        info["samples"] = samples

    return info


def _summarize_search_result(result: Any) -> dict[str, Any]:
    if isinstance(result, pd.DataFrame):
        return {
            "type": "DataFrame",
            "shape": list(result.shape),
            "columns": [str(c) for c in list(result.columns)[:20]],
            "head": _json_safe(
                json.loads(result.head(10).astype(str).to_json(orient="records", force_ascii=False))
            ),
        }

    if isinstance(result, (list, tuple)):
        return {
            "type": type(result).__name__,
            "count": len(result),
            "head": [str(item)[:300] for item in list(result)[:10]],
        }

    return {
        "type": type(result).__name__,
        "repr": str(result)[:1200],
    }


def main() -> None:
    import finlab
    from finlab import data, login

    api_key = os.environ.get("FINLAB_API_KEY")
    out: dict[str, Any] = {
        "sdk_version": getattr(finlab, "__version__", "unknown"),
        "has_key_env": bool(api_key),
        "login": None,
        "datasets": {},
        "searches": {},
    }

    if not api_key:
        out["login"] = {
            "status": "error",
            "type": "MissingEnvironment",
            "message": "FINLAB_API_KEY is not set",
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))
        raise SystemExit(1)

    try:
        login(api_key)
        out["login"] = "ok"
    except Exception as exc:
        out["login"] = {
            "status": "error",
            "type": type(exc).__name__,
            "message": str(exc)[:300],
        }

    for dataset in ["security_categories", "security_industry_themes"]:
        try:
            df = data.get(dataset)
            out["datasets"][dataset] = _summarize_df(df, ["7820", "6682"])
        except Exception as exc:
            out["datasets"][dataset] = {
                "status": "error",
                "type": type(exc).__name__,
                "message": str(exc)[:300],
            }

    for query in ["美股", "us", "world", "新聞", "總體", "macro"]:
        try:
            out["searches"][query] = _summarize_search_result(data.search(query))
        except Exception as exc:
            out["searches"][query] = {
                "status": "error",
                "type": type(exc).__name__,
                "message": str(exc)[:300],
            }

    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
