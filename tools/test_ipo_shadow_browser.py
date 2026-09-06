"""Local browser verification with synthetic data; every non-local request is denied."""
from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "audits/local-test-runtime"))
from playwright.sync_api import sync_playwright

OUT = ROOT / "audits/outbox/2026-09-05-l4-ipo-local-closure"
OUT.mkdir(parents=True, exist_ok=True)
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    page = browser.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/*", lambda route: route.continue_() if route.request.url.startswith("http://127.0.0.1:5178/") else route.abort())
    checks = []
    for width, height in [(1280, 1000), (390, 844), (320, 720)]:
        page.set_viewport_size({"width": width, "height": height})
        page.goto("http://127.0.0.1:5178/tests/ipo-shadow-review.html", wait_until="networkidle")
        page.get_by_role("heading", name="L4 × IPO 同步對照").wait_for()
        overflow = page.evaluate("document.documentElement.scrollWidth > window.innerWidth")
        assert not overflow, f"Horizontal overflow at {width}px"
        assert page.get_by_text("當日封存 L4", exact=True).is_visible()
        assert page.get_by_text("固定 IPO shadow", exact=True).is_visible()
        page.screenshot(path=str(OUT / f"ipo-shadow-{width}.png"), full_page=True)
        checks.append({"width": width, "horizontal_overflow": overflow, "comparison_visible": True})
    page.evaluate("window.renderIpo({...window.ipoFixture,status:'not_registered',candidate_id:null,daily:[],frozen_dates:0,frozen_rows:0,mature_dates:0,paired_dates:0,latest_frozen_date:null})")
    page.get_by_text("等待第一批當日原生快照。", exact=False).wait_for()
    page.evaluate("window.renderIpo({...window.ipoFixture,status:'unavailable',daily:[],blockers:['ipo_shadow_migration_missing']})")
    page.get_by_role("status").wait_for()
    assert "ipo_shadow_migration_missing" in page.get_by_role("status").inner_text()
    assert not errors, errors
    browser.close()
    print(json.dumps({"fixture": "synthetic_not_production", "checks": checks, "page_errors": errors,
                      "missing_and_error_states": "pass"}, ensure_ascii=False))
