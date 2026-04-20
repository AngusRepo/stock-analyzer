"""
discord_alert.py — Lightweight Discord webhook client for ML_POOL events.

2026-04-19 ML_POOL Plan A Stage 5:
  - Sends lifecycle event notifications (promote / demote / retire / recovery)
  - Sends weekly IC summary report (post Friday cron)
  - Reads DISCORD_WEBHOOK_URL from env; no-op if absent (graceful)

Usage:
    from services.discord_alert import alert_lifecycle, alert_weekly_ic_summary
    alert_lifecycle("promote", "XGBoost", from_status="challenger", to_status="active",
                    reason="4w IC 0.142 > active 0.131 + margin 0.01")

To enable in production:
    gcloud run services update ml-controller --region=asia-east1 \\
      --update-env-vars DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
"""
from __future__ import annotations
import json
import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_DISCORD_TIMEOUT = 10.0
_MAX_DESCRIPTION = 4096       # Discord embed description limit
_MAX_FIELDS = 25               # per embed

# Color palette for embed left-bar (matches Discord conventions)
_COLOR = {
    "promote":  0x57F287,      # green
    "demote":   0xFEE75C,      # yellow
    "retire":   0xED4245,      # red
    "recovery": 0x3498DB,      # blue
    "register": 0x9B59B6,      # purple — new challenger registered
    "discard":  0x95A5A6,      # gray — challenger discarded
    "summary":  0x5865F2,      # blurple — weekly IC report
    "error":    0xED4245,      # red
}


def _webhook_url() -> Optional[str]:
    """Read webhook from env. Returns None if unset (caller should no-op)."""
    return os.environ.get("DISCORD_WEBHOOK_URL") or None


def _twd_now_iso() -> str:
    """Friendly TWD timestamp for Discord display."""
    tw = datetime.now(timezone.utc) + timedelta(hours=8)
    return tw.strftime("%Y-%m-%d %H:%M") + " TWD"


def _post_embed(embed: dict) -> bool:
    """Send a single embed. Returns True on 2xx, False otherwise / on missing URL."""
    url = _webhook_url()
    if not url:
        logger.debug("[DiscordAlert] DISCORD_WEBHOOK_URL not set — skipping send")
        return False
    payload = {"embeds": [embed]}
    try:
        with httpx.Client(timeout=_DISCORD_TIMEOUT) as client:
            r = client.post(url, json=payload)
        if 200 <= r.status_code < 300:
            return True
        logger.warning(f"[DiscordAlert] webhook returned {r.status_code}: {r.text[:200]}")
        return False
    except Exception as e:
        logger.warning(f"[DiscordAlert] post failed: {e}")
        return False


# ─────────────────────────────────────────────────────────────────────────────
# Public alert types
# ─────────────────────────────────────────────────────────────────────────────


def alert_lifecycle(
    event: str,             # "promote" | "demote" | "retire" | "recovery" | "register" | "discard"
    model_name: str,
    *,
    from_status: Optional[str] = None,
    to_status: Optional[str] = None,
    reason: str = "",
    metrics: Optional[dict] = None,
) -> bool:
    """Send a lifecycle transition alert.

    metrics dict keys are rendered as fields (e.g. {"ic_4w_avg": 0.13, "weekly_ic": [...]}).
    """
    icon = {
        "promote": "🟢", "demote": "🟡", "retire": "🔴",
        "recovery": "🔵", "register": "🟣", "discard": "⚪",
    }.get(event, "⚪")
    title = f"{icon} ML_POOL {event.upper()} — {model_name}"
    desc_lines = []
    if from_status and to_status:
        desc_lines.append(f"**Status:** `{from_status}` → `{to_status}`")
    if reason:
        desc_lines.append(f"**Reason:** {reason}")
    desc_lines.append(f"**At:** {_twd_now_iso()}")
    description = "\n".join(desc_lines)[:_MAX_DESCRIPTION]

    fields = []
    if metrics:
        for k, v in list(metrics.items())[:_MAX_FIELDS]:
            value_str = json.dumps(v) if not isinstance(v, str) else v
            fields.append({"name": k, "value": f"`{value_str[:1024]}`", "inline": True})

    embed = {
        "title": title,
        "description": description,
        "color": _COLOR.get(event, 0x95A5A6),
        "fields": fields,
        "footer": {"text": "ML_POOL · Stage 5 alerts"},
    }
    return _post_embed(embed)


def alert_weekly_ic_summary(per_model_ic: dict, pool_changes: Optional[dict] = None) -> bool:
    """Friday weekly IC tracker post-run summary.

    per_model_ic format (from /model_pool/compute_weekly_ic):
      {model_name: {"status": "computed"|"insufficient_samples", "ic": float, "n_samples": int}}
    pool_changes format (from same endpoint):
      {model_name: {"ic": ..., "ic_4w_avg": ..., "consecutive_negative_weeks": ..., "history_len": ...}}
    """
    fields = []
    computed = []
    insufficient = []
    for name, info in per_model_ic.items():
        if info.get("status") == "computed":
            ic = info.get("ic")
            n = info.get("n_samples", 0)
            arrow = "🟢" if (ic or 0) > 0 else "🔴"
            change = pool_changes.get(name) if pool_changes else None
            extra = ""
            if change:
                avg4 = change.get("ic_4w_avg")
                neg = change.get("consecutive_negative_weeks", 0)
                extra = f" · 4w_avg={avg4:.3f}" if avg4 is not None else ""
                if neg >= 1:
                    extra += f" · 連{neg}週<0"
            computed.append(f"{arrow} **{name}**: {ic:+.4f} (n={n}){extra}")
        else:
            insufficient.append(f"{name} (n={info.get('n_samples', 0)})")

    desc_lines = ["**Computed IC:**", *computed] if computed else ["⚠️ No model has enough samples this week"]
    if insufficient:
        desc_lines.append("")
        desc_lines.append(f"**Insufficient samples:** {', '.join(insufficient)}")
    desc_lines.append("")
    desc_lines.append(f"**At:** {_twd_now_iso()}")
    description = "\n".join(desc_lines)[:_MAX_DESCRIPTION]

    embed = {
        "title": "📊 ML_POOL Weekly IC Summary",
        "description": description,
        "color": _COLOR["summary"],
        "footer": {"text": "ML_POOL · Stage 2 cron · Stage 5 alert"},
    }
    return _post_embed(embed)


def alert_error(context: str, error: str) -> bool:
    """Generic ML_POOL error alert (e.g. cron failure)."""
    embed = {
        "title": f"❌ ML_POOL ERROR — {context}",
        "description": f"```\n{str(error)[:1800]}\n```\n**At:** {_twd_now_iso()}",
        "color": _COLOR["error"],
        "footer": {"text": "ML_POOL · Stage 5 alerts"},
    }
    return _post_embed(embed)


def is_enabled() -> bool:
    """For callers wanting to short-circuit expensive prep when no webhook set."""
    return bool(_webhook_url())
