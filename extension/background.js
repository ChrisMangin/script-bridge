// ScriptBridge v3 - Background Service Worker
// Extension is the primary app; companion is optional for external scripts

let companionOnline = false;
let companionPaired = false;

// ============ SCRIPT STORAGE (chrome.storage.local) ============

async function readStoredScripts() {
    const { scripts } = await chrome.storage.local.get('scripts');
    return Array.isArray(scripts) ? scripts : [];
}

// Malformed legacy records are never injected, menued, synced, update-checked or shown to the UI,
// but they stay in storage untouched unless a valid record with the same id replaces them.
async function getScripts() {
    return (await readStoredScripts()).filter(s => !scriptFieldError(s));
}

async function saveScripts(scripts) {
    const incomingIds = new Set(scripts.map(s => s.id));
    const quarantined = (await readStoredScripts()).filter(s => scriptFieldError(s) && !incomingIds.has(s && s.id));
    await chrome.storage.local.set({ scripts: [...scripts, ...quarantined] });
}

// Settings the worker itself interprets; anything else is passed through for the UI unchanged.
const SETTING_TYPES = { page_blacklist: 'string', debug_scripts: 'boolean' };

function settingsValidationError(settings) {
    if (!isPlainObject(settings) || hasForbiddenKey(settings)) return 'Settings must be a plain object';
    for (const [key, type] of Object.entries(SETTING_TYPES)) {
        if (settings[key] !== undefined && typeof settings[key] !== type) return `Setting ${key} must be a ${type}`;
    }
    return null;
}

// Malformed stored values are dropped from the returned copy only, never rewritten in storage.
async function getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    if (!isPlainObject(settings)) return {};
    const safe = {};
    for (const [key, value] of Object.entries(settings)) {
        if (FORBIDDEN_KEYS.includes(key)) continue;
        if (SETTING_TYPES[key] && typeof value !== SETTING_TYPES[key]) continue;
        safe[key] = value;
    }
    return safe;
}

async function saveSettings(settings) {
    await chrome.storage.local.set({ settings });
}

// ============ COMPANION DETECTION ============

async function checkCompanion() {
    companionPaired = await SBCompanion.isPaired();
    companionOnline = false;
    if (companionPaired) {
        try {
            const res = await SBCompanion.fetch('/api/ping', { signal: AbortSignal.timeout(2000) });
            companionOnline = res.ok;
        } catch {
            companionOnline = false;
        }
    }
    await chrome.storage.local.set({ companionOnline });
    return companionOnline;
}

// Allowlisted fields only: the companion must never receive watch paths, working dirs or unknown fields from storage.
function companionSyncBody(script) {
    return {
        id: script.id,
        name: script.name || 'Untitled',
        description: script.description || '',
        language: script.language || 'python',
        category: 'external',
        code: script.code || '',
        match_patterns: [],
        run_at: '',
        trigger: 'manual',
        tags: script.tags || [],
        env_vars: script.env_vars || {}
    };
}

async function findRunnableExternal(id) {
    if (!isValidScriptId(id)) return null;
    return (await getScripts()).find(s => s.id === id && s.category === 'external' && s.enabled === true) || null;
}

function companionStatus() {
    return { online: companionOnline, paired: companionPaired };
}

// ============ INPUT VALIDATION ============

const SCRIPT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SCRIPT_CATEGORIES = new Set(['browser', 'external']);
const SCRIPT_LANGUAGES = new Set(['javascript', 'typescript', 'python', 'rust', 'c', 'sql', 'vbscript', 'shell', 'cmd', 'powershell']);
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === null || Object.getPrototypeOf(proto) === null;
}

function hasForbiddenKey(value) {
    return FORBIDDEN_KEYS.some(k => Object.prototype.hasOwnProperty.call(value, k));
}

function isValidScriptId(id) {
    return typeof id === 'string' && SCRIPT_ID_RE.test(id);
}

