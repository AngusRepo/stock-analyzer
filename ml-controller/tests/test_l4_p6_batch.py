import io
import json
from pathlib import Path
import zipfile
import pytest
from services.l4_p6_batch import seal_inputs
from services.l4_p6_final_inputs import prepare_final
from test_l4_p6_final_inputs import batch


def test_sealed_phases_are_reproducible_and_bound_to_current_inputs(batch,monkeypatch):
    directories,selections,cutoff,out=batch
    source=Path(__file__).resolve().parents[2]
    provenance=dict(l3_identity={'artifact_id':'test-only'},calendar_receipt_sha256='a'*64,
        ancestor_graph_sha256='b'*64,requested_cutoff=cutoff.__dict__)
    seal,raw=seal_inputs(directories[0].parent,phase='cv',source_root=source,provenance=provenance)
    assert (seal,raw)==seal_inputs(directories[0].parent,phase='cv',source_root=source,provenance=provenance)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        assert json.loads(z.read('batch-seal.json'))==seal
        assert '4/arrays.npz' in z.namelist()
        from app.p6_engine import p6_train as engine
        from app.l4_p6_job import extract
        extracted=directories[0].parent.parent/(directories[0].parent.name+'-sealed-cv')
        extracted.mkdir();extract(raw,extracted)
        verify=engine.verify_files
        def checked(root,files,required):
            return verify(source/'ml-service/vendor/tabpack' if str(root)=='\\opt\\tabpack' or str(root)=='/opt/tabpack' else root,files,required)
        monkeypatch.setattr(engine,'verify_files',checked)
        assert engine.verify_inputs(extracted,42,'cv')['batch_id']==seal['batch_id']
        with pytest.raises(ValueError,match='phase_mismatch'):engine.verify_inputs(extracted,42,'final')
        (extracted/'extra.json').write_text('{}')
        with pytest.raises(ValueError,match='unsealed'):engine.verify_inputs(extracted,42,'cv')
    prepare_final(directories,selections=selections,cutoff=cutoff,output=out)
    final,raw_final=seal_inputs(out,phase='final',source_root=source,provenance=provenance)
    assert final['batch_id']!=seal['batch_id'] and raw!=raw_final
    assert final['code_sha256']==seal['code_sha256']
    (out/'arrays.npz').write_bytes(b'changed')
    with pytest.raises(ValueError,match='file_changed'):seal_inputs(out,phase='final',source_root=source,provenance=provenance)
