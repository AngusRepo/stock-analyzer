"""T3 (C28-02): the PIT flag is derived from evidence and fails closed on any gap."""
import copy
import json

import pytest

from services import pit_certification as pc
from services.formal_feature_contract import FEATURES131
from pit_certification_fixture import approve, certified, inventory, passed_tests, pending


def test_repo_contract_is_pending_until_wei_approves():
    repo = pc.load_contract()
    # The repo copy is either the pending placeholder or a complete approval of its own content.
    assert (repo["approval_status"] == "pending_wei" and repo["approved_by"] is None) or pc.contract_approved(repo)
    contract = pending(repo)
    assert not pc.contract_approved(contract)
    attached, _ = certified(contract)
    receipt = attached["receipt"]
    assert receipt["point_in_time_vintage_certified"] is False and receipt["reasons"] == ["contract_not_approved"]
    assert pc.verify_receipt(attached, contract)["certified"] is False


@pytest.mark.parametrize("change", [{"approved_by": "  "}, {"approved_by": None}, {"approved_at": "yesterday"},
                                    {"approved_at": None}, {"approval_status": "pending_wei"}])
def test_approval_needs_a_named_approver_an_iso_time_and_the_approved_status(change):
    assert pc.contract_approved(approve(pc.load_contract()))
    assert not pc.contract_approved({**approve(pc.load_contract()), **change})


def test_approved_contract_with_complete_evidence_certifies():
    attached, contract = certified()
    receipt = attached["receipt"]
    assert receipt["point_in_time_vintage_certified"] is True and receipt["reasons"] == []
    assert receipt["contract_sha256"] == pc.contract_content_sha256(contract)
    assert pc.HISTORY_LIMITATION in receipt["limitations"]
    assert all(item["verified"] for item in receipt["evidence"].values())
    assert receipt["revision_masks"]["eps"]["verified"] and receipt["revision_masks"]["eps"]["cells"] == 1442
    assert receipt["datasets"]["market_value"]["level"] == "R"
    assert any("12.46%" in line for line in receipt["datasets"]["market_value"]["evidence"])
    verified = pc.verify_receipt(attached, contract)
    assert verified["certified"] is True and verified["receipt_sha256"] == attached["receipt_sha256"]


def test_every_auxiliary_capture_field_is_bound_by_a_lane_and_owned_by_a_dataset():
    from services.training_auxiliary_capture import FIELDS
    lane_fields = [f for fields in pc.LANE_AUXILIARY_FIELDS.values() for f in fields]
    assert sorted(lane_fields) == sorted(FIELDS) and sorted(pc.AUXILIARY_FIELD_DATASETS) == sorted(FIELDS)
    assert set(pc.AUXILIARY_FIELD_DATASETS.values()) <= set(pc.load_contract()["datasets"])


def test_a_versions_lag_table_cannot_change_under_the_same_version(monkeypatch):
    from app import pit_contract
    changed = copy.deepcopy(pc.load_contract())
    changed["feature_lags"]["eps"] = 2
    monkeypatch.setattr(pit_contract, "load", lambda version: changed)
    with pytest.raises(ValueError, match="pit_contract_feature_lags_changed_without_new_version"):
        pit_contract.feature_lags(pc.CONTRACT_VERSION)


def test_contract_owns_every_formal131_feature_once():
    contract = pc.load_contract()
    owners = [f for spec in contract["datasets"].values() for f in spec.get("features") or ()]
    assert sorted(owners) == sorted(FEATURES131) and len(owners) == 131
    assert {"label", "universe"} <= set(contract["datasets"])
    assert all(spec["level"] in pc.LEVELS for spec in contract["datasets"].values())


@pytest.mark.parametrize("change", ["level_u", "dataset_removed", "label_removed", "feature_unowned", "lag_split"])
def test_any_uncertified_source_fails_even_when_approved(change):
    contract = copy.deepcopy(pc.load_contract())
    if change == "level_u":
        contract["datasets"]["broker"]["level"] = "U"
    if change == "dataset_removed":
        del contract["datasets"]["us_quotes"]
    if change == "label_removed":
        del contract["datasets"]["label"]
    if change == "feature_unowned":
        contract["datasets"]["price_raw"]["features"].remove("KMID")
    if change == "lag_split":  # a dataset lag the feature layer would not apply
        contract["datasets"]["margin_short"]["lag_sessions"] = 0
    attached, approved = certified(approve(contract))
    assert attached["receipt"]["point_in_time_vintage_certified"] is False
    reasons = attached["receipt"]["reasons"]
    expected = {"level_u": "dataset_level_uncertified:broker", "dataset_removed": "feature_level_missing:us_sentiment_score",
                "label_removed": "dataset_level_missing:label", "feature_unowned": "feature_level_missing:KMID",
                "lag_split": "feature_lag_mismatch:margin_balance"}[change]
    assert expected in reasons
    assert pc.verify_receipt(attached, approved)["certified"] is False


def test_changed_contract_invalidates_an_old_receipt():
    attached, contract = certified()
    changed = copy.deepcopy(contract)
    changed["feature_lags"]["eps"] = 2
    verified = pc.verify_receipt(attached, approve(changed))
    assert verified["certified"] is False and "contract_sha256_mismatch" in verified["reasons"]
    # Editing the approval record alone does not count as approval.
    forged = copy.deepcopy(contract)
    forged["feature_lags"]["eps"] = 2
    assert not pc.contract_approved(forged)