const SCRIPT_STRING_FIELDS = ['name', 'description', 'code', 'version', 'run_at', 'trigger', 'created_at', 'updated_at',
    'previous_code', 'previous_version', 'previous_updated_at', 'chain_group'];
const SCRIPT_STRING_LIST_FIELDS = ['tags', 'match_patterns'];

const isStringList = value => Array.isArray(value) && value.every(v => typeof v === 'string');

function isStringMap(value) {
    return isPlainObject(value) && !hasForbiddenKey(value) && Object.values(value).every(v => typeof v === 'string');
}

// Unknown legacy fields are tolerated; fields the extension interprets must have the expected shape.
function scriptFieldError(script) {
    if (!isPlainObject(script) || hasForbiddenKey(script)) return 'is not a plain object';
    if (!isValidScriptId(script.id)) return 'has an invalid id';
    if (!SCRIPT_CATEGORIES.has(script.category)) return 'has an invalid category';
    if (script.language !== undefined && !SCRIPT_LANGUAGES.has(script.language)) return 'has an invalid language';
    for (const field of SCRIPT_STRING_FIELDS) {
        if (script[field] !== undefined && script[field] !== null && typeof script[field] !== 'string') return `has a non-string ${field}`;
    }
    for (const field of SCRIPT_STRING_LIST_FIELDS) {
        if (script[field] !== undefined && !isStringList(script[field])) return `has an invalid ${field} list`;
    }
    if (script.env_vars !== undefined && !isStringMap(script.env_vars)) return 'has invalid env_vars';
    if (script.enabled !== undefined && typeof script.enabled !== 'boolean') return 'has a non-boolean enabled flag';
    if (script.order !== undefined && !Number.isFinite(script.order)) return 'has a non-numeric order';
    return null;
}

function scriptValidationError(scripts) {
    if (!Array.isArray(scripts)) return 'Scripts must be an array';
    const seen = new Set();
    for (const [index, script] of scripts.entries()) {
        const problem = scriptFieldError(script);
        if (problem) return `Script #${index + 1} ${problem}`;
        if (seen.has(script.id)) return `Script #${index + 1} has a duplicate id`;
        seen.add(script.id);
    }
    return null;
}

const TRUSTED_UI_PAGES = new Set(['/popup.html', '/dashboard.html', '/editor.html', '/install.html']);

