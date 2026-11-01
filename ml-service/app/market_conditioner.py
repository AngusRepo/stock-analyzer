"""W4(a) market-conditioner challengers: an OOF-only ablation of market-level columns.

{LightGBM, ExtraTrees, TabM} x arms declared in data/feature_registry/market_conditioner_contract_v1.json
(mkt9 = FEATURES131 + the sealed-capture market columns, mkt0 = FEATURES131 without its two market
columns). They ride app.oof_challengers: aliased fold OOF in GCS, no manifest model_set entry, no
full-fit, no bundle. FEATURES131, the PIT contract, prep and the release roster are unchanged; the
block joins by date after the trainer's 131-column check.
"""
from __future__ import annotations

import hashlib
import json
import math
from functools import lru_cache
from pathlib import Path

import numpy as np

from .formal_feature_contract import FEATURES131
from .training_policy import MARKET_CONDITIONER_RELEASE_MODE as RELEASE_MODE

CONTRACT_NAME = "market_conditioner_contract_v1.json"
BLOCK_SCHEMA = "market-conditioner-block-v1"
TREE_FUNCTION = "train_wf_tree_market_challenger"
TABM_FUNCTION = "train_tabm_market_challenger"
BLOCK_FUNCTION = "build_market_conditioner_block"
# A window never waits on its market challengers longer than this (R33 OOF main path ~4 h).
CHALLENGER_BUDGET_S = 10800
ARMS = ("mkt9", "mkt0")
FAMILIES = (("lgbm", "LightGBM", TREE_FUNCTION), ("et", "ExtraTrees", TREE_FUNCTION), ("tabm", "TabM", TABM_FUNCTION))


def oof_alias(model: str, arm: str) -> str:
    """Never a roster name, case-insensitively: the fold OOF lands at {alias.lower()}.npz."""
    return f"{model}_{arm.upper()}"


LIFECYCLE_SLOTS = {
    f"{short}_{arm}": {"modal_function": function,
                       "payload_config": {"market_conditioner_arm": arm, "challenger_model": model,
                                          "oof_model_alias": oof_alias(model, arm)}}
    for arm in ARMS for short, model, function in FAMILIES
}


def _contract_paths() -> list[Path]:
    here = Path(__file__).resolve()
    return [Path("/root/data/feature_registry") / CONTRACT_NAME, Path("/app/data/feature_registry") / CONTRACT_NAME,
            here.parents[2] / "data" / "feature_registry" / CONTRACT_NAME]


@lru_cache(maxsize=1)
def load_contract() -> dict:
    for path in _contract_paths():
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    raise FileNotFoundError("market_conditioner_contract_missing")


def _declared() -> dict[str, dict]:
    return {row["feature_id"]: row for row in load_contract()["features"]}


def arm_columns(arm: str) -> tuple[list[str], list[str]]:
    """(added, dropped) for an arm; every added column must be declared available."""
    spec = load_contract()["arms"].get(arm)
    if spec is None or spec.get("base") != "FEATURES131":
        raise ValueError(f"market_conditioner_arm_unknown:{arm}")
    declared = _declared()
    add, drop = list(spec.get("add") or []), list(spec.get("drop") or [])
    if any((declared.get(name) or {}).get("status") != "available" for name in add):
        raise ValueError(f"market_conditioner_arm_column_unavailable:{arm}")
    if set(add) & set(FEATURES131) or set(drop) - set(FEATURES131) or len(set(add)) != len(add):
        raise ValueError(f"market_conditioner_arm_invalid:{arm}")
    return add, drop


def arm_feature_names(arm: str) -> list[str]:
    add, drop = arm_columns(arm)
    names = [name for name in FEATURES131 if name not in drop] + add
    if len(names) != int(load_contract()["arms"][arm]["feature_count"]):
        raise ValueError(f"market_conditioner_arm_count_mismatch:{arm}")
    return names


def _block_sha(columns: list[str], values: dict) -> str:
    return hashlib.sha256(json.dumps({"columns": columns, "values": values}, sort_keys=True,
                                     allow_nan=False).encode()).hexdigest()


def seal_block(source: str, columns: list[str], values: dict, **evidence) -> dict:
    """values: {date: [value per column]}; a declared-available column must vary over the capture."""
    for index, name in enumerate(columns):
        seen = [row[index] for row in values.values() if row[index] is not None]
        if not seen or len(set(seen)) < 2:
            raise ValueError(f"market_conditioner_constant_column:{name}")
        if len(seen) < 0.5 * len(values):
            raise ValueError(f"market_conditioner_mostly_null_column:{name}")
    return {"schema_version": BLOCK_SCHEMA, "source": source, "columns": columns, "values": values,
            "block_sha256": _block_sha(columns, values), **evidence}