@pytest.mark.parametrize("change", ["tampered", "forged_flag", "missing"])
def test_receipt_flag_is_never_trusted(change):
    attached, contract = certified(tests=passed_tests(T4="failed"))
    assert attached["receipt"]["reasons"] == ["test_not_passed:T4:failed"]
    if change == "tampered":
        attached["receipt"]["point_in_time_vintage_certified"] = True
        reasons = ["receipt_sha256_mismatch"]
    elif change == "forged_flag":
        attached = pc.attach({**attached["receipt"], "point_in_time_vintage_certified": True, "reasons": []})
        reasons = ["test_not_passed:T4:failed", "receipt_flag_not_derived"]
    else:
        attached, reasons = None, ["receipt_missing"]
    verified = pc.verify_receipt(attached, contract)
    assert verified["certified"] is False and verified["reasons"] == reasons


@pytest.mark.parametrize("change", ["inventory_blocked", "lane_missing", "field_missing"])
def test_unbound_capture_lanes_fail(change):
    inv = inventory()
    if change == "inventory_blocked":
        inv["status"] = "blocked"
    if change == "lane_missing":
        inv["manifest_sha256"] = {k: v for k, v in inv["manifest_sha256"].items() if not k.endswith("holding.json")}
    if change == "field_missing":
        del inv["auxiliary_field_captures"]["eps"]
    attached, _ = certified(inventory=inv)
    reasons = attached["receipt"]["reasons"]
    assert attached["receipt"]["point_in_time_vintage_certified"] is False
    assert {"inventory_blocked": "capture_inventory_not_ready", "lane_missing": "lane_manifest_unbound:training_shareholding",
            "field_missing": "lane_field_unbound:fundamental_factor_diversity:eps"}[change] in reasons


def test_junit_results_map_required_tests_and_skips_fail(tmp_path):
    xml = tmp_path / "junit.xml"
    xml.write_text(
        '<testsuites><testsuite>'
        '<testcase classname="tests.test_pit_truncation_equivalence" name="a"/>'
        '<testcase classname="tests.test_pit_lag_contract" name="b"/>'
        '<testcase classname="tests.test_pit_lag_contract" name="b2"><error/></testcase>'
        '<testcase classname="tests.test_sequence_scale_invariance" name="c"><skipped/></testcase>'
        '<testcase classname="tests.test_pit_revision_fixture" name="d"><failure/></testcase>'
        '</testsuite></testsuites>', encoding="utf-8")
    results = pc.test_results_from_junit([xml])["results"]
    assert {k: v["status"] for k, v in results.items()} == {"T1": "passed", "T2": "failed", "T4": "failed", "T5": "failed"}
    assert results["T2"]["tests"] == 2 and results["T2"]["errors"] == 1
    assert all(v["file_sha256"] for v in results.values())


def test_ml_service_binding_uses_the_same_hashes():
    from app import pit_contract
    contract = pc.load_contract()
    assert pit_contract.content_sha256(contract) == pc.contract_content_sha256(contract)
    assert pit_contract.load(pc.CONTRACT_VERSION) == contract
    attached, _ = certified()
    assert pit_contract.canonical_sha256(attached["receipt"]) == attached["receipt_sha256"]
    assert pit_contract.feature_lags(pc.CONTRACT_VERSION) == contract["feature_lags"]
    json.dumps(attached)  # the receipt travels in JSON payloads


def test_model_metadata_reads_the_flag_only_from_a_bound_receipt(monkeypatch):
    from app import pit_contract
    from app.full_fit_scope import bounds
    from app.timexer_cutoff import input_scope
    full_fit = dict(candidate_type="oof_full_fit_release", generation_mode="oof_full_fit_release",
                    run_date="2026-10-01", signal_date_max="2026-09-22", label_known_at_max="2026-10-01")
    oof = dict(generation_mode="purged_oof", run_date="2026-10-01", signal_date_max="2026-09-22",
               label_known_at_max="2026-10-01", train_start="2026-01-01", train_end="2026-06-30",
               test_start="2026-07-15", test_end="2026-09-22")
    # No receipt and no prep version: exactly the pre-C28-02 metadata.
    assert bounds(full_fit) == {"signal_date_max": "2026-09-22", "label_known_at_max": "2026-10-01",
                                "scope": "explicit_full_fit_samples", "point_in_time_vintage_certified": False}
    # The artifact records the prep's version even without a receipt, so serving must match its lags.
    unreceipted = bounds({**full_fit, "pit_contract_version": pc.CONTRACT_VERSION})
    assert unreceipted["pit_contract_version"] == pc.CONTRACT_VERSION
    assert unreceipted["point_in_time_vintage_certified"] is False
    with pytest.raises(ValueError, match="pit_contract_version_unknown"):
        bounds({**full_fit, "pit_contract_version": "pit-availability-contract-v0"})
    # A receipt is for the version the prep was built under.
    full_fit, oof = ({**full_fit, "pit_contract_version": pc.CONTRACT_VERSION},
                     {**oof, "pit_contract_version": pc.CONTRACT_VERSION})
    # Under a pending contract a derived receipt is false but still bound.
    monkeypatch.setattr(pit_contract, "load", lambda version: pending(pc.load_contract()))
    unapproved, contract = certified(pending(pc.load_contract()))
    with pytest.raises(ValueError, match="pit_certification_prep_version_mismatch"):
        input_scope({}, {**oof, "pit_contract_version": None, "pit_certification": unapproved})
    scope = input_scope({}, {**oof, "pit_certification": unapproved})
    assert scope["point_in_time_vintage_certified"] is False
    assert scope["pit_certification_sha256"] == unapproved["receipt_sha256"]
    assert scope["pit_contract_sha256"] == pc.contract_content_sha256(contract)
    assert scope["pit_contract_version"] == pc.CONTRACT_VERSION  # what serving must send
    # An approved receipt is true only where the service sees the same approved contract.
    attached, approved = certified()
    with pytest.raises(ValueError, match="pit_certification_flag_not_derived"):
        bounds({**full_fit, "pit_certification": attached})
    monkeypatch.setattr(pit_contract, "load", lambda version: approved)
    assert bounds({**full_fit, "pit_certification": attached})["point_in_time_vintage_certified"] is True
    forged = copy.deepcopy(attached)
    forged["receipt"]["reasons"] = []
    forged["receipt"]["capture_id"] = "other"
    with pytest.raises(ValueError, match="pit_certification_receipt_invalid"):
        bounds({**full_fit, "pit_certification": forged})
    stale = pc.attach({**attached["receipt"], "contract_sha256": "0" * 64})
    with pytest.raises(ValueError, match="pit_certification_contract_mismatch"):
        bounds({**full_fit, "pit_certification": stale})



