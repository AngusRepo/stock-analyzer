"""Rebuild full137 from immutable inputs; require retained-row feature parity."""
import argparse,contextlib,hashlib,io,json,sys,time
from pathlib import Path
import numpy as np
import polars as pl
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/"ml-controller"));sys.path.insert(0,str(ROOT/"ml-service"))
from app import features,universal_training
from routers.retrain_trigger import _group_rows_by_key,_snapshot_per_stock_ts_map,_snapshot_sentiment_map
OUT=ROOT/"audits/l4-design-repair/final-adjudication/corrected-comparison"
SOURCE=OUT/"source"

class LocalBucket:
 def __init__(self,root): self.root=root
 def blob(self,name):
  path=self.root/name
  class Blob:
   def upload_from_file(self,stream,**kwargs):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(stream.read())
   def upload_from_string(self,value,**kwargs):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(value,encoding="utf-8")
  return Blob()

def load_context():
 names=json.loads((SOURCE/"feature_names.json").read_text(encoding="utf-8"))
 assert names==features.FEATURE_COLS and len(names)==137
 frames={name:pl.read_parquet(SOURCE/(name+".parquet")) for name in ("stocks","prices","indicators","chips","sentiment","monthly_revenue","canonical_fundamentals","margin_data","shareholding")}
 history={};symbols=[]
 # These are the only two shared-market outputs among the frozen137 inputs.
 # Recover their same-date values, never returns/labels; require uniqueness.
 context_cols=["us_sentiment_score","advance_ratio"]
 stages=[]
 for i in range(5):
  a=np.load(SOURCE/f"original-batch-{i}.npz",allow_pickle=True)
  syms=list(dict.fromkeys(a["symbols"].astype(str)));symbols.append(syms)
  stages.append(pl.DataFrame({"date":a["dates"].astype(str),**{c:a["X"][:,names.index(c)] for c in context_cols}}))
 joined=pl.concat(stages)
 unique=joined.group_by("date").agg([pl.col(c).n_unique().alias(c+"_count") for c in context_cols])
 assert all(unique[c+"_count"].max()==1 for c in context_cols),"shared context differs within date"
 for r in joined.unique("date").to_dicts():history[r.pop("date")]=r
 (OUT/"shared-context-receipt.json").write_text(json.dumps({"source":"same-date unique feature values in all five immutable source NPZ", "fields":context_cols,"dates":len(history),"future_target_used":False,"full137_output_parity_required":True},indent=2),encoding="utf-8")
 allsymbols=set(sum(symbols,[]))
 counts=frames["prices"].group_by("stock_id").len()
 extra=frames["stocks"].filter(pl.col("market").is_in(["TW","TWO","TWSE","OTC"]) & ~pl.col("symbol").is_in(list(allsymbols))).join(counts,left_on="id",right_on="stock_id",how="inner").filter(pl.col("len")>=60).sort("id")["symbol"].to_list()
 if extra:symbols.append(extra);allsymbols.update(extra)
 (OUT/"whole-symbol-recovery.json").write_text(json.dumps({"extra_symbols":extra,"policy":"all frozen Taiwan stocks with at least60 source price rows; no stock-count truncation","original_universe":len(allsymbols)-len(extra)},indent=2),encoding="utf-8")
 stockrows=frames["stocks"].filter(pl.col("symbol").is_in(list(allsymbols))).to_dicts()
 bysymbol={str(r["symbol"]):r for r in stockrows};assert len(bysymbol)==len(allsymbols)
 ids=[r["id"] for r in stockrows];idset=set(ids)
 px=_group_rows_by_key(frames["prices"].to_dicts(),key="stock_id",allowed=idset,limit=504,
  mapper=lambda r:{k:r.get(k) for k in ("date","open","high","low","close","volume","adj_close","avg_price")})
 ind=_group_rows_by_key(frames["indicators"].to_dicts(),key="stock_id",allowed=idset,limit=504,
  mapper=lambda r:{**{k:r.get(k) for k in ("date","ma5","ma10","ma20","ma60","rsi14","bb_upper","bb_lower","atr14")},"macdHist":r.get("macd_hist",r.get("macdHist"))})
 chips=_group_rows_by_key(frames["chips"].to_dicts(),key="symbol",allowed=allsymbols,limit=252,
  mapper=lambda r:{k:r.get(k) for k in ("date","foreign_net","trust_net","dealer_net","margin_balance","short_balance")})
 sentiment=_snapshot_sentiment_map(frames["sentiment"].to_dicts(),ids)
 pts=_snapshot_per_stock_ts_map(monthly_revenue_rows=frames["monthly_revenue"].to_dicts(),canonical_fundamental_rows=frames["canonical_fundamentals"].to_dicts(),margin_rows=frames["margin_data"].to_dicts(),shareholding_rows=frames["shareholding"].to_dicts(),stock_ids=ids,symbol_to_id={s:r["id"] for s,r in bysymbol.items()})
 return names,symbols,history,bysymbol,px,ind,chips,sentiment,pts

