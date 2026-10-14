"""Scope execution consumption, retaining the full original review population."""
from services.paired_nav_cold import load
from services.paired_nav_journal import read_snapshot

KNOWN_OWNERS = frozenset({'atomic_strategy', 'ensemble', 'l4_alpha_ev',
    'allocator_ev_fusion', 'opb_arm_prior', 'l15_route'})


class StrategyAccountingScope:
    def __init__(self, query, active_owners):
        self.original = query
        self.active_owners = frozenset(active_owners)
        if self.active_owners != {'atomic_strategy'}:
            raise ValueError('strategy_nav_accounting_scope_invalid')
        self.owners = {}
        self.retained = {}

    def is_active(self, snapshot_id):
        rows = self.original('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [snapshot_id])
        if len(rows) != 1 or rows[0]['snapshot_kind'] != 'execution_pair':
            raise RuntimeError('strategy_nav_accounting_execution_identity_missing')
        manifest = rows[0]
        key = (snapshot_id, manifest['payload_checksum'], manifest['part_count'], manifest['frozen_at'])
        owner = self.owners.get(key)
        if owner is None:
            prefixes = frozenset({'schema_version', 'signal_date', 'snapshot_kind', 'source_run_id', 'content.owner'})
            payload = load(self.original, manifest, prefixes=prefixes)
            if payload is None:
                payload = read_snapshot(self.original, snapshot_id)['payload']
            if any(payload.get(name) != manifest[name] for name in ('signal_date', 'snapshot_kind', 'source_run_id')):
                raise RuntimeError('strategy_nav_accounting_execution_identity_changed')
            owner = payload.get('content', {}).get('owner')
            if owner not in KNOWN_OWNERS:
                raise RuntimeError('strategy_nav_accounting_owner_unknown')
            self.owners[key] = owner
        if owner not in self.active_owners:
            self.retained[snapshot_id] = {'snapshot_id': snapshot_id, 'owner': owner,
                'payload_checksum': manifest['payload_checksum'], 'reason': 'inactive_single_b_owner',
                'original_evidence_retained': True, 'nav_maturity_credit': 0}
            return False
        return True

    def query(self, sql, params):
        staged = "WHERE m.snapshot_kind='execution_receipt'" in sql and 'j.snapshot_id IS NULL' in sql
        promised = "WHERE m.snapshot_kind='execution_pair' AND m.prospective=1" in sql and 'j.snapshot_id IS NULL' in sql
        if not staged and not promised:
            return self.original(sql, params)
        values, statement = list(params), sql
        while True:
            rows = self.original(statement, values)
            if not rows:
                return []
            selected = [row for row in rows if self.is_active(row['parent_snapshot_id'] if staged else row['snapshot_id'])]
            if selected:
                return selected
            last = rows[-1]
            if promised:
                values[1] = last['snapshot_id']
            else:
                # Original pending queue has no cursor because consumed rows
                # disappear. Seek beyond retained inactive receipts, without
                # deleting them or hiding a later active owner's receipt.
                statement = sql.replace(' ORDER BY m.signal_date,m.snapshot_id LIMIT 100',
                    ' AND (m.signal_date>? OR (m.signal_date=? AND m.snapshot_id>?)) ORDER BY m.signal_date,m.snapshot_id LIMIT 100')
                if statement == sql:
                    raise RuntimeError('strategy_nav_accounting_pagination_contract_changed')
                values = [*params, last['signal_date'], last['signal_date'], last['snapshot_id']]