@pytest.mark.parametrize("change", ["evidence_changed", "history_dropped", "limitation_dropped", "test_subset",
                                    "test_edited", "test_skipped", "pin_other_file", "pins_listed", "lag_unowned",
                                    "lag_undeclared"])
def test_evidence_test_pins_and_lag_ownership_gaps_fail(change):
    contract = copy.deepcopy(pc.load_contract())
    tests = passed_tests()
    if change == "evidence_changed":
        contract["evidence"]["e2"]["sha256"] = "0" * 64
    if change == "test_subset":  # a -k selection runs fewer cases than were approved
        tests["results"]["T2"]["tests"] -= 1
    if change == "test_edited":
        tests["results"]["T1"]["file_sha256"] = "c" * 64
    if change == "test_skipped":  # a status that disagrees with its own counts
        tests["results"]["T4"]["skipped"] = 1
    if change == "pin_other_file":
        contract["required_tests"]["T1"]["file"] = "ml-controller/tests/test_other.py"
    if change == "pins_listed":
        contract["required_tests"] = sorted(contract["required_tests"])
    if change == "lag_unowned":
        contract["datasets"]["us_quotes"]["lag_sessions"] = 1
    if change == "lag_undeclared":
        contract["feature_lags"]["foreign_net"] = 1
    attached, approved = certified(approve(contract), tests=tests)
    receipt = attached["receipt"]
    if change in ("history_dropped", "limitation_dropped"):
        kept = receipt["limitations"][1:] if change == "history_dropped" else receipt["limitations"][:-1]
        flag, reasons = pc.derive({**receipt, "limitations": kept}, approved)
    else:
        flag, reasons = receipt["point_in_time_vintage_certified"], receipt["reasons"]
    assert flag is False
    assert {"evidence_changed": "evidence_unverified:e2", "history_dropped": "history_limitation_missing",
            "limitation_dropped": "contract_limitation_missing", "test_skipped": "test_not_passed:T4:passed",
            "pin_other_file": "test_not_pinned:T1",
            "test_subset": "test_not_pinned:T2", "test_edited": "test_not_pinned:T1",
            "pins_listed": "required_tests_mismatch", "lag_unowned": "dataset_lag_unowned:us_quotes",
            "lag_undeclared": "feature_lag_undeclared:foreign_net"}[change] in reasons


