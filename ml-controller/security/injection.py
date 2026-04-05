"""
injection.py — Prompt Injection Detection for LLM outputs (P1#14)

Detects patterns in LLM output that indicate prompt injection:
  - "ignore previous instructions"
  - "all in" / "sell everything" / "buy maximum"
  - Unusual urgency or authority claims
  - JSON/code injection attempts

If dangerous patterns detected, the debate verdict is auto-downgraded
to a safe template response.
"""
import re
import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# ── Danger Patterns ───────────────────────────────────────────────────────────
# Each pattern: (regex, severity, description)
DANGER_PATTERNS = [
    # Instruction override attempts
    (r"ignore\s+(all\s+)?(previous|above|prior)\s+(instruction|prompt|rule)", "critical", "instruction_override"),
    (r"disregard\s+(everything|all|the)\s+(above|previous)", "critical", "instruction_override"),
    (r"forget\s+(your|all|previous)\s+(instruction|rule|prompt)", "critical", "instruction_override"),
    (r"you\s+are\s+now\s+a", "critical", "role_hijack"),
    (r"system\s*:\s*you\s+are", "critical", "system_prompt_inject"),

    # Extreme trading instructions
    (r"\b(all[\s-]?in|go\s+all\s+in)\b", "high", "extreme_action"),
    (r"\b(sell\s+everything|liquidate\s+all|dump\s+all)\b", "high", "extreme_action"),
    (r"\b(buy\s+maximum|max\s+position|maximum\s+leverage)\b", "high", "extreme_action"),
    (r"\b(100%\s+of\s+(portfolio|cash|capital))\b", "high", "extreme_action"),
    (r"\b(guaranteed|risk[\s-]?free|cannot\s+lose|sure\s+thing)\b", "medium", "unrealistic_claim"),

    # Urgency manipulation
    (r"\b(act\s+now|immediately|urgent|don'?t\s+wait|must\s+buy\s+today)\b", "medium", "urgency_manipulation"),
    (r"\b(insider|confidential|secret\s+info|tip\s+from)\b", "high", "insider_claim"),

    # Code/JSON injection
    (r"```(python|javascript|bash|sh|sql)", "critical", "code_injection"),
    (r"\{[\s]*[\"']?(system|role|prompt)[\"']?\s*:", "high", "json_injection"),
]

# Compile patterns for performance
COMPILED_PATTERNS = [
    (re.compile(pattern, re.IGNORECASE), severity, desc)
    for pattern, severity, desc in DANGER_PATTERNS
]


@dataclass
class InjectionCheckResult:
    is_safe: bool = True
    severity: str = "none"        # "none" | "medium" | "high" | "critical"
    matches: list[dict] = None
    action: str = "pass"          # "pass" | "downgrade" | "reject"
    original_text: str = ""
    sanitized_text: str = ""

    def __post_init__(self):
        if self.matches is None:
            self.matches = []


def check_injection(text: str) -> InjectionCheckResult:
    """
    Scan LLM output for prompt injection patterns.

    Returns:
        InjectionCheckResult with:
        - is_safe: True if no dangerous patterns found
        - severity: highest severity found
        - matches: list of matched patterns
        - action: "pass" / "downgrade" / "reject"
    """
    result = InjectionCheckResult(original_text=text[:500])
    matches = []

    for pattern, severity, desc in COMPILED_PATTERNS:
        found = pattern.findall(text)
        if found:
            matches.append({
                "pattern": desc,
                "severity": severity,
                "matches": [str(f)[:100] for f in found[:3]],
            })

    if not matches:
        result.is_safe = True
        result.severity = "none"
        result.action = "pass"
        return result

    result.is_safe = False
    result.matches = matches

    # Determine highest severity
    severities = [m["severity"] for m in matches]
    if "critical" in severities:
        result.severity = "critical"
        result.action = "reject"
    elif "high" in severities:
        result.severity = "high"
        result.action = "downgrade"
    else:
        result.severity = "medium"
        result.action = "downgrade"

    # Sanitize: replace dangerous content with safe template
    result.sanitized_text = _sanitize(text, matches)

    logger.warning(
        f"[Injection] Detected {len(matches)} patterns "
        f"(severity={result.severity}, action={result.action}): "
        + ", ".join(m["pattern"] for m in matches)
    )

    return result


def _sanitize(text: str, matches: list[dict]) -> str:
    """Replace dangerous patterns with safe placeholders."""
    sanitized = text
    for pattern, _, _ in COMPILED_PATTERNS:
        sanitized = pattern.sub("[FILTERED]", sanitized)
    return sanitized[:500]


# ── Template safe responses ───────────────────────────────────────────────────
SAFE_VERDICTS = {
    "APPROVE": "Based on technical and fundamental analysis, the recommendation appears reasonable within normal parameters.",
    "DOWNGRADE": "Analysis suggests elevated uncertainty. Recommend reduced position size as a precaution.",
    "REJECT": "Insufficient evidence to support this recommendation. Skip this opportunity.",
}
