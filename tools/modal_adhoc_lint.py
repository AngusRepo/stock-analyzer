"""Static check for one-off Modal scripts; run it before every `modal run` (AGENTS.md).

    python tools/modal_adhoc_lint.py <script.py> [...]      exit 0 = pass, 1 = findings

Rules (2026-10-30 incident: detached one-off apps crash-looped for two weeks, and
129 one-off runs reused `stockvision-ml` so billing could not tell them apart):
  app_name       modal.App name must be a literal `adhoc-<purpose>-<YYYYMMDD>`
  deployed_name  never a deployed app name (read from ml-service/modal*app*.py)
  deployed_app   never run a deployed app module's `app` (e.g. `modal_app.app.run()`)
  no_app         a `modal run` script defines its own App
  local_branch   no Modal object or decorator under `if modal.is_local()/is_remote()`
  import_work    no filesystem / subprocess / env / sys.path / `.parents[i]` work at
                 import time; keep it in `@app.local_entrypoint()` or `__main__`
Read-only AST parse: the script is never imported or executed.
"""
from __future__ import annotations

import ast
from datetime import datetime
from pathlib import Path
import re
import sys

REPO = Path(__file__).resolve().parent.parent
NAME_RE = re.compile(r'^adhoc-[a-z0-9]+(?:-[a-z0-9]+)*-(\d{8})$')
BRANCH_TESTS = {'is_local', 'is_remote'}
MODAL_DECORATORS = {'function', 'cls', 'local_entrypoint', 'asgi_app', 'wsgi_app', 'web_server',
                    'fastapi_endpoint', 'web_endpoint', 'batched', 'concurrent', 'method', 'enter', 'exit'}
PATH_IO = {'read_text', 'read_bytes', 'write_text', 'write_bytes', 'mkdir', 'exists', 'is_file', 'is_dir',
           'iterdir', 'glob', 'rglob', 'unlink', 'touch', 'rmdir', 'rename', 'stat', 'open'}
OS_IO = {'system', 'popen', 'makedirs', 'mkdir', 'remove', 'unlink', 'rmdir', 'listdir', 'scandir', 'walk',
         'chdir', 'rename', 'replace', 'symlink', 'putenv'}
ENV_MUTATORS = {'update', 'setdefault', 'pop', 'clear'}


def dotted(node: ast.AST) -> str:
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return '.'.join(reversed(parts))
    if parts:  # Path(__file__).read_bytes -> '<expr>.read_bytes'; (A/'x').read_bytes too
        parts.append('<expr>')
        return '.'.join(reversed(parts))
    return ''


def app_name_from(call: ast.Call, consts: dict[str, str]) -> str | None:
    arg = next((k.value for k in call.keywords if k.arg == 'name'), call.args[0] if call.args else None)
    if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
        return arg.value
    if isinstance(arg, ast.Name):
        return consts.get(arg.id)
    return None


def module_consts(tree: ast.Module) -> dict[str, str]:
    return {t.id: node.value.value for node in tree.body if isinstance(node, ast.Assign)
            and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)
            for t in node.targets if isinstance(t, ast.Name)}


def is_app_call(node: ast.AST, modal_names: set[str], app_names: set[str]) -> bool:
    if not isinstance(node, ast.Call):
        return False
    name = dotted(node.func)
    return name in app_names or any(name == alias + '.App' for alias in modal_names)


def deployed_apps(repo: Path = REPO) -> dict[str, str]:
    """{module stem: App name} of the deployed Modal apps in ml-service."""
    found = {}
    for path in sorted((repo / 'ml-service').glob('modal*app*.py')):
        tree = ast.parse(path.read_text(encoding='utf-8'))
        consts = module_consts(tree)
        for node in ast.walk(tree):
            if is_app_call(node, {'modal'}, set()) and (name := app_name_from(node, consts)):
                found[path.stem] = name
    return found


