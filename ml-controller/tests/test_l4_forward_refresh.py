import copy,io,json,sys,unittest
from pathlib import Path
from unittest.mock import patch
from services import l4_forward_refresh as module
from services.l4_forward_materialization import digest

class Blob:
    generation=1
    def __init__(self,owner,key):self.owner,self.key,self.name=owner,key,key
    def exists(self):return self.key in self.owner.data
    def download_as_bytes(self,**kwargs):return self.owner.data[self.key]
    def upload_from_string(self,raw,**kwargs):
        if self.exists():
            from google.api_core.exceptions import PreconditionFailed
            raise PreconditionFailed('already exists')
        self.owner.data[self.key]=raw.encode() if isinstance(raw,str) else raw
class Bucket:
    def __init__(self):self.data={}
    def blob(self,key):return Blob(self,key)
    def list_blobs(self,prefix):return [Blob(self,k) for k in sorted(self.data) if k.startswith(prefix)]

class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.manifest=dict(snapshot_id='test',signal_date='2026-10-01',snapshot_kind='allocation_context',payload_checksum='a'*64)
        rows=[dict(symbol='1101',features={'x':1},l3_baseline={'x':1})]
        self.snapshot=dict(signal_date='2026-10-01',frozen_at='2026-10-01T23:00:00+08:00',
            snapshot_id='test',original_sha256='a'*64,verified_original_sha256='a'*64,
            feature_rows=rows,features_checksum=digest(rows),eligible_symbols=['1101'],
            l3_identity={'id':1},pool_contract=module.NATIVE_POOL,feature_schema='test',coverage_exclusions=[],source_manifest=self.manifest,
            l3_training_label_known_max='2026-09-30')
        self.r33_manifest=dict(snapshot_id='r33',signal_date='2026-10-02',snapshot_kind='allocation_context',payload_checksum='c'*64)
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
    def test_excluded_refresh_leaves_daily_closure_alone(self):
        result=module.attach_daily_result({'status':'native_l4_daily_accounted'},{},'2026-11-20',
            runner=lambda *a:{'status':'refreshed_with_exclusions','excluded_signal_dates':['2026-11-20']})
        self.assertEqual(result['status'],'native_l4_daily_accounted');self.assertNotIn('dependency_retry_required',result)
    def test_callback_keeps_separate_dates_without_full_training_rows(self):
        self.snapshot['pool_contract']=module.ROUTED_POOL
        summary=module.callback_summary(self.run_refresh())
        self.assertEqual(summary['latest_mature_evaluation_date'],'2026-10-01')
        self.assertIsNone(summary['latest_training_eligible_date'])
        self.assertFalse(summary['training_dispatched']);self.assertNotIn('items',summary)
        self.assertEqual(summary['training_blocker_counts'],{'pool_contract_mismatch_evaluation_only':1})
    def test_failure_carries_redacted_exception_summary(self):
        token='AbCdEf0123456789GhIjKl0123456789MnOp'
        self.run_refresh();key=next(k for k in self.bucket.data if '/projections/' in k);self.bucket.data[key]=b'{}'
        r=self.run_refresh();item=r['items'][0]
        self.assertEqual((item['error_type'],item['error_summary']),('ValueError','l4_forward_projection_hash'))
        self.assertEqual(module.callback_summary(r)['failure_samples'],[{'signal_date':'2026-10-01',
            'reason':'l4_forward_source_or_maturity_failed','error_type':'ValueError','error_summary':'l4_forward_projection_hash'}])
        with patch.dict('os.environ',{'CF_API_TOKEN':'plain-secret-value'}):
            text=module.error_summary(RuntimeError(
                f'HTTP 403 plain-secret-value Bearer {token} https://storage.googleapis.com/b/o?X-Goog-Signature=abc '
                f'api_key={token[:10]} token: {token} gs://bucket/l4_distribution/forward_data/v1/{"a"*64}.json '
                'l4_forward_daily_price_source_missing'))
        for secret in ('plain-secret-value',token,token[:10],'abc'):self.assertNotIn(secret,text)
        self.assertIn('a'*64,text);self.assertIn('l4_forward_daily_price_source_missing',text)
        self.assertLessEqual(len(module.error_summary(RuntimeError('x'*999))),300)
    def run_failing_projection(self,sha,reader=None,error=None):
        def boom(frozen):raise error or KeyError('feature_rows')
        with patch.dict('os.environ',{'STOCKVISION_SOURCE_SHA':sha}),patch.object(module,'project',side_effect=boom):
            return module.refresh(query=lambda *a:[self.manifest],bucket=self.bucket,price_capture={},
                expected_identity={'id':1},cutoff='2026-10-09T10:00:00+08:00',snapshot_reader=reader or self.reader,
                price_loader=lambda *a,**k:(self.calendar,self.prices,{'verified':True}))
    def test_projection_failure_is_remembered_per_deploy(self):
        first=self.run_failing_projection('sha1');second=self.run_failing_projection('sha1')
        self.assertEqual(self.reads,1);self.assertEqual(first,second)
        self.assertEqual(first['items'][0]['status'],'failed');self.assertEqual(first['items'][0]['error_type'],'KeyError')
        self.run_failing_projection('sha2');self.assertEqual(self.reads,2)
    def test_resource_exhaustion_is_not_remembered(self):
        for error in (MemoryError(),RecursionError('depth')):
            self.reads=0
            self.run_failing_projection('sha1',error=error);r=self.run_failing_projection('sha1',error=error)
            self.assertEqual(self.reads,2);self.assertEqual(r['items'][0]['error_type'],type(error).__name__)
            self.assertFalse([k for k in self.bucket.data if 'projection_failures' in k])
    def test_projection_failure_not_remembered_without_source_sha(self):
        self.run_failing_projection('');self.run_failing_projection('')
        self.assertEqual(self.reads,2);self.assertFalse([k for k in self.bucket.data if 'projection_failures' in k])
    def test_read_failure_is_not_remembered(self):
        def broken(sid):
            self.reads+=1;raise OSError('gcs read reset')
        self.run_failing_projection('sha1',broken);r=self.run_failing_projection('sha1',broken)
        self.assertEqual(self.reads,2);self.assertEqual(r['items'][0]['error_type'],'OSError')
        self.assertFalse([k for k in self.bucket.data if 'projection_failures' in k])
    def test_new_snapshot_checksum_retries_after_remembered_failure(self):
        self.run_failing_projection('sha1');self.manifest['payload_checksum']='b'*64
        self.run_failing_projection('sha1');self.assertEqual(self.reads,2)
        self.snapshot['source_manifest']=self.manifest
        with patch.dict('os.environ',{'STOCKVISION_SOURCE_SHA':'sha2'}):r=self.run_refresh()  # fixed deploy
        self.assertEqual(self.reads,3);self.assertNotEqual(r['items'][0]['status'],'failed')
    def test_manifest_row_change_retries_remembered_failure(self):
        self.run_failing_projection('sha1');self.manifest['frozen_at']='2026-10-01T23:30:00+08:00'
        self.run_failing_projection('sha1');self.assertEqual(self.reads,2)
    def test_marker_upload_failure_keeps_projection_error(self):
        upload=Blob.upload_from_string
        def denied(blob,raw,**kwargs):
            if 'projection_failures' in blob.key:raise PermissionError('403 forbidden')
            return upload(blob,raw,**kwargs)
        with patch.object(Blob,'upload_from_string',denied):r=self.run_failing_projection('sha1')
        self.assertEqual(r['items'][0]['error_type'],'KeyError')
        self.run_failing_projection('sha1');self.assertEqual(self.reads,2)
    def test_attach_daily_result_keeps_summary(self):
        def fail(*a):raise RuntimeError('boom detail')
        data=module.attach_daily_result({},{},'2026-10-09',runner=fail)['forward_learning_data']
        self.assertEqual((data['reason'],data['error_summary']),('l4_forward_refresh_failed','boom detail'))
        self.assertEqual(module.callback_summary(data)['error_summary'],'boom detail')
    def test_error_summary_masks_quoted_keys_auth_and_padded_env(self):
        with patch.dict('os.environ',{'STOCKVISION_AUTH_TOKEN':'0123456789abcdef'*4+'\n'}):
            text=module.error_summary(RuntimeError(
                "{'api_key': 'hunter2hunter2'} {\"password\": \"p@ss w0rd\"} Authorization: Basic dXNlcjpwYXNz "
                +'0123456789abcdef'*4+' l4_forward_projection_hash'))
        for secret in ('hunter2hunter2','p@ss','w0rd','dXNlcjpwYXNz','0123456789abcdef'):self.assertNotIn(secret,text)
        self.assertIn('l4_forward_projection_hash',text)
    def test_error_summary_is_bounded_on_long_tokens(self):
        import time
        started=time.monotonic();text=module.error_summary(RuntimeError('A1'*30000))
        self.assertLess(time.monotonic()-started,1.0);self.assertLessEqual(len(text),300)
    def r33_frozen(self,*,pool=True,runtime=2):
        """Sealed markers only; the roster is deliberately not core4 and not R33_MODELS."""
        predictions={s:dict(ensemble_v2=dict(schema_version='r33-roster-runtime-v1' if i<runtime else 'active8-v2',model_order=['GNN']))
            for i,s in enumerate(('2317','2330'))}
        state=dict(l3_identity={'id':2},predictions=predictions)
        if pool:state['r33_rank_pool']=dict(schema_version='r33-attested-rank-pool-v1')
        return dict(manifest=self.r33_manifest,payload=dict(content=dict(model_predictions=predictions,
            inputs=dict(alpha_policy=dict(l4Distribution=dict(runtime=state))))))
    def run_mixed(self,sha='sha1',frozen=None):
        frozen=frozen or self.r33_frozen();real=module.project;self.r33_reads=0
        def reader(sid):
            if sid!='r33':return self.reader(sid)
            self.r33_reads+=1;return frozen
        def project(value):  # R33 goes through the real projection; legacy keeps its fixture
            return real(value) if value['manifest']['snapshot_id']=='r33' else copy.deepcopy(self.snapshot)
        with patch.dict('os.environ',{'STOCKVISION_SOURCE_SHA':sha}),patch.object(module,'project',project):
            return module.refresh(query=lambda *a:[self.manifest,self.r33_manifest],bucket=self.bucket,price_capture={},
                expected_identity={'id':1},cutoff='2026-10-09T10:00:00+08:00',snapshot_reader=reader,
                price_loader=lambda *a,**k:(self.calendar,self.prices,{'verified':True}))
    def keys(self,kind):return [k for k in self.bucket.data if '/'+kind+'/' in k]
    def test_r33_snapshot_is_excluded_not_failed(self):
        legacy=self.run_refresh()['items'][0];self.bucket=Bucket()
        r=self.run_mixed();by={i['snapshot_id']:i for i in r['items']}
        self.assertEqual(r['status'],'refreshed_with_exclusions')
        self.assertEqual(by['r33'],dict(snapshot_id='r33',signal_date='2026-10-02',status='excluded',
            reason='r33_forward_projection_not_implemented',training_eligible=False))
        self.assertEqual(by['test'],legacy);self.assertEqual(r['latest_training_eligible_date'],'2026-10-01')
        self.assertEqual((r['excluded_signal_dates'],r['excluded_counts']),(['2026-10-02'],{'r33_forward_projection_not_implemented':1}))
        self.assertFalse(self.keys('projection_failures'));self.assertEqual(len(self.keys('projection_index')),1)
        self.assertEqual(len(self.keys('projection_exclusions')),1)
        summary=module.callback_summary(r)
        self.assertEqual((summary['status'],summary['excluded_signal_dates']),('refreshed_with_exclusions',['2026-10-02']))
        self.assertEqual(summary['status_counts'],{'ready':1,'excluded':1})
        from oof_materialize_job_main import _summary
        line=_summary('r',{'status':'native_l4_daily_accounted','forward_learning_data':r},mode='oof_lifecycle')
        self.assertIn('forward_data=refreshed_with_exclusions',line);self.assertIn('forward_excluded=2026-10-02',line)
    def test_r33_marker_inconsistency_fails_closed(self):
        for frozen in (self.r33_frozen(runtime=0),self.r33_frozen(runtime=1),self.r33_frozen(pool=False)):
            self.bucket=Bucket();r=self.run_mixed(frozen=frozen);item=r['items'][1]
            self.assertEqual(r['status'],'failed')
            self.assertEqual((item['status'],item['error_summary']),('failed','l4_forward_r33_snapshot_inconsistent'))
            self.assertFalse(self.keys('projection_exclusions'))
        self.assertFalse(module._is_r33_snapshot({},{'1101':dict(ensemble_v2=dict(schema_version='active8-v2'))}))
    def test_registry_reader_skips_excluded_items(self):
        from services.l4_forward_training import load_current_registry
        self.run_mixed()
        bodies,registry=load_current_registry(self.bucket,cutoff='2026-10-09T10:00:00+08:00')
        self.assertEqual([b['receipt']['snapshot_id'] for b in bodies],['test'])
        self.assertEqual(registry['excluded'],[dict(snapshot_id='r33',signal_date='2026-10-02',reason='r33_forward_projection_not_implemented')])
    def test_exclusion_cache_retries_on_new_deploy(self):
        self.run_mixed('sha1');r=self.run_mixed('sha1')
        self.assertEqual(self.r33_reads,0);self.assertEqual(r['items'][1]['status'],'excluded')
        self.run_mixed('sha2');self.assertEqual(self.r33_reads,1)  # a new deploy may carry the R33 projection
        self.run_mixed('');self.assertEqual(self.r33_reads,1)
        self.assertEqual(len(self.keys('projection_exclusions')),2)

if __name__=='__main__':unittest.main()
