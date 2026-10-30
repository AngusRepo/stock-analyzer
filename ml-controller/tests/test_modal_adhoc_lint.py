import importlib.util
from pathlib import Path
import textwrap

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('modal_adhoc_lint', ROOT / 'tools/modal_adhoc_lint.py')
lint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lint)

DEPLOYED = {'modal_app': 'stockvision-ml', 'modal_strategy_mining_app': 'stockvision-strategy-mining'}

GOOD = '''
"""One-off holding inspection."""
import json
import os
from pathlib import Path

import modal

APP_NAME = "adhoc-holding-inspect-20261030"
image = modal.Image.debian_slim().pip_install("polars").add_local_dir(Path(__file__).parent / "src", "/root/src")
app = modal.App(APP_NAME, image=image, secrets=[modal.Secret.from_name("stockvision-cf")])
TOKEN_ENV = os.environ.get("X")


@app.function(timeout=600)
def inspect(payload):
    root = Path("/root")
    return {"ok": (root / "src").exists(), "rows": json.loads((root / "x.json").read_text())}


@app.local_entrypoint()
def main():
    import subprocess
    here = Path(__file__).resolve().parents[1]
    subprocess.check_output(["git", "-C", str(here), "status"])
    print(inspect.remote({}))


if __name__ == "__main__":
    print(open(__file__).read()[:10])
'''


def run(source, tmp_path):
    path = tmp_path / 'script.py'
    path.write_text(textwrap.dedent(source), encoding='utf-8')
    return lint.lint_file(path, DEPLOYED)


def rules(source, tmp_path):
    return sorted({rule for _, rule, _ in run(source, tmp_path)})


def test_good_one_off_script_passes(tmp_path):
    assert run(GOOD, tmp_path) == []


def test_oct13_repair_script_shape_fails_every_rule(tmp_path):
    source = '''
    import json, os, subprocess, sys
    from pathlib import Path
    import modal

    app = modal.App('stockvision-ml')
    if modal.is_local():
        A = Path(__file__).resolve().parent
        ROOT = A.parents[1]
        R = json.loads((A/'release-inputs.json').read_bytes())
        assert subprocess.check_output(['git','status']).strip() == b''
        os.environ.update(STOCKVISION_SOURCE_SHA=R['commit'])
        sys.path.insert(0, str(ROOT/'ml-service'))
        import modal_app as original
        app = modal.App('stockvision-ml', image=original.image)

    @app.function(serialized=True)
    def compose_only(payload):
        return payload
    '''
    findings = run(source, tmp_path)
    assert {rule for _, rule, _ in findings} == {'deployed_name', 'local_branch', 'import_work'}
    assert [line for line, rule, _ in findings if rule == 'deployed_name'] == [6, 15]
    assert any('.parents[i]' in message for _, _, message in findings)


@pytest.mark.parametrize('name', ['adhoc-repair-2026103', 'adhoc-repair-20261332', 'adhoc-Repair-20261030',
                                  'repair-20261030', 'adhoc-20261030', 'adhoc-repair_x-20261030'])
def test_app_name_pattern(tmp_path, name):
    assert rules(f'import modal\napp = modal.App("{name}")\n', tmp_path) == ['app_name']


def test_non_literal_and_deployed_names(tmp_path):
    assert rules('import modal\nimport os\napp = modal.App(os.environ["N"])\n', tmp_path) == ['app_name']
    assert rules('from modal import App\napp = App(name="stockvision-strategy-mining")\n', tmp_path) == ['deployed_name']


def test_running_a_deployed_app_module_fails(tmp_path):
    source = '''
    import modal_app

    def main():
        with modal_app.app.run():
            modal_app.train.remote({})
    '''
    assert rules(source, tmp_path) == ['deployed_app']
    assert rules('from modal_app import app\n', tmp_path) == ['deployed_app']


def test_missing_app_and_remote_branch(tmp_path):
    assert rules('import modal\nf = modal.Function.from_name("stockvision-ml", "x")\n', tmp_path) == ['no_app']
    source = '''
    import modal
    app = modal.App("adhoc-x-20261030")
    if not modal.is_remote():
        @app.function()
        def f():
            pass
    image = modal.Image.debian_slim() if modal.is_local() else None
    '''
    assert rules(source, tmp_path) == ['local_branch']


def test_cli_exit_codes(tmp_path, capsys):
    good, bad = tmp_path / 'good.py', tmp_path / 'bad.py'
    good.write_text(GOOD, encoding='utf-8')
    bad.write_text('import modal\napp = modal.App("stockvision-ml")\n', encoding='utf-8')
    assert lint.main([str(good)]) == 0
    assert lint.main([str(good), str(bad)]) == 1
    assert 'deployed_name' in capsys.readouterr().out


def test_deployed_names_come_from_the_repo():
    assert lint.deployed_apps()['modal_app'] == 'stockvision-ml'
    assert {'stockvision-ml', 'stockvision-strategy-mining', 'quantaalpha-poc'} <= set(lint.deployed_apps().values())
