"""The v1 -> v2 activation transform keeps every absolute cap and only fills absent risk fields."""
from pathlib import Path
import re

import pytest

from services.l4_policy_activation import (CHANGE_SCHEMA, LEGACY_LOSS_STREAK_SCALE, LEGACY_MOMENTUM_ZONE_SCALE,
    LEGACY_SEVERE_HIGH_VOL_SCALE, SCHEMA, apply_risk_fields, chain_states, circuit_position_scales,
    missing_risk_fields, next_trading_config, step_writes, with_policy_activations)

WORKER = Path(__file__).resolve().parents[2] / 'worker/src/lib'


def test_legacy_scales_match_worker_constants():
    for name in ('riskChecks/p3MarketRisk.ts', 'riskChecks/p4Breadth.ts'):
        assert f'cc.highVolReducedPosPct * {LEGACY_SEVERE_HIGH_VOL_SCALE}' in (WORKER / name).read_text(encoding='utf-8')
    zone = (WORKER / 'momentumZone.ts').read_text(encoding='utf-8')
    block = re.search(r'ZONE_MULTIPLIER: Record<MomentumZone, number> = \{([^}]*)\}', zone).group(1)
    assert {k: float(v) for k, v in re.findall(r'(RED|YELLOW): ([0-9.]+)', block)} == LEGACY_MOMENTUM_ZONE_SCALE
    losses = (WORKER / 'riskChecks/p5Losses.ts').read_text(encoding='utf-8')
    assert f'export const P5_LOSS_POSITION_SCALE = {LEGACY_LOSS_STREAK_SCALE}\n' in losses


def test_scales_reproduce_absolute_caps_and_reject_invalid_caps():
    scales = circuit_position_scales({'maxPositionPct': .08, 'highVolReducedPosPct': .04})
    assert .08 * scales['highVol'] == .04 and .08 * scales['highVol'] * scales['severeHighVol'] == .02
    with pytest.raises(ValueError, match='circuit_caps'):
        circuit_position_scales({'maxPositionPct': .08, 'highVolReducedPosPct': .09})


def test_risk_fill_adds_absent_fields_only():
    risk = {'system': {'killSwitch': True}, 'portfolio': {}, 'position': {}, 'order': {}}
    filled = missing_risk_fields(risk, {'system': {'killSwitch': False, 'clockSkewTolerance': 30},
        'portfolio': {'orangeTargetExposure': .45}, 'position': {}, 'order': {}})
    assert filled == {'system.clockSkewTolerance': 30, 'portfolio.orangeTargetExposure': .45}
    assert apply_risk_fields(risk, filled)['system'] == {'killSwitch': True, 'clockSkewTolerance': 30}
    with pytest.raises(ValueError, match='risk_field_present'):
        apply_risk_fields(risk, {'system.killSwitch': False})


def test_raw_config_must_carry_the_name_cap_it_moves():
    with pytest.raises(ValueError, match='position_name_cap_missing'):
        next_trading_config({'position': {}}, l4={}, scales={})


T, R = 'trading:config', 'trading:risk_config'
# S -> P1 moves both keys (risk first), P1 -> P2 changes trading:config only.
CHAIN = [{'rollback_config': 't0', 'rollback_risk_config': 'r0', 'next_config': 't1', 'next_risk_config': 'r1',
          'write_order': [R, T], 'rollback_order': [T, R]},
         {'rollback_config': 't1', 'rollback_risk_config': 'r1', 'next_config': 't2', 'next_risk_config': 'r1',
          'write_order': [T], 'rollback_order': [T]}]


@pytest.mark.parametrize('trading,risk,target,start,writes', [
    ('t0', 'r0', 1, 0, [(R, 'r0', 'r1'), (T, 't0', 't1')]),
    ('t0', 'r1', 1, 0, [(T, 't0', 't1')]),  # resume after the risk write landed
    ('t1', 'r1', 2, 1, [(T, 't1', 't2')]),  # the unchanged risk key is not rewritten
    ('t2', 'r1', 1, 2, [(T, 't2', 't1')]),
    ('t1', 'r1', 0, 1, [(T, 't1', 't0'), (R, 'r1', 'r0')]),
    ('t0', 'r1', 0, 1, [(R, 'r1', 'r0')]),  # resume a rollback after its trading write
    ('t2', 'r1', 2, 2, [])])
def test_step_writes_moves_one_adjacent_step(trading, risk, target, start, writes):
    assert step_writes(CHAIN, {T: trading, R: risk}, target) == (start, writes)


@pytest.mark.parametrize('trading,risk,target,reason', [
    ('t0', 'r0', 2, 'step_not_adjacent'), ('t2', 'r1', 0, 'step_not_adjacent'),
    ('tx', 'r0', 1, 'drift'), ('t1', 'r0', 1, 'drift'), ('t2', 'r0', 2, 'drift'),
    ('t0', 'r0', 3, 'step_target'), ('t0', 'r0', -1, 'step_target'), ('t0', 'r0', '1', 'step_target')])
def test_step_writes_refuses_drift_and_jumps(trading, risk, target, reason):
    with pytest.raises(ValueError, match=reason):
        step_writes(CHAIN, {T: trading, R: risk}, target)


def test_chain_states_require_linked_packets():
    assert [s[T] for s in chain_states(CHAIN)] == ['t0', 't1', 't2']
    for field, value in (('rollback_config', 't9'), ('rollback_risk_config', 'r0'), ('write_order', ['other'])):
        broken = [CHAIN[0], {**CHAIN[1], field: value}]
        with pytest.raises(ValueError, match='chain_not_linked'):
            chain_states(broken)


def test_release_policy_keys_bind_one_key_per_reviewed_activation():
    chain = [{'schema_version': SCHEMA}, {'schema_version': CHANGE_SCHEMA}]
    manifest, behavior = with_policy_activations({'policy_activation': {}, 'scope': 'paper'},
        {'runtime_admission': 'S', 'policy_runtime_admission': 'old'}, chain=chain, keys=['P1', 'P2'])
    assert manifest == {'scope': 'paper', 'policy_activations': chain}
    assert behavior == {'runtime_admission': 'S', 'policy_runtime_admissions': ['P1', 'P2']}
    for keys, activations in ((['P1'], chain), (['P1', 'P1'], chain), (['S', 'P2'], chain),
                              (['P1', 'P2'], [chain[0], {'schema_version': 'l4-execution-policy-activation-v1'}])):
        with pytest.raises(ValueError, match='release_policy_keys'):
            with_policy_activations({}, {'runtime_admission': 'S'}, chain=activations, keys=keys)