@pytest.mark.parametrize("change, reason", [
    ("lane_field_dropped", "lane_fields_incomplete:revenue"),
    ("lane_two_manifests", "lane_manifest_unbound:daily_price"),
    ("evidence_dropped", "evidence_incomplete"),
    ("evidence_other_file", "evidence_sha256_mismatch:e2"),
    ("evidence_not_dict", "evidence_unverified:e2"),
    ("mask_dropped", "revision_masks_incomplete"),
    ("mask_unverified", "revision_mask_unverified:eps"),
    ("mask_other_file", "revision_mask_sha256_mismatch:eps"),
    ("schema_other", "receipt_schema_invalid"),
    ("contract_version_other", "contract_version_mismatch"),
    ("capture_id_empty", "capture_inventory_not_ready"),
    ("lane_sha_shape", "lane_manifest_unbound:daily_price"),
    ("field_sha_shape", "lane_field_unbound:fundamental_factor_diversity:eps"),
    ("test_sha_shape", "test_not_passed:T1:passed"),
    ("limitations_string", "history_limitation_missing"),  # substring matches must not count
])
def test_incomplete_or_self_declared_receipt_content_fails(change, reason):
    attached, contract = certified()
    receipt = copy.deepcopy(attached["receipt"])
    if change == "lane_field_dropped":
        del receipt["lanes"]["revenue"]["auxiliary_fields"]["revenue_mom"]
    if change == "lane_two_manifests":
        receipt["lanes"]["daily_price"]["manifests"]["other/manifest.json"] = "b" * 64
    if change == "evidence_dropped":
        del receipt["evidence"]["e7"]
    if change == "evidence_other_file":  # verified, but against a file the contract does not name
        receipt["evidence"]["e2"]["sha256"] = "b" * 64
    if change == "evidence_not_dict":
        receipt["evidence"]["e2"] = "verified"
    if change == "mask_dropped":
        del receipt["revision_masks"]["eps"]
    if change == "mask_unverified":
        receipt["revision_masks"]["eps"]["verified"] = False
    if change == "mask_other_file":
        receipt["revision_masks"]["eps"]["sha256"] = "b" * 64
    if change == "schema_other":
        receipt["schema_version"] = "pit-vintage-certification-v0"
    if change == "contract_version_other":
        receipt["contract_version"] = "pit-availability-contract-v0"
    if change == "capture_id_empty":
        receipt["capture"]["capture_id"] = ""
    if change == "lane_sha_shape":
        lane = receipt["lanes"]["daily_price"]["manifests"]
        lane[next(iter(lane))] = "B" * 64
    if change == "field_sha_shape":
        receipt["lanes"]["fundamental_factor_diversity"]["auxiliary_fields"]["eps"]["capture_manifest_sha256"] = "a" * 63
    if change == "test_sha_shape":
        receipt["tests"]["results"]["T1"]["file_sha256"] = "a" * 63
    if change == "limitations_string":
        receipt["limitations"] = "\n".join(receipt["limitations"])
    flag, reasons = pc.derive(receipt, contract)
    assert flag is False and reason in reasons


@pytest.mark.parametrize("change, reason", [
    ("unknown_feature", "feature_level_unknown:not_a_feature"),
    ("duplicate_feature", "feature_level_duplicate:KMID"),
    ("na_owns_features", "dataset_not_applicable_owns_features:holding"),
])
def test_contract_feature_ownership_gaps_fail(change, reason):
    contract = copy.deepcopy(pc.load_contract())
    if change == "unknown_feature":
        contract["datasets"]["price_raw"]["features"].append("not_a_feature")
    if change == "duplicate_feature":
        contract["datasets"]["indicator"]["features"].append("KMID")
    if change == "na_owns_features":
        contract["datasets"]["price_raw"]["features"].remove("KMID")
        contract["datasets"]["holding"]["features"] = ["KMID"]
    attached, _ = certified(approve(contract))
    assert attached["receipt"]["point_in_time_vintage_certified"] is False and reason in attached["receipt"]["reasons"]


def test_a_malformed_receipt_fails_closed_without_raising():
    attached, contract = certified()
    malformed = pc.attach({**attached["receipt"], "capture": ["run"]})
    verified = pc.verify_receipt(malformed, contract)
    assert verified["certified"] is False and verified["reasons"][0] == "receipt_malformed"


def test_repo_contract_pins_the_current_gate_test_files():
    for key, pin in pc.load_contract()["required_tests"].items():
        assert pin["file"] == pc.REQUIRED_TESTS[key] and pin["sha256"] == pc.file_sha256(pc.REPO / pin["file"]), key
        assert pin["cases"] > 0


class _Blob:
    def __init__(self, store, name):
        self.store, self.name = store, name

    def exists(self):
        return self.name in self.store

    def download_as_bytes(self):
        return self.store[self.name]

    def download_as_text(self):
        return self.store[self.name].decode("utf-8")


class _Bucket:
    name = "stockvision-models"

    def __init__(self):
        self.store = {}

    def blob(self, name):
        return _Blob(self.store, name)

    def put(self, name, value):
        self.store[name] = value if isinstance(value, bytes) else json.dumps(value).encode()
        return __import__("hashlib").sha256(self.store[name]).hexdigest()


RUN = "finlab/v4/backfill/run"


def _sealed(value, compact):
    import hashlib
    options = {"sort_keys": True, **({"separators": (",", ":")} if compact else {})}
    return {**value, "manifest_checksum": hashlib.sha256(json.dumps(value, **options).encode()).hexdigest()}


def _aux_path(field, family="finlab/v4/backfill"):
    return f"{family}/aux-{field}/raw/training_auxiliary_full_vintage/manifest.json"