// Only this extension's own UI documents (top frame, popup or tab) may reach privileged handlers.
function isTrustedSender(sender) {
    if (!sender || sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return false;
    if (sender.frameId !== undefined && sender.frameId !== 0) return false;
    const ownOrigin = 'chrome-extension://' + chrome.runtime.id;
    if (sender.origin !== undefined && sender.origin !== ownOrigin) return false;
    let url;
    try { url = new URL(sender.url); } catch { return false; }
    return url.protocol === 'chrome-extension:' && url.host === chrome.runtime.id
        && !url.username && !url.password && !url.port && TRUSTED_UI_PAGES.has(url.pathname);
}

async function fetchUserscriptText(rawUrl, timeoutMs) {
    const href = SBScriptUrlPolicy.fetchableScriptUrl(rawUrl);
    const res = await fetch(href, { redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.text();
}

// ============ SCRIPT INJECTION ============

function matchesPattern(url, pattern) {
    if (pattern === '<all_urls>' || pattern === '*://*/*') return true;
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    try {
        return new RegExp(`^${escaped}$`).test(url);
    } catch {
        return false;
    }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !tab.url) return;
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

    const scripts = await getScripts();
    const settings = await getSettings();
    const blacklist = (settings.page_blacklist || '').split('\n').filter(Boolean);

    // Check blacklist
    for (const pattern of blacklist) {
        if (matchesPattern(tab.url, pattern.trim())) return;
    }

    // Determine if any matching script needs the GM polyfill
    let needsPolyfill = false;
    const matchingScripts = [];
    for (const script of scripts) {
        if (!script.enabled || script.category !== 'browser') continue;
        const patterns = script.match_patterns || ['*://*/*'];
        const matches = patterns.some(p => matchesPattern(tab.url, p));
        if (!matches) continue;
        matchingScripts.push(script);
        if (script.code && /\bGM[_.]/.test(script.code)) needsPolyfill = true;
    }

    // Inject GM polyfill first if any script needs it
    if (needsPolyfill) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                files: ['gm-polyfill.js'],
                world: 'MAIN'
            });
        } catch(e) {
            console.warn('ScriptBridge: Failed to inject GM polyfill', e);
        }
    }

    for (const script of matchingScripts) {
        try {
            // Wrap in IIFE to isolate scope, execute directly (bypasses page CSP)
            // Shim: if page already loaded, fire load/DOMContentLoaded listeners immediately
            const wrappedCode = `(function() {
var __sb_origAddEventListener = window.addEventListener;
window.addEventListener = function(type, fn, opts) {
    if ((type === 'load' || type === 'DOMContentLoaded') && document.readyState === 'complete') {
        setTimeout(fn, 0);
    } else {
        __sb_origAddEventListener.call(this, type, fn, opts);
    }
};
${script.code}
window.addEventListener = __sb_origAddEventListener;
})();`;
            await chrome.scripting.executeScript({
                target: { tabId },
                func: (code, name, debug) => {
                    if (debug) console.log('[ScriptBridge] Injecting:', name);
                    // Try eval first (works when unsafe-inline is blocked but eval is allowed)
                    // Fall back to script tag (works when unsafe-eval is blocked but inline is allowed)
                    try {
                        (0, eval)(code);
                    } catch(e) {
                        if (e instanceof EvalError || (e.message && e.message.includes('unsafe-eval'))) {
                            try {
                                const s = document.createElement('script');
                                s.textContent = code;
                                (document.head || document.documentElement).appendChild(s);
                                s.remove();
                            } catch(e2) {
                                console.error('[ScriptBridge] Error in "' + name + '":', e2);
                            }
                        } else {
                            console.error('[ScriptBridge] Error in "' + name + '":', e);
                        }
                    }
                },
                args: [wrappedCode, script.name, !!settings.debug_scripts],
                world: 'MAIN'
            });
        } catch (e) {
            console.warn(`ScriptBridge: Failed to inject "${script.name}"`, e);
        }
    }
});

// ============ CONTEXT MENU ============

async function buildContextMenu() {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
        id: 'sb-parent',
        title: 'ScriptBridge',
        contexts: ['page', 'selection', 'link']
    });

    const scripts = await getScripts();
    const browserScripts = scripts.filter(s => s.category === 'browser' && s.enabled);
    
    for (const script of browserScripts.slice(0, 20)) {
        chrome.contextMenus.create({
            id: `inject-${script.id}`,
            parentId: 'sb-parent',
            title: script.name,
            contexts: ['page', 'selection', 'link']
        });
    }

    if (companionOnline) {
        const externals = scripts.filter(s => s.category === 'external' && s.enabled);
        if (externals.length > 0) {
            chrome.contextMenus.create({
                id: 'sb-sep', parentId: 'sb-parent', type: 'separator', contexts: ['page']
            });
            for (const ext of externals.slice(0, 20)) {
                chrome.contextMenus.create({
                    id: `ext-${ext.id}`,
                    parentId: 'sb-parent',
                    title: `[${ext.language}] ${ext.name}`,
                    contexts: ['page', 'selection', 'link']
                });
            }
        }
    }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId.startsWith('inject-')) {
        const id = info.menuItemId.slice(7);
        const scripts = await getScripts();
        const script = scripts.find(s => s.id === id);
        if (script && tab?.id) {
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: (code) => {
                        const s = document.createElement('script');
                        s.textContent = code;
                        (document.head || document.documentElement).appendChild(s);
                        s.remove();
                    },
                    args: [script.code],
                    world: 'MAIN'
                });
            } catch(e) {}
        }
    } else if (info.menuItemId.startsWith('ext-')) {
        const id = info.menuItemId.slice(4);
        if (companionOnline && await findRunnableExternal(id)) {
            SBCompanion.fetch(`/api/scripts/${encodeURIComponent(id)}/run`, { method: 'POST' }).catch(() => {});
        }
    }
});

