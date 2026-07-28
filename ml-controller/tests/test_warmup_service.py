import asyncio

from services.warmup_service import run_named_warmups


def test_named_warmups_start_all_targets_concurrently() -> None:
    async def scenario():
        started = 0
        all_started = asyncio.Event()

        async def target(name: str):
            nonlocal started
            started += 1
            if started == 2:
                all_started.set()
            await asyncio.wait_for(all_started.wait(), timeout=0.2)
            return {"name": name}

        return await run_named_warmups(
            {"left": target("left"), "right": target("right")},
            per_target_timeout_sec=0.5,
            overall_timeout_sec=0.6,
        )

    outcomes = asyncio.run(scenario())

    assert outcomes["left"].value == {"name": "left"}
    assert outcomes["right"].value == {"name": "right"}
    assert outcomes["left"].error is None
    assert outcomes["right"].error is None


def test_named_warmups_return_timeout_evidence_without_raising() -> None:
    async def scenario():
        async def slow():
            await asyncio.sleep(1)

        return await run_named_warmups(
            {"slow": slow()},
            per_target_timeout_sec=0.01,
            overall_timeout_sec=0.1,
        )

    outcomes = asyncio.run(scenario())

    assert outcomes["slow"].value is None
    assert outcomes["slow"].error is not None
    assert "TimeoutError" in outcomes["slow"].error
