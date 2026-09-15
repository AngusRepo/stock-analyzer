"""Local-only, evidence-verified cutover/rollback JSON preparation."""
import argparse
import json
from pathlib import Path
from services.l4_release_packet import prepare_packet


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('current-config','candidate','acceptance','source-evidence','l3-identity','constraints','signal-date','output'):
        parser.add_argument('--'+name,required=True)
    parser.add_argument('--current-l3-identity',required=True)
    parser.add_argument('--current-plan-id')
    args=vars(parser.parse_args())
    output=Path(args.pop('output'))
    for name in list(args):
        if name not in ('signal_date','current_plan_id') and args[name] is not None:args[name]=json.loads(Path(args[name]).read_text(encoding='utf-8-sig'))
    packet=prepare_packet(**args)
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('x',encoding='utf-8') as stream:json.dump(packet,stream,ensure_ascii=False,indent=2,allow_nan=False)
    print(json.dumps({'status':'local_packet_prepared','path':str(output),
        'l3_publication_qualification':packet['l3_publication_qualification'],
        'pending_release_checks':packet['pending_release_checks'],'remote_mutations_executed':False}))

if __name__=='__main__':main()
