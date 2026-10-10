"""Rebuild indicators from sealed raw prices using the original Worker owner."""
import hashlib,json,os,shutil,subprocess,tempfile
from pathlib import Path

def rebuild_capture_indicators(prices):
    node=shutil.which("node")
    if not node:raise ValueError("training_indicator_node_runtime_missing")
    runner=Path(__file__).resolve().parents[1]/"scripts/training_indicators.cjs"
    with tempfile.TemporaryDirectory(prefix="capture-indicators-") as folder:
        source=Path(folder)/"prices.jsonl";output=Path(folder)/"indicators.jsonl"
        with source.open("w",encoding="utf8") as stream:
            for stock_id,rows in prices.items():
                dates=[str(r["date"]) for r in rows]
                if dates!=sorted(set(dates)):raise ValueError("training_indicator_dates_invalid")
                stream.write(json.dumps({"stock_id":stock_id,"prices":rows},allow_nan=False)+"\n")
        result=subprocess.run([node,str(runner),str(source),str(output)],capture_output=True,text=True,encoding="utf8",timeout=900)
        if result.returncode:raise ValueError("training_indicator_owner_failed:"+result.stderr[-1200:])
        owner=json.loads(result.stdout)
        indicators={}
        with output.open(encoding="utf8") as stream:
            for line in stream:
                item=json.loads(line);key=item["stock_id"]
                if key in indicators:raise ValueError("training_indicator_duplicate_stock")
                expected=[r["date"] for r in prices[key][19:]]
                if [r["date"] for r in item["indicators"]]!=expected:raise ValueError("training_indicator_date_coverage")
                indicators[key]=item["indicators"]
        if set(indicators)!=set(prices):raise ValueError("training_indicator_stock_coverage")
        proof={"recipe":"Worker computeTechnicalIndicators, latest 70 observed raw bars, minimum 20",**owner,
            "runner_sha256":hashlib.sha256(runner.read_bytes()).hexdigest(),"input_sha256":hashlib.sha256(source.read_bytes()).hexdigest(),
            "output_sha256":hashlib.sha256(output.read_bytes()).hexdigest(),"rows":sum(map(len,indicators.values()))}
        return indicators,proof
