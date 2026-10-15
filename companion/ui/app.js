const API = '';
let scripts = [];
let currentFilter = 'all';

async function fetchScripts() {
    const res = await fetch(`${API}/api/scripts`);
    scripts = await res.json();
    render();
}

function filterTab(tab) {
    currentFilter = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    render();
}

function render() {
    const list = document.getElementById('script-list');
    let filtered = scripts;
    if (currentFilter === 'browser') filtered = scripts.filter(s => s.category === 'browser');
    if (currentFilter === 'external') filtered = scripts.filter(s => s.category === 'external');
    // Apply tag filter if active
    if (window._activeTagFilter) {
        filtered = filtered.filter(s => s.tags && s.tags.includes(window._activeTagFilter));
    }

    if (filtered.length === 0) {
        list.innerHTML = `<div class="empty-state">
            <h3>No scripts yet</h3>
            <p>Create your first script to get started</p>
        </div>`;
        return;
    }

    list.innerHTML = filtered.map(s => `
        <div class="script-card">
            <div class="script-card-header">
                <h3>${esc(s.name)}</h3>
                <label class="toggle-switch">
                    <input type="checkbox" ${s.enabled ? 'checked' : ''} onchange="toggleScript('${s.id}')">
                    <span class="toggle-slider"></span>
                </label>
            </div>
            <div class="script-card-meta">
                <span class="badge badge-${langClass(s.language)}">${s.language}</span>
                <span class="badge badge-${s.category}">${s.category}</span>
                <span class="badge ${s.enabled ? 'badge-enabled' : 'badge-disabled'}">${s.enabled ? 'enabled' : 'disabled'}</span>
            </div>
            <p class="script-desc">${esc(s.description || 'No description')}</p>
            ${(s.tags && s.tags.length) ? `<div style="margin-bottom:8px;display:flex;gap:4px;flex-wrap:wrap">${s.tags.map(t => `<span style="font-size:0.68rem;padding:2px 6px;background:var(--surface2);border-radius:8px;color:var(--text-dim)">${esc(t)}</span>`).join('')}</div>` : ''}
            <div class="script-actions">
                <button class="btn" onclick="editScript('${s.id}')">Edit</button>
                ${s.category === 'external' ? `<button class="btn btn-run" onclick="runScript('${s.id}')">&#9654; Run</button>` : ''}
                <button class="btn" onclick="watchFile('${s.id}')" title="Watch local file">${s.watch_path ? '&#128994;' : '&#128065;'} Watch</button>
                <button class="btn btn-danger" onclick="deleteScript('${s.id}')">Delete</button>
                ${s.last_run ? `<span style="font-size:0.72rem;color:var(--text-dim);margin-left:auto">Last: ${new Date(s.last_run).toLocaleString()}</span>` : ''}
            </div>
        </div>
    `).join('');
}

function langClass(lang) {
    const map = { javascript: 'js', python: 'python', rust: 'rust', c: 'c', cmd: 'cmd', powershell: 'powershell' };
    return map[lang] || 'js';
}

function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

function showCreateModal() {
    document.getElementById('modal-title').textContent = 'New Script';
    document.getElementById('script-id').value = '';
    document.getElementById('script-name').value = '';
    document.getElementById('script-desc').value = '';
    document.getElementById('script-language').value = 'javascript';
    document.getElementById('script-category').value = 'browser';
    document.getElementById('script-patterns').value = '*://*/*';
    document.getElementById('script-runat').value = 'document-idle';
    document.getElementById('script-trigger').value = 'manual';
    document.getElementById('script-code').value = '';
    onCategoryChange();
    document.getElementById('modal').classList.remove('hidden');
}

function editScript(id) {
    const s = scripts.find(x => x.id === id);
    if (!s) return;
    document.getElementById('modal-title').textContent = 'Edit Script';
    document.getElementById('script-id').value = s.id;
    document.getElementById('script-name').value = s.name;
    document.getElementById('script-desc').value = s.description;
    document.getElementById('script-language').value = s.language;
    document.getElementById('script-category').value = s.category;
    document.getElementById('script-patterns').value = (s.match_patterns || []).join('\n');
    document.getElementById('script-runat').value = s.run_at || 'document-idle';
    document.getElementById('script-trigger').value = s.trigger || 'manual';
    document.getElementById('script-code').value = s.code;
    onCategoryChange();
    document.getElementById('modal').classList.remove('hidden');
}

function closeModal() { document.getElementById('modal').classList.add('hidden'); }
function closeRunModal() { document.getElementById('run-modal').classList.add('hidden'); }

function onLanguageChange() {
    const lang = document.getElementById('script-language').value;
    const cat = document.getElementById('script-category');
    if (lang !== 'javascript') {
        cat.value = 'external';
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
    const body = {
        name: document.getElementById('script-name').value,
        description: document.getElementById('script-desc').value,
        language: document.getElementById('script-language').value,
        category: document.getElementById('script-category').value,
        code: document.getElementById('script-code').value,
        match_patterns: document.getElementById('script-patterns').value.split('\n').filter(Boolean),
        run_at: document.getElementById('script-runat').value,
        trigger: document.getElementById('script-trigger').value,
    };

    if (id) {
        await fetch(`${API}/api/scripts/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    } else {
        await fetch(`${API}/api/scripts`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    }
    closeModal();
    fetchScripts();
}

async function deleteScript(id) {
    if (!confirm('Delete this script?')) return;
    await fetch(`${API}/api/scripts/${id}`, { method: 'DELETE' });
    fetchScripts();
}

async function toggleScript(id) {
    await fetch(`${API}/api/scripts/${id}/toggle`, { method: 'POST' });
    fetchScripts();
}

async function runScript(id) {
    const modal = document.getElementById('run-modal');
    modal.classList.remove('hidden');
    document.getElementById('run-status').innerHTML = '<span style="color:var(--orange)">Running...</span>';
    document.getElementById('run-stdout').textContent = '';
    document.getElementById('run-stderr').textContent = '';

    try {
        const res = await fetch(`${API}/api/scripts/${id}/run`, { method: 'POST' });
        const data = await res.json();
        const color = data.exit_code === 0 ? 'var(--green)' : 'var(--red)';
        document.getElementById('run-status').innerHTML = `<span style="color:${color}">Exit code: ${data.exit_code}</span> &nbsp; <span style="color:var(--text-dim)">${data.duration_ms}ms</span>`;
        document.getElementById('run-stdout').textContent = data.stdout || '(no output)';
        document.getElementById('run-stderr').textContent = data.stderr || '';
    } catch(e) {
        document.getElementById('run-status').innerHTML = `<span style="color:var(--red)">Error</span>`;
        document.getElementById('run-stderr').textContent = e.message;
    }
    fetchScripts();
}

// Tab key in code editor
document.getElementById('script-code').addEventListener('keydown', function(e) {
    if (e.key === 'Tab') {
        e.preventDefault();
        const start = this.selectionStart;
        this.value = this.value.substring(0, start) + '    ' + this.value.substring(this.selectionEnd);
        this.selectionStart = this.selectionEnd = start + 4;
    }
});

// --- Keyboard Shortcuts ---
document.addEventListener('keydown', function(e) {
    // Ctrl+N: New script
    if (e.ctrlKey && e.key === 'n' && !e.shiftKey && !e.altKey) {
        if (!document.getElementById('modal').classList.contains('hidden')) return;
        e.preventDefault();
        showCreateModal();
    }
    // Ctrl+S: Save (when modal is open)
    if (e.ctrlKey && e.key === 's') {
        if (document.getElementById('modal').classList.contains('hidden')) return;
        e.preventDefault();
        document.getElementById('script-form').dispatchEvent(new Event('submit', {cancelable:true}));
    }
    // Ctrl+Enter: Save and run (when modal open + external script)
    if (e.ctrlKey && e.key === 'Enter') {
        if (document.getElementById('modal').classList.contains('hidden')) return;
        e.preventDefault();
        const id = document.getElementById('script-id').value;
        const cat = document.getElementById('script-category').value;
        saveScript(new Event('submit')).then(() => {
            if (cat === 'external' && id) runScript(id);
        });
    }
    // Escape: close modals
    if (e.key === 'Escape') {
        closeModal();
        closeRunModal();
    }
    // Ctrl+F: Focus search
    if (e.ctrlKey && e.key === 'f' && document.getElementById('modal').classList.contains('hidden')) {
        const searchEl = document.getElementById('search-input');
        if (searchEl) { e.preventDefault(); searchEl.focus(); }
    }
});

// --- Search ---
let searchTimeout = null;
function onSearchInput(e) {
    clearTimeout(searchTimeout);
    const query = e.target.value.trim();
    if (!query) { fetchScripts(); return; }
    searchTimeout = setTimeout(async () => {
        const isRegex = document.getElementById('search-regex')?.checked || false;
        const res = await fetch(`${API}/api/search?q=${encodeURIComponent(query)}&regex=${isRegex}`);
        if (res.ok) {
            scripts = await res.json();
            render();
        }
    }, 300);
}

// --- Import/Export ---
async function exportScripts() {
    const res = await fetch(`${API}/api/export`);
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scriptbridge-export-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

async function importScripts() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const text = await file.text();
        try {
            const data = JSON.parse(text);
            const scriptsList = data.scripts || data;
            const overwrite = confirm('Overwrite existing scripts with the same ID?');
            const res = await fetch(`${API}/api/import`, {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ scripts: scriptsList, overwrite })
            });
            const result = await res.json();
            alert(`Imported: ${result.imported}, Skipped: ${result.skipped}`);
            fetchScripts();
        } catch(err) {
            alert('Invalid import file: ' + err.message);
        }
    };
    input.click();
}

// --- File Watch ---
async function watchFile(id) {
    const path = prompt('Enter the full file path to watch:\n(Script code will sync from this file on changes)');
    if (!path) return;
    const res = await fetch(`${API}/api/scripts/${id}/watch`, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ path })
    });
    if (res.ok) {
        alert('File watch enabled. Code synced from:\n' + path);
        fetchScripts();
    } else {
        alert('Failed to set watch. Check the file path.');
    }
}

// File watch polling (check every 5s for watched scripts)
setInterval(async () => {
    for (const s of scripts) {
        if (!s.watch_path) continue;
        const res = await fetch(`${API}/api/scripts/${s.id}/check-file`);
        if (res.ok) {
            const data = await res.json();
            if (data.changed) {
                console.log(`[ScriptBridge] File changed, reloaded: ${s.name}`);
                fetchScripts();
                break;
            }
        }
    }
}, 5000);

// Init
fetchScripts();
