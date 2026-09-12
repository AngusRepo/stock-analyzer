"""Observe own native holdings before daily features; no recommendation authority."""
from copy import deepcopy
from datetime import datetime, timezone

from services.native_paper_sandbox import PrivatePaperStore
from services.paired_native_carry import read_native_carry, ARMS
from services.paired_nav_collection import shadow_failure
from services.paired_nav_journal import digest, materialize_staged_receipts
from services.paired_nav_lifecycle import registered_pairs


def _account_rows(query, account_id):
    positions = query('SELECT symbol,shares FROM paper_positions WHERE account_id=? AND shares>0 ORDER BY symbol', [account_id])
    receivables = query('SELECT action_id,symbol,shares_due FROM paper_corporate_entitlements_v1 '
                        'WHERE account_id=? AND settled=0 AND shares_due>0 ORDER BY action_id', [account_id])
    from services.paired_nav_journal import number
    for row in [*positions, *receivables]:
        if (not isinstance(row.get('symbol'), str) or not row['symbol'].strip()
                or row['symbol'] != row['symbol'].strip()
                or number(row.get('shares', row.get('shares_due')), 'native_holdings.shares', minimum=0) <= 0):
            raise ValueError('paired_native_holdings_source_invalid')
    if len({r['symbol'] for r in positions}) != len(positions):
        raise ValueError('paired_native_holdings_duplicate_position')
    return {'positions': positions, 'stock_receivables': receivables}


def _symbols(rows):
    return sorted({r['symbol'] for group in rows.values() for r in group})


def _prediction_symbols(source, definition, arm):
    # Input capture precedes the final model/configuration pair identity. A
    # successor can bootstrap a different account even when its strategy
    # definition already has a carried pair. Forecast this union separately;
    # NEVER substitute the observation for either private account's state.
    initial = source.get('initial_observation') or {}
    bootstrap = _symbols(initial['rows']) if initial.get('status') == 'ready' else []
    return sorted(set(definition['arms'][arm]) | set(bootstrap))


def capture_native_holdings(*, signal_date, definition_checksums, query, writer,
                            paper_query=None, objects=None, account_id=1, now=None):
    """Observe potential new-pair symbols; existing pairs retain their own state.

    The observation is a required-symbol superset, not a replacement account
    bootstrap. Registration still freezes/checks the actual initial state.
    Failures belong to their definition, never an empty successful holding list.
    """
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None or type(account_id) is not int or account_id <= 0:
        raise ValueError('paired_native_holdings_context_invalid')
    wanted = set(definition_checksums)
    by_definition = {key: [] for key in wanted}
    for entry in registered_pairs(signal_date=signal_date, query=query) if wanted else []:
        allocation = entry['allocation']['payload']['content']
        if allocation['owner'] == 'atomic_strategy' and allocation['candidate_checksum'] in wanted:
            by_definition[allocation['candidate_checksum']].append(entry)
    initial = None
    if wanted:
        try:
            if paper_query is None:
                from services.d1_domain_client import D1DataDomain, client_for_domain
                paper_query = client_for_domain(D1DataDomain.PAPER).query
            accounts = paper_query('SELECT id FROM paper_accounts WHERE id=?', [account_id])
            if accounts != [{'id': account_id}]:
                raise ValueError('paired_native_holdings_initial_account_missing')
            initial = _account_rows(paper_query, account_id)
            if initial != _account_rows(paper_query, account_id):
                raise ValueError('paired_native_holdings_source_changed_during_capture')
            initial = {'status': 'ready', 'account_id': account_id, 'rows': initial}
        except Exception as exc:
            initial = shadow_failure('native_holdings_initial_source', exc)
    definitions = {}
    for key, entries in sorted(by_definition.items()):
        try:
            if not entries:
                if initial['status'] != 'ready':
                    definitions[key] = deepcopy(initial)
                    continue
                definitions[key] = {'status': 'ready', 'source_kind': 'initial_paper_observation',
                    'arms': {arm: _symbols(initial['rows']) for arm in ARMS}, 'references': []}
                continue
            arms, references = {arm: set() for arm in ARMS}, []
            for entry in entries:
                packet = entry['execution']['payload']['content']
                if packet['account_id'] != account_id:
                    raise ValueError('paired_native_holdings_account_mismatch')
                materialize_staged_receipts(business_date=signal_date, pair_id=packet['pair_id'],
                    query=query, writer=writer, now=clock)
                if objects is None:
                    from services.paper_corporate_source import production_objects
                    objects = production_objects()
                carry = read_native_carry(pair_id=packet['pair_id'], signal_date=signal_date, query=query, objects=objects, now=clock)
                if carry is None or carry['reference']['execution_snapshot_id'] != entry['execution']['manifest']['snapshot_id']:
                    raise ValueError('paired_native_holdings_registration_changed')
                for arm in ARMS:
                    store = PrivatePaperStore(**carry['states'][arm], inputs={})
                    try:
                        rows = _account_rows(lambda sql, args: [dict(r) for r in store.db.execute(sql, args)], account_id)
                        arms[arm].update(_symbols(rows))
                    finally:
                        store.db.close()
                references.append(carry['reference'])
            definitions[key] = {'status': 'ready', 'source_kind': 'verified_native_carry',
                'arms': {arm: sorted(arms[arm]) for arm in ARMS},
                'references': sorted(references, key=lambda r: r['pair_id'])}
        except Exception as exc:
            definitions[key] = shadow_failure('native_holdings_carry_source', exc)
    body = {'schema_version': 'paired-nav-native-holdings-v1', 'signal_date': signal_date,
        'account_id': account_id, 'observed_at': (now or datetime.now(timezone.utc)).isoformat(), 'definitions': definitions,
        'initial_observation': initial, 'production_effect': False,
        'promotion_allowed': False, 'nav_maturity_credit': 0}
    return {**body, 'source_checksum': digest(body)}


