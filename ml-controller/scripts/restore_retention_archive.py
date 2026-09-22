"""Restore reviewed retained chunks into a new local SQLite database, never D1."""
import argparse,json
from pathlib import Path
from services.retention_archive import download_archive,restore_archives

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifests',required=True,type=Path,help='JSON list of trusted Ops run_artifacts manifests')
    parser.add_argument('--output',required=True,type=Path,help='New local SQLite path; existing files are refused')
    args=parser.parse_args()
    manifests=json.loads(args.manifests.read_text(encoding='utf-8'))
    result=restore_archives(((download_archive(m),m) for m in manifests),args.output)
    print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':main()
