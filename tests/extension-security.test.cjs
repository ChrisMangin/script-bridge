'use strict';
// Security boundary tests for the extension worker, companion client and page-injected helpers.
// Every network call and chrome API is mocked; nothing is launched and no real profile is touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, 'extension', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const TOKEN = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';
const OTHER_TOKEN = 'b'.repeat(64);
const initMarker = '// ============ INIT ============';

function createWorker({ accessLevelFails = false, fetchImpl } = {}) {
    const store = {};
    const calls = { fetch: [], get: 0, set: 0, remove: 0, accessLevel: [], executeScript: [], logs: [], tabsCreated: [] };
    const listeners = {};
    const event = name => ({ addListener(fn) { listeners[name] = fn; } });
    const log = (...args) => calls.logs.push(args.map(String).join(' '));
    const context = vm.createContext({
        URL, Headers, AbortSignal, setTimeout,
        console: { log, warn: log, error: log, info: log },
        fetch: async (url, init) => {
            calls.fetch.push({ url: String(url), init });
            if (fetchImpl) return fetchImpl(String(url), init);
            return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
        },
        setInterval() { throw new Error('timers are forbidden in unit tests'); },
        chrome: {
            runtime: { id: EXT_ID, onMessage: event('message'), getURL: file => `chrome-extension://${EXT_ID}/${file}` },
            storage: { local: {
                async setAccessLevel(options) {
                    calls.accessLevel.push(options);
                    if (accessLevelFails) throw new Error('setAccessLevel unavailable');
                },
                async get(key) { calls.get++; return { [key]: store[key] }; },
                async set(values) { calls.set++; Object.assign(store, values); },
                async remove(key) { calls.remove++; delete store[key]; }
            } },
            tabs: { onUpdated: event('tabUpdated'), create(opts) { calls.tabsCreated.push(opts); } },
            contextMenus: { onClicked: event('menu'), async removeAll() {}, create() {} },
            scripting: { async executeScript(details) { calls.executeScript.push(details); } },
            webNavigation: { onBeforeNavigate: event('nav'), onCommitted: event('commit') }
        }
    });
    vm.runInContext(read('background.js').split(initMarker)[0], context, { filename: 'background.js' });
    vm.runInContext(read('companion-client.js'), context, { filename: 'companion-client.js' });
    vm.runInContext(read('script-url-policy.js'), context, { filename: 'script-url-policy.js' });
    const send = (msg, sender) => new Promise(resolve => {
        const reply = value => resolve(plain(value));
        if (listeners.message(msg, sender, reply) !== true) return;
    });
    const resetCounts = () => { calls.fetch.length = 0; calls.get = 0; calls.set = 0; calls.remove = 0; };
    return { context, store, calls, listeners, send, resetCounts, SB: context.SBCompanion };
}

const extUrl = page => `chrome-extension://${EXT_ID}/${page}`;
const trustedSender = (page, extra = {}) => ({ id: EXT_ID, url: extUrl(page), origin: `chrome-extension://${EXT_ID}`, ...extra });
const validScript = (overrides = {}) => ({ id: 'script-1', name: 'Example', category: 'browser', language: 'javascript', code: 'void 0', enabled: true, ...overrides });

// ---------- sender boundary ----------

