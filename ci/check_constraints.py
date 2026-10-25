"""Fail when the built image's packages differ from ml-controller/constraints.txt.

A package missing from constraints.txt or resolved to another version means the image no longer
reproduces the pinned (live) set. pip, setuptools and wheel belong to the base image and are skipped.
Usage: check_constraints.py <constraints.txt> <pip-freeze.txt>
"""
import re
import sys

BASE = {'pip', 'setuptools', 'wheel'}


def pins(path):
    found = {}
    for line in open(path, encoding='utf-8'):
        line = line.split('#', 1)[0].strip()
        if line:
            name, version = line.split('==')
            found[re.sub(r'[-_.]+', '-', name).lower()] = version
    return found


want, got = pins(sys.argv[1]), pins(sys.argv[2])
drift = sorted(f'{k}: constraints={want.get(k)} image={got.get(k)}'
               for k in (want.keys() | got.keys()) - BASE if want.get(k) != got.get(k))
print('\n'.join(drift) or f'{len(got)} packages match constraints.txt')
sys.exit(1 if drift else 0)
