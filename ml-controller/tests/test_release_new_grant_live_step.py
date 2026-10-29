"""TOOL-PK: a source-only new grant continues from the live L4 policy step (S or Pk).

Runs release_admission.new_grant and activate_l4_policy prepare-change locally; KV, gcloud and the
controller configuration reader are fakes. No cloud call is made.
"""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import types

import pytest

ROOT = Path(__file__).resolve().parents[2]
for entry in (str(ROOT / 'tools'), str(ROOT / 'tools' / 'release')):
    if entry not in sys.path:
        sys.path.insert(0, entry)

import release_admission as admission  # noqa: E402
import runtime_context  # noqa: E402
import services  # noqa: E402
from services import active8_nav_adoption, active8_paper_admission  # noqa: E402
from services.active8_paper_admission import runtime_configuration_identity  # noqa: E402
from services.paired_nav_journal import digest  # noqa: E402

S_KEY = admission.GRANT_PREFIX + 'r31-20261031'
P_KEYS = [S_KEY + '-p1', S_KEY + '-p2']
NEW_KEY = admission.GRANT_PREFIX + 'w-rel-20261101'
ADMISSION = {'approved_at': '2026-10-12T12:00:00Z', 'configuration': {'pinned': 'admission'}}
PIPELINE = ('m1.py', 'm2.py', 'm3.py')
# The live release's reviewed chain (its strategy_nav_source_release.json policy_activations).
LIVE_ACTIVATIONS = [{'schema_version': 'l4-policy-constraints-change-v1', 'scope': 'paper',
                     'next_policy_checksum': str(step) * 64, 'source_reference': 'r31 P' + str(step)} for step in (1, 2)]
OLD_SOURCES = {'allocator_source_identity': {'a.py': '1' * 64}, 'l3_inference_source_identity': {'b.py': '2' * 64}}
NEW_SOURCES = {'allocator_source_identity': {'a.py': '3' * 64}, 'l3_inference_source_identity': {'b.py': '2' * 64}}
FIXED_NOW = datetime(2026, 10, 28, 9, 0, tzinfo=timezone.utc)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def seal(value):
    value['approval_checksum'] = digest({k: v for k, v in value.items() if k != 'approval_checksum'})
    return value


def configuration(policy, sources, owner):
    return {'trading_config': {'l4Distribution': {'policy': policy}, 'fees': {'commission': .001425}},
            'risk_config': {'position': {'maxSingleNamePct': .25}}, **deepcopy(sources),
            'native_execution_policy': {'execution_owner_version': owner,
                'variables': {'LIVE_EXECUTION_CLIENT_ENABLED': '0'}, 'frozen_kv': {}}}


def live_grants(owner):
    """The live release: S and its staged P1, P2 (each the S grant with the next configuration)."""
    source = seal({'schema_version': 'active8-paper-runtime-approval-v1', 'admission': ADMISSION, 'scope': 'paper',
        'approved': True, 'maturity_transfer': False, 'efficacy_status': 'unproven', 'source_reference': 'S',
        'approved_at': '2026-10-27T12:00:00Z', 'configuration': configuration('S', OLD_SOURCES, owner)})
    grants = [source]
    for step in (1, 2):
        grant = deepcopy(source)
        grant['configuration']['trading_config']['l4Distribution'] = {'policy': 'P' + str(step)}
        grant['approved_l4_execution_policy_change'] = {'activation_checksums': [digest(a) for a in LIVE_ACTIVATIONS[:step]]}
        grants.append(seal(grant))
    return grants