def _risk_world():
    policy = {'scope': 'paper', 'artifact': {'model_checksum': 'a' * 64}, 'constraints': {'max_positions': 5},
              'opb': {'enabled': True, 'approved_policy_identity': 'b' * 64}}
    raw = {'l4Distribution': policy, 'exit': {'hardStopPct': -.1}}
    merged = {**raw, 'fees': {'commission': .001425, 'tax': .003}}
    return raw, merged, {'position': {'maxSingleNamePct': .25, 'maxPerSector': 2, 'correlationThreshold': .65, 'correlationWindow': 60}}


def test_risk_packet_writes_only_risk_config_and_links_into_the_chain():
    """K20 P1 (G0b): risk-only link; trading:config stays byte-equal and a later change links after it."""
    from services.l4_release_packet import prepare_policy_risk_packet
    raw, merged, risk = _risk_world()
    packet = prepare_policy_risk_packet(raw_config=raw, merged_config=merged, risk_config=risk,
        risk_fields={'position.minCorrelationOverlap': 20}, engineering_receipt={'r': 1}, source_reference='test')
    assert packet['write_order'] == packet['rollback_order'] == ['trading:risk_config']
    assert packet['next_config'] == packet['rollback_config'] == raw
    assert packet['next_risk_config'] == {'position': {**risk['position'], 'minCorrelationOverlap': 20}}
    states = chain_states([packet])
    assert states[0][T] == states[1][T] == raw and states[1][R] == packet['next_risk_config']
    assert step_writes([packet], {T: raw, R: risk}, 1) == (0, [(R, risk, packet['next_risk_config'])])
    with pytest.raises(ValueError, match='l4_policy_risk_raw_policy_not_merged_policy'):
        prepare_policy_risk_packet(raw_config={**raw, 'l4Distribution': {**raw['l4Distribution'], 'scope': 'live'}},
            merged_config=merged, risk_config=risk, risk_fields={'position.minCorrelationOverlap': 20},
            engineering_receipt={'r': 1}, source_reference='test')


def test_effective_risk_change_allows_only_the_declared_field():
    import sys
    tools = str(Path(__file__).resolve().parents[2] / 'tools')
    if tools not in sys.path:
        sys.path.insert(0, tools)
    from activate_l4_policy import effective_risk_change_allowed as allowed
    before = {'position': {'maxSingleNamePct': .25, 'minCorrelationOverlap': 10}, 'portfolio': {'cap': 1}}
    after = {'position': {'maxSingleNamePct': .25, 'minCorrelationOverlap': 20}, 'portfolio': {'cap': 1}}
    declared = {'position.minCorrelationOverlap': 20}
    assert allowed(before, after, declared, forward=True)
    assert not allowed(before, {**after, 'position': {**after['position'], 'minCorrelationOverlap': 21}}, declared, forward=True)
    assert not allowed(before, {**after, 'portfolio': {'cap': 2}}, declared, forward=True)
    assert allowed(after, before, declared, forward=False)          # rollback: declared fields not compared
    assert not allowed(before, after, {}, forward=True)              # an undeclared move is refused


def _tools():
    import sys
    tools = str(Path(__file__).resolve().parents[2] / 'tools')
    if tools not in sys.path:
        sys.path.insert(0, tools)
    import activate_l4_policy
    return activate_l4_policy


class _Clock:
    """Fake monotonic clock: sleep advances it, so a poll loop runs without waiting."""
    def __init__(self):
        self.now, self.sleeps = 0.0, []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


def _fake_time(monkeypatch, tool):
    import types
    clock = _Clock()
    monkeypatch.setattr(tool, 'time', types.SimpleNamespace(monotonic=clock, sleep=clock.sleep))
    return clock


STALE = {'position': {'maxSingleNamePct': .25, 'minCorrelationOverlap': 0}, 'portfolio': {'cap': 1}}
FRESH = {'position': {'maxSingleNamePct': .25, 'minCorrelationOverlap': 20}, 'portfolio': {'cap': 1}}
DECLARED = {'position.minCorrelationOverlap': 20}


def test_worker_risk_view_is_polled_until_the_edge_cache_shows_the_write(monkeypatch):
    """The Worker reads KV through a ~60 s edge cache: a stale view right after the write is not drift."""
    tool = _tools()
    clock = _fake_time(monkeypatch, tool)
    views, timeouts = iter([STALE] * 12 + [FRESH]), []
    after = tool.wait_for_worker_risk_view(lambda t: timeouts.append(t) or next(views), STALE, DECLARED, forward=True)
    assert after == FRESH and clock.sleeps == [5.0] * 12 and clock.now == 60.0
    assert timeouts == [15.0] * 13          # every read is itself bounded


@pytest.mark.parametrize('view,reason', [
    (STALE, 'worker_effective_risk_config_changed'),                                     # never turns
    ({**FRESH, 'portfolio': {'cap': 2}}, 'worker_effective_risk_config_changed'),       # undeclared move
    (None, 'worker_risk_config_unavailable')])
def test_worker_risk_view_poll_is_bounded(monkeypatch, view, reason):
    tool = _tools()
    clock = _fake_time(monkeypatch, tool)
    with pytest.raises(RuntimeError, match=reason):
        tool.wait_for_worker_risk_view(lambda t: view, STALE, DECLARED, forward=True)
    assert clock.now == 120.0 and len(clock.sleeps) == 24


def test_worker_risk_view_poll_retries_transport_errors_within_the_same_bound(monkeypatch):
    import httpx
    tool = _tools()
    clock = _fake_time(monkeypatch, tool)
    script = iter([httpx.ReadTimeout('read'), httpx.RemoteProtocolError('Server disconnected'),
                   httpx.ConnectError('refused'), FRESH])

    def fetch(timeout):
        item = next(script)
        if isinstance(item, Exception):
            raise item
        return item
    assert tool.wait_for_worker_risk_view(fetch, STALE, DECLARED, forward=True) == FRESH and clock.now == 15.0

    def down(timeout):
        raise httpx.ReadTimeout('read')
    clock.now, clock.sleeps = 0.0, []
    with pytest.raises(RuntimeError, match='worker_risk_config_unavailable'):
        tool.wait_for_worker_risk_view(down, STALE, DECLARED, forward=True)
    assert clock.now == 120.0
    with pytest.raises(ValueError):            # anything else is not retried
        tool.wait_for_worker_risk_view(lambda t: (_ for _ in ()).throw(ValueError('bug')), STALE, DECLARED, forward=True)


