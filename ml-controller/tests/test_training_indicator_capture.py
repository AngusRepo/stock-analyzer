from datetime import date,timedelta
import pytest
from services.training_indicator_capture import rebuild_capture_indicators

def bars(n):
    return [{"date":str(date(2024,1,1)+timedelta(days=i)),"close":100+i/3+(-1)**i,"high":102+i/3,"low":98+i/3,"volume":100+i} for i in range(n)]

def test_actual_worker_causal_owner_and_warmup():
    data=bars(90)
    full,proof=rebuild_capture_indicators({1:data})
    prefix,_=rebuild_capture_indicators({1:data[:75]})
    assert prefix[1]==full[1][:56]
    assert len(full[1])==71 and proof["rows"]==71
    assert all(r[k] is not None for r in full[1] for k in ("plusDi14","minusDi14","adx14","parabolicSar"))
    tail,_=rebuild_capture_indicators({1:data[-70:]})
    assert tail[1][-1]==full[1][-1]
    assert len(proof["formula_sha256"])==64

@pytest.mark.parametrize("kind",["duplicate","reverse","nan"])
def test_bad_input_rejected(kind):
    rows=bars(30)
    if kind=="duplicate":rows.append(rows[-1])
    elif kind=="reverse":rows.reverse()
    else:rows[-1]["close"]=float("nan")
    with pytest.raises(ValueError):rebuild_capture_indicators({1:rows})

def test_missing_owner_never_silently_falls_back(monkeypatch):
    monkeypatch.setenv("TRAINING_INDICATOR_MODULE","missing-source-owner.js")
    with pytest.raises(ValueError,match="training_indicator_owner_failed"):
        rebuild_capture_indicators({1:bars(30)})
