"""Validate and freeze a future HMM training input. Default: no fitting, network, or publication.

An explicitly authorized operator may add --execute --approved-by Wei --approval-ref <receipt>.
This tool saves local candidate files only. Production admission remains a separate reviewed operation.
"""
from pathlib import Path
import argparse,hashlib,json,sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'ml-service'))
from app.hmm_input_contract import CONTRACT_HASH,FEATURES,validate_environment
from app.regime import build_market_feature_rows,RegimeDetector

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--input',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--execute',action='store_true')
    parser.add_argument('--approved-by');parser.add_argument('--approval-ref')
    args=parser.parse_args()
    if args.execute and (args.approved_by!='Wei' or not args.approval_ref):
        parser.error('explicit Wei approval receipt required for retraining')
    if args.output.exists():
        parser.error('fresh output directory required; cannot overwrite another candidate')
    env=json.loads(args.input.read_text(encoding='utf-8'))
    validate_environment(env)
    dates,features=build_market_feature_rows(env)
    if features is None or len(features)<30:
        parser.error('at least 30 consecutive certified-score feature sessions required')
    receipt={'status':'PREPARED_NOT_TRAINED','training_calls':0,'input_contract':CONTRACT_HASH,'feature_order':list(FEATURES),
      'input_checksum':env['hmm_input_checksum'],'input_file_sha256':hashlib.sha256(args.input.read_bytes()).hexdigest(),
      'feature_matrix_sha256':hashlib.sha256(features.astype('<f8').tobytes()).hexdigest(),
      'train_start':dates[0],'train_end':dates[-1],'history_days':len(dates),'production_effect':False}
    args.output.mkdir(parents=True)
    (args.output/'input.json').write_bytes(args.input.read_bytes())
    if args.execute:
        detector=RegimeDetector().fit(features,input_contract=CONTRACT_HASH,training_input_checksum=env['hmm_input_checksum'])
        if not detector.compatible():
            raise RuntimeError('HMM training failed; no publication')
        import joblib
        joblib.dump(detector,args.output/'hmm_detector.joblib')
        receipt.update(status='LOCAL_CANDIDATE_REQUIRES_ADMISSION',training_calls=1,
          approval_ref=args.approval_ref,artifact_sha256=hashlib.sha256((args.output/'hmm_detector.joblib').read_bytes()).hexdigest())
    (args.output/'receipt.json').write_bytes(json.dumps(receipt,ensure_ascii=False,indent=2).encode())
    print(json.dumps(receipt,ensure_ascii=False))

if __name__=='__main__':main()
