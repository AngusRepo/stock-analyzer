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