@pytest.mark.parametrize('reply,view', [
    ({'http_status': 200, 'body': {'source': 'kv', 'effective': FRESH}}, FRESH),
    ({'http_status': 500, 'body': {'source': 'kv', 'effective': FRESH}}, None),
    ({'http_status': 401, 'body': 'unauthorized'}, None),
    # A KV read error / missing key: the Worker answers 200 with its FAIL_CLOSED view.
    ({'http_status': 200, 'body': {'source': 'error', 'effective': STALE}}, None),
    ({'http_status': 200, 'body': {'source': 'missing', 'effective': STALE}}, None),
    ({'http_status': 200, 'body': {'source': 'kv'}}, None)])
def test_worker_risk_view_reader_counts_only_a_kv_backed_200(reply, view):
    tool, timeouts = _tools(), []
    fetch = tool.worker_risk_view_reader(lambda timeout: timeouts.append(timeout) or reply)
    assert fetch(7.5) == view and timeouts == [7.5]


def test_a_resumed_step_checks_the_target_values_not_an_empty_declaration():
    """start == target (every write landed, `before` read after it): the target packet's declared values."""
    from services.l4_release_packet import prepare_policy_risk_packet
    tool = _tools()
    raw, merged, risk = _risk_world()
    packet = prepare_policy_risk_packet(raw_config=raw, merged_config=merged, risk_config=risk,
        risk_fields=DECLARED, engineering_receipt={'r': 1}, source_reference='test')
    assert tool.risk_view_expectation([packet], 0, 1) == (DECLARED, (), True)      # forward S -> P1
    assert tool.risk_view_expectation([packet], 1, 0) == (DECLARED, (), False)     # rollback P1 -> S
    declared, free, forward = tool.risk_view_expectation([packet], 1, 1)           # resumed at P1
    assert (declared, free, forward) == (DECLARED, (), True)
    for before in (STALE, FRESH):   # `before` may be either side of the edge cache
        assert tool.effective_risk_change_allowed(before, FRESH, declared, forward=forward, free=free)
        assert not tool.effective_risk_change_allowed(before, STALE, declared, forward=forward, free=free)
    declared, free, forward = tool.risk_view_expectation([packet], 0, 0)           # resumed rollback at S
    assert (declared, free, forward) == ({}, ('position.minCorrelationOverlap',), True)
    assert tool.effective_risk_change_allowed(FRESH, STALE, declared, forward=forward, free=free)
    assert not tool.effective_risk_change_allowed(FRESH, {**STALE, 'portfolio': {'cap': 2}}, declared,
                                                  forward=forward, free=free)


@pytest.mark.parametrize('value', [0, 1, 2, 61, 20.5, '20', True, None])
def test_a_risk_only_link_refuses_an_out_of_range_position_field(value):
    """minCorrelationOverlap must satisfy FormalPositionRiskParams (3..correlationWindow) at prepare time."""
    from services.l4_policy_activation import risk_change_document
    raw, _, risk = _risk_world()
    with pytest.raises(ValueError, match='risk_position_range'):
        risk_change_document(raw, risk, risk_fields={'position.minCorrelationOverlap': value},
                             engineering_receipt_checksum='e' * 64, source_reference='x')
    # The window bounds the overlap: without correlationWindow no overlap is valid.
    no_window = {'position': {k: v for k, v in risk['position'].items() if k != 'correlationWindow'}}
    with pytest.raises(ValueError, match='risk_position_range'):
        risk_change_document(raw, no_window, risk_fields=DECLARED, engineering_receipt_checksum='e' * 64,
                             source_reference='x')
    activation, next_risk = risk_change_document(raw, risk, risk_fields=DECLARED,
                                                 engineering_receipt_checksum='e' * 64, source_reference='x')
    assert next_risk['position']['minCorrelationOverlap'] == 20


# --- activate_l4_policy main(): the Worker risk view call site (fakes only, no cloud call) --------

