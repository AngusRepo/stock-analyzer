"""CI-NEW-32: controller tests must import their siblings by module name, never as `tests.X`.

ci/run_suite.sh puts ml-service on PYTHONPATH, and ml-service/tests is a regular package while
ml-controller/tests is not, so `tests` resolves to ml-service/tests and `from tests.test_x import`
fails at collection (a1d442b6 fixed the one in test_same_plan_paper_comparison). Pytest already puts
ml-controller/tests on sys.path, so `from test_x import ...` is the form that works.
"""
import ast
from pathlib import Path
import warnings

TESTS = Path(__file__).resolve().parent


def package_import_lines(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            if node.module == 'tests' or node.module.startswith('tests.'):
                yield node.lineno
        elif isinstance(node, ast.Import):
            if any(a.name == 'tests' or a.name.startswith('tests.') for a in node.names):
                yield node.lineno


def test_controller_tests_never_import_the_tests_package():
    offenders = {}
    for path in sorted(TESTS.rglob('*.py')):
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', SyntaxWarning)
            tree = ast.parse(path.read_text(encoding='utf-8-sig'), filename=str(path))
        if lines := list(package_import_lines(tree)):
            offenders[path.relative_to(TESTS).as_posix()] = lines
    assert offenders == {}


def test_the_scan_catches_both_import_forms():
    tree = ast.parse('from tests.test_a import x\nimport tests.test_b\nfrom test_c import y\nfrom .tests import z\n')
    assert list(package_import_lines(tree)) == [1, 2]
