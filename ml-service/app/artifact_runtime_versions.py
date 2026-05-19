from __future__ import annotations

import logging
import warnings
from typing import Any

logger = logging.getLogger(__name__)


def runtime_library_versions() -> dict[str, str]:
    versions: dict[str, str] = {}
    try:
        import sklearn

        versions["sklearn"] = str(sklearn.__version__)
    except Exception:
        versions["sklearn"] = "unavailable"
    try:
        import numpy as np

        versions["numpy"] = str(np.__version__)
    except Exception:
        versions["numpy"] = "unavailable"
    try:
        import joblib

        versions["joblib"] = str(joblib.__version__)
    except Exception:
        versions["joblib"] = "unavailable"
    return versions


def sklearn_version_report(metadata: dict[str, Any] | None) -> dict[str, Any]:
    meta = metadata or {}
    runtime = runtime_library_versions()
    library_versions = meta.get("library_versions") if isinstance(meta.get("library_versions"), dict) else {}
    artifact_sklearn = (
        library_versions.get("sklearn")
        or meta.get("sklearn_version")
        or meta.get("training_sklearn_version")
    )
    runtime_sklearn = runtime.get("sklearn")
    status = "unknown_artifact_version"
    if artifact_sklearn:
        status = "ok" if str(artifact_sklearn) == str(runtime_sklearn) else "mismatch"
    return {
        "status": status,
        "artifact_sklearn": artifact_sklearn,
        "runtime_sklearn": runtime_sklearn,
        "runtime_versions": runtime,
    }


def load_joblib_with_version_warnings(buffer: Any, *, artifact_name: str):
    import joblib

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        model = joblib.load(buffer)

    for item in caught:
        category_name = getattr(item.category, "__name__", str(item.category))
        if category_name == "InconsistentVersionWarning":
            logger.warning(
                "[ArtifactVersion] sklearn InconsistentVersionWarning while loading %s: %s",
                artifact_name,
                item.message,
            )
        else:
            warnings.warn(item.message, item.category, stacklevel=2)
    return model

