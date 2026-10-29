"""C28-21 (CD-NEW-13): every `scripts.X` the controller runtime imports must ship in the image.

.dockerignore drops ml-controller/scripts/* except an allowlist; a runtime import of a script that
is not on it only fails when that code path runs in production. Runtime = every controller .py
except tests/, scripts/ themselves and local virtualenvs. The two known violations belong to the R2 code that deletion slice D
removes (Wei 10/28: R2 does not run in prod); the test fails if a new one appears or once they go.
"""
import ast
from pathlib import Path
import warnings

CONTROLLER = Path(__file__).resolve().parents[1]
ROOT = CONTROLLER.parent
KNOWN_UNSHIPPED = {
    ('services/l4_r2_daily_shadow.py', 'l4_r2_source_refresh'),
    ('services/l4_r2_monthly.py', 'l4_r2_source_refresh'),
}


def shipped_scripts() -> set[str]:
    lines = [line.strip() for line in (ROOT / '.dockerignore').read_text(encoding='utf-8').splitlines()]
    assert 'ml-controller/scripts/*' in lines, 'scripts are no longer excluded by default; revisit this contract'
    prefix = '!ml-controller/scripts/'
    return {line[len(prefix):] for line in lines if line.startswith(prefix) and line != prefix}


def runtime_files():
    for path in sorted(CONTROLLER.rglob('*.py')):
        top = path.relative_to(CONTROLLER).parts[0]
        if top not in {'tests', 'scripts'} and not top.startswith('.'):
            yield path


def script_imports(path: Path):
    with warnings.catch_warnings():  # runtime sources' own SyntaxWarnings are not this contract's
        warnings.simplefilter('ignore', SyntaxWarning)
        tree = ast.parse(path.read_text(encoding='utf-8-sig'), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            parts = node.module.split('.')
            if parts[0] == 'scripts':
                yield from ([parts[1]] if len(parts) > 1 else [alias.name for alias in node.names])
        elif isinstance(node, ast.Import):
            for alias in node.names:
                parts = alias.name.split('.')
                if parts[0] == 'scripts' and len(parts) > 1:
                    yield parts[1]


def test_allowlisted_scripts_exist():
    for name in shipped_scripts():
        assert (CONTROLLER / 'scripts' / name).is_file(), name


def test_every_runtime_scripts_import_is_shipped_in_the_image():
    shipped = shipped_scripts()
    unshipped = {(path.relative_to(CONTROLLER).as_posix(), module)
                 for path in runtime_files() for module in script_imports(path)
                 if module + '.py' not in shipped}
    assert unshipped - KNOWN_UNSHIPPED == set(), 'add to the .dockerignore allowlist (or stop importing)'
    assert KNOWN_UNSHIPPED - unshipped == set(), 'violation removed: drop it from KNOWN_UNSHIPPED'


def test_the_scan_sees_the_shipped_imports_too():
    found = {module for path in runtime_files() for module in script_imports(path)}
    assert {'l4_distribution_refresh_job', 'l4_r2_source_refresh'} <= found
