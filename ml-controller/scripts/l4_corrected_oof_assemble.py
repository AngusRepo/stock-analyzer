"""Verified local research assembly of rebuilt cores and unchanged sequence OOF."""
import hashlib,io,json,sys,zipfile
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/"ml-controller"))
from services.l4_distribution import digest
from services.l4_distribution_dataset import build_native_oof_rows,NET_LABEL_SCHEMA
OUT=ROOT/"audits/l4-design-repair/final-adjudication/corrected-comparison"
COHORT="l4-population-price-corrected-20260914"
def read(p):return json.loads(p.read_text(encoding="utf-8-sig"))
def decode(raw,window,model,expected_sha=None):
 checksum=hashlib.sha256(raw).hexdigest()
 if expected_sha:assert checksum==expected_sha
 loaded=np.load(io.BytesIO(raw),allow_pickle=True);a={k:loaded[k] for k in loaded.files};loaded.close();meta=json.loads(str(a["metadata"].item()))
 assert meta["model_name"]==model and meta["target_semantic_version"]==NET_LABEL_SCHEMA
 assert meta["generation_mode"]=="purged_oof"
 split=meta["split_metadata"]
 assert split.get("test_range",[split.get("test_start"),split.get("test_end")])==window["test_range"]
 assert split.get("requested_train_range",split.get("train_range",[split.get("train_start"),split.get("train_end")]))==window["train_range"]
 if "effective_train_range" in split:assert window["train_range"][0]<=split["effective_train_range"][0]<=split["effective_train_range"][1]<=window["train_range"][1]
 rows=[]
 for i in range(len(a["dates"])):
  rows.append({"cohort_id":COHORT,"source_cohort_id":meta["cohort_id"],"fold_id":f"w{window['window_id']}","prediction_date":str(a["dates"][i])[:10],"symbol":str(a["symbols"][i]),"market_segment":str(a["markets"][i]),"model_name":model,"raw_score":float(a["raw_scores"][i]),"rank_score":float(a["rank_scores"][i]),"target_return":float(a["targets"][i]),"label_known_date":str(a["label_known_dates"][i])[:10],"artifact_version":meta["artifact_version"],"artifact_checksum":checksum,"target_semantic_version":NET_LABEL_SCHEMA,"score_semantic_version":meta["score_semantic"],"train_start":window["train_range"][0],"train_end":window["train_range"][1],"test_start":window["test_range"][0],"test_end":window["test_range"][1]})
 return rows,meta,checksum

def main():
 base=read(OUT/"source/base-cohort-manifest.json");predictions=[];inventory=[];labelcheck=[];targets={}
 for path in (OUT/"canonical-price-input/study/prep").glob("batch_*.npz"):
  a=np.load(path,allow_pickle=True)
  targets.update({(str(s),str(d)):(float(y),str(k)) for s,d,y,k in zip(a["symbols"],a["dates"],a["target_returns"],a["label_known_dates"])})
 for window in base["windows"]:
  fold=window["window_id"]
  for group in ["trees","TabM","GNN"]:
   path=OUT/f"canonical-price-core-oof/w{fold}-{group}.zip"
   with zipfile.ZipFile(path) as z:
    for name in z.namelist():
     if "/oof/" not in name or not name.endswith(".npz"):continue
     raw=z.read(name);model=json.loads(str(np.load(io.BytesIO(raw),allow_pickle=True)["metadata"].item()))["model_name"]
     rows,meta,checksum=decode(raw,window,model);predictions.extend(rows)
     inventory.append({"fold":fold,"model":model,"path":str(path.relative_to(ROOT))+":"+name,"sha256":checksum,"retrained":True,"rows":len(rows)})
  for model in ["DLinear","PatchTST","iTransformer"]:
   metric=window["model_metrics"][model];path=ROOT/"audits/l4-refactor/source-cache"/(hashlib.sha256(metric["oof_artifact"].encode()).hexdigest()+".bin")
   rows,meta,checksum=decode(path.read_bytes(),window,model,metric["artifact_checksum"])
   matched=[(r,targets[(r["symbol"],r["prediction_date"])]) for r in rows if (r["symbol"],r["prediction_date"]) in targets]
   error=max(abs(r["target_return"]-v[0]) for r,v in matched);known=sum(r["label_known_date"]!=v[1] for r,v in matched)
   labelcheck.append({"fold":fold,"model":model,"matched":len(matched),"max_target_error":error,"known_date_mismatches":known})
   assert error<=1e-6 and known==0,labelcheck[-1]
   predictions.extend(rows);inventory.append({"fold":fold,"model":model,"path":metric["oof_artifact"],"sha256":checksum,"retrained":False,"rows":len(rows)})
 assert len(inventory)==48 and len({(r["fold_id"],r["prediction_date"],r["symbol"],r["model_name"]) for r in predictions})==len(predictions)
 (OUT/"sequence-label-equivalence.json").write_text(json.dumps(labelcheck,indent=2),encoding="utf-8")
 manifest={"schema_version":"active8-oof-cohort-manifest-v5","cohort_id":COHORT,"target_semantic_version":NET_LABEL_SCHEMA,"scope":"local_reconstructed_research_only","serving_eligible":False,"original_manifest_checksum":base["manifest_checksum"],"artifacts":inventory,"data_receipt":read(OUT/"canonical-price-input-canonical-receipt.json")}
 manifest["manifest_checksum"]=digest(manifest)
 parent=read(ROOT/"audits/l4-refactor/current-l3-readback.json")[0]["results"][0];payload=json.loads(parent["payload_json"])
 payload.update(cohort_id=COHORT,base_artifact_set_checksum=digest(inventory),serving_eligible=False,scope="local_reconstructed_research_only")
 payload["payload_checksum"]=digest({k:v for k,v in payload.items() if k!="payload_checksum"})
 identity={"schema_version":"paired-nav-formal-ml-baseline-v1","artifact_id":COHORT,"cohort_id":COHORT,"payload_checksum":payload["payload_checksum"],"base_artifact_set_checksum":payload["base_artifact_set_checksum"]}
 (OUT/"research-manifest.json").write_text(json.dumps(manifest,indent=2),encoding="utf-8")
 print("SOURCE_VERIFIED",len(predictions),flush=True)
 rows,receipt=build_native_oof_rows(predictions,manifest=manifest,parent_l3=payload,parent_identity=identity,as_of="2026-09-14")
 receipt.update(base_models_retrained=True,retrained_core_models=5,reused_sequence_models=3,scope="local_reconstructed_research_only",sequence_label_equivalence=labelcheck)
 (OUT/"native-oof-rows.json").write_text(json.dumps(rows,separators=(",",":")),encoding="utf-8")
 (OUT/"native-dataset-receipt.json").write_text(json.dumps(receipt,indent=2),encoding="utf-8")
 print("ASSEMBLED",len(rows),len({r["date"] for r in rows}),flush=True)
if __name__=="__main__":main()
