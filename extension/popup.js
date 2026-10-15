// ScriptBridge Popup - talks to background via messages
async function send(msg) {
    const response = await chrome.runtime.sendMessage(msg); if (response && !Array.isArray(response) && response.error) throw new Error(response.error); return response;
}

function matchesPattern(url, pattern) {
    if (!url || !pattern) return false;
    if (pattern === '<all_urls>' || pattern === '*://*/*') return true;
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    try { return new RegExp('^' + escaped + '$').test(url); }
    catch { return false; }
}

async function init() {
    // Get scripts from extension storage
    const allScripts = await send({ action: 'getScripts' }) || [];
    const { online } = await send({ action: 'getCompanionStatus' });

    // Get current tab URL to filter scripts
    let currentUrl = '';
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) currentUrl = tab.url || '';
    } catch {}

    // Filter: show scripts whose @match patterns match the current URL (include disabled)
    const scripts = allScripts.filter(s => {
        const patterns = s.match_patterns || [];
        // Scripts with no match patterns show everywhere (backward compat)
        if (patterns.length === 0) return true;
        return patterns.some(p => matchesPattern(currentUrl, p));
    });
    // Sort enabled first, then disabled
    scripts.sort((a, b) => (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0));

    // Status dot
    const dot = document.getElementById('status-dot');
    dot.classList.remove('online', 'offline', 'ext-only');
    dot.classList.add('online'); // Extension is always "on"

    // Companion status
    const cDot = document.getElementById('companion-dot');
    const cText = document.getElementById('companion-text');
    cDot.classList.remove('online', 'offline');
    if (online) {
        cDot.classList.add('online');
        cText.textContent = 'Companion: connected (external scripts enabled)';
    } else {
        cDot.classList.add('offline');
        cText.innerHTML = 'Companion: offline or unpaired <a href="#" id="install-link">(open pairing)</a>';
    }

    // Script count
    const enabledCount = scripts.filter(s => s.enabled).length;
    document.getElementById('script-count').textContent = `${enabledCount} active, ${scripts.length} total for this page`;

    // Render script list
    renderScripts(scripts);

    // Install link handler
    document.getElementById('install-link')?.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html#companion') });
    });
}

function renderScripts(scripts) {
    const list = document.getElementById('script-list');
    if (scripts.length === 0) {
        list.innerHTML = '<div class="empty">No scripts match this page.</div>';
        return;
    }
    // Show max 15 in popup
    const shown = scripts.slice(0, 15);
    list.innerHTML = shown.map(s => `
        <div class="script-item${s.enabled ? '' : ' disabled'}">
            <div class="script-info">
                <div class="script-name">${esc(s.name)}</div>
                <div class="script-meta">
                    <span class="badge badge-${esc(s.category)}">${esc(s.category)}</span>
                    ${esc(s.language || 'js')}
                    ${s.enabled ? '' : '<span class="badge badge-off">off</span>'}
                </div>
            </div>
            <div class="toggle ${s.enabled ? 'on' : ''}" data-id="${esc(s.id)}"></div>
        </div>
    `).join('');

    // Toggle handlers
    list.querySelectorAll('.toggle').forEach(el => {
        el.addEventListener('click', async () => {
            const id = el.dataset.id;
            const allScripts = await send({ action: 'getScripts' });
            const script = allScripts.find(s => s.id === id);
            if (script) {
                script.enabled = !script.enabled;
                await send({ action: 'saveScripts', scripts: allScripts });
                el.classList.toggle('on');
            }
        });
    });
}

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// Dashboard button
document.getElementById('btn-dashboard').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

// New script button
document.getElementById('btn-new').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });
});

init();
