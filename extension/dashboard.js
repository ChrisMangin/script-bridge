// ScriptBridge Dashboard - runs entirely in the extension
// All data in chrome.storage.local; companion is optional

let scripts = [];
let currentFilter = 'all';
let companionOnline = false;
let selectedScripts = new Set(); // IDs of selected scripts
let scriptUpdates = {}; // id -> { remoteVersion, localVersion, downloadUrl, scriptName }
let currentLayout = 'grid'; // grid, list, or table
let scheduledScriptIds = new Set(); // IDs of scripts with active schedules
let scriptChains = {}; // id -> chain name (if script belongs to a chain)

// ============ MESSAGING ============
async function send(msg) {
    const response = await chrome.runtime.sendMessage(msg);
    if (response && !Array.isArray(response) && response.error) throw new Error(response.error);
    return response;
}

// ============ INIT ============
async function init() {
    scripts = await send({ action: 'getScripts' }) || [];
    const status = await send({ action: 'checkCompanion' });
    companionOnline = status?.online || false;
    scriptUpdates = await send({ action: 'getUpdates' }) || {};
    const settings = await send({ action: 'getSettings' }) || {};
    currentLayout = settings.layout || 'table';
    await loadScheduleStatus();
    loadChainData();
    updateCompanionIndicator();
    renderPage();
    loadPageFromHash();
}

// Listen for storage changes from other tabs (install/update pages)
chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'local' && changes.scripts) {
        scripts = await send({ action: 'getScripts' }) || [];
        scriptUpdates = {};
        renderPage();
    }
    if (area === 'local' && changes.scriptUpdates) {
        scriptUpdates = changes.scriptUpdates.newValue || {};
        renderPage();
    }
});

function loadPageFromHash() {
    const hash = location.hash.slice(1);
    if (hash === 'new') { showPage('scripts'); setTimeout(showCreateModal, 100); }
    else if (hash === 'companion') showPage('companion');
    else if (hash === 'settings') showPage('settings');
    else if (hash === 'guide') showPage('guide');
}

function updateCompanionIndicator() {
    const dot = document.getElementById('nav-companion-dot');
    if (dot) {
        dot.classList.toggle('online', companionOnline);
    }
    // Hide external tab when companion is offline
    const extTab = document.querySelector('.tab[data-tab="external"]');
    if (extTab) {
        extTab.style.display = companionOnline ? '' : 'none';
    }
    // Hide/disable external category option in new script modal
    const extOption = document.querySelector('#script-category option[value="external"]');
    if (extOption) {
        extOption.disabled = !companionOnline;
        extOption.textContent = companionOnline ? 'External (local)' : 'External (requires companion)';
    }
    // Show/hide external locked notice
    const locked = document.getElementById('external-locked');
    if (locked) locked.classList.toggle('hidden', companionOnline);
}

// ============ PAGES ============
async function showPage(name) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
    document.getElementById(`page-${name}`).classList.add('active');
    document.querySelector(`.nav-link[data-page="${name}"]`)?.classList.add('active');
    
    if (name === 'companion') renderCompanionPage();
    if (name === 'settings') renderSettingsPage();
    if (name === 'guide') renderGuidePage();
    if (name === 'scripts') {
        await loadScheduleStatus();
        loadChainData();
        renderPage();
    }
}

// ============ SCRIPTS ============
function filterTab(tab) {
    currentFilter = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    render();
}

