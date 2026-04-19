"""
model_store.py — 模型持久化框架
訓練好的 XGBoost / CatBoost / ExtraTrees / LightGBM / FT-Transformer 序列化存入 GCS
下次 predict 直接載入，不用重新 fit

結構：
  GCS bucket: stockvision-models/
    └── {stock_id}/
          ├── xgboost.joblib
          ├── catboost.joblib
          ├── extratrees.joblib
          ├── lightgbm.joblib
          ├── ft-transformer.joblib    # dict: {state_dict, scaler, n_features}
          ├── metadata_{model}.json
          └── weekly/
                └── ...（週備份）

環境變數：
  GCS_BUCKET_NAME                     → GCS bucket 名稱（預設 stockvision-models）
  GOOGLE_APPLICATION_CREDENTIALS      → Service Account JSON 路徑
  GOOGLE_APPLICATION_CREDENTIALS_JSON → JSON 內容字串（Modal Secret 注入方式）
    modal_app.py 啟動時會自動把此變數寫到 /tmp/gcs-credentials.json
"""
import os
import io
import json
import logging
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

# ── GCS 初始化（lazy，避免本機測試時也要裝 google-cloud）──────────────────────
_bucket = None

def _get_bucket():
    global _bucket
    if _bucket is not None:
        return _bucket

    bucket_name = os.getenv("GCS_BUCKET_NAME", "stockvision-models")
    try:
        from google.cloud import storage
        client = storage.Client()
        _bucket = client.bucket(bucket_name)
        # 確認 bucket 存在
        if not _bucket.exists():
            _bucket = client.create_bucket(bucket_name, location="asia-east1")
            logger.info(f"[ModelStore] Created bucket: {bucket_name}")
        else:
            logger.info(f"[ModelStore] Using bucket: {bucket_name}")
    except ImportError:
        logger.warning("[ModelStore] google-cloud-storage not installed, model persistence disabled")
        return None
    except Exception as e:
        logger.warning(f"[ModelStore] GCS init failed: {e}, model persistence disabled")
        return None

    return _bucket


# ── 儲存模型 ──────────────────────────────────────────────────────────────────
def save_model(
    stock_id: int,
    model_name: str,
    model: Any,
    feature_names: list[str],
    sample_count: int,
    feature_medians: dict[str, float] | None = None,  # 2026-04-17: P1 v2 alignment fallback
    gcs_prefix: str | None = None,                     # 2026-04-18 #32: walk-forward override
    extra_metadata: dict | None = None,                # 2026-04-18 #32: windowed metadata
    skip_weekly_backup: bool = False,                   # 2026-04-18 #32: walk-forward wf/w{id}/* doesn't need weekly
) -> bool:
    """
    序列化模型並上傳到 GCS
    model_name: 'XGBoost' | 'CatBoost' | 'ExtraTrees' | 'MLP' | 'TCN'
    feature_medians: training-time per-feature median, used by predict_stock_v2
                     for name-based alignment when a feature is missing at predict time
    gcs_prefix:      Override default path. If None: 'universal' (stock_id=0) or str(stock_id).
                     For walk-forward: 'walk_forward/w{window_id}'.
    extra_metadata:  Additional keys merged into metadata JSON (e.g. window_id, train_range).
    skip_weekly_backup: when True, don't write weekly/* copy (saves space for walk-forward).
    """
    bucket = _get_bucket()
    if bucket is None:
        return False

    try:
        import joblib

        # 序列化到記憶體
        buf = io.BytesIO()
        joblib.dump(model, buf)
        buf.seek(0)

        # 2026-04-18 #32: gcs_prefix override takes priority, falls back to stock_id-based default
        if gcs_prefix is not None:
            prefix = gcs_prefix.rstrip("/")
        else:
            prefix = "universal" if stock_id == 0 else str(stock_id)
        blob_path = f"{prefix}/{model_name.lower()}.joblib"
        blob = bucket.blob(blob_path)
        blob.upload_from_file(buf, content_type="application/octet-stream")

        # 寫 metadata
        meta = {
            "stock_id": stock_id,
            "model_name": model_name,
            "feature_names": feature_names,
            "feature_medians": feature_medians or {},  # 2026-04-17: P1
            "sample_count": sample_count,
            "trained_at": datetime.now(timezone.utc).isoformat(),
            "gcs_prefix": prefix,   # 2026-04-18 #32: self-describing path
        }
        if extra_metadata:
            meta.update(extra_metadata)
        meta_blob = bucket.blob(f"{prefix}/metadata_{model_name.lower()}.json")
        meta_blob.upload_from_string(json.dumps(meta, ensure_ascii=False), content_type="application/json")

        # 每週備份（方便回溯）— walk-forward 不需要，因為 gcs_prefix 已是 window-versioned
        if not skip_weekly_backup:
            week_key = datetime.now(timezone.utc).strftime("%Y-W%W")
            weekly_blob = bucket.blob(f"{prefix}/weekly/{week_key}/{model_name.lower()}.joblib")
            buf.seek(0)
            weekly_blob.upload_from_file(buf, content_type="application/octet-stream")

        logger.info(f"[ModelStore] Saved {model_name} ({prefix}) {sample_count} samples")
        return True

    except Exception as e:
        logger.error(f"[ModelStore] Save failed for {model_name} prefix={gcs_prefix or stock_id}: {e}")
        return False


