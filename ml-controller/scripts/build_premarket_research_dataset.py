"""Local PIT dataset export; no training or remote data fetch."""
import argparse,json
from pathlib import Path
from services.premarket_research_dataset import mature_training_rows
def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--input',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--fit-cutoff',required=True)
    args=parser.parse_args()
    data=json.loads(args.input.read_text(encoding='utf8'))
    result=mature_training_rows(**data,fit_cutoff=args.fit_cutoff)
    with args.output.open('x',encoding='utf8') as stream:json.dump(result,stream,ensure_ascii=False,allow_nan=False)
if __name__=='__main__':main()