// ============ MESSAGE HANDLING (from extension UI pages only) ============

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isTrustedSender(sender)) {
        sendResponse({ error: 'Forbidden' });
        return false;
    }
    handleMessage(msg).then(sendResponse, () => sendResponse({ error: 'Request failed' }));
    return true;
});

async function handleMessage(msg) {
    if (!isPlainObject(msg) || typeof msg.action !== 'string') return { error: 'Unknown action' };
    switch (msg.action) {
        case 'getScripts':
            return await getScripts();
        case 'saveScripts': {
            const invalid = scriptValidationError(msg.scripts);
            if (invalid) return { error: invalid };
            await saveScripts(msg.scripts);
            buildContextMenu();
            return { ok: true };
        }
        case 'getSettings':
            return await getSettings();
        case 'saveSettings':
            {
                const invalid = settingsValidationError(msg.settings);
                if (invalid) return { error: invalid };
            }
            await saveSettings(msg.settings);
            return { ok: true };
        case 'getCompanionStatus':
            return companionStatus();
        case 'checkCompanion':
            await checkCompanion();
            return companionStatus();
        case 'runExternal':
            if (!isValidScriptId(msg.id)) return { error: 'Invalid script id' };
            if (!await findRunnableExternal(msg.id)) return { error: 'External script is missing or disabled' };
            if (!companionOnline) return { error: 'Companion offline' };
            try {
                const res = await SBCompanion.fetch(`/api/scripts/${encodeURIComponent(msg.id)}/run`, { method: 'POST' });
                return await res.json();
            } catch(e) {
                return { error: e.message };
            }
        case 'checkForUpdates':
            return await checkForUpdates();
        case 'getUpdates': {
            const { scriptUpdates = {} } = await chrome.storage.local.get('scriptUpdates');
            return scriptUpdates;
        }
        case 'openUpdateTab':
            if (!isValidScriptId(msg.id)) return { error: 'Invalid script id' };
            openUpdateTab(msg.id);
            return { ok: true };
        case 'revertScript':
            if (!isValidScriptId(msg.id)) return { error: 'Invalid script id' };
            return await revertScript(msg.id);
        case 'syncToCompanion': {
            if (!companionOnline) return { error: 'Companion offline' };
            const externals = (await getScripts()).filter(s => s.category === 'external' && s.enabled === true);
            let synced = 0;
            for (const s of externals) {
                try {
                    const res = await SBCompanion.fetch('/api/scripts', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(companionSyncBody(s))
                    });
                    if (res.ok) synced++;
                } catch { /* reported through the synced count */ }
            }
            return { ok: true, synced, total: externals.length };
        }
        default:
            return { error: 'Unknown action' };
    }
}

// ============ SCRIPT UPDATE CHECKER ============

// Compare semver-like version strings: returns true if remote > local
function isNewerVersion(local, remote) {
    if (!local || !remote) return false;
    const normalize = v => v.replace(/[^0-9.]/g, '').split('.').map(Number);
    const l = normalize(local), r = normalize(remote);
    for (let i = 0; i < Math.max(l.length, r.length); i++) {
        const lp = l[i] || 0, rp = r[i] || 0;
        if (rp > lp) return true;
        if (rp < lp) return false;
    }
    return false;
}

