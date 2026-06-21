from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.artifact_lifecycle_repair_packet import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
