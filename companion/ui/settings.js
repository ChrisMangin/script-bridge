const API = '';
let settings = {};
let tags = ['utilities', 'productivity', 'social media', 'games', 'news', 'automation'];

// Config mode visibility levels: which fields show at which level
// beginner = only essentials, advanced = most, expert = everything
const VISIBILITY = {
    beginner: [
        'config_mode', 'language', 'auto_reload', 'theme', 'layout',
        'enhanced_editor', 'editor_theme', 'editor_font_size', 'word_wrap',
        'indent_width', 'indent_type',
        'update_interval', 'default_run_at', 'script_template',
        'exec_timeout', 'python_path',
        'page_blacklist', 'filter_mode', 'confirm_external',
        'sync_enabled', 'sync_type',
        'tags_enabled',
        'exec_notify', 'notify_updates',
    ],
    advanced: [
        'config_mode', 'language', 'auto_reload', 'debug_scripts', 'log_level',
        'trash_mode', 'server_port', 'start_with_windows', 'minimize_to_tray',
        'theme', 'layout', 'accent_color', 'badge_info', 'badge_color',
        'update_notification', 'hide_disabled', 'custom_css',
        'enhanced_editor', 'editor_theme', 'editor_font_size', 'editor_font',
        'key_mapping', 'indent_width', 'indent_type', 'word_wrap', 'line_numbers',
        'auto_brackets', 'highlight_matches', 'trim_whitespace', 'auto_lint', 'save_on_blur',
        'update_interval', 'url_detection', 'injection_method', 'default_run_at',
        'script_order', 'script_template', 'custom_template',
        'scripts_dir', 'exec_timeout', 'keep_artifacts', 'max_output',
        'python_path', 'rustc_path', 'cc_path', 'ps_policy', 'env_vars', 'working_dir', 'run_as_admin',
        'sandbox_mode', 'csp_mode', 'allow_local_files', 'allow_cors',
        'api_auth', 'api_token', 'allowed_origins',
        'page_blacklist', 'page_whitelist', 'filter_mode', 'confirm_external',
        'sync_enabled', 'sync_type', 'sync_path', 'sync_interval', 'sync_external', 'conflict_resolution',
        'tags_enabled',
        'exec_notify', 'notify_updates', 'notify_timeout', 'sound_on_complete',
        'strict_mode', 'top_level_await', 'max_concurrent', 'history_days',
        'backup_on_save', 'max_backups', 'export_format', 'heartbeat_interval',
    ],
    // expert shows everything (no filter)
};

function applyConfigMode() {
    const mode = document.getElementById('config_mode').value;
    const allowed = VISIBILITY[mode]; // undefined for expert = show all

    document.querySelectorAll('.setting-row').forEach(row => {
        // Find the input/select/textarea in this row to get its ID
        const control = row.querySelector('input, select, textarea');
        if (!control || !control.id) {
            // Rows without an ID (like tags container, buttons) always show
            row.style.display = '';
            return;
        }
        if (control.id === 'config_mode') {
            row.style.display = ''; // Always show config mode selector
            return;
        }
        if (!allowed) {
            // Expert mode: show everything
            row.style.display = '';
        } else {
            row.style.display = allowed.includes(control.id) ? '' : 'none';
        }
    });

    // Also hide entire nav sections if all their rows are hidden (beginner mode)
    if (mode === 'beginner') {
        // Hide Advanced and Notifications nav items for beginners? No, just let them see fewer rows
    }
}

// Hook up the config mode dropdown
document.getElementById('config_mode').addEventListener('change', applyConfigMode);

