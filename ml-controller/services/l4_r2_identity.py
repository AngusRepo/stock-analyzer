"""Economic implementation identity; line endings alone do not change policy."""
import hashlib
from pathlib import Path
from services.l4_distribution import digest


def implementation_identity():
    root=Path(__file__).resolve().parents[1]
    names=('l4_r2_identity','l4_r2_shadow','l4_r2_daily_shadow','l4_r2_forward_evaluation',
        'l4_r2_allocation','l4_r2_paired','l4_r2_sources','l4_forward_training',
        'l4_forward_materialization','l4_native_observation','l4_instrument_classification',
        'l4_distribution','l4_distribution_runtime','l4_portfolio','l4_quadratic_refinement')
    paths=[root/'services'/(n+'.py') for n in names]+[root/'graphs/daily_pipeline_v2.py']
    sources={p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes().replace(b'\r\n',b'\n')).hexdigest() for p in paths}
    return dict(checksum=digest(sources),sources=sources)