def attach_holding_scopes(packet, holdings, *, core_query):
    """Separate one-target holding slates; NEVER expand recommendation slates."""
    from services.payload_builder import build_ml_universe
    if (packet.get('input_checksum') != digest({k:v for k,v in packet.items() if k != 'input_checksum'})
            or holdings.get('schema_version') != 'paired-nav-native-holdings-v1'
            or holdings.get('source_checksum') != digest({k:v for k,v in holdings.items() if k != 'source_checksum'})
            or holdings.get('signal_date') != packet['signal_date']
            or set(holdings['definitions']) != {r['definition_checksum'] for r in packet['population']['replacements']}):
        raise ValueError('paired_native_holdings_capture_mismatch')
    result = deepcopy(packet)
    union = {r['symbol']: deepcopy(r) for r in packet['required_stocks']}
    targets = sorted({symbol for d in holdings['definitions'].values() if d['status'] == 'ready'
        for arm in ARMS for symbol in _prediction_symbols(holdings, d, arm)} - set(union))
    for offset in range(0, len(targets), 80):
        chunk = targets[offset:offset+80]
        rows = core_query('SELECT id,symbol,name,market FROM stocks WHERE symbol IN (' + ','.join('?' for _ in chunk) + ')', chunk)
        for row in rows:
            if (row.get('symbol') not in chunk or row['symbol'] in union or type(row.get('id')) is not int
                    or row['id'] <= 0 or not isinstance(row.get('market'), str) or not row['market'].strip()
                    or any(r['id'] == row['id'] for r in union.values())):
                raise ValueError('paired_native_holdings_stock_identity_invalid')
            union[row['symbol']] = build_ml_universe([{**row, 'eligible_for_pending_buy': False}], [])[0]
    if any(symbol not in union for symbol in targets):
        raise ValueError('paired_native_holdings_stock_identity_missing')
    scopes = {}
    for key, definition in holdings['definitions'].items():
        if definition['status'] != 'ready' or key not in packet['candidate_stocks']:
            continue
        for arm in ARMS:
            reference = packet['formal_stocks'] if arm == 'baseline' else packet['candidate_stocks'][key]
            for symbol in sorted(set(_prediction_symbols(holdings, definition, arm)) - {r['symbol'] for r in reference}):
                target = build_ml_universe([{**union[symbol], 'eligible_for_pending_buy': False}], [])[0]
                # One held target per reference slate avoids a different private
                # portfolio's other holdings changing this target's peer context.
                metadata = {'definition_checksum': key, 'arm': arm, 'target_symbol': symbol,
                    'holdings_source_checksum': holdings['source_checksum']}
                scopes[digest(metadata)] = {**metadata,
                    'stocks': sorted([*deepcopy(reference), target], key=lambda r:r['id'])}
    result.update(native_holdings=deepcopy(holdings), holding_scopes=scopes,
        required_stocks=sorted(union.values(), key=lambda r:r['id']))
    result['input_checksum'] = digest({k:v for k,v in result.items() if k != 'input_checksum'})
    return result


def validate_holding_prediction_coverage(definition, *, definition_checksum, arm,
                                         predictions, selection_symbols, source):
    if (source.get('schema_version') != 'paired-nav-native-holdings-v1'
            or source.get('source_checksum') != digest({k:v for k,v in source.items() if k != 'source_checksum'})):
        raise ValueError('paired_native_holdings_capture_mismatch')
    member = source['definitions'][definition_checksum]
    if member['status'] != 'ready' or set(member['arms']) != set(ARMS):
        raise ValueError('paired_native_holdings_source_unavailable')
    required = set(_prediction_symbols(source, member, arm))
    supplemental = [r for r in definition.get('holding_predictions', []) if r['arm'] == arm]
    if (len({r['target_symbol'] for r in supplemental}) != len(supplemental)
            or {r['target_symbol'] for r in supplemental} != required - set(selection_symbols)
            or set(predictions) != set(selection_symbols) | required):
        raise ValueError('paired_native_holdings_prediction_coverage_missing')
    for scope in supplemental:
        metadata = {'definition_checksum': definition_checksum, 'arm': arm,
            'target_symbol': scope['target_symbol'], 'holdings_source_checksum': source['source_checksum']}
        if scope['scope_checksum'] != digest(metadata):
            raise ValueError('paired_native_holdings_prediction_source_mismatch')
