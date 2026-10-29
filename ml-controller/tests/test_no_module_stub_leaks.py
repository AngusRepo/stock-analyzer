"""NEW-93: a test file must not leave a stub module in sys.modules for the tests collected after it.

A module-level `sys.modules[name] = stub` or `sys.modules.setdefault(name, stub)` stays for the
whole xdist worker, so later test files (and anything they import) silently get the stub; which
files fail then depends on how the shard happens to order collection. Allowed at module level:
inside `except ImportError` (the real package is absent, nothing to shadow) or registering a
module the file itself loaded by path (spec.name / SPEC.name). In a test, use monkeypatch.setitem.
"""
import ast
from pathlib import Path
import warnings

TESTS = Path(__file__).resolve().parent


def _stub_target(node):
    """The sys.modules key a statement writes, or None."""
    call = node.value if isinstance(node, (ast.Expr, ast.Assign)) else None
    if isinstance(node, ast.Assign):
        for target in node.targets:
            if (isinstance(target, ast.Subscript) and ast.unparse(target.value) == 'sys.modules'):
                return ast.unparse(target.slice)
    if isinstance(call, ast.Call) and ast.unparse(call.func) in ('sys.modules.setdefault', 'sys.modules.update'):
        return ast.unparse(call.args[0]) if call.args else '<update>'
    return None


def leaks(tree):
    found = []

    def walk(nodes, guarded):
        for node in nodes:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            if isinstance(node, ast.Try):
                walk(node.body + node.orelse + node.finalbody, guarded)
                for handler in node.handlers:
                    names = ast.unparse(handler.type) if handler.type else ''
                    walk(handler.body, guarded or 'ImportError' in names or 'ModuleNotFoundError' in names)
                continue
            if isinstance(node, (ast.If, ast.With, ast.For)):
                walk(node.body + getattr(node, 'orelse', []), guarded)
                continue
            target = _stub_target(node)
            if target and not guarded and not target.endswith('.name'):
                found.append((node.lineno, target))
    walk(tree.body, False)
    return found


def test_no_test_file_leaks_a_module_stub_at_import_time():
    offenders = {}
    for path in sorted(TESTS.glob('test_*.py')):
        source = path.read_text(encoding='utf-8-sig')
        if 'sys.modules' not in source:
            continue
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', SyntaxWarning)
            tree = ast.parse(source, filename=str(path))
        if found := leaks(tree):
            offenders[path.name] = found
    assert offenders == {}


def test_the_scan_flags_the_leaking_forms_and_spares_the_guarded_ones():
    flagged = leaks(ast.parse(
        'import sys\n'
        'sys.modules.setdefault("httpx", stub)\n'
        'if "httpx" not in sys.modules:\n    sys.modules["httpx"] = stub\n'
        'try:\n    import x\nexcept ImportError:\n    sys.modules["x"] = stub\n'
        'sys.modules[spec.name] = module\n'
        'def test_inside():\n    sys.modules["y"] = stub\n'))
    assert flagged == [(2, "'httpx'"), (4, "'httpx'")]
