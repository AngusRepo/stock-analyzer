"""Apply exact canonical T5 lookup to full corrected feature rows, locally."""
import argparse,hashlib,json,sys
from pathlib import Path
import numpy as np
import polars as pl
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/"ml-service"))
from app.canonical_adjusted_prep import build_adjusted_target_lookup,_market_map
from app.oof_lineage import percentile_rank_by_date_market
OUT=ROOT/"audits/l4-design-repair/final-adjudication/corrected-comparison"

def main():
 parser=argparse.ArgumentParser();parser.add_argument("--feature-source",default="corrected-feature-frozen");parser.add_argument("--compute-dest",default="compute-input");args=parser.parse_args()
 records=[]
 for i in range(5):records.extend(np.load(OUT/f"source/sequence-batch_{i}.npz",allow_pickle=True)["sequence_records"].tolist())
 lookup=build_adjusted_target_lookup(records)
 batches=[]
 for path in sorted((OUT/args.feature_source/"local/prep").glob("batch_*.npz")):
  a=np.load(path,allow_pickle=True)
  batches.append({k:a[k] for k in a.files})
 markets=_market_map(batches);staged=[];keys=[]
 dest=OUT/args.compute_dest/"study"/"prep";dest.mkdir(parents=True,exist_ok=True)
 for i,a in enumerate(batches):
  targets=np.full(len(a["dates"]),np.nan);known=np.full(len(targets),"",dtype=object);ms=np.array([markets.get(str(s),"") for s in a["symbols"]],dtype=object)
  for j,(s,d) in enumerate(zip(a["symbols"],a["dates"])):
   v=lookup.get(str(s),{}).get(str(d)[:10])
   if v is not None:targets[j],known[j]=v
  mask=np.isfinite(targets)&(known.astype(str)!="")&(ms.astype(str)!="")
  data={k:np.asarray(a[k])[mask] for k in ["X","dates","symbols","sectors"]}
  data.update(target_returns=targets[mask],label_known_dates=known[mask],markets=ms[mask],missingness_rates=a["missingness_rates"])
  staged.append(data)
  keys.extend({"date":str(d),"symbol":str(s)} for d,s in zip(data["dates"],data["symbols"]))
 ranks=percentile_rank_by_date_market(np.concatenate([a["target_returns"] for a in staged]),np.concatenate([a["dates"] for a in staged]),np.concatenate([a["markets"] for a in staged]))
 offset=0;receipt=[]
 for i,a in enumerate(staged):
  n=len(a["dates"]);a["y"]=ranks[offset:offset+n];offset+=n
  path=dest/f"batch_{i}.npz";np.savez_compressed(path,**a)
  receipt.append({"batch":i,"rows":n,"input_rows":len(batches[i]["dates"]),"sha256":hashlib.sha256(path.read_bytes()).hexdigest()})
 (dest/"feature_names.json").write_bytes((OUT/"source/feature_names.json").read_bytes())
 keyframe=pl.DataFrame(keys);assert keyframe.unique(["date","symbol"]).height==keyframe.height
 references=json.loads((OUT.parent/"pre-l3-coverage.json").read_text(encoding="utf-8"));route=json.loads((OUT.parent/"selection_reference.json").read_text(encoding="utf-8"))
 rows=[r for resp in route["responses"] for r in resp["results"]]
 selected=pl.DataFrame(rows).filter((pl.col("hard_gate_passed")==1)&(pl.col("feature_available")==1)&(pl.col("strategy_selected")==1))
 # Actual reference schema uses trade_date or date; resolve only known columns.
 dcol="signal_date"
 selected=selected.select(pl.col(dcol).alias("date"),"symbol").unique()
 missing=selected.join(keyframe,on=["date","symbol"],how="anti")
 summary={"schema":"local-corrected-canonical-study-v1","target":"canonical-adjusted-next-open-to-T5-close-net18bps","rows":offset,"batches":receipt,"reference_rows":selected.height,"reference_missing_rows":missing.height,"missing_reference_keys":missing.to_dicts(),"source_feature_policy":args.feature_source,"formal_promotion":False}
 (OUT/(args.compute_dest+"-canonical-receipt.json")).write_text(json.dumps(summary,indent=2),encoding="utf-8");print(json.dumps(summary,indent=2),flush=True)
 cohort=json.loads((OUT/"source/base-cohort-manifest.json").read_text())
 for w in cohort["windows"]:
  (OUT/args.compute_dest/f"pool-w{w['window_id']}.json").write_text(json.dumps(w["fs_result"]["feature_pool"]),encoding="utf-8")
 (OUT/args.compute_dest/"base-cohort-manifest.json").write_bytes((OUT/"source/base-cohort-manifest.json").read_bytes())

if __name__=="__main__":main()
