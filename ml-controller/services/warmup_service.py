from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Mapping
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class WarmupOutcome:
    value: Any = None
    error: str | None = None
    elapsed_sec: float = 0.0


async def run_named_warmups(
    targets: Mapping[str, Awaitable[Any]],
    *,
    per_target_timeout_sec: float = 25.0,
    overall_timeout_sec: float = 28.0,
) -> dict[str, WarmupOutcome]:
    """Run independent warmups concurrently within one request deadline."""

    loop = asyncio.get_running_loop()

    async def run_one(awaitable: Awaitable[Any]) -> WarmupOutcome:
        started = loop.time()
        try:
            value = await asyncio.wait_for(awaitable, timeout=per_target_timeout_sec)
            return WarmupOutcome(value=value, elapsed_sec=round(loop.time() - started, 3))
        except Exception as exc:  # noqa: BLE001 - warmup evidence must be returned, not raised.
            return WarmupOutcome(
                error=f"{type(exc).__name__}: {exc}",
                elapsed_sec=round(loop.time() - started, 3),
            )

    tasks = {name: asyncio.create_task(run_one(awaitable)) for name, awaitable in targets.items()}
    try:
        values = await asyncio.wait_for(
            asyncio.gather(*tasks.values()),
            timeout=overall_timeout_sec,
        )
    except TimeoutError:
        for task in tasks.values():
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks.values(), return_exceptions=True)
        values = []
        for task in tasks.values():
            if task.cancelled():
                values.append(WarmupOutcome(error="TimeoutError: overall warmup deadline exceeded"))
            else:
                try:
                    values.append(task.result())
                except Exception as exc:  # noqa: BLE001
                    values.append(WarmupOutcome(error=f"{type(exc).__name__}: {exc}"))

    return dict(zip(tasks, values, strict=True))
