from pathlib import Path

from routers.admin import _MODAL_STABLE_MTIME, _prepare_stable_modal_source


def test_stable_modal_source_includes_finlab_contract(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    service_root = repo_root / "ml-service"
    app_path = service_root / "modal_app.py"
    app_path.parent.mkdir(parents=True)
    app_path.write_text("# modal app\n", encoding="utf-8")

    (repo_root / "tools").mkdir()
    feature_registry = repo_root / "data" / "feature_registry"
    feature_registry.mkdir(parents=True)
    (feature_registry / "registry.json").write_text("{}", encoding="utf-8")
    contract = repo_root / "data" / "finlab_source_contract.json"
    contract.write_text('{"version": 1}', encoding="utf-8")

    stable_app_path, stable_dir = _prepare_stable_modal_source(
        str(app_path),
        stable_root=tmp_path / "stable",
    )

    stable_root = Path(stable_dir)
    assert Path(stable_app_path).is_file()
    assert (stable_root / "data" / "feature_registry" / "registry.json").is_file()
    assert (stable_root / "data" / contract.name).read_text(encoding="utf-8") == '{"version": 1}'
    assert int((stable_root / "data" / contract.name).stat().st_mtime) == _MODAL_STABLE_MTIME