# ── 載入模型 ──────────────────────────────────────────────────────────────────
def load_model(
    stock_id: int,
    model_name: str,
    gcs_prefix: str | None = None,  # 2026-04-18 #32: walk-forward override
) -> tuple[Any | None, dict | None]:
    """
    從 GCS 載入已訓練的模型和 metadata
    回傳 (model, metadata) 或 (None, None)

    gcs_prefix: override default path. For walk-forward: 'walk_forward/w{window_id}'.

    2026-04-19 ML_POOL Stage 1 path resolution order (when gcs_prefix is None
    AND stock_id == 0 = universal predict):
      1. Try model_pool.json → use pool entry's gcs_path (versioned layout)
      2. Fallback: legacy flat-file universal/{model}.joblib
    Walk-forward callers (gcs_prefix set) bypass pool lookup. Per-stock
    callers (stock_id != 0) also bypass — they aren't ML_POOL managed.
    """
    bucket = _get_bucket()
    if bucket is None:
        return None, None

    try:
        import joblib

        blob_path: str | None = None
        meta_path: str | None = None
        used_pool = False
        if gcs_prefix is not None:
            prefix = gcs_prefix.rstrip("/")
            blob_path = f"{prefix}/{model_name.lower()}.joblib"
            meta_path = f"{prefix}/metadata_{model_name.lower()}.json"
        elif stock_id == 0:
            # ML_POOL aware: prefer pool entry, fall back to legacy
            try:
                from .model_pool import get_active_path, gcs_metadata_path_for, get_active_version
                pool_path = get_active_path(model_name)
                if pool_path:
                    candidate = bucket.blob(pool_path)
                    if candidate.exists():
                        blob_path = pool_path
                        ver = get_active_version(model_name)
                        if ver:
                            meta_path = gcs_metadata_path_for(model_name, ver)
                        used_pool = True
            except Exception as _e:
                logger.debug(f"[ModelStore] Pool lookup skipped for {model_name}: {_e}")
            if blob_path is None:
                # Legacy flat-file fallback (kept for safety while ML_POOL bootstraps)
                blob_path = f"universal/{model_name.lower()}.joblib"
                meta_path = f"universal/metadata_{model_name.lower()}.json"
        else:
            prefix = str(stock_id)
            blob_path = f"{prefix}/{model_name.lower()}.joblib"
            meta_path = f"{prefix}/metadata_{model_name.lower()}.json"

        blob = bucket.blob(blob_path)
        if not blob.exists():
            return None, None

        # 下載到記憶體
        buf = io.BytesIO()
        blob.download_to_file(buf)
        buf.seek(0)
        model = joblib.load(buf)

        # 載入 metadata
        metadata = {}
        if meta_path:
            meta_blob = bucket.blob(meta_path)
            if meta_blob.exists():
                metadata = json.loads(meta_blob.download_as_text())

        logger.info(f"[ModelStore] Loaded {model_name} from {blob_path} ({'pool' if used_pool else 'legacy/wf'})")
        return model, metadata

    except Exception as e:
        logger.warning(f"[ModelStore] Load failed for {model_name} prefix={gcs_prefix or stock_id}: {e}")
        return None, None


def is_model_fresh(metadata: dict | None, max_age_days: int = 8) -> bool:
    """
    判斷模型是否夠新（預設 8 天，確保每週重訓後不會用舊模型）
    """
    if not metadata:
        return False
    trained_at_str = metadata.get("trained_at")
    if not trained_at_str:
        return False
    try:
        trained_at = datetime.fromisoformat(trained_at_str)
        age = (datetime.now(timezone.utc) - trained_at).days
        return age <= max_age_days
    except Exception:
        return False


def feature_names_match(metadata: dict | None, current_features: list[str]) -> bool:
    """
    確認模型訓練時用的 feature list 和現在一致
    如果不一致（例如新增了大盤特徵），需要重新訓練
    """
    if not metadata:
        return False
    stored = metadata.get("feature_names", [])
    return sorted(stored) == sorted(current_features)


# ── 清理舊備份（保留最近 12 週）─────────────────────────────────────────────
def cleanup_old_weekly(stock_id: int, keep_weeks: int = 12) -> None:
    bucket = _get_bucket()
    if bucket is None:
        return
    try:
        prefix = f"{stock_id}/weekly/"
        blobs = list(bucket.list_blobs(prefix=prefix))
        weeks = sorted(set(b.name.split("/")[2] for b in blobs if len(b.name.split("/")) > 3))
        if len(weeks) > keep_weeks:
            for old_week in weeks[:-keep_weeks]:
                old_blobs = [b for b in blobs if f"/weekly/{old_week}/" in b.name]
                for b in old_blobs:
                    b.delete()
                logger.info(f"[ModelStore] Deleted old backup: {old_week}")
    except Exception as e:
        logger.warning(f"[ModelStore] Cleanup failed: {e}")
