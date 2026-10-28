"""Actual unpacked-extension checks in a disposable profile.
No default user data, installed browser profile, or plant access is used.
--companion starts ONLY the specified freshly-built binary on vacant port 9876
with SCRIPTBRIDGE_DATA_DIR set to a disposable directory. It executes one fixed
CMD echo fixture through the dashboard, never imported or existing user scripts.
"""
import argparse
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--browser', required=True)
parser.add_argument('--companion')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
tmp = Path.home() / '.aki' / 'tmp'
tmp.mkdir(parents=True, exist_ok=True)
checks = []

def check(name, valid=True):
    assert valid, name
    checks.append(name)

with tempfile.TemporaryDirectory(prefix='sb-security-', dir=tmp) as work:
    work = Path(work)
    process = None
    context = None
    try:
        if args.companion:
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 9876))
            data = work / 'data'
            data.mkdir()
            environment = dict(os.environ, SCRIPTBRIDGE_DATA_DIR=str(data))
            process = subprocess.Popen([str(Path(args.companion).resolve())], env=environment,
                                       cwd=work, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with sync_playwright() as pw:
            context = pw.chromium.launch_persistent_context(
                str(work / 'browser'), executable_path=args.browser, headless=True,
                args=[f'--disable-extensions-except={root / "extension"}',
                      f'--load-extension={root / "extension"}',
                      '--disable-background-networking', '--no-first-run',
                      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'])
            workers = context.service_workers
            worker = workers[0] if workers else context.wait_for_event('serviceworker')
            extension_id = worker.url.split('/')[2]
            base = f'chrome-extension://{extension_id}'
            errors = []
            denied_requests = []
            companion_responses = []
            context.on('response', lambda response: companion_responses.append({'path': urlsplit(response.url).path, 'status': response.status, 'origin': response.request.headers.get('origin')}) if urlsplit(response.url).port == 9876 else None)
            context.on('requestfailed', lambda request: companion_responses.append({'path': urlsplit(request.url).path, 'failure': request.failure}) if urlsplit(request.url).port == 9876 else None)
            fixture = 'http://scriptbridge.test/'
            payload = '\"><img src=x onerror="window.__pwn=1">'

            update_fetches = []
            retry_fetches = []
            reviewed_update = '// ==UserScript==\n// @name Update fixture\n// @version 2.0\n// ==/UserScript==\nconsole.log("REVIEWED_NOT_EXECUTED");'

            def route_request(route):
                url = urlsplit(route.request.url)
                if url.hostname in ('127.0.0.1', 'localhost') and url.port == 9876:
                    if args.companion:
                        route.continue_()
                    else:
                        route.abort()
                    return
                if url.hostname == 'scriptbridge.test':
                    if url.path == '/update.user.js':
                        update_fetches.append(route.request.url)
                        source = reviewed_update if len(update_fetches) == 1 else 'throw new Error("UNREVIEWED");'
                        route.fulfill(status=200, content_type='text/javascript', body=source)
                    elif url.path == '/offline.user.js':
                        route.abort()
                    elif url.path == '/forbidden.user.js':
                        route.fulfill(status=403, content_type='text/plain', body='Forbidden')
                    elif url.path == '/redirect.user.js':
                        route.fulfill(status=302, headers={'Location': fixture + 'login'})
                    elif url.path == '/login.user.js':
                        route.fulfill(status=200, content_type='text/html', body='<html><body>Sign in</body></html>')
                    elif url.path == '/html-as-text.user.js':
                        route.fulfill(status=200, content_type='text/plain', body='<!DOCTYPE html><html>Sign in</html>')
                    elif url.path == '/retry.user.js':
                        retry_fetches.append(route.request.url)
                        if len(retry_fetches) == 1:
                            route.abort()
                        else:
                            route.fulfill(status=200, content_type='text/javascript', body=reviewed_update)
                    elif url.path == '/metadata.js':
                        route.fulfill(status=200, content_type='text/javascript',
                                      body='// @version 2.0\n// @downloadURL ' + fixture + 'offline.user.js')
                    elif url.path == '/fixture.user.js':
                        source = ('// ==UserScript==\n// @name ' + payload +
                                  '\n// @homepage javascript:alert(1)\n// @match http://scriptbridge.test/*'
                                  '\n// ==/UserScript==\nconsole.log("review only");')
                        route.fulfill(status=200, content_type='text/javascript', body=source)
                    else:
                        route.fulfill(status=200, content_type='text/html', body='<html><body><h1>Hostile page fixture</h1></body></html>')
                    return
                if url.scheme == 'chrome-extension':
                    route.continue_()
                    return
                denied_requests.append(url.scheme + '://' + (url.hostname or '') + url.path)
                route.abort()

            context.route('**/*', route_request)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(base + '/dashboard.html#companion')
            expect(page.locator('#companion-token')).to_be_visible()
            check('unpacked extension dashboard loads')
            expect(page.locator('#companion-token')).to_have_attribute('type', 'password')
            check('pairing field masked')
            page.locator('#companion-token').fill('bad-token')
            page.locator('#btn-pair-companion').click()
            expect(page.locator('#pair-feedback')).to_contain_text('Pairing failed')
            expect(page.locator('#companion-token')).to_have_value('')
            check('malformed token rejected and field cleared')
            stored = page.evaluate("async () => Object.keys(await chrome.storage.local.get(null))")
            check('malformed token not stored', 'companionToken' not in stored)

            # Real extension IPC sender validation plus hostile imported metadata.
            browser_script = {'id': 'browser-fixture', 'name': payload, 'description': payload,
                              'category': 'browser', 'language': 'javascript', 'code': 'document.body.dataset.sbInjected = "yes";',
                              'enabled': True, 'match_patterns': [fixture + '*'], 'tags': [payload],
                              'version': payload, 'chain_group': payload, 'previous_version': payload,
                              'env_vars': {'TEST': payload}, 'created_at': '2026-10-14T00:00:00Z',
                              'updated_at': '2026-10-14T00:00:00Z'}
            response = page.evaluate("s => chrome.runtime.sendMessage({action:'saveScripts',scripts:[s]})", browser_script)
            check('trusted dashboard can save valid script', response.get('ok') is True)
            invalid = dict(browser_script, id=payload)
            response = page.evaluate("s => chrome.runtime.sendMessage({action:'saveScripts',scripts:[s]})", invalid)
            check('malformed imported id rejected', bool(response.get('error')))
            response = page.evaluate("() => chrome.runtime.sendMessage({action:'gmXhr',details:{url:'http://127.0.0.1:9876/api/reset'}})")
            check('removed privileged GM action denied even from UI', bool(response.get('error')))
            page.goto(base + '/dashboard.html')
            expect(page.locator('#script-list')).to_contain_text(payload)
            for layout in ['grid', 'list', 'table']:
                page.evaluate('(value) => {currentLayout=value; render(); populateTagFilter();}', layout)
                check('metadata is inert in ' + layout,
                      page.locator('img[src=x], [onerror], [onmouseover]').count() == 0)
            page.locator('[data-action="edit"]').first.click()
            expect(page.locator('#editor-textarea')).to_be_visible()
            check('editor variable values inert', page.locator('img[src=x], [onerror]').count() == 0)
            page.locator('[data-page="settings"]').click()
            expect(page.locator('#ss-security')).to_be_attached()
            check('fake security controls removed', page.locator('#s-sandbox,#s-allow-cors,#s-confirm-ext').count() == 0)
            page.locator('[data-section="security"]').click()
            expect(page.locator('#security-boundary')).to_be_visible()
            check('enforced boundary explained')
            page.locator('[data-page="guide"]').click()
            expect(page.locator('#guide-container')).to_contain_text('Page-triggered native execution is disabled')
            check('guide documents compatibility break')

            hostile = context.new_page()
            hostile.goto(fixture)
            expect(hostile.locator('body')).to_have_attribute('data-sb-injected', 'yes')
            check('ordinary browser userscript injection preserved')
            before = page.evaluate("() => chrome.storage.local.get('scripts')")
            reply = hostile.evaluate("""async () => {
                const messages = [];
                window.addEventListener('message', event => {
                    if (String(event.data?.type).includes('RESULT') || String(event.data?.type).includes('RESPONSE')) messages.push(event.data.type);
                });
                for (const type of ['SCRIPTBRIDGE_RUN','SCRIPTBRIDGE_RUN_ID','SCRIPTBRIDGE_GM_XHR','SCRIPTBRIDGE_GM_STORAGE']) {
                    window.postMessage({type,id:'hostile',name:'native-fixture',scriptId:'native-fixture',op:'get',key:'companionToken',details:{url:'http://127.0.0.1:9876/api/export'}}, '*');
                }
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                return {api: typeof window.ScriptBridge, messages, storage: typeof chrome?.storage};
            }""")
            check('web page has no native bridge or extension storage', reply == {'api': 'undefined', 'messages': [], 'storage': 'undefined'})
            check('hostile page did not mutate scripts', before == page.evaluate("() => chrome.storage.local.get('scripts')"))

            installer = context.new_page()
            installer.on('pageerror', lambda error: errors.append(str(error)))
            installer.goto(base + '/install.html?url=' + fixture + 'fixture.user.js')
            expect(installer.locator('#install-content')).to_contain_text('(unsupported link)')
            check('installer escapes metadata and invalid homepage', installer.locator('img[src=x], [onerror], a[href^="javascript:"]').count() == 0)
            page.goto(base + '/dashboard.html')
            dialogs = []
            def accept_dialog(dialog):
                dialogs.append(dialog.message)
                dialog.accept()
            page.on('dialog', accept_dialog)
            imported = {'id': 'imported-external', 'name': 'Import review fixture', 'description': '',
                        'category': 'external', 'language': 'cmd', 'code': 'echo NEVER_EXECUTED',
                        'enabled': True, 'trigger': 'onbrowserevent', 'tags': [], 'match_patterns': [], 'env_vars': {}}
            with page.expect_file_chooser() as chooser:
                page.locator('#btn-import').click()
            chooser.value.set_files({'name': 'fixture.json', 'mimeType': 'application/json',
                                     'buffer': json.dumps({'scripts': [imported]}).encode()})
            page.wait_for_function("async () => (await chrome.storage.local.get('scripts')).scripts?.some(s => s.id === 'imported-external')")
            imported_state = page.evaluate("async () => (await chrome.storage.local.get('scripts')).scripts.find(s => s.id === 'imported-external')")
            check('actual JSON import disables native script pending review', imported_state['enabled'] is False and imported_state['trigger'] == 'manual')
            with page.expect_file_chooser() as chooser:
                page.locator('#btn-import').click()
            with page.expect_event('dialog', predicate=lambda dialog: dialog.type == 'alert') as rejection:
                chooser.value.set_files({'name': 'malformed.json', 'mimeType': 'application/json',
                                         'buffer': json.dumps({'scripts': [invalid]}).encode()})
            check('invalid import reports validation error', 'invalid id' in rejection.value.message.lower())
            page.wait_for_function("() => document.querySelector('#script-list') !== null")
            check('invalid actual import not persisted', not page.evaluate("async bad => (await chrome.storage.local.get('scripts')).scripts.some(s => s.id === bad)", payload))

            update_script = dict(browser_script, id='update-fixture', name='Update fixture',
                                 code='// @version 1.0\nconsole.log("OLD");', enabled=False, match_patterns=[])
            page.evaluate("s => chrome.runtime.sendMessage({action:'saveScripts',scripts:[s]})", update_script)
            page.evaluate("info => chrome.storage.local.set({scriptUpdates: {'update-fixture': info}})",
                          {'downloadUrl': fixture + 'update.user.js', 'remoteVersion': '2.0', 'localVersion': '1.0'})
            page.reload()
            expect(page.locator('[data-action="update"]')).to_be_visible()
            with context.expect_page() as update_opened:
                page.locator('[data-action="update"]').click()
            update_page = update_opened.value
            expect(update_page.locator('#btn-do-install')).to_be_visible()
            expect(update_page.locator('.code-preview')).to_contain_text('REVIEWED_NOT_EXECUTED')
            check('dashboard update opens source review without applying it', page.evaluate("async () => (await chrome.storage.local.get('scripts')).scripts[0].code") == update_script['code'])
            update_page.locator('#btn-do-install').click()
            expect(update_page.locator('#status-msg')).to_contain_text('Updated to')
            check('update installs exactly reviewed bytes without refetch',
                  page.evaluate("async () => (await chrome.storage.local.get('scripts')).scripts[0].code") == reviewed_update and len(update_fetches) == 1)
            check('update preserves disabled state', page.evaluate("async () => (await chrome.storage.local.get('scripts')).scripts[0].enabled") is False)

            # Reproduce a discovered update whose source cannot be downloaded.
            failing_script = dict(update_script, code='// @version 1.0\n// @updateURL ' + fixture + 'metadata.js')
            page.evaluate("s => chrome.runtime.sendMessage({action:'saveScripts',scripts:[s]})", failing_script)
            opened_unexpectedly = []
            record_page = lambda new_page: opened_unexpectedly.append(new_page.url)
            context.on('page', record_page)
            updates = page.evaluate("() => chrome.runtime.sendMessage({action:'checkForUpdates'})")
            check('real update check records a newer version without opening a tab',
                  'update-fixture' in updates and not opened_unexpectedly)
            context.remove_listener('page', record_page)
            snapshot = page.evaluate("() => chrome.storage.local.get('scripts')")
            for source, message in [('offline.user.js', 'Failed to fetch'),
                                    ('forbidden.user.js', 'HTTP 403'),
                                    ('redirect.user.js', 'Failed to fetch'),
                                    ('login.user.js', 'web page instead of script code'),
                                    ('html-as-text.user.js', 'web page instead of script code')]:
                page.evaluate("url => chrome.storage.local.set({scriptUpdates:{'update-fixture':{downloadUrl:url}}})", fixture + source)
                failed = context.new_page()
                failed.on('pageerror', lambda error: errors.append(str(error)))
                failed.goto(base + '/install.html?update=update-fixture')
                expect(failed.locator('#load-error-detail')).to_contain_text(message)
                expect(failed.locator('#install-content')).to_contain_text('do not send sign-in cookies or follow redirects')
                expect(failed.locator('#failed-source')).to_have_text(fixture + source)
                check('failed update has no install action: ' + source, failed.locator('#btn-do-install').count() == 0)
                with failed.expect_event('close'):
                    failed.locator('#btn-close-load').click()
                opened_unexpectedly.clear()
                context.on('page', record_page)
                for _ in range(2):
                    result = page.evaluate("() => chrome.runtime.sendMessage({action:'checkForUpdates'})")
                    check('closed failure stays closed during update check: ' + source,
                          'update-fixture' in result and not opened_unexpectedly)
                context.remove_listener('page', record_page)
                check('failed update leaves installed script unchanged: ' + source,
                      snapshot == page.evaluate("() => chrome.storage.local.get('scripts')"))

            retry = context.new_page()
            retry.goto(base + '/install.html?url=' + fixture + 'retry.user.js')
            expect(retry.locator('#btn-retry-load')).to_be_visible()
            check('failed install fetches only once before Retry', len(retry_fetches) == 1)
            retry.locator('#btn-retry-load').click()
            expect(retry.locator('#btn-do-install')).to_be_visible()
            check('explicit Retry loads code for review without saving it', len(retry_fetches) == 2 and
                  snapshot == page.evaluate("() => chrome.storage.local.get('scripts')"))
            retry.close()

            unsafe = context.new_page()
            unsafe_source = 'javascript:<img src=x onerror=alert(1)>'
            unsafe.goto(base + '/install.html?url=' + unsafe_source)
            expect(unsafe.locator('#load-error-detail')).to_contain_text('http(s) without credentials')
            check('error page escapes untrusted source', unsafe.locator('img,[onerror]').count() == 0)
            unsafe.locator('#btn-open-dashboard').click()
            expect(unsafe.locator('#script-list')).to_be_visible()
            check('error recovery opens dashboard in the same tab', unsafe.url == base + '/dashboard.html')
            unsafe.close()

            if args.companion:
                check('only our companion running' , process.poll() is None)
                pairing = json.loads((data / 'pairing.json').read_text())
                token = pairing['token']
                check('fresh secret generated', len(token) == 64 and all(c in '0123456789abcdef' for c in token))
                page.goto(base + '/dashboard.html#companion')
                page.locator('#companion-token').fill(token)
                page.locator('#btn-pair-companion').click()
                try:
                    expect(page.locator('#pair-status')).to_contain_text('Connected and authenticated')
                except AssertionError:
                    print(json.dumps({'pair_feedback': page.locator('#pair-feedback').inner_text(), 'requests': companion_responses, 'bound_id': json.loads((data / 'pairing.json').read_text()).get('extension_id'), 'errors': errors}), flush=True)
                    raise
                expect(page.locator('#companion-token')).to_have_value('')
                check('actual Chromium origin paired and authenticated')
                paired = json.loads((data / 'pairing.json').read_text())
                check('companion bound to actual extension id', paired['extension_id'] == extension_id)

                def request(method, target, headers=None, body=None):
                    conn = http.client.HTTPConnection('127.0.0.1', 9876, timeout=10)
                    conn.request(method, target, body=body, headers=headers or {})
                    result = conn.getresponse()
                    status, text = result.status, result.read().decode()
                    conn.close()
                    return status, text

                status, text = request('GET', '/api/ping')
                check('live unauthenticated API rejected', status == 401)
                auth = {'Authorization': 'Bearer ' + token}
                status, text = request('GET', '/api/export', {**auth, 'Origin': 'https://attacker.test'})
                check('live hostile origin rejected even with token', status == 403)
                status, text = request('GET', '/api/export', {**auth, 'Host': 'attacker.test:9876'})
                check('live DNS-rebinding Host rejected', status == 403)
                status, text = request('GET', '/api/export', auth)
                check('authenticated local CLI works and export omits secret', status == 200 and token not in text)
                status, text = request('GET', '/api/settings', auth)
                check('settings omit pairing secret', status == 200 and token not in text)
                status, text = request('GET', '/settings.html', auth)
                check('legacy dashboard route unavailable', status == 404)
                page.locator('[data-page="scripts"]').click()
                with page.expect_download() as download:
                    page.locator('#btn-export').click()
                export_path = work / 'export.json'
                download.value.save_as(export_path)
                exported = export_path.read_text()
                check('actual browser export contains no pairing token', token not in exported and 'companionToken' not in exported)
                status, text = request('GET', '/api/check-dep?kind=exe&name=unapproved.exe', auth)
                check('arbitrary executable dependency check rejected', status in [400, 422])
                native = {'id': 'native-fixture', 'name': 'Native echo fixture', 'description': '', 'category': 'external',
                          'language': 'cmd', 'code': '@echo off\necho SCRIPTBRIDGE_SECURE_E2E', 'enabled': True,
                          'match_patterns': [], 'tags': [], 'trigger': 'manual', 'env_vars': {}}
                result = page.evaluate("s => chrome.runtime.sendMessage({action:'saveScripts',scripts:[s]})", native)
                check('trusted UI stores fixed native fixture', result.get('ok') is True)
                page.locator('[data-page="scripts"]').click()
                page.locator('[data-action="run"]').first.click()
                expect(page.locator('#run-stdout')).to_contain_text('SCRIPTBRIDGE_SECURE_E2E', timeout=15000)
                expect(page.locator('#run-status')).to_contain_text('Exit: 0')
                check('manual authenticated native echo and SSE work')
                page.locator('#btn-run-close').click()
                page.locator('[data-page="companion"]').click()
                page.locator('#btn-forget-companion').click()
                expect(page.locator('#pair-status')).to_contain_text('Not connected')
                check('forget removes token', not page.evaluate("async () => (await chrome.storage.local.get('companionToken')).companionToken !== undefined"))
                status, text = request('GET', '/api/ping', auth)
                check('forget accurately leaves server token valid', status == 200)
            check('no unexpected page script errors', not errors)
            check('no unexpected external requests', not denied_requests)
            context.close()
            context = None
    finally:
        if context:
            try: context.close()
            except Exception: pass
        if process:
            process.terminate()
            process.wait(timeout=10)
print(json.dumps({'passed': len(checks), 'failed': 0, 'checks': checks}, indent=2))