def _bound_capture(lane_root=RUN, **prep_changes):
    """A capture, its receipt and one adjusted prep, all written to a fake bucket."""
    import hashlib
    from services.training_auxiliary_capture import FIELDS
    bucket = _Bucket()
    close = f"gs://{bucket.name}/{RUN}/raw/daily_price_full_vintage/close.parquet"
    sequence = _sealed({"status": "ready", "output_gcs_prefix": "seq", "lane_reports": [
        {"lane": "daily_price", "source_uri": {"close": close}}]}, compact=True)
    bucket.put("seq/prep/sequence_manifest.json", sequence)
    manifests = {RUN + "/raw" + suffix: bucket.put(RUN + "/raw" + suffix, {"lane": suffix})
                 for suffix in pc.LANE_MANIFESTS.values()}
    auxiliary = {f: {"capture_id": "run", "capture_manifest_path": _aux_path(f),
                     "capture_manifest_sha256": bucket.put(_aux_path(f), {"field": f})} for f in FIELDS}
    if lane_root != RUN:  # a receipt copied from another capture whose lane manifests are identical
        manifests = {lane_root + "/raw" + suffix: bucket.put(lane_root + "/raw" + suffix, {"lane": suffix})
                     for suffix in pc.LANE_MANIFESTS.values()}
    attached, contract = certified(inventory=inventory(capture_id="run", sequence_manifest_checksum=sequence["manifest_checksum"],
                                                       manifest_sha256=manifests, auxiliary_field_captures=auxiliary))
    bucket.put(RUN + "/" + pc.RECEIPT_FILE, attached)
    mask_sha = contract["revision_masks"]["eps"]["sha256"]
    prep = {"pit_contract_version": pc.CONTRACT_VERSION, "pit_contract_sha256": pc.contract_content_sha256(contract),
            "price_capture": {"capture_id": "run"},
            "roster_sidecar": {"schema_version": pc.ROSTER_SIDECAR_SCHEMA},
            "auxiliary_capture": {"field_captures": {f: {"capture_manifest_sha256": v["capture_manifest_sha256"]}
                                                     for f, v in auxiliary.items()},
                                  "fields": {"eps": {"revision_mask": {"sha256": mask_sha}}}}, **prep_changes}
    checksum = hashlib.sha256(json.dumps(prep, sort_keys=True).encode()).hexdigest()
    bucket.put("src/prep/immutable_receipt.json", {**prep, "receipt_checksum": checksum})
    bucket.put("adj/prep/manifest.json", _sealed({"status": "ready", "output_gcs_prefix": "adj", "source_gcs_prefix": "src",
                                                  "source_receipt_checksum": checksum}, compact=False))
    return bucket, attached, contract


def _bound(bucket, contract, preps=("adj",)):
    return pc.verify_bound_receipt(bucket, sequence_gcs_prefix="seq", prep_gcs_prefixes=preps, contract=contract)


def test_a_bound_receipt_certifies_only_its_own_capture_and_preps():
    bucket, attached, contract = _bound_capture()
    verified = _bound(bucket, contract)
    assert verified["certified"] is True and verified["binding_reasons"] == []
    assert verified["receipt_sha256"] == attached["receipt_sha256"] and verified["attached"] == attached
    # No receipt beside the capture: nothing to bind.
    del bucket.store[RUN + "/" + pc.RECEIPT_FILE]
    assert _bound(bucket, contract)["reasons"] == ["receipt_missing"]


@pytest.mark.parametrize("change, reason", [
    ("lane_manifest", "lane_manifest_changed:daily_price"),
    ("aux_manifest", "lane_field_changed:fundamental_factor_diversity:eps"),
    ("sequence", "receipt_capture_mismatch"),
    ("prep_missing", "prep_receipt_missing:adj"),
    ("prep_tampered", "prep_receipt_checksum_mismatch:adj"),
    ("adjusted_lineage", "prep_receipt_checksum_mismatch:adj"),
])
def test_capture_or_prep_drift_unbinds_the_receipt(change, reason):
    bucket, _, contract = _bound_capture()
    if change == "lane_manifest":
        bucket.put(RUN + "/raw" + pc.LANE_MANIFESTS["daily_price"], {"lane": "rewritten"})
    if change == "aux_manifest":
        bucket.put(_aux_path("eps"), {"field": "eps", "rewritten": True})
    if change == "sequence":
        old = json.loads(bucket.store["seq/prep/sequence_manifest.json"])
        bucket.put("seq/prep/sequence_manifest.json", _sealed({**{k: v for k, v in old.items() if k != "manifest_checksum"},
                                                               "rebuilt": True}, compact=True))
    if change == "prep_missing":
        del bucket.store["src/prep/immutable_receipt.json"]
    if change == "prep_tampered":
        prep = json.loads(bucket.store["src/prep/immutable_receipt.json"])
        bucket.put("src/prep/immutable_receipt.json", {**prep, "pit_contract_version": None})
    if change == "adjusted_lineage":  # the adjusted prep names another source receipt
        adjusted = json.loads(bucket.store["adj/prep/manifest.json"])
        bucket.put("adj/prep/manifest.json", _sealed({**{k: v for k, v in adjusted.items() if k != "manifest_checksum"},
                                                      "source_receipt_checksum": "0" * 64}, compact=False))
    verified = _bound(bucket, contract)
    assert verified["certified"] is False and reason in verified["binding_reasons"]


@pytest.mark.parametrize("changes, reason", [
    ({"pit_contract_version": None}, "prep_not_built_under_contract:adj"),
    ({"roster_sidecar": None}, "prep_roster_sidecar_missing:adj"),
    ({"price_capture": {"capture_id": "other"}}, "prep_capture_mismatch:adj"),
    ({"auxiliary_capture": {"field_captures": {}}}, "prep_auxiliary_capture_mismatch:adj:eps"),
    ({"pit_contract_sha256": "0" * 64}, "prep_not_built_under_contract:adj"),
    ({"auxiliary_capture": {"field_captures": {}, "fields": {}}}, "prep_revision_mask_mismatch:adj:eps"),
])
def test_a_prep_not_built_under_the_receipt_unbinds_it(changes, reason):
    bucket, _, contract = _bound_capture(**changes)
    assert _bound(bucket, contract, preps=())["certified"] is True  # the capture alone still binds
    verified = _bound(bucket, contract)
    assert verified["certified"] is False and reason in verified["binding_reasons"]


