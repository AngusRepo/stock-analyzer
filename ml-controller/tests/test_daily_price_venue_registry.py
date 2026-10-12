import copy
import hashlib
import json
from pathlib import Path

import pytest
from services import training_price_venue_scope as scope
from test_training_price_venue_scope import scope_fixture


def daily_manifest():
    return {"schema_version":"finlab-adjusted-price-single-capture-v1",
            "capture_id":"daily-20261012", "end_date":"2026-10-12",
            "checksums":{"close":"a"*64,"adj_close":"b"*64}}


def test_registry_is_exact_reviewed_announcements_bound_to_each_capture():
    m=daily_manifest(); before=copy.deepcopy(m)
    entries,sha=scope.resolve_scope(m)
    assert set(entries)=={"7855","7814","7825","6947","7689","2237"}
    assert entries["7855"]["listed_from"]=="2026-08-11"
    assert m==before  # Existing immutable manifest is never patched.
    for key,value in (("capture_id","next"),("end_date","2026-10-13"),("checksums",{"close":"c"*64})):
        changed={**m,key:value}
        assert scope.resolve_scope(changed)[1]!=sha
    assert scope.resolve_scope({**m,"end_date":"2026-10-08"})==({},None)


def test_registry_cannot_hide_post_listing_loss_or_wrong_market():
    entry=scope.resolve_scope(daily_manifest())[0]["7855"]
    old=[{"date":"2026-08-10"},{"date":"2026-08-11"},{"date":"2026-08-12"}]
    rows=old[1:]
    count,proof=scope.compare_prior_scope(entry,symbol="7855",market="TWSE",previous=old,rows=rows)
    assert count==2 and proof["pre_listing_rows_excluded_from_comparison"]==1
    with pytest.raises(ValueError,match="lost_post_listing"):
        scope.compare_prior_scope(entry,symbol="7855",market="TWSE",previous=old,rows=rows[:1])
    with pytest.raises(ValueError,match="owner_mismatch"):
        scope.compare_prior_scope(entry,symbol="7855",market="OTC",previous=old,rows=rows)


def test_producer_seals_same_scope_as_existing_daily_reader(tmp_path):
    m=daily_manifest();path=tmp_path/"raw/daily_price_full_vintage/manifest.json"
    path.parent.mkdir(parents=True);path.write_text(json.dumps(m))
    expected=scope.resolve_scope(m)
    scope.seal_daily_scope(tmp_path)
    raw=path.read_bytes();sealed=json.loads(raw)
    assert sealed["checksums"]==m["checksums"]
    assert scope.scope_from_manifest(sealed)==expected
    scope.seal_daily_scope(tmp_path)
    assert path.read_bytes()==raw


def test_corrupt_sealed_scope_does_not_fall_back_to_registry():
    _,m,s,_=scope_fixture()
    m["prior_venue_scope_sha256"]="0"*64
    with pytest.raises(ValueError,match="manifest_mismatch"):scope.resolve_scope(m)


def test_registry_checksum_mismatch_rejected(monkeypatch):
    monkeypatch.setattr(scope,"REGISTRY_SHA256","0"*64)
    with pytest.raises(ValueError,match="registry_checksum"):scope.resolve_scope(daily_manifest())


def test_explicit_scope_is_not_replaced():
    _,m,s,_=scope_fixture()
    assert scope.resolve_scope(m)==scope.scope_from_manifest(m)


def test_actual_daily_materializer_automatically_seals_registry(monkeypatch,tmp_path):
    import pandas as pd
    import services.finlab_sealed_raw as sealed
    from test_finlab_remote_backfill_tool_contract import _load_tool_module
    tool=_load_tool_module()
    source=pd.DataFrame({str(s):[100.,101.] for s in range(3000,3100)},index=pd.to_datetime(['2026-10-08','2026-10-12']))
    class Source:
        binding={'test_only':'synthetic daily source; no SDK or cloud calls'}
        def __init__(self,*a,**kw):pass
        def get(self,key):return source.copy()
    monkeypatch.setattr(sealed,'SealedDailySource',Source)
    monkeypatch.setattr(tool,'d1_counts',lambda start:{})
    monkeypatch.setattr(tool,'start_date_for_years',lambda years:'2026-09-01')
    monkeypatch.setattr(tool,'write_official_training_calendar',lambda **kw:None)
    monkeypatch.setattr(tool,'write_training_breadth_capture',lambda **kw:None)
    monkeypatch.setattr(tool.time,'sleep',lambda seconds:None)
    run=tmp_path/'daily'
    tool.materialize_specs(years=4,run_dir=run,lanes=['daily_price'],source_start_date='2026-10-08',source_end_date='2026-10-12',
        sealed_raw_root='synthetic',sealed_raw_receipt_sha256='a'*64,daily_refresh=True)
    m=json.loads((run/'raw/daily_price_full_vintage/manifest.json').read_bytes())
    entries,sha=scope.scope_from_manifest(m)
    assert '7855' in entries and sha
    assert m['prior_venue_scope']['capture_id']=='daily'
    assert m['prior_venue_scope']['price_checksums']==m['checksums']