function render() {
    const list = document.getElementById('script-list');
    if (!list) return;
    let filtered = scripts;
    if (currentFilter === 'browser') filtered = scripts.filter(s => s.category === 'browser');
    if (currentFilter === 'external') filtered = scripts.filter(s => s.category === 'external');

    // Hide external scripts when companion is offline
    if (!companionOnline) {
        filtered = filtered.filter(s => s.category !== 'external');
    }

    // Drag-and-drop ordering (defaults to insertion order for scripts with no order set)
    filtered = filtered.slice().sort((a, b) => (a.order || 0) - (b.order || 0));

    if (filtered.length === 0) {
        list.innerHTML = `<div class="empty-state"><h3>No scripts yet</h3><p>Click "+ New Script" to create your first script</p></div>`;
        return;
    }

    // Apply layout class
    list.className = currentLayout === 'list' ? 'script-list-view' : currentLayout === 'table' ? 'script-table-view' : 'script-grid';

    if (currentLayout === 'table') {
        list.innerHTML = `<table class="script-table"><thead><tr>
            <th><input type="checkbox" id="table-select-all" ${filtered.every(s=>selectedScripts.has(s.id))?'checked':''}></th>
            <th>Name</th><th>Lang</th><th>Category</th><th>Status</th><th>Size</th><th>Modified</th><th>Version</th><th>Actions</th>
        </tr></thead><tbody>${filtered.map(s => `<tr data-drag-id="${esc(s.id)}">
            <td><input type="checkbox" class="script-select-cb" data-select-id="${esc(s.id)}" ${selectedScripts.has(s.id)?'checked':''}></td>
            <td class="td-name">${esc(s.name)}${s.chain_group ? ' <span class="badge badge-chain">ὑ7 '+esc(s.chain_group)+'</span>':''}${scheduledScriptIds.has(s.id)?'<span class="badge badge-scheduled">⏰</span>':''}</td>
            <td><span class="badge badge-${langClass(s.language)}">${esc(s.language||'js')}</span></td>
            <td>${esc(s.category)}</td>
            <td><label class="toggle-switch"><input type="checkbox" ${s.enabled?'checked':''} data-action="toggle" data-id="${esc(s.id)}"><span class="toggle-slider"></span></label></td>
            <td>${formatSize(s.code?.length||0)}</td>
            <td>${s.updated_at?formatDate(s.updated_at):'—'}</td>
            <td>${s.version?'v'+esc(s.version):'—'}</td>
            <td class="td-actions"><button class="btn btn-sm" data-action="edit" data-id="${esc(s.id)}">Edit</button>${s.category==='external'&&companionOnline?` <button class="btn btn-sm btn-run" data-action="run" data-id="${esc(s.id)}">&#9654;</button>`:''}${scriptUpdates[s.id]?` <button class="btn btn-update btn-sm" data-action="update" data-id="${esc(s.id)}">Update</button>`:''}${s.previous_code?` <button class="btn btn-revert btn-sm" data-action="revert" data-id="${esc(s.id)}" title="Roll back to v${esc(s.previous_version||'prev')}">&#x21A9; Roll Back</button>`:''} <button class="btn btn-danger btn-sm" data-action="delete" data-id="${esc(s.id)}">Del</button></td>
        </tr>`).join('')}</tbody></table>`;
        list.querySelector('#table-select-all')?.addEventListener('change', (e) => {
            const checked = e.target.checked;
            if (checked) filtered.forEach(s => selectedScripts.add(s.id));
            else filtered.forEach(s => selectedScripts.delete(s.id));
            list.querySelectorAll('.script-select-cb').forEach(cb => cb.checked = checked);
            updateBulkBar();
        });
    } else if (currentLayout === 'list') {
        list.innerHTML = filtered.map(s => `
            <div class="script-row" data-drag-id="${esc(s.id)}">
                <input type="checkbox" class="script-select-cb" data-select-id="${esc(s.id)}" ${selectedScripts.has(s.id)?'checked':''}>
                <label class="toggle-switch"><input type="checkbox" ${s.enabled?'checked':''} data-action="toggle" data-id="${esc(s.id)}"><span class="toggle-slider"></span></label>
                <span class="row-name">${esc(s.name)}</span>
                <span class="badge badge-${langClass(s.language)}">${esc(s.language||'js')}</span>
                ${scheduledScriptIds.has(s.id)?'<span class="badge badge-scheduled">⏰</span>':''}
                ${s.chain_group?`<span class="badge badge-chain">ὑ7 ${esc(s.chain_group)}</span>`:''}
                ${scriptUpdates[s.id]?'<span class="badge badge-update">⬆</span>':''}
                <span class="row-meta">${formatSize(s.code?.length||0)} &middot; ${s.updated_at?formatDate(s.updated_at):'—'}${s.version?' &middot; v'+esc(s.version):''}</span>
                <span class="row-actions">
                    <button class="btn btn-sm" data-action="edit" data-id="${esc(s.id)}">Edit</button>
                    ${s.category==='external'&&companionOnline?`<button class="btn btn-sm btn-run" data-action="run" data-id="${esc(s.id)}">▶</button>`:''}
                    ${scriptUpdates[s.id]?`<button class="btn btn-update btn-sm" data-action="update" data-id="${esc(s.id)}">⬆ Update</button>`:''}
                    ${s.previous_code?`<button class="btn btn-revert btn-sm" data-action="revert" data-id="${esc(s.id)}" title="Roll back to v${esc(s.previous_version||'prev')}">↩ Roll Back</button>`:''}
                    <button class="btn btn-sm btn-danger" data-action="delete" data-id="${esc(s.id)}">Del</button>
                </span>
            </div>
        `).join('');
    } else {
        // Grid (default)
        list.innerHTML = filtered.map(s => `
            <div class="script-card" draggable="true" data-drag-id="${esc(s.id)}">
                <div class="script-card-header">
                    <span class="drag-handle" title="Drag to reorder">&#8942;&#8942;</span>
                    <input type="checkbox" class="script-select-cb" data-select-id="${esc(s.id)}" ${selectedScripts.has(s.id)?'checked':''}>
                    <h3>${esc(s.name)}</h3>
                    <label class="toggle-switch">
                        <input type="checkbox" ${s.enabled ? 'checked' : ''} data-action="toggle" data-id="${esc(s.id)}">
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="script-card-meta">
                    <span class="badge badge-${langClass(s.language)}">${esc(s.language || 'javascript')}</span>
                    <span class="badge badge-${esc(s.category)}">${esc(s.category)}</span>
                    <span class="badge ${s.enabled ? 'badge-enabled' : 'badge-disabled'}">${s.enabled ? 'enabled' : 'disabled'}</span>
                    ${s.watch_path ? '<span class="badge" style="background:#1a3020;color:var(--green)">watching</span>' : ''}
                    ${scheduledScriptIds.has(s.id) ? '<span class="badge badge-scheduled" title="Running on a schedule">&#x23F0; scheduled</span>' : ''}
                    ${s.chain_group ? `<span class="badge badge-chain" title="Chain: ${esc(s.chain_group)}">&#x1F517; ${esc(s.chain_group)}</span>` : ''}
                    ${scriptUpdates[s.id] ? `<span class="badge badge-update" title="Update available: v${esc(scriptUpdates[s.id].remoteVersion)}">&#x2B06; update</span>` : ''}
                </div>
                <div class="script-info-row">
                    <span class="script-size" title="Code size">${formatSize(s.code?.length || 0)}</span>
                    <span class="script-date" title="Last modified">${s.updated_at ? formatDate(s.updated_at) : 'never'}</span>
                    ${s.version ? `<span class="script-version">v${esc(s.version)}</span>` : ''}
                    ${getUpdateStatus(s)}
                </div>
                <p class="script-desc">${esc(s.description || 'No description')}</p>
                ${(s.tags && s.tags.length) ? `<div class="script-tags">${s.tags.map(t => `<span class="tag-pill">${esc(t)}</span>`).join('')}</div>` : ''}
                <div class="script-actions">
                    <button class="btn" data-action="edit" data-id="${esc(s.id)}">Edit</button>
                    ${s.category === 'external' && companionOnline ? `<button class="btn btn-run" data-action="run" data-id="${esc(s.id)}">&#9654; Run</button>` : ''}
                    ${s.category === 'external' && !companionOnline ? `<button class="btn" disabled title="Start companion to run">&#9654; Run</button>` : ''}
                    ${scriptUpdates[s.id] ? `<button class="btn btn-update" data-action="update" data-id="${esc(s.id)}">&#x2B06; Update to v${esc(scriptUpdates[s.id].remoteVersion)}</button>` : ''}
                    ${s.previous_code ? `<button class="btn btn-revert" data-action="revert" data-id="${esc(s.id)}" title="Roll back to the previous version (v${esc(s.previous_version || '?')})">&#x21A9; Roll Back to v${esc(s.previous_version || 'prev')}</button>` : ''}
                    <button class="btn btn-danger" data-action="delete" data-id="${esc(s.id)}">Delete</button>
                    ${s.last_run ? `<span style="font-size:0.7rem;color:var(--dim);margin-left:auto">Last: ${new Date(s.last_run).toLocaleString()}</span>` : ''}
                </div>
            </div>
        `).join('');
    }

    bindDragReorder(list, filtered);
}

// Drag-and-drop reordering: persists an `order` field on each script
function bindDragReorder(list, filtered) {
    let dragId = null;
    list.querySelectorAll('.script-card').forEach(card => {
        card.addEventListener('dragstart', (e) => {
            dragId = card.dataset.dragId;
            card.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            list.querySelectorAll('.script-card').forEach(c => c.classList.remove('drag-over'));
        });
        card.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (card.dataset.dragId !== dragId) card.classList.add('drag-over');
        });
        card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
        card.addEventListener('drop', (e) => {
            e.preventDefault();
            card.classList.remove('drag-over');
            const targetId = card.dataset.dragId;
            if (!dragId || dragId === targetId) return;

            const order = filtered.map(s => s.id);
            const fromIdx = order.indexOf(dragId);
            const toIdx = order.indexOf(targetId);
            if (fromIdx === -1 || toIdx === -1) return;
            order.splice(toIdx, 0, order.splice(fromIdx, 1)[0]);

            // Re-assign sequential order values to this filtered set only
            order.forEach((id, i) => {
                const s = scripts.find(x => x.id === id);
                if (s) s.order = i;
            });
            send({ action: 'saveScripts', scripts });
            render();
        });
    });
}

function langClass(lang) {
    return { javascript:'js', typescript:'ts', python:'python', rust:'rust', c:'c', sql:'sql', vbscript:'vb', shell:'shell', cmd:'cmd', powershell:'powershell' }[lang] || 'js';
}
function esc(str) { return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
    return d.toLocaleDateString();
}

function getUpdateStatus(s) {
    // If there's a pending update, show "outdated"
    if (scriptUpdates[s.id]) {
        return '<span class="script-status status-outdated" title="Remote version is newer">outdated</span>';
    }
    // If script has updateURL and no pending update, it's up to date
    const meta = parseMetaFromCode(s.code || '');
    if (meta.updateURL) {
        return '<span class="script-status status-current" title="Matches remote version">up to date</span>';
    }
    // No updateURL = local only
    return '<span class="script-status status-local" title="No update URL configured">local</span>';
}

// ============ EDITOR (inline tabbed) ============
let openEditors = []; // [{id, name, code, isNew}]
let activeEditor = null; // id of active editor tab, or null = list view

function getTemplate(lang) {
    const date = new Date().toISOString().slice(0,10);
    if (lang === 'javascript') return `// ==UserScript==\n// @name         New Userscript\n// @namespace    scriptbridge\n// @version      ${date}\n// @description  try to take over the world!\n// @author       You\n// @match        https://*/*\n// @grant        none\n// ==/UserScript==\n\n(function() {\n    'use strict';\n\n    // Your code here...\n})();`;
    if (lang === 'python') return `#!/usr/bin/env python3\n# @name         New Script\n# @category     external\n# @language     python\n# @trigger      manual\n\ndef main():\n    print("Hello from ScriptBridge!")\n\nif __name__ == "__main__":\n    main()`;
    if (lang === 'rust') return `// @name         New Script\n// @category     external\n// @language     rust\n// @trigger      manual\n\nfn main() {\n    println!("Hello from ScriptBridge!");\n}`;
    if (lang === 'powershell') return `# @name         New Script\n# @category     external\n# @language     powershell\n# @trigger      manual\n\nWrite-Host "Hello from ScriptBridge!"`;
    if (lang === 'c') return `/* @name         New Script */\n/* @category     external */\n/* @language     c */\n/* @trigger      manual */\n\n#include <stdio.h>\nint main() {\n    printf("Hello from ScriptBridge!\\n");\n    return 0;\n}`;
    if (lang === 'typescript') return `// ==UserScript==
// @name         New Userscript
// @namespace    scriptbridge
// @version      ${date}
// @description  TypeScript userscript
// @author       You
// @match        https://*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    // Your code here...
})();`;
    if (lang === 'sql') return `-- @name         New Script
-- @category     external
-- @language     sql
-- @trigger      manual

SELECT 1;`;
    if (lang === 'vbscript') return `' @name         New Script
' @category     external
' @language     vbscript
' @trigger      manual

WScript.Echo "Hello from ScriptBridge!"`;
    if (lang === 'shell') return `#!/bin/bash
# @name         New Script
# @category     external
# @language     shell
# @trigger      manual

echo "Hello from ScriptBridge!"`;
    if (lang === 'cmd') return `@echo off\nREM @name         New Script\nREM @category     external\nREM @language     cmd\nREM @trigger      manual\n\necho Hello from ScriptBridge!`;
    return '';
}

function parseMetaFromCode(code) {
    // Parse @key value from any comment style (// # REM /* */)
    const meta = {};
    const lines = code.split('\n');
    for (const line of lines) {
        const m = line.match(/(?:\/\/|#|REM|\/\*|\*)\s*@(\w+)\s+(.*?)(?:\s*\*\/)?$/);
        if (m) meta[m[1]] = m[2].trim();
    }
    return meta;
}

// @require lines can repeat, so parse them separately from the single-value meta map
function parseRequires(code) {
    const out = [];
    for (const line of code.split('\n')) {
        const m = line.match(/(?:\/\/|#|REM|\/\*|\*)\s*@require\s+(.*?)(?:\s*\*\/)?$/);
        if (m) out.push(m[1].trim());
    }
    return out;
}

function renderVarRows(ed) {
    if (!ed.envRows || ed.envRows.length === 0) {
        return '<div class="dim" style="font-size:0.8rem;padding:4px 0">No variables. Click + Add to create one.</div>';
    }
    return ed.envRows.map((r, i) => `
        <div class="var-row" data-idx="${i}">
            <input type="text" class="var-key" placeholder="KEY" value="${esc(r.key)}" data-idx="${i}">
            <input type="text" class="var-value" placeholder="value" value="${esc(r.value)}" data-idx="${i}">
            <button class="btn btn-danger btn-sm" data-remove-var="${i}" title="Remove">&times;</button>
        </div>
    `).join('');
}

function renderDepRows(ed) {
    const reqs = parseRequires(ed.code);
    if (reqs.length === 0) {
        return '<div class="dim" style="font-size:0.8rem;padding:4px 0">No <code>@require</code> lines in code. Example: <code># @require pip:pylogix</code></div>';
    }
    return reqs.map(r => `
        <div class="dep-row" data-require="${esc(r)}">
            <span class="dep-name">${esc(r)}</span>
            <button class="btn btn-sm" data-check-dep="${esc(r)}">Check</button>
            <span class="dep-result" data-result-for="${esc(r)}"></span>
        </div>
    `).join('');
}

// ============ DIFF ON SAVE ============
function computeLineDiff(oldStr, newStr) {
    const a = oldStr.split('\n');
    const b = newStr.split('\n');
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: 'del', line: a[i] }); i++; }
        else { ops.push({ t: 'add', line: b[j] }); j++; }
    }
    while (i < n) { ops.push({ t: 'del', line: a[i] }); i++; }
    while (j < m) { ops.push({ t: 'add', line: b[j] }); j++; }
    return ops;
}

function showDiffConfirm(oldCode, newCode, onConfirm) {
    if (oldCode === newCode) { onConfirm(); return; }
    if (oldCode.length > 200000 || newCode.length > 200000) { onConfirm(); return; } // skip diff for huge files
    const ops = computeLineDiff(oldCode, newCode);
    const added = ops.filter(o => o.t === 'add').length;
    const removed = ops.filter(o => o.t === 'del').length;
    const rows = ops.map(o => `<div class="${o.t === 'add' ? 'diff-add' : 'diff-del'}">${o.t === 'add' ? '+' : '-'} ${esc(o.line)}</div>`).join('');
    const overlay = document.createElement('div');
    overlay.className = 'diff-modal-overlay';
    overlay.innerHTML = `
        <div class="diff-modal">
            <h3>Changes since last save</h3>
            <p class="dim" style="margin:4px 0 8px">+${added} / -${removed} lines</p>
            <div class="diff-modal-body">${rows || '<div class="dim">No visible changes</div>'}</div>
            <div class="diff-modal-actions">
                <button class="btn" id="diff-cancel">Cancel</button>
                <button class="btn btn-primary" id="diff-confirm">Save</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#diff-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#diff-confirm').addEventListener('click', () => { overlay.remove(); onConfirm(); });
}

function openScriptEditor(script) {
    if (script) {
        // Edit existing
        const existing = openEditors.find(e => e.id === script.id);
        if (existing) {
            activeEditor = script.id;
        } else {
            const envRows = Object.entries(script.env_vars || {}).map(([key, value]) => ({ key, value }));
            openEditors.push({ id: script.id, name: script.name, code: script.code, isNew: false, dirty: false, envRows });
            activeEditor = script.id;
        }
    } else {
        // New script
        const id = crypto.randomUUID();
        const code = getTemplate('javascript');
        openEditors.push({ id, name: 'New Userscript', code, isNew: true, dirty: false, envRows: [] });
        activeEditor = id;
    }
    renderPage();
}

function closeEditor(id) {
    const ed = openEditors.find(e => e.id === id);
    if (ed && ed.dirty && !confirm(`"${ed.name}" has unsaved changes. Close?`)) return;
    openEditors = openEditors.filter(e => e.id !== id);
    if (activeEditor === id) activeEditor = null;
    renderPage();
}

function saveActiveEditor() {
    const ed = openEditors.find(e => e.id === activeEditor);
    if (!ed) return;
    const codeEl = document.getElementById('editor-textarea');
    if (codeEl) ed.code = codeEl.value;

    const existing = scripts.find(s => s.id === ed.id);
    const oldCode = existing ? existing.code : '';

    if (!ed.isNew && existing) {
        showDiffConfirm(oldCode, ed.code, () => doSaveActiveEditor(ed));
    } else {
        doSaveActiveEditor(ed);
    }
}

async function doSaveActiveEditor(ed) {
    try {
        const meta = parseMetaFromCode(ed.code);
        const env_vars = Object.create(null);
        for (const row of ed.envRows || []) {
            if (row.key && row.key.trim()) env_vars[row.key.trim()] = row.value || '';
        }
        const existing = scripts.find(item => item.id === ed.id);
        const updated = { ...(existing || {}), id: ed.id, name: meta.name || ed.name,
            description: meta.description || '', language: meta.language || 'javascript',
            category: meta.category || 'browser', code: ed.code,
            enabled: existing ? existing.enabled : true,
            match_patterns: meta.match ? [meta.match] : ['https://*/*'],
            run_at: meta['run-at'] || 'document-idle', trigger: 'manual',
            tags: existing?.tags || [], env_vars, version: meta.version || '',
            created_at: existing?.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString(), order: existing?.order ?? scripts.length };
        if (existing && existing.code !== ed.code) {
            updated.previous_code = existing.code;
            updated.previous_version = existing.version || '';
            updated.previous_updated_at = existing.updated_at || '';
        }
        const next = scripts.filter(item => item.id !== ed.id).concat(updated);
        await send({ action: 'saveScripts', scripts: next });
        scripts = await send({ action: 'getScripts' });
        ed.name = updated.name;
        ed.dirty = false;
        ed.isNew = false;
        renderPage();
    } catch (error) {
        ed.dirty = true;
        alert('Could not save script: ' + error.message);
    }
}

function renderPage() {
    const page = document.getElementById('page-scripts');
    if (!page) return;

    // Build tab bar: All | Browser | External | [open script tabs...]
    const filterTabs = ['all','browser','external'].map(t => {
        const active = !activeEditor && currentFilter === t;
        const label = t === 'all' ? 'All' : t === 'browser' ? 'Browser' : 'External';
        const hidden = (t === 'external' && !companionOnline) ? ' style="display:none"' : '';
        return `<button class="tab ${active?'active':''}" data-tab="${t}"${hidden}>${label}</button>`;
    }).join('');

    const editorTabsHtml = openEditors.map(ed => {
        const active = activeEditor === ed.id;
        return `<div class="tab editor-script-tab ${active?'active':''}" data-editor-id="${esc(ed.id)}">
            ${esc(ed.name)}${ed.dirty?' *':''}
            <span class="tab-close" data-close-id="${esc(ed.id)}">&times;</span>
        </div>`;
    }).join('');

    if (activeEditor) {
        // Show editor view
        const ed = openEditors.find(e => e.id === activeEditor);
        page.innerHTML = `
            <div class="toolbar">
                <div class="tabs">${filterTabs}${editorTabsHtml}</div>
                <span id="filter-count" class="filter-count"></span>
                <div class="toolbar-right">
                    <button class="btn btn-primary" id="editor-save">Save (Ctrl+S)</button>
                </div>
            </div>
            <div class="editor-code-area">
                <div class="editor-line-nums" id="editor-line-nums"></div>
                <div class="editor-highlight-wrap">
                    <textarea id="editor-textarea" spellcheck="false" wrap="off">${ed ? esc(ed.code) : ''}</textarea>
                    <pre id="editor-highlight" class="editor-highlight" aria-hidden="true"><code></code></pre>
                </div>
            </div>
            <div class="editor-extra">
                <div class="editor-extra-col">
                    <div class="editor-extra-title">Variables <button class="btn btn-sm" id="var-add">+ Add</button></div>
                    <div id="var-rows">${ed ? renderVarRows(ed) : ''}</div>
                </div>
                <div class="editor-extra-col">
                    <div class="editor-extra-title">Dependencies</div>
                    <div id="dep-rows">${ed ? renderDepRows(ed) : ''}</div>
                </div>
            </div>
        `;
        bindPageEvents(page);
        updateEditorLines();
        setTimeout(updateHighlight, 50);
    } else {
        // Show script list
        page.innerHTML = `
            <div class="toolbar">
                <div class="tabs">${filterTabs}${editorTabsHtml}</div>
                <span id="filter-count" class="filter-count"></span>
                <div class="toolbar-right">
                    <label class="select-all-label" title="Select all"><input type="checkbox" id="select-all-cb"> All</label>
                    <span id="selection-count" class="selection-count" style="display:none"></span>
                    <select id="bulk-actions" class="bulk-select" style="display:none">
                        <option value="">-- Bulk Actions --</option>
                        <option value="chain">Run as Chain</option>
                        <option value="savechain">Save as Chain Group</option>
                        <option value="unchain">Remove from Chain</option>
                        <option value="toggle">Toggle Enable</option>
                        <option value="addtag">Add Tag</option>
                        <option value="removetag">Remove Tag</option>
                        <option value="export">Export Selected</option>
                        <option value="delete">Delete</option>
                    </select>
                    <select id="filter-language" class="filter-select"><option value="">Lang</option><option value="javascript">JS</option><option value="typescript">TS</option><option value="python">Python</option><option value="rust">Rust</option><option value="c">C</option><option value="sql">SQL</option><option value="vbscript">VB</option><option value="shell">Shell</option><option value="cmd">CMD</option><option value="powershell">PS</option></select>
                    <select id="filter-status" class="filter-select"><option value="">Status</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select>
                    <select id="filter-tag" class="filter-select"><option value="">Tags</option></select>
                    <select id="filter-sort" class="filter-select"><option value="order">Order</option><option value="name">A-Z</option><option value="name-desc">Z-A</option><option value="updated">Recent</option><option value="size">Largest</option><option value="size-asc">Smallest</option></select>
                    <button class="btn btn-sm" id="filter-clear" style="display:none">&times;</button>
                    <input type="text" id="search-input" placeholder="Search... (Ctrl+F)" class="search-box">
                    <label class="regex-toggle" title="Enable regex search"><input type="checkbox" id="search-regex"> <span>Regex</span></label>
                    <button class="btn" id="btn-check-updates">&#x27F3; Check for Updates</button>
                    <button class="btn" id="btn-import">Import</button>
                    <button class="btn" id="btn-export">Export</button>
                </div>
            </div>
            <main id="script-list" class="script-grid"></main>
        `;
        bindPageEvents(page);
        render();
    }
}

function bindPageEvents(page) {
    // Filter tabs
    page.querySelectorAll('.tab[data-tab]').forEach(el => {
        el.addEventListener('click', () => {
            activeEditor = null;
            filterTab(el.dataset.tab);
            renderPage();
        });
    });
    // Editor script tabs
    page.querySelectorAll('.editor-script-tab').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.classList.contains('tab-close')) return;
            // Save current before switching
            const codeEl = document.getElementById('editor-textarea');
            const cur = openEditors.find(x => x.id === activeEditor);
            if (cur && codeEl) cur.code = codeEl.value;
            activeEditor = el.dataset.editorId;
            renderPage();
        });
    });
    // Tab close buttons
    page.querySelectorAll('.tab-close').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            closeEditor(el.dataset.closeId);
        });
    });
    // Save button
    page.querySelector('#editor-save')?.addEventListener('click', saveActiveEditor);

    // Variables panel
    page.querySelector('#var-add')?.addEventListener('click', () => {
        const ed = openEditors.find(e => e.id === activeEditor);
        if (!ed) return;
        ed.envRows = ed.envRows || [];
        ed.envRows.push({ key: '', value: '' });
        ed.dirty = true;
        const rows = document.getElementById('var-rows');
        if (rows) rows.innerHTML = renderVarRows(ed);
    });
    page.querySelector('#var-rows')?.addEventListener('input', (e) => {
        const ed = openEditors.find(x => x.id === activeEditor);
        if (!ed || e.target.dataset.idx === undefined) return;
        const idx = Number(e.target.dataset.idx);
        if (!ed.envRows[idx]) return;
        if (e.target.classList.contains('var-key')) ed.envRows[idx].key = e.target.value;
        if (e.target.classList.contains('var-value')) ed.envRows[idx].value = e.target.value;
        ed.dirty = true;
    });
    page.querySelector('#var-rows')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-remove-var]');
        if (!btn) return;
        const ed = openEditors.find(x => x.id === activeEditor);
        if (!ed) return;
        ed.envRows.splice(Number(btn.dataset.removeVar), 1);
        ed.dirty = true;
        const rows = document.getElementById('var-rows');
        if (rows) rows.innerHTML = renderVarRows(ed);
    });

    // Dependencies panel
    page.querySelector('#dep-rows')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-check-dep]');
        if (!btn) return;
        const req = btn.dataset.checkDep;
        const [kind, name] = req.split(':');
        const resultSpan = page.querySelector(`[data-result-for="${CSS.escape(req)}"]`);
        if (resultSpan) { resultSpan.textContent = 'Checking...'; resultSpan.style.color = 'var(--dim)'; }
        if (!companionOnline) { if (resultSpan) resultSpan.textContent = 'Companion offline'; return; }
        try {
            const res = await SBCompanion.fetch(`/api/check-dep?kind=${encodeURIComponent(kind || '')}&name=${encodeURIComponent(name || '')}`);
            const data = await res.json();
            if (resultSpan) {
                resultSpan.textContent = data.ok ? '\u2713 found' : '\u2717 missing';
                resultSpan.style.color = data.ok ? 'var(--green)' : 'var(--red)';
                resultSpan.title = data.output || '';
            }
        } catch (err) {
            if (resultSpan) resultSpan.textContent = 'Error: ' + err.message;
        }
    });
    // Select all checkbox
    page.querySelector('#select-all-cb')?.addEventListener('change', (e) => {
        const checked = e.target.checked;
        const visible = getVisibleScripts();
        if (checked) {
            visible.forEach(s => selectedScripts.add(s.id));
        } else {
            // Only deselect visible ones (keep non-visible selections intact)
            visible.forEach(s => selectedScripts.delete(s.id));
        }
        updateBulkBar();
        // Update only visible checkboxes
        const visibleIds = new Set(visible.map(s => s.id));
        page.querySelectorAll('.script-select-cb').forEach(cb => {
            if (visibleIds.has(cb.dataset.selectId)) cb.checked = checked;
        });
    });

    // Selection checkboxes (delegation)
    page.querySelector('#script-list')?.addEventListener('change', (e) => {
        const cb = e.target.closest('.script-select-cb');
        if (cb) {
            const id = cb.dataset.selectId;
            if (cb.checked) selectedScripts.add(id);
            else selectedScripts.delete(id);
            updateBulkBar();
            syncSelectAllCheckbox();
            return;
        }
        const toggle = e.target.closest('[data-action="toggle"]');
        if (toggle) toggleScript(toggle.dataset.id);
    });
    // Bulk actions dropdown
    page.querySelector('#bulk-actions')?.addEventListener('change', (e) => {
        const action = e.target.value;
        if (action) executeBulkAction(action);
        e.target.value = '';
    });

    // Search
    page.querySelector('#search-input')?.addEventListener('input', onSearchInput);
    page.querySelector('#filter-language')?.addEventListener('change', onFilterChange);
    page.querySelector('#filter-status')?.addEventListener('change', onFilterChange);
    page.querySelector('#filter-tag')?.addEventListener('change', onFilterChange);
    page.querySelector('#filter-sort')?.addEventListener('change', onFilterChange);
    page.querySelector('#filter-clear')?.addEventListener('click', clearAllFilters);
    populateTagFilter();
    applyFilters();
    page.querySelector('#btn-check-updates')?.addEventListener('click', checkUpdatesManual);
    page.querySelector('#btn-import')?.addEventListener('click', importScripts);
    page.querySelector('#btn-export')?.addEventListener('click', exportScripts);
    // Script list delegation
    page.querySelector('#script-list')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (btn.dataset.action === 'edit') editScript(btn.dataset.id);
        else if (btn.dataset.action === 'run') runScript(btn.dataset.id);
        else if (btn.dataset.action === 'delete') deleteScript(btn.dataset.id);
        else if (btn.dataset.action === 'update') updateScript(btn.dataset.id);
        else if (btn.dataset.action === 'revert') revertScript(btn.dataset.id);
    });
    // (toggle handled in selection change listener above)
    // Editor textarea events
    const textarea = page.querySelector('#editor-textarea');
    if (textarea) {
        textarea.addEventListener('input', () => {
            updateEditorLines(true);
            const ed = openEditors.find(e => e.id === activeEditor);
            if (ed) {
                ed.dirty = true;
                ed.code = textarea.value;
                const depRows = document.getElementById('dep-rows');
                if (depRows) depRows.innerHTML = renderDepRows(ed);
            }
        });
        textarea.addEventListener('scroll', () => {
            const nums = document.getElementById('editor-line-nums');
            if (nums) nums.scrollTop = textarea.scrollTop;
            const pre = document.getElementById('editor-highlight');
            if (pre) { pre.scrollTop = textarea.scrollTop; pre.scrollLeft = textarea.scrollLeft; }
        });
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = textarea.selectionStart;
                textarea.value = textarea.value.substring(0, start) + '    ' + textarea.value.substring(textarea.selectionEnd);
                textarea.selectionStart = textarea.selectionEnd = start + 4;
                updateEditorLines();
            }
        });
        textarea.focus();
    }
}

function updateEditorLines() {
    const textarea = document.getElementById('editor-textarea');
    const nums = document.getElementById('editor-line-nums');
    if (!textarea || !nums) return;
    const count = textarea.value.split('\n').length;
    nums.innerText = Array.from({length: count}, (_, i) => i + 1).join('\n');
    updateHighlight();
}

function updateHighlight() {
    const textarea = document.getElementById('editor-textarea');
    const pre = document.getElementById('editor-highlight');
    if (!textarea || !pre) return;
    const codeEl = pre.querySelector('code');
    if (!codeEl) return;
    const code = textarea.value;
    if (!code) { codeEl.innerHTML = ''; return; }
    // Determine language from current editor metadata
    const ed = openEditors.find(e => e.id === activeEditor);
    const lang = ed ? (parseMetaFromCode(ed.code || '').language || 'javascript') : 'javascript';
    // Use hljs if available, otherwise plain escaped text
    if (typeof hljs !== 'undefined') {
        try {
            var langMap = {javascript:'javascript',typescript:'typescript',python:'python',rust:'rust',c:'c',sql:'sql',vbscript:'vbnet',shell:'bash',cmd:'dos',powershell:'powershell'};
            var result = hljs.highlight(code, {language: langMap[lang] || 'javascript', ignoreIllegals: true});
            codeEl.innerHTML = result.value;
        } catch(e) {
            codeEl.textContent = code;
        }
    } else {
        codeEl.textContent = code;
    }
    // Sync scroll
    pre.scrollTop = textarea.scrollTop;
    pre.scrollLeft = textarea.scrollLeft;
}

// ============ SCHEDULE & CHAIN STATUS ============

async function loadScheduleStatus() {
    scheduledScriptIds.clear();
    if (!companionOnline) return;
    try {
        const res = await SBCompanion.fetch('/api/schedules', { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
            const schedules = await res.json();
            schedules.forEach(sc => scheduledScriptIds.add(sc.script_id));
        }
    } catch {}
}

function loadChainData() {
    // Chains are stored on the script object as chain_group (set via bulk action or manually)
    scriptChains = {};
    scripts.forEach(s => {
        if (s.chain_group) scriptChains[s.id] = s.chain_group;
    });
}

function getChainName(scriptId) {
    return scriptChains[scriptId] || '';
}

// ============ BULK ACTIONS ============

// Returns only the scripts currently visible (respects tab filter + search + dropdown filters)
function getVisibleScripts() {
    let filtered = scripts;
    if (currentFilter === 'browser') filtered = filtered.filter(s => s.category === 'browser');
    if (currentFilter === 'external') filtered = filtered.filter(s => s.category === 'external');
    if (!companionOnline) filtered = filtered.filter(s => s.category !== 'external');

    // Dropdown filters
    const langFilter = document.getElementById('filter-language')?.value;
    const statusFilter = document.getElementById('filter-status')?.value;
    const tagFilter = document.getElementById('filter-tag')?.value;

    if (langFilter) filtered = filtered.filter(s => (s.language || 'javascript') === langFilter);
    if (statusFilter === 'enabled') filtered = filtered.filter(s => s.enabled);
    if (statusFilter === 'disabled') filtered = filtered.filter(s => !s.enabled);
    if (tagFilter) filtered = filtered.filter(s => (s.tags || []).includes(tagFilter));

    // Text search (supports prefixes: lang:, status:, tag:, author:)
    const searchInput = document.getElementById('search-input');
    let q = searchInput ? searchInput.value.trim().toLowerCase() : '';
    if (q) {
        // Parse prefixed filters from search query
        const prefixFilters = [];
        q = q.replace(/(\w+):(\S+)/g, (match, key, val) => {
            prefixFilters.push({ key, val });
            return '';
        }).trim();

        for (const pf of prefixFilters) {
            if (pf.key === 'lang' || pf.key === 'language') filtered = filtered.filter(s => (s.language||'javascript').includes(pf.val));
            else if (pf.key === 'status') filtered = filtered.filter(s => pf.val === 'enabled' ? s.enabled : !s.enabled);
            else if (pf.key === 'tag') filtered = filtered.filter(s => (s.tags||[]).some(t => t.toLowerCase().includes(pf.val)));
            else if (pf.key === 'author') filtered = filtered.filter(s => { const m = parseMetaFromCode(s.code||''); return (m.author||'').toLowerCase().includes(pf.val); });
            else if (pf.key === 'version' || pf.key === 'ver') filtered = filtered.filter(s => (s.version||'').includes(pf.val));
        }

        // Remaining free-text search
        if (q) {
            const isRegex = document.getElementById('search-regex')?.checked;
            let re;
            if (isRegex) { try { re = new RegExp(q, 'i'); } catch {} }
            filtered = filtered.filter(s => {
                if (re) return re.test(s.name) || re.test(s.description||'') || re.test(s.code);
                return s.name.toLowerCase().includes(q) || (s.description||'').toLowerCase().includes(q) || s.code.toLowerCase().includes(q) || (s.tags||[]).some(t => t.toLowerCase().includes(q));
            });
        }
    }

    // Sort
    const sortBy = document.getElementById('filter-sort')?.value || 'order';
    if (sortBy === 'name') filtered = filtered.slice().sort((a,b) => (a.name||'').localeCompare(b.name||''));
    else if (sortBy === 'name-desc') filtered = filtered.slice().sort((a,b) => (b.name||'').localeCompare(a.name||''));
    else if (sortBy === 'updated') filtered = filtered.slice().sort((a,b) => (b.updated_at||'').localeCompare(a.updated_at||''));
    else if (sortBy === 'size') filtered = filtered.slice().sort((a,b) => (b.code||'').length - (a.code||'').length);
    else if (sortBy === 'size-asc') filtered = filtered.slice().sort((a,b) => (a.code||'').length - (b.code||'').length);
    else filtered = filtered.slice().sort((a,b) => (a.order||0) - (b.order||0));

    return filtered;
}

function syncSelectAllCheckbox() {
    const selectAllCb = document.getElementById('select-all-cb');
    if (!selectAllCb) return;
    const visible = getVisibleScripts();
    const allSelected = visible.length > 0 && visible.every(s => selectedScripts.has(s.id));
    selectAllCb.checked = allSelected;
}

function updateBulkBar() {
    const countEl = document.getElementById('selection-count');
    const bulkEl = document.getElementById('bulk-actions');
    if (!countEl || !bulkEl) return;
    if (selectedScripts.size > 0) {
        countEl.style.display = '';
        countEl.textContent = `${selectedScripts.size} selected`;
        bulkEl.style.display = '';
    } else {
        countEl.style.display = 'none';
        bulkEl.style.display = 'none';
    }
}

async function executeBulkAction(action) {
    const ids = [...selectedScripts];
    if (ids.length === 0) return;

    switch (action) {
        case 'toggle':
            for (const id of ids) {
                const s = scripts.find(x => x.id === id);
                if (s) { s.enabled = !s.enabled; s.updated_at = new Date().toISOString(); }
            }
            await send({ action: 'saveScripts', scripts });
            renderPage();
            break;
        case 'addtag': {
            const tag = prompt('Enter tag to add to selected scripts:');
            if (!tag) return;
            for (const id of ids) {
                const s = scripts.find(x => x.id === id);
                if (s) {
                    s.tags = s.tags || [];
                    if (!s.tags.includes(tag.trim())) s.tags.push(tag.trim());
                    s.updated_at = new Date().toISOString();
                }
            }
            await send({ action: 'saveScripts', scripts });
            renderPage();
            break;
        }
        case 'removetag': {
            // Collect all tags from selected scripts
            const allTags = new Set();
            for (const id of ids) {
                const s = scripts.find(x => x.id === id);
                if (s?.tags) s.tags.forEach(t => allTags.add(t));
            }
            if (allTags.size === 0) { alert('Selected scripts have no tags.'); return; }
            const tag = prompt(`Remove which tag?\nAvailable: ${[...allTags].join(', ')}`);
            if (!tag) return;
            for (const id of ids) {
                const s = scripts.find(x => x.id === id);
                if (s?.tags) { s.tags = s.tags.filter(t => t !== tag.trim()); s.updated_at = new Date().toISOString(); }
            }
            await send({ action: 'saveScripts', scripts });
            renderPage();
            break;
        }
        case 'export': {
            const selected = scripts.filter(s => ids.includes(s.id));
            const data = { version: '3.0.0', exported_at: new Date().toISOString(), script_count: selected.length, scripts: selected };
            const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url;
            a.download = `scriptbridge-selected-${new Date().toISOString().slice(0,10)}.json`;
            a.click(); URL.revokeObjectURL(url);
            break;
        }
        case 'chain': {
            if (!companionOnline) { alert('Companion is offline. Start ScriptBridge.exe to chain external scripts.'); return; }
            const chainable = ids.map(id => scripts.find(s => s.id === id)).filter(s => s && s.category === 'external' && s.enabled);
            if (chainable.length === 0) { alert('Select external (companion) scripts to chain.'); return; }
            try {
                for (const s of chainable) {
                    const syncBody = { id: s.id, name: s.name || 'Untitled', description: s.description || '', language: s.language || 'python', category: 'external', code: s.code, match_patterns: [], run_at: '', trigger: 'manual', tags: s.tags || [], env_vars: s.env_vars || {} };
                    let response = await SBCompanion.fetch('/api/scripts/' + encodeURIComponent(s.id), { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(syncBody) });
                    if (response.status === 404) response = await SBCompanion.fetch('/api/scripts', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(syncBody) });
                    if (!response.ok) throw new Error('Script synchronization failed');
                }
            } catch {
                alert('Could not sync the selected scripts. Nothing was run. Check pairing and script languages.');
                break;
            }
            const modal = document.getElementById('run-modal');
            modal.classList.remove('hidden');
            document.getElementById('run-status').innerHTML = '<span style="color:var(--orange)">Running chain of ' + chainable.length + ' scripts...</span>';
            document.getElementById('run-stdout').textContent = '';
            document.getElementById('run-stderr').textContent = '';
            try {
                const res = await SBCompanion.fetch('/api/chain', {
                    method: 'POST', headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({ script_ids: chainable.map(s => s.id) })
                });
                if (!res.ok) throw new Error('Chain request failed: ' + res.status);
                const data = await res.json();
                const results = data.results || [];
                const failed = results.find(r => (r.exit_code !== undefined && r.exit_code !== 0) || r.error);
                document.getElementById('run-status').innerHTML = failed
                    ? '<span style="color:var(--red)">Stopped after failure</span>'
                    : '<span style="color:var(--green)">Chain completed</span>';
                document.getElementById('run-stdout').textContent = results.map(r =>
                    `--- ${r.script_name || r.script_id} ---\n${r.error ? 'ERROR: ' + r.error : (r.stdout || '(no output)') + (r.exit_code !== 0 ? '\n[exit ' + r.exit_code + ']' : '')}`
                ).join('\n\n');
            } catch(e) {
                document.getElementById('run-status').innerHTML = '<span style="color:var(--red)">Error</span>';
                document.getElementById('run-stderr').textContent = e.message;
            }
            break;
        }
        case 'savechain': {
            const chainName = prompt('Chain group name:', 'Chain 1');
            if (!chainName) return;
            for (const id of ids) {
                const s = scripts.find(x => x.id === id);
                if (s) s.chain_group = chainName;
            }
            await send({ action: 'saveScripts', scripts });
            loadChainData();
            renderPage();
            showToast(`${ids.length} scripts added to chain "${chainName}"`);
            break;
        }
        case 'unchain':
            for (const id of ids) {
                const s = scripts.find(x => x.id === id);
                if (s) delete s.chain_group;
            }
            await send({ action: 'saveScripts', scripts });
            loadChainData();
            renderPage();
            showToast('Removed from chain');
            break;
        case 'delete':
            if (!confirm(`Delete ${ids.length} selected scripts? This cannot be undone.`)) return;
            scripts = scripts.filter(s => !ids.includes(s.id));
            selectedScripts.clear();
            await send({ action: 'saveScripts', scripts });
            renderPage();
            break;
    }
    selectedScripts.clear();
    updateBulkBar();
}

// ============ CRUD ============
function showCreateModal() {
    openScriptEditor(null);
}

function editScript(id) {
    const s = scripts.find(x => x.id === id);
    if (!s) return;
    openScriptEditor(s);
}

function closeModal() { document.getElementById('modal').classList.add('hidden'); }
function closeRunModal() { document.getElementById('run-modal').classList.add('hidden'); }

function onLanguageChange() {
    const lang = document.getElementById('script-language').value;
    if (lang !== 'javascript') {
        document.getElementById('script-category').value = 'external';
        onCategoryChange();
    }
}

function onCategoryChange() {
    const cat = document.getElementById('script-category').value;
    document.getElementById('browser-options').classList.toggle('hidden', cat !== 'browser');
    document.getElementById('external-options').classList.toggle('hidden', cat !== 'external');
}

async function saveScript(e) {
    e.preventDefault();
    const id = document.getElementById('script-id').value;
    const data = {
        name: document.getElementById('script-name').value,
        description: document.getElementById('script-desc').value,
        language: document.getElementById('script-language').value,
        category: document.getElementById('script-category').value,
        code: document.getElementById('script-code').value,
        match_patterns: document.getElementById('script-patterns').value.split('\n').filter(Boolean),
        run_at: document.getElementById('script-runat').value,
        trigger: document.getElementById('script-trigger').value,
        tags: document.getElementById('script-tags').value.split(',').map(t => t.trim()).filter(Boolean),
        enabled: true,
    };

    if (id) {
        const idx = scripts.findIndex(s => s.id === id);
        if (idx >= 0) {
            scripts[idx] = { ...scripts[idx], ...data, updated_at: new Date().toISOString() };
        }
    } else {
        scripts.push({
            id: crypto.randomUUID(),
            ...data,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        });
    }

    await send({ action: 'saveScripts', scripts });
    closeModal();
    render();
}

async function deleteScript(id) {
    if (!confirm('Delete this script?')) return;
    scripts = scripts.filter(s => s.id !== id);
    await send({ action: 'saveScripts', scripts });
    render();
}

async function toggleScript(id) {
    const s = scripts.find(x => x.id === id);
    if (s) {
        s.enabled = !s.enabled;
        s.updated_at = new Date().toISOString();
        await send({ action: 'saveScripts', scripts });
    }
}

async function runScript(id) {
    const candidate = scripts.find(s => s.id === id);
    if (!candidate || !candidate.enabled || candidate.category !== 'external') { alert('Review and enable this external script before running it.'); return; }
    if (!companionOnline) { alert('Companion is offline. Start ScriptBridge.exe to run external scripts.'); return; }
    const modal = document.getElementById('run-modal');
    modal.classList.remove('hidden');
    document.getElementById('run-status').innerHTML = '<span style="color:var(--orange)">Running...</span>';
    document.getElementById('run-stdout').textContent = '';
    document.getElementById('run-stderr').textContent = '';

    const script = scripts.find(s => s.id === id);
    if (!script) return;

    try {
        // Sync to companion: try PUT (update), fall back to POST (create)
        const syncBody = {
            name: script.name || 'Untitled',
            description: script.description || '',
            language: script.language || 'python',
            category: 'external',
            code: script.code,
            match_patterns: [],
            run_at: '',
            trigger: script.trigger || 'manual',
            tags: script.tags || [],
            env_vars: script.env_vars || {}
        };

        let syncRes = await SBCompanion.fetch('/api/scripts/' + encodeURIComponent(script.id), {
            method: 'PUT',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify(syncBody)
        });
        if (syncRes.status === 404) {
            syncBody.id = script.id;
            syncRes = await SBCompanion.fetch('/api/scripts', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify(syncBody)
            });
        }

        if (!syncRes.ok) throw new Error('Script synchronization failed: ' + syncRes.status);

        // Run it with live output streaming (SSE)
        const streamRes = await SBCompanion.fetch('/api/scripts/' + encodeURIComponent(script.id) + '/stream', { method: 'POST' });
        if (!streamRes.ok || !streamRes.body) throw new Error('Companion returned ' + streamRes.status);

        const reader = streamRes.body.getReader();
        const decoder = new TextDecoder();
        let buf = '', stdout = '', stderr = '', exitCode = null;
        const startTime = performance.now();
        document.getElementById('run-status').innerHTML = '<span style="color:var(--orange)">Running (live)...</span>';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
                const rawEvent = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                const dataLine = rawEvent.split('\n').find(l => l.startsWith('data:'));
                if (!dataLine) continue;
                const payload = dataLine.slice(5).replace(/^ /, '');
                if (rawEvent.startsWith('event: error')) {
                    stderr += payload + '\n';
                    document.getElementById('run-stderr').textContent = stderr;
                    continue;
                }
                if (payload.startsWith('OUT|')) {
                    stdout += payload.slice(4) + '\n';
                    document.getElementById('run-stdout').textContent = stdout;
                } else if (payload.startsWith('ERR|')) {
                    stderr += payload.slice(4) + '\n';
                    document.getElementById('run-stderr').textContent = stderr;
                } else if (payload.startsWith('DONE|')) {
                    exitCode = parseInt(payload.slice(5), 10);
                }
            }
        }

        const duration = Math.round(performance.now() - startTime);
        const color = exitCode === 0 ? 'var(--green)' : 'var(--red)';
        document.getElementById('run-status').innerHTML = '<span style="color:' + color + '">Exit: ' + (exitCode ?? '?') + '</span> <span style="color:var(--dim)">' + duration + 'ms</span>';
        if (!stdout) document.getElementById('run-stdout').textContent = '(no output)';
    } catch(e) {
        document.getElementById('run-status').innerHTML = '<span style="color:var(--red)">Error</span>';
        document.getElementById('run-stderr').textContent = e.message;
    }
}

// ============ SEARCH ============
let searchTimeout = null;
function onSearchInput() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => { applyFilters(); }, 200);
}

function onFilterChange() {
    applyFilters();
}

function applyFilters() {
    const visible = getVisibleScripts();
    const el = document.getElementById('script-list');
    
    // Update filter count
    const countEl = document.getElementById('filter-count');
    if (countEl) {
        const hasFilters = document.getElementById('filter-language')?.value || document.getElementById('filter-status')?.value || document.getElementById('filter-tag')?.value || document.getElementById('search-input')?.value.trim();
        countEl.textContent = hasFilters ? `Showing ${visible.length} of ${scripts.length}` : `${scripts.length} scripts`;
    }
    
    // Show/hide clear button
    const clearBtn = document.getElementById('filter-clear');
    if (clearBtn) {
        const active = document.getElementById('filter-language')?.value || document.getElementById('filter-status')?.value || document.getElementById('filter-tag')?.value || document.getElementById('search-input')?.value.trim();
        clearBtn.style.display = active ? ''  : 'none';
    }

    if (visible.length === 0) { 
        el.innerHTML = '<div class="empty-state"><h3>No matches</h3><p>Try adjusting your filters</p></div>'; 
        return; 
    }
    // Render with filtered list
    const backup = scripts;
    scripts = visible;
    render();
    scripts = backup;
}

function clearAllFilters() {
    const langSel = document.getElementById('filter-language');
    const statusSel = document.getElementById('filter-status');
    const tagSel = document.getElementById('filter-tag');
    const sortSel = document.getElementById('filter-sort');
    const searchInput = document.getElementById('search-input');
    if (langSel) langSel.value = '';
    if (statusSel) statusSel.value = '';
    if (tagSel) tagSel.value = '';
    if (sortSel) sortSel.value = 'order';
    if (searchInput) searchInput.value = '';
    applyFilters();
}

function populateTagFilter() {
    const tagSel = document.getElementById('filter-tag');
    if (!tagSel) return;
    const allTags = new Set();
    scripts.forEach(s => (s.tags||[]).forEach(t => allTags.add(t)));
    const current = tagSel.value;
    tagSel.innerHTML = '<option value="">All Tags</option>' + [...allTags].sort().map(t => `<option value="${esc(t)}" ${t===current?'selected':''}>${esc(t)}</option>`).join('');
}

// ============ SCRIPT UPDATES ============
async function updateScript(id) {
    const btn = document.querySelector(`[data-action="update"][data-id="${id}"]`);
    if (btn) { btn.disabled = true; btn.textContent = 'Opening review...'; }
    try {
        await send({ action: 'openUpdateTab', id });
        showToast('Review the downloaded source before applying the update.');
    } catch (error) {
        alert('Update review failed: ' + error.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Review update'; }
    }
}

async function revertScript(id) {
    const script = scripts.find(s => s.id === id);
    if (!script || !script.previous_code) return;
    // Open revert confirmation page (similar to install/update page)
    const revertUrl = chrome.runtime.getURL('install.html') + '?revert=' + encodeURIComponent(id);
    chrome.tabs.create({ url: revertUrl });
}

async function checkUpdatesManual() {
    const btn = document.getElementById('btn-check-updates');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }
    scriptUpdates = await send({ action: 'checkForUpdates' }) || {};
    if (btn) { btn.disabled = false; btn.textContent = '⟳ Check for Updates'; }
    render();
    const count = Object.keys(scriptUpdates).length;
    showToast(count > 0 ? `${count} update${count > 1 ? 's' : ''} available` : 'All scripts up to date');
}

function showToast(msg) {
    let toast = document.getElementById('sb-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'sb-toast';
        toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:var(--green,#4caf50);color:#fff;padding:10px 20px;border-radius:6px;font-size:0.9rem;z-index:9999;opacity:0;transition:opacity 0.3s';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

// ============ IMPORT/EXPORT ============
async function exportScripts() {
    // Always fetch fresh from storage to avoid stale data
    const freshScripts = await send({ action: 'getScripts' }) || [];
    const data = { version: '3.0.0', exported_at: new Date().toISOString(), script_count: freshScripts.length, scripts: freshScripts };
    const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `scriptbridge-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
}

async function importScripts() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,.zip';
    input.onchange = async (e) => {
        const file = e.target.files[0]; if (!file) return;
        try {
            if (file.name.endsWith('.zip')) {
                await importTampermonkeyZip(file);
            } else {
                const data = JSON.parse(await file.text());
                const imported = data.scripts || data;
                if (!Array.isArray(imported)) { alert('Invalid JSON file'); return; }
                if (!confirm(`Import ${imported.length} scripts? External scripts will be disabled until you review and enable them.`)) return;
                for (const item of imported) { if (item && item.category === 'external') { item.enabled = false; item.trigger = 'manual'; delete item.chain_group; } }
                const overwrite = confirm('Overwrite existing scripts with matching IDs? Cancel keeps existing copies.');
                const merged = scripts.slice();
                for (const s of imported) {
                    const idx = merged.findIndex(x => x.id === s.id);
                    if (idx >= 0 && overwrite) merged[idx] = s;
                    else if (idx < 0) merged.push(s);
                }
                await send({ action: 'saveScripts', scripts: merged });
                scripts = await send({ action: 'getScripts' });
                renderPage();
                alert(`Imported ${imported.length} scripts`);
            }
        } catch(err) { alert('Import failed: ' + err.message); }
    };
    input.click();
}

async function importTampermonkeyZip(file) {
    // Use JSZip-like approach via browser's built-in zip handling isn't available,
    // so we use a lightweight unzip via ArrayBuffer parsing
    const arrayBuffer = await file.arrayBuffer();
    const entries = await parseZipEntries(arrayBuffer);
    
    const imported = [];
    for (const [name, data] of entries) {
        if (!name.endsWith('.user.js')) continue;
        const code = new TextDecoder().decode(data);
        
        // Parse metadata from the userscript header
        const meta = {};
        const headerMatch = code.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
        if (headerMatch) {
            const lines = headerMatch[1].split('\n');
            for (const line of lines) {
                const m = line.match(/\/\/\s*@(\S+)\s+(.*)/);
                if (m) {
                    const key = m[1], val = m[2].trim();
                    if (key === 'match' || key === 'include') {
                        meta.matches = meta.matches || [];
                        meta.matches.push(val);
                    } else {
                        meta[key] = val;
                    }
                }
            }
        }

        // Find corresponding options.json
        const baseName = name.replace('.user.js', '');
        const optionsEntry = entries.find(([n]) => n === baseName + '.options.json');
        let options = {};
        if (optionsEntry) {
            try { options = JSON.parse(new TextDecoder().decode(optionsEntry[1])); } catch {}
        }

        const script = {
            id: options?.meta?.uuid || crypto.randomUUID(),
            name: meta.name || baseName,
            description: meta.description || '',
            language: 'javascript',
            category: 'browser',
            code: code,
            enabled: options?.settings?.enabled !== false,
            match_patterns: meta.matches || (options?.options?.override?.orig_matches) || ['*://*/*'],
            run_at: meta['run-at'] || options?.options?.override?.orig_run_at || 'document-idle',
            trigger: 'manual',
            tags: options?.options?.tags || [],
            created_at: new Date().toISOString(),
            updated_at: options?.meta?.modified ? new Date(options.meta.modified).toISOString() : new Date().toISOString(),
            version: meta.version || '',
        };
        imported.push(script);
    }

    if (imported.length === 0) {
        alert('No userscripts found in the zip file.');
        return;
    }

    if (!confirm(`Import ${imported.length} browser scripts from this backup? Review their code first.`)) return;
    const overwrite = confirm('Overwrite existing scripts with matching IDs or names? Cancel keeps existing copies.');
    const merged = scripts.slice();
    for (const s of imported) {
        const idx = merged.findIndex(x => x.id === s.id || x.name === s.name);
        if (idx >= 0 && overwrite) merged[idx] = s;
        else if (idx < 0) merged.push(s);
    }
    await send({ action: 'saveScripts', scripts: merged });
    scripts = await send({ action: 'getScripts' });
    renderPage();
    alert(`Imported ${imported.length} scripts from Tampermonkey backup`);
}

// ZIP parser using central directory (more reliable than local headers)
async function parseZipEntries(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const entries = [];
    
    // Find End of Central Directory record (scan backwards)
    let eocdOffset = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset < 0) return entries;
    
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const cdEntries = view.getUint16(eocdOffset + 10, true);
    
    // Read central directory
    let pos = cdOffset;
    const fileInfos = [];
    for (let i = 0; i < cdEntries && pos < bytes.length; i++) {
        if (view.getUint32(pos, true) !== 0x02014b50) break;
        const compression = view.getUint16(pos + 10, true);
        const compSize = view.getUint32(pos + 20, true);
        const uncompSize = view.getUint32(pos + 24, true);
        const nameLen = view.getUint16(pos + 28, true);
        const extraLen = view.getUint16(pos + 30, true);
        const commentLen = view.getUint16(pos + 32, true);
        const localHeaderOffset = view.getUint32(pos + 42, true);
        const name = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + nameLen));
        fileInfos.push({ name, compression, compSize, uncompSize, localHeaderOffset });
        pos += 46 + nameLen + extraLen + commentLen;
    }
    
    // Extract files from local headers
    for (const info of fileInfos) {
        const lh = info.localHeaderOffset;
        if (view.getUint32(lh, true) !== 0x04034b50) continue;
        const lhNameLen = view.getUint16(lh + 26, true);
        const lhExtraLen = view.getUint16(lh + 28, true);
        const dataStart = lh + 30 + lhNameLen + lhExtraLen;
        const rawData = bytes.slice(dataStart, dataStart + info.compSize);
        
        if (info.compression === 0) {
            entries.push([info.name, rawData]);
        } else if (info.compression === 8) {
            try {
                const ds = new DecompressionStream('deflate-raw');
                const writer = ds.writable.getWriter();
                const reader = ds.readable.getReader();
                writer.write(rawData);
                writer.close();
                const chunks = [];
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                }
                const totalLen = chunks.reduce((a, c) => a + c.length, 0);
                const result = new Uint8Array(totalLen);
                let p = 0;
                for (const chunk of chunks) { result.set(chunk, p); p += chunk.length; }
                entries.push([info.name, result]);
            } catch (e) {
                console.warn('Decompress failed:', info.name, e);
            }
        }
    }
    return entries;
}

