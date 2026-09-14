"""Local full-capacity sequence replay. Never writes serving storage."""
import os
os.environ.setdefault("OMP_NUM_THREADS","8")
os.environ.setdefault("OPENBLAS_NUM_THREADS","1")
import argparse,json,sys,time,hashlib
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/"ml-service"));sys.path.insert(0,str(ROOT/"ml-controller"))
from app import neuralforecast_sequence_runtime as rt
from services.active8_release_model_profiles import ACTIVE8_RELEASE_MODEL_PROFILES
OUT=ROOT/"audits/l4-design-repair/final-adjudication/corrected-comparison"

def read(p):return json.loads(p.read_text(encoding="utf-8-sig"))
def save(p,v):p.write_text(json.dumps(v,indent=2,allow_nan=False),encoding="utf-8")
def records():
 mm=read(OUT/"asof-models/original-symbol-market.json");result=[]
 for p in sorted((OUT/"source").glob("sequence-batch_*.npz")):
  a=np.load(p,allow_pickle=True)
  for r in a["sequence_records"].tolist():
   if mm.get(str(r["symbol"])) in {"LISTED","OTC","EMERGING"}:result.append({**r,"market_type":mm[str(r["symbol"])]})
 assert len({r["symbol"] for r in result})==len(result)
 return result

def main():
 ap=argparse.ArgumentParser();ap.add_argument("--model",required=True,choices=["PatchTST","iTransformer"]);ap.add_argument("--device",default="cpu",choices=["cpu","directml"]);args=ap.parse_args()
 import torch,pandas as pd
 from neuralforecast import NeuralForecast
 torch.set_num_threads(8)
 dest=OUT/"asof-models"/args.model;dest.mkdir(exist_ok=True)
 rows=records();calendar=rt._canonical_sequence_calendar(rows)
 cfg=ACTIVE8_RELEASE_MODEL_PROFILES[args.model]["payload_config"]
 opts=rt._resolve_nf_training_options(cfg,args.model)
 train,panel,report=rt._build_fixed_oof_panel(rows,calendar=calendar,train_end="2026-08-18",seq_len=512,pred_len=5,max_series=1024,training_history_mode="full_pit_history")
 assert report["selected_series"]==1024 and report["unique_training_windows"]==250880,report
 save(dest/"training-receipt.json",{"scope":"local research retrain, same original capacity, backend may differ", "config":cfg,"options":opts,"panel":report,"panel_symbols":[r["symbol"] for r in panel],"device":args.device,"source_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),"production_effect":False})
 def no_network(event,values):
  if event in {"socket.connect","socket.getaddrinfo"}:raise RuntimeError("offline_replay_network_forbidden")
 sys.addaudithook(no_network)
 model=rt._make_nf_model(args.model,pred_len=5,seq_len=512,max_steps=cfg["max_steps"],batch_size=cfg["batch_size"],seed=42,n_series=1024,training_options=opts)
 if args.device=="directml":
  import torch_directml
  from pytorch_lightning.accelerators import Accelerator
  from pytorch_lightning.strategies import SingleDeviceStrategy
  class DMLAccelerator(Accelerator):
   def setup_device(self,device):pass
   def get_device_stats(self,device):return {}
   def teardown(self):pass
   @staticmethod
   def parse_devices(devices):return devices
   @staticmethod
   def get_parallel_devices(devices):return [torch_directml.device(0)]
   @staticmethod
   def auto_device_count():return 1
   @staticmethod
   def is_available():return True
   @staticmethod
   def name():return "directml"
  model.trainer_kwargs.update(accelerator=DMLAccelerator(),devices=1,strategy=SingleDeviceStrategy(device=torch_directml.device(0)))
 else:model.trainer_kwargs.update(accelerator="cpu",devices=1)
 nf=NeuralForecast(models=[model],freq=1)
 start=time.time();print("TRAIN_BEGIN",args.model,report,flush=True)
 nf.fit(df=pd.DataFrame(train));print("TRAIN_END",args.model,time.time()-start,flush=True)
 nf.save(path=str(dest/"weights"),overwrite=True,save_dataset=False)
 save(dest/"weights-receipt.json",{"elapsed_seconds":time.time()-start,"files":{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (dest/"weights").rglob("*") if p.is_file()}})
 evaluation=rt._dense_oof_evaluation_records(args.model,rows,panel);outputs=[]
 for day in [d for d in calendar if "2026-08-19"<=d<="2026-09-01"]:
  idx=calendar.index(day);context_dates=calendar[idx-511:idx+1];context=[];anchors={}
  for r in evaluation:
   values,_=rt._aligned_close_values(r,context_dates)
   if len(values)!=512:continue
   context.extend({"unique_id":r["symbol"],"ds":i,"y":float(v)} for i,v in enumerate(values));anchors[r["symbol"]]=float(values[-1])
  pred,_=rt._predict_horizon_by_id_with_column(nf,pd.DataFrame(context),horizon_idx=5,model_name=args.model)
  current=[{"date":day,"symbol":s,"model":args.model,"forecast_price":float(v),"signal_close":anchors[s],"raw_score":float(v)/anchors[s]-1,"score_semantic":"forecast_t5_over_signal_close_gross_v1","future_labels_required":False} for s,v in pred.items()]
  outputs.extend(current);save(dest/"predictions.json",outputs);print("PREDICTED",day,len(current),flush=True)
 save(dest/"completed.json",{"rows":len(outputs),"dates":len({r["date"] for r in outputs}),"elapsed_seconds":time.time()-start,"future_labels_required":False})
if __name__=="__main__":main()
