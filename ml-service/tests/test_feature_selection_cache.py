from app.feature_selection import build_feature_selection_cache_key


class _Blob:
    def __init__(self, name: str, generation: str, size: int = 10, crc32c: str = "crc"):
        self.name = name
        self.generation = generation
        self.size = size
        self.crc32c = crc32c
        self.md5_hash = ""


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
