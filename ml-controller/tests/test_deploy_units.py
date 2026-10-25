from tools.deploy_units import ROOT, outside_inputs, touched_units


def write(root, rel, text=''):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


def test_units_follow_relative_imports_out_of_their_directory(tmp_path):
    write(tmp_path, 'worker/src/index.ts', "import a from './lib/a'\nimport('../../schemas/s.json')\n")
    write(tmp_path, 'worker/src/lib/a.ts', "export * from './b.js'\n")
    write(tmp_path, 'worker/src/lib/b.ts', "import p from '../../../ml-controller/services/p.json'\n")
    write(tmp_path, 'worker/src/lib/a.test.ts', "import t from '../../../ml-controller/tests/fixture.json'\n")
    write(tmp_path, 'frontend/src/main.tsx', "import { c } from '../../worker/src/lib/c'\n")
    write(tmp_path, 'worker/src/lib/c.ts', "import d from './d'\n")
    write(tmp_path, 'worker/src/lib/d.ts', "import s from '../../../schemas/s.json'\n")
    for rel in ('schemas/s.json', 'ml-controller/services/p.json', 'ml-controller/tests/fixture.json'):
        write(tmp_path, rel, '{}')

    assert outside_inputs('worker', tmp_path) == {'schemas/s.json', 'ml-controller/services/p.json'}
    assert outside_inputs('frontend', tmp_path) == {
        'worker/src/lib/c.ts', 'worker/src/lib/d.ts', 'schemas/s.json'}

    units = lambda *changed: touched_units(list(changed), tmp_path)
    assert units('ml-controller/services/p.json') == {'worker': True, 'pages': False}
    assert units('worker/src/lib/d.ts') == {'worker': True, 'pages': True}
    assert units('worker/src/lib/a.test.ts', 'ml-controller/tests/fixture.json') == {'worker': False, 'pages': False}
    assert units('frontend/index.html') == {'worker': False, 'pages': True}
    assert units('infra/gcp-scheduler-jobs.json') == {'worker': True, 'pages': True}


def test_repo_worker_bundles_controller_policy_files():
    assert 'ml-controller/services/paired_nav_transport_policy.json' in outside_inputs('worker', ROOT)
