import json
import pytest
from app.timexer_contract import ARCHITECTURE,OFFICIAL_COMMIT,SCHEMA,SCORE_SEMANTIC

@pytest.mark.parametrize("entry",["daily","forward"])
@pytest.mark.parametrize("matching",[True,False])
def test_registry_digest_matches_immutable_sidecar_before_feature_or_weight_reads(monkeypatch,entry,matching):
    import torch
    from app import timexer_inference,timexer_forward
    metadata={"schema_version":SCHEMA+"-metadata","version":"v1","checksum":"a"*64,
      "artifact_path":"model.pt","seq_len":168,"pred_len":5,"raw_score_semantic_version":SCORE_SEMANTIC,
      "train_range":["2025-01-01","2026-09-11"],"training_label_known_max":"2026-09-11",
      "timexer":{"variant":"price","official_commit":OFFICIAL_COMMIT,"architecture":ARCHITECTURE,
      "inference_device":"cuda","matmul_precision":"high","feature_history_schema":"formal137-pit-asof-source-quality-v3",
      "max_exogenous_staleness_sessions":1}}
    reads=[]
    class Blob:
        def __init__(self,key):self.key=key
        def download_as_bytes(self):
            reads.append(self.key)
            if self.key=="metadata.json":return json.dumps(metadata).encode()
            assert self.key.endswith("immutable_receipt.json")
            return json.dumps({"business_date":"2026-09-18"}).encode()
    class Bucket:
        def blob(self,key):return Blob(key)
    class FeatureBoundaryReached(Exception):pass
    def stop(*a,**k):raise FeatureBoundaryReached()
    monkeypatch.setattr(torch.cuda,"is_available",lambda:True)
    monkeypatch.setattr(timexer_inference,"feature_receipt",stop)
    identity={"model":"TimeXer","version":"v1","artifact_id":"TimeXer:v1","metadata_path":"metadata.json",
              "artifact_path":"model.pt","checksum":"sha256:"+("a" if matching else "b")*64}
    def run():
        if entry=="daily":return timexer_inference.batch_predict(series_list=[],artifact_identity=identity,
            feature_source={},signal_date="2026-09-18",version="v1",bucket=Bucket())
        return timexer_forward.predict_forward(bucket=Bucket(),prep={"source_gcs_prefix":"source","source_receipt_checksum":"c"*64},
            sequence={},rows={},source=identity,train_end="2026-09-11")
    with pytest.raises(FeatureBoundaryReached if matching else ValueError,match=None if matching else "identity_mismatch"):
        run()
    assert "model.pt" not in reads
    if not matching:assert reads==["metadata.json"]
