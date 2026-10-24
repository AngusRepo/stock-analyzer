"""Write ci/controller_durations.json (test file -> seconds) from controller junit reports.

usage: controller_durations.py <junit.xml or a directory searched for *.xml> ...

pytest's junit time per testcase covers setup, call and teardown, so a file's sum is
the worker time it needs. Seconds are rounded to keep the committed file readable.
"""
import json
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

seconds = defaultdict(float)
reports = []
for arg in sys.argv[1:]:
    path = Path(arg)
    reports += sorted(path.rglob('*.xml')) if path.is_dir() else [path]
for report in reports:
    for case in ET.parse(report).getroot().iter('testcase'):
        module = case.get('classname', '').split('.')
        # classname is tests.test_x or tests.test_x.TestClass
        if len(module) >= 2 and module[0] == 'tests' and module[1].startswith('test_'):
            seconds[f'tests/{module[1]}.py'] += float(case.get('time') or 0)
if not seconds:
    raise SystemExit('no controller testcases found')
out = Path(__file__).with_name('controller_durations.json')
out.write_text(json.dumps({k: round(v, 1) for k, v in sorted(seconds.items())}, indent=0) + '\n', encoding='utf-8')
print(f'{len(seconds)} files, {sum(seconds.values()):.0f}s total -> {out}')
