"""Build-input ordering, not a claim that a Docker image was built or deployed."""
from pathlib import Path


def test_both_nav_shared_sources_exist_before_worker_compilation():
    root = Path(__file__).parents[2]
    dockerfile = (root / 'Dockerfile').read_text(encoding='utf-8')
    compile_at = dockerfile.index('RUN cd /app/worker && npx tsc')
    for name in ('paired_nav_review_policy.json', 'opb_nav_serving_source.json', 'paired_nav_transport_policy.json'):
        source = 'ml-controller/services/' + name
        assert (root / source).is_file()
        assert dockerfile.index(f'COPY {source} /app/{source}') < compile_at
    assert "require('/app/worker-dist/src/lib/opbNavPublication.js')" in dockerfile
    assert dockerfile.index('COPY ml-controller/ /app/') > compile_at
