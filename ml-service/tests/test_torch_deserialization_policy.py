from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1] / "app"


def test_runtime_does_not_enable_unsafe_torch_deserialization() -> None:
    violations: list[str] = []
    for path in APP_ROOT.rglob("*.py"):
        source = path.read_text(encoding="utf-8")
        if "weights_only=False" in source:
            violations.append(f"{path}: weights_only=False")
        if "torch.jit.script" in source:
            violations.append(f"{path}: torch.jit.script")
        if ".load_from_checkpoint(" in source:
            violations.append(f"{path}: load_from_checkpoint")
    assert violations == []
