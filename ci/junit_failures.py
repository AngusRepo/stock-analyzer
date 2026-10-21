"""pytest junit xml -> one "controller: <classname>::<name>" line per failed/errored test."""
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
ids = set()
for case in root.iter('testcase'):
    if case.find('failure') is not None or case.find('error') is not None:
        ids.add(f"controller: {case.get('classname', '')}::{case.get('name', '')}")
print('\n'.join(sorted(ids)))