def build_history_block(bucket, prep_manifest: dict) -> dict:
    """Columns read from the sealed capture's market history, bound to the prep's history_sha256."""
    from services.training_global_capture import read_market_history
    global_capture = prep_manifest.get("global_capture") or {}
    expected = global_capture.get("history_sha256")
    if not expected or not prep_manifest.get("price_capture"):
        raise ValueError("market_conditioner_history_binding_missing")
    history, proof = read_market_history(bucket, price_capture=prep_manifest["price_capture"],
                                         us_component=global_capture.get("us_component") or {})
    if proof["history_sha256"] != expected:
        raise ValueError("market_conditioner_history_sha_mismatch")
    declared = _declared()
    columns = [name for name, row in declared.items() if row.get("status") == "available"
               and row.get("block") == "history" and name not in FEATURES131]
    values = {}
    for day in sorted(history):
        row = []
        for name in columns:
            value = history[day].get(declared[name].get("history_key") or name)
            if value is None or not math.isfinite(float(value)):
                raise ValueError(f"market_conditioner_history_value_missing:{name}:{day}")
            row.append(float(value))
        values[day] = row
    return seal_block("history", columns, values, history_sha256=expected, capture_id=proof["capture_id"])


BLOCK_BUILDERS = {"history": build_history_block}


def build_blocks(bucket, prep_manifest: dict) -> dict:
    """Each block fails on its own: an unbuildable block only leaves the arms that need it unsupported."""
    blocks = {}
    for name, builder in BLOCK_BUILDERS.items():
        try:
            blocks[name] = builder(bucket, prep_manifest)
        except Exception as exc:  # noqa: BLE001 - reported as the dependent arms' unsupported reason.
            blocks[name] = {"error": f"{type(exc).__name__}:{str(exc)[:300]}"}
    return blocks


def conditioner_for_arm(arm: str, blocks) -> tuple[dict | None, str | None]:
    """The payload a challenger needs for this arm, or the reason it is unsupported."""
    try:
        add, _ = arm_columns(arm)
        declared = _declared()
        needed = sorted({declared[name]["block"] for name in add})
    except Exception as exc:  # noqa: BLE001
        return None, f"market_conditioner_arm_invalid:{exc}"
    blocks = blocks if isinstance(blocks, dict) else {"error": "invalid"}
    for name in needed:
        block = blocks.get(name) if not blocks.get("error") else {"error": blocks["error"]}
        block = block if isinstance(block, dict) else {"error": "missing"}
        if block.get("error"):
            return None, f"market_conditioner_block_unavailable:{name}:{block['error']}"
    return {"arm": arm, "blocks": {name: blocks[name] for name in needed}}, None


def apply_block(X: np.ndarray, dates, feature_names: list[str], conditioner: dict):
    """FEATURES131 matrix -> the arm's matrix (dropped columns removed, added columns joined by date)."""
    if list(feature_names) != list(FEATURES131):
        raise ValueError("market_conditioner_base_not_formal131")
    arm = conditioner["arm"]
    add, drop = arm_columns(arm)
    names = arm_feature_names(arm)
    declared = _declared()
    keep = [index for index, name in enumerate(feature_names) if name not in drop]
    day_keys = np.asarray([str(day)[:10] for day in np.asarray(dates).reshape(-1)])
    unique_days, inverse = np.unique(day_keys, return_inverse=True)
    covered = np.ones(len(unique_days), dtype=bool)
    columns, nulls, block_shas = [], {}, {}
    for name in add:
        source = declared[name]["block"]
        block = conditioner["blocks"][source]
        if block.get("schema_version") != BLOCK_SCHEMA or _block_sha(block["columns"], block["values"]) != block["block_sha256"]:
            raise ValueError(f"market_conditioner_block_checksum_mismatch:{source}")
        block_shas[source] = block["block_sha256"]
        position = block["columns"].index(name)
        fill = float(declared[name].get("null_fill", 0.0))
        rows = [block["values"].get(day) for day in unique_days]
        covered &= np.asarray([row is not None for row in rows], dtype=bool)
        values = [None if row is None else row[position] for row in rows]
        nulls[name] = sum(1 for row, value in zip(rows, values) if row is not None and value is None)
        per_day = np.asarray([fill if value is None else value for value in values], dtype=np.float64)
        columns.append(per_day[inverse])
    uncovered_rows = int((~covered[inverse]).sum()) if add else 0
    if uncovered_rows:  # a date the block does not carry is never filled
        raise ValueError(f"market_conditioner_dates_uncovered:{uncovered_rows}/{len(day_keys)}")
    out = np.asarray(X)[:, keep]
    if columns:
        out = np.column_stack([out, *columns]).astype(np.asarray(X).dtype, copy=False)
    receipt = {"arm": arm, "release_mode": RELEASE_MODE, "added": add, "dropped": drop,
               "feature_count": len(names),
               "feature_names_sha256": hashlib.sha256(json.dumps(names, separators=(",", ":")).encode()).hexdigest(),
               "block_sha256": block_shas, "uncovered_rows": uncovered_rows, "null_filled_days": nulls}
    return out, names, receipt


