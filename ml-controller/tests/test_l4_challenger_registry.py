import json
import pytest
from google.api_core.exceptions import NotFound,PreconditionFailed
from services.l4_challenger_comparison import seal
from services.l4_challenger_registry import Registry,PREFIX


class Bucket:
    def __init__(self):self.objects={};self.writes=[]
    def blob(self,key):return Blob(self,key)


class Blob:
    def __init__(self,bucket,key):self.bucket=bucket;self.key=key;self.generation=None
    def reload(self):
        if self.key not in self.bucket.objects:raise NotFound('missing')
        self.generation=self.bucket.objects[self.key][0]
    def download_as_bytes(self,if_generation_match=None):
        self.reload()
        if if_generation_match is not None and if_generation_match!=self.generation:raise PreconditionFailed('generation')
        return self.bucket.objects[self.key][1]
    def upload_from_string(self,raw,*,if_generation_match,content_type=None):
        current=self.bucket.objects.get(self.key,(0,None))[0]
        if current!=if_generation_match:raise PreconditionFailed('generation')
        self.bucket.objects[self.key]=(current+1,raw);self.bucket.writes.append(self.key)


def entry(name,*,calibration='raw',letter='a',qualified=True):
    components=dict(L3=letter*64,L4=letter*64,allocator_policy='1'*64,calibration='2'*64)
    receipt=seal(dict(component_checksum=letter*64,actual_trained_at='2026-10-19T01:00:00Z',
        signal_date_max='2026-09-22',label_known_at_max='2026-10-01',ancestor_label_known_at_max='2026-10-01',feature_vintage=['source']))
    return seal(dict(entry_id=name,scope='paper_shadow',order_submission_allowed=False,
        calibration=calibration,frozen_at='2026-10-19T02:00:00Z',bundle_reference={'path':'pinned/model.json','sha256':letter*64},
        components=components,trainable_components=['L3','L4'],training_receipts={'L3':receipt,'L4':receipt},
        serving_identity=dict(l3_payload_checksum=letter*64,l4_model_checksum=letter*64),inner_acceptance={'passed':qualified}))


def setup():
    b=Bucket();champ=entry('actual-old-c53',qualified=False);formal=[champ['serving_identity']]
    r=Registry(b,formal_identity=lambda:formal[0],clock=lambda:'2026-10-19T03:00:00Z')
    return b,r,champ,formal


def test_incumbent_can_be_baseline_without_fabricated_new_inner_pass():
    b,r,champ,_=setup();s=r.initialize(champ)
    assert s['champion_id']==champ['entry_id'] and r.initialize(champ)==s
    assert b.writes[0]==PREFIX+'rules.json'
    assert all(k.startswith(PREFIX) for k in b.writes)


def test_arbitrary_ids_share_calibration_not_accounts_and_can_join_later():
    b,r,champ,_=setup();s=r.initialize(champ)
    for name,letter in [('oct-monthly','b'),('next-candidate','c'),('another-raw','d')]:
        s=r.register(entry(name,letter=letter),expected_registry_checksum=s['checksum'])
    assert len(s['entries'])==4 and len(set(s['shadow_accounts'].values()))==4
    assert r.current()[0]==s and all(e['calibration']=='raw' for e in s['entries'].values())


def test_stale_writers_do_not_overwrite_other_session_registration():
    _,r,champ,_=setup();initial=r.initialize(champ)
    updated=r.register(entry('first',letter='b'),expected_registry_checksum=initial['checksum'])
    with pytest.raises(ValueError,match='stale'):
        r.register(entry('second',letter='c'),expected_registry_checksum=initial['checksum'])
    assert r.current()[0]==updated


def test_unqualified_challenger_cannot_register():
    _,r,champ,_=setup();s=r.initialize(champ)
    with pytest.raises(ValueError,match='inner_acceptance'):
        r.register(entry('not-ready',letter='b',qualified=False),expected_registry_checksum=s['checksum'])


def test_registry_cannot_switch_formal_model_but_observes_completed_switch():
    _,r,champ,formal=setup();s=r.initialize(champ);candidate=entry('new',letter='b')
    s=r.register(candidate,expected_registry_checksum=s['checksum'])
    with pytest.raises(ValueError,match='switch_not_observed'):
        r.reconcile_champion('new',expected_registry_checksum=s['checksum'])
    assert formal[0]==champ['serving_identity']
    formal[0]=candidate['serving_identity']
    s=r.reconcile_champion('new',expected_registry_checksum=s['checksum'])
    assert s['champion_id']=='new' and champ['entry_id'] in s['entries']


def test_changed_formal_chain_blocks_stale_champion_registration():
    _,r,champ,formal=setup();s=r.initialize(champ);formal[0]={'different':'chain'}
    with pytest.raises(ValueError,match='pointer_changed'):
        r.register(entry('new',letter='b'),expected_registry_checksum=s['checksum'])


def test_entry_and_rules_mutation_are_detected():
    b,r,champ,_=setup();s=r.initialize(champ)
    key=PREFIX+'entries/'+champ['checksum']+'.json';generation,raw=b.objects[key]
    value=json.loads(raw);value['calibration']='linear';b.objects[key]=(generation+1,json.dumps(value).encode())
    with pytest.raises(ValueError,match='checksum'):r.current()