const hostileSenders = [
    ['web page content script', { id: EXT_ID, url: 'https://evil.example/', origin: 'https://evil.example', tab: { id: 1 }, frameId: 0 }],
    ['other extension', { id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', url: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/dashboard.html' }],
    ['forged url on another extension host', { id: EXT_ID, url: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/dashboard.html' }],
    ['forged origin', { id: EXT_ID, url: extUrl('dashboard.html'), origin: 'https://evil.example' }],
    ['own non-UI resource', { id: EXT_ID, url: extUrl('gm-polyfill.js') }],
    ['own page lookalike path', { id: EXT_ID, url: extUrl('dashboard.html.evil') }],
    ['own page in sub-path', { id: EXT_ID, url: extUrl('x/dashboard.html') }],
    ['own page in child frame', { id: EXT_ID, url: extUrl('dashboard.html'), frameId: 2 }],
    ['credentials in url', { id: EXT_ID, url: `chrome-extension://user:pw@${EXT_ID}/dashboard.html` }],
    ['missing url', { id: EXT_ID }],
    ['malformed url', { id: EXT_ID, url: 'not a url' }],
    ['missing sender', undefined],
    ['web page with extension-looking query', { id: EXT_ID, url: `https://evil.example/?u=${extUrl('dashboard.html')}` }]
];

for (const [label, sender] of hostileSenders) {
    for (const msg of [
        { action: 'saveScripts', scripts: [validScript()] },
        { action: 'getScripts' },
        { action: 'checkCompanion' },
        { action: 'runExternal', id: 'script-1' },
        { action: 'saveSettings', settings: { debug_scripts: true } }
    ]) {
        test(`hostile sender rejected before any handler: ${label} -> ${msg.action}`, async () => {
            const w = createWorker();
            w.store.companionToken = TOKEN;
            w.resetCounts();
            assert.deepEqual(await w.send(msg, sender), { error: 'Forbidden' });
            assert.equal(w.calls.fetch.length, 0, 'no network');
            assert.equal(w.calls.get + w.calls.set + w.calls.remove, 0, 'no storage access');
        });
    }
}

for (const page of ['popup.html', 'dashboard.html', 'dashboard.html#companion', 'editor.html', 'install.html?url=https%3A%2F%2Fexample.org%2Fa.user.js', 'install.html?update=script-1']) {
    test(`trusted extension UI allowed: ${page}`, async () => {
        const w = createWorker();
        w.store.scripts = [validScript()];
        assert.deepEqual(await w.send({ action: 'getScripts' }, trustedSender(page)), [validScript()]);
    });
}

test('own extension UI opened in a tab (top frame) is allowed', async () => {
    const w = createWorker();
    const sender = trustedSender('dashboard.html', { tab: { id: 7, url: extUrl('dashboard.html') }, frameId: 0 });
    assert.deepEqual(await w.send({ action: 'saveScripts', scripts: [validScript()] }, sender), { ok: true });
    assert.deepEqual(plain(w.store.scripts), [validScript()]);
});

for (const action of ['gmXhr', 'gmStorage', 'runExternalByName', 'notify', '__proto__', 'constructor', 'toString']) {
    test(`removed or prototype action name is unknown: ${action}`, async () => {
        const w = createWorker();
        w.resetCounts();
        assert.deepEqual(await w.send({ action, details: { url: 'https://example.org' }, name: 'x' }, trustedSender('dashboard.html')), { error: 'Unknown action' });
        assert.equal(w.calls.fetch.length, 0);
    });
}

test('worker no longer contains GM network or storage relays', () => {
    const source = read('background.js');
    assert.doesNotMatch(source, /gmXhr|gmStorage|handleGmXhr|handleGmStorage|runExternalByName|localhost:9876/);
});

// ---------- script schema validation ----------

for (const [label, scripts] of [
    ['non-array', { id: 'x' }],
    ['path traversal id', [validScript({ id: '../../api/pair' })]],
    ['markup id', [validScript({ id: '"><img src=x onerror=alert(1)>' })]],
    ['missing id', [validScript({ id: undefined })]],
    ['numeric id', [validScript({ id: 5 })]],
    ['unknown category', [validScript({ category: 'native' })]],
    ['unknown language', [validScript({ language: 'perl;rm' })]],
    ['tags not strings', [validScript({ tags: ['ok', { x: 1 }] })]],
    ['env_vars non-string value', [validScript({ env_vars: { PATH: 1 } })]],
    ['env_vars array', [validScript({ env_vars: ['A=B'] })]],
    ['code object', [validScript({ code: { toString: 1 } })]],
    ['enabled string', [validScript({ enabled: 'yes' })]],
    ['duplicate ids', [validScript(), validScript()]],
    ['proto key', [JSON.parse('{"id":"a","category":"browser","__proto__":{"polluted":true}}')]]
]) {
    test(`saveScripts rejects malformed records without writing: ${label}`, async () => {
        const w = createWorker();
        w.store.scripts = [validScript({ id: 'keep' })];
        const result = await w.send({ action: 'saveScripts', scripts }, trustedSender('dashboard.html'));
        assert.ok(result.error, JSON.stringify(result));
        assert.deepEqual(plain(w.store.scripts), [validScript({ id: 'keep' })]);
    });
}

test('saveScripts accepts the full supported schema including unknown legacy fields', async () => {
    const w = createWorker();
    const script = validScript({ id: '3f2c6a1e-1b2c-4d5e-8f90-0123456789ab', category: 'external', language: 'powershell', tags: ['a'],
        env_vars: { A: 'b' }, match_patterns: ['https://example.org/*'], order: 2, previous_code: null, chain_group: 'g', last_run: '2026-01-01' });
    assert.deepEqual(await w.send({ action: 'saveScripts', scripts: [script] }, trustedSender('editor.html')), { ok: true });
});

test('malformed legacy records are hidden from UI and injection but preserved in storage', async () => {
    const w = createWorker();
    const legacy = { id: 'bad id!', category: 'browser', code: 'window.legacyRan = true', enabled: true };
    w.store.scripts = [validScript(), legacy];
    assert.deepEqual(await w.send({ action: 'getScripts' }, trustedSender('dashboard.html')), [validScript()]);
    assert.deepEqual(await w.send({ action: 'saveScripts', scripts: [validScript({ name: 'Renamed' })] }, trustedSender('dashboard.html')), { ok: true });
    assert.deepEqual(plain(w.store.scripts), [validScript({ name: 'Renamed' }), legacy]);
    await w.listeners.tabUpdated(1, { status: 'complete' }, { url: 'https://example.org/' });
    assert.equal(w.calls.executeScript.length, 1);
    assert.doesNotMatch(w.calls.executeScript[0].args[0], /legacyRan/);
});

test('saveSettings rejects non-object and prototype keys', async () => {
    const w = createWorker();
    for (const settings of [[1], 'x', null, JSON.parse('{"__proto__":{"a":1}}')]) {
        assert.ok((await w.send({ action: 'saveSettings', settings }, trustedSender('dashboard.html'))).error);
    }
    assert.equal(w.store.settings, undefined);
});

test('saveSettings rejects malformed worker-interpreted values', async () => {
    const w = createWorker();
    for (const settings of [{ page_blacklist: ['x'] }, { debug_scripts: 'true' }, { page_blacklist: 5 }]) {
        assert.match((await w.send({ action: 'saveSettings', settings }, trustedSender('dashboard.html'))).error, /must be a/);
    }
    assert.equal(w.store.settings, undefined);
    assert.deepEqual(await w.send({ action: 'saveSettings', settings: { page_blacklist: 'https://a/*', debug_scripts: false, theme: 'dark' } }, trustedSender('dashboard.html')), { ok: true });
});

for (const stored of [{ page_blacklist: ['https://example.org/*'], debug_scripts: 'yes', theme: 'dark' }, ['x'], 'garbage', null, 7]) {
    test(`malformed stored settings cannot break injection and are not rewritten: ${JSON.stringify(stored)}`, async () => {
        const w = createWorker();
        w.store.settings = stored;
        w.store.scripts = [validScript()];
        await w.listeners.tabUpdated(1, { status: 'complete' }, { url: 'https://example.org/' });
        assert.equal(w.calls.executeScript.length, 1);
        assert.equal(w.calls.executeScript[0].args[2], false, 'non-boolean debug flag ignored');
        const returned = await w.send({ action: 'getSettings' }, trustedSender('dashboard.html'));
        assert.deepEqual(returned, stored && typeof stored === 'object' && !Array.isArray(stored) ? { theme: 'dark' } : {});
        assert.deepEqual(plain(w.store.settings), plain(stored));
    });
}

// ---------- ordinary injection ----------

test('ordinary browser script injection is unaffected and uses no network or companion', async () => {
    const w = createWorker();
    w.store.scripts = [validScript({ code: 'GM_addStyle("a{}")', match_patterns: ['https://example.org/*'] }),
        validScript({ id: 'off', enabled: false }), validScript({ id: 'other', match_patterns: ['https://other.test/*'] })];
    await w.listeners.tabUpdated(4, { status: 'complete' }, { url: 'https://example.org/page' });
    assert.equal(w.calls.executeScript.length, 2);
    assert.deepEqual(plain(w.calls.executeScript[0]), { target: { tabId: 4 }, files: ['gm-polyfill.js'], world: 'MAIN' });
    assert.equal(w.calls.executeScript[1].world, 'MAIN');
    assert.match(w.calls.executeScript[1].args[0], /GM_addStyle\("a\{\}"\)/);
    assert.equal(w.calls.fetch.length, 0);
});

// ---------- companion client ----------

test('SBCompanion exposes exactly fetch/pair/forget/isPaired, frozen, with no token getter', () => {
    const w = createWorker();
    assert.deepEqual(Object.getOwnPropertyNames(w.SB).sort(), ['fetch', 'forget', 'isPaired', 'pair']);
    assert.ok(Object.isFrozen(w.SB));
    assert.throws(() => { 'use strict'; w.SB.token = 'x'; });
    assert.equal(Object.getOwnPropertyDescriptor(w.context, 'SBCompanion').writable, false);
});

for (const bad of ['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ` ${TOKEN}`, `${TOKEN}\n`, 123, null, undefined, { toString: () => TOKEN }]) {
    test(`pair rejects malformed token without network or storage: ${JSON.stringify(String(bad)).slice(0, 20)}`, async () => {
        const w = createWorker();
        w.resetCounts();
        await assert.rejects(w.SB.pair(bad), /64 lowercase hex/);
        assert.equal(w.calls.fetch.length, 0);
        assert.equal(w.calls.set, 0);
    });
}

test('pair authenticates the provided token against the fixed pair endpoint, then stores it', async () => {
    let storedDuringRequest;
    const w = createWorker({ fetchImpl: async () => { storedDuringRequest = w.store.companionToken; return { ok: true, status: 200 }; } });
    assert.deepEqual(plain(await w.SB.pair(TOKEN)), { ok: true });
    assert.equal(storedDuringRequest, undefined, 'token is stored only after success');
    assert.equal(w.store.companionToken, TOKEN);
    const [{ url, init }] = w.calls.fetch;
    assert.equal(url, 'http://127.0.0.1:9876/api/pair');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.get('Authorization'), 'Bearer ' + TOKEN);
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(plain(w.calls.accessLevel[0]), { accessLevel: 'TRUSTED_CONTEXTS' });
    assert.equal(await w.SB.isPaired(), true);
});

for (const [label, fetchImpl] of [
    ['HTTP 401', async () => ({ ok: false, status: 401 })],
    ['HTTP 409 already bound', async () => ({ ok: false, status: 409 })],
    ['network error mentioning the request', async (url, init) => { throw new Error('boom ' + init.headers.get('Authorization')); }]
]) {
    test(`failed pairing stores nothing and the error is generic: ${label}`, async () => {
        const w = createWorker({ fetchImpl });
        w.store.companionToken = OTHER_TOKEN;
        const err = await w.SB.pair(TOKEN).then(() => null, e => e);
        assert.ok(err instanceof Error || (err && err.message));
        assert.doesNotMatch(String(err.message) + String(err.stack), new RegExp(TOKEN));
        assert.equal(w.store.companionToken, OTHER_TOKEN, 'previous pairing left intact');
    });
}

test('unpaired fetch rejects without network', async () => {
    const w = createWorker();
    w.resetCounts();
    await assert.rejects(w.SB.fetch('/api/ping'), /not paired/);
    assert.equal(w.calls.fetch.length, 0);
    assert.equal(await w.SB.isPaired(), false);
});

test('stored token with a malformed shape is treated as unpaired', async () => {
    const w = createWorker();
    w.store.companionToken = TOKEN.toUpperCase();
    await assert.rejects(w.SB.fetch('/api/ping'), /not paired/);
    assert.equal(w.calls.fetch.length, 0);
});

for (const [input, expected] of [
    ['/api/ping', 'http://127.0.0.1:9876/api/ping'],
    ['/api/check-dep?kind=a%20b&name=x', 'http://127.0.0.1:9876/api/check-dep?kind=a%20b&name=x'],
    ['/api/scripts/abc-1/stream', 'http://127.0.0.1:9876/api/scripts/abc-1/stream'],
    ['/api/history#frag', 'http://127.0.0.1:9876/api/history'],
    ['http://127.0.0.1:9876/api/schedules', 'http://127.0.0.1:9876/api/schedules'],
    ['http://localhost:9876/api/settings', 'http://127.0.0.1:9876/api/settings']
]) {
    test(`fetch maps accepted companion URL ${input}`, async () => {
        const w = createWorker();
        w.store.companionToken = TOKEN;
        await w.SB.fetch(input, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer forged' }, redirect: 'follow', credentials: 'include' });
        const [{ url, init }] = w.calls.fetch;
        assert.equal(url, expected);
        assert.equal(init.method, 'PUT');
        assert.equal(init.headers.get('Content-Type'), 'application/json');
        assert.equal(init.headers.get('Authorization'), 'Bearer ' + TOKEN, 'caller cannot override auth');
        assert.equal(init.redirect, 'error', 'redirects cannot carry the bearer elsewhere');
        assert.equal(init.credentials, 'omit');
    });
}

for (const input of [
    'https://evil.example/api/ping', 'http://evil.example/api/ping', '//evil.example/api/ping',
    'http://127.0.0.1:9877/api/ping', 'https://127.0.0.1:9876/api/ping', 'http://127.0.0.1:9876@evil.example/api/ping',
    'http://user:pw@127.0.0.1:9876/api/ping', 'http://127.0.0.2:9876/api/ping', 'http://[::1]:9876/api/ping',
    '/ping', '/apix/ping', 'api/ping', '/api/../shutdown', '/api/%2e%2e/shutdown', '/api/%2E%2E/shutdown', '/api/a%2fb', '/api\\..\\x',
    'http://127.0.0.1:9876/', 'javascript:alert(1)', 'file:///C:/x', 'chrome-extension://x/api/ping', '', 42, null, { href: '/api/ping' }
]) {
    test(`fetch rejects non-companion URL without network: ${String(JSON.stringify(input))}`, async () => {
        const w = createWorker();
        w.store.companionToken = TOKEN;
        w.resetCounts();
        const err = await w.SB.fetch(input).then(() => null, e => e);
        assert.ok(err, 'must reject');
        assert.match(err.message, /rejected/);
        assert.doesNotMatch(err.message, new RegExp(TOKEN));
        assert.equal(w.calls.fetch.length, 0);
    });
}

test('forget removes only the extension copy of the token', async () => {
    const w = createWorker();
    w.store.companionToken = TOKEN;
    w.store.settings = { a: 1 };
    await w.SB.forget();
    assert.equal(w.store.companionToken, undefined);
    assert.deepEqual(w.store.settings, { a: 1 });
    assert.equal(w.calls.fetch.length, 0);
    assert.equal(await w.SB.isPaired(), false);
});

test('storage access restriction failure fails closed: no token read, no network, no store', async () => {
    const w = createWorker({ accessLevelFails: true });
    w.store.companionToken = TOKEN;
    w.resetCounts();
    await assert.rejects(w.SB.fetch('/api/ping'), /could not be restricted/);
    await assert.rejects(w.SB.pair(TOKEN), /could not be restricted/);
    assert.equal(await w.SB.isPaired(), false);
    assert.equal(w.calls.fetch.length, 0);
    assert.equal(w.calls.get, 0);
    assert.equal(w.calls.set, 0);
});

test('storage is restricted before the token is read', async () => {
    const order = [];
    const w = createWorker();
    w.store.companionToken = TOKEN;
    const local = w.context.chrome.storage.local;
    const origGet = local.get, origLevel = local.setAccessLevel;
    local.get = async key => { order.push('get'); return origGet(key); };
    local.setAccessLevel = async o => { order.push('restrict'); return origLevel(o); };
    // A fresh client instance observes the patched storage from its first call.
    const fresh = vm.createContext({ URL, Headers, fetch: async () => ({ ok: true }), chrome: w.context.chrome });
    vm.runInContext(read('companion-client.js'), fresh);
    await fresh.SBCompanion.fetch('/api/ping');
    assert.equal(order[0], 'restrict');
    assert.ok(order.indexOf('get') > 0);
});

test('token is stored only under companionToken in local storage, never in settings/scripts', async () => {
    const source = read('companion-client.js');
    assert.doesNotMatch(source, /storage\.sync|storage\.session|localStorage|console\./);
    const w = createWorker();
    await w.SB.pair(TOKEN);
    assert.deepEqual(Object.keys(w.store).filter(k => JSON.stringify(w.store[k]).includes(TOKEN)), ['companionToken']);
});

test('worker companion status responses and logs never contain the token', async () => {
    const w = createWorker({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ output: 'done' }) }) });
    w.store.companionToken = TOKEN;
    w.store.scripts = [validScript({ id: 'ext-1', category: 'external', language: 'python' })];
    const ui = trustedSender('dashboard.html');
    const responses = [
        await w.send({ action: 'checkCompanion' }, ui),
        await w.send({ action: 'getCompanionStatus' }, ui),
        await w.send({ action: 'runExternal', id: 'ext-1' }, ui),
        await w.send({ action: 'syncToCompanion' }, ui),
        await w.send({ action: 'getSettings' }, ui),
        await w.send({ action: 'getScripts' }, ui)
    ];
    assert.deepEqual(responses[0], { online: true, paired: true });
    for (const r of responses) assert.doesNotMatch(JSON.stringify(r), new RegExp(TOKEN));
    assert.doesNotMatch(w.calls.logs.join('\n'), new RegExp(TOKEN));
    for (const call of w.calls.fetch) {
        assert.ok(call.url.startsWith('http://127.0.0.1:9876/api/'), call.url);
        assert.doesNotMatch(call.url, new RegExp(TOKEN));
    }
});