class GpuGate:
    """Cohort-wide gate for L4 challengers (workspace limit 10 concurrent GPUs; the champion folds ask for ~12).

    gpu_free: every window's champion GPU calls are done. champion_done: every window's champion calls are
    done; a gated challenger is cancelled then, so it never extends the cohort. Per window is not enough: a
    challenger started after one window's GPU calls would still take an L4 from another window's queued fold."""

    def __init__(self, windows: int):
        import asyncio
        self.gpu_free, self.champion_done = asyncio.Event(), asyncio.Event()
        self._left = {"gpu": windows, "champion": windows}
        self._tracked: set = set()
        self._tickets: list[tuple] = []
        self._spawned: set = set()
        self._watchers: list = []  # strong references: the loop keeps only weak ones to tasks
        self._turn = asyncio.Condition()
        for key in self._left:
            self._settle(key, 0)

    def _settle(self, key: str, done: int) -> None:
        self._left[key] -= done
        if self._left[key] <= 0:
            (self.gpu_free if key == "gpu" else self.champion_done).set()

    def track(self, window_id, gpu=(), champion=()) -> None:
        """Once per window: its champion GPU futures and all its champion futures (none: nothing pending)."""
        import asyncio
        if window_id in self._tracked:
            return
        self._tracked.add(window_id)

        async def _watch(key: str, futures: list) -> None:
            await asyncio.gather(*futures, return_exceptions=True)
            self._settle(key, 1)
        for key, futures in (("gpu", list(gpu)), ("champion", list(champion))):
            self._watchers.append(asyncio.ensure_future(_watch(key, futures)))

    def ticket(self, rank) -> int:
        """Spawn order once the GPUs are free: rank (arm, window) so whole arms finish first."""
        self._tickets.append((rank, len(self._tickets)))
        return len(self._tickets) - 1

    def _next(self):
        return next((i for _, i in sorted(self._tickets) if i not in self._spawned), None)

    async def turn(self, ticket: int) -> None:
        async with self._turn:
            await self._turn.wait_for(lambda: self._next() == ticket)

    async def release(self, ticket: int) -> None:
        async with self._turn:
            self._spawned.add(ticket)
            self._turn.notify_all()


GPU_CHALLENGER_FUNCTIONS = {TABM_FUNCTION}


async def _until(awaitable, closed, deadline):
    """(True, result) if `awaitable` finishes first; (False, None) at the deadline or once `closed` is set."""
    import asyncio
    loop = asyncio.get_running_loop()
    task = asyncio.ensure_future(awaitable)
    waiters = [asyncio.ensure_future(closed.wait())] if closed is not None else []
    try:
        done, _ = await asyncio.wait([task, *waiters], return_when=asyncio.FIRST_COMPLETED,
                                     timeout=None if deadline is None else max(0.0, deadline - loop.time()))
    finally:
        for waiter in waiters:
            waiter.cancel()
    if task in done:
        return True, task.result()
    task.cancel()
    return False, None