class _ActivateWorld:
    """S and the risk-only P1 staged; KV, the Worker, gcloud and D1 are fakes."""
    WORKER_URL = 'https://worker.test'

    def __init__(self, tmp_path, monkeypatch, *, at):
        import json
        import sys
        import types
        from urllib.parse import unquote
        import services
        from services import active8_nav_adoption, active8_paper_admission
        from services.l4_policy_activation import chain_states
        from services.l4_release_packet import prepare_policy_risk_packet
        from services.paired_nav_journal import digest
        self.tool, self.tmp = _tools(), tmp_path
        self.clock = _fake_time(monkeypatch, self.tool)
        raw, merged, risk = _risk_world()
        packet = prepare_policy_risk_packet(raw_config=raw, merged_config=merged, risk_config=risk,
            risk_fields=DECLARED, engineering_receipt={'r': 1}, source_reference='test')
        self.chain, self.states = [packet], chain_states([packet])
        source = {'admission': {'a': 1}, 'approval_checksum': 's' * 64,
                  'configuration': {'trading_config': merged, 'risk_config': packet['rollback_risk_config']}}
        p1 = {'admission': {'a': 1}, 'approval_checksum': 'p' * 64,
              'configuration': {'trading_config': packet['next_merged_config'], 'risk_config': packet['next_risk_config']},
              'approved_l4_execution_policy_change': {'activation_checksums': [digest(packet['activation'])]}}
        self.grants = [source, p1]
        self.kv = {'grant:s': source, 'grant:p1': p1, **json.loads(json.dumps(self.states[at]))}
        self.out, controller = tmp_path / 'out', tmp_path / 'controller'
        (controller / 'services').mkdir(parents=True)
        (controller / 'services/native_execution_behavior_release.json').write_text(
            json.dumps({'runtime_admission': 'grant:s', 'policy_runtime_admissions': ['grant:p1']}), encoding='utf-8')
        self.out.mkdir()
        (self.out / 'policy-chain.json').write_text(json.dumps(self.chain), encoding='utf-8')
        (self.out / 'policy-grants.json').write_text(json.dumps([p1]), encoding='utf-8')
        self.script, self.worker_timeouts, self.expectations = [], [], []

        def kv_get(key):
            return {'http_status': 200, 'body': json.loads(json.dumps(self.kv[key]))} if key in self.kv \
                else {'http_status': 404, 'body': None}

        def request(url, *, method='GET', body=None, headers=None, timeout=120):
            if url.startswith(self.WORKER_URL):
                assert url == self.WORKER_URL + '/api/admin/risk-config' and method == 'GET'
                self.worker_timeouts.append(timeout)
                item = self.script.pop(0) if self.script else 'live'
                if isinstance(item, Exception):
                    raise item
                return item if isinstance(item, dict) else {'http_status': 200, 'body': {
                    'source': 'kv', 'effective': self.view(0 if item == 'stale' else None)}}
            assert method == 'PUT' and '/values/' in url
            self.kv[unquote(url.split('/values/')[1].split('?')[0])] = json.loads(json.dumps(body))
            return {'http_status': 200, 'body': {'success': True}}

        fake = types.ModuleType('runtime_context')
        fake.load_environment = lambda: {'source_sha': 'e' * 40}
        fake.kv_get, fake.request = kv_get, request
        fake.worker = lambda *a, **kw: pytest.fail('activate reads the Worker only through the bounded reader')
        fake.gc = lambda *args: b'[]'
        paper = types.SimpleNamespace(query=lambda sql, params=None: [])
        d1 = types.ModuleType('services.d1_domain_client')
        d1.client_for_domain = lambda domain: paper
        monkeypatch.setitem(sys.modules, 'runtime_context', fake)
        monkeypatch.setitem(sys.modules, 'services.d1_domain_client', d1)
        monkeypatch.setattr(services, 'd1_domain_client', d1, raising=False)
        monkeypatch.setattr(sys, 'path', list(sys.path))
        monkeypatch.setenv('CLOUDSDK_PYTHON', sys.executable)
        for name, value in (('STOCKVISION_WORKER_URL', self.WORKER_URL), ('STOCKVISION_AUTH_TOKEN', 'test-only'),
                            ('CF_ACCOUNT_ID', 'acct'), ('CF_KV_NAMESPACE_ID', 'ns'), ('CF_API_TOKEN', 'test-only')):
            monkeypatch.setenv(name, value)
        live_grant = lambda: next(g for g in self.grants if g['configuration']['risk_config'] == self.kv['trading:risk_config'])
        monkeypatch.setattr(active8_nav_adoption, 'current_execution_configuration', lambda: live_grant()['configuration'])
        monkeypatch.setattr(active8_paper_admission, 'validate_runtime_approval', lambda grant, adm, now=None: None)
        monkeypatch.setattr(active8_paper_admission, 'runtime_configuration_identity', lambda config: config)
        monkeypatch.setattr(active8_paper_admission, 'verify_active_approval', lambda adm: live_grant())
        expectation = self.tool.risk_view_expectation

        def spy(chain, start, target):
            self.expectations.append((start, target))
            return expectation(chain, start, target)
        monkeypatch.setattr(self.tool, 'risk_view_expectation', spy)
        monkeypatch.setattr(sys, 'argv', ['activate_l4_policy.py', 'activate', '--workspace-root', str(tmp_path),
                                          '--out', str(self.out), '--controller', str(controller)])

    def view(self, state=None):
        """The Worker effective view of a raw risk_config: the KV-owned overlap fails closed to 0."""
        import json
        raw = json.loads(json.dumps(self.kv['trading:risk_config'] if state is None
                                    else self.states[state]['trading:risk_config']))
        raw['position'].setdefault('minCorrelationOverlap', 0)
        return raw

    def activate(self, to, *, execute=True):
        import sys
        sys.argv += ['--to', to] + (['--execute'] if execute else [])
        self.tool.main()

    def receipt(self, name):
        import json
        return json.loads((self.out / name).read_text(encoding='utf-8'))


@pytest.mark.parametrize('at,to,step,receipt', [
    (0, '1', (0, 1), 'activation-source-P1-receipt.json'),        # forward S -> P1
    (1, 'source', (1, 0), 'activation-P1-source-receipt.json'),   # rollback P1 -> S
    (1, '1', (1, 1), 'activation-P1-P1-receipt.json')])           # resumed: every write landed
def test_activate_checks_the_worker_view_of_exactly_this_step(tmp_path, monkeypatch, at, to, step, receipt):
    world = _ActivateWorld(tmp_path, monkeypatch, at=at)
    world.script = ['live', 'stale', 'stale', 'stale']           # the edge cache lags the write
    world.activate(to)
    assert world.expectations == [step]
    assert world.kv['trading:risk_config'] == world.states[step[1]]['trading:risk_config']
    assert world.receipt(receipt)['status'] == 'config_written_readback_verified'
    assert world.worker_timeouts and all(0 < t <= 15.0 for t in world.worker_timeouts)


def test_activate_forward_refuses_a_worker_view_other_than_the_declared_value(tmp_path, monkeypatch):
    """A swapped start/target would read as a rollback, where the declared field is not compared."""
    world = _ActivateWorld(tmp_path, monkeypatch, at=0)
    wrong = world.view(1)
    wrong['position']['minCorrelationOverlap'] = 21
    world.script = ['live'] + [{'http_status': 200, 'body': {'source': 'kv', 'effective': wrong}}] * 100
    with pytest.raises(RuntimeError, match='worker_effective_risk_config_changed'):
        world.activate('1')
    assert world.expectations == [(0, 1)] and world.clock.now == 120.0
    assert world.receipt('activation-source-P1-receipt.json')['status'] == 'writing'


@pytest.mark.parametrize('reply', [
    {'http_status': 503, 'body': 'unavailable'},
    {'http_status': 200, 'body': {'source': 'error', 'effective': {'position': {}}}},
    'transport'])
def test_activate_after_the_write_fails_closed_when_the_worker_view_is_unavailable(tmp_path, monkeypatch, reply):
    import httpx
    world = _ActivateWorld(tmp_path, monkeypatch, at=0)
    world.script = ['live'] + [httpx.ReadTimeout('read') if reply == 'transport' else reply] * 100
    with pytest.raises(RuntimeError, match='worker_risk_config_unavailable'):
        world.activate('1')
    assert world.clock.now == 120.0 and world.receipt('activation-source-P1-receipt.json')['status'] == 'writing'


