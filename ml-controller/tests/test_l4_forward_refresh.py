import copy,io,json,sys,unittest
from pathlib import Path
from unittest.mock import patch
from services import l4_forward_refresh as module
from services.l4_forward_materialization import digest

class Blob:
    def __init__(self,owner,key):self.owner,self.key=owner,key
    def exists(self):return self.key in self.owner.data
    def download_as_bytes(self):return self.owner.data[self.key]
    def upload_from_string(self,raw,**kwargs):
        if self.exists():
            from google.api_core.exceptions import PreconditionFailed
            raise PreconditionFailed('already exists')
        self.owner.data[self.key]=raw.encode() if isinstance(raw,str) else raw
class Bucket:
    def __init__(self):self.data={}
    def blob(self,key):return Blob(self,key)

class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.manifest=dict(snapshot_id='test',signal_date='2026-10-01',snapshot_kind='allocation_context',payload_checksum='a'*64)
        rows=[dict(symbol='1101',features={'x':1},l3_baseline={'x':1})]
        self.snapshot=dict(signal_date='2026-10-01',frozen_at='2026-10-01T23:00:00+08:00',
            snapshot_id='test',original_sha256='a'*64,verified_original_sha256='a'*64,
            feature_rows=rows,features_checksum=digest(rows),eligible_symbols=['1101'],
            l3_identity={'id':1},pool_contract=module.NATIVE_POOL,feature_schema='test',coverage_exclusions=[],source_manifest=self.manifest,
            l3_training_label_known_max='2026-09-30')
        self.calendar=['2026-10-01','2026-10-02','2026-10-05','2026-10-06','2026-10-07','2026-10-08']
        self.prices={('2026-10-02','1101'):dict(adj_open=100,source_sha256='b'*64),('2026-10-08','1101'):dict(adj_close=110,source_sha256='b'*64)}
        self.bucket=Bucket();self.reads=0
    def reader(self,sid):
        self.reads+=1
        return dict(manifest=self.manifest)
    def run_refresh(self):
        with patch.object(module,'project',return_value=copy.deepcopy(self.snapshot)):
            return module.refresh(query=lambda *a:[self.manifest],bucket=self.bucket,price_capture={},
                expected_identity={'id':1},cutoff='2026-10-09T10:00:00+08:00',snapshot_reader=self.reader,
                price_loader=lambda *a,**k:(self.calendar,self.prices,{'verified':True}))
    def test_refresh_retry_uses_verified_projection_and_same_receipt(self):
        first=self.run_refresh();second=self.run_refresh()
        self.assertEqual(first,second);self.assertEqual(self.reads,1)
        self.assertEqual(first['latest_training_eligible_date'],'2026-10-01')
        self.assertFalse(first['training_dispatched'])
    def test_routed_data_remains_evaluation_only(self):
        self.snapshot['pool_contract']=module.ROUTED_POOL
        r=self.run_refresh();self.assertEqual(r['latest_mature_evaluation_date'],'2026-10-01')
        self.assertIsNone(r['latest_training_eligible_date'])
    def test_missing_price_not_marked_ready(self):
        self.prices.clear();r=self.run_refresh()
        self.assertIsNone(r['latest_mature_evaluation_date']);self.assertIsNone(r['latest_training_eligible_date'])
        self.assertEqual(r['items'][0]['status'],'incomplete_labels')
    def test_corrupt_cached_projection_visible_failure(self):
        self.run_refresh()
        key=next(k for k in self.bucket.data if '/projections/' in k)
        self.bucket.data[key]=b'{}'
        r=self.run_refresh();self.assertEqual(r['status'],'failed')
        self.assertEqual(r['items'][0]['status'],'failed')
    def test_changed_original_manifest_does_not_reuse_cache(self):
        self.run_refresh();self.manifest['payload_checksum']='b'*64
        self.snapshot['source_manifest']=self.manifest
        self.run_refresh();self.assertEqual(self.reads,2)
    def test_failed_refresh_cannot_certify_daily_completion(self):
        def fail(*a):raise ValueError('l4_forward_daily_price_source_missing')
        result=module.attach_daily_result({'status':'native_l4_daily_accounted'}, {},'2026-10-09',runner=fail)
        self.assertEqual(result['status'],'failed');self.assertTrue(result['dependency_retry_required'])
        self.assertEqual(result['forward_learning_data']['reason'],'l4_forward_daily_price_source_missing')
    def test_callback_keeps_separate_dates_without_full_training_rows(self):
        self.snapshot['pool_contract']=module.ROUTED_POOL
        summary=module.callback_summary(self.run_refresh())
        self.assertEqual(summary['latest_mature_evaluation_date'],'2026-10-01')
        self.assertIsNone(summary['latest_training_eligible_date'])
        self.assertFalse(summary['training_dispatched']);self.assertNotIn('items',summary)
        self.assertEqual(summary['training_blocker_counts'],{'pool_contract_mismatch_evaluation_only':1})

if __name__=='__main__':unittest.main()
