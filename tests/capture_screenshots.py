"""Capture public README images from the real extension in a disposable profile.

Only built-in, disabled example scripts are stored. No companion is launched,
no token is read, and non-extension requests are blocked. Requires Playwright.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--browser', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
out = root / 'docs' / 'screenshots'
out.mkdir(parents=True, exist_ok=True)
temp_root = Path.home() / '.aki' / 'tmp'
temp_root.mkdir(parents=True, exist_ok=True)

examples = [
    ('reading-mode', 'Reading Mode', 'Give example articles a comfortable reading width.', 'reading', "document.querySelectorAll('article').forEach(article => {\n    article.style.maxWidth = '72ch';\n    article.style.marginInline = 'auto';\n    article.style.lineHeight = '1.7';\n});"),
    ('highlight-links', 'Highlight External Links', 'Outline links that lead away from the current example page.', 'navigation', "document.querySelectorAll('a[href]').forEach(link => {\n    if (link.origin !== location.origin) {\n        link.style.outline = '1px solid #6c8cff';\n    }\n});"),
    ('table-summary', 'Table Row Summary', 'Count rows in example tables and report totals to the console.', 'tables', "document.querySelectorAll('table').forEach((table, index) => {\n    console.info(`Table ${index + 1}: ${table.rows.length} rows`);\n});"),
    ('page-outline', 'Page Outline', 'List page headings in the developer console.', 'navigation', "const headings = [...document.querySelectorAll('h1, h2, h3')];\nconsole.table(headings.map(h => ({\n    level: h.tagName,\n    title: h.textContent.trim()\n})));"),
    ('focus-guide', 'Focus Guide', 'Make keyboard focus easier to see on example form fields.', 'accessibility', "document.querySelectorAll('input, button').forEach(control => {\n    control.addEventListener('focus', () => {\n        control.style.outline = '2px solid #6c8cff';\n    });\n});"),
    ('image-summary', 'Image Summary', 'Inspect alternative text on example images.', 'accessibility', "console.table([...document.images].map(image => ({\n    alternativeText: image.alt || '(missing)',\n    width: image.naturalWidth,\n    height: image.naturalHeight\n})));"),
]
scripts = []
for i, (slug, name, description, tag, code) in enumerate(examples):
    source = ('// ==UserScript==\n// @name         Example: ' + name +
              '\n// @version      1.0.0\n// @description  ' + description +
              '\n// @match        https://example.com/*\n// @run-at       document-idle\n// ==/UserScript==\n\n' +
              '// Documentation example. Review before enabling.\n' +
              "(function () {\n    'use strict';\n\n" +
              '\n'.join('    ' + line for line in code.splitlines()) + '\n})();\n')
    scripts.append({'id': 'docs-' + slug, 'name': 'Example: ' + name,
                    'description': description, 'category': 'browser',
                    'language': 'javascript', 'code': source, 'enabled': False,
                    'match_patterns': ['https://example.com/*'], 'tags': ['example', tag],
                    'version': '1.0.0', 'run_at': 'document-idle', 'trigger': 'manual',
                    'env_vars': {}, 'created_at': '2026-10-14T12:00:00Z',
                    'updated_at': '2026-10-14T12:00:00Z', 'order': i})

checks = []
errors = []
blocked = []
def check(name, condition):
    assert condition, name
    checks.append(name)

with tempfile.TemporaryDirectory(prefix='scriptbridge-docs-', dir=temp_root) as work:
    with sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            str(Path(work) / 'browser'), executable_path=args.browser, headless=True,
            viewport={'width': 1440, 'height': 900}, device_scale_factor=1,
            reduced_motion='reduce',
            args=[f'--disable-extensions-except={root / "extension"}',
                  f'--load-extension={root / "extension"}',
                  '--disable-background-networking', '--no-first-run',
                  '--host-resolver-rules=MAP * ~NOTFOUND'])
        try:
            workers = context.service_workers
            worker = workers[0] if workers else context.wait_for_event('serviceworker')
            base = worker.url.rsplit('/', 1)[0]
            def route_request(route):
                if route.request.url.startswith(base + '/'):
                    route.continue_()
                else:
                    blocked.append(urlsplit(route.request.url).scheme)
                    route.abort()
            context.route('**/*', route_request)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(base + '/dashboard.html')
            expect(page.locator('#script-list')).to_be_visible()
            check('fresh profile has no pairing token', page.evaluate("async () => !(await chrome.storage.local.get('companionToken')).companionToken"))
            result = page.evaluate("s => chrome.runtime.sendMessage({action:'saveScripts',scripts:s})", scripts)
            check('real worker accepted disabled documentation examples', result.get('ok') is True)
            result = page.evaluate("() => chrome.runtime.sendMessage({action:'saveSettings',settings:{layout:'grid'}})")
            check('real worker accepted grid layout setting', not result.get('error'))
            page.reload()
            expect(page.locator('.script-card')).to_have_count(6)
            check('examples remain disabled', page.evaluate("async () => (await chrome.storage.local.get('scripts')).scripts.every(s=>s.enabled===false)"))

            def capture(filename):
                page.mouse.move(1, 1)
                page.evaluate('window.scrollTo(0,0)')
                check(filename + ' fits viewport', page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
                text = page.locator('body').inner_text()
                check(filename + ' contains no local account or internal links', not re.search(r'C:\\Users\\|amazon\.com|mcm\.', text, re.I))
                check(filename + ' contains no 64-character hex secret', not re.search(r'\b[0-9a-f]{64}\b', text, re.I))
                page.screenshot(path=str(out / filename), animations='disabled')

            capture('dashboard.png')
            page.locator('[data-action="edit"][data-id="docs-reading-mode"]').click()
            expect(page.locator('#editor-textarea')).to_contain_text('Documentation example')
            expect(page.locator('#editor-highlight code .hljs-keyword').first).to_be_attached()
            capture('editor.png')
            page.locator('[data-page="companion"]').click()
            expect(page.locator('#pair-status')).to_contain_text('Not connected')
            expect(page.locator('#companion-token')).to_have_value('')
            check('pairing field masked and empty', page.locator('#companion-token').get_attribute('type') == 'password')
            capture('companion.png')
            page.locator('[data-page="guide"]').click()
            expect(page.locator('#guide-container')).to_contain_text('Page-triggered native execution is disabled')
            capture('guide.png')
            check('no page errors', not errors)
            check('no attempted non-extension requests', not blocked)
            check('no token added during capture', page.evaluate("async () => !(await chrome.storage.local.get('companionToken')).companionToken"))
        finally:
            context.close()

images = []
for image in sorted(out.glob('*.png')):
    data = image.read_bytes()
    check(image.name + ' valid PNG', data.startswith(b'\x89PNG\r\n\x1a\n'))
    images.append({'file': image.name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
print(json.dumps({'passed': len(checks), 'failed': 0, 'checks': checks, 'images': images}, indent=2))