def test_activate_recovers_from_transport_errors_after_the_write(tmp_path, monkeypatch):
    import httpx
    world = _ActivateWorld(tmp_path, monkeypatch, at=0)
    world.script = ['live', httpx.ReadTimeout('read'), httpx.RemoteProtocolError('Server disconnected'), 'stale']
    world.activate('1')
    assert world.receipt('activation-source-P1-receipt.json')['status'] == 'config_written_readback_verified'


@pytest.mark.parametrize('reply', [
    {'http_status': 200, 'body': {'source': 'error', 'effective': {'position': {}}}},   # KV read error: FAIL_CLOSED
    {'http_status': 200, 'body': {'source': 'missing', 'effective': {'position': {}}}},
    {'http_status': 500, 'body': 'boom'},
    'transport'])
@pytest.mark.parametrize('execute', [True, False])
def test_activate_reads_the_before_view_bounded_and_fails_closed_before_any_write(tmp_path, monkeypatch, reply, execute):
    import httpx
    world = _ActivateWorld(tmp_path, monkeypatch, at=0)
    world.script = [httpx.ConnectError('refused') if reply == 'transport' else reply] * 100
    with pytest.raises(RuntimeError, match='worker_risk_config_unavailable'):
        world.activate('1', execute=execute)
    assert world.clock.now == 120.0 and world.expectations == []
    assert world.kv['trading:risk_config'] == world.states[0]['trading:risk_config']
    assert not list(world.out.glob('activation-*'))


def test_activate_before_view_survives_a_transient_error(tmp_path, monkeypatch):
    import httpx
    world = _ActivateWorld(tmp_path, monkeypatch, at=0)
    world.script = [httpx.ConnectError('refused'), {'http_status': 502, 'body': 'x'}, 'live']
    world.activate('1')
    assert world.receipt('activation-source-P1-receipt.json')['status'] == 'config_written_readback_verified'


# --- activate_l4_policy prepare: the Worker risk defaults come only from a KV-backed view ----------

def _prepare(tmp_path, monkeypatch, script):
    """Run `prepare` with fakes; `script` is the Worker replies in order (then the last one repeats)."""
    import json
    import sys
    import types
    from services import worker_config_client
    from test_strategy_nav_runtime_approval import V1_POLICY
    tool = _tools()
    clock = _fake_time(monkeypatch, tool)
    raw = {'l4Distribution': json.loads(json.dumps(V1_POLICY)), 'position': {'maxPctOfPortfolio': .25, 'maxPositions': 5},
           'circuit': {'maxPositionPct': .08, 'highVolReducedPosPct': .04}, 'fees': {'commission': .001425}}
    risk = {'system': {'killSwitch': False}, 'portfolio': {'dailyPnlLossLimitPct': -.03},
            'position': {'maxSingleNamePct': .25, 'maxPerSector': 2, 'correlationThreshold': .65,
                         'correlationWindow': 60}, 'order': {}}
    kv, worker_calls = {'trading:config': raw, 'trading:risk_config': risk}, []

    def request(url, *, method='GET', body=None, headers=None, timeout=120):
        assert url == 'https://worker.test/api/admin/risk-config' and method == 'GET' and timeout <= 15.0
        worker_calls.append(timeout)
        item = script[min(len(worker_calls), len(script)) - 1]
        if isinstance(item, Exception):
            raise item
        return json.loads(json.dumps(item))

    fake = types.ModuleType('runtime_context')
    fake.load_environment = lambda: {'source_sha': 'e' * 40}
    fake.kv_get = lambda key: {'http_status': 200, 'body': json.loads(json.dumps(kv[key]))}
    fake.request = request
    fake.worker = lambda *a, **kw: pytest.fail('prepare reads the Worker only through the bounded reader')
    fake.gc = lambda *args: json.dumps({'spec': {'template': {'spec': {'containers': [{'env': []}]}}}}).encode()
    monkeypatch.setitem(sys.modules, 'runtime_context', fake)
    monkeypatch.setattr(worker_config_client, 'load_active_trading_config', lambda *a, **kw: json.loads(json.dumps(raw)))
    monkeypatch.setattr(sys, 'path', list(sys.path))
    monkeypatch.setenv('CLOUDSDK_PYTHON', sys.executable)
    monkeypatch.setenv('STOCKVISION_WORKER_URL', 'https://worker.test')
    monkeypatch.setenv('STOCKVISION_AUTH_TOKEN', 'test-only')
    (tmp_path / 'receipt.json').write_text('{"receipt": "p1"}', encoding='utf-8')
    out = tmp_path / 'out'
    monkeypatch.setattr(sys, 'argv', ['activate_l4_policy.py', 'prepare', '--workspace-root', str(tmp_path),
        '--out', str(out), '--engineering-receipt', str(tmp_path / 'receipt.json'),
        '--source-reference', 'test-only', '--cost-objective', 'single_side_v1'])
    return tool, clock, out, worker_calls


def test_prepare_takes_the_risk_defaults_from_a_kv_backed_worker_view(tmp_path, monkeypatch):
    import httpx
    import json
    from test_strategy_nav_runtime_approval import RISK_DEFAULTS
    good = {'http_status': 200, 'body': {'source': 'kv', 'effective': RISK_DEFAULTS}}
    tool, clock, out, calls = _prepare(tmp_path, monkeypatch, [httpx.ReadTimeout('read'), {'http_status': 503,
        'body': 'x'}, {'http_status': 200, 'body': {'source': 'error', 'effective': {'position': {}}}}, good])
    tool.main()
    (packet,) = json.loads((out / 'policy-chain.json').read_text(encoding='utf-8'))
    assert packet['worker_effective_risk_config'] == RISK_DEFAULTS and len(calls) == 4 and clock.now == 15.0
    assert packet['activation']['risk_config_filled_fields']   # absent raw fields came from the KV-backed view


@pytest.mark.parametrize('reply', [
    {'http_status': 503, 'body': 'unavailable'},
    {'http_status': 401, 'body': {'source': 'kv', 'effective': {'position': {}}}},
    # A KV read error / missing key: the Worker answers 200 with its FAIL_CLOSED view.
    {'http_status': 200, 'body': {'source': 'error', 'effective': {'position': {'maxSingleNamePct': 0}}}},
    {'http_status': 200, 'body': {'source': 'missing', 'effective': {'position': {'maxSingleNamePct': 0}}}},
    'transport'])