test('checkCompanion while unpaired makes no network request', async () => {
    const w = createWorker();
    assert.deepEqual(await w.send({ action: 'checkCompanion' }, trustedSender('popup.html')), { online: false, paired: false });
    assert.equal(w.calls.fetch.length, 0);
});

test('runExternal refuses invalid, missing and disabled scripts before any companion call', async () => {
    const w = createWorker();
    w.store.companionToken = TOKEN;
    w.store.scripts = [validScript({ id: 'off', category: 'external', enabled: false }), validScript({ id: 'web', category: 'browser' })];
    const ui = trustedSender('dashboard.html');
    await w.send({ action: 'checkCompanion' }, ui);
    w.resetCounts();
    for (const id of ['../pair', 'off', 'web', 'missing']) assert.ok((await w.send({ action: 'runExternal', id }, ui)).error, id);
    assert.equal(w.calls.fetch.length, 0);
});

test('syncToCompanion sends only enabled externals with an allowlisted body', async () => {
    const w = createWorker();
    w.store.companionToken = TOKEN;
    w.store.scripts = [
        validScript({ id: 'on', category: 'external', language: 'python', trigger: 'schedule', watch_path: 'C:/secret', working_dir: 'C:/', tags: ['t'], env_vars: { A: 'b' } }),
        validScript({ id: 'off', category: 'external', enabled: false }),
        validScript({ id: 'web', category: 'browser' })
    ];
    const ui = trustedSender('dashboard.html');
    await w.send({ action: 'checkCompanion' }, ui);
    w.resetCounts();
    assert.deepEqual(await w.send({ action: 'syncToCompanion' }, ui), { ok: true, synced: 1, total: 1 });
    assert.equal(w.calls.fetch.length, 1);
    assert.deepEqual(JSON.parse(w.calls.fetch[0].init.body), { id: 'on', name: 'Example', description: '', language: 'python', category: 'external',
        code: 'void 0', match_patterns: [], run_at: '', trigger: 'manual', tags: ['t'], env_vars: { A: 'b' } });
});

