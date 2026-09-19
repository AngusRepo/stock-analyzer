"""The separately deployed Controller and Modal must agree with the feature owner."""
import ast
from pathlib import Path
import pytest
ROOT=Path(__file__).resolve().parents[2]
PATHS=[
 'ml-controller/graphs/daily_pipeline_v2.py',
 'ml-controller/services/active8_oof_cohort_materializer.py',
 'ml-controller/routers/retrain_trigger.py',
 'ml-controller/services/active8_prep_lifecycle.py',
 'ml-controller/routers/walk_forward.py',
 'ml-controller/services/model_serving_resolver.py',
 'ml-controller/services/oof_fold_lineage.py',
 'ml-service/modal_app.py',
 'ml-service/app/serving_resolver.py',
]

def versions(path):
    return {n.value for n in ast.walk(ast.parse((ROOT/path).read_text(encoding='utf-8')))
            if isinstance(n,ast.Constant) and isinstance(n.value,str) and n.value.startswith('formal137-pit-')}

@pytest.mark.parametrize('path',PATHS)
def test_training_oof_and_serving_expect_current_feature_owner(path):
    owner=versions('ml-service/app/features/__init__.py')
    assert len(owner)==1
    assert versions(path)==owner
