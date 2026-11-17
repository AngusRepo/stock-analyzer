"""pytest junit xml -> one "<suite>: <classname>::<name>" line per failed/errored test (suite defaults to controller)."""
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
suite = sys.argv[2] if len(sys.argv) > 2 else 'controller'
ids = set()
for case in root.iter('testcase'):
    if case.find('failure') is not None or case.find('error') is not None:
        ids.add(f"{suite}: {case.get('classname', '')}::{case.get('name', '')}")
print('\n'.join(sorted(ids)))