// (moved to DOMContentLoaded)

// (moved to DOMContentLoaded)

// ============ COMPANION PAGE ============
function renderCompanionPage() {
    const container = document.getElementById('companion-container');
    container.innerHTML = `
        <div style="max-width:720px;margin:32px auto;padding:0 20px">
            <h2>Companion App</h2>
            <p id="pair-status" role="status">${companionOnline ? 'Connected and authenticated' : 'Not connected: start the companion and pair this extension'}</p>
            <section style="padding:20px;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin:20px 0">
                <h3>Pair this extension</h3>
                <p>The companion only accepts its paired extension and authenticated local tools. Start your newly built companion, then open <code>%USERPROFILE%\\.scriptbridge\\pairing.json</code> locally and copy only the <code>token</code> value below. Never paste it into a website, chat, script or export.</p>
                <label for="companion-token">Local pairing token</label>
                <input type="password" id="companion-token" autocomplete="off" spellcheck="false" maxlength="64" placeholder="64-character local token" class="search-box" style="display:block;width:100%;margin:12px 0">
                <button class="btn btn-primary" id="btn-pair-companion">Pair Companion</button>
                <button class="btn" id="btn-check-companion">Check Connection</button>
                <button class="btn" id="btn-forget-companion">Forget Local Token</button>
                <p id="pair-feedback" role="status" aria-live="polite"></p>
                <p class="dim">Forgetting removes this browser's token, not the companion's pairing. To revoke or change the paired extension, stop the companion, delete pairing.json locally and restart it, then pair again. Schedules require review after a pairing reset.</p>
            </section>
            <p><strong>External scripts are not sandboxed.</strong> They run with your Windows account's permissions. Web pages cannot trigger them. Use the dashboard Run button or an explicit context-menu action; schedules must be created here. Browser userscripts still run in the page's MAIN world and share its trust level.</p>
            ${companionOnline ? `
                <button class="btn" id="btn-sync-companion">Sync External Scripts</button>
                <h3>Language Toolchain</h3><div id="toolchain-list"></div>
                <h3>Scheduled Scripts</h3><div id="schedule-list"></div>
                <div style="display:flex;gap:8px;margin:12px 0">
                    <select id="sched-script-select" class="search-box"></select>
                    <input type="number" id="sched-interval" class="search-box" min="5" value="60" aria-label="Schedule interval in seconds">
                    <button class="btn btn-primary" id="btn-add-schedule">Add Schedule</button>
                </div>
                <h3>Execution History</h3><div id="history-list"></div>
            ` : ''}
        </div>`;
    if (companionOnline) { loadToolchainUI(); loadScheduleUI(); loadHistoryUI(); }
}

