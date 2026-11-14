import random
import threading
import time

import pytest

from services import dataset_snapshot_exporter as exporter
from services.verified_read_observation import verified_read_observation

SQL = "SELECT symbol, date, close FROM parity_table WHERE date BETWEEN ? AND ?"


class FakeClient:
    def __init__(self, fail_on=None):
        self.active = 0
        self.peak = 0
        self.lock = threading.Lock()
        self.fail_on = fail_on

    def query(self, sql, params, timeout=None):
        with self.lock:
            self.active += 1
            self.peak = max(self.peak, self.active)
        try:
            # Later chunks often answer first, so ordering must come from the map.
            time.sleep(random.uniform(0, 0.01))
            start, end = params
            if start == self.fail_on:
                raise RuntimeError("d1_chunk_failed")
            if start.endswith("-05"):
                return []  # an empty chunk is skipped, as before
            return [{"symbol": f"S{i}", "date": end, "close": float(i)} for i in range(3)]
        finally:
            with self.lock:
                self.active -= 1


def _read(client):
    return exporter._query_date_range(SQL, "2026-01-01", "2026-03-31", 2, query_client=client)


def test_parallel_chunks_match_sequential_frame_and_count(monkeypatch):
    monkeypatch.setenv("DATASET_SNAPSHOT_QUERY_WORKERS", "1")
    sequential_client = FakeClient()
    sequential, sequential_count = _read(sequential_client)
    monkeypatch.delenv("DATASET_SNAPSHOT_QUERY_WORKERS")
    parallel_client = FakeClient()
    parallel, parallel_count = _read(parallel_client)

    assert sequential_client.peak == 1
    assert 1 < parallel_client.peak <= 4
    assert parallel_count == sequential_count == 45
    assert parallel.equals(sequential)
    assert parallel["date"].to_list() == sorted(parallel["date"].to_list())


def test_failed_chunk_still_fails_the_export():
    with pytest.raises(RuntimeError, match="d1_chunk_failed"):
        _read(FakeClient(fail_on="2026-02-10"))


def test_observation_scope_reads_sequentially():
    client = FakeClient()
    with verified_read_observation():
        frame, count = _read(client)
    assert client.peak == 1 and count == 45 and frame.height > 0