// ---------- update checker ----------

for (const updateURL of ['file:///C:/x.user.js', 'chrome-extension://x/a.user.js', 'javascript:alert(1)', 'data:text/plain,x', 'https://user:pw@example.org/a.user.js']) {
    test(`update checker never fetches non-http(s) or credentialed URL: ${updateURL}`, async () => {
        const w = createWorker();
        w.store.scripts = [validScript({ code: `// @version 1.0\n// @updateURL ${updateURL}` })];
        await w.context.checkForUpdates();
        assert.equal(w.calls.fetch.length, 0);
    });
}

for (const updateURL of [
    'http://localhost/a.user.js', 'http://LOCALHOST./a.user.js', 'https://api.localhost/a.user.js', 'http://127.0.0.1:9876/api/pair',
    'http://127.1/a.user.js', 'http://2130706433/a.user.js', 'http://0x7f.0.0.1/a.user.js', 'http://0.0.0.0/a.user.js',
    'http://10.1.2.3/a.user.js', 'http://172.16.0.1/a.user.js', 'http://172.31.255.255/a.user.js', 'http://192.168.1.1/a.user.js',
    'http://169.254.169.254/latest/meta-data', 'http://100.64.0.1/a.user.js', 'http://192.0.2.10/a.user.js', 'http://198.18.0.1/a.user.js',
    'http://224.0.0.1/a.user.js', 'http://255.255.255.255/a.user.js', 'http://[::1]/a.user.js', 'http://[::]/a.user.js',
    'http://[::ffff:127.0.0.1]/a.user.js', 'http://[::ffff:10.0.0.1]/a.user.js', 'http://[fd00::1]/a.user.js', 'http://[fe80::1]/a.user.js',
    'http://[ff02::1]/a.user.js', 'http://[2001:db8::1]/a.user.js', 'http://[2002:7f00:1::]/a.user.js', 'http://[2001::1]/a.user.js',
    'http://[64:ff9b::7f00:1]/a.user.js'
]) {
    test(`update checker never fetches local/private/reserved literal destination: ${updateURL}`, async () => {
        const w = createWorker();
        w.store.scripts = [validScript({ code: `// @version 1.0\n// @updateURL ${updateURL}` })];
        await w.context.checkForUpdates();
        assert.equal(w.calls.fetch.length, 0);
        await assert.rejects(w.context.fetchUserscriptText(updateURL, 1000), /local, private or reserved/);
    });
}