class Release:
    """A git source whose live commit pins S (and optionally P1/P2), and HEAD changes one native input."""

    def __init__(self, tmp_path, monkeypatch, *, policy_keys=True, live_activations=LIVE_ACTIVATIONS):
        self.repo, self.monkeypatch = tmp_path / 'repo', monkeypatch
        self.repo.mkdir()
        for args in (('init', '-q'), ('config', 'user.email', 't@t'), ('config', 'user.name', 't'),
                     ('config', 'core.autocrlf', 'false')):
            git(self.repo, *args)
        files = {'ml-controller/services/native_paper_sandbox.py': b'host = 1\n',
                 'ml-controller/routers/intraday.py': b'rescore = 1\n',
                 **{'ml-controller/services/' + name: b'x = 1\n' for name in PIPELINE}}
        self.prior_bundle, self.bundle = b'old bundle', b'new bundle'
        old_parts = {'bundle': sha(self.prior_bundle),
                     'pipeline': {name: sha(files['ml-controller/services/' + name]) for name in PIPELINE},
                     'private_host': sha(files['ml-controller/services/native_paper_sandbox.py']),
                     'rescore': sha(files['ml-controller/routers/intraday.py'])}
        self.old_owner = 'native-paper-v1:' + digest(old_parts)
        behavior = {'schema_version': 'native-paper-behavior-release-v1', 'execution_owner_version': self.old_owner,
                    'scope': 'paper', 'runtime_admission': S_KEY}
        if policy_keys:
            behavior['policy_runtime_admissions'] = P_KEYS
        files[admission.MANIFEST_PATHS[0]] = (json.dumps(behavior, indent=2) + '\n').encode()
        files[admission.MANIFEST_PATHS[1]] = (json.dumps({'approved_sources': {}, **(
            {'policy_activations': live_activations} if policy_keys and live_activations else {})}, indent=2) + '\n').encode()
        for path, raw in files.items():
            (self.repo / path).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / path).write_bytes(raw)
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-qm', 'live')
        self.live = git(self.repo, 'rev-parse', 'HEAD')
        (self.repo / 'ml-controller/services/m2.py').write_bytes(b'x = 2\n')
        # HEAD's release manifest differs from the live one: the live chain is read at expected_live.
        (self.repo / admission.MANIFEST_PATHS[1]).write_bytes(b'{"approved_sources": {}}\n')
        git(self.repo, 'commit', '-qam', 'release')
        (tmp_path / 'native-paper.cjs').write_bytes(self.bundle)
        self.bundle_path = tmp_path / 'native-paper.cjs'
        self.parts = {**deepcopy(old_parts), 'bundle': sha(self.bundle)}
        self.parts['pipeline']['m2.py'] = sha(b'x = 2\n')
        self.owner = 'native-paper-v1:' + digest(self.parts)
        self.grants = live_grants(self.old_owner)
        self.kv = {S_KEY: self.grants[0], **({key: g for key, g in zip(P_KEYS, self.grants[1:])} if policy_keys else {})}
        self.reads, self.validated = [], []
        self.current = None
        self.out = tmp_path / 'admission'

    def at(self, policy):
        self.current = configuration(policy, NEW_SOURCES, self.owner)
        return self

    def kv_get(self, key):
        self.reads.append(key)
        if key in self.kv:
            value = self.kv[key]
            return value if isinstance(value, dict) and 'http_status' in value else {'http_status': 200, 'body': deepcopy(value)}
        return {'http_status': 404, 'body': None}

    def run(self, module=admission, policy_chain=None):
        native = types.ModuleType('services.native_paper_sandbox')
        native.digest = digest
        native.native_execution_identity = lambda: 'native-paper-v1:' + native.digest(deepcopy(self.parts))
        patch = self.monkeypatch
        patch.setitem(sys.modules, 'services.native_paper_sandbox', native)
        patch.setattr(services, 'native_paper_sandbox', native, raising=False)
        patch.setattr(sys, 'path', list(sys.path))
        patch.setenv('NATIVE_PAPER_RUNNER', '')
        patch.delenv('GITHUB_ACTIONS', raising=False)
        patch.setattr(runtime_context, 'kv_get', self.kv_get)
        patch.setattr(active8_nav_adoption, 'current_execution_configuration', lambda: deepcopy(self.current))
        patch.setattr(active8_paper_admission, 'validate_runtime_approval',
                      lambda grant, adm, now=None: self.validated.append((grant, adm)))
        baseline = {'source_sha': self.live, 'image': 'img@sha256:' + 'a' * 64, 'service_spec_sha256': 'b' * 64,
                    'jobs': {}, 'paper': {'source_receipt_checksum': 'c' * 64}}
        patch.setattr(module, 'runtime_baseline', lambda source, expected: deepcopy(baseline))
        patch.setattr(module, 'datetime', type('FixedClock', (datetime,), {'now': staticmethod(lambda tz=None: FIXED_NOW)}))
        return module.new_grant(self.repo, self.out, self.live, prior_bundle=self.prior_bundle,
            prior_components={'current': {'bundle': sha(self.prior_bundle)}}, new_bundle=self.bundle_path,
            release_id='w-rel-20261101', authorization='Wei go (test fixture)', review='review.md',
            policy_chain=policy_chain)

    def output(self, name):
        return json.loads((self.out / name).read_text(encoding='utf-8'))

    def manifests(self):
        services_dir = self.repo / 'ml-controller/services'
        return [json.loads((services_dir / name).read_text(encoding='utf-8')) for name in admission.MANIFESTS]


