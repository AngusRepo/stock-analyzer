"""X-DEC-W4A-FU: a market-challenger container builds its tabular dataset once per sealed prep, and each npz
member is inflated once. Same data as load_tabular_dataset; the shared arrays are read-only."""
import io
import json

import numpy as np
import pytest

from app import gcs_batch_io
from app.research_benchmarks import common

DATES = [f"2026-01-{day:02d}" for day in range(1, 11)]
NAMES = ["f_a", "f_b", "f_c"]


def batch(offset: int) -> bytes:
    rng = np.random.default_rng(offset)
    dates = np.asarray([d for d in DATES for _ in range(4)], dtype=object)
    raw = io.BytesIO()
    np.savez(raw, X=rng.normal(size=(len(dates), 3)).astype(np.float32),
             y=rng.random(len(dates)).astype(np.float32), target_returns=rng.normal(size=len(dates)).astype(np.float32),
             dates=dates, sectors=np.asarray(["s"] * len(dates), dtype=object),
             symbols=np.asarray([f"{offset}{i % 4}" for i in range(len(dates))], dtype=object),
             markets=np.asarray(["TWSE"] * len(dates), dtype=object),
             label_known_dates=np.asarray([d.replace("2026-01", "2026-02") for d in dates], dtype=object),
             missingness_rates=np.zeros(3))
    return raw.getvalue()


class Blob:
    def __init__(self, text):
        self.text = text

    def exists(self):
        return self.text is not None

    def download_as_text(self):
        return self.text


class Bucket:
    def __init__(self):
        self.features = json.dumps(NAMES)

    def blob(self, key):
        assert key == "p/prep/feature_names.json"
        return Blob(self.features)


@pytest.fixture
def prep(monkeypatch):
    state = {"raws": [batch(0), batch(1)], "bucket": Bucket(), "downloads": 0}

    def download(bucket, keys, **_):
        state["downloads"] += 1
        assert keys == [f"p/prep/batch_{i}.npz" for i in range(len(keys))]
        return [(key, raw) for key, raw in zip(keys, state["raws"])]
    monkeypatch.setattr(common, "_bucket", lambda: state["bucket"])
    monkeypatch.setattr(gcs_batch_io, "download_existing_blobs", download)
    common._REUSED_TABULAR.clear()
    yield state
    common._REUSED_TABULAR.clear()


PAYLOAD = {"gcs_prefix": "p", "batch_count": 2}


def assert_same_data(left, right):
    for name in left.__dataclass_fields__:
        a, b = getattr(left, name), getattr(right, name)
        if isinstance(a, np.ndarray):
            assert a.dtype == b.dtype and a.shape == b.shape and (a == b).all(), name
        else:
            assert a == b, name


def test_each_npz_member_is_inflated_once():
    reads = []

    class Npz:
        files = ["X"]

        def __getitem__(self, name):
            reads.append(name)
            return np.ones(2)
    decoded = common._DecodedOnce(Npz())
    assert decoded.files == ["X"] and decoded["X"] is decoded["X"] and reads == ["X"]


def test_reused_dataset_equals_a_fresh_load_and_is_built_once(prep):
    fresh = common.load_tabular_dataset(PAYLOAD)
    first, second = common.load_tabular_dataset_reused(PAYLOAD), common.load_tabular_dataset_reused(PAYLOAD)
    assert_same_data(fresh, first)
    assert_same_data(fresh, second)
    assert first is not second and first.X is second.X  # one build, its own dataclass per call
    assert prep["downloads"] == 3  # the download cache is still asked every call (generation check)
    assert first.feature_names == NAMES and first.feature_names is not second.feature_names
    assert all(not getattr(first, n).flags.writeable for n in first.__dataclass_fields__
               if isinstance(getattr(first, n), np.ndarray))
    with pytest.raises(ValueError):
        first.X[0, 0] = 1.0  # the next fold's data cannot be altered in place
    first.X = first.X[:, :1]  # a caller rebinding a field (as train_tabm_universal does) leaves the cache alone
    assert common.load_tabular_dataset_reused(PAYLOAD).X.shape == fresh.X.shape