async function pairCompanionFromUI() {
    const field = document.getElementById('companion-token');
    const button = document.getElementById('btn-pair-companion');
    const feedback = document.getElementById('pair-feedback');
    const token = field.value.trim();
    field.value = '';
    button.disabled = true;
    feedback.textContent = 'Pairing...';
    try {
        await SBCompanion.pair(token);
        await checkCompanionNow();
        document.getElementById('pair-feedback').textContent = 'Pairing saved. Connection checked.';
    } catch {
        feedback.textContent = 'Pairing failed. Check the local token, companion process and existing extension pairing. Your previous pairing, if any, was not replaced.';
    } finally {
        button.disabled = false;
    }
}

async function forgetCompanionFromUI() {
    await SBCompanion.forget();
    await checkCompanionNow();
    document.getElementById('pair-feedback').textContent = 'Local token removed. Companion-side revocation requires resetting pairing.json with the companion stopped.';
}

async function loadToolchainUI(containerId) {
    const container = document.getElementById(containerId || 'toolchain-list');
    if (!container) return;
    try {
        const response = await SBCompanion.fetch('/api/toolchain');
        if (!response.ok) throw new Error('Toolchain check failed');
        const tools = await response.json();
        container.innerHTML = Object.entries(tools).map(([name, info]) =>
            `<p><strong>${esc(name)}</strong>: ${info.installed ? esc(info.version || 'installed') : 'not found on PATH'}</p>`).join('');
    } catch {
        container.textContent = 'Toolchain check unavailable. Start and pair the companion first.';
    }
}