for (const updateURL of ['https://example.org/a.user.js', 'http://93.184.216.34/a.user.js', 'http://172.32.0.1/a.user.js',
    'http://100.128.0.1/a.user.js', 'http://[2606:4700::1111]/a.user.js', 'https://localhost.example.org/a.user.js']) {
    test(`update checker still fetches public destination: ${updateURL}`, async () => {
        const w = createWorker({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '// @version 1.0' }) });
        w.store.scripts = [validScript({ code: `// @version 1.0\n// @updateURL ${updateURL}` })];
        await w.context.checkForUpdates();
        assert.equal(w.calls.fetch.length, 1);
        assert.equal(w.calls.fetch[0].init.redirect, 'error');
    });
}

test('update check records available updates without opening any tab', async () => {
    const w = createWorker({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '// @version 2.0' }) });
    w.store.scripts = [validScript({ code: '// @version 1.0\n// @updateURL https://example.org/a.user.js' })];
    const updates = plain(await w.context.checkForUpdates());
    assert.deepEqual(Object.keys(updates), ['script-1']);
    assert.equal(updates['script-1'].downloadUrl, 'https://example.org/a.user.js');
    assert.deepEqual(plain(w.store.scriptUpdates), updates);
    assert.equal(w.calls.tabsCreated.length, 0);
    assert.doesNotMatch(read('background.js').match(/async function checkForUpdates[\s\S]*?\n}/)[0], /openUpdateTab|tabs\.create/);
});

