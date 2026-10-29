"""CD-NEW-12: the controller image installs a pinned node/npm, the versions the live image runs."""
from pathlib import Path
import re

DOCKERFILE = (Path(__file__).resolve().parents[2] / 'Dockerfile').read_text(encoding='utf-8')


def apt_install():
    match = re.search(r'RUN apt-get update && apt-get install -y --no-install-recommends(.*?)rm -rf /var/lib/apt/lists/\*',
                      DOCKERFILE, re.S)
    assert match, 'apt-get install layer not found'
    return match.group(1)


def test_node_and_npm_are_version_pinned():
    layer = apt_install()
    assert "'nodejs=20.19.2+dfsg-1*'" in layer
    assert "'npm=9.2.0~ds1-3'" in layer
    assert re.search(r"node --version \| grep -qx 'v20\.19\.2'", layer)
    # apt's * also matches the unpatched main-archive 20.19.2+dfsg-1; only a security build passes
    check = re.search(r"dpkg-query -W -f='\$\{Version\}' nodejs \| grep -Eqx '([^']+)'", layer)
    assert check
    pattern = re.compile(check.group(1))  # ERE and Python agree on this pattern
    assert pattern.fullmatch('20.19.2+dfsg-1+deb13u3') and pattern.fullmatch('20.19.2+dfsg-1+deb13u12')
    assert not pattern.fullmatch('20.19.2+dfsg-1') and not pattern.fullmatch('20.19.3+dfsg-1+deb13u1')
    # no other unpinned node/npm install sneaks in next to the pinned ones
    assert not re.search(r'(?m)^\s+(nodejs|npm)\s*\\$', layer)
