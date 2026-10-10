import importlib.util
from copy import deepcopy
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('prebuilt_release', ROOT/'tools/verify_prebuilt_release.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def example():
    project='test-project'; source='a'*40; tree='b'*40; digest='sha256:'+'c'*64
    name=f'asia-east1-docker.pkg.dev/{project}/cloud-run-source-deploy/ml-controller'
    account='builder@test-project.iam.gserviceaccount.com'
    build={'status':'SUCCESS','projectId':project,'serviceAccount':f'projects/{project}/serviceAccounts/{account}',
        'substitutions':{'_SOURCE_SHA':source,'_SOURCE_TREE_SHA':tree,'_SOURCE_CONTEXT_SHA256':'d'*64},
        'results':{'images':[{'name':name+':'+source,'digest':digest}]},
        'sourceProvenance':{'resolvedStorageSource':{'bucket':'b','object':'source.tgz','generation':'1'}}}
    return build,dict(image=name+'@'+digest,source_sha=source,tree_sha=tree,project=project,service_account=account)

def test_exact_success():
    build,args=example()
    assert module.verify(build,**args)==args['image']

@pytest.mark.parametrize('mutation', ['failed','account','source','tree','digest','multiple','generation','tag','image_scope'])
def test_rejects_unverified_image(mutation):
    build,args=example(); build=deepcopy(build)
    if mutation=='failed':build['status']='WORKING'
    elif mutation=='account':build['serviceAccount']='other'
    elif mutation=='source':build['substitutions']['_SOURCE_SHA']='e'*40
    elif mutation=='tree':build['substitutions']['_SOURCE_TREE_SHA']='e'*40
    elif mutation=='digest':build['results']['images'][0]['digest']='sha256:'+'e'*64
    elif mutation=='multiple':build['results']['images']*=2
    elif mutation=='generation':build['sourceProvenance']['resolvedStorageSource'].pop('generation')
    elif mutation=='tag':build['results']['images'][0]['name']='other'
    elif mutation=='image_scope':args['image']=args['image'].replace('test-project','other-project')
    with pytest.raises(ValueError):module.verify(build,**args)
