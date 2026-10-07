import importlib.util
from pathlib import Path
import pytest
p=Path(__file__).parents[2]/'scripts/runtime_min_policy.py'
spec=importlib.util.spec_from_file_location('runtime_min',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def doc():
 return {'metadata':{'annotations':{'run.googleapis.com/minScale':'0'}},'spec':{'template':{'metadata':{'annotations':{}},'spec':{'containers':[{'resources':{'limits':{'cpu':'1','memory':'512Mi'}}}]}}},'status':{'latestReadyRevisionName':'new','traffic':[{'revisionName':'new','percent':100}]}}
def test_revision_floor_cannot_hide_behind_service_zero():
 d=doc()
 with pytest.raises(RuntimeError,match='active_revision_min_nonzero'):
  m.verify(d,{'new':{'metadata':{'annotations':{'autoscaling.knative.dev/minScale':'1'}}}},0)
 m.verify(d,{'new':{}},0)
def test_tagged_revision_is_checked_and_resources_protected():
 import copy
 d=doc();d['status']['traffic'].append({'revisionName':'old','tag':'rollback'})
 with pytest.raises(RuntimeError,match='old'):m.verify(d,{'new':{},'old':{'metadata':{'annotations':{'autoscaling.knative.dev/minScale':'1'}}}},0)
 changed=copy.deepcopy(d);changed['spec']['template']['spec']['containers'][0]['resources']['limits']['memory']='256Mi'
 assert m.protected(changed)!=m.protected(d)


def test_large_tag_history_uses_one_list_and_checks_every_floor(monkeypatch):
 import json
 d=doc();d['status']['traffic'] += [{'revisionName':f'old{i}','tag':f'tag{i}'} for i in range(142)]
 rows=[{'metadata':{'name':x['revisionName'],'annotations':{}}} for x in d['status']['traffic']]
 calls=[]
 def gc(args):
  calls.append(args)
  return json.dumps(d if args[:3]==['run','services','describe'] else rows)
 monkeypatch.setattr(m,'gcloud',gc)
 assert m.run('svc','project','region')['status']=='verified'
 assert len(calls)==2 and calls[1][:3]==['run','revisions','list']
 rows[-1]['metadata']['annotations']['autoscaling.knative.dev/minScale']='1'
 with pytest.raises(RuntimeError,match='active_revision_min_nonzero'):m.run('svc','project','region')
 rows.pop()
 with pytest.raises(RuntimeError,match='referenced_revision_not_observed'):m.run('svc','project','region')
