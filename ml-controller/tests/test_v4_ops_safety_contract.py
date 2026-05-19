from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.v4_ops_safety_contract import (  # noqa: E402
    OPS_SAFETY_SCHEMA_VERSION,
    build_v4_ops_safety_policy,
    evaluate_v4_ops_action,
    validate_v4_ops_safety_packet,
)


def test_policy_declares_secret_kill_switch_and_approval_boundaries():
    policy = build_v4_ops_safety_policy()

    assert policy["schema_version"] == OPS_SAFETY_SCHEMA_VERSION
    assert policy["finlab_secret_policy"] == {
        "storage": ["gcp_secret_manager", "cloudflare_secret"],
        "frontend_exposure_allowed": False,
        "log_secret_allowed": False,
        "production_auth_flow": "python -m finlab login",
    }
    assert policy["kill_switch"]["kv_key"] == "trading:risk_config"
    assert policy["kill_switch"]["path"] == "system.killSwitch"
    assert set(policy["explicit_approval_required"]) >= {
        "deploy",
        "retrain",
        "commit",
        "push",
        "real_order",
        "live_submit",
        "resource_change",
    }
    assert policy["resource_change_policy"]["approval_required"] is True
    assert "cloud_run_memory" in policy["resource_change_policy"]["owned_fields"]


def test_external_api_fetch_requires_backend_secret_cache_rate_limit_and_audit_log():
    packet = evaluate_v4_ops_action(
        {
            "action": "external_api_fetch",
            "source": "finnhub",
            "secret_location": "gcp_secret_manager",
            "frontend_exposes_secret": False,
            "cache_ttl_sec": 0,
            "rate_limit_configured": False,
            "audit_log_enabled": False,
        },
        generated_at="2026-05-17T00:00:00Z",
    )

    assert packet["decision"] == "BLOCK"
    assert packet["failed_gates"] == [
        "cache_required",
        "rate_limit_required",
        "audit_log_required",
    ]
    assert packet["can_execute"] is False
    assert validate_v4_ops_safety_packet(packet) == []


def test_external_api_fetch_blocks_frontend_secret_exposure():
    packet = evaluate_v4_ops_action(
        {
            "action": "external_api_fetch",
            "source": "finlab",
            "secret_location": "frontend_env",
            "frontend_exposes_secret": True,
            "cache_ttl_sec": 3600,
            "rate_limit_configured": True,
            "audit_log_enabled": True,
        },
        generated_at="2026-05-17T00:00:00Z",
    )

    assert packet["decision"] == "BLOCK"
    assert "secret_must_be_backend_only" in packet["failed_gates"]
    assert "frontend_secret_exposure_not_allowed" in packet["failed_gates"]


def test_real_order_is_blocked_by_kill_switch_even_with_human_approval():
    packet = evaluate_v4_ops_action(
        {
            "action": "real_order",
            "approved_by": "Wei",
            "approval_scope": "single_order_poc",
            "kill_switch_active": True,
            "audit_log_enabled": True,
        },
        generated_at="2026-05-17T00:00:00Z",
    )

    assert packet["decision"] == "BLOCK"
    assert packet["failed_gates"] == ["kill_switch_active"]
    assert packet["can_execute"] is False


def test_deploy_retrain_commit_and_push_require_explicit_wei_approval():
    for action in ["deploy", "retrain", "commit", "push"]:
        packet = evaluate_v4_ops_action(
            {
                "action": action,
                "approved_by": "",
                "approval_scope": "",
                "audit_log_enabled": True,
            },
            generated_at="2026-05-17T00:00:00Z",
        )

        assert packet["decision"] == "REQUIRE_APPROVAL"
        assert packet["failed_gates"] == ["explicit_wei_approval_required"]
        assert packet["can_execute"] is False
        assert validate_v4_ops_safety_packet(packet) == []


def test_validator_blocks_forged_execution_packet():
    packet = evaluate_v4_ops_action(
        {
            "action": "deploy",
            "approved_by": "",
            "approval_scope": "",
            "audit_log_enabled": True,
        },
        generated_at="2026-05-17T00:00:00Z",
    )
    packet["can_execute"] = True
    packet["decision"] = "ALLOW"

    assert validate_v4_ops_safety_packet(packet) == [
        "approval_required_action_cannot_be_forged_to_allow"
    ]


def test_cloud_run_or_modal_resource_change_requires_wei_reason_cost_and_audit():
    packet = evaluate_v4_ops_action(
        {
            "action": "resource_change",
            "source": "cloud_run:ml-controller",
            "approval_scope": "",
            "approved_by": "",
            "target": "cloud_run_memory",
            "from": "8Gi",
            "to": "16Gi",
            "audit_log_enabled": False,
        },
        generated_at="2026-05-18T00:00:00Z",
    )

    assert packet["decision"] == "REQUIRE_APPROVAL"
    assert packet["can_execute"] is False
    assert packet["failed_gates"] == [
        "explicit_wei_approval_required",
        "resource_change_reason_required",
        "estimated_cost_required",
        "audit_log_required",
    ]
    assert validate_v4_ops_safety_packet(packet) == []


def test_resource_change_allows_only_with_explicit_wei_approval_and_cost():
    packet = evaluate_v4_ops_action(
        {
            "action": "resource_change",
            "source": "modal:feature_selection_pipeline",
            "approval_scope": "raise timeout for one approved CPD smoke run",
            "approved_by": "Wei",
            "reason": "baseline profile shows timeout at unchanged model spec",
            "estimated_monthly_cost_usd": 4.25,
            "audit_log_enabled": True,
        },
        generated_at="2026-05-18T00:00:00Z",
    )

    assert packet["decision"] == "ALLOW_WITH_GUARDS"
    assert packet["can_execute"] is True
    assert packet["failed_gates"] == []
    assert validate_v4_ops_safety_packet(packet) == []