test('openUpdateTab still opens the preview page when the user asks', async () => {
    const w = createWorker();
    assert.deepEqual(await w.send({ action: 'openUpdateTab', id: 'script-1' }, trustedSender('dashboard.html')), { ok: true });
    assert.deepEqual(plain(w.calls.tabsCreated), [{ url: extUrl('install.html?update=script-1') }]);
});

test('downloadURL from remote metadata is also host-checked before it can be stored as an update', async () => {
    const w = createWorker({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '// @version 2.0\n// @downloadURL http://192.168.0.5/x.user.js' }) });
    w.store.scripts = [validScript({ code: '// @version 1.0\n// @updateURL https://example.org/a.user.js' })];
    const updates = plain(await w.context.checkForUpdates());
    assert.deepEqual(updates, {});
    assert.equal(w.calls.fetch.length, 1);
});

test('update checker fetches http(s) without credentials or redirects and never sends the bearer', async () => {
    const w = createWorker({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '// @version 1.0' }) });
    w.store.companionToken = TOKEN;
    w.store.scripts = [validScript({ code: '// @version 1.0\n// @updateURL https://example.org/a.user.js' })];
    await w.context.checkForUpdates();
    const [{ url, init }] = w.calls.fetch;
    assert.equal(url, 'https://example.org/a.user.js');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers, undefined);
});

