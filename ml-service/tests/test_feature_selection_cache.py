from app.feature_selection import (
    acquire_feature_selection_stage_lock,
    build_feature_selection_cache_key,
    load_feature_selection_stage_checkpoint,
    run_feature_selection_stage,
    save_feature_selection_stage_checkpoint,
)


class _Blob:
    def __init__(self, name: str, generation: str, size: int = 10, crc32c: str = "crc"):
        self.name = name
        self.generation = generation
        self.size = size
        self.crc32c = crc32c
        self.md5_hash = ""


class _StoreBlob:
    def __init__(self, name: str, store: dict[str, str]):
        self.name = name
        self.store = store
        self.generation = "1"

    def exists(self):
        return self.name in self.store

    def download_as_text(self):
        return self.store[self.name]

    def upload_from_string(self, text: str, content_type: str | None = None, if_generation_match=None):
        if if_generation_match == 0 and self.exists():
            raise RuntimeError("precondition failed")
        self.store[self.name] = text
        self.generation = str(int(self.generation) + 1)

    def delete(self):
        self.store.pop(self.name, None)


class _StoreBucket:
    def __init__(self):
        self.store: dict[str, str] = {}

    def blob(self, name: str):
        return _StoreBlob(name, self.store)


def test_feature_selection_cache_key_changes_when_prep_generation_changes():
    common = {
        "feature_blob": _Blob("universal/prep/feature_names.json", "1"),
        "feature_names": ["a", "b"],
        "selection_params": {
            "max_rounds": 100,
            "alpha": 0.01,
            "icir_weight": 0.1,
            "permutation_mode": "within_date_sector",
            "target_permutation_max_workers": 2,
            "k_sweep_n_jobs": 2,
        },
        "train_end_date": None,
        "gcs_prefix": None,
    }

    key1 = build_feature_selection_cache_key(
        prep_blobs=[_Blob("universal/prep/batch_0.npz", "1")],
        **common,
    )
    key2 = build_feature_selection_cache_key(
        prep_blobs=[_Blob("universal/prep/batch_0.npz", "2")],
        **common,
    )

    assert key1 != key2


def test_feature_selection_cache_key_changes_when_policy_changes():
    prep_blobs = [_Blob("universal/prep/batch_0.npz", "1")]
    feature_blob = _Blob("universal/prep/feature_names.json", "1")

    key1 = build_feature_selection_cache_key(
        prep_blobs=prep_blobs,
        feature_blob=feature_blob,
        feature_names=["a", "b"],
        selection_params={"max_rounds": 100, "alpha": 0.01},
        train_end_date=None,
        gcs_prefix=None,
    )
    key2 = build_feature_selection_cache_key(
        prep_blobs=prep_blobs,
        feature_blob=feature_blob,
        feature_names=["a", "b"],
        selection_params={"max_rounds": 60, "alpha": 0.01},
        train_end_date=None,
        gcs_prefix=None,
    )

    assert key1 != key2


def test_feature_selection_stage_checkpoint_round_trips_json_safe_payload():
    bucket = _StoreBucket()

    save_feature_selection_stage_checkpoint(
        bucket,
        "cache-a",
        "target_permutation",
        {"per_feature": {"f1": {"score": 0.5}}, "active": {"f1"}},
    )

    loaded = load_feature_selection_stage_checkpoint(bucket, "cache-a", "target_permutation")

    assert loaded == {"per_feature": {"f1": {"score": 0.5}}, "active": ["f1"]}


def test_checkpointed_stage_hit_skips_compute(monkeypatch):
    bucket = _StoreBucket()
    stats = {}
    save_feature_selection_stage_checkpoint(bucket, "cache-a", "signal_gate", {"passed": True})

    result = run_feature_selection_stage(
        bucket,
        "cache-a",
        "signal_gate",
        dry_run=False,
        checkpoint_stats=stats,
        compute=lambda: (_ for _ in ()).throw(AssertionError("should not recompute")),
    )

    assert result == {"passed": True}
    assert stats["signal_gate"]["status"] == "hit"


def test_checkpointed_stage_lock_conflict_fails_open_and_saves(monkeypatch):
    bucket = _StoreBucket()
    stats = {}
    acquire_feature_selection_stage_lock(
        bucket,
        "cache-a",
        "k_sweep",
        owner="other",
        ttl_seconds=3600,
    )
    monkeypatch.setenv("FEATURE_SELECTION_STAGE_LOCK_WAIT_SECONDS", "0")

    result = run_feature_selection_stage(
        bucket,
        "cache-a",
        "k_sweep",
        dry_run=False,
        checkpoint_stats=stats,
        compute=lambda: {"best_k": 20},
    )

    assert result == {"best_k": 20}
    assert stats["k_sweep"]["status"] == "lock_conflict_fail_open"
    assert load_feature_selection_stage_checkpoint(bucket, "cache-a", "k_sweep") == {"best_k": 20}