def expected_manifest(prior, current):
    """The release manifest exactly as the pre-TOOL-PK new_grant builds it from `prior`."""
    manifest = dict(schema_version='strategy-nav-source-release-v1', scope='paper', source_equivalence=False,
        maturity_transfer=False, production_baseline_verified=True, production_baseline_source=None,
        production_baseline_receipt_checksum='c' * 64, prior_approval_checksum=prior['approval_checksum'],
        prior_configuration_checksum=digest(runtime_configuration_identity(prior['configuration'])),
        approved_sources={k: current[k] for k in admission.SOURCE_ONLY_SECTIONS}, execution_owner_version=None,
        review='review.md')
    return manifest


@pytest.mark.parametrize('staged_policy_keys', [False, True])
def test_new_grant_in_the_source_state_keeps_s_as_prior(tmp_path, monkeypatch, staged_policy_keys):
    release = Release(tmp_path, monkeypatch, policy_keys=staged_policy_keys).at('S')
    receipt = release.run()
    source = release.grants[0]
    grant, behavior, manifest = release.output('source-grant.json'), *release.manifests()
    assert receipt['prior_key'] == S_KEY and receipt['live_step'] == 0 and receipt['new_key'] == NEW_KEY
    assert receipt['prior_approval_checksum'] == source['approval_checksum']
    assert grant['prior_runtime_approval'] == source and grant['configuration'] == release.current
    assert {k: grant[k] for k in ('schema_version', 'admission', 'scope', 'approved', 'maturity_transfer',
            'efficacy_status', 'source_reference', 'approved_at')} == {
        'schema_version': source['schema_version'], 'admission': ADMISSION, 'scope': 'paper', 'approved': True,
        'maturity_transfer': False, 'efficacy_status': 'unproven', 'source_reference': 'Wei go (test fixture)',
        'approved_at': FIXED_NOW.isoformat()}
    assert grant['approval_checksum'] == digest({k: v for k, v in grant.items() if k != 'approval_checksum'})
    assert grant['approved_strategy_nav_source_change'] == {'release_manifest_checksum': digest(manifest)}
    expected = expected_manifest(source, release.current)
    expected.update(production_baseline_source=release.live, execution_owner_version=release.owner)
    assert manifest == expected
    assert behavior['runtime_admission'] == NEW_KEY and behavior['execution_owner_version'] == release.owner
    assert 'policy_runtime_admissions' not in behavior and 'policy_activations' not in manifest
    delta = release.output('identity-delta.json')
    assert delta['live_step'] == 0 and delta['prior_key'] == S_KEY
    assert delta['allocator_and_l3']['allocator_source_identity'] == {'a.py': {'previous': '1' * 64, 'approved': '3' * 64}}
    assert delta['previous_native_owner'] == release.old_owner and delta['new_native_owner'] == release.owner
    assert release.validated == [(grant, ADMISSION)]
    live = [S_KEY, *P_KEYS] if staged_policy_keys else [S_KEY]
    # Each live grant read once, then the new key; the drift recheck reads them all again.
    assert release.reads == [*live, NEW_KEY, *live, NEW_KEY]


def test_new_grant_continues_from_the_activated_policy_step(tmp_path, monkeypatch):
    release = Release(tmp_path, monkeypatch).at('P2')
    receipt = release.run()
    p2 = release.grants[2]
    grant, behavior, manifest = release.output('source-grant.json'), *release.manifests()
    assert receipt['prior_key'] == P_KEYS[1] and receipt['live_step'] == 2
    assert receipt['prior_approval_checksum'] == p2['approval_checksum']
    assert grant['prior_runtime_approval'] == p2 and grant['admission'] == p2['admission']
    assert grant['configuration']['trading_config']['l4Distribution'] == {'policy': 'P2'}
    assert 'approved_l4_execution_policy_change' not in grant
    assert manifest['prior_approval_checksum'] == p2['approval_checksum']
    assert manifest['prior_configuration_checksum'] == digest(runtime_configuration_identity(p2['configuration']))
    # The r31 P1/P2 grants are bound to the r31 manifest: the new release must not name them.
    assert 'policy_runtime_admissions' not in behavior and behavior['runtime_admission'] == NEW_KEY
    delta = release.output('identity-delta.json')
    assert delta['live_step'] == 2 and delta['prior_key'] == P_KEYS[1]
    assert release.reads == [S_KEY, *P_KEYS, NEW_KEY, S_KEY, *P_KEYS, NEW_KEY]


