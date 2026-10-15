import copy
import tempfile
import unittest
from services.l4_forward_materialization import digest, materialize, persist_local

class MaturityTests(unittest.TestCase):
    def setUp(self):
        self.calendar=['2026-10-01','2026-10-02','2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-12']
        self.rows=[dict(symbol='1101',features={'x':1},l3_baseline={'x':1})]
        self.snapshot=dict(signal_date='2026-10-01',frozen_at='2026-10-01T23:00:00+08:00',
            snapshot_id='test',original_sha256='a'*64,verified_original_sha256='a'*64,
            feature_rows=self.rows,features_checksum=digest(self.rows),eligible_symbols=['1101'],
            l3_identity={'id':1},pool_contract='native-v1',feature_schema='test',l3_training_label_known_max='2026-09-30')
        self.prices={('2026-10-02','1101'):dict(adj_open=100,source_sha256='b'*64),
                     ('2026-10-08','1101'):dict(adj_close=110,source_sha256='c'*64)}
    def run_case(self, **overrides):
        args=dict(calendar=self.calendar,prices=self.prices,cutoff='2026-10-09T10:00:00+08:00',
            expected_identity={'id':1},pool_contract='native-v1')
        args.update(overrides)
        return materialize(self.snapshot,**args)
    def test_calendar_five_sessions_and_forward_identity(self):
        rows,r=self.run_case()
        self.assertAlmostEqual(rows[0]['gross_return'],.1)
        self.assertEqual(rows[0]['label_known_date'],'2026-10-08')
        self.assertEqual(rows[0]['prediction_kind'],'forward')
        self.assertTrue(r['training_eligible'])
    def test_same_day_label_never_assumed_available(self):
        _,r=self.run_case(cutoff='2026-10-08T23:59:59+08:00')
        self.assertEqual(r['status'],'label_not_yet_mature_at_cutoff')
    def test_late_capture_rejected_even_before_label_matures(self):
        self.snapshot['frozen_at']='2026-10-02T09:00:00+08:00'
        self.assertEqual(self.run_case()[1]['status'],'prediction_sealed_after_entry')
    def test_missing_price_blocks_full_pool_training(self):
        self.prices.pop(('2026-10-08','1101'))
        rows,r=self.run_case()
        self.assertFalse(r['training_eligible']);self.assertEqual(rows,[])
        self.assertEqual(r['status'],'incomplete_labels')
    def test_routed_pool_not_mixed_with_native_pool(self):
        self.snapshot['pool_contract']='routed-v1'
        rows,r=self.run_case();self.assertEqual(len(rows),1)
        self.assertFalse(r['training_eligible'])
    def test_foreign_identity_rejected(self):
        self.assertEqual(self.run_case(expected_identity={'id':2})[1]['status'],'incompatible_l3_identity')
    def test_projection_tampering_rejected(self):
        self.snapshot['feature_rows'][0]['features']['x']=2
        with self.assertRaisesRegex(ValueError,'checksum'): self.run_case()
    def test_immutable_idempotent_publication(self):
        rows,r=self.run_case()
        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(persist_local(temp,rows,r),persist_local(temp,rows,r))

if __name__=='__main__':unittest.main()
