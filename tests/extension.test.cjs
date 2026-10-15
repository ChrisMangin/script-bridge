'use strict';
// Pure-function and storage tests. No browser, companion, network, or user profile access.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8');
const initMarker = '// ============ INIT ============';
assert.equal(source.split(initMarker).length, 2, 'Background initialization marker must be unique');
const store = {};
const event = { addListener() {} };
const context = vm.createContext({
    console, AbortSignal,
    fetch() { throw new Error('Network access is forbidden in unit tests'); },
    setInterval() { throw new Error('Background timers are forbidden in unit tests'); },
    chrome: {
        storage: { local: {
            async get(key) { return { [key]: store[key] }; },
            async set(values) { Object.assign(store, values); }
        } },
        tabs: { onUpdated: event },
        contextMenus: { onClicked: event },
        runtime: { onMessage: event },
        webNavigation: { onBeforeNavigate: event, onCommitted: event }
    }
});
vm.runInContext(source.split(initMarker)[0], context, { filename: 'background.js' });
const plain = value => JSON.parse(JSON.stringify(value));

for (const [label, url, pattern, expected] of [
    ['exact match', 'https://example.org/page', 'https://example.org/page', true],
    ['different host', 'https://other.org/page', 'https://example.org/*', false],
    ['wildcard path', 'https://example.org/a/b', 'https://example.org/*', true],
    ['wildcard scheme', 'http://example.org/a', '*://example.org/*', true],
    ['literal dot', 'https://exampleXorg/a', 'https://example.org/*', false],
    ['anchored host', 'https://example.org.evil.test/a', 'https://example.org/*', false],
    ['all_urls sentinel', 'https://example.org/a', '<all_urls>', true],
    ['single-character wildcard', 'https://example.org/a', 'https://example.org/?', true],
    ['single-character limit', 'https://example.org/ab', 'https://example.org/?', false]
]) test('URL pattern: ' + label, () => assert.equal(context.matchesPattern(url, pattern), expected));

for (const [local, remote, expected] of [
    ['1.0.0', '1.0.1', true], ['1.9.0', '1.10.0', true],
    ['2.0.0', '1.9.9', false], ['1.0', '1.0.0', false],
    ['v1.0.0', 'v2.0.0', true], ['', '2.0.0', false], ['1.0.0', '', false]
]) test(`numeric version comparison: ${local} -> ${remote}`, () =>
    assert.equal(context.isNewerVersion(local, remote), expected));

test('metadata supports JavaScript comments', () => {
    const meta = context.parseMetaHeader('// ==UserScript==\n// @name Example\n// @version 1.2.3\n// @match https://example.org/*');
    assert.deepEqual(plain(meta), { name: 'Example', version: '1.2.3', match: 'https://example.org/*' });
});
test('metadata supports Python and C comments', () => {
    assert.deepEqual(plain(context.parseMetaHeader('# @name Example\n/* @version 2.0.0 */')), { name: 'Example', version: '2.0.0' });
});
test('metadata ignores ordinary prose', () => assert.deepEqual(plain(context.parseMetaHeader('hello\nworld')), {}));
test('script and settings storage round-trip using mock storage only', async () => {
    assert.deepEqual(plain(await context.getScripts()), []);
    await context.saveScripts([{ id: 'sample', name: 'Example', category: 'browser', language: 'javascript', code: '' }]);
    assert.deepEqual(plain(await context.getScripts()), [{ id: 'sample', name: 'Example', category: 'browser', language: 'javascript', code: '' }]);
    await context.saveSettings({ debug_scripts: true });
    assert.deepEqual(plain(await context.getSettings()), { debug_scripts: true });
});
test('all shipped extension JavaScript parses without executing it', () => {
    for (const directory of ['extension', 'extension/lib']) {
        for (const filename of fs.readdirSync(path.join(root, directory)).filter(f => f.endsWith('.js'))) {
            new vm.Script(fs.readFileSync(path.join(root, directory, filename), 'utf8'), { filename });
        }
    }
});
test('manifest references existing local files', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    const files = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page,
        ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
        ...(manifest.content_scripts || []).flatMap(s => s.js),
        ...(manifest.web_accessible_resources || []).flatMap(r => r.resources)];
    for (const file of files) assert.ok(fs.existsSync(path.join(root, 'extension', file)), file);
});

test('embedded companion JavaScript parses without executing it', () => {
    for (const filename of fs.readdirSync(path.join(root, 'companion/ui')).filter(f => f.endsWith('.js'))) {
        new vm.Script(fs.readFileSync(path.join(root, 'companion/ui', filename), 'utf8'), { filename });
    }
});
test('embedded guide uses documentation-only controller addresses', () => {
    const guide = fs.readFileSync(path.join(root, 'companion/ui/guide.html'), 'utf8');
    assert.doesNotMatch(guide, /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/);
    assert.match(guide, /192\.0\.2\.10/);
    assert.match(guide, /Documentation-only addresses/);
});
test('page relay entrypoints and web-accessible UI are absent from manifest', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
    assert.deepEqual(manifest.content_scripts || [], []);
    assert.deepEqual(manifest.web_accessible_resources || [], []);
    assert.equal(manifest.externally_connectable, undefined);
});

for (const fails of [false, true]) test(`dashboard update opens review, never applies unseen code (failure=${fails})`, async () => {
    const dashboard = fs.readFileSync(path.join(root, 'extension/dashboard.js'), 'utf8');
    const start = dashboard.indexOf('async function updateScript(id) {');
    const end = dashboard.indexOf('async function revertScript', start);
    const calls = [], alerts = [], button = {};
    const ctx = vm.createContext({
        document: { querySelector: () => button },
        send: async message => { calls.push(plain(message)); if (fails) throw new Error('fixture failure'); },
        showToast: () => {}, alert: value => alerts.push(value)
    });
    vm.runInContext(dashboard.slice(start, end), ctx);
    await ctx.updateScript('script-1');
    assert.deepEqual(calls, [{ action: 'openUpdateTab', id: 'script-1' }]);
    assert.equal(button.disabled, false);
    assert.equal(alerts.length, fails ? 1 : 0);
});

test('installer loads URL policy before installer logic', () => {
    const html = fs.readFileSync(path.join(root, 'extension/install.html'), 'utf8');
    const policy = html.indexOf('<script src="script-url-policy.js"></script>');
    assert.ok(policy >= 0 && policy < html.indexOf('<script src="install.js"></script>'));
});
test('dashboard does not offer unenforced execution protections', () => {
    const source = fs.readFileSync(path.join(root, 'extension/dashboard.js'), 'utf8');
    assert.doesNotMatch(source, /s-exec-timeout|s-run-admin|s-max-output/);
    assert.match(source, /no enforced execution timeout/);
});