// Parse @key values from userscript header text
function parseMetaHeader(text) {
    const meta = {};
    for (const line of text.split('\n')) {
        const m = line.match(/(?:\/\/|#|\/\*|\*)\s*@(\w+)\s+(.*?)(?:\s*\*\/)?$/);
        if (m) meta[m[1]] = m[2].trim();
    }
    return meta;
}

// Check all scripts that have @updateURL for newer versions
async function checkForUpdates() {
    const scripts = await getScripts();
    const updates = {}; // id -> { remoteVersion, updateUrl, downloadUrl }
    
    for (const script of scripts) {
        if (!script.code) continue;
        const meta = parseMetaHeader(script.code);
        const updateUrl = meta.updateURL;
        if (!updateUrl) continue;
        
        try {
            const text = await fetchUserscriptText(updateUrl, 10000);
            const remoteMeta = parseMetaHeader(text);
            const localVersion = meta.version || script.version || '';
            const remoteVersion = remoteMeta.version || '';
            
            if (isNewerVersion(localVersion, remoteVersion)) {
                updates[script.id] = {
                    remoteVersion,
                    localVersion,
                    downloadUrl: SBScriptUrlPolicy.fetchableScriptUrl(remoteMeta.downloadURL || meta.downloadURL || updateUrl),
                    scriptName: script.name
                };
            }
        } catch (e) {
            // Unreachable, rejected or unsafe URL: skip this script
        }
    }
    
    // Updates are listed in the dashboard; the user opens the preview tab per script.
    await chrome.storage.local.set({ scriptUpdates: updates });
    return updates;
}

// Revert a script to its previous version
async function revertScript(scriptId) {
    const scripts = await getScripts();
    const idx = scripts.findIndex(s => s.id === scriptId);
    if (idx === -1) return { error: 'Script not found' };
    if (!scripts[idx].previous_code) return { error: 'No previous version to revert to' };
    
    // Swap current and previous
    const currentCode = scripts[idx].code;
    const currentVersion = scripts[idx].version;
    const currentUpdatedAt = scripts[idx].updated_at;
    
    scripts[idx].code = scripts[idx].previous_code;
    scripts[idx].version = scripts[idx].previous_version || '';
    scripts[idx].updated_at = scripts[idx].previous_updated_at || new Date().toISOString();
    
    // Store what we reverted from so user can re-apply
    scripts[idx].previous_code = currentCode;
    scripts[idx].previous_version = currentVersion;
    scripts[idx].previous_updated_at = currentUpdatedAt;
    
    await saveScripts(scripts);
    return { ok: true, revertedTo: scripts[idx].version };
}


// ============ .USER.JS INSTALL INTERCEPTION ============

// Intercept navigations to .user.js URLs and redirect to install page
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameId !== 0) return; // only main frame
    const url = details.url;
    if (url.match(/\.user\.js(\?.*)?$/i) && !url.startsWith("chrome-extension://")) {
        // Redirect to our install page
        const installUrl = chrome.runtime.getURL("install.html") + "?url=" + encodeURIComponent(url);
        chrome.tabs.update(details.tabId, { url: installUrl });
    }
});

// Also catch downloads/links that end in .user.js (content script approach)
chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    const url = details.url;
    if (url.match(/\.user\.js(\?.*)?$/i) && !url.startsWith("chrome-extension://")) {
        const installUrl = chrome.runtime.getURL("install.html") + "?url=" + encodeURIComponent(url);
        chrome.tabs.update(details.tabId, { url: installUrl });
    }
});

// Open update tab when update is found (called from checkForUpdates)
async function openUpdateTab(scriptId) {
    const installUrl = chrome.runtime.getURL("install.html") + "?update=" + encodeURIComponent(scriptId);
    chrome.tabs.create({ url: installUrl });
}

// ============ INIT ============

// Loaded here rather than at the top so unit tests can evaluate the helpers above without a worker global.
importScripts('companion-client.js', 'script-url-policy.js');

checkCompanion();
buildContextMenu();
setInterval(checkCompanion, 30000);
setInterval(buildContextMenu, 60000);

// Check for script updates on startup and every 6 hours
checkForUpdates();
setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
