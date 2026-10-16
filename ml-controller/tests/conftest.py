import pytest


@pytest.fixture(autouse=True)
def isolated_slate_artifacts(tmp_path):
    """New slate I/O is local in tests, including graph integration fixtures."""
    from services.pipeline_slate_artifacts import local_store
    with local_store(tmp_path / 'slates'):
        yield
