"""W4(a) market-conditioner challengers: OOF-only, aliased, never touching the release path."""
import hashlib
import inspect
import io
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "ml-controller") not in sys.path:
    sys.path.append(str(ROOT / "ml-controller"))

from app import market_conditioner as mc
from app.formal_feature_contract import FEATURES131, FEATURES131_SHA256, FEATURE131_SEMANTIC, R33_PROFILE

DAYS = [str(date(2026, 1, 1) + timedelta(days=i)) for i in range(60)]
SYMBOLS = [str(1100 + i) for i in range(30)]
HISTORY_COLUMNS = ["market_return_1d", "market_return_5d", "market_bias_20d", "us_vix", "us_sox_return",
                   "us_gspc_return", "us_dxy_return"]


def panel(seed=7):
    rng = np.random.default_rng(seed)
    n = len(DAYS) * len(SYMBOLS)
    dates = np.repeat(DAYS, len(SYMBOLS))
    known = np.repeat([str(date.fromisoformat(d) + timedelta(days=5)) for d in DAYS], len(SYMBOLS))
    X = rng.normal(size=(n, len(FEATURES131))).astype(np.float32)
    target = (X[:, 0] * 0.02 + rng.normal(scale=0.02, size=n)).astype(np.float32)
    return dict(X=X, y=rng.random(n).astype(np.float32), target_returns=target, dates=dates,
                label_known_dates=known, symbols=np.tile(SYMBOLS, len(DAYS)), markets=np.repeat("LISTED", n),
                sectors=np.tile(["A", "B"], n // 2))


def history(days=DAYS, seed=11):
    rng = np.random.default_rng(seed)
    return {day: {**{name: float(v) for name, v in zip(HISTORY_COLUMNS, rng.normal(size=len(HISTORY_COLUMNS)))},
                  "advance_ratio": 0.5, "us_sentiment_score": 0.0, "us_hy_spread": None} for day in days}


def history_block(days=DAYS):
    rows = history(days)
    return mc.seal_block("history", HISTORY_COLUMNS, {d: [rows[d][c] for c in HISTORY_COLUMNS] for d in days},
                         history_sha256="h" * 64, capture_id="cap")


def _raw(function):
    """The undecorated Modal function body (modal 1.x has no get_raw_f)."""
    return function.get_raw_f() if hasattr(function, "get_raw_f") else function._raw_f_


class Bucket:
    def __init__(self):
        self.values = {}

    def blob(self, name):
        owner = self

        class Blob:
            def exists(self, **kw):
                return name in owner.values

            def download_as_bytes(self, **kw):
                return owner.values[name]

            def download_as_text(self, **kw):
                return owner.values[name].decode()

            def upload_from_string(self, value, **kw):
                owner.values[name] = value.encode() if isinstance(value, str) else value

            def upload_from_file(self, stream, **kw):
                owner.values[name] = stream.read()
        return Blob()


# R4: FEATURE_COLS and FEATURES131 are pinned, and the declaration sits next to the registry.
def test_feature_cols_order_and_content_are_pinned_by_the_declaration():
    from app.features import FEATURE_COLS
    sha = hashlib.sha256(json.dumps(FEATURE_COLS, separators=(",", ":")).encode()).hexdigest()
    assert len(FEATURE_COLS) == 137 == mc.load_contract()["formal_feature_count"]
    assert sha == mc.load_contract()["formal_feature_names_sha256"] == \
        "c5967f08a269cae3be76e29e370bf61fea21d3a84c2897d49ed333dc1499cc37"
    assert FEATURES131_SHA256 == "be4a3323547897819a5d001737966f5701a7556bb3d284660e744ed2cbc26abd"


def test_feature_cols_fail_closed_when_the_declaration_disagrees(tmp_path, monkeypatch):
    import app.features as features
    registry = ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"
    (tmp_path / registry.name).write_bytes(registry.read_bytes())
    declared = mc.load_contract()
    monkeypatch.setattr(features, "_registry_search_paths", lambda: [tmp_path / registry.name])
    (tmp_path / features.FORMAL_FEATURE_DECLARATION).write_text(json.dumps({**declared, "formal_feature_names_sha256": "0" * 64}))
    with pytest.raises(RuntimeError, match="formal137_feature_order_mismatch"):
        features._load_formal_feature_cols()
    (tmp_path / features.FORMAL_FEATURE_DECLARATION).unlink()
    with pytest.raises(RuntimeError, match="formal137_registry_unavailable"):
        features._load_formal_feature_cols()


def test_contract_declares_the_market_columns_and_the_degenerate_fingerprint():
    contract = mc.load_contract()
    registry = json.loads((ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json").read_text(encoding="utf-8"))
    fingerprint = contract["degenerate_triage"]["fingerprint"]
    degenerate = [row["feature_id"] for row in registry["features"]
                  if all(round((row.get("triage") or {}).get(k) or 0, 8 if k != "max_drawdown" else 4) == v
                         for k, v in fingerprint.items())]
    assert degenerate == contract["degenerate_triage"]["features"] and len(degenerate) == 34
    declared = {row["feature_id"]: row for row in contract["features"]}
    assert len(declared) == 20 and all(row["role"] == "market_conditioner" for row in declared.values())
    assert {n for n, r in declared.items() if r["in_formal131"]} == {"advance_ratio", "us_sentiment_score"}
    for arm in contract["arms"].values():
        assert all(declared[name]["status"] == "available" for name in arm["add"])


def test_arms_add_or_drop_only_declared_market_columns():
    mkt9, mkt0 = mc.arm_feature_names("mkt9"), mc.arm_feature_names("mkt0")
    assert mkt9[:131] == list(FEATURES131) and mkt9[131:] == HISTORY_COLUMNS and len(mkt9) == 138
    assert mkt0 == [n for n in FEATURES131 if n not in ("advance_ratio", "us_sentiment_score")] and len(mkt0) == 129
    with pytest.raises(ValueError, match="market_conditioner_arm_unknown"):
        mc.arm_feature_names("mkt99")


# R1: aliases never collide with roster names or the release fold files.
def test_aliases_and_versions_never_collide_with_the_release_roster():
    from app.alpha_model_roster import SUPPORTED_MODELS
    roster = {name.lower() for name in SUPPORTED_MODELS}
    for slot, spec in mc.LIFECYCLE_SLOTS.items():
        alias = spec["payload_config"]["oof_model_alias"]
        assert slot.lower() not in roster and alias.lower() not in roster and alias != spec["payload_config"]["challenger_model"]
    assert len({s["payload_config"]["oof_model_alias"].lower() for s in mc.LIFECYCLE_SLOTS.values()}) == len(mc.LIFECYCLE_SLOTS)
    payload = {**mc.LIFECYCLE_SLOTS["lgbm_mkt9"]["payload_config"], "oof_challenger": True,
               "output_model_version": "c-w1", "market_conditioner": {"arm": "mkt9"}}
    identity = mc.challenger_identity(payload)
    assert identity["version"] == "c-w1-lightgbm_mkt9" != payload["output_model_version"]
    with pytest.raises(ValueError, match="market_conditioner_alias_invalid"):
        mc.challenger_identity({**payload, "oof_model_alias": "LightGBM"})
    with pytest.raises(ValueError, match="market_conditioner_alias_invalid"):
        mc.challenger_identity({**payload, "oof_model_alias": "lightgbm"})
    with pytest.raises(ValueError, match="market_conditioner_oof_fold_required"):
        mc.challenger_identity({**payload, "oof_challenger": False})


def test_apply_block_joins_by_date_and_mkt0_drops_two_columns():
    data = panel()
    block = history_block()
    X9, names9, receipt = mc.apply_block(data["X"], data["dates"], list(FEATURES131),
                                         {"arm": "mkt9", "blocks": {"history": block}})
    assert names9 == mc.arm_feature_names("mkt9") and X9.shape == (len(data["X"]), 138)
    np.testing.assert_array_equal(X9[:, :131], data["X"])
    for day in (DAYS[0], DAYS[33]):
        rows = data["dates"] == day
        np.testing.assert_allclose(X9[rows, 131:], np.tile(np.asarray(block["values"][day], dtype=np.float32), (rows.sum(), 1)))
    assert receipt["uncovered_rows"] == 0 and receipt["feature_count"] == 138
    X0, names0, _ = mc.apply_block(data["X"], data["dates"], list(FEATURES131), {"arm": "mkt0", "blocks": {}})
    keep = [i for i, n in enumerate(FEATURES131) if n not in ("advance_ratio", "us_sentiment_score")]
    np.testing.assert_array_equal(X0, data["X"][:, keep])
    assert names0 == mc.arm_feature_names("mkt0")


def test_apply_block_fails_closed_on_tampering_uncovered_dates_or_a_non131_base():
    data = panel()
    block = history_block()
    tampered = {**block, "values": {**block["values"], DAYS[0]: [0.0] * 7}}
    with pytest.raises(ValueError, match="block_checksum_mismatch"):
        mc.apply_block(data["X"], data["dates"], list(FEATURES131), {"arm": "mkt9", "blocks": {"history": tampered}})
    # One missing date (1/60 of the rows) is never filled: the arm fails instead.
    for short in (history_block(DAYS[10:]), history_block(DAYS[1:])):
        with pytest.raises(ValueError, match="market_conditioner_dates_uncovered"):
            mc.apply_block(data["X"], data["dates"], list(FEATURES131), {"arm": "mkt9", "blocks": {"history": short}})
    with pytest.raises(ValueError, match="market_conditioner_base_not_formal131"):
        mc.apply_block(data["X"][:, :130], data["dates"], list(FEATURES131)[:130], {"arm": "mkt0", "blocks": {}})


def test_constant_or_missing_market_columns_never_become_a_block():
    values = {d: [0.0] * 7 for d in DAYS}
    with pytest.raises(ValueError, match="market_conditioner_constant_column:market_return_1d"):
        mc.seal_block("history", HISTORY_COLUMNS, values)


# R2: a history that does not match the prep manifest leaves only the market arms unsupported.
def test_history_sha_mismatch_marks_market_arms_unsupported(monkeypatch):
    import services.training_global_capture as capture
    rows = history()
    proof = {"history_sha256": "a" * 64, "capture_id": "cap"}
    monkeypatch.setattr(capture, "read_market_history", lambda bucket, **kw: (rows, proof))
    manifest = {"price_capture": {"capture_id": "cap"}, "global_capture": {"history_sha256": "a" * 64, "us_component": {}}}
    good = mc.build_blocks(None, manifest)
    assert good["history"]["columns"] == HISTORY_COLUMNS and good["history"]["history_sha256"] == "a" * 64
    assert mc.conditioner_for_arm("mkt9", good)[1] is None
    bad = mc.build_blocks(None, {**manifest, "global_capture": {"history_sha256": "b" * 64}})
    assert "market_conditioner_history_sha_mismatch" in bad["history"]["error"]
    conditioner, reason = mc.conditioner_for_arm("mkt9", bad)
    assert conditioner is None and reason.startswith("market_conditioner_block_unavailable:history:")
    # mkt0 needs no block: it still runs, as do the release folds.
    assert mc.conditioner_for_arm("mkt0", bad) == ({"arm": "mkt0", "blocks": {}}, None)
    assert mc.conditioner_for_arm("mkt9", {"error": "builder_crashed"})[1].endswith("builder_crashed")
    monkeypatch.setattr(capture, "read_market_history", lambda bucket, **kw: (_ for _ in ()).throw(ValueError("gap")))
    assert "gap" in mc.build_blocks(None, manifest)["history"]["error"]


def test_orchestrator_isolates_market_challengers_from_the_release_folds():
    import modal_app
    source = inspect.getsource(_raw(modal_app.walk_forward_orchestrator))
    # The block is built by its own function, awaited only by market challengers, under the gate's tail cap.
    assert "build_market_conditioner_block.remote.aio" in source
    assert 'run_challenger(trainer, slot_payload, market_state["blocks"], **gated)' in source
    assert '{"status": "unsupported", "reason": r["unsupported"]}' in source
    # Every market challenger is deferred out of the window's gather; the tail starts when the windows return.
    assert "gate.track(wid, gpu=" in source
    assert 'trainer, slot_payload, budget_s=None, gate=gate, ticket=ticket' in source
    assert 'market_state["gate"].champion_done.set()' in source
    assert 'payload.get("challenger_models_disabled")' in source
    assert mc.TAIL_CAP_S == 45 * 60
    # R3: market challengers run in their own Modal functions, never a release trainer's pool.
    functions = {spec["modal_function"] for spec in mc.LIFECYCLE_SLOTS.values()}
    assert functions == {"train_wf_tree_market_challenger", "train_tabm_market_challenger"}


# Champion path: Modal wrappers byte-identical to 03727129 and training results identical with challengers off.
CHAMPION_WRAPPER_SHA256 = {
    "train_wf_tree_window": "e2501c5a11c8224ae6e08556e1db2210fde04202f53442afcecfe9ad9fd38f79",
    "train_tabm_universal": "7c3ab63aa133faedfe12e3be24eedfa3c12b4e9fbff9ed02b8c7ad3301663653",
}


def _wrapper_sha(name):
    import modal_app
    return hashlib.sha256(inspect.getsource(_raw(getattr(modal_app, name))).encode()).hexdigest()


def test_champion_modal_wrappers_are_unchanged():
    for name, expected in CHAMPION_WRAPPER_SHA256.items():
        assert _wrapper_sha(name) == expected, name


def _tree_run(monkeypatch, bucket, *, conditioner=None, models=("ExtraTrees",), version="c-w1"):
    from app import universal_training as ut
    data = panel()
    raw = io.BytesIO()
    np.savez(raw, **{k: data[k] for k in ("X", "y", "target_returns", "dates", "symbols", "markets", "label_known_dates")},
             missingness_rates=np.zeros(131))
    bucket.values["universal/prep/feature_names.json"] = json.dumps(list(FEATURES131)).encode()
    monkeypatch.setattr(ut, "_get_bucket", lambda: bucket)
    monkeypatch.setattr(ut, "download_existing_blobs", lambda *a, **k: [("universal/prep/batch_0.npz", raw.getvalue())])
    monkeypatch.setattr(ut, "collect_prep_lineage", lambda *a, **k: {})
    monkeypatch.setenv("STOCKVISION_SOURCE_SHA", "f" * 40)
    req = ut.UniversalTrainRequest(
        feature_semantic_version=FEATURE131_SEMANTIC, batch_count=1, models_filter=list(models), skip_feature_pool=True,
        feature_release_mode="approved_full131_v1" if conditioner is None else mc.RELEASE_MODE,
        train_start=DAYS[0], train_end=DAYS[39], test_start=DAYS[45], test_end=DAYS[59], gcs_prefix="universal",
        window_id=1, skip_weekly_backup=True, generation_mode="purged_oof", cohort_id="c", fold_id="w1",
        output_model_version=version, fold_model_cpcv="outer_test_date_panel", disable_stale_prep_guard=True)
    return ut.train_universal_from_gcs(req, **({"market_conditioner": conditioner} if conditioner else {}))


def _oof_digest(raw):
    npz = np.load(io.BytesIO(raw), allow_pickle=True)
    meta = json.loads(str(npz["metadata"]))
    return meta["contract_checksum"], hashlib.sha256(np.round(npz["raw_scores"], 8).tobytes()).hexdigest()


# Computed with this fixture at 03727129 (before W4(a)); contract checksum, raw-score digest.
CHAMPION_TREE_OOF = ("f9f39c9d3d434a68e8fee96c71486709726df331a34c474e89b6b3aac66a963d",
                     "61c77dffec4c535a373524fefd873074497bc6c3100c314e37c9971178223367")


def test_champion_tree_oof_is_unchanged_with_challengers_off(monkeypatch):
    bucket = Bucket()
    _tree_run(monkeypatch, bucket)
    assert _oof_digest(bucket.values["universal/oof/c/w1/extratrees.npz"]) == CHAMPION_TREE_OOF


def _slot_payload(slot, blocks):
    config = mc.LIFECYCLE_SLOTS[slot]["payload_config"]
    conditioner, reason = mc.conditioner_for_arm(config["market_conditioner_arm"], blocks)
    assert reason is None
    return {"window_id": 1, "train_start": DAYS[0], "train_end": DAYS[39], "test_start": DAYS[45], "test_end": DAYS[59],
            "batch_count": 1, "feature_semantic_version": FEATURE131_SEMANTIC, "generation_mode": "purged_oof",
            "cohort_id": "c", "fold_id": "w1", "output_model_version": "c-w1", "prep_gcs_prefix": "universal",
            "gcs_prefix": "universal", "feature_release_mode": "approved_full131_v1", **config, "oof_challenger": True,
            "market_conditioner": conditioner}


def _lightgbm_missing() -> bool:
    try:
        import lightgbm  # noqa: F401
    except Exception:  # noqa: BLE001 - e.g. libomp absent on a dev Mac
        return True
    return False


@pytest.mark.parametrize("slot", ["et_mkt9", "et_mkt0", pytest.param(
    "lgbm_mkt9", marks=pytest.mark.skipif(_lightgbm_missing(), reason="lightgbm runtime unavailable"))])
def test_tree_challenger_smoke_writes_only_its_alias(monkeypatch, slot):
    import modal_app
    from app import universal_training as ut
    bucket = Bucket()
    data = panel()
    raw = io.BytesIO()
    np.savez(raw, **{k: data[k] for k in ("X", "y", "target_returns", "dates", "symbols", "markets", "label_known_dates")},
             missingness_rates=np.zeros(131))
    bucket.values["universal/prep/feature_names.json"] = json.dumps(list(FEATURES131)).encode()
    monkeypatch.setattr(ut, "_get_bucket", lambda: bucket)
    monkeypatch.setattr(ut, "download_existing_blobs", lambda *a, **k: [("universal/prep/batch_0.npz", raw.getvalue())])
    monkeypatch.setattr(ut, "collect_prep_lineage", lambda *a, **k: {})
    monkeypatch.setattr(modal_app, "_setup_env", lambda: None)
    monkeypatch.setattr(modal_app, "_prepare_training_input_cache_for_payload", lambda payload: {"status": "skipped"})
    monkeypatch.setenv("STOCKVISION_SOURCE_SHA", "f" * 40)
    result = _raw(modal_app.train_wf_tree_market_challenger)(_slot_payload(slot, {"history": history_block()}))
    alias = mc.LIFECYCLE_SLOTS[slot]["payload_config"]["oof_model_alias"]
    assert not result.get("error"), result
    from app.oof_challengers import challenger_metric
    metric = challenger_metric(result)
    assert metric["status"] == "ready" and metric["model"] == alias
    assert metric["oof_artifact"] == f"universal/oof/c/w1/{alias.lower()}.npz"
    oof_files = [k for k in bucket.values if k.startswith("universal/oof/")]
    assert oof_files == [metric["oof_artifact"]]
    assert not any(k.endswith("/c-w1.joblib") or k.endswith("/c-w1.json") for k in bucket.values)
    meta = json.loads(str(np.load(io.BytesIO(bucket.values[metric["oof_artifact"]]), allow_pickle=True)["metadata"]))
    expected = len(mc.arm_feature_names(mc.LIFECYCLE_SLOTS[slot]["payload_config"]["market_conditioner_arm"]))
    assert meta["model_name"] == alias and meta["split_metadata"]["market_conditioner"]["feature_count"] == expected
    assert result["market_conditioner"]["arm"] == mc.LIFECYCLE_SLOTS[slot]["payload_config"]["market_conditioner_arm"]


@pytest.mark.parametrize("slot", ["tabm_mkt9", "tabm_mkt0"])
def test_tabm_challenger_smoke_writes_only_its_alias(monkeypatch, slot):
    import modal_app
    from app import tabm_training
    bucket = Bucket()
    monkeypatch.setattr(tabm_training, "_get_bucket", lambda: bucket)
    monkeypatch.setattr(tabm_training, "collect_prep_lineage", lambda *a, **k: {})
    monkeypatch.setattr(modal_app, "_setup_env", lambda: None)
    monkeypatch.setattr(modal_app, "_prepare_training_input_cache_for_payload", lambda payload: {"status": "skipped"})
    monkeypatch.setenv("STOCKVISION_SOURCE_SHA", "f" * 40)
    data = panel()
    payload = {**_slot_payload(slot, {"history": history_block()}), "epochs": 1,
               "tabular_dataset": {**{k: data[k] for k in ("X", "y", "target_returns", "dates", "symbols", "markets",
                                                           "label_known_dates", "sectors")},
                                   "feature_names": list(FEATURES131)}}
    result = _raw(modal_app.train_tabm_market_challenger)(payload)
    alias = mc.LIFECYCLE_SLOTS[slot]["payload_config"]["oof_model_alias"]
    assert not result.get("error"), result
    assert result["model"] == alias and result["oof_artifact"]["path"] == f"universal/oof/c/w1/{alias.lower()}.npz"
    assert [k for k in bucket.values if k.startswith("universal/oof/")] == [result["oof_artifact"]["path"]]
    assert "universal/tabm/c-w1.pt" not in bucket.values and f"universal/tabm/c-w1-{alias.lower()}.pt" in bucket.values
    arm = mc.LIFECYCLE_SLOTS[slot]["payload_config"]["market_conditioner_arm"]
    assert result["market_conditioner"]["feature_count"] == len(mc.arm_feature_names(arm))


CHAMPION_TABM_OOF = ("844ad5dc2d67a098ff59304ea6f580d13335eea677a95e04c412fb0645bdcb73",
                     "a3326c1779cef735fbcb371561ff2a3ce8d229d918ba1da4b5989bcb536c37e1")


def test_champion_tabm_oof_is_unchanged_with_challengers_off(monkeypatch):
    from app import tabm_training
    bucket = Bucket()
    monkeypatch.setattr(tabm_training, "_get_bucket", lambda: bucket)
    monkeypatch.setattr(tabm_training, "collect_prep_lineage", lambda *a, **k: {})
    monkeypatch.setenv("STOCKVISION_SOURCE_SHA", "f" * 40)
    data = panel()
    tabm_training.train_tabm_universal({
        "window_id": 1, "train_start": DAYS[0], "train_end": DAYS[39], "test_start": DAYS[45], "test_end": DAYS[59],
        "feature_semantic_version": FEATURE131_SEMANTIC, "generation_mode": "purged_oof", "cohort_id": "c",
        "fold_id": "w1", "output_model_version": "c-w1", "gcs_prefix": "universal", "epochs": 1,
        "feature_release_mode": "approved_full131_v1",
        "tabular_dataset": {**{k: data[k] for k in ("X", "y", "target_returns", "dates", "symbols", "markets",
                                                    "label_known_dates", "sectors")}, "feature_names": list(FEATURES131)}})
    assert _oof_digest(bucket.values["universal/oof/c/w1/tabm.npz"]) == CHAMPION_TABM_OOF
