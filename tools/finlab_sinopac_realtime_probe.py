from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.finlab_sinopac_realtime_probe import run_probe, sinopac_env_status  # noqa: E402


def _symbols(value: str) -> list[str]:
    return [item.strip() for item in value.replace(" ", ",").split(",") if item.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Read-only FinLab Sinopac realtime tick/bidask latency probe.",
    )
    parser.add_argument("--symbols", default="6126,6271")
    parser.add_argument("--duration-seconds", type=int, default=5400)
    parser.add_argument("--output-dir", default=".tmp/finlab_sinopac_realtime_probe")
    parser.add_argument("--allow-broker-login", action="store_true")
    parser.add_argument("--compare-proxy", action="store_true")
    parser.add_argument("--proxy-url", default=os.environ.get("SHIOAJI_PROXY_URL", ""))
    parser.add_argument("--proxy-token", default=os.environ.get("PROXY_SERVICE_TOKEN", ""))
    parser.add_argument("--proxy-poll-seconds", type=int, default=15)
    parser.add_argument("--env-check-only", action="store_true")
    args = parser.parse_args()

    if args.env_check_only:
        print(json.dumps(sinopac_env_status(), ensure_ascii=False, indent=2))
        return

    proxy_url = args.proxy_url if args.compare_proxy and args.proxy_url else None
    result = run_probe(
        symbols=_symbols(args.symbols),
        duration_seconds=args.duration_seconds,
        output_dir=Path(args.output_dir),
        allow_broker_login=args.allow_broker_login,
        compare_proxy_url=proxy_url,
        proxy_token=args.proxy_token or None,
        proxy_poll_seconds=args.proxy_poll_seconds,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result.get("status") == "blocked":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