@pytest.mark.parametrize('case,error', [
    ('drift', 'live_step_unmatched'),            # KV holds a configuration no live grant pins
    ('drift_without_policy_keys', 'live_step_unmatched'),
    ('unstaged', 'live_step_unmatched'),         # KV at P2 but the P2 grant was never staged
    ('ambiguous', 'live_step_ambiguous:1,2'),    # two live grants pin the same configuration
    ('unreadable', 'live_policy_grant_unreadable:' + P_KEYS[0]),
    ('source_missing', 'live_paper_grant_missing'),
    ('source_invalid', 'live_paper_grant_invalid'),
])
def test_new_grant_fails_closed_without_exactly_one_live_step(tmp_path, monkeypatch, case, error):
    release = Release(tmp_path, monkeypatch, policy_keys=case != 'drift_without_policy_keys')
    release.at('X' if case.startswith('drift') else 'S' if case.startswith('source') else 'P2')
    if case == 'unstaged':
        del release.kv[P_KEYS[1]]
    elif case == 'ambiguous':
        p1 = release.kv[P_KEYS[0]]
        p1['configuration']['trading_config']['l4Distribution'] = {'policy': 'P2'}
        seal(p1)
    elif case == 'unreadable':
        release.kv[P_KEYS[0]] = {'http_status': 500, 'body': None}
    elif case == 'source_missing':
        del release.kv[S_KEY]
    elif case == 'source_invalid':
        release.kv[S_KEY]['efficacy_status'] = 'proven'
        seal(release.kv[S_KEY])
    before = [(release.repo / 'ml-controller/services' / name).read_bytes() for name in admission.MANIFESTS]
    with pytest.raises(RuntimeError, match='^' + error + '$'):
        release.run()
    assert not release.out.exists() and NEW_KEY not in release.reads
    assert [(release.repo / 'ml-controller/services' / name).read_bytes() for name in admission.MANIFESTS] == before


@pytest.mark.parametrize('live,continued,policy,ok', [
    ('P2', 2, 'P2', True),     # chain continued from the live step
    ('S', None, 'S', True),    # a chain prepared from S at k=0
    ('P2', 1, 'P2', False),    # --step names another step than the live one
    ('P2', None, 'P2', False),  # a fresh chain while P2 is live
    ('S', 1, 'S', False),      # a continued chain while S is live
    ('P2', 2, 'P1', False),    # first packet does not start from the live policy
])
def test_new_grant_binds_the_release_chain_to_the_live_step(tmp_path, monkeypatch, live, continued, policy, ok):
    release = Release(tmp_path, monkeypatch).at(live)
    packet = {'activation': {'schema_version': 'l4-policy-constraints-change-v1',
                             'previous_policy_checksum': digest({'policy': policy})},
              'rollback_risk_config': deepcopy(release.current['risk_config'])}
    if continued:
        packet['continued_from'] = {'step': continued, 'activation_checksum': digest(LIVE_ACTIVATIONS[continued - 1])}
    (tmp_path / 'policy-chain.json').write_text(json.dumps([packet]), encoding='utf-8')
    if not ok:
        with pytest.raises(RuntimeError, match='^policy_chain_does_not_start_at_live_step$'):
            release.run(policy_chain=tmp_path / 'policy-chain.json')
        assert not release.out.exists()
        return
    receipt = release.run(policy_chain=tmp_path / 'policy-chain.json')
    behavior, manifest = release.manifests()
    assert receipt['policy_keys'] == [NEW_KEY + '-p1'] and receipt['live_step'] == (2 if live == 'P2' else 0)
    assert behavior['policy_runtime_admissions'] == [NEW_KEY + '-p1']
    assert manifest['policy_activations'] == [packet['activation']]