def test_a_receipt_copied_from_another_capture_does_not_bind():
    bucket, _, contract = _bound_capture(lane_root="finlab/v4/backfill/other")
    verified = _bound(bucket, contract, preps=())
    assert verified["certified"] is False
    assert {"lane_manifest_foreign:" + lane for lane in pc.LANE_MANIFESTS} <= set(verified["binding_reasons"])
    assert not any(r.startswith("lane_manifest_changed") for r in verified["binding_reasons"])


def test_a_malformed_binding_fails_closed_without_raising():
    bucket, attached, contract = _bound_capture()
    receipt = copy.deepcopy(attached["receipt"])
    receipt["lanes"]["extra"] = ["not", "a", "lane"]
    bucket.put(RUN + "/" + pc.RECEIPT_FILE, pc.attach(receipt))
    verified = _bound(bucket, contract, preps=())
    assert verified["certified"] is False and "receipt_binding_malformed" in verified["reasons"]


@pytest.mark.parametrize("path", ["{family}/aux-eps/raw/training_auxiliary_full_vintage/other.json",
                                  "{family}/aux-eps/raw/training_auxiliary_full_vintage/manifest.json.bak"])
def test_an_auxiliary_binding_must_name_a_capture_manifest(path):
    bucket, attached, _ = _bound_capture()
    receipt = copy.deepcopy(attached["receipt"])
    binding = receipt["lanes"]["fundamental_factor_diversity"]["auxiliary_fields"]["eps"]
    binding["capture_manifest_path"] = path.format(family="finlab/v4/backfill")
    binding["capture_manifest_sha256"] = bucket.put(binding["capture_manifest_path"], {"field": "eps"})
    assert pc.capture_binding_reasons(bucket, "seq", receipt) == ["lane_field_foreign:fundamental_factor_diversity:eps"]


def test_an_auxiliary_capture_outside_the_capture_family_does_not_bind():
    bucket, attached, contract = _bound_capture()
    receipt = copy.deepcopy(attached["receipt"])
    binding = receipt["lanes"]["fundamental_factor_diversity"]["auxiliary_fields"]["eps"]
    binding["capture_manifest_path"] = _aux_path("eps", family="elsewhere")
    binding["capture_manifest_sha256"] = bucket.put(binding["capture_manifest_path"], {"field": "eps"})
    reasons = pc.capture_binding_reasons(bucket, "seq", receipt)
    assert reasons == ["lane_field_foreign:fundamental_factor_diversity:eps"]


def test_prep_batches_must_report_the_contract_the_receipt_names():
    sha = pc.contract_content_sha256(pc.load_contract())
    binding = {"pit_contract_version": pc.CONTRACT_VERSION, "pit_contract_sha256": sha}
    applied = {"cleaning_report": {"pit_contract_version": pc.CONTRACT_VERSION, "pit_contract_sha256": sha}}
    assert pc.prep_batches_not_under_contract([applied, applied], binding) == []
    # An older ml-service ignores the fields; another image carries a different contract file.
    stale = {"cleaning_report": {"pit_contract_version": pc.CONTRACT_VERSION}}
    other = {"cleaning_report": {"pit_contract_version": pc.CONTRACT_VERSION, "pit_contract_sha256": "0" * 64}}
    assert pc.prep_batches_not_under_contract([applied, stale, other, {}, None, "x"], binding) == [1, 2, 3, 4, 5]
    # Legacy prep binds no contract and checks nothing.
    assert pc.prep_batches_not_under_contract([{}], {"price_capture": {}}) == []


def test_ml_service_prep_refuses_a_contract_file_the_controller_did_not_bind(monkeypatch):
    from app import universal_training
    request = universal_training.UniversalPrepRequest(payloads=[], pit_contract_version=pc.CONTRACT_VERSION,
                                                      pit_contract_sha256="0" * 64)
    with pytest.raises(ValueError, match="pit_contract_sha256_mismatch"):
        universal_training.prep_universal_batch(request)
    with pytest.raises(ValueError, match="pit_contract_sha256_mismatch"):
        universal_training.prep_universal_batch(request.model_copy(update={"pit_contract_sha256": None}))
    with pytest.raises(ValueError, match="pit_contract_sha256_without_version"):
        universal_training.prep_universal_batch(request.model_copy(update={"pit_contract_version": None}))