// All setting field IDs and their types
const FIELDS = {
    // General
    config_mode: 'select', language: 'select', auto_reload: 'checkbox', debug_scripts: 'checkbox',
    log_level: 'select', trash_mode: 'checkbox', server_port: 'number', start_with_windows: 'checkbox',
    minimize_to_tray: 'checkbox',
    // Appearance
    theme: 'select', layout: 'select', accent_color: 'color', badge_info: 'select',
    badge_color: 'color', custom_css: 'textarea', update_notification: 'select', hide_disabled: 'checkbox',
    // Editor
    enhanced_editor: 'checkbox', editor_theme: 'select', editor_font_size: 'select',
    editor_font: 'select', key_mapping: 'select', indent_width: 'select', indent_type: 'select',
    word_wrap: 'checkbox', line_numbers: 'checkbox', auto_brackets: 'checkbox',
    highlight_matches: 'select', trim_whitespace: 'checkbox', auto_lint: 'checkbox', save_on_blur: 'checkbox',
    // Userscripts
    update_interval: 'select', url_detection: 'select', injection_method: 'select',
    default_run_at: 'select', script_order: 'select', script_template: 'select', custom_template: 'textarea',
    // External
    scripts_dir: 'text', exec_timeout: 'number', keep_artifacts: 'checkbox', max_output: 'number',
    python_path: 'text', rustc_path: 'text', cc_path: 'text', ps_policy: 'select',
    env_vars: 'textarea', working_dir: 'text', run_as_admin: 'checkbox',
    // Security
    sandbox_mode: 'select', csp_mode: 'select', allow_local_files: 'checkbox',
    allow_cors: 'checkbox', api_auth: 'checkbox', api_token: 'text',
    allowed_origins: 'textarea', page_blacklist: 'textarea', page_whitelist: 'textarea',
    filter_mode: 'select', confirm_external: 'checkbox',
    // Sync
    sync_enabled: 'checkbox', sync_type: 'select', sync_path: 'text',
    sync_interval: 'select', sync_external: 'checkbox', conflict_resolution: 'select',
    // Tags
    tags_enabled: 'checkbox',
    // Notifications
    exec_notify: 'select', notify_updates: 'checkbox', notify_timeout: 'select', sound_on_complete: 'checkbox',
    // Advanced
    strict_mode: 'select', top_level_await: 'select', max_concurrent: 'number',
    history_days: 'number', backup_on_save: 'checkbox', max_backups: 'number',
    export_format: 'select', heartbeat_interval: 'number',
};

async function loadSettings() {
    try {
        const res = await fetch(`${API}/api/settings`);
        if (res.ok) {
            const data = await res.json();
            settings = data.settings || {};
            tags = data.tags || tags;
        }
    } catch (e) {
        console.warn('Could not load settings, using defaults');
    }
    applyToForm();
    renderTags();
    applyConfigMode();
}

function applyToForm() {
    for (const [id, type] of Object.entries(FIELDS)) {
        const el = document.getElementById(id);
        if (!el || !(id in settings)) continue;
        if (type === 'checkbox') el.checked = settings[id];
        else el.value = settings[id];
    }
}

function gatherFromForm() {
    const result = {};
    for (const [id, type] of Object.entries(FIELDS)) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (type === 'checkbox') result[id] = el.checked;
        else if (type === 'number') result[id] = parseInt(el.value) || 0;
        else result[id] = el.value;
    }
    return result;
}

async function saveAllSettings() {
    settings = gatherFromForm();
    try {
        await fetch(`${API}/api/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings, tags })
        });
        showToast('Settings saved');
    } catch (e) {
        showToast('Failed to save settings');
    }
}

async function resetSettings() {
    if (!confirm('Reset all settings to defaults? This cannot be undone.')) return;
    try {
        await fetch(`${API}/api/settings`, { method: 'DELETE' });
        location.reload();
    } catch (e) {
        showToast('Failed to reset');
    }
}

async function clearAllData() {
    if (!confirm('This will DELETE all scripts, settings, and history. Are you sure?')) return;
    if (!confirm('This is irreversible. Type OK in the next prompt to confirm.')) return;
    try {
        await fetch(`${API}/api/reset`, { method: 'POST' });
        showToast('All data cleared');
        setTimeout(() => location.href = '/', 1000);
    } catch (e) {
        showToast('Failed to clear data');
    }
}

function generateToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = 'sb_';
    for (let i = 0; i < 32; i++) token += chars.charAt(Math.floor(Math.random() * chars.length));
    document.getElementById('api_token').value = token;
    document.getElementById('api_token').type = 'text';
}

// Tags
function renderTags() {
    const container = document.getElementById('tags-container');
    container.innerHTML = tags.map((t, i) => `
        <span class="tag-pill">${esc(t)}<span class="tag-remove" onclick="removeTag(${i})">&times;</span></span>
    `).join('');
}

function addTag() {
    const input = document.getElementById('new_tag');
    const val = input.value.trim();
    if (val && !tags.includes(val)) {
        tags.push(val);
        renderTags();
        input.value = '';
    }
}

function removeTag(i) {
    tags.splice(i, 1);
    renderTags();
}

// Navigation
function showSection(name) {
    document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById(`section-${name}`).classList.add('active');
    document.querySelector(`.nav-item[data-section="${name}"]`).classList.add('active');
}

// Toast
function showToast(msg) {
    let toast = document.querySelector('.toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Enter key on tag input
document.getElementById('new_tag').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addTag(); }
});

loadSettings();
