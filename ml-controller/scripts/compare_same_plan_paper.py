"""Run from ml-controller with PYTHONPATH=. Input JSON contains only frozen local data."""
import argparse,json
from pathlib import Path
from services.same_plan_paper_comparison import compare_same_plan
def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--input',type=Path,required=True)
    parser.add_argument('--runner',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if args.output.exists():raise ValueError('comparison_output_already_exists')
    data=json.loads(args.input.read_text(encoding='utf8'))
    result=compare_same_plan(**data,runner=args.runner)
    # Open exclusively after BOTH accounts succeed; never publish one arm.
    with args.output.open('x',encoding='utf8') as stream:json.dump(result,stream,ensure_ascii=False,allow_nan=False)
if __name__=='__main__':main()
