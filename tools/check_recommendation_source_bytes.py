"""Verify L3 replay sources are the exact bytes recorded in HEAD."""

import ast
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "ml-controller/services/paired_nav_recommendation_path.py"


def recommendation_files() -> list[str]:
    tree = ast.parse(SOURCE.read_bytes(), filename=str(SOURCE))
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                    and node.name == "recommendation_source_identity")
    result = next(node for node in ast.walk(function) if isinstance(node, ast.DictComp))
    names = result.generators[0].iter
    if not isinstance(names, ast.Tuple) or not all(
            isinstance(item, ast.Constant) and isinstance(item.value, str)
            for item in names.elts):
        raise RuntimeError("recommendation source list is not a literal tuple")
    return [item.value for item in names.elts]


def main() -> int:
    mismatched = []
    for name in recommendation_files():
        relative = f"ml-controller/services/{name}"
        committed = subprocess.run(["git", "show", f"HEAD:{relative}"], cwd=ROOT,
                                   check=True, capture_output=True).stdout
        if (ROOT / relative).read_bytes() != committed:
            mismatched.append(relative)
    if mismatched:
        print("ERROR: deployed L3 source bytes differ from HEAD (including line endings):",
              file=sys.stderr)
        for relative in mismatched:
            print(f"  {relative}", file=sys.stderr)
        return 1
    print("L3 source byte parity: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
