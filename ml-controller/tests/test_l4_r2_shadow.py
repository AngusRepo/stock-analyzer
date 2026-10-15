import hashlib,io,sys,unittest
from pathlib import Path
import numpy as np
from services.l4_r2_shadow import infer_seed,validate

class ShadowTests(unittest.TestCase):
    def fixture(self):
        arrays={}
        for m in range(2):
            w=np.zeros((34,384),np.float32);w[0,0]=1
            out=np.zeros((384,1),np.float32);out[0,0]=m+1
            arrays.update({f'm{m}_l0_weight':w,f'm{m}_l0_bias':np.zeros(384,np.float32),
                f'm{m}_l1_weight':out,f'm{m}_l1_bias':np.zeros(1,np.float32)})
        buffer=io.BytesIO();np.savez_compressed(buffer,**arrays);raw=buffer.getvalue()
        seed=dict(weights={'sha256':hashlib.sha256(raw).hexdigest()},target_mean=.01,target_scale=.1,
            members=[dict(depth=1,weight=.25),dict(depth=1,weight=.75)])
        return seed,raw
    def test_weighted_export_and_target_units(self):
        seed,raw=self.fixture();x=np.zeros((3,34),np.float32);x[:,0]=[-1,0,2]
        np.testing.assert_allclose(infer_seed(x,seed,raw),[.01,.01,.36],rtol=1e-6)
    def test_tampered_export_rejected(self):
        seed,raw=self.fixture()
        with self.assertRaisesRegex(ValueError,'weight_hash'):infer_seed(np.zeros((1,34),np.float32),seed,raw+b'x')

    def bundle(self):
        from services import l4_distribution as native
        from services.alpha_model_roster import TIMEXER_MODELS
        seed,_=self.fixture()
        seed['members']=[dict(depth=1,weight=1.,member_id=0,epoch=1)]
        seed['final_recipe']=dict(native=dict(names=native.feature_names(TIMEXER_MODELS),mean=[0.]*30,scale=[1.]*30),
            head_names=['p_loss','gain','loss','expected_return_gross'],mean=[0.]*4,scale=[1.]*4)
        result=dict(schema_version='l4-r2-shadow-v1',l3_identity={'id':1},
            feature_schema=native.feature_schema(TIMEXER_MODELS),source_pool='native_non_etf_equity_v1',
            production_enabled=False,training_label_known_max='2026-10-07',calibration={'w':.5,'b':.2},
            seeds=[dict(seed,seed=s) for s in (42,43,44)])
        return self.seal(result)

    def seal(self,bundle):
        from services.l4_distribution import digest
        bundle['payload_checksum']=digest({k:v for k,v in bundle.items() if k!='payload_checksum'})
        return bundle

    def test_future_training_cutoff_or_other_l3_cannot_run(self):
        bundle=self.bundle()
        validate(bundle,identity={'id':1},signal_date='2026-10-15')
        with self.assertRaisesRegex(ValueError,'training_after_decision'):
            validate(bundle,identity={'id':1},signal_date='2026-10-07')
        with self.assertRaisesRegex(ValueError,'contract_invalid'):
            validate(bundle,identity={'id':2},signal_date='2026-10-15')

    def test_wrong_native_scaler_rejected_before_inference(self):
        bundle=self.bundle();bundle['seeds'][0]['final_recipe']['native']['scale'][0]=0
        with self.assertRaisesRegex(ValueError,'native_normalizer_invalid'):
            validate(self.seal(bundle),identity={'id':1},signal_date='2026-10-15')

if __name__=='__main__':unittest.main()