class Lint:
    def __init__(self, path: str, source: str, deployed: dict[str, str]):
        self.path, self.deployed, self.findings = path, deployed, []
        self.tree = ast.parse(source, filename=path)
        self.consts = module_consts(self.tree)
        self.modal_names, self.from_modal, self.deployed_aliases = set(), set(), set()
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Import):
                for a in node.names:
                    if a.name == 'modal':
                        self.modal_names.add(a.asname or 'modal')
                    elif a.name in deployed:
                        self.deployed_aliases.add(a.asname or a.name)
            elif isinstance(node, ast.ImportFrom) and node.module == 'modal':
                self.from_modal |= {a.asname or a.name for a in node.names}
            elif isinstance(node, ast.ImportFrom) and node.module in deployed:
                if any(a.name == 'app' for a in node.names):
                    self.add(node, 'deployed_app', f'imports the deployed `{deployed[node.module]}` app; '
                             'define an adhoc-<purpose>-<YYYYMMDD> App instead')

    def add(self, node: ast.AST, rule: str, message: str):
        self.findings.append((getattr(node, 'lineno', 0), rule, message))

    def modal_call(self, node: ast.AST) -> bool:
        if not isinstance(node, ast.Call):
            return False
        name = dotted(node.func)
        root = name.split('.', 1)[0]
        return ((root in self.modal_names and name.rsplit('.', 1)[-1] not in BRANCH_TESTS)
                or (root in self.from_modal and root not in BRANCH_TESTS))

    def branch_test(self, test: ast.AST) -> bool:
        return any(isinstance(n, ast.Call) and dotted(n.func).rsplit('.', 1)[-1] in BRANCH_TESTS
                   and dotted(n.func).split('.', 1)[0] in self.modal_names | self.from_modal
                   for n in ast.walk(test))

    def modal_decorated(self, node: ast.AST) -> bool:
        return isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and any(
            dotted(d.func if isinstance(d, ast.Call) else d).rsplit('.', 1)[-1] in MODAL_DECORATORS
            or self.modal_call(d) for d in node.decorator_list)

    def run(self) -> list[tuple[int, str, str]]:
        apps = [n for n in ast.walk(self.tree) if is_app_call(n, self.modal_names, self.from_modal & {'App'})]
        for call in apps:
            name = app_name_from(call, self.consts)
            if name is None:
                self.add(call, 'app_name', 'modal.App name must be a string literal adhoc-<purpose>-<YYYYMMDD>')
            elif name in self.deployed.values():
                self.add(call, 'deployed_name', f'`{name}` is a deployed app name; use adhoc-<purpose>-<YYYYMMDD>')
            elif not (m := NAME_RE.match(name)) or not valid_date(m.group(1)):
                self.add(call, 'app_name', f'`{name}` does not match adhoc-<purpose>-<YYYYMMDD>')
        for node in ast.walk(self.tree):
            if (isinstance(node, ast.Attribute) and node.attr == 'app' and isinstance(node.value, ast.Name)
                    and node.value.id in self.deployed_aliases):
                self.add(node, 'deployed_app', f'`{node.value.id}.app` runs a deployed app ephemerally; '
                         'define an adhoc-<purpose>-<YYYYMMDD> App instead')
            if isinstance(node, (ast.If, ast.IfExp)) and self.branch_test(node.test):
                branches = (node.body + node.orelse) if isinstance(node, ast.If) else [node.body, node.orelse]
                for sub in (s for b in branches for s in ast.walk(b)):
                    if self.modal_call(sub) or self.modal_decorated(sub):
                        self.add(sub, 'local_branch', 'Modal object defined under a modal.is_local()/is_remote() '
                                 'branch; local and remote must see the same definitions')
        if not apps and not any(r == 'deployed_app' for _, r, _ in self.findings):
            self.add(self.tree, 'no_app', 'no modal.App(...) found; `modal run` needs its own adhoc-* App')
        for stmt in import_time(self.tree.body):
            self.import_work(stmt)
        return sorted(set(self.findings))

    def import_work(self, stmt: ast.stmt):
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            nodes = stmt.decorator_list + stmt.args.defaults + [d for d in stmt.args.kw_defaults if d]
        else:
            nodes = stmt.decorator_list if isinstance(stmt, ast.ClassDef) else [stmt]
        for node in (n for top in nodes for n in ast.walk(top)):
            if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute) and node.value.attr == 'parents':
                self.add(node, 'import_work', 'path indexing `.parents[i]` at import fails in the container (/root)')
            if isinstance(node, ast.Assign) and any(dotted(t.value) == 'os.environ' for t in node.targets
                                                    if isinstance(t, ast.Subscript)):
                self.add(node, 'import_work', 'os.environ mutation at import time')
            if not isinstance(node, ast.Call):
                continue
            name = dotted(node.func)
            root, attr = name.split('.', 1)[0], name.rsplit('.', 1)[-1]
            if (root in {'subprocess', 'shutil'} or name == 'open'
                    or (root == 'os' and name.count('.') == 1 and attr in OS_IO)
                    or (name.startswith('os.environ.') and attr in ENV_MUTATORS)
                    or name.startswith('sys.path.')
                    or (name.count('.') and attr in PATH_IO and root not in self.modal_names)):
                self.add(node, 'import_work', f'`{name}()` at import time; move it into '
                         '@app.local_entrypoint() or `if __name__ == "__main__"`')


def import_time(body: list[ast.stmt]):
    """Statements that execute on import, minus function/class bodies and the __main__ guard."""
    for stmt in body:
        if isinstance(stmt, ast.If) and dotted(getattr(stmt.test, 'left', ast.Pass())) == '__name__':
            continue
        if isinstance(stmt, (ast.If, ast.While)):
            yield ast.Expr(stmt.test)
        elif isinstance(stmt, ast.For):
            yield ast.Expr(stmt.iter)
        elif isinstance(stmt, ast.With):
            yield from (ast.Expr(item.context_expr) for item in stmt.items)
        elif not isinstance(stmt, ast.Try):
            yield stmt
            continue
        for field in ('body', 'orelse', 'finalbody'):
            yield from import_time(getattr(stmt, field, []))
        for handler in getattr(stmt, 'handlers', []):
            yield from import_time(handler.body)


def valid_date(text: str) -> bool:
    try:
        datetime.strptime(text, '%Y%m%d')
        return True
    except ValueError:
        return False


def lint_file(path: str | Path, deployed: dict[str, str] | None = None) -> list[tuple[int, str, str]]:
    return Lint(str(path), Path(path).read_text(encoding='utf-8'),
                deployed_apps() if deployed is None else deployed).run()


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    deployed, failed = deployed_apps(), False
    for path in argv:
        for line, rule, message in lint_file(path, deployed):
            failed = True
            print(f'{path}:{line}: {rule}: {message}')
    print('modal_adhoc_lint: ' + ('FAIL' if failed else 'ok') + f' ({len(argv)} file(s))')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
