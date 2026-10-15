"""Run the original TypeScript Atomic kernel in the existing CPU job, read-only."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import logging


def read_population(request):
    runner = Path(os.environ.get('ATOMIC_POPULATION_RUNNER', '/app/worker-dist/atomic-population.cjs'))
    if not runner.is_file():
        raise RuntimeError('atomic_population_runner_missing')
    from services.atomic_replay_checkpoints import AtomicReplayCheckpoints
    bucket = None
    if os.environ.get('GCS_BUCKET_NAME'):
        from google.cloud import storage
        bucket = storage.Client().bucket(os.environ['GCS_BUCKET_NAME'])
    # Do not retain both a giant stdout string and its parsed population.
    with tempfile.TemporaryDirectory(prefix='atomic-replay-') as directory, \
            AtomicReplayCheckpoints(directory, runner, request, bucket), \
            tempfile.TemporaryFile(mode='w+b') as output:
        for attempt in range(2):
            output.seek(0)
            output.truncate()
            try:
                result = subprocess.run([os.environ.get('NODE_BIN', 'node'), '--max-old-space-size=2048', str(runner)],
                    input=json.dumps(request).encode('utf-8'), stdout=output, stderr=subprocess.PIPE,
                    env={**os.environ, 'ATOMIC_CHECKPOINT_DIR': directory}, timeout=1800, check=False)
                break
            except subprocess.TimeoutExpired:
                if attempt:
                    raise
                logging.getLogger(__name__).warning('Atomic replay timed out; resuming verified checkpoints once')
        if result.returncode:
            detail = result.stderr.decode('utf-8', errors='replace')[-1000:]
            raise RuntimeError('atomic_population_node_failed:' + detail)
        output.seek(0)
        population = json.load(output)
    if not isinstance(population, dict) or population.get('schema_version') != 'atomic-canonical-population-v1':
        raise ValueError('atomic_population_node_result_invalid')
    return population