def test_retrain_trigger_never_forwards_a_receipt_it_did_not_bind(monkeypatch):
    import asyncio
    from google.cloud import storage
    from routers import retrain_trigger as rt
    from services import training_source_preflight

    def request(attached):
        return rt.UniversalRetrainTriggerRequest(pit_certification=attached, prebuilt_prep_gcs_prefix="adj")

    def dispatch(bucket, attached):
        monkeypatch.setattr(storage, "Client", lambda *a, **k: type("C", (), {"bucket": lambda self, name: bucket})())
        try:
            asyncio.run(rt._dispatch_prebuilt_oof_full_fit(req=request(attached), request=None, run_id="r",
                                                           run_date="2026-10-30", lock_key="k"))
        except (ValueError, LookupError) as exc:
            return str(exc)

    # Without a prebuilt prep there is nothing the receipt could be bound to.
    early = asyncio.run(rt.trigger_universal_retrain(
        rt.UniversalRetrainTriggerRequest(pit_certification={"receipt": {}, "receipt_sha256": "x"}), None))
    assert early == {"status": "rejected", "error": "pit_certification_requires_prebuilt_prep"}
    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models")
    monkeypatch.setattr(rt, "_verify_prebuilt_canonical_prep", lambda **kw: {"gcs_prefix": "adj", "sequence_gcs_prefix": "seq"})
    monkeypatch.setattr(training_source_preflight, "require_single_adjustment_capture", lambda *a, **k: None)

    def reached(**kw):
        raise LookupError("reached_sequence_verification")
    monkeypatch.setattr(rt, "_verify_prebuilt_sequence_prep", reached)
    bucket, attached, approved = _bound_capture()
    monkeypatch.setattr(pc, "load_contract", lambda: pending(approved))
    # A pending contract: even a correctly bound receipt is not forwarded.
    assert dispatch(bucket, attached) == "pit_certification_not_verified:contract_not_approved,receipt_flag_not_derived"
    monkeypatch.setattr(pc, "load_contract", lambda: approved)
    assert dispatch(bucket, attached) == "reached_sequence_verification"
    forged = {**attached, "receipt_sha256": "f" * 64}
    assert dispatch(bucket, forged) == "pit_certification_not_verified:request_receipt_sha256_mismatch"
    unbound, attached, _ = _bound_capture(pit_contract_version=None)
    assert dispatch(unbound, attached) == "pit_certification_not_verified:prep_not_built_under_contract:adj"


def test_retrain_trigger_forwards_the_stored_receipt_and_requires_one_for_a_pit_prep(monkeypatch):
    import asyncio
    from google.cloud import storage
    from routers import retrain_trigger as rt
    from services import modal_client, training_source_preflight

    bucket, attached, approved = _bound_capture()
    monkeypatch.setattr(pc, "load_contract", lambda: approved)
    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models")
    monkeypatch.setattr(storage, "Client", lambda *a, **k: type("C", (), {"bucket": lambda self, name: bucket})())
    monkeypatch.setattr(training_source_preflight, "require_single_adjustment_capture", lambda *a, **k: None)
    monkeypatch.setattr(rt, "_verify_prebuilt_sequence_prep",
                        lambda **kw: {"gcs_prefix": "seq", "batch_count": 1, "lineage_manifest_checksum": "l" * 64})
    monkeypatch.setattr(rt, "normalize_release_execution_scope", lambda groups, targets, **kw: (groups, targets))
    monkeypatch.setattr(rt, "build_release_training_contract", lambda **kw: {})
    monkeypatch.setattr(rt, "_runtime_source_sha", lambda: "0" * 40)
    sent = {}

    async def orchestrator(*, payload, fire_and_forget):
        sent.update(payload)
        raise LookupError("dispatched")
    monkeypatch.setattr(modal_client, "retrain_orchestrator", orchestrator)

    def dispatch(attached, verified):
        monkeypatch.setattr(rt, "_verify_prebuilt_canonical_prep", lambda **kw: verified)
        req = rt.UniversalRetrainTriggerRequest(
            pit_certification=attached, prebuilt_prep_gcs_prefix="adj", train_model_groups=[],
            prebuilt_prep_source_manifest_checksum="m" * 64, prebuilt_prep_source_cohort_id="c")
        try:
            asyncio.run(rt._dispatch_prebuilt_oof_full_fit(req=req, request=None, run_id="r",
                                                           run_date="2026-10-30", lock_key="k"))
        except (ValueError, LookupError) as exc:
            return str(exc)

    prep = {"gcs_prefix": "adj", "sequence_gcs_prefix": "seq", "batch_count": 1}
    # Same receipt_sha256 but altered content: the stored, bound receipt is what trainers get.
    altered = {**attached, "receipt": {**attached["receipt"], "generated_at": "elsewhere"}}
    assert dispatch(altered, prep) == "dispatched"
    assert sent["pit_certification"] == attached and "pit_contract_version" not in sent
    # Trainers get the version the prep was built under; ml-service requires the receipt to match.
    sent.clear()
    assert dispatch(attached, {**prep, "pit_contract_version": pc.CONTRACT_VERSION}) == "dispatched"
    assert sent["pit_contract_version"] == pc.CONTRACT_VERSION and sent["pit_certification"] == attached
    # A PIT prep without a receipt would train an artifact that does not record its lags.
    sent.clear()
    assert dispatch(None, {**prep, "pit_contract_version": pc.CONTRACT_VERSION}) == "pit_prep_requires_certification"
    assert dispatch(None, prep) == "dispatched" and "pit_certification" not in sent


@pytest.mark.parametrize("change", ["test_failed", "test_skipped", "test_unpinned", "evidence_unverified",
                                    "evidence_other_file", "mask_dropped", "level_u", "history_dropped",
                                    "limitation_dropped", "limitations_string", "reasons_kept"])
