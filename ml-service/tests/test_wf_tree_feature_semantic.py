"""Exercise the actual Modal adapter with the actual request/semantic classes."""
import ast
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

import pytest
from pydantic import BaseModel
from app.formal_feature_contract import FEATURE131_SEMANTIC, LEGACY_SEMANTIC, EXO131_PROFILE, payload_semantic

ROOT=Path(__file__).resolve().parents[1]

def run_adapter(extra):
    source=ROOT/'modal_app.py'
    fn=next(n for n in ast.parse(source.read_text(encoding='utf8')).body
            if isinstance(n,ast.FunctionDef) and n.name=='train_wf_tree_window')
    fn.decorator_list=[]
    cls=next(n for n in ast.parse((ROOT/'app/universal_training.py').read_text(encoding='utf8')).body
             if isinstance(n,ast.ClassDef) and n.name=='UniversalTrainRequest')
    types={'BaseModel':BaseModel,'__name__':__name__}
    exec(compile(ast.Module(body=[cls],type_ignores=[]),'request','exec'),types)
    calls=[];use_cases=ModuleType('app.use_cases')
    use_cases.UniversalTrainRequest=types['UniversalTrainRequest']
    def train(request):
        calls.append(request.model_dump())
        return {'semantic':payload_semantic(request.model_dump())}
    use_cases.train_universal_from_gcs=train
    ns={'_setup_env':lambda:None,'_prepare_training_input_cache_for_payload':lambda p:{}}
    exec(compile(ast.Module(body=[fn],type_ignores=[]),str(source),'exec'),ns)
    payload=dict(window_id=0,train_start='2023-04-06',train_end='2026-06-30',test_start='2026-07-01',
                 test_end='2026-07-15',generation_mode='purged_oof',cohort_id='fixture',**extra)
    with patch.dict('sys.modules',{'app.use_cases':use_cases}):result=ns['train_wf_tree_window'](payload)
    return result,calls

@pytest.mark.parametrize('extra,expected',[
    ({'feature_semantic_version':FEATURE131_SEMANTIC,'feature_release_mode':'approved_full131_v1'},FEATURE131_SEMANTIC),
    ({'model_profile_schema_version':EXO131_PROFILE},FEATURE131_SEMANTIC),
    ({'feature_semantic_version':LEGACY_SEMANTIC},LEGACY_SEMANTIC),
    ({},LEGACY_SEMANTIC),
])
def test_preserves_feature_identity(extra,expected):
    result,calls=run_adapter(extra)
    assert result['semantic']==expected and len(calls)==1
    assert calls[0]['generation_mode']=='purged_oof' and calls[0]['cohort_id']=='fixture'

@pytest.mark.parametrize('extra',[
    {'feature_semantic_version':'unknown'},
    {'feature_semantic_version':LEGACY_SEMANTIC,'model_profile_schema_version':EXO131_PROFILE},
])
def test_rejects_invalid_identity_before_training(extra):
    result,calls=run_adapter(extra)
    assert result.get('error') and calls==[]
