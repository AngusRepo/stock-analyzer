"""Append-only comparison entries; the production model pointer is read-only.

GCS generations serialize registry revisions. Immutable rules/entries/revisions
retain their original clocks. The registry cannot promote a serving model.
"""
from datetime import datetime, timezone
import json
import re
from google.api_core.exceptions import NotFound, PreconditionFailed
from services.l4_challenger_comparison import RULES, CALIBRATION_ORDER, digest, seal, verify, instant
from services.l4_challenger_rules import verify_document

PREFIX='l4_distribution/challenger_registry/v1/'


def _raw(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()


def _sha(value):
    return isinstance(value,str) and re.fullmatch('[a-f0-9]{64}',value) is not None


class Registry:
    def __init__(self,bucket,*,formal_identity,clock=None):
        self.bucket=bucket;self.formal_identity=formal_identity
        self.clock=clock or (lambda:datetime.now(timezone.utc).isoformat())

    def _read(self,key):
        blob=self.bucket.blob(PREFIX+key)
        try:
            blob.reload();generation=blob.generation
            record=json.loads(blob.download_as_bytes(if_generation_match=generation))
        except NotFound:return None,None
        verify(record)
        return record,generation

    def _put(self,key,value):
        verify(value);blob=self.bucket.blob(PREFIX+key)
        try:blob.upload_from_string(_raw(value),content_type='application/json',if_generation_match=0)
        except PreconditionFailed:pass
        saved,_=self._read(key)
        if saved!=value:raise ValueError('challenger_immutable_conflict:'+key)
        return saved

    def seal_rules(self):
        document_sha = verify_document()
        old,_=self._read('rules.json')
        if old:
            if old.get('rules')!=RULES or old.get('rules_document_sha256')!=document_sha:
                raise ValueError('challenger_rules_changed')
            return old
        return self._put('rules.json',seal(dict(rules=RULES,rules_sha=digest(RULES),
            rules_document_sha256=document_sha,sealed_at=self.clock())))

    def current(self):
        result,generation=self._read('current.json')
        if result:
            rules,_=self._read('rules.json')
            document_sha=verify_document()
            if (not rules or result['rules_sha']!=rules['rules_sha'] or rules['rules']!=RULES
                    or rules.get('rules_document_sha256')!=document_sha
                    or result.get('rules_document_sha256')!=document_sha):
                raise ValueError('challenger_rules_binding_invalid')
            revision,_=self._read('revisions/'+result['checksum']+'.json')
            if revision!=result:raise ValueError('challenger_revision_missing')
            for entry_id,entry in result['entries'].items():
                stored,_=self._read('entries/'+entry['checksum']+'.json')
                if stored!=entry or entry['entry_id']!=entry_id:raise ValueError('challenger_entry_readback_mismatch')
        return result,generation

    def _validate_entry(self,entry,*,incumbent=False):
        verify(entry)
        if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}',entry.get('entry_id',''))
                or entry.get('scope')!='paper_shadow' or entry.get('order_submission_allowed') is not False
                or entry.get('calibration') not in CALIBRATION_ORDER or not entry.get('frozen_at')
                or not entry.get('bundle_reference') or not _sha(entry['bundle_reference'].get('sha256'))):
            raise ValueError('challenger_entry_contract_invalid')
        frozen=instant(entry['frozen_at'])
        if frozen>instant(self.clock()):raise ValueError('challenger_freeze_in_future')
        components=entry.get('components') or {};trainable=entry.get('trainable_components') or []
        receipts=entry.get('training_receipts') or {}
        if (not components or any(not _sha(v) for v in components.values())
                or not {'L3','L4','allocator_policy','calibration'}<=set(components)
                or not trainable or len(set(trainable))!=len(trainable)
                or not set(trainable)<=set(components) or set(receipts)!=set(trainable)):
            raise ValueError('challenger_component_inventory_incomplete')
        identity=entry.get('serving_identity') or {}
        if identity.get('l3_payload_checksum')!=components['L3'] or identity.get('l4_model_checksum')!=components['L4']:
            raise ValueError('challenger_full_chain_identity_mismatch')
        for name,r in receipts.items():
            verify(r)
            if r.get('component_checksum')!=components[name] or instant(r['actual_trained_at'])>frozen:
                raise ValueError('challenger_training_receipt_mismatch')
        if not incumbent and entry.get('inner_acceptance',{}).get('passed') is not True:
            raise ValueError('challenger_inner_acceptance_missing')

    def _save_revision(self,body,generation):
        saved=seal(body)
        self._put('revisions/'+saved['checksum']+'.json',saved)
        try:self.bucket.blob(PREFIX+'current.json').upload_from_string(_raw(saved),content_type='application/json',if_generation_match=generation or 0)
        except PreconditionFailed as exc:raise ValueError('challenger_concurrent_revision_retry_with_fresh_state') from exc
        current,_=self.current()
        if current!=saved:raise ValueError('challenger_current_readback_mismatch')
        return current

    def initialize(self,champion):
        """Bind an incumbent snapshot to the actual pointer; no pointer update."""
        rules=self.seal_rules();self._validate_entry(champion,incumbent=True)
        current,generation=self.current()
        if current:
            if current['entries'].get(current['champion_id'])==champion:return current
            raise ValueError('challenger_registry_already_initialized')
        if champion['serving_identity']!=self.formal_identity():raise ValueError('champion_is_not_formal_pointer')
        self._put('entries/'+champion['checksum']+'.json',champion)
        return self._save_revision(dict(schema='l4-challenger-registry-v1',rules_sha=rules['rules_sha'],
            rules_document_sha256=rules['rules_document_sha256'],
            rules_receipt_checksum=rules['checksum'],champion_id=champion['entry_id'],entries={champion['entry_id']:champion},
            shadow_accounts={champion['entry_id']:digest(['r30-shadow-account',champion['checksum']])},
            registered_at={champion['entry_id']:self.clock()},previous_checksum=None,recorded_at=self.clock()),generation)

    def register(self,entry,*,expected_registry_checksum):
        self._validate_entry(entry);current,generation=self.current()
        if not current or current['checksum']!=expected_registry_checksum:raise ValueError('challenger_registry_stale')
        if current['entries'][current['champion_id']]['serving_identity']!=self.formal_identity():
            raise ValueError('champion_pointer_changed_reconcile_first')
        key=entry['entry_id']
        if key in current['entries']:
            if current['entries'][key]!=entry:raise ValueError('challenger_frozen_entry_changed')
            return current
        if set(entry['components'])!=set(current['entries'][current['champion_id']]['components']):
            raise ValueError('challenger_comparison_components_mismatch')
        self._put('entries/'+entry['checksum']+'.json',entry)
        body={k:v for k,v in current.items() if k!='checksum'}
        body.update(entries={**current['entries'],key:entry},registered_at={**current['registered_at'],key:self.clock()},
            shadow_accounts={**current['shadow_accounts'],key:digest(['r30-shadow-account',entry['checksum']])},
            previous_checksum=current['checksum'],recorded_at=self.clock())
        return self._save_revision(body,generation)

    def reconcile_champion(self,entry_id,*,expected_registry_checksum):
        """Only observe an already completed atomic switch; former champion stays."""
        current,generation=self.current()
        if not current or current['checksum']!=expected_registry_checksum:raise ValueError('challenger_registry_stale')
        if entry_id not in current['entries'] or current['entries'][entry_id]['serving_identity']!=self.formal_identity():
            raise ValueError('champion_switch_not_observed')
        if current['champion_id']==entry_id:return current
        body={k:v for k,v in current.items() if k!='checksum'}
        body.update(champion_id=entry_id,previous_checksum=current['checksum'],recorded_at=self.clock())
        return self._save_revision(body,generation)
