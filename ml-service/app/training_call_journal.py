"""Persist full-fit child calls across coordinator restarts without resubmitting work.

An interrupted dispatch with no recorded call ID is deliberately ambiguous:
stop for reconciliation rather than start a second paid job. Completed results
outlive Modal's result retention and retain their original artifact identities.
"""
from copy import deepcopy
import hashlib
import json
import os
import re

from google.api_core.exceptions import NotFound, PreconditionFailed

SCHEMA = "full-fit-child-call-journal-v1"

def _bytes(value):
    return json.dumps(value,sort_keys=True,separators=(",",":"),allow_nan=False).encode()

def _digest(value):
    return hashlib.sha256(_bytes(value)).hexdigest()

class TrainingCallJournal:
    def __init__(self,bucket,*,run_id,source_sha,scope,from_id):
        if not run_id or not re.fullmatch(r"[a-f0-9]{40}",source_sha):
            raise ValueError("training_journal_identity_missing")
        self.bucket,self.from_id=bucket,from_id
        self.identity={"run_id":run_id,"source_sha":source_sha,"scope":scope}
        # Source is validated inside the record, not a separate cache namespace.
        self.prefix="training_call_journal/v1/"+_digest([run_id,scope])+"/"

    def _read(self,name):
        blob=self.bucket.blob(self.prefix+name)
        try:
            blob.reload()
        except NotFound:
            return None,0
        generation=int(blob.generation)
        row=json.loads(blob.download_as_bytes(if_generation_match=generation))
        if (row.get("schema_version")!=SCHEMA or row.get("identity")!=self.identity
                or row.get("checksum")!=_digest({k:v for k,v in row.items() if k!="checksum"})):
            raise ValueError("training_journal_corrupt_or_source_changed")
        return row,generation

    def _write(self,name,row,generation):
        value={**row,"schema_version":SCHEMA,"identity":self.identity}
        value.pop("checksum",None);value["checksum"]=_digest(value)
        self.bucket.blob(self.prefix+name).upload_from_string(
            _bytes(value),content_type="application/json",if_generation_match=generation)

    def pin_version(self,payload,proposed):
        fingerprint=_digest(payload)
        row,generation=self._read("version.json")
        if row is None:
            try:self._write("version.json",{"input_checksum":fingerprint,"version":proposed},0)
            except PreconditionFailed:pass
            row,generation=self._read("version.json")
        if row is None or row.get("input_checksum")!=fingerprint or not row.get("version"):
            raise ValueError("training_journal_run_payload_changed")
        return row["version"]

    def spawn(self,stage,spawn,payload):
        name=_digest(stage)+".json";fingerprint=_digest(payload)
        row,generation=self._read(name)
        if row is None:
            try:
                self._write(name,{"stage":stage,"input_checksum":fingerprint,"state":"dispatch_intent"},0)
            except PreconditionFailed:
                return self.spawn(stage,spawn,payload)
            row,generation=self._read(name)
            handle=spawn(payload)
            # If this write is interrupted, the intent stops automatic resubmission.
            self._write(name,{**row,"state":"dispatched","call_id":handle.object_id},generation)
            row,generation=self._read(name)
        if row.get("stage")!=stage or row.get("input_checksum")!=fingerprint:
            raise ValueError("training_journal_stage_payload_changed")
        if row.get("state") not in ("dispatched","completed") or not row.get("call_id"):
            raise RuntimeError("training_dispatch_outcome_unknown_reconcile_before_retry")
        if row["state"]=="completed" and row.get("result_checksum")!=_digest(row.get("result")):
            raise ValueError("training_journal_result_corrupt")
        return _RecordedCall(self,name,row,generation)

    def call(self,stage,spawn,payload):
        return self.spawn(stage,spawn,payload).get()

class _RecordedCall:
    def __init__(self,journal,name,row,generation):
        self.journal,self.name,self.row,self.generation=journal,name,row,generation
        self.object_id=row["call_id"]

    def get(self):
        if self.row["state"]=="completed":return deepcopy(self.row["result"])
        # Use the existing callback JSON wire format on BOTH fresh and resumed reads.
        # Feature-policy tuples become lists; numeric values/artifact checksums do not change.
        result=json.loads(_bytes(self.journal.from_id(self.object_id).get()))
        completed={**self.row,"state":"completed","result":result,"result_checksum":_digest(result)}
        try:self.journal._write(self.name,completed,self.generation)
        except PreconditionFailed:
            current,_=self.journal._read(self.name)
            if (current is None or current.get("state")!="completed"
                    or current.get("call_id")!=self.object_id or current.get("result_checksum")!=_digest(result)):
                raise RuntimeError("training_journal_result_conflict") from None
        self.row=completed
        return deepcopy(result)

def release_journal(payload,*,scope,bucket_name):
    if payload.get("candidate_type")!="oof_full_fit_release":return None
    from google.cloud import storage
    import modal
    if not bucket_name:raise ValueError("training_journal_bucket_missing")
    return TrainingCallJournal(storage.Client().bucket(bucket_name),run_id=payload.get("run_id"),
        source_sha=os.environ.get("STOCKVISION_SOURCE_SHA",""),scope=scope,
        from_id=modal.FunctionCall.from_id)