@pytest.mark.parametrize('start', ['live_chain', 'other_chain', 'no_checksum', 'live_chain_short', 'no_live_chain'])
def test_continued_chain_must_start_from_the_live_release_chain(tmp_path, monkeypatch, start):
    live_activations = {'live_chain_short': LIVE_ACTIVATIONS[:1], 'no_live_chain': []}.get(start, LIVE_ACTIVATIONS)
    release = Release(tmp_path, monkeypatch, live_activations=live_activations).at('P2')
    # Another chain whose step 2 reaches the same l4 / risk but through a different reviewed activation.
    other = {**LIVE_ACTIVATIONS[1], 'source_reference': 'another chain, same P2 policy'}
    continued = {'step': 2, 'activation_checksum': digest(LIVE_ACTIVATIONS[1] if start == 'live_chain' else other)}
    if start == 'no_checksum':
        del continued['activation_checksum']
    packet = {'activation': {'schema_version': 'l4-policy-constraints-change-v1',
                             'previous_policy_checksum': digest({'policy': 'P2'})},
              'rollback_risk_config': deepcopy(release.current['risk_config']), 'continued_from': continued}
    (tmp_path / 'policy-chain.json').write_text(json.dumps([packet]), encoding='utf-8')
    before = [(release.repo / 'ml-controller/services' / name).read_bytes() for name in admission.MANIFESTS]
    if start != 'live_chain':
        with pytest.raises(RuntimeError, match='^policy_chain_not_continued_from_live_release_chain$'):
            release.run(policy_chain=tmp_path / 'policy-chain.json')
        assert not release.out.exists()
        assert [(release.repo / 'ml-controller/services' / name).read_bytes() for name in admission.MANIFESTS] == before
        return
    receipt = release.run(policy_chain=tmp_path / 'policy-chain.json')
    assert receipt['live_step'] == 2 and receipt['prior_key'] == P_KEYS[1]
    assert release.manifests()[1]['policy_activations'] == [packet['activation']]


def test_live_step_match_ignores_only_the_source_only_fields():
    owner = 'native-paper-v1:' + '0' * 64
    grants = live_grants(owner)
    reads = {key: {'http_status': 200, 'body': g} for key, g in zip([S_KEY, *P_KEYS], grants)}
    after = runtime_configuration_identity(configuration('P1', NEW_SOURCES, 'native-paper-v1:' + '9' * 64))
    assert admission.match_live_step([S_KEY, *P_KEYS], reads, after, runtime_configuration_identity, digest) == 1
    after['risk_config']['position']['maxSingleNamePct'] = .3
    with pytest.raises(RuntimeError, match='live_step_unmatched'):
        admission.match_live_step([S_KEY, *P_KEYS], reads, after, runtime_configuration_identity, digest)


# --- activate_l4_policy prepare-change --continue-from -------------------------------------------

def old_chain():
    """The live release's chain: P1 = v1 -> v2 owner move, P2 = a constraints change."""
    from services.active_model_policy import gnn_return_history_lookback
    from services.l4_release_packet import prepare_policy_change_packet, prepare_policy_v2_packet
    from test_strategy_nav_runtime_approval import RISK_DEFAULTS, V1_POLICY
    raw = {'l4Distribution': deepcopy(V1_POLICY), 'position': {'maxPctOfPortfolio': .25, 'maxPositions': 5},
           'circuit': {'maxPositionPct': .08, 'highVolReducedPosPct': .04}, 'fees': {'commission': .001425}}
    risk = {'system': {'killSwitch': False}, 'portfolio': {'dailyPnlLossLimitPct': -.03},
            'position': {'maxSingleNamePct': .25}, 'order': {}}
    first = prepare_policy_v2_packet(raw_config=raw, merged_config=deepcopy(raw), risk_config=risk,
        risk_defaults=RISK_DEFAULTS, lookback=gnn_return_history_lookback(), cost_objective='single_side_v1',
        engineering_receipt={'receipt': 'p1'}, source_reference='test-only r31 P1')
    second = prepare_policy_change_packet(first, changes={'cost_objective': 'entry_round_trip_v1'},
        engineering_receipt={'receipt': 'p2'}, source_reference='test-only r31 P2')
    return [first, second]


def activate(monkeypatch, tmp_path, *args):
    import activate_l4_policy
    fake = types.ModuleType('runtime_context')
    fake.load_environment = lambda: {'source_sha': 'e' * 40}
    for name in ('kv_get', 'request', 'worker', 'gc'):
        setattr(fake, name, lambda *a, **kw: pytest.fail('prepare-change must not call ' + name))
    monkeypatch.setitem(sys.modules, 'runtime_context', fake)
    monkeypatch.setattr(sys, 'path', list(sys.path))
    monkeypatch.setenv('CLOUDSDK_PYTHON', sys.executable)
    (tmp_path / 'receipt.json').write_text('{"receipt": "w-rel"}', encoding='utf-8')
    monkeypatch.setattr(sys, 'argv', ['activate_l4_policy.py', *args, '--workspace-root', str(tmp_path),
        '--engineering-receipt', str(tmp_path / 'receipt.json'), '--source-reference', 'test-only W-REL'])
    activate_l4_policy.main()