async def run_challenger(trainer, slot_payload: dict, blocks_task, *, budget_s: float | None = CHALLENGER_BUDGET_S,
                         gate: GpuGate | None = None, ticket: int | None = None) -> dict:
    """Wait for the shared block (and, gated, for the champion GPUs and its turn), spawn, and cancel the
    remote input at the budget or once the champion is done.

    A timed-out .remote() await only drops the local wait; modal 1.6.2 sends FunctionCallCancel
    from FunctionCall.cancel() alone, so a queued or running input would otherwise keep its container."""
    import asyncio
    loop = asyncio.get_running_loop()
    deadline = None if budget_s is None else loop.time() + budget_s
    closed = gate.champion_done if gate is not None else None

    def _over(stage: str) -> dict:
        why = "champion_done" if closed is not None and closed.is_set() else "budget"
        return {"unsupported": f"market_challenger_budget_exceeded:{stage}:{why}"}
    try:
        ok, blocks = await _until(asyncio.shield(blocks_task), closed, deadline)
        if not ok:
            return _over("blocks")
        conditioner, reason = conditioner_for_arm(slot_payload["market_conditioner_arm"], blocks)
        if reason:
            return {"unsupported": reason}
        if gate is not None:
            ok, _ = await _until(gate.gpu_free.wait(), closed, deadline)
            if not ok or not (await _until(gate.turn(ticket), closed, deadline))[0]:
                return _over("waiting_for_champion_gpu")
        call = await trainer.spawn.aio({**slot_payload, "market_conditioner": conditioner})
    finally:
        if gate is not None:
            await gate.release(ticket)
    settled = False
    try:
        ok, result = await _until(call.get.aio(), closed, deadline)
        settled = ok
        return result if ok else _over("running")
    finally:
        if not settled:  # also on CancelledError when the orchestrator loop shuts down
            try:
                await call.cancel.aio(terminate_containers=True)
            except Exception as exc:  # noqa: BLE001 - the window still moves on; reported in the log.
                print(f"[MarketChallenger] cancel failed: {type(exc).__name__}: {exc}")


def challenger_identity(payload: dict) -> dict:
    """Alias, arm and a version that never equals the fold's release version."""
    model, alias, arm = payload.get("challenger_model"), payload.get("oof_model_alias"), payload.get("market_conditioner_arm")
    from .alpha_model_roster import SUPPORTED_MODELS
    roster = {str(name).lower() for name in SUPPORTED_MODELS}
    if alias != oof_alias(str(model), str(arm)) or str(alias).lower() in roster:
        raise ValueError(f"market_conditioner_alias_invalid:{alias}")
    base = str(payload.get("output_model_version") or "")
    if not base or not payload.get("oof_challenger"):
        raise ValueError("market_conditioner_oof_fold_required")
    conditioner = payload.get("market_conditioner") or {}
    if conditioner.get("arm") != arm:
        raise ValueError("market_conditioner_payload_arm_mismatch")
    return {"model": model, "alias": alias, "arm": arm, "version": f"{base}-{alias.lower()}",
            "conditioner": conditioner}


def tree_request_fields(payload: dict, identity: dict) -> dict:
    from .formal_feature_contract import payload_semantic
    return dict(
        feature_semantic_version=payload_semantic(payload), batch_count=payload.get("batch_count", 5),
        models_filter=[identity["model"]], skip_feature_pool=True, feature_release_mode=RELEASE_MODE,
        train_start=payload["train_start"], train_end=payload["train_end"], test_start=payload["test_start"],
        test_end=payload["test_end"], gcs_prefix=str(payload.get("prep_gcs_prefix") or "universal").strip().rstrip("/"),
        window_id=payload["window_id"], skip_weekly_backup=True, generation_mode="purged_oof",
        cohort_id=payload.get("cohort_id"), fold_id=str(payload.get("fold_id") or payload.get("window_id") or ""),
        output_model_version=identity["version"], fold_model_cpcv="outer_test_date_panel")


def tree_challenger_result(result: dict, identity: dict) -> dict:
    """Shape a one-model tree run into the single oof_artifact app.oof_challengers reads."""
    artifacts = [row for row in ((result.get("oos_artifact") or {}).get("individual_artifacts") or [])
                 if row.get("model_name") == identity["alias"]]
    metrics = (result.get("results") or {}).get(identity["model"]) or {}
    out = {"model": identity["alias"], "arm": identity["arm"], "version": identity["version"],
           "oos_ic": metrics.get("oos_ic"), "market_conditioner": result.get("market_conditioner")}
    if metrics.get("error") or len(artifacts) != 1:
        return {**out, "error": metrics.get("error") or "challenger_oof_artifact_missing"}
    return {**out, "oof_artifact": artifacts[0]}


def tabm_challenger_payload(payload: dict, identity: dict) -> dict:
    fields = {key: value for key, value in payload.items() if key != "market_conditioner"}
    return {**fields, "output_model_version": identity["version"], "version": identity["version"],
            "feature_release_mode": RELEASE_MODE, "generation_mode": "purged_oof"}


def tabm_challenger_result(result: dict, identity: dict) -> dict:
    artifact = result.get("oof_artifact") or {}
    out = {"model": identity["alias"], "arm": identity["arm"], "version": identity["version"],
           "oos_ic": result.get("oos_ic"), "market_conditioner": result.get("market_conditioner")}
    if result.get("error") or artifact.get("model_name") != identity["alias"]:
        return {**out, "error": result.get("error") or "challenger_oof_artifact_missing"}
    return {**out, "oof_artifact": artifact}