test('applyUpdate is removed: updates are applied only through the install preview page', async () => {
    const w = createWorker();
    w.store.scripts = [validScript()];
    w.store.scriptUpdates = { 'script-1': { downloadUrl: 'https://example.org/a.user.js' } };
    w.resetCounts();
    assert.deepEqual(await w.send({ action: 'applyUpdate', id: 'script-1' }, trustedSender('dashboard.html')), { error: 'Unknown action' });
    assert.equal(w.calls.fetch.length, 0);
    assert.equal(w.calls.set, 0);
    assert.doesNotMatch(read('background.js'), /applyUpdate/);
});

// ---------- manifest and page-visible files ----------

test('manifest exposes no page-to-extension bridge and sets a strict extension CSP', () => {
    const manifest = JSON.parse(read('manifest.json'));
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.web_accessible_resources, undefined);
    assert.equal(manifest.externally_connectable, undefined);
    assert.ok(!manifest.permissions.includes('notifications'));
    assert.ok(Number(manifest.minimum_chrome_version) >= 103, 'storage.setAccessLevel and AbortSignal.timeout');
    const csp = manifest.content_security_policy.extension_pages;
    for (const directive of ["script-src 'self'", "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
        assert.ok(csp.split(';').map(d => d.trim()).includes(directive), directive);
    }
});

test('worker loads the shared companion client and URL policy via importScripts', () => {
    assert.match(read('background.js').split(initMarker)[1], /importScripts\('companion-client\.js', 'script-url-policy\.js'\)/);
});

function pageWindow() {
    const posted = [], listeners = [], ls = new Map();
    const win = {
        postMessage: (...a) => posted.push(a),
        addEventListener: (...a) => listeners.push(a),
        open() {},
    };
    const localStorage = {
        getItem: k => (ls.has(k) ? ls.get(k) : null),
        setItem: (k, v) => ls.set(k, String(v)),
        removeItem: k => ls.delete(k),
        key: i => [...ls.keys()][i] ?? null,
        get length() { return ls.size; }
    };
    const ctx = vm.createContext({ window: win, localStorage, setTimeout, console: { log() {}, info() {} }, navigator: {},
        document: { createElement: () => ({}), head: { appendChild() {} } } });
    win.chrome = undefined;
    return { ctx, win, posted, listeners, ls };
}

test('content.js registers no relay', () => {
    const p = pageWindow();
    vm.runInContext(read('content.js'), p.ctx);
    assert.equal(p.listeners.length, 0);
    assert.doesNotMatch(read('content.js'), /sendMessage|addEventListener|postMessage/);
});

test('scriptbridge-api.js rejects run/runById/notify as unavailable and posts nothing', async () => {
    const p = pageWindow();
    vm.runInContext(read('scriptbridge-api.js'), p.ctx);
    for (const fn of ['run', 'runById', 'notify']) await assert.rejects(p.win.ScriptBridge[fn]('x'), /unavailable/);
    assert.equal(p.posted.length, 0);
    assert.equal(p.listeners.length, 0);
});

