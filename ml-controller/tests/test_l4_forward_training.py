import copy,unittest
import test_l4_forward_refresh as fixtures
from services.l4_forward_training import merge_materializations,validate_forward_rows

class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.RefreshTests();self.fixture.setUp();result=self.fixture.run_refresh()
        import json
        ref=result['items'][0]['materialization']
        self.body=json.loads(self.fixture.bucket.data[ref['path']])
    def merge(self,bodies):
        return merge_materializations([],bodies,identity={'id':1},feature_schema='test',as_of='2026-10-10')
    def test_forward_keeps_own_identity(self):
        rows,receipts,_=self.merge([self.body]);self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['prediction_kind'],'forward')
        validate_forward_rows(rows,receipts,identity={'id':1},as_of='2026-10-10')
    def test_no_receipt_no_admission(self):
        with self.assertRaisesRegex(ValueError,'receipt_invalid'):
            validate_forward_rows(self.body['rows'],[],identity={'id':1},as_of='2026-10-10')
    def test_pending_old_version_does_not_hide_later_maturity(self):
        older=copy.deepcopy(self.body);older['receipt'].update(cutoff='2026-10-08T10:00:00+08:00',training_eligible=False,status='label_not_yet_mature_at_cutoff')
        rows,_,ledger=self.merge([older,self.body]);self.assertEqual(len(rows),1)
        self.assertEqual(ledger[1]['status'],'duplicate_snapshot')
    def test_label_tampering_rejected(self):
        self.body['rows'][0]['gross_return']=99
        with self.assertRaisesRegex(ValueError,'receipt_invalid'):self.merge([self.body])
    def test_same_cutoff_conflict_rejected(self):
        other=copy.deepcopy(self.body);other['receipt']['rows']=123
        with self.assertRaisesRegex(ValueError,'conflicting_same_cutoff'):self.merge([self.body,other])
    def test_routed_pool_not_implicitly_accepted(self):
        self.body['receipt']['pool_contract']='routed_available_l3_v1'
        with self.assertRaisesRegex(ValueError,'receipt_invalid'):self.merge([self.body])

if __name__=='__main__':unittest.main()
