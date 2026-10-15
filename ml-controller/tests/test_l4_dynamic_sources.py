import copy,json,unittest
import polars as pl
import test_l4_forward_refresh as fixtures
from services.l4_r2_sources import resolve,verified_slice


class DynamicSourcesTests(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.RefreshTests();self.fixture.setUp()
        result=self.fixture.run_refresh()
        self.body=json.loads(self.fixture.bucket.data[result['items'][0]['materialization']['path']])
        self.native=copy.deepcopy(self.body['rows'][0]);self.native.update(date='2026-09-29',prediction_kind='oof')
        self.native.pop('source')
        self.calls=0
    def resolve(self,bodies):
        def discover(bucket):self.calls+=1;return ['current_registry']
        return resolve(bucket=None,identity={'id':1},feature_schema='test',cutoff='2026-10-10T10:00:00+08:00',
            work='unused',discover=discover,prepare=lambda *a,**k:(pl.DataFrame([self.native]),{}),
            forward=lambda *a,**k:(bodies,{'status':'verified'}),
            classify=lambda f:(f,dict(policy='historical_source_universe_official_non_etf_equity_v1',evidence_sha256='a'*64)))
    def test_new_mature_signal_advances_without_mutating_oof(self):
        _,old=self.resolve([]);rows,new=self.resolve([self.body])
        self.assertEqual(self.calls,2)
        self.assertEqual(old['source_max_signal_date'],'2026-09-29')
        self.assertEqual(new['source_max_signal_date'],'2026-10-01')
        self.assertEqual(new['prediction_kind_counts'],{'oof':1,'forward':1})
        selected,proof=verified_slice(rows,new,dates=['2026-10-01'],as_of='2026-10-10')
        self.assertEqual(selected[0]['prediction_kind'],'forward');self.assertEqual(len(proof),1)
        self.assertFalse(new['training_started'])
    def test_row_tamper_or_missing_date_rejected(self):
        rows,receipt=self.resolve([self.body])
        with self.assertRaisesRegex(ValueError,'requested_date_missing'):
            verified_slice(rows,receipt,dates=['2026-10-02'],as_of='2026-10-10')
        rows[0]['gross_return']=10
        with self.assertRaisesRegex(ValueError,'source_rows_changed'):
            verified_slice(rows,receipt,dates=['2026-10-01'],as_of='2026-10-10')

if __name__=='__main__':unittest.main()