async function loadScheduleUI() {
    const selectEl = document.getElementById('sched-script-select');
    const listEl = document.getElementById('schedule-list');
    if (!selectEl || !listEl) return;

    const externals = scripts.filter(s => s.category === 'external' && s.enabled);
    selectEl.innerHTML = externals.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('') || '<option value="">No external scripts</option>';

    try {
        const res = await SBCompanion.fetch('/api/schedules');
        const schedules = await res.json();
        if (schedules.length === 0) {
            listEl.innerHTML = '<p class="dim" style="font-size:0.82rem">No scheduled scripts.</p>';
        } else {
            listEl.innerHTML = schedules.map(sc => {
                const script = scripts.find(s => s.id === sc.script_id);
                return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--bg);border-radius:6px;margin-bottom:6px;font-size:0.82rem">
                    <span>${esc(script ? script.name : sc.script_id)} <span class="dim">every ${esc(sc.interval_secs)}s${sc.last_run ? ', last run ' + new Date(sc.last_run).toLocaleTimeString() : ''}</span></span>
                    <button class="btn btn-danger btn-sm" data-delete-schedule="${esc(sc.id)}">Remove</button>
                </div>`;
            }).join('');
            listEl.querySelectorAll('[data-delete-schedule]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    await SBCompanion.fetch('/api/schedules/' + encodeURIComponent(btn.dataset.deleteSchedule), { method: 'DELETE' });
                    loadScheduleUI();
                    await loadScheduleStatus();
                });
            });
        }
    } catch(e) {
        listEl.innerHTML = '<p class="dim" style="font-size:0.82rem">Could not load schedules.</p>';
    }

    document.getElementById('btn-add-schedule')?.addEventListener('click', async () => {
        const scriptId = selectEl.value;
        const interval = Math.max(5, parseInt(document.getElementById('sched-interval').value, 10) || 60);
        if (!scriptId) { alert('No external script selected'); return; }
        try {
            const response = await SBCompanion.fetch('/api/schedules', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ script_id: scriptId, interval_secs: interval })
            });
            if (!response.ok) throw new Error('Schedule creation failed');
            loadScheduleUI();
            await loadScheduleStatus();
        } catch { alert('Could not schedule the script. Check pairing and sync reviewed external scripts first.'); }
    }, { once: true });
}

async function loadHistoryUI() {
    const listEl = document.getElementById('history-list');
    if (!listEl) return;
    try {
        const res = await SBCompanion.fetch('/api/history');
        const history = await res.json();
        if (history.length === 0) {
            listEl.innerHTML = '<p class="dim" style="font-size:0.82rem">No runs recorded yet.</p>';
            return;
        }
        listEl.innerHTML = history.slice(0, 25).map(h => {
            const color = h.exit_code === 0 ? 'var(--green)' : 'var(--red)';
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--bg);border-radius:6px;margin-bottom:6px;font-size:0.8rem">
                <span>${esc(h.script_name)}</span>
                <span class="dim">${new Date(h.started_at).toLocaleString()}</span>
                <span style="color:${color}">exit ${esc(h.exit_code)}</span>
                <span class="dim">${esc(h.duration_ms)}ms</span>
            </div>`;
        }).join('');
    } catch(e) {
        listEl.innerHTML = '<p class="dim" style="font-size:0.82rem">Could not load history.</p>';
    }
}

