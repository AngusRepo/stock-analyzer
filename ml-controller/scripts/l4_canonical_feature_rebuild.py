"""Reconstruct full137 with one consistent, verified adjusted-price series."""
import contextlib,hashlib,json,time
import numpy as np
from l4_corrected_feature_rebuild import OUT,load_context,LocalBucket,universal_training

def main():
 names,batches,history,stocks,px,ind,chips,sentiment,pts=load_context()
 records={}
 for i in range(5):
  for r in np.load(OUT/f"source/sequence-batch_{i}.npz",allow_pickle=True)["sequence_records"]:
   records[str(r["symbol"])]=dict(zip(map(str,r["dates"]),map(float,r["close"])))
 dest=OUT/"canonical-price-features";dest.mkdir(exist_ok=True)
 universal_training._get_bucket=lambda:LocalBucket(dest)
 receipts=[]
 for i,symbols in enumerate(batches):
  payloads=[];changed=0;missing=0;total=0
  for s in symbols:
   stock=stocks[s];sid=stock["id"];series=records.get(s,{})
   prices=[]
   for row in px[sid]:
    value=series.get(str(row["date"])[:10]);total+=1
    missing+=value is None
    changed+=value is not None and row.get("adj_close")!=value
    prices.append({**row,"adj_close":value})
   payloads.append({"stock_id":sid,"symbol":s,"market":stock["market"],"prices":prices,"indicators":ind.get(sid,[]),"chips":chips.get(s,[]),"sentiment_scores":sentiment.get(sid,[]),"market_env":{},"stock_meta":{}})
  path=dest/f"local/prep/batch_{i}.npz";start=time.time()
  if not path.exists():
   with (dest/f"batch-{i}.log").open("w",encoding="utf-8") as log,contextlib.redirect_stdout(log):
    result=universal_training.prep_universal_batch(universal_training.UniversalPrepRequest(payloads=payloads,batch_index=i,shared_market_history=history,per_stock_ts_map={str(k):v for k,v in pts.items()},gcs_prefix="local"))
   assert result["skipped"]==0,result
  a=np.load(path,allow_pickle=True)
  receipt={"batch":i,"rows":len(a["dates"]),"feature_count":len(names),"source_price_rows":total,"adjusted_close_changed":changed,"canonical_adj_close_missing":missing,"missing_price_policy":"null, never raw-close fallback; existing causal feature imputer handles undefined features","sha256":hashlib.sha256(path.read_bytes()).hexdigest(),"seconds":time.time()-start}
  receipts.append(receipt);print(json.dumps(receipt),flush=True)
  (dest/"receipt.json").write_text(json.dumps(receipts,indent=2),encoding="utf-8")
if __name__=="__main__":main()