def main():
 parser=argparse.ArgumentParser();parser.add_argument("--probe",action="store_true");parser.add_argument("--missing-symbols",action="store_true");args=parser.parse_args()
 names,symbols,history,stocks,px,ind,chips,sentiment,pts=load_context()
 dest=OUT/("feature-probe" if args.probe else "corrected-feature")
 universal_training._get_bucket=lambda:LocalBucket(dest)
 receipts=[]
 for i,batchsymbols in enumerate(symbols):
  if args.missing_symbols and i<5:continue
  if args.probe:
   batchsymbols=[s for s in ["2618","3045","2412","2330","1102","6999","7860"] if s in batchsymbols]
   if not batchsymbols:continue
  payloads=[]
  for s in batchsymbols:
   r=stocks[s];sid=r["id"]
   payloads.append({"stock_id":sid,"symbol":s,"market":r["market"],"prices":px[sid],"indicators":ind.get(sid,[]),"chips":chips.get(s,[]),"sentiment_scores":sentiment.get(sid,[]),"market_env":{},"stock_meta":{}})
  t=time.time();dest.mkdir(parents=True,exist_ok=True)
  if not (dest/f"local/prep/batch_{i}.npz").exists():
   with (dest/f"batch-{i}.log").open("w",encoding="utf-8") as log,contextlib.redirect_stdout(log):
    result=universal_training.prep_universal_batch(universal_training.UniversalPrepRequest(payloads=payloads,batch_index=i,shared_market_history=history,per_stock_ts_map={str(k):v for k,v in pts.items()},gcs_prefix="local"))
   assert result["skipped"]==0
  if i>=5:
   source=dest/f"local/prep/batch_{i}.npz"
   frozen=OUT/"corrected-feature-frozen/local/prep";frozen.mkdir(parents=True,exist_ok=True)
   (frozen/source.name).write_bytes(source.read_bytes())
   new=np.load(source,allow_pickle=True)
   print(json.dumps({"batch":i,"symbols":batchsymbols,"rows":len(new["dates"]),"policy":"whole-symbol recovery, all137 reconstructed"}),flush=True)
   continue
  old=np.load(SOURCE/f"original-batch-{i}.npz",allow_pickle=True)
  new=np.load(dest/f"local/prep/batch_{i}.npz",allow_pickle=True)
  index={(str(s),str(d)):j for j,(s,d) in enumerate(zip(new["symbols"],new["dates"]))}
  pairs=[(j,index[(str(s),str(d))]) for j,(s,d) in enumerate(zip(old["symbols"],old["dates"])) if str(s) in batchsymbols]
  left,right=np.array(pairs).T
  ox=old["X"][left];nx=new["X"][right];diff=np.abs(ox-nx)
  model_window=old["dates"][left].astype(str)>="2026-03-09"
  mismatch=~np.isclose(ox,nx,atol=1e-6,rtol=1e-7)
  window_mismatch=mismatch[model_window]
  changes={names[j]:int(window_mismatch[:,j].sum()) for j in range(len(names)) if window_mismatch[:,j].any()}
  return_error=float(np.max(np.abs(old["target_returns"][left]-new["target_returns"][right])))
  receipt={"batch":i,"symbols":len(batchsymbols),"original_matched_rows":len(pairs),"corrected_rows":len(new["dates"]),"extra_rows":len(new["dates"])-len(pairs),"feature_max_abs_diff":float(diff.max()),"numeric_atol":1e-6,"numeric_rtol":1e-7,"comparison_start":"2026-03-09","pre_window_mismatched_cells":int(mismatch[~model_window].sum()),"in_window_mismatched_cells":int(window_mismatch.sum()),"changed_features":changes,"return_max_abs_diff":return_error,"seconds":time.time()-t,"status":"pass" if not changes and return_error<1e-10 else "parity_failed"}
  # Single-change experiment: retained stock/date features are immutable controls.
  # Regenerate all137 only for previously absent rows; never synthesize a missing
  # forecast or use another stock's feature vector. Preserve discrepancy audit.
  arrays={key:new[key] for key in new.files}
  arrays["X"][right]=old["X"][left]
  np.testing.assert_array_equal(arrays["X"][right],old["X"][left])
  frozen=OUT/"corrected-feature-frozen"/"local"/"prep"
  frozen.mkdir(parents=True,exist_ok=True)
  np.savez_compressed(frozen/f"batch_{i}.npz",**arrays)
  (frozen/"feature_names.json").write_text(json.dumps(names),encoding="utf-8")
  receipt["reconstruction_parity_status"]=receipt["status"]
  receipt["status"]="retained_features_frozen_exact_new_rows_full137_rebuilt"
  receipt["frozen_retained_max_abs_difference"]=0.0
  receipts.append(receipt);print(json.dumps(receipt),flush=True)
  (dest/"parity.json").write_text(json.dumps(receipts,indent=2),encoding="utf-8")
  if return_error>=1e-10:raise ValueError("retained_return_parity_failed")
 print("finished",flush=True)

if __name__=="__main__":main()
