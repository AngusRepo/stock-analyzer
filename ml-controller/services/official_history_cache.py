"""Optional shared raw-response cache; callers validate every cached response."""
import os

def cache_bucket_and_prefix():
    prefix=os.environ.get("FINLAB_OFFICIAL_HISTORY_CACHE_PREFIX","").strip("/")
    name=os.environ.get("GCS_BUCKET_NAME","").strip()
    if not prefix:return None,None
    if not name:raise ValueError("official_history_cache_bucket_required")
    from google.cloud import storage
    return storage.Client().bucket(name),prefix

def read_cached(key):
    bucket,prefix=cache_bucket_and_prefix()
    if bucket is None:return None
    blob=bucket.blob(prefix+"/"+key)
    return blob.download_as_bytes() if blob.exists() else None

def write_cached(key,raw):
    bucket,prefix=cache_bucket_and_prefix()
    if bucket is not None:bucket.blob(prefix+"/"+key).upload_from_string(raw,content_type="application/json")
