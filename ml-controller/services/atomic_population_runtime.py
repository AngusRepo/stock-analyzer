"""Run the original TypeScript Atomic kernel in the existing CPU job, read-only."""
import json
import os
from pathlib import Path
import subprocess
import tempfile


def read_population(request):
    runner = Path(os.environ.get('ATOMIC_POPULATION_RUNNER', '/app/worker-dist/atomic-population.cjs'))
    if not runner.is_file():
        raise RuntimeError('atomic_population_runner_missing')
    # Do not retain both a giant stdout string and its parsed population.
    with tempfile.TemporaryFile(mode='w+b') as output:
        result = subprocess.run([os.environ.get('NODE_BIN', 'node'), '--max-old-space-size=2048', str(runner)],
            input=json.dumps(request).encode('utf-8'), stdout=output, stderr=subprocess.PIPE, timeout=900, check=False)
        if result.returncode:
            detail = result.stderr.decode('utf-8', errors='replace')[-1000:]
            raise RuntimeError('atomic_population_node_failed:' + detail)
        output.seek(0)
        population = json.load(output)
    if not isinstance(population, dict) or population.get('schema_version') != 'atomic-canonical-population-v1':
        raise ValueError('atomic_population_node_result_invalid')
    return population