async function checkCompanionNow() {
    const { online } = await send({ action: 'checkCompanion' });
    companionOnline = online;
    updateCompanionIndicator();
    renderCompanionPage();
}

async function syncToCompanion() {
    const result = await send({ action: 'syncToCompanion' });
    alert(result.error || `Synced ${result.synced} external scripts to companion`);
}

// ============ SETTINGS PAGE ============
function renderSettingsPage() {
    const container = document.getElementById('settings-container');
    container.innerHTML = '<div class="settings-layout"><nav class="settings-nav" id="settings-nav"></nav><div class="settings-body" id="settings-body"></div></div>';
    loadAndRenderSettings();
}

async function loadAndRenderSettings() {
    const s = await send({ action: 'getSettings' }) || {};
    const nav = document.getElementById('settings-nav');
    const body = document.getElementById('settings-body');
    const secs = ['general','appearance','editor','userscripts','security','tags','notifications','advanced'];
    if (companionOnline) secs.splice(4, 0, 'external');

    nav.innerHTML = secs.map((sec,i) => `<a class="s-nav-item${i===0?' active':''}" data-section="${sec}">${sec[0].toUpperCase()+sec.slice(1)}</a>`).join('');
    nav.addEventListener('click', e => {
        const it = e.target.closest('.s-nav-item'); if(!it) return;
        nav.querySelectorAll('.s-nav-item').forEach(n=>n.classList.remove('active')); it.classList.add('active');
        body.querySelectorAll('.s-section').forEach(el=>el.classList.remove('active'));
        const t=body.querySelector('#ss-'+it.dataset.section); if(t) t.classList.add('active');
    });

    const chk=(id,l,h,v)=>`<div class="s-row"><div class="s-label"><span>${l}</span>${h?`<span class="s-hint">${h}</span>`:''}</div><label class="toggle-switch"><input type="checkbox" id="${id}" ${v?'checked':''}><span class="toggle-slider"></span></label></div>`;
    const sel=(id,l,h,opts,v)=>{const o=opts.map(x=>`<option value="${x[0]}" ${x[0]===v?'selected':''}>${x[1]}</option>`).join('');return `<div class="s-row"><div class="s-label"><span>${l}</span>${h?`<span class="s-hint">${h}</span>`:''}</div><select id="${id}">${o}</select></div>`;};
    const txt=(id,l,h,v,ph)=>`<div class="s-row"><div class="s-label"><span>${l}</span>${h?`<span class="s-hint">${h}</span>`:''}</div><input type="text" id="${id}" value="${esc(v||'')}" placeholder="${ph||''}"></div>`;
    const num=(id,l,h,v,mn,mx)=>`<div class="s-row"><div class="s-label"><span>${l}</span>${h?`<span class="s-hint">${h}</span>`:''}</div><input type="number" id="${id}" value="${esc(v||0)}" min="${mn||0}" max="${mx||9999}" style="width:90px"></div>`;
    const area=(id,l,h,v,r)=>`<div class="s-row" style="flex-direction:column;align-items:stretch"><div class="s-label"><span>${l}</span>${h?`<span class="s-hint">${h}</span>`:''}</div><textarea id="${id}" rows="${r||3}" class="code-editor" style="width:100%;margin-top:6px">${esc(v||'')}</textarea></div>`;
    const clr=(id,l,h,v)=>`<div class="s-row"><div class="s-label"><span>${l}</span>${h?`<span class="s-hint">${h}</span>`:''}</div><input type="color" id="${id}" value="${esc(v||'#6c8cff')}" style="width:44px;height:32px;padding:2px;cursor:pointer"></div>`;

    body.innerHTML = `
<section class="s-section active" id="ss-general"><h2>General</h2>
${sel('s-config-mode','Config Mode','Controls visible settings',[['beginner','Beginner'],['advanced','Advanced'],['expert','Expert']],s.config_mode||'advanced')}
${sel('s-language','Language','Interface language',[['browser','Browser Default'],['en','English'],['es','Spanish'],['fr','French'],['de','German'],['ja','Japanese']],s.language||'browser')}
${chk('s-auto-reload','Auto Reload Pages','Reload pages when scripts update',s.auto_reload!==false)}
${chk('s-debug','Debug Scripts','Verbose console logging',s.debug_scripts)}
${sel('s-log-level','Logging Level','Minimum severity',[['error','Error'],['warn','Warning'],['info','Info'],['debug','Debug']],s.log_level||'error')}
${chk('s-trash','Trash Mode','Move to trash instead of delete',s.trash_mode!==false)}
${sel('s-badge-info','Icon Badge','Badge counter shows',[['running','Running count'],['total','Total enabled'],['none','Hidden']],s.badge_info||'running')}
${clr('s-badge-color','Badge Color','Badge background',s.badge_color||'#ee3131')}
</section>
<section class="s-section" id="ss-appearance"><h2>Appearance</h2>
${sel('s-theme','Theme','Color scheme',[['dark','Dark'],['light','Light'],['system','System'],['midnight','Midnight Blue'],['monokai','Monokai']],s.theme||'dark')}
${sel('s-layout','Layout','Script list mode',[['grid','Grid (Cards)'],['list','List (Compact)'],['table','Table']],s.layout||'grid')}
${clr('s-accent','Accent Color','Primary UI color',s.accent_color||'#6c8cff')}
${sel('s-update-notify','Update Notifications','On script updates',[['changelog','Open changelog'],['badge','Badge only'],['none','Disabled']],s.update_notification||'changelog')}
${chk('s-hide-disabled','Hide Disabled Scripts','Hide in main list',s.hide_disabled)}
${area('s-custom-css','Custom CSS','Extra dashboard CSS',s.custom_css,4)}
</section>
<section class="s-section" id="ss-editor"><h2>Editor</h2>
${sel('s-editor-theme','Theme','Syntax highlighting',[['default','Default'],['monokai','Monokai'],['dracula','Dracula'],['github-dark','GitHub Dark'],['one-dark','One Dark'],['solarized','Solarized Dark']],s.editor_theme||'default')}
${sel('s-font-size','Font Size','',[['80','80%'],['90','90%'],['100','100%'],['110','110%'],['120','120%'],['140','140%']],s.editor_font_size||'100')}
${sel('s-font-family','Font Family','',[['cascadia','Cascadia Code'],['fira','Fira Code'],['jetbrains','JetBrains Mono'],['consolas','Consolas']],s.editor_font||'cascadia')}
${sel('s-keymap','Key Mapping','',[['default','Default'],['vim','Vim'],['emacs','Emacs'],['sublime','Sublime']],s.key_mapping||'default')}
${sel('s-indent-width','Indent Width','',[['2','2'],['4','4'],['8','8']],s.indent_width||'4')}
${sel('s-indent-type','Indent With','',[['spaces','Spaces'],['tabs','Tabs']],s.indent_type||'spaces')}
${chk('s-word-wrap','Word Wrap','',s.word_wrap!==false)}
${chk('s-line-numbers','Line Numbers','',s.line_numbers!==false)}
${chk('s-auto-brackets','Auto-close Brackets','',s.auto_brackets!==false)}
${chk('s-trim-ws','Trim Trailing Whitespace','On save',s.trim_whitespace!==false)}
${chk('s-auto-lint','Auto Syntax Check','Lint while typing',s.auto_lint!==false)}
${chk('s-save-blur','Save on Focus Loss','Auto-save on blur',s.save_on_blur)}
${chk('s-diff-on-save','Diff on Save','Show changes before overwriting',s.diff_on_save!==false)}
${chk('s-auto-check-deps','Auto-check Dependencies','Verify @require on open',s.auto_check_deps)}
</section>
<section class="s-section" id="ss-userscripts"><h2>Userscripts</h2>
${sel('s-update-interval','Update Interval','Check frequency',[['never','Never'],['daily','Every Day'],['weekly','Every Week'],['12h','Every 12 Hours']],s.update_interval||'daily')}
${sel('s-default-runat','Default @run-at','New script timing',[['document-idle','document-idle'],['document-start','document-start'],['document-end','document-end']],s.default_run_at||'document-idle')}
${sel('s-script-order','Script Order','Multiple matches',[['auto','Auto (creation date)'],['alpha','Alphabetical'],['manual','Manual (drag)']],s.script_order||'auto')}
${sel('s-template','New Script Template','Boilerplate',[['es6','ES6 (Modern)'],['es5','ES5 (Classic IIFE)'],['minimal','Minimal'],['custom','Custom']],s.script_template||'es6')}
${area('s-custom-template','Custom Template','When Custom selected',s.custom_template,6)}
</section>
${companionOnline ? `<section class="s-section" id="ss-external"><h2>External Scripts</h2>
<div style="margin-bottom:16px;padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border)">
<h4 style="margin:0 0 10px;font-size:0.88rem">Toolchain Status</h4>
<div id="settings-toolchain-list"><p class="dim" style="font-size:0.82rem">Checking...</p></div>
</div>
<p>External scripts run with your current Windows account, without a sandbox. Per-script environment values may change runtime behavior. There is no enforced execution timeout or process-memory/output limit, and closing the output window does not stop a script. Only run code you trust. Stop the companion and its child process in Task Manager if a script does not finish.</p>
<p>Compilation caching, the ten-second scheduler check and stop-on-error chains use fixed behavior. This page does not offer execution settings that the companion does not enforce.</p>
</section>` : ''}
<section class="s-section" id="ss-security"><h2>Security</h2>
<p id="security-boundary">Companion authentication is always required and cannot be disabled here. Pair from the Companion tab. Web-page requests for native execution, extension network access, notifications and extension storage are disabled.</p>
<p>Browser scripts run in the page's MAIN world, not a sandbox. GM values use the page's localStorage and are visible to the site. Do not store secrets in browser scripts or GM values.</p>
${area('s-blacklist','Page Blacklist','Do not auto-inject browser scripts on these URL patterns (one per line)',s.page_blacklist||'',4)}
</section>
<section class="s-section" id="ss-tags"><h2>Tags</h2>
${chk('s-tags-enabled','Enable Tags','Organize with tags',s.tags_enabled!==false)}
${txt('s-system-tags','System Tags','Comma-separated',(s.system_tags||['utilities','productivity','automation']).join(', '),'utilities, productivity')}
</section>
<section class="s-section" id="ss-notifications"><h2>Notifications</h2>
${sel('s-exec-notify','Execution Notifications','',[['errors','On errors only'],['always','Always'],['never','Never']],s.exec_notify||'errors')}
${chk('s-notify-updates','Update Notifications','On available updates',s.notify_updates!==false)}
${sel('s-notify-timeout','Auto-dismiss','',[['5','5 sec'],['10','10 sec'],['30','30 sec'],['0','Never']],s.notify_timeout||'10')}
${chk('s-sound','Sound on Completion','When scripts finish',s.sound_on_complete)}
</section>
<section class="s-section" id="ss-advanced"><h2>Advanced</h2>
${sel('s-strict','Strict Mode','',[['default','Default'],['always','Always'],['never','Never']],s.strict_mode||'default')}
${sel('s-top-await','Top-level Await','',[['default','Default'],['enabled','Enabled'],['disabled','Disabled']],s.top_level_await||'default')}
${num('s-max-concurrent','Concurrent Scripts','Max parallel',s.max_concurrent||4,0,32)}
${num('s-history-days','History (days)','Retention',s.history_days||30,1,365)}
${chk('s-backup-save','Backup on Save','Keep previous',s.backup_on_save!==false)}
${num('s-max-backups','Max Backups','Per script',s.max_backups||10,1,100)}
${sel('s-export-format','Export Format','',[['json','JSON'],['zip','ZIP'],['tampermonkey','Tampermonkey']],s.export_format||'json')}
${num('s-heartbeat','Heartbeat (sec)','Companion check',s.heartbeat_interval||30,5,300)}
<div class="s-row"><div class="s-label"><span>Reset All Settings</span><span class="s-hint">Restore defaults</span></div><button class="btn btn-danger" id="btn-reset-settings">Reset</button></div>
</section>
<div style="padding:20px 0"><button class="btn btn-primary" id="btn-save-settings">Save All Settings</button></div>`;
    if (companionOnline) loadToolchainUI('settings-toolchain-list');
}

