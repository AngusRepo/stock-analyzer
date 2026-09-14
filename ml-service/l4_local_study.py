"""Original research trainers, local data/artifact I/O only."""
import argparse,hashlib,io,json,os,sys,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"ml-service"));sys.path.insert(0,str(ROOT/"ml-controller"))
OUT=ROOT/"audits/l4-design-repair/final-adjudication/corrected-comparison"
INPUT=OUT/"canonical-price-input"
def deny_network(event,args):
 if event in {"socket.connect","socket.getaddrinfo"}:raise RuntimeError("local_research_network_disabled")
sys.addaudithook(deny_network)

class DiskBucket:
 name="isolated-local-study"
 def __init__(self,output):self.output=Path(output)
 def blob(self,name):
  if name.startswith("/") or ".." in Path(name).parts:raise ValueError("unsafe_local_artifact_path")
  output=self.output/name;source=INPUT/name
  class Blob:
   generation=1
   def __init__(self):self.name=name;self.reload()
   def _path(self):return output if output.exists() else source
   def exists(self,**kw):return self._path().is_file()
   def reload(self,**kw):
    from datetime import datetime,timezone
    p=self._path();self.size=p.stat().st_size if p.exists() else 0
    self.updated=datetime.fromtimestamp(p.stat().st_mtime,timezone.utc) if p.exists() else None
    self.time_created=self.updated
   def download_as_bytes(self,**kw):return self._path().read_bytes()
   def download_as_text(self,**kw):return self.download_as_bytes().decode("utf-8")
   def upload_from_file(self,stream,**kw):self.upload_from_string(stream.read())
   def upload_from_string(self,value,**kw):
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_bytes(value.encode("utf-8") if isinstance(value,str) else value);self.reload()
  return Blob()
 def list_blobs(self,prefix="",**kw):
  names=set()
  for root in [INPUT,self.output]:
   if root.exists():names.update(str(p.relative_to(root)).replace("\\","/") for p in root.rglob("*") if p.is_file())
  return [self.blob(n) for n in sorted(names) if n.startswith(prefix)]

def train_fold(job):
 import tempfile,numpy as np,torch
 torch.set_num_threads(4)
 # No secret is attached to this app. Every artifact API is filesystem-only.
 from app import model_store,universal_training,tabm_training,gnn_training,gcs_batch_io
 from app.research_benchmarks import common
 from app.training_reproducibility import configure_training_reproducibility
 configure_training_reproducibility(42)
 root=ROOT.parents[1]/".l4-runs"/f"w{job['fold']}-{job['group']}";root.mkdir(parents=True,exist_ok=True);bucket=DiskBucket(root)
 for module in [model_store,universal_training,tabm_training,gnn_training]:module._get_bucket=lambda:bucket
 common._bucket=lambda:bucket
 gcs_batch_io._BLOB_BYTES_CACHE.clear()
 manifest=json.loads((INPUT/"base-cohort-manifest.json").read_text(encoding="utf-8"))
 w=manifest["windows"][job["fold"]];group=job["group"]
 version=f"l4-population-price-corrected-w{job['fold']}-{group}"
 payload={"gcs_prefix":"study","batch_count":len(list((INPUT/"study/prep").glob("batch_*.npz"))),"train_start":w["train_range"][0],"train_end":w["train_range"][1],"test_start":w["test_range"][0],"test_end":w["test_range"][1],"label_horizon_days":5,"generation_mode":"purged_oof","cohort_id":"l4-population-price-corrected-20260914","fold_id":f"w{job['fold']}","window_id":job["fold"],"output_model_version":version,"seed":42}
 print("STUDY_START",json.dumps(job),flush=True)
 if group=="trees":
  payload.update(feature_pool_path=f"pool-w{job['fold']}.json",skip_weekly_backup=True,enable_model_cpcv=False,register_challengers=False)
  result=universal_training.train_universal_from_gcs(universal_training.UniversalTrainRequest(**payload))
  assert set(result["results"])=={"LightGBM","XGBoost","ExtraTrees"}
  assert all("error" not in v for v in result["results"].values()),result["results"]
  assert set(result["artifact_registrations"])=={"LightGBM","XGBoost","ExtraTrees"},"incomplete_tree_weights_metadata"
 else:
  params=w[group+"_result"]["metadata"]["training_params"]
  payload.update({k:v for k,v in params.items() if k not in ["device","reproducibility","graph_semantic_version"]})
  payload["max_rows"]=1000000000 # Full training pool, no research downsample.
  if group=="TabM":
   import torch_directml
   result=tabm_training.train_tabm_universal(payload,research_device=torch_directml.device(0))
  else:result=gnn_training.train_graphsage_universal(payload)
  assert result.get("status")=="ok",result
 # Retain all generated weights, OOF rows, checksums and metadata locally.
 (root/"research-result.json").write_text(json.dumps(result,default=str),encoding="utf-8")
 inventory={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob("*") if p.is_file()}
 (root/"research-io-receipt.json").write_text(json.dumps({"job":job,"files":inventory,"execution_device":"DirectML RX6900XT" if group=="TabM" else "CPU", "torch_version":torch.__version__,"input_checksums":{str(p.relative_to(INPUT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in INPUT.rglob("*") if p.is_file()},"cloud_writes":0,"model_registration":False,"tree_feature_pool":"original training-fold pool frozen to isolate population repair","extra_tree_cpcv":"not rerun; no promotion; required outer OOF split retained"}),encoding="utf-8")
 buf=io.BytesIO()
 with zipfile.ZipFile(buf,"w",compression=zipfile.ZIP_DEFLATED) as z:
  for p in root.rglob("*"):
   if p.is_file():z.write(p,str(p.relative_to(root)))
 print("STUDY_COMPLETE",json.dumps(job),flush=True)
 return {"job":job,"archive":buf.getvalue(),"summary":{"train_samples":result.get("train_samples"),"test_samples":result.get("validation_samples",result.get("test_samples")),"elapsed_s":result.get("elapsed_s")}}

def main():
 parser=argparse.ArgumentParser();parser.add_argument("--group",choices=["trees","TabM","GNN"],required=True);parser.add_argument("--fold",type=int,default=-1);args=parser.parse_args()
 destination=OUT/"canonical-price-core-oof";destination.mkdir(exist_ok=True)
 for fold in (range(6) if args.fold<0 else [args.fold]):
  path=destination/f"w{fold}-{args.group}.zip"
  if path.exists():
   with zipfile.ZipFile(path) as z:
    assert z.testzip() is None
    prior=json.loads(z.read("research-result.json"))
    complete=args.group!="trees" or len(prior.get("artifact_registrations",{}))==3
   if complete:
    print("VERIFIED_EXISTING",path.name,flush=True);continue
   backup=path.with_suffix(".incomplete.zip")
   assert not backup.exists()
   path.rename(backup)
   print("REPAIR_INCOMPLETE_ARCHIVE",backup.name,flush=True)
  r=train_fold({"fold":fold,"group":args.group});path.write_bytes(r["archive"])
  print(json.dumps({"saved":str(path),"sha256":hashlib.sha256(r["archive"]).hexdigest(),"summary":r["summary"]}),flush=True)
if __name__=="__main__":main()
