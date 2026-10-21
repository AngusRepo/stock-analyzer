"""Independent persistent research accounts using the existing native Paper engine.

This owner persists execution state, not statistical eligibility or promotion.
A frame receipt never counts as a full-session/outer-acceptance receipt.
"""
import hashlib
import json
import re
from google.api_core.exceptions import NotFound, PreconditionFailed
from services.l4_challenger_comparison import digest, seal, verify, instant
from services.native_paper_sandbox import run_native_paper_frames, native_execution_identity

PREFIX = "l4_distribution/shadow_accounts/v1/"
STAGES = ("settlement", "morning", "preopen", "intraday", "rescore", "eod", "postclose", "snapshot")


def validate_frame_order(frames, previous):
    # The existing schedule deliberately serializes settlement/morning and
    # intraday/rescore/EOD at the same instant. Compare stage as well as clock.
    def position(frame):
        if frame.get("stage") not in STAGES:
            raise ValueError("shadow_frame_stage_invalid")
        return instant(frame["observed_at"]), STAGES.index(frame["stage"])
    keys = [position(frame) for frame in frames]
    if (not keys or keys != sorted(set(keys))
            or len({frame["input_id"] for frame in frames}) != len(frames)
            or (previous and keys[0] <= position(previous))):
        raise ValueError("shadow_frame_clock_not_forward")