@pytest.mark.parametrize("change", ["new_batch_object", "feature_names", "batch_count"])
def test_anything_but_the_same_prep_bytes_rebuilds(prep, change):
    first = common.load_tabular_dataset_reused(PAYLOAD)
    payload = PAYLOAD
    if change == "new_batch_object":  # equal content, but not the cached generation's object: rebuild
        prep["raws"] = [bytes(bytearray(raw)) for raw in prep["raws"]]
    elif change == "feature_names":
        prep["bucket"].features = json.dumps(["g_a", "g_b", "g_c"])
    else:  # the same first batch object, but a different prep inventory
        payload = {**PAYLOAD, "batch_count": 1}
    second = common.load_tabular_dataset_reused(payload)
    assert second.X is not first.X
    if change == "feature_names":
        assert second.feature_names == ["g_a", "g_b", "g_c"]


def test_a_rebuild_releases_the_previous_prep_first(prep, monkeypatch):
    import gc
    import weakref

    common.load_tabular_dataset_reused(PAYLOAD)
    old = weakref.ref(common._REUSED_TABULAR["entry"]["dataset"])
    seen = []
    build = common._tabular_dataset

    def checked(*a):
        gc.collect()
        seen.append(old() is None)  # no second full prep in memory while the next one builds
        return build(*a)
    monkeypatch.setattr(common, "_tabular_dataset", checked)
    prep["raws"] = [bytes(bytearray(raw)) for raw in prep["raws"]]
    common.load_tabular_dataset_reused(PAYLOAD)
    assert seen == [True]


def test_missing_inputs_fail_as_before(prep):
    prep["bucket"].features = None
    with pytest.raises(ValueError, match="prep_feature_names_missing"):
        common.load_tabular_dataset_reused(PAYLOAD)
    prep["raws"] = [prep["raws"][0], None]
    with pytest.raises(ValueError, match="prep_batch_missing"):
        common.load_tabular_dataset_reused(PAYLOAD)
    assert not common._REUSED_TABULAR  # nothing cached from a failed build


def test_only_the_market_challenger_reuses(monkeypatch):
    from app import tabm_training as tabm
    calls = []

    class Stop(Exception):
        pass

    def loader(name):
        def load(payload):
            calls.append(name)
            raise Stop()
        return load
    monkeypatch.setattr(tabm, "_get_bucket", lambda: object())
    monkeypatch.setattr(tabm, "load_tabular_dataset", loader("fresh"))
    monkeypatch.setattr(tabm, "load_tabular_dataset_reused", loader("reused"))
    with pytest.raises(Stop):
        tabm.train_tabm_universal({"epochs": 1})
    with pytest.raises(Stop):
        tabm.train_tabm_universal({"epochs": 1}, market_conditioner={"alias": "TabM_MKT0", "conditioner": {}})
    assert calls == ["fresh", "reused"]


def test_folds_on_the_reused_prep_train_exactly_as_on_a_fresh_load(monkeypatch):
    """Two challenger folds in one process from a GCS-style prep: the second reuses the first one's build, and
    each fold's OOF is the one a fresh load gives."""
    pytest.importorskip("torch")
    from app import market_conditioner as mc
    from app import tabm_training as tabm
    from app.formal_feature_contract import FEATURE131_SEMANTIC, FEATURES131
    from tests.test_market_conditioner import Bucket as OofBucket, DAYS, _oof_digest, panel

    data = panel()
    raw = io.BytesIO()
    np.savez(raw, **{k: data[k] for k in ("X", "y", "target_returns", "dates", "symbols", "markets",
                                         "label_known_dates", "sectors")}, missingness_rates=np.zeros(len(FEATURES131)))
    prep = raw.getvalue()  # one object, as the generation-keyed download cache returns for an unchanged blob

    class PrepBucket:
        def blob(self, key):
            return Blob(json.dumps(list(FEATURES131)) if key == "p/prep/feature_names.json" else None)
    monkeypatch.setattr(common, "_bucket", PrepBucket)
    monkeypatch.setattr(gcs_batch_io, "download_existing_blobs", lambda bucket, keys, **_: [(keys[0], prep)])
    oof = OofBucket()
    monkeypatch.setattr(tabm, "_get_bucket", lambda: oof)
    monkeypatch.setattr(tabm, "collect_prep_lineage", lambda *a, **k: {})
    # The arms are covered in test_market_conditioner; here a copy stands in for the block (the trainer keeps
    # the 131-column release mode, so this test needs no arm contract).
    monkeypatch.setattr(mc, "apply_block", lambda X, dates, names, conditioner: (
        np.array(X, copy=True), list(names), {"arm": "copy"}))
    monkeypatch.setenv("STOCKVISION_SOURCE_SHA", "f" * 40)
    builds = []
    build = common._tabular_dataset
    monkeypatch.setattr(common, "_tabular_dataset", lambda *a: builds.append(1) or build(*a))

    def fold(train_end, test_start, test_end):
        tabm.train_tabm_universal({
            "window_id": 1, "train_start": DAYS[0], "train_end": DAYS[train_end], "test_start": DAYS[test_start],
            "test_end": DAYS[test_end], "feature_semantic_version": FEATURE131_SEMANTIC, "generation_mode": "purged_oof",
            "cohort_id": "c", "fold_id": "w1", "output_model_version": "c-w1", "gcs_prefix": "p", "batch_count": 1,
            "epochs": 1, "feature_release_mode": "approved_full131_v1"},
            market_conditioner={"alias": "TabM_MKT0", "conditioner": {}})
        (key,) = [k for k in oof.values if "/oof/" in k]
        return _oof_digest(oof.values.pop(key))

    windows = [(39, 45, 59), (29, 35, 49)]
    reuse = tabm.load_tabular_dataset_reused
    monkeypatch.setattr(tabm, "load_tabular_dataset_reused", common.load_tabular_dataset)
    fresh = [fold(*w) for w in windows]
    assert len(builds) == 2 and fresh[0] != fresh[1]
    monkeypatch.setattr(tabm, "load_tabular_dataset_reused", reuse)
    builds.clear()
    common._REUSED_TABULAR.clear()
    try:
        assert [fold(*w) for w in windows] == fresh and len(builds) == 1
    finally:
        common._REUSED_TABULAR.clear()


