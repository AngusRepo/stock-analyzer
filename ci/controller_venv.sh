#!/usr/bin/env bash
# NEW-104: (re)build the local ml-controller/.venv exactly as the CI controller suite installs it:
# requirements.txt under constraints.txt (the live image's pins: ijson, scipy, scikit-learn, ...)
# plus the shared test packages. A hand-made venv drifted and lacked ijson/scipy/sklearn.
# Usage (repo root): bash ci/controller_venv.sh [python]   default python3.12, as ci.yml
set -euo pipefail
python="${1:-python3.12}"
root="$(cd "$(dirname "$0")/.." && pwd)"
source "$root/ci/controller_deps.sh"            # CONTROLLER_TEST_DEPS
venv="$root/ml-controller/.venv"
command -v "$python" > /dev/null || { echo "$python not found; pass the interpreter path" >&2; exit 1; }
# a fresh venv, so nothing installed by hand earlier survives; the old one is kept aside and put
# back if the new one fails or the run is interrupted. It sits in a directory named .venv so the
# existing .gitignore/.dockerignore patterns cover it.
old="$root/ml-controller/.venv-previous/.venv"
[ ! -e "$old" ] || { echo "$old exists from an interrupted run; restore or remove it first" >&2; exit 1; }
restore() { [ -d "$old" ] && { rm -rf "$venv"; mv "$old" "$venv"; rmdir "$(dirname "$old")"; echo "restored the previous .venv" >&2; }; }
trap 'restore' ERR
trap 'restore; exit 130' INT TERM HUP
if [ -d "$venv" ]; then mkdir -p "$(dirname "$old")"; mv "$venv" "$old"; fi
"$python" -m venv "$venv"
"$venv/bin/python" -m pip install -q -r "$root/ml-controller/requirements.txt" -c "$root/ml-controller/constraints.txt" \
  "${CONTROLLER_TEST_DEPS[@]}"
# the packages NEW-104 found missing must import
"$venv/bin/python" -c "import ijson, scipy, sklearn; print('ml-controller/.venv ready:', ijson.__version__, scipy.__version__, sklearn.__version__)"
trap - ERR INT TERM HUP
rm -rf "$(dirname "$old")"
