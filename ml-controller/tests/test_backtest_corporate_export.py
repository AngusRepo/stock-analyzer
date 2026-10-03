from copy import deepcopy
import pytest
from services.backtest_corporate_export import export_original_corporate_records
from services.paired_nav_journal import digest


def receipt():
    identity={'owner':'paper-corporate-source-v1','session_date':'2026-09-24','scope_id':'paper-account-1'}
    snapshot={'schema_version':'paper-corporate-source-v1','session_date':'2026-09-24',
        'covered_symbols':['2330'],'actions':[],'blockers':{},'source_checksum':'a'*64,
        'tax_basis':'gross_before_personal_tax','observed_at':'2026-09-24T00:00:00+00:00'}
    return {'identity':identity,'request':{'symbols':['2330'],'outstanding_action_ids':[]},
        'snapshot':snapshot,'snapshot_checksum':digest(snapshot),'captured_at':'2026-09-24T00:01:00+00:00'}


class Objects:
    def __init__(self,r):self.record=r
    def lookup_delivery(self,key):return 'original' if key==digest(self.record['identity']) else None
    def get(self,key):return deepcopy(self.record)


def test_original_receipt_and_missing_dates_are_preserved():
    import json
    row=receipt();frame=export_original_corporate_records(['2026-09-23','2026-09-24'],objects=Objects(row))
    assert frame.height==1 and json.loads(frame['record_json'][0])==row


def test_late_or_corrupt_receipt_cannot_be_backdated():
    row=receipt();row['captured_at']='2026-09-24T02:00:00+00:00'
    with pytest.raises(ValueError,match='not_original_preopen'):
        export_original_corporate_records(['2026-09-24'],objects=Objects(row))
    row=receipt();row['snapshot_checksum']='wrong'
    with pytest.raises(ValueError,match='identity_invalid'):
        export_original_corporate_records(['2026-09-24'],objects=Objects(row))