def test_prepare_never_packets_a_fail_closed_worker_view(tmp_path, monkeypatch, reply):
    import httpx
    tool, clock, out, calls = _prepare(tmp_path, monkeypatch, [httpx.ConnectError('refused') if reply == 'transport'
                                                               else reply])
    with pytest.raises(RuntimeError, match='worker_risk_config_unavailable'):
        tool.main()
    assert clock.now == 120.0 and len(calls) == 25
    assert not (out / 'policy-chain.json').exists() and list(out.iterdir()) == []


# --- OPB v2 -> v3 schema change (l4-policy-opb-schema-change-v1) ----------------------------------

def _v2_world():
    """Live raw / merged trading:config at a v2 policy (V1_POLICY after the owner move) and its risk_config."""
    from copy import deepcopy
    from services.l4_release_packet import prepare_policy_v2_packet
    from services.active_model_policy import gnn_return_history_lookback
    from test_strategy_nav_runtime_approval import RISK_DEFAULTS, V1_POLICY
    raw = {'l4Distribution': deepcopy(V1_POLICY), 'position': {'maxPctOfPortfolio': .25, 'maxPositions': 5},
           'circuit': {'maxPositionPct': .08, 'highVolReducedPosPct': .04}, 'fees': {'commission': .001425}}
    risk = {'system': {'killSwitch': False}, 'portfolio': {'dailyPnlLossLimitPct': -.03},
            'position': {'maxSingleNamePct': .25}, 'order': {}}
    v2 = prepare_policy_v2_packet(raw_config=raw, merged_config=deepcopy(raw), risk_config=risk,
        risk_defaults=RISK_DEFAULTS, lookback=gnn_return_history_lookback(), cost_objective='entry_round_trip_v1',
        engineering_receipt={'r': 'v2'}, source_reference='test-only v2')
    return v2['next_config'], v2['next_merged_config'], v2['next_risk_config']


def _v3_opb(**overrides):
    from copy import deepcopy
    from test_strategy_nav_runtime_approval import V3_OPB
    return {**deepcopy(V3_OPB), **overrides}


def test_opb_change_replaces_only_the_opb_block_and_recomputes_the_identity():
    from services.l4_distribution_runtime import distribution_policy_identity
    from services.l4_opb_selection import is_v3
    from services.l4_policy_activation import OPB_CHANGE_SCHEMA, SCHEMAS, expected_configuration, opb_change_document
    from services.paired_nav_journal import digest
    raw, merged, risk = _v2_world()
    assert OPB_CHANGE_SCHEMA in SCHEMAS
    activation, config = opb_change_document(merged, opb=_v3_opb(), engineering_receipt_checksum='e' * 64,
                                             source_reference='x')
    old, new = merged['l4Distribution'], config['l4Distribution']
    assert is_v3(new) and {k: v for k, v in new.items() if k != 'opb'} == {k: v for k, v in old.items() if k != 'opb'}
    assert {k: v for k, v in new['opb'].items() if k not in ('approved_policy_identity', 'migration')} == _v3_opb()
    assert new['opb']['migration']['source_policy_identity'] == old['opb']['approved_policy_identity']
    assert new['opb']['approved_policy_identity'] == distribution_policy_identity(new, new['artifact']['l3_identity'])
    assert {k: v for k, v in config.items() if k != 'l4Distribution'} == {
        k: v for k, v in merged.items() if k != 'l4Distribution'}
    assert activation['schema_version'] == OPB_CHANGE_SCHEMA and activation['opb'] == _v3_opb()
    assert activation['previous_policy_checksum'] == digest(old) and activation['next_policy_checksum'] == digest(new)
    state = {'trading_config': merged, 'risk_config': risk}
    assert expected_configuration(state, activation) == (config, risk)
    for field, value in (('next_policy_checksum', '0' * 64), ('next_policy_identity', '0' * 64),
                         ('opb', _v3_opb(hac_lag_sessions=3)), ('previous_policy_checksum', '0' * 64),
                         ('maturity_transfer', True), ('engineering_receipt_checksum', '')):
        with pytest.raises(ValueError):
            expected_configuration(state, {**activation, field: value})


def _required_v3_keys():
    from services.l4_opb_selection import V3_CONFIG_KEYS
    return sorted(V3_CONFIG_KEYS - {'approved_policy_identity', 'migration'})


@pytest.mark.parametrize('missing', _required_v3_keys())
def test_opb_change_requires_every_v3_knob_written_out(missing):
    from services.l4_policy_activation import next_opb_policy
    _, merged, _ = _v2_world()
    opb = {k: v for k, v in _v3_opb().items() if k != missing}
    with pytest.raises(ValueError, match='opb_change_(field_missing:' + missing + '|target_not_v3)'):
        next_opb_policy(merged['l4Distribution'], opb)


@pytest.mark.parametrize('opb,reason', [
    ({'approved_policy_identity': 'b' * 64}, 'opb_change_unknown_or_derived_field'),
    ({'exploration': .05}, 'opb_change_unknown_or_derived_field'),
    ({'enabled': 1}, 'opb_change_enabled'),
    ({'schema_version': 'l4-opb-relative-arms-v2'}, 'opb_change_target_not_v3'),
    ({'family_error_rate': .6}, 'family_error_rate_invalid'),
    ({'market_proxy': '2330'}, 'market_proxy_invalid'),
    ({'cutover_warm_start': {'enabled': True, 'max_observations': 61}}, 'cutover_warm_start_invalid'),
    ({'arms': [{'id': 'base'}, {'id': 'half', 'exposure_fraction': .5}]}, 'forbidden_override'),
    ({'arms': [{'id': 'alpha_tilt', 'risk_aversion': .5}]}, 'base_arm_required')])
def test_opb_change_refuses_an_invalid_v3_block(opb, reason):
    from services.l4_policy_activation import next_opb_policy
    _, merged, _ = _v2_world()
    with pytest.raises(ValueError, match=reason):
        next_opb_policy(merged['l4Distribution'], _v3_opb(**opb))