def test_ml_service_refuses_a_certified_receipt_missing_its_evidence(monkeypatch, change):
    from app import pit_contract
    from app.full_fit_scope import bounds
    attached, approved = certified()
    monkeypatch.setattr(pit_contract, "load", lambda version: approved)
    receipt = copy.deepcopy(attached["receipt"])
    if change == "test_failed":
        receipt["tests"]["results"]["T2"]["status"] = "failed"
    if change == "test_skipped":
        receipt["tests"]["results"]["T2"]["skipped"] = 1
    if change == "limitation_dropped":
        receipt["limitations"] = receipt["limitations"][:-1]
    if change == "limitations_string":
        receipt["limitations"] = "\n".join(receipt["limitations"])
    if change == "reasons_kept":  # certified, yet the receipt still lists a reason
        receipt["reasons"] = ["test_not_passed:T2:failed"]
    if change == "test_unpinned":
        receipt["tests"]["results"]["T5"]["file_sha256"] = "c" * 64
    if change == "evidence_unverified":
        receipt["evidence"]["e1"]["verified"] = False
    if change == "evidence_other_file":
        receipt["evidence"]["e1"]["sha256"] = "c" * 64
    if change == "mask_dropped":
        del receipt["revision_masks"]["eps"]
    if change == "level_u":
        receipt["datasets"]["broker"]["level"] = "U"
    if change == "history_dropped":
        receipt["limitations"] = receipt["limitations"][1:]
    full_fit = dict(candidate_type="oof_full_fit_release", generation_mode="oof_full_fit_release",
                    run_date="2026-10-01", signal_date_max="2026-09-22", label_known_at_max="2026-10-01",
                    pit_contract_version=pc.CONTRACT_VERSION, pit_certification=pc.attach(receipt))
    assert bounds({**full_fit, "pit_certification": attached})["point_in_time_vintage_certified"] is True
    with pytest.raises(ValueError, match="pit_certification_flag_not_derived"):
        bounds(full_fit)


def test_trainers_receive_the_receipt_and_the_prep_version():
    from app.training_policy import UniversalTrainingPolicy, build_group_train_payload
    from app.universal_training import UniversalTrainRequest
    attached, _ = certified()
    policy = UniversalTrainingPolicy.from_env()
    base = policy.to_base_train_payload({"pit_certification": attached, "pit_contract_version": pc.CONTRACT_VERSION},
                                        candidate_version="v")
    tree = build_group_train_payload(base, "tree")
    assert tree["pit_certification"] == attached and tree["pit_contract_version"] == pc.CONTRACT_VERSION
    assert UniversalTrainRequest(**{k: tree[k] for k in ("pit_certification", "pit_contract_version")}
                                 ).model_dump()["pit_contract_version"] == pc.CONTRACT_VERSION
    legacy = policy.to_base_train_payload({}, candidate_version="v")
    assert "pit_certification" not in legacy and "pit_contract_version" not in legacy
    source = (pc.REPO / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    forward = ('**({"pit_contract_version": payload["pit_contract_version"]} '
               'if payload.get("pit_contract_version") is not None else {}),')
    assert source.count(forward) == source.count('**({"pit_certification": payload["pit_certification"]}') == 4
    # The walk-forward cohort manifest records the contract its windows were trained under.
    assert '**({"pit_contract_version": prep_manifest["pit_contract_version"]}' in source


def test_ml_service_history_limitation_matches_the_controller():
    from app import pit_contract
    assert pit_contract.HISTORY_LIMITATION == pc.HISTORY_LIMITATION


def test_the_metadata_ml_service_writes_passes_the_lifecycle_binding_check(monkeypatch):
    # Cross-module: the lifecycle seal reads the keys vintage_scope really writes, at the
    # nesting each trainer family stores them (tree/TabM/GNN deployment_fit; NF/TimeXer top level).
    from app import pit_contract
    from app.full_fit_scope import bounds
    from services.alpha_model_roster import R33_MODELS
    from services.r33_monthly_lifecycle import artifacts_missing_pit_binding
    attached, approved = certified()
    monkeypatch.setattr(pit_contract, "load", lambda version: approved)
    payload = dict(candidate_type="oof_full_fit_release", generation_mode="oof_full_fit_release",
                   run_date="2026-10-01", signal_date_max="2026-09-22", label_known_at_max="2026-10-01",
                   pit_contract_version=pc.CONTRACT_VERSION, pit_certification=copy.deepcopy(attached))
    scope = bounds(payload)
    shapes = {"LightGBM": {"deployment_fit": {"input_scope": scope}},
              "ExtraTrees": {"deployment_fit": {"input_scope": scope}},
              "TabM": {"deployment_fit": {"input_scope": scope}},
              "GNN": {"deployment_fit": {"input_scope": scope}},
              "PatchTST": {"input_scope": {**scope, "admitted_rows": 3}},
              "iTransformer": {"input_scope": scope},
              "TimeXer": {"input_scope": {**scope, "archive_source_feature_date_max": "2026-10-01"}}}
    assert set(shapes) == set(R33_MODELS)
    bucket = _Bucket()
    registry = {"artifacts": {m: {"metadata_path": f"m/{m}.json"} for m in R33_MODELS}}
    for m in R33_MODELS:
        bucket.put(f"m/{m}.json", shapes[m])
    binding = dict(receipt_sha256=attached["receipt_sha256"], contract_version=attached["receipt"]["contract_version"])
    assert artifacts_missing_pit_binding(bucket, registry, **binding) == []
    # An older trainer image that dropped the receipt and version is caught.
    legacy = {k: v for k, v in payload.items() if k not in ("pit_certification", "pit_contract_version")}
    bucket.put("m/TabM.json", {"deployment_fit": {"input_scope": bounds(legacy)}})
    assert artifacts_missing_pit_binding(bucket, registry, **binding) == ["TabM"]
