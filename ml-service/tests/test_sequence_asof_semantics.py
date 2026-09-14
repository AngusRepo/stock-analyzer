import numpy as np
import pytest
from app.sequence_training import forecast_return_from_signal_close
from app.neuralforecast_sequence_runtime import _dense_oof_eval_panel


def test_signal_score_is_invariant_to_future_execution_price():
    price, signal_close = np.array([105., 98.]), np.array([100., 100.])
    np.testing.assert_allclose(forecast_return_from_signal_close(price, signal_close), [.05, -.02])
    # Reconstruct cached forecast prices: future entry cancels algebraically.
    for entry in [np.array([80., 120.]), np.array([110., 90.])]:
        legacy_net = price / entry - 1 - .0018
        recovered = (legacy_net + 1 + .0018) * entry
        np.testing.assert_allclose(forecast_return_from_signal_close(recovered, signal_close), [.05, -.02])


def test_latest_signal_keeps_context_without_any_future_rows():
    calendar = [f"2026-01-{d:02}" for d in range(1, 7)]
    record = {"symbol": "A", "dates": calendar, "close": [100.,101.,102.,103.,104.,105.], "open": [99.]*6}
    context, labels = _dense_oof_eval_panel([record],calendar=calendar,signal_date=calendar[-1],seq_len=4,pred_len=2)
    assert len(context)==4 and context[-1]["y"]==105. and labels==[]
    extended = [*calendar,"2026-01-07","2026-01-08"]
    future = {**record,"dates":extended,"close":[*record["close"],200.,300.],"open":[*record["open"],500.,600.]}
    context_after, labels_after = _dense_oof_eval_panel([future],calendar=extended,signal_date=calendar[-1],seq_len=4,pred_len=2)
    assert context_after==context
    assert labels_after[0]["last_close"]==105. and labels_after[0]["entry_open"]==500.


def test_invalid_signal_anchor_is_rejected():
    with pytest.raises(ValueError,match="signal_close"):
        forecast_return_from_signal_close(np.array([1.]),np.array([0.]))


def test_outer_test_prices_cannot_choose_dlinear_checkpoint():
    import torch
    from datetime import date, timedelta
    from app.dlinear_universal import train_dlinear
    dates=[str(date(2026,1,1)+timedelta(days=i)) for i in range(40)]
    records=[{"symbol":str(i),"market_type":"LISTED","dates":dates,"close":[100.+i+j*.2+np.sin(j) for j in range(40)],"open":[100.+i+j*.2 for j in range(40)]} for i in range(3)]
    changed=[{**r,"close":[v if j<28 else v*(2+j*.1) for j,v in enumerate(r["close"])],"open":[v if j<28 else v*.5 for j,v in enumerate(r["open"])]} for r in records]
    kwargs=dict(series_close=[],seq_len=4,pred_len=2,kernel=3,n_epochs=3,batch_size=16,device="cpu",train_start=dates[4],train_end=dates[24],test_start=dates[28],test_end=dates[35],seed=42)
    a=train_dlinear(sequence_records=records,**kwargs)
    b=train_dlinear(sequence_records=changed,**kwargs)
    assert a["metadata"]["checkpoint_selection"]=="fixed_final_epoch_outer_test_monitor_only"
    assert all(torch.equal(value,b["_state_dict_torch"][key]) for key,value in a["_state_dict_torch"].items())


@pytest.mark.parametrize("unmatured_only", [False, True])
def test_dense_fold_persists_latest_predictions_and_replay_weights(monkeypatch, unmatured_only):
    monkeypatch.setenv("STOCKVISION_SOURCE_SHA", "1" * 40)
    import json
    from pathlib import Path
    from app import neuralforecast_sequence_runtime as rt
    class Bucket:
        def __init__(self):self.values={}
        def blob(self,name):
            owner=self
            class Blob:
                def exists(self):return name in owner.values
                def upload_from_string(self,value,**kwargs):owner.values[name]=value.encode() if isinstance(value,str) else value
                def download_as_bytes(self):return owner.values[name]
                def download_as_text(self):return self.download_as_bytes().decode()
            return Blob()
    class NF:
        def save(self,path,**kwargs):
            Path(path).mkdir();(Path(path)/"fitted.ckpt").write_bytes(b"fitted-only-on-prior-history")
    calendar=[f"2026-01-{d:02}" for d in range(1,13)]
    rows=[{"symbol":str(i),"dates":calendar,"open":[100.]*12,"close":[100.+j for j in range(12)]} for i in range(12)]
    bucket=Bucket();bucket.values['local/prep/symbol_market.json']=json.dumps({r['symbol']:'LISTED' for r in rows}).encode()
    monkeypatch.setattr(rt,'_train_nf',lambda *args,**kwargs:(NF(),None))
    monkeypatch.setattr(rt,'_predict_horizon_by_id_with_column',lambda nf,df,**kwargs:({str(s):115. for s in df['unique_id'].unique()},'PatchTST'))
    result=rt._train_dense_purged_oof({'cohort_id':'test','fold_id':'w0','train_start':calendar[0],'train_end':calendar[7],'test_start':calendar[10] if unmatured_only else calendar[8],'test_end':calendar[-1]},model_name='PatchTST',cfg={'nf_model_name':'PatchTST'},bucket=bucket,records=rows,version='test',seq_len=4,pred_len=2,max_steps=2,batch_size=12,seed=42,max_series=20,gcs_prefix='local',training_options={'oof_training_history_mode':'full_pit_history'})
    artifact=result['asof_prediction_artifact'];persisted=json.loads(bucket.values[artifact['path']])
    assert artifact['rows']==(24 if unmatured_only else 48)
    assert result['metrics']['oos_samples']==(0 if unmatured_only else 24)
    if unmatured_only:assert result['oof_artifact'] is None
    latest=[r for r in persisted['rows'] if r['date']==calendar[-1]]
    assert len(latest)==12 and persisted['future_labels_required'] is False
    assert latest[0]['raw_score']==pytest.approx(115./111.-1)
    assert result['fold_model_artifact']['path'] in bucket.values
