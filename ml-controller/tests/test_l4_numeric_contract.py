"""Pin the Worker mirror of the L4 weight-support constant to the controller owner."""
import re
from pathlib import Path

from services.l4_numeric_contract import WEIGHT_SUPPORT


def test_worker_weight_support_matches_controller():
    source = (Path(__file__).resolve().parents[2]/'worker/src/lib/l4NumericContract.ts').read_text(encoding='utf-8')
    values = re.findall(r'export const WEIGHT_SUPPORT = ([0-9.e+-]+)\n', source)
    assert values and float(values[0]) == WEIGHT_SUPPORT and len(values) == 1
