"""Execute the real entrypoint without loading Modal or fitting a model."""
import ast
import sys
import types
from pathlib import Path
import pytest

SOURCE = Path(__file__).resolve().parents[1] / 'modal_app.py'

def entry(monkeypatch, result, seen):
    node = next(n for n in ast.parse(SOURCE.read_text(encoding='utf-8')).body
                if isinstance(n, ast.FunctionDef) and n.name == 'train_patchtst_universal')
    node.decorator_list = []
    module = types.ModuleType('app.patchtst_universal')
    def train(**kwargs):
        seen.update(kwargs)
        return result
    module.train_patchtst = train
    monkeypatch.setitem(sys.modules, 'app.patchtst_universal', module)
    namespace = {'_setup_env':lambda:None}
    exec(compile(ast.Module(body=[node],type_ignores=[]),str(SOURCE),'exec'),namespace)
    return namespace[node.name]

def test_oof_entry_preserves_input_identity_and_checkpoint_graph(monkeypatch):
    evidence = {'metadata':{'model_name':'PatchTST'}, 'oof_artifact':{'path':'oof.npz'},
                'oof_evidence_path':'fold.json','oof_evidence_checksum':'a'*64,
                'asof_prediction_artifact':{'path':'predictions.json'},
                'fold_model_artifact':{'path':'weights.zip'},'model_cpcv':{'decision':'FAIL'},
                'production_effect':False,'allowed_use':'promotion_evidence'}
    seen = {}
    result = entry(monkeypatch,evidence,seen)({'feature_semantic_version':'formal131-without-unverified-daily-owners-v1',
        'generation_mode':'purged_oof','output_model_version':'new','train_end':'2026-06-12',
        'test_start':'2026-06-15','test_end':'2026-06-29','pred_len':5})
    assert seen['feature_semantic_version'] == 'formal131-without-unverified-daily-owners-v1'
    assert seen['train_end'] == '2026-06-12' and seen['pred_len'] == 5
    for key,value in evidence.items():
        assert result[key] == value

def test_old_call_without_semantic_retains_default_contract(monkeypatch):
    seen = {}
    result = entry(monkeypatch,{'metadata':{}},seen)({})
    assert seen['feature_semantic_version'] is None
    assert seen['n_epochs'] == 30 and seen['seq_len'] == 512
    assert result['type'] == 'neuralforecast_patchtst_universal'

def test_error_is_not_converted_to_success(monkeypatch):
    result = {'error':'fit failed'}
    assert entry(monkeypatch,result,{})({}) == result