def test_opb_change_derives_the_v2_to_v3_migration_record_from_the_source_policy():
    from copy import deepcopy
    from services.l4_distribution_runtime import distribution_policy_identity
    from services.l4_policy_activation import next_opb_policy
    _, merged, _ = _v2_world()
    source = deepcopy(merged['l4Distribution'])
    policy = next_opb_policy(source, _v3_opb())
    assert source == merged['l4Distribution']
    assert policy['opb']['migration'] == {
        'source_policy_identity': source['opb']['approved_policy_identity'],
        'arm_semantic': 'allocator_selection_override',
        'replaced_v2_arms': source['opb']['arms'],
        'v2_migration': source['opb']['migration']}
    assert policy['opb']['migration']['v2_migration']['arm_semantic'] == 'fraction_of_risk_envelope'
    # The record is inside the identity: it names what this policy replaced.
    assert policy['opb']['approved_policy_identity'] == distribution_policy_identity(policy, policy['artifact']['l3_identity'])
    stripped = deepcopy(policy)
    del stripped['opb']['migration']
    assert distribution_policy_identity(stripped, stripped['artifact']['l3_identity']) != policy['opb']['approved_policy_identity']


def test_opb_change_migration_follows_the_source_policy_it_replaces():
    from copy import deepcopy
    from services.l4_distribution_runtime import distribution_policy_identity
    from services.l4_policy_activation import next_opb_policy
    _, merged, _ = _v2_world()
    other = deepcopy(merged['l4Distribution'])
    other['opb']['migration'] = {**other['opb']['migration'], 'exploration_removed': .2}
    other['opb']['approved_policy_identity'] = distribution_policy_identity(other, other['artifact']['l3_identity'])
    a = next_opb_policy(merged['l4Distribution'], _v3_opb())['opb']
    b = next_opb_policy(other, _v3_opb())['opb']
    assert b['migration']['source_policy_identity'] == other['opb']['approved_policy_identity']
    assert b['migration']['v2_migration']['exploration_removed'] == .2
    assert a['migration'] != b['migration'] and a['approved_policy_identity'] != b['approved_policy_identity']


@pytest.mark.parametrize('record', ['derived', 'other'])
def test_opb_change_refuses_a_caller_supplied_migration_even_when_it_matches(record):
    from services.l4_policy_activation import next_opb_policy
    _, merged, _ = _v2_world()
    derived = next_opb_policy(merged['l4Distribution'], _v3_opb())['opb']['migration']
    supplied = derived if record == 'derived' else {'source_policy_identity': 'b' * 64}
    with pytest.raises(ValueError, match='opb_change_unknown_or_derived_field'):
        next_opb_policy(merged['l4Distribution'], _v3_opb(migration=supplied))


@pytest.mark.parametrize('identity', [None, '', 7, 'b' * 64, 'stale'])
def test_opb_change_refuses_a_source_whose_identity_is_not_its_own(identity):
    """The source identity is recomputed from the v2 policy; a well-formed but wrong 64-hex
    value, or the identity of the policy before an edit, fails closed."""
    from copy import deepcopy
    from services.l4_distribution_runtime import distribution_policy_identity
    from services.l4_policy_activation import next_opb_policy
    _, merged, _ = _v2_world()
    source = deepcopy(merged['l4Distribution'])
    assert source['opb']['approved_policy_identity'] == distribution_policy_identity(
        source, source['artifact']['l3_identity'])
    if identity == 'stale':
        source['constraints']['risk_aversion'] = source['constraints']['risk_aversion'] + 1.
    else:
        source['opb']['approved_policy_identity'] = identity
    with pytest.raises(ValueError, match='opb_change_source_identity'):
        next_opb_policy(source, _v3_opb())


@pytest.mark.parametrize('source', ['v3', 'v1', 'live_scope', 'no_opb'])
def test_opb_change_source_must_be_a_v2_paper_relative_arms_policy(source):
    from copy import deepcopy
    from services.l4_policy_activation import next_opb_policy
    from test_strategy_nav_runtime_approval import V1_POLICY
    _, merged, _ = _v2_world()
    policy = deepcopy(merged['l4Distribution'])
    if source == 'v3': policy = next_opb_policy(policy, _v3_opb())
    elif source == 'v1': policy = deepcopy(V1_POLICY)
    elif source == 'live_scope': policy['scope'] = 'live'
    elif source == 'no_opb': del policy['opb']
    with pytest.raises(ValueError, match='opb_change_source_not_v2'):
        next_opb_policy(policy, _v3_opb())


@pytest.mark.parametrize('field, value, reason', [
    ('return_history_lookback_sessions', 10, 'l4_policy_v2_lookback_invalid'),
    ('risk_aversion', -1., 'l4_policy_v2_risk_aversion_invalid'),
    ('cost_objective', 'none', 'l4_policy_v2_cost_objective_invalid')])
def test_opb_change_revalidates_the_source_constraints(field, value, reason):
    """The OPB link keeps every constraint as it is, so it must not carry an invalid one forward."""
    from copy import deepcopy
    from services.l4_policy_activation import next_opb_policy
    _, merged, _ = _v2_world()
    from services.l4_distribution_runtime import distribution_policy_identity
    policy = deepcopy(merged['l4Distribution'])
    policy['constraints'][field] = value
    policy['opb']['approved_policy_identity'] = distribution_policy_identity(policy, policy['artifact']['l3_identity'])
    with pytest.raises(ValueError, match=reason):
        next_opb_policy(policy, _v3_opb())


