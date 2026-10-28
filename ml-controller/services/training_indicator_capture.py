"""Rebuild indicators from sealed raw prices using the original Worker owner."""
import hashlib,json,os,shutil,subprocess,tempfile
from pathlib import Path

def _shard_count(stocks):
    # One node owner per available CPU; each stock line is computed independently.
    configured=os.environ.get("TRAINING_INDICATOR_SHARDS")
    cpus=len(os.sched_getaffinity(0)) if hasattr(os,"sched_getaffinity") else os.cpu_count() or 1
    return max(1,min(int(configured) if configured else min(8,cpus),stocks or 1))

def rebuild_capture_indicators(prices):
    node=shutil.which("node")
    if not node:raise ValueError("training_indicator_node_runtime_missing")
    runner=Path(__file__).resolve().parents[1]/"scripts/training_indicators.cjs"
    items=list(prices.items());size=max(1,-(-len(items)//_shard_count(len(items))))
    with tempfile.TemporaryDirectory(prefix="capture-indicators-") as folder:
        # Contiguous shards in stock order: the streamed hashes equal the single-file hashes.
        source_hash=hashlib.sha256();procs=[]
        try:
            # An empty capture still runs one owner so the proof keeps its formula hash.
            for start in range(0,max(1,len(items)),size):
                source=Path(folder)/f"prices.{start}.jsonl";output=Path(folder)/f"indicators.{start}.jsonl"
                with source.open("w",encoding="utf8") as stream:
                    for stock_id,rows in items[start:start+size]:
                        dates=[str(r["date"]) for r in rows]
                        if dates!=sorted(set(dates)):raise ValueError("training_indicator_dates_invalid")
                        line=json.dumps({"stock_id":stock_id,"prices":rows},allow_nan=False)+"\n"
                        stream.write(line);source_hash.update(line.encode("utf8"))
                procs.append((subprocess.Popen([node,str(runner),str(source),str(output)],stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,text=True,encoding="utf8"),output))
            owners=[]
            for proc,_ in procs:
                stdout,stderr=proc.communicate(timeout=900)
                if proc.returncode:raise ValueError("training_indicator_owner_failed:"+stderr[-1200:])
                owners.append(json.loads(stdout))
        finally:
            for proc,_ in procs:
                if proc.poll() is None:proc.kill();proc.wait()
        if any(owner!=owners[0] for owner in owners):raise ValueError("training_indicator_owner_mismatch")
        indicators={};output_hash=hashlib.sha256()
        for _,output in procs:
            with output.open(encoding="utf8") as stream:
                for line in stream:
                    output_hash.update(line.encode("utf8"))
                    item=json.loads(line);key=item["stock_id"]
                    if key in indicators:raise ValueError("training_indicator_duplicate_stock")
                    expected=[r["date"] for r in prices[key][19:]]
                    if [r["date"] for r in item["indicators"]]!=expected:raise ValueError("training_indicator_date_coverage")
                    indicators[key]=item["indicators"]
        if set(indicators)!=set(prices):raise ValueError("training_indicator_stock_coverage")
        proof={"recipe":"Worker computeTechnicalIndicators, latest 70 observed raw bars, minimum 20",**owners[0],
            "runner_sha256":hashlib.sha256(runner.read_bytes()).hexdigest(),"input_sha256":source_hash.hexdigest(),
            "output_sha256":output_hash.hexdigest(),"rows":sum(map(len,indicators.values()))}
        return indicators,proof
