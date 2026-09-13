"""Local-only UI checks. Every API response is intercepted; never contacts prod."""
import argparse
from copy import deepcopy
import json
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--fixture', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--url', default='http://127.0.0.1:4178')
args = parser.parse_args()
fixture = json.loads(Path(args.fixture).read_text(encoding='utf-8'))
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1100}, service_workers='block')
    requests, errors = [], []
    mode = {'value': 'populated'}

    def intercept(route):
        parsed = urlparse(route.request.url)
        path = parsed.path
        if '/api/' not in path:
            if parsed.hostname not in {'127.0.0.1', 'localhost'}:
                route.abort()
            else:
                route.continue_()
            return
        requests.append((route.request.method, path))
        assert route.request.method == 'GET', f'Unexpected mutation: {path}'
        if path.endswith('/auth/me'):
            body = {'id': 1, 'role': 'admin', 'is_primary_admin': True, 'name': 'Local NAV test', 'email': 'test@example.invalid'}
        elif '/nav/comparisons/' in path:
            body = deepcopy(fixture['details'][path.rsplit('/', 1)[-1]])
            cutoff = parse_qs(parsed.query).get('date', [None])[0]
            if cutoff:
                body['history'] = [r for r in body['history'] if r['date'] <= cutoff]
                # Historical account is intentionally not fabricated from curves.
                body['latest'] = None
                body['status'] = 'not_found'
            if mode['value'] == 'missing':
                body['latest']['receipt_status'] = 'missing'
                body['latest']['fills'] = None
            if mode['value'] == 'invalid':
                body.update(status='unavailable', latest=None, history=[])
        elif path.endswith('/nav/comparisons'):
            body = deepcopy(fixture['list'])
            if mode['value'] == 'empty':
                body.update(status='awaiting_allocation_context', pairs=[], allocation_context_dates=0, latest_allocation_context_date=None)
            if mode['value'] == 'error':
                route.fulfill(status=503, json={'error': 'Synthetic read failure'})
                return
        elif '/paper/' in path:
            body = [] if any(x in path for x in ['positions', 'orders', 'trades', 'events', 'snapshots', 'pending']) else {}
        else:
            body = {}
        route.fulfill(status=200, json=body)

    context.route('**/*', intercept)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(args.url + '/bot?tab=nav')
    page.wait_for_load_state('networkidle')
    expect(page.get_by_role('heading', name='NAV 候選比較', exact=True)).to_be_visible()
    expect(page.get_by_role('heading', name='成本後 NAV 走勢')).to_be_visible()
    assert not [path for _, path in requests if '/paper/' in path], 'Inactive Paper tab fetched accounts'
    assert not errors, errors
    page.evaluate("""() => { const banner = document.createElement('div'); banner.textContent = '本機合成測試資料 · 非正式績效'; banner.style.cssText = 'padding:12px;background:#78350f;color:white;text-align:center;font-weight:bold'; document.querySelector('section[aria-label="NAV 候選比較"]').prepend(banner); }""")
    page.screenshot(path=str(output / 'desktop.png'), full_page=True)
    before_refresh = sum('/nav/comparisons/' in path for _, path in requests)
    page.get_by_role('button', name='重新整理', exact=True).click()
    page.wait_for_load_state('networkidle')
    assert sum('/nav/comparisons/' in path for _, path in requests) > before_refresh, 'Refresh must update account details too'
    pairs = list(fixture['details'])
    page.get_by_label('比較組合', exact=True).select_option(pairs[1])
    expect(page.get_by_label('比較組合', exact=True)).to_have_value(pairs[1])
    expect(page.get_by_role('heading', name='候選模擬帳戶')).to_be_visible()
    page.get_by_text('逐日淨值與報酬數據', exact=True).click()
    expect(page.get_by_role('columnheader', name='差異（百分點）')).to_be_visible()
    page.get_by_label('帳務截止日', exact=True).fill('2026-09-09')
    expect(page.get_by_text('指定截止日尚無這組比較的帳本。')).to_be_visible()
    page.get_by_label('帳務截止日', exact=True).fill('')
    expect(page.get_by_role('heading', name='成本後 NAV 走勢')).to_be_visible()
    page.set_viewport_size({'width': 390, 'height': 844})
    page.screenshot(path=str(output / 'mobile.png'), full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile page overflows horizontally'
    baseline = page.get_by_role('article', name='凍結基準帳戶').bounding_box()
    candidate = page.get_by_role('article', name='候選模擬帳戶').bounding_box()
    assert candidate['y'] > baseline['y'], 'Mobile accounts must stack'
    for value, text in [('empty', '尚無配對模擬帳本'), ('missing', '尚缺封存成交收據，不能推定零成交。'),
                        ('invalid', '帳本讀取或完整性驗證失敗；不顯示為零資產。'), ('error', '比較列表讀取失敗，請重新整理；不是沒有候選。')]:
        mode['value'] = value
        page.reload()
        expect(page.get_by_text(text, exact=True).first).to_be_visible(timeout=20000)
    mode['value'] = 'populated'
    page.reload()
    expect(page.get_by_role('heading', name='成本後 NAV 走勢')).to_be_visible()
    page.get_by_role('tab', name='現行 Paper', exact=True).click()
    expect(page.get_by_role('tab', name='現行 Paper', exact=True)).to_have_attribute('data-state', 'active')
    assert urlparse(page.url).query == ''
    page.go_back()
    expect(page.get_by_role('tab', name='NAV 候選比較', exact=True)).to_have_attribute('data-state', 'active')
    expect(page.get_by_role('heading', name='成本後 NAV 走勢')).to_be_visible()
    assert not errors, errors
    (output / 'result.json').write_text(json.dumps({'source': fixture['source'], 'checks': ['desktop', 'mobile', 'no_horizontal_overflow',
        'account_stack', 'candidate_selection', 'date_cutoff', 'empty', 'missing_receipt', 'invalid_journal', 'http_error',
        'paper_tab', 'browser_back', 'no_mutation', 'no_production_network'], 'page_errors': errors}, ensure_ascii=False, indent=2), encoding='utf-8')
    browser.close()
print('NAV browser checks passed: desktop/mobile, accounts, history, empty/error, readonly isolation and tab navigation')
