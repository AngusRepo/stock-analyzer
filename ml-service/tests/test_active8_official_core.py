"""Real stable-library tests at native model capacity; no market-data retraining."""
from pathlib import Path
import ast
import io
import numpy as np
import pytest
import torch
from app.tabm_output_contract import MEMBER_CONTRACT, member_loss, member_rank_prediction, validate_output_contract
from app import tabm_training, tabm_batch_runtime, dlinear_universal, gnn_training
from app import neuralforecast_sequence_runtime as nf_runtime


def test_tabm_members_do_not_cancel_their_training_gradients():
    z = torch.tensor([[[-2.], [2.]]], requires_grad=True)
    loss = member_loss(z, torch.tensor([.5]))
    loss.backward()
    assert loss.item() == pytest.approx(.0725032)
    assert z.grad[0, 0, 0] < 0 < z.grad[0, 1, 0]


def test_tabm_native_training_calls_member_loss_before_any_averaging():
    source = Path(tabm_training.__file__).read_text(encoding="utf-8")
    assert "loss = member_loss(_tabm_forward(model, xb), yb)" in source
    assert "sigmoid(_reduce_tabm_output" not in source


def test_tabm_full_capacity_train_serve_roundtrip_and_legacy_semantics():
    torch.manual_seed(42)
    model = tabm_training._build_tabm_ranker(137).eval()
    assert model.k == 32
    x = np.random.default_rng(42).normal(size=(4,137)).astype(np.float32)
    state = io.BytesIO()
    torch.save(model.state_dict(), state)
    state.seek(0)
    restored = tabm_batch_runtime._build_tabm_ranker({"n_features":137}, {})
    restored.load_state_dict(torch.load(state, weights_only=True))
    restored.eval()
    meta = {"output_transform":"sigmoid", "artifact_schema":"torch_tabm_ranker_v2", "output_contract":MEMBER_CONTRACT}
    artifact = tabm_batch_runtime.TabMArtifact(restored, meta, "local", "test")
    np.testing.assert_allclose(tabm_training._predict_tabm_batches(model,x,batch_size=2,device="cpu"),
                               tabm_batch_runtime.predict_tabm_scores(artifact,features=x), rtol=1e-6)
    output = model(torch.tensor(x))
    loss = member_loss(output,torch.tensor([.1,.3,.6,.9]))
    loss.backward()
    assert all(torch.isfinite(p.grad).all() for p in model.parameters() if p.grad is not None)
    legacy = tabm_batch_runtime.TabMArtifact(model,{"output_transform":"sigmoid"},"local","legacy")
    expected = torch.sigmoid(output.mean(1).squeeze(-1)).detach().numpy()
    np.testing.assert_allclose(tabm_batch_runtime.predict_tabm_scores(legacy,features=x),expected,rtol=1e-6)


def test_tabm_unknown_or_missing_v2_contract_fails_closed():
    with pytest.raises(ValueError,match="unknown"):
        validate_output_contract({"output_contract":"unknown"})
    with pytest.raises(ValueError,match="v2_requires"):
        validate_output_contract({"artifact_schema":"torch_tabm_ranker_v2"})


def test_tabm_legacy_and_new_aggregation_are_distinct():
    z = torch.tensor([[[-4.],[1.]]])
    assert not torch.allclose(member_rank_prediction(z), torch.sigmoid(z.mean(1).squeeze(-1)))


@pytest.mark.parametrize("name",["XGBRegressor","ExtraTreesRegressor","LGBMRegressor"])
def test_both_native_tree_constructors_use_identical_full_settings(name):
    from xgboost import XGBRegressor
    from sklearn.ensemble import ExtraTreesRegressor
    from lightgbm import LGBMRegressor
    from app import universal_training
    tree = ast.parse(Path(universal_training.__file__).read_text(encoding="utf-8"))
    calls = [n for n in ast.walk(tree) if isinstance(n,ast.Call) and
             ((isinstance(n.func,ast.Name) and n.func.id==name) or (isinstance(n.func,ast.Attribute) and n.func.attr==name))]
    params = [{k.arg:ast.literal_eval(k.value) for k in n.keywords} for n in calls]
    assert len(params)==2 and params[0]==params[1]
    estimator = {"XGBRegressor":XGBRegressor,"ExtraTreesRegressor":ExtraTreesRegressor,"LGBMRegressor":LGBMRegressor}[name](**params[0])
    assert estimator.get_params()["n_estimators"]==300
    if name=="LGBMRegressor":
        assert estimator.get_params()["subsample_freq"]==1
        assert estimator.get_params()["subsample"]==.8
    rng=np.random.default_rng(42)
    x=rng.normal(size=(80,37));y=np.linspace(0,1,80)
    estimator.fit(x,y)
    prediction=estimator.predict(x)
    assert np.isfinite(prediction).all() and np.std(prediction)>0
    import joblib
    buffer=io.BytesIO();joblib.dump(estimator,buffer);buffer.seek(0)
    np.testing.assert_allclose(joblib.load(buffer).predict(x),prediction)


def test_dlinear_full_512_decomposition_and_gradient():
    model=dlinear_universal._build_model(512,5,25)
    assert sum(p.numel() for p in model.parameters())==5130
    x=torch.randn(4,512,requires_grad=True)
    output=model(x)
    assert output.shape==(4,5) and torch.isfinite(output).all()
    output.square().mean().backward()
    assert torch.isfinite(x.grad).all()


def test_graphsage_full_features_and_two_message_passing_layers():
    from torch_geometric.nn import SAGEConv
    model=gnn_training._build_model(n_features=137,hidden_dim=64,dropout=.12)
    assert isinstance(model.conv1,SAGEConv) and isinstance(model.conv2,SAGEConv)
    x=torch.randn(8,137,requires_grad=True)
    edges=torch.tensor([[0,1,2,3,4,5,6,7],[1,2,3,4,5,6,7,0]])
    output=model(x,edges)
    assert output.shape==(8,)
    output.square().mean().backward()
    assert torch.isfinite(x.grad).all()


@pytest.mark.parametrize("name,series",[("PatchTST",1),("iTransformer",4)])
def test_native_sequence_models_full_capacity_forward_gradient_and_roundtrip(name,series):
    from neuralforecast.losses.pytorch import MAE
    model=nf_runtime._make_nf_model(name,pred_len=5,seq_len=512,max_steps=120 if name=="PatchTST" else 30,batch_size=128,seed=42,n_series=series)
    assert model.__class__.__name__==name and isinstance(model.loss,MAE)
    assert model.h==5 and model.input_size==512
    assert not model.EXOGENOUS_HIST
    x=torch.randn(2,512,series)
    batch={"insample_y":x.clone(), "insample_mask":torch.ones_like(x), "futr_exog":None,"hist_exog":None,"stat_exog":None}
    model.eval()
    prediction=model(batch)
    assert prediction.shape[:2]==(2,5) and torch.isfinite(prediction).all()
    prediction.square().mean().backward()
    gradients=[p.grad for p in model.parameters() if p.grad is not None]
    assert gradients and all(torch.isfinite(g).all() for g in gradients)
    buffer=io.BytesIO();torch.save(model.state_dict(),buffer);buffer.seek(0)
    restored=nf_runtime._make_nf_model(name,pred_len=5,seq_len=512,max_steps=120 if name=="PatchTST" else 30,batch_size=128,seed=42,n_series=series)
    restored.load_state_dict(torch.load(buffer,weights_only=True));restored.eval()
    torch.testing.assert_close(restored({**batch,"insample_y":x.clone()}),prediction)