@pytest.mark.parametrize("dtype", [np.float32, np.float64])
@pytest.mark.parametrize("clip", [None, 0, 8.0])
def test_the_in_place_standardize_returns_the_out_of_place_bytes(dtype, clip):
    from app.tabm_training import _robust_standardize

    rng = np.random.default_rng(0)
    x = (rng.standard_cauchy(size=(4000, 12)) * 3).astype(dtype)
    x[rng.random(x.shape) < 0.02] = np.nan
    x[rng.random(x.shape) < 0.01] = np.inf
    x[:, 3], x[:, 4] = 1.0, np.nan  # a zero-scale and an all-NaN column
    before = x.copy()
    got, medians, scales = _robust_standardize(x[:1000], x, clip_value=clip)
    # c9d333ff's expression for the same medians and scales.
    expected = np.nan_to_num((x - medians.reshape(1, -1)) / scales.reshape(1, -1), nan=0.0, posinf=0.0, neginf=0.0)
    if clip is not None and float(clip) > 0:
        expected = np.clip(expected, -float(clip), float(clip))
    expected = expected.astype(np.float32)
    assert got.dtype == expected.dtype and got.tobytes() == expected.tobytes()
    assert np.array_equal(x, before, equal_nan=True)  # the input is not touched


def test_gathered_batches_equal_default_collation_and_draw_the_same_rng():
    torch = pytest.importorskip("torch")
    from app.tabm_training import _RowBatches, _as_batch

    x = torch.randn(5000, 7)
    y = torch.rand(5000)

    def epochs(loader):
        torch.manual_seed(11)
        out = [[(xb.clone(), yb.clone()) for xb, yb in loader] for _ in range(3)]
        return out, torch.rand(4)  # the default generator's state after the epochs
    fresh, after_fresh = epochs(torch.utils.data.DataLoader(torch.utils.data.TensorDataset(x, y), batch_size=1024,
                                                            shuffle=True))
    gathered, after_gathered = epochs(torch.utils.data.DataLoader(_RowBatches(x, y), batch_size=1024, shuffle=True,
                                                                  collate_fn=_as_batch))
    assert torch.equal(after_fresh, after_gathered)
    assert [len(e) for e in fresh] == [len(e) for e in gathered] == [5, 5, 5]
    for epoch_fresh, epoch_gathered in zip(fresh, gathered):
        for (xa, ya), (xb, yb) in zip(epoch_fresh, epoch_gathered):
            assert xa.dtype == xb.dtype and ya.shape == yb.shape
            assert xa.numpy().tobytes() == xb.numpy().tobytes() and ya.numpy().tobytes() == yb.numpy().tobytes()