async function saveSettingsFromUI() {
    const g=id=>document.getElementById(id),v=id=>g(id)?.value||'',c=id=>g(id)?.checked||false;
    const settings={config_mode:v('s-config-mode'),language:v('s-language'),auto_reload:c('s-auto-reload'),debug_scripts:c('s-debug'),log_level:v('s-log-level'),trash_mode:c('s-trash'),badge_info:v('s-badge-info'),badge_color:v('s-badge-color'),theme:v('s-theme'),layout:v('s-layout'),accent_color:v('s-accent'),update_notification:v('s-update-notify'),hide_disabled:c('s-hide-disabled'),custom_css:v('s-custom-css'),editor_theme:v('s-editor-theme'),editor_font_size:v('s-font-size'),editor_font:v('s-font-family'),key_mapping:v('s-keymap'),indent_width:v('s-indent-width'),indent_type:v('s-indent-type'),word_wrap:c('s-word-wrap'),line_numbers:c('s-line-numbers'),auto_brackets:c('s-auto-brackets'),trim_whitespace:c('s-trim-ws'),auto_lint:c('s-auto-lint'),save_on_blur:c('s-save-blur'),update_interval:v('s-update-interval'),default_run_at:v('s-default-runat'),script_order:v('s-script-order'),script_template:v('s-template'),custom_template:v('s-custom-template'),page_blacklist:v('s-blacklist'),tags_enabled:c('s-tags-enabled'),system_tags:v('s-system-tags').split(',').map(t=>t.trim()).filter(Boolean),exec_notify:v('s-exec-notify'),notify_updates:c('s-notify-updates'),notify_timeout:v('s-notify-timeout'),sound_on_complete:c('s-sound'),strict_mode:v('s-strict'),top_level_await:v('s-top-await'),max_concurrent:parseInt(v('s-max-concurrent'))||4,history_days:parseInt(v('s-history-days'))||30,backup_on_save:c('s-backup-save'),max_backups:parseInt(v('s-max-backups'))||10,export_format:v('s-export-format'),heartbeat_interval:parseInt(v('s-heartbeat'))||30};
    await send({ action: 'saveSettings', settings });
    currentLayout = settings.layout || 'table';
    alert('Settings saved');
}