def test_opb_packet_writes_only_trading_config_and_links_into_the_chain():
    from services.l4_release_packet import prepare_policy_change_packet, prepare_policy_opb_packet
    raw, merged, risk = _v2_world()
    packet = prepare_policy_opb_packet(raw_config=raw, merged_config=merged, risk_config=risk, opb=_v3_opb(),
                                       engineering_receipt={'r': 1}, source_reference='test')
    assert packet['schema_version'] == 'l4-policy-opb-packet-v1'
    assert packet['write_order'] == packet['rollback_order'] == ['trading:config']
    assert packet['rollback_config'] == raw and packet['rollback_risk_config'] == packet['next_risk_config'] == risk
    assert packet['next_config'] == {**raw, 'l4Distribution': packet['next_merged_config']['l4Distribution']}
    assert packet['approved_policy_identity'] == packet['next_merged_config']['l4Distribution']['opb'][
        'approved_policy_identity'] == packet['activation']['next_policy_identity']
    states = chain_states([packet])
    assert states[0] == {T: raw, R: risk} and states[1] == {T: packet['next_config'], R: risk}
    assert step_writes([packet], {T: raw, R: risk}, 1) == (0, [(T, raw, packet['next_config'])])
    assert step_writes([packet], {T: packet['next_config'], R: risk}, 0) == (1, [(T, packet['next_config'], raw)])
    with pytest.raises(ValueError, match='drift'):
        step_writes([packet], {T: packet['next_config'], R: {'other': 1}}, 0)
    # A constraints change may follow the v3 link; a second OPB schema change may not (source is v3).
    nxt = prepare_policy_change_packet(packet, changes={'risk_aversion': 3.}, engineering_receipt={'r': 2},
                                       source_reference='test')
    assert len(chain_states([packet, nxt])) == 3
    assert nxt['next_merged_config']['l4Distribution']['opb']['schema_version'] == 'l4-opb-selection-arms-v3'
    assert nxt['write_order'] == nxt['rollback_order'] == ['trading:config']
    with pytest.raises(ValueError, match='opb_change_source_not_v2'):
        prepare_policy_opb_packet(raw_config=packet['next_config'], merged_config=packet['next_merged_config'],
            risk_config=risk, opb=_v3_opb(), engineering_receipt={'r': 3}, source_reference='test')
    with pytest.raises(ValueError, match='l4_policy_opb_raw_policy_not_merged_policy'):
        prepare_policy_opb_packet(raw_config={**raw, 'l4Distribution': {**raw['l4Distribution'], 'scope': 'live'}},
            merged_config=merged, risk_config=risk, opb=_v3_opb(), engineering_receipt={'r': 1}, source_reference='t')


def test_opb_change_declares_no_risk_field():
    from services.l4_policy_activation import declared_risk_fields, opb_change_document
    _, merged, _ = _v2_world()
    activation, _ = opb_change_document(merged, opb=_v3_opb(), engineering_receipt_checksum='e' * 64,
                                        source_reference='x')
    assert declared_risk_fields(activation) == {}


def test_release_policy_keys_accept_the_opb_schema_change():
    from services.l4_policy_activation import OPB_CHANGE_SCHEMA
    chain = [{'schema_version': OPB_CHANGE_SCHEMA}]
    manifest, behavior = with_policy_activations({}, {'runtime_admission': 'S'}, chain=chain, keys=['P1'])
    assert manifest['policy_activations'] == chain and behavior['policy_runtime_admissions'] == ['P1']


def _opb_activate_world(tmp_path, monkeypatch, *, at):
    """_ActivateWorld with S = the v2 world and P1 = its v3 OPB link (trading:config only)."""
    import json
    from services import active8_nav_adoption, active8_paper_admission
    from services.l4_policy_activation import chain_states
    from services.l4_release_packet import prepare_policy_opb_packet
    from services.paired_nav_journal import digest
    world = _ActivateWorld(tmp_path, monkeypatch, at=0)
    raw, merged, risk = _v2_world()
    packet = prepare_policy_opb_packet(raw_config=raw, merged_config=merged, risk_config=risk, opb=_v3_opb(),
                                       engineering_receipt={'r': 1}, source_reference='test')
    world.chain, world.states = [packet], chain_states([packet])
    source = {'admission': {'a': 1}, 'approval_checksum': 's' * 64,
              'configuration': {'trading_config': merged, 'risk_config': risk}}
    p1 = {'admission': {'a': 1}, 'approval_checksum': 'p' * 64,
          'configuration': {'trading_config': packet['next_merged_config'], 'risk_config': risk},
          'approved_l4_execution_policy_change': {'activation_checksums': [digest(packet['activation'])]}}
    world.grants = [source, p1]
    world.kv = {'grant:s': source, 'grant:p1': p1, **json.loads(json.dumps(world.states[at]))}
    (world.out / 'policy-chain.json').write_text(json.dumps(world.chain), encoding='utf-8')
    (world.out / 'policy-grants.json').write_text(json.dumps([p1]), encoding='utf-8')
    # S and P1 share risk_config: the live grant is the one whose policy KV holds.
    live = lambda: (p1 if world.kv['trading:config'] == packet['next_config'] else source)
    monkeypatch.setattr(active8_nav_adoption, 'current_execution_configuration', lambda: live()['configuration'])
    monkeypatch.setattr(active8_paper_admission, 'verify_active_approval', lambda adm: live())
    return world, packet


def test_activate_dry_run_to_the_opb_link_plans_one_trading_config_write(tmp_path, monkeypatch):
    from services.paired_nav_journal import digest
    world, packet = _opb_activate_world(tmp_path, monkeypatch, at=0)
    before = dict(world.kv)
    world.activate('1', execute=False)
    plan = world.receipt('activation-source-P1-dry-run.json')
    assert plan['mode'] == 'dry_run' and (plan['from'], plan['to']) == ('source', 'P1')
    assert plan['writes'] == [{'key': 'trading:config', 'from_checksum': digest(packet['rollback_config']),
                               'to_checksum': digest(packet['next_config'])}]
    assert plan['grant_checksum'] == 'p' * 64 and world.kv == before


@pytest.mark.parametrize('at,to,receipt', [(0, '1', 'activation-source-P1-receipt.json'),
                                           (1, 'source', 'activation-P1-source-receipt.json')])
def test_activate_moves_the_opb_link_and_the_worker_risk_view_must_not_move(tmp_path, monkeypatch, at, to, receipt):
    world, packet = _opb_activate_world(tmp_path, monkeypatch, at=at)
    world.activate(to)
    assert world.receipt(receipt)['status'] == 'config_written_readback_verified'
    assert world.kv['trading:config'] == (packet['next_config'] if to == '1' else packet['rollback_config'])
    assert world.kv['trading:risk_config'] == packet['rollback_risk_config']
    assert world.expectations == [(at, 1 - at)]


def test_activate_refuses_an_opb_step_that_moved_the_worker_risk_view(tmp_path, monkeypatch):
    world, _ = _opb_activate_world(tmp_path, monkeypatch, at=0)
    moved = {'http_status': 200, 'body': {'source': 'kv', 'effective': {**world.view(), 'portfolio': {'x': 1}}}}
    world.script = ['live'] + [moved] * 40
    with pytest.raises(RuntimeError, match='worker_effective_risk_config_changed'):
        world.activate('1')