test('gm-polyfill has no extension relay and GM network requests fail explicitly', async () => {
    const p = pageWindow();
    vm.runInContext(read('gm-polyfill.js'), p.ctx);
    let onerror, onload = false;
    const handle = p.win.GM_xmlhttpRequest({ url: 'https://example.org', onerror: r => { onerror = r; }, onload: () => { onload = true; } });
    assert.equal(typeof handle.abort, 'function');
    await new Promise(r => setTimeout(r, 5));
    assert.equal(onerror.status, 0);
    assert.match(onerror.error, /does not support/);
    assert.equal(onload, false);
    await assert.rejects(p.win.GM.xmlHttpRequest({ url: 'https://example.org' }), r => /does not support/.test(r.error));
    let downloadError;
    p.win.GM_download({ url: 'https://example.org/f', onerror: e => { downloadError = e; } });
    await new Promise(r => setTimeout(r, 5));
    assert.equal(downloadError.error, 'not_supported');
    p.win.GM_notification({ title: 't', text: 'b' });
    assert.equal(p.posted.length, 0, 'no postMessage relay');
    assert.equal(p.listeners.length, 0, 'no message listener');
    assert.doesNotMatch(read('gm-polyfill.js'), /postMessage|chrome\.|SCRIPTBRIDGE_/);
});

test('gm-polyfill async storage is page-local and shares the sync namespace', async () => {
    const p = pageWindow();
    vm.runInContext(read('gm-polyfill.js'), p.ctx);
    p.win.GM_setValue('a', { n: 1 });
    assert.deepEqual(plain(await p.win.GM.getValue('a')), { n: 1 });
    await p.win.GM.setValue('b', 2);
    assert.equal(p.win.GM_getValue('b'), 2);
    assert.deepEqual(plain(await p.win.GM.listValues()).sort(), ['a', 'b']);
    await p.win.GM.deleteValue('a');
    assert.equal(p.win.GM_getValue('a', 'dflt'), 'dflt');
    assert.equal(await p.win.GM.getValue('missing', 7), 7);
    assert.deepEqual([...p.ls.keys()], ['_SB_GM_b']);
    assert.equal(p.posted.length, 0);
});

// ---------- installer URL policy ----------

function installPolicy() {
    const ctx = vm.createContext({ URL });
    vm.runInContext(read('script-url-policy.js'), ctx, { filename: 'script-url-policy.js' });
    return ctx.SBScriptUrlPolicy;
}

test('script URL policy is frozen and non-writable', () => {
    const ctx = vm.createContext({ URL });
    vm.runInContext(read('script-url-policy.js'), ctx);
    assert.ok(Object.isFrozen(ctx.SBScriptUrlPolicy));
    assert.equal(Object.getOwnPropertyDescriptor(ctx, 'SBScriptUrlPolicy').writable, false);
});

for (const [raw, ok] of [
    ['https://greasyfork.org/scripts/1/code/a.user.js', true], ['http://93.184.216.34/a.user.js', true],
    ['https://localhost.example.org/a.user.js', true], ['http://[2606:4700::1111]/a.user.js', true],
    ['http://localhost:8080/a.user.js', false], ['http://dev.localhost/a.user.js', false], ['http://127.0.0.1/a.user.js', false],
    ['http://192.168.0.2/a.user.js', false], ['http://[::1]/a.user.js', false], ['http://[fd12::1]/a.user.js', false],
    ['file:///C:/a.user.js', false], ['ftp://example.org/a.user.js', false], ['https://u:p@example.org/a.user.js', false], ['not a url', false]
]) {
    test(`installer URL policy ${ok ? 'allows' : 'blocks'} ${raw}`, () => {
        const policy = installPolicy();
        if (ok) assert.equal(policy.fetchableScriptUrl(raw), new URL(raw).href);
        else assert.throws(() => policy.fetchableScriptUrl(raw));
    });
}

test('install.js routes every installer fetch through the shared URL policy', () => {
    const source = read('install.js');
    assert.match(source, /function safeDownloadUrl\(value\) \{\s*return SBScriptUrlPolicy\.fetchableScriptUrl\(value\);\s*\}/);
    const fetches = source.match(/\bfetch\([^\n]*/g) || [];
    assert.ok(fetches.length >= 2);
    for (const call of fetches) {
        assert.match(call, /^fetch\(safeDownloadUrl\(/, call);
        assert.match(call, /redirect: 'error'/, call);
        assert.match(call, /credentials: 'omit'/, call);
    }
});