// ============ GUIDE PAGE ============
function renderGuidePage() {
    document.getElementById('guide-container').innerHTML = `
    <article style="max-width:820px;margin:32px auto;padding:0 24px;line-height:1.75">
        <h2>ScriptBridge Guide</h2>
        <h3>Browser scripts</h3>
        <p>Create a browser script, review its code and select narrow URL match patterns. Enabled scripts are injected after the page completes loading. Stored run-at preferences do not change that timing. Scripts run in the page's MAIN world and are not isolated from site JavaScript; site CSP may prevent injection.</p>
        <h3>Pairing and local execution</h3>
        <p>Browser scripts work without the companion. To run local scripts, start the companion and pair it from this extension's Companion tab using the token in your local pairing.json. The companion binds only 127.0.0.1:9876. It requires authentication on every API call and only accepts its paired extension origin or authenticated local tools.</p>
        <p>Choose an external script in this dashboard and click Run. Native Python, Node.js, Rust and C require their tools on PATH; CMD and PowerShell use Windows tools. C uses gcc, not MSVC. External scripts have your user permissions and are not sandboxed. Review imported scripts and updates before executing them.</p>
        <h3>Security changes</h3>
        <p><strong>Page-triggered native execution is disabled.</strong> ScriptBridge.run/runById and page-to-extension messages no longer run local scripts. Privileged GM network requests, downloads and notifications are disabled. Use ordinary page APIs subject to the browser's security rules, or manually run a reviewed external script in the extension UI.</p>
        <p>GM sync and async storage are page-local compatibility helpers, visible to the site and shared on that origin. Never store secrets there. GM menu commands and resource functions remain unsupported. A userscript is not a trusted extension component.</p>
        <h3>Schedules and data</h3>
        <p>After pairing, sync reviewed external scripts and create schedules from the Companion tab. A schedule runs while the companion process is running, even if this dashboard is closed. Remove schedules before leaving automation unattended. Existing schedules require review after a new pairing.</p>
        <p>Extension scripts/settings stay in chrome.storage.local. Native scripts/history stay in your user profile's .scriptbridge folder. The pairing token is separate from script/settings exports. Exports may still contain script code and environment values you entered: review before sharing.</p>
        <h3>Resetting access</h3>
        <p>Forget Local Token removes only this browser's copy. To revoke access, stop the companion, delete pairing.json and restart, then pair again. Restarting alone retains pairing. The old localhost dashboard is retired; use this extension's dashboard.</p>
    </article>`;
}

// ============ STYLE FOR SETTINGS ============
const style = document.createElement('style');
style.textContent = `
.setting-section { padding:16px 0; border-bottom:1px solid var(--border); }
.s-row { display:flex; justify-content:space-between; align-items:center; padding:10px 12px; border-radius:6px; margin-bottom:2px; }
.s-row:hover { background:var(--surface); }
.s-row span { font-size:0.88rem; }
`;
document.head.appendChild(style);

// ============ EVENT BINDING (MV3 CSP - no inline handlers) ============
document.addEventListener('DOMContentLoaded', () => {
    // Nav links
    document.querySelectorAll('.nav-link').forEach(el => {
        el.addEventListener('click', () => showPage(el.dataset.page));
    });

    // Header buttons
    document.getElementById('btn-new-script').addEventListener('click', showCreateModal);
    document.getElementById('btn-import').addEventListener('click', importScripts);
    document.getElementById('btn-export').addEventListener('click', exportScripts);

    // Tabs
    document.querySelectorAll('.tab').forEach(el => {
        el.addEventListener('click', () => filterTab(el.dataset.tab));
    });

    // Search
    document.getElementById('search-input').addEventListener('input', onSearchInput);

    // Modal
    document.getElementById('btn-modal-close').addEventListener('click', closeModal);
    document.getElementById('btn-cancel').addEventListener('click', closeModal);
    document.getElementById('btn-run-close').addEventListener('click', closeRunModal);
    document.getElementById('script-form').addEventListener('submit', saveScript);
    document.getElementById('script-language').addEventListener('change', onLanguageChange);
    document.getElementById('script-category').addEventListener('change', onCategoryChange);

    // Code editor tab key
    document.getElementById('script-code').addEventListener('keydown', function(e) {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = this.selectionStart;
            this.value = this.value.substring(0, start) + '    ' + this.value.substring(this.selectionEnd);
            this.selectionStart = this.selectionEnd = start + 4;
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.key === 'n' && !e.shiftKey) { e.preventDefault(); showCreateModal(); }
        if (e.ctrlKey && e.key === 's' && !document.getElementById('modal').classList.contains('hidden')) {
            e.preventDefault();
            document.getElementById('script-form').requestSubmit();
        }
        if (e.key === 'Escape') { closeModal(); closeRunModal(); }
        if (e.ctrlKey && e.key === 'f') {
            const search = document.getElementById('search-input');
            if (search && document.getElementById('page-scripts').classList.contains('active')) {
                e.preventDefault(); search.focus();
            }
        }
    });

    // Event delegation for companion/settings pages (dynamic content)
    document.addEventListener('click', (e) => {
        if (e.target.id === 'btn-pair-companion') pairCompanionFromUI();
        if (e.target.id === 'btn-forget-companion') forgetCompanionFromUI();
        if (e.target.id === 'btn-check-companion') checkCompanionNow();
        if (e.target.id === 'btn-sync-companion') syncToCompanion();
        if (e.target.id === 'btn-save-settings') saveSettingsFromUI();
    });
    document.addEventListener('change', (e) => {
    });

    // Event delegation for dynamic script cards
    document.getElementById('script-list').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (action === 'edit') editScript(id);
        else if (action === 'run') runScript(id);
        else if (action === 'delete') deleteScript(id);
    });
    document.getElementById('script-list').addEventListener('change', (e) => {
        const el = e.target.closest('[data-action="toggle"]');
        if (el) toggleScript(el.dataset.id);
    });

    // Init
    init();
});
