"""One owner for service min; revision min must always be zero.

Only min settings can change. Image, CPU/RAM, secrets, environment, timeout,
concurrency and CPU allocation are compared before/after, never logged.
"""
import argparse, json, os, subprocess

def gcloud(args):
    cmd = 'gcloud.cmd' if os.name == 'nt' else 'gcloud'
    p = subprocess.run([cmd,*args],capture_output=True,text=True)
    if p.returncode: raise RuntimeError('gcloud_failed:'+str(p.returncode))
    return p.stdout

def revision_min(doc):
    return int(doc.get('metadata',{}).get('annotations',{}).get('autoscaling.knative.dev/minScale','0'))

def protected(doc):
    template=json.loads(json.dumps(doc['spec']['template']))
    meta=template.get('metadata',{})
    meta.pop('name',None);meta.pop('creationTimestamp',None)
    # gcloud adds operation bookkeeping on any update.
    for k in ['run.googleapis.com/operation-id','run.googleapis.com/client-name','run.googleapis.com/client-version','autoscaling.knative.dev/minScale']:
        meta.get('annotations',{}).pop(k,None)
    return {"spec": template["spec"], "annotations": meta.get("annotations",{})}

def active_revisions(doc):
    return {r.get('revisionName') or doc['status']['latestReadyRevisionName'] for r in doc['status'].get('traffic',[]) if r.get('percent',0)>0 or r.get('tag')}

def verify(doc, revisions, desired):
    actual=int(doc.get('metadata',{}).get('annotations',{}).get('run.googleapis.com/minScale','0'))
    if actual!=desired: raise RuntimeError('service_min_mismatch')
    if revision_min(doc['spec']['template']): raise RuntimeError('template_min_nonzero')
    for name in active_revisions(doc):
        if name not in revisions or revision_min(revisions[name]): raise RuntimeError('active_revision_min_nonzero:'+name)

def run(service, project, region, desired=None, apply=False):
    common=['--project='+project,'--region='+region]
    def read(): return json.loads(gcloud(['run','services','describe',service,*common,'--format=json']))
    def revisions(doc):
        # One paginated list replaces a separate gcloud process for each retained tag.
        rows=json.loads(gcloud(['run','revisions','list','--service='+service,*common,
                                '--format=json(metadata.name,metadata.annotations)']))
        indexed={r['metadata']['name']:r for r in rows}
        names=active_revisions(doc)
        if not names.issubset(indexed): raise RuntimeError('referenced_revision_not_observed')
        return {n:indexed[n] for n in names}
    before=read();old=revisions(before)
    existing=int(before.get('metadata',{}).get('annotations',{}).get('run.googleapis.com/minScale','0'))
    desired=existing if desired is None else desired
    if apply:
        # Scaling never deploys or routes a new revision. A stale revision
        # floor needs an explicitly approved release before the scaler is used.
        if revision_min(before['spec']['template']) or any(revision_min(r) for r in old.values()):
            raise RuntimeError('revision_floor_requires_approved_release')
        gcloud(['run','services','update',service,*common,'--min='+str(desired),'--quiet'])
    after=read() if apply else before
    if protected(before)!=protected(after): raise RuntimeError('protected_runtime_settings_changed')
    tags=lambda d:{r['tag']:r['revisionName'] for r in d['status'].get('traffic',[]) if r.get('tag')}
    if tags(before)!=tags(after): raise RuntimeError('release_tags_changed')
    after_revisions=revisions(after) if apply else old
    verify(after,after_revisions,desired)
    result={'service':service,'service_min':desired,'template_min':0,'active_revision_min':{n:0 for n in after_revisions},'protected_settings_unchanged':True,'status':'verified'}
    print(json.dumps(result));return result

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--service',required=True);parser.add_argument('--project',required=True);parser.add_argument('--region',required=True)
    parser.add_argument('--desired',type=int,choices=[0,1]);parser.add_argument('--apply',action='store_true')
    a=parser.parse_args();run(a.service,a.project,a.region,a.desired,a.apply)