@pytest.mark.parametrize('step,change', [(1, 'entry_round_trip_v1'), (2, 'single_side_v1')])
def test_prepare_change_continues_a_new_chain_from_the_live_step(tmp_path, monkeypatch, step, change):
    from services.l4_policy_activation import chain_states
    chain = old_chain()
    (tmp_path / 'r31-chain.json').write_text(json.dumps(chain), encoding='utf-8')
    out = tmp_path / 'w-rel'
    activate(monkeypatch, tmp_path, 'prepare-change', '--out', str(out), '--continue-from',
             str(tmp_path / 'r31-chain.json'), '--step', str(step), '--set', 'cost_objective="' + change + '"')
    new = json.loads((out / 'policy-chain.json').read_text(encoding='utf-8'))
    pk = chain[step - 1]
    assert len(new) == 1
    assert new[0]['rollback_config'] == pk['next_config'] and new[0]['rollback_risk_config'] == pk['next_risk_config']
    assert new[0]['activation']['previous_policy_checksum'] == digest(pk['next_merged_config']['l4Distribution'])
    assert new[0]['next_merged_config']['l4Distribution']['constraints']['cost_objective'] == change
    # The new chain's S state is the old chain's state k.
    assert chain_states(new)[0] == chain_states(chain)[step]
    assert new[0]['continued_from'] == {'step': step, 'activation_checksum': digest(pk['activation']),
        'policy_chain_sha256': sha((tmp_path / 'r31-chain.json').read_bytes())}
    assert new[0]['controller_source_sha'] == 'e' * 40
    # A further prepare-change extends the new chain from its own end, still linked.
    activate(monkeypatch, tmp_path, 'prepare-change', '--out', str(out), '--set', 'risk_aversion=3.0')
    extended = json.loads((out / 'policy-chain.json').read_text(encoding='utf-8'))
    assert extended[0] == new[0] and len(chain_states(extended)) == 3


@pytest.mark.parametrize('args,error', [
    (['--step', '1'], '--continue-from and --step go together'),
    (['--continue-from', 'CHAIN'], '--continue-from and --step go together'),
    (['--continue-from', 'CHAIN', '--step', '0'], '--step must name a packet'),
    (['--continue-from', 'CHAIN', '--step', '3'], '--step must name a packet'),
    (['--continue-from', 'CHAIN', '--step', '1', 'EXISTS'], 'policy-chain.json exists'),
])
def test_prepare_change_continue_from_refuses_unbound_input(tmp_path, monkeypatch, args, error):
    (tmp_path / 'chain.json').write_text(json.dumps(old_chain()), encoding='utf-8')
    out = tmp_path / 'w-rel'
    if 'EXISTS' in args:
        out.mkdir()
        (out / 'policy-chain.json').write_text('[]', encoding='utf-8')
    args = [str(tmp_path / 'chain.json') if a == 'CHAIN' else a for a in args if a != 'EXISTS']
    with pytest.raises(SystemExit, match=error):
        activate(monkeypatch, tmp_path, 'prepare-change', '--out', str(out), *args, '--set', 'risk_aversion=3.0')


def test_continue_from_refuses_a_chain_whose_links_do_not_connect(tmp_path, monkeypatch):
    chain = old_chain()
    chain[1]['rollback_config'] = deepcopy(chain[0]['rollback_config'])
    (tmp_path / 'chain.json').write_text(json.dumps(chain), encoding='utf-8')
    with pytest.raises(ValueError, match='chain_not_linked'):
        activate(monkeypatch, tmp_path, 'prepare-change', '--out', str(tmp_path / 'w-rel'), '--continue-from',
                 str(tmp_path / 'chain.json'), '--step', '2', '--set', 'risk_aversion=3.0')


def test_continue_from_is_refused_outside_prepare_change(tmp_path, monkeypatch):
    with pytest.raises(SystemExit, match='with prepare-change only'):
        activate(monkeypatch, tmp_path, 'grant', '--out', str(tmp_path / 'w-rel'), '--continue-from',
                 str(tmp_path / 'chain.json'), '--step', '1')
