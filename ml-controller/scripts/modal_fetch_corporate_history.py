"""One-off Modal fetch of the seven FinLab corporate-history sources (Wei go 10/30).

Its own ephemeral app (never the stockvision-ml name), CPU only, no retries, a
hard timeout. Inside Modal it only downloads the seven FinLab datasets with
the existing `stockvision-finlab` secret and returns parquet bytes with each
pre-request clock. The public TWSE ETF registry, the spec and the sealing run
locally through fetch_corporate_history_sources.seal_fetch, exactly as a local
fetch does. Nothing is written to GCS, D1 or KV.

Secret values never leave the container: SDK output and logging are silenced,
the result carries only data and env names, and any error comes back as a
type name plus a message with every FINLAB_* value scrubbed, without a
traceback.

Run from ml-controller (ephemeral app, stops when done):
  ../ml-service/.venv/bin/modal run scripts/modal_fetch_corporate_history.py --out-dir OUT_DIR
"""
from __future__ import annotations

import json
from pathlib import Path
import sys

import modal

APP_NAME = 'sv-adhoc-corp-history-fetch-20261030'
TIMEOUT_S = 900
HERE = Path(__file__).resolve()
ML_CONTROLLER = HERE.parents[1]

image = (
    modal.Image.debian_slim(python_version='3.12')
    .pip_install('finlab==2.0.13', 'pandas[pyarrow]>=2.2.0', 'polars==1.44.2')
    .add_local_file(str(ML_CONTROLLER / 'services' / 'finlab_auth.py'), remote_path='/root/services/finlab_auth.py')
    .add_local_file(str(HERE.parent / 'fetch_corporate_history_sources.py'),
                    remote_path='/root/scripts/fetch_corporate_history_sources.py')
)
app = modal.App(name=APP_NAME, image=image)
finlab_secret = modal.Secret.from_name('stockvision-finlab')

FINLAB_ENV_NAMES = ('FINLAB_API_KEY', 'FINLAB_REFRESH_TOKEN', 'FINLAB_SESSION_ID', 'FINLAB_API_TOKEN', 'FINLAB_ID_TOKEN')


def scrub(text: str, env) -> str:
    """Remove every FINLAB_* value (and long substrings of it) from a message."""
    out = str(text)
    for name, value in env.items():
        if name.startswith('FINLAB') and value and len(str(value)) >= 4:
            out = out.replace(str(value), '***')
    return out[:300]


def _fetcher():
    """The local fetch module: /root/scripts in the container, scripts/ here."""
    for path in ('/root/scripts', str(HERE.parent)):
        if path not in sys.path:
            sys.path.insert(0, path)
    import fetch_corporate_history_sources
    return fetch_corporate_history_sources


def remote_fetch(env, *, sdk_loader=None, clock=None) -> dict:
    """Body of the Modal function; returns data or a scrubbed error, never env values."""
    import contextlib
    import io
    import logging
    logging.disable(logging.CRITICAL)  # SDK loggers may hold handlers bound before redirection
    try:
        return _remote_fetch(env, sdk_loader=sdk_loader, clock=clock)
    finally:
        logging.disable(logging.NOTSET)


def _remote_fetch(env, *, sdk_loader, clock) -> dict:
    import contextlib
    import io
    present = sorted(name for name in FINLAB_ENV_NAMES if str(env.get(name) or '').strip())
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            fetcher = _fetcher()
            auth_mode, finlab_get, role_of = (sdk_loader or _real_sdk)(env, fetcher)
            result = fetcher.collect_finlab(finlab_get, role_of, **({'clock': clock} if clock else {}))
        return {'ok': True, 'auth_mode': auth_mode, 'env_names_present': present, **result}
    except BaseException as exc:  # SystemExit included: return it as data, no traceback in Modal logs
        return {'ok': False, 'env_names_present': present, 'error_type': type(exc).__name__,
                'error': scrub(exc, env)}


def _real_sdk(env, fetcher):
    """Session auth (checked first, no browser fallback) or the legacy token, as login_finlab_sdk decides."""
    import finlab
    from finlab import data
    from finlab.auth import get_id_token
    from services.finlab_auth import finlab_session_auth_available, login_finlab_sdk
    if finlab_session_auth_available(env):
        finlab.login = fetcher._refuse_login
        if not get_id_token():
            raise SystemExit('finlab_session_rejected')
        mode = 'session_env'
    else:
        mode = login_finlab_sdk(finlab.login, env=env)  # legacy token; raises when auth is absent or partial
        finlab.login = fetcher._refuse_login  # a server rejection must stop, never loop
    data.set_storage(data.CacheStorage())
    return mode, (lambda key: data.get(key, force_download=True)), data.get_role


@app.function(secrets=[finlab_secret], timeout=TIMEOUT_S, retries=0, cpu=1.0, memory=2048)
def fetch_finlab_sources() -> dict:
    import os
    return remote_fetch(dict(os.environ))


@app.local_entrypoint()
def main(out_dir: str, days: str = '', universe: str = ''):
    fetcher = _fetcher()
    out = Path(out_dir).resolve()
    days_path = Path(days).resolve() if days else out / 'days.json'
    universe_path = Path(universe).resolve() if universe else out / 'universe.json'
    fetcher.check_targets(out, days_path=days_path, universe_path=universe_path)  # before any remote call
    result = fetch_finlab_sources.remote()
    if not result.get('ok'):
        print(json.dumps({k: result.get(k) for k in ('error_type', 'error', 'env_names_present')}, ensure_ascii=False))
        raise SystemExit(1)
    report = fetcher.seal_fetch(out, result, days_path=days_path, universe_path=universe_path,
                                auth_mode='modal:' + result['auth_mode'],
                                report_extra={'modal_app': APP_NAME, 'finlab_env_names_present': result['env_names_present']})
    print(json.dumps(report, ensure_ascii=False, indent=2))