def raw(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


class Accounts:
    def __init__(self, registry, *, runner):
        self.registry = registry
        self.bucket = registry.bucket
        self.runner = runner

    def _entry(self, entry_id):
        registry, _ = self.registry.current()
        if not registry or entry_id not in registry["entries"]:
            raise ValueError("shadow_entry_not_registered")
        return registry["entries"][entry_id], registry["shadow_accounts"][entry_id]

    def _read(self, path):
        blob = self.bucket.blob(PREFIX + path)
        try:
            blob.reload()
            generation = blob.generation
            value = json.loads(blob.download_as_bytes(if_generation_match=generation))
        except NotFound:
            return None, None
        verify(value)
        return value, generation

    def _put(self, path, value):
        verify(value)
        try:
            self.bucket.blob(PREFIX + path).upload_from_string(raw(value), content_type="application/json", if_generation_match=0)
        except PreconditionFailed:
            pass
        saved, _ = self._read(path)
        if saved != value:
            raise ValueError("shadow_immutable_conflict")
        return saved

    def _publish(self, account, state, generation):
        self._put(account + "/states/" + state["checksum"] + ".json", state)
        try:
            self.bucket.blob(PREFIX + account + "/head.json").upload_from_string(
                raw(state), content_type="application/json", if_generation_match=generation or 0)
        except PreconditionFailed as exc:
            raise ValueError("shadow_state_concurrent_writer") from exc
        saved, _ = self._read(account + "/head.json")
        if saved != state:
            raise ValueError("shadow_head_readback_mismatch")
        return saved

    def current(self, entry_id):
        entry, account = self._entry(entry_id)
        head, generation = self._read(account + "/head.json")
        if head:
            saved, _ = self._read(account + "/states/" + head["checksum"] + ".json")
            if (head != saved or head["entry_checksum"] != entry["checksum"]
                    or head["serving_identity"] != entry["serving_identity"]
                    or head["shadow_account"] != account
                    or hashlib.sha256(head["state_sql"].encode()).hexdigest() != head["state_checksum"]):
                raise ValueError("shadow_state_chain_mismatch")
        return head, generation

    def initialize(self, entry_id, *, state_sql, state_checksum, account_id, opening_receipt):
        entry, account = self._entry(entry_id)
        verify(opening_receipt)
        if (not isinstance(account_id, int) or isinstance(account_id, bool) or account_id < 1
                or hashlib.sha256(state_sql.encode()).hexdigest() != state_checksum
                or opening_receipt.get("state_checksum") != state_checksum
                or opening_receipt.get("scope") != "paper_shadow"):
            raise ValueError("shadow_opening_state_invalid")
        initial = seal(dict(schema="l4-shadow-account-state-v1", shadow_account=account,
            entry_checksum=entry["checksum"], serving_identity=entry["serving_identity"],
            account_id=account_id, state_sql=state_sql, state_checksum=state_checksum,
            opening_receipt=opening_receipt, execution_owner=native_execution_identity(self.runner),
            previous_checksum=None, last_observed_at=None, last_stage=None, last_action=None, production_effect=False))
        existing, generation = self.current(entry_id)
        if existing:
            if (existing["opening_receipt"] != opening_receipt or existing["account_id"] != account_id):
                raise ValueError("shadow_opening_state_changed")
            return existing
        return self._publish(account, initial, generation)

    def _recover_pending(self, account, current):
        if current["last_action"]:
            last = current["last_action"]
            recovery, _ = self._read(account + "/pending/" + last["request_sha"] + ".json")
            if (not recovery or recovery["state_checksum"] != current["checksum"]
                    or recovery["request_sha"] != last["request_sha"]
                    or recovery["previous_checksum"] != current["previous_checksum"]):
                raise ValueError("shadow_action_recovery_missing")
            self._put(account + "/actions/" + digest(last["action_id"]) + ".json", recovery)

    def prepare_day(self, entry_id, *, expected_state_checksum, packet):
        from services.l4_shadow_daily import validate
        from services.native_paper_state import prepare_native_state
        from datetime import timezone, timedelta
        entry, account = self._entry(entry_id)
        validate(packet, entry)
        action_id = "prepare:" + packet['session_date']
        request_sha = digest(dict(kind='prepare_day', packet_checksum=packet['checksum'],
            entry_checksum=entry['checksum'], expected_state_checksum=expected_state_checksum))
        path = account + '/actions/' + digest(action_id) + '.json'
        current, generation = self.current(entry_id)
        if not current or current['account_id'] != 1:
            raise ValueError('shadow_daily_private_account_required')
        self._recover_pending(account, current)
        prior, _ = self._read(path)
        if prior:
            if prior['request_sha'] != request_sha:raise ValueError('shadow_action_input_changed')
            return prior
        if current['checksum'] != expected_state_checksum:raise ValueError('shadow_state_stale')
        previous_day = (current.get('daily_inputs') or {}).get('session_date')
        native_day = (instant(current['last_observed_at']).astimezone(timezone(timedelta(hours=8))).date().isoformat()
                      if current['last_observed_at'] else None)
        if ((previous_day and packet['session_date'] <= previous_day)
                or (native_day and packet['session_date'] <= native_day)):
            raise ValueError('shadow_daily_session_already_started')
        prepared = prepare_native_state(base_state=current, seed_rows=packet['seed_rows'],
            recommendations=packet['recommendations'], signal_date=packet['signal_date'],
            trading_config=packet['trading_config'], risk_config=packet['risk_config'],
            stock_rows=packet.get('stock_rows'), frozen_kv=packet.get('frozen_kv'),
            l4_allocation_inputs=packet['l4_allocation_inputs'], allocation_snapshot_id=packet['checksum'])
        daily_path = account + '/daily/' + packet['session_date'] + '/' + packet['checksum'] + '.json'
        saved_packet, _ = self._read(daily_path)
        if saved_packet is None:
            recorded_at = self.registry.clock()
            saved_packet = seal(dict(packet=packet, recorded_at=recorded_at,
                recorded_before_open=instant(recorded_at) < instant(packet['next_open']), outer_acceptance_credit=0))
            self._put(daily_path, saved_packet)
        elif saved_packet.get('packet') != packet:
            raise ValueError('shadow_daily_input_receipt_changed')
        next_state = seal({**{k:v for k,v in current.items() if k!='checksum'},
            'state_sql':prepared['state_sql'],'state_checksum':prepared['state_checksum'],
            'previous_checksum':current['checksum'],
            'daily_inputs':dict(session_date=packet['session_date'],packet_checksum=packet['checksum'],
                               receipt_checksum=saved_packet['checksum']),
            'last_action':dict(action_id=action_id,request_sha=request_sha)})
        receipt = seal(dict(schema='l4-shadow-daily-preparation-v1',shadow_account=account,
            entry_checksum=entry['checksum'],serving_identity=entry['serving_identity'],action_id=action_id,
            request_sha=request_sha,previous_checksum=current['checksum'],state_checksum=next_state['checksum'],
            preparation={k:v for k,v in prepared.items() if k!='state_sql'},
            input_receipt_checksum=saved_packet['checksum'],production_effect=False,outer_acceptance_credit=0))
        self._put(account + '/pending/' + request_sha + '.json', receipt)
        self._publish(account,next_state,generation)
        return self._put(path,receipt)

    def _validate_daily_execution(self, entry, account, current, frames, variables=None):
        from datetime import timezone, timedelta
        from services.l4_shadow_daily import validate
        # Settlement can run independently. Any trading/research stage must bind
        # to today's frozen inputs, never silently reuse yesterday's portfolio.
        trading = [frame for frame in frames if frame["stage"] != "settlement"]
        if not trading:
            return
        inputs = current.get("daily_inputs")
        if not inputs:
            raise ValueError("shadow_daily_inputs_missing")
        days = {instant(frame["observed_at"]).astimezone(
            timezone(timedelta(hours=8))).date().isoformat() for frame in frames}
        if days != {inputs["session_date"]}:
            raise ValueError("shadow_daily_frame_date_mismatch")
        path = account + "/daily/" + inputs["session_date"] + "/" + inputs["packet_checksum"] + ".json"
        receipt, _ = self._read(path)
        if (not receipt or receipt["checksum"] != inputs["receipt_checksum"]
                or receipt.get("packet", {}).get("checksum") != inputs["packet_checksum"]):
            raise ValueError("shadow_daily_receipt_mismatch")
        validate(receipt["packet"], entry)
        context = receipt["packet"].get("execution_context")
        if context is not None and variables != context["variables"]:
            raise ValueError("shadow_execution_variables_changed")

    def advance(self, entry_id, *, action_id, expected_state_checksum, serving_identity, frames, frame_inputs, variables, capture_source=None):
        entry, account = self._entry(entry_id)
        if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", action_id)
                or serving_identity != entry["serving_identity"] or not frames):
            raise ValueError("shadow_execution_identity_invalid")
        request = dict(action_id=action_id, expected_state_checksum=expected_state_checksum,
                       entry_checksum=entry["checksum"], frames=frames, frame_inputs=frame_inputs, variables=variables)
        request_sha = digest(request)
        path = account + "/actions/" + digest(action_id) + ".json"
        current, generation = self.current(entry_id)
        if not current:
            raise ValueError("shadow_account_not_initialized")
        self._recover_pending(account, current)
        prior, _ = self._read(path)
        if prior:
            if prior["request_sha"] != request_sha:
                raise ValueError("shadow_action_input_changed")
            return prior
        if current["checksum"] != expected_state_checksum:
            raise ValueError("shadow_state_stale")
        previous = ({"observed_at": current["last_observed_at"], "stage": current["last_stage"]}
                    if current["last_observed_at"] else None)
        validate_frame_order(frames, previous)
        self._validate_daily_execution(entry, account, current, frames, variables)
        result = run_native_paper_frames(state_sql=current["state_sql"], state_checksum=current["state_checksum"],
            account_id=current["account_id"], variables=variables, frames=frames, frame_inputs=frame_inputs,
            runner=self.runner, expected_execution_owner_version=current["execution_owner"], capture_source=capture_source)
        next_state = seal({**{k: v for k, v in current.items() if k != "checksum"},
            "state_sql": result["state_sql"], "state_checksum": result["state_checksum"],
            "previous_checksum": current["checksum"], "last_observed_at": frames[-1]["observed_at"],
            "last_stage": frames[-1]["stage"],
            "last_action": {"action_id": action_id, "request_sha": request_sha}})
        receipt = seal(dict(schema="l4-shadow-frame-receipt-v1", shadow_account=account,
            entry_checksum=entry["checksum"], serving_identity=entry["serving_identity"],
            action_id=action_id, request_sha=request_sha, previous_checksum=current["checksum"],
            state_checksum=next_state["checksum"], execution_owner=current["execution_owner"],
            native_result={k: v for k, v in result.items() if k != "state_sql"},
            production_effect=False, outer_acceptance_credit=0))
        # Seal the recovery receipt before advancing the head. A concurrent writer
        # cannot overwrite another account state; callers must retry against it.
        self._put(account + "/pending/" + request_sha + ".json", receipt)
        self._publish(account, next_state, generation)
        return self._put(path, receipt)
