// ScriptBridge Install/Update Page
(async () => {
    const container = document.getElementById('install-content');
    const params = new URLSearchParams(location.search);
    const scriptUrl = params.get('url');
    const updateId = params.get('update'); // if present, this is an update
    const revertId = params.get('revert'); // if present, this is a revert
    let downloadUrl = scriptUrl;
    const send = async (msg) => { const response = await chrome.runtime.sendMessage(msg); if (response && !Array.isArray(response) && response.error) throw new Error(response.error); return response; };

    if (!scriptUrl && !updateId && !revertId) {
        container.innerHTML = '<p style="color:#f44336">No script URL provided.</p>';
        return;
    }

    // Parse metadata block from script text
    function parseMeta(text) {
        const meta = {};
        const matches = [];
        const grants = [];
        for (const line of text.split('\n')) {
            const m = line.match(/\/\/\s*@(\w+)\s+(.*?)$/);
            if (m) {
                const key = m[1].trim(), val = m[2].trim();
                if (key === 'match' || key === 'include') matches.push(val);
                else if (key === 'grant') grants.push(val);
                else meta[key] = val;
            }
        }
        meta._matches = matches;
        meta._grants = grants;
        return meta;
    }

    // Simple diff: returns array of {type: 'add'|'del'|'ctx', line}
    function simpleDiff(oldText, newText) {
        const oldLines = oldText.split('\n');
        const newLines = newText.split('\n');
        const result = [];
        // Simple LCS-based approach for short scripts; fall back to line-by-line for large
        const oldSet = new Set(oldLines);
        const newSet = new Set(newLines);
        let oi = 0, ni = 0;
        while (oi < oldLines.length || ni < newLines.length) {
            if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
                result.push({ type: 'ctx', line: oldLines[oi] });
                oi++; ni++;
            } else if (oi < oldLines.length && !newSet.has(oldLines[oi])) {
                result.push({ type: 'del', line: oldLines[oi] });
                oi++;
            } else if (ni < newLines.length && !oldSet.has(newLines[ni])) {
                result.push({ type: 'add', line: newLines[ni] });
                ni++;
            } else if (oi < oldLines.length) {
                result.push({ type: 'del', line: oldLines[oi] });
                oi++;
            } else {
                result.push({ type: 'add', line: newLines[ni] });
                ni++;
            }
        }
        return result;
    }

    function escHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

    function safeDownloadUrl(value) {
        return SBScriptUrlPolicy.fetchableScriptUrl(value);
    }

    async function readScriptResponse(response) {
        if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
        const text = await response.text();
        const type = response.headers.get('content-type') || '';
        if (/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(type) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(text)) {
            throw new Error('The server returned a web page instead of script code, possibly a sign-in page');
        }
        return text;
    }

    function showLoadError(error) {
        const message = error?.message || 'Unknown error';
        document.title = 'ScriptBridge - Unable to load script';
        container.innerHTML = `<section class="meta-card" role="alert">
            <h2>Unable to load script</h2>
            <p id="load-error-detail">${escHtml(message)}</p>
            ${downloadUrl ? `<p>ScriptBridge could not download the script. Downloads do not send sign-in cookies or follow redirects. A protected source may require a signed-in browser download; a network failure can look the same.</p>
            <p>Download the file through the source site's normal signed-in page, then review its code in the ScriptBridge editor. Retrying here does not sign you in.</p>
            <p>Requested source: <code id="failed-source">${escHtml(downloadUrl)}</code></p>` : ''}
            <p>No scripts were changed. This page will not retry or reopen automatically.</p>
        </section>
        <div class="actions">
            <button class="btn btn-install" id="btn-retry-load">Retry</button>
            <button class="btn btn-cancel" id="btn-open-dashboard">Open Dashboard</button>
            <button class="btn btn-cancel" id="btn-close-load">Close</button>
        </div>`;
        document.getElementById('btn-retry-load').addEventListener('click', () => location.reload());
        document.getElementById('btn-open-dashboard').addEventListener('click', () => location.assign(chrome.runtime.getURL('dashboard.html')));
        document.getElementById('btn-close-load').addEventListener('click', async () => {
            const tab = await chrome.tabs.getCurrent();
            if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
            else window.close();
        });
    }

    function homepageLink(value) {
        try { return `<a href="${escHtml(safeDownloadUrl(value))}" target="_blank" rel="noopener noreferrer">${escHtml(value)}</a>`; }
        catch { return escHtml(value) + ' (unsupported link)'; }
    }

    try {
        let code, meta, isUpdate = false, existingScript = null, oldCode = '';

        if (revertId) {
            // Revert flow: show diff between current and previous version
            const scripts = await send({ action: 'getScripts' });
            existingScript = scripts.find(s => s.id === revertId);
            if (!existingScript) { container.innerHTML = '<p style="color:#f44336">Script not found.</p>'; return; }
            if (!existingScript.previous_code) { container.innerHTML = '<p style="color:#f44336">No previous version available.</p>'; return; }
            code = existingScript.previous_code;
            oldCode = existingScript.code;
            meta = parseMeta(code);
            const currentMeta = parseMeta(oldCode);
            isUpdate = false;
            document.title = 'ScriptBridge - Roll Back: ' + (currentMeta.name || existingScript.name);

            let html = '<div class="meta-card">' +
                '<h2>' + escHtml(existingScript.name) + '<span class="update-badge" style="background:#ff9800">ROLL BACK</span></h2>' +
                '<p class="desc">You are about to roll back to the previous version of this script.</p>' +
                '<div class="meta-grid">' +
                '<span class="key">Current Version</span><span class="val">' + escHtml(currentMeta.version || existingScript.version || '?') + '</span>' +
                '<span class="key">Rolling Back To</span><span class="val" style="color:#4caf50;font-weight:600">' + escHtml(meta.version || existingScript.previous_version || '?') + '</span>' +
                (meta.author ? '<span class="key">Author</span><span class="val">' + escHtml(meta.author) + '</span>' : '') +
                (existingScript.updated_at ? '<span class="key">Last Updated</span><span class="val">' + new Date(existingScript.updated_at).toLocaleString() + '</span>' : '') +
                '</div></div>';

            // Diff: show what will change (current → previous)
            const diff = simpleDiff(oldCode, code);
            const added = diff.filter(d => d.type === 'add').length;
            const removed = diff.filter(d => d.type === 'del').length;
            const diffHtml = diff.map(d => {
                const cls = d.type === 'add' ? 'diff-add' : d.type === 'del' ? 'diff-del' : 'diff-ctx';
                const prefix = d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' ';
                return '<div class="' + cls + '">' + prefix + ' ' + escHtml(d.line) + '</div>';
            }).join('');
            html += '<details class="diff-view" open>' +
                '<summary>Changes if you roll back (' + added + ' restored, ' + removed + ' removed)</summary>' +
                '<pre>' + diffHtml + '</pre></details>';

            // Code preview of the version being restored
            html += '<details class="code-preview">' +
                '<summary>Previous Version Source (' + code.split(String.fromCharCode(10)).length + ' lines)</summary>' +
                '<pre>' + escHtml(code) + '</pre></details>';

            html += '<div class="actions">' +
                '<button class="btn btn-install" id="btn-do-install" style="background:#ff9800">Roll Back</button>' +
                '<button class="btn btn-cancel" id="btn-cancel">Cancel</button></div>' +
                '<div id="status-msg"></div>';

            container.innerHTML = html;

            document.getElementById('btn-cancel').addEventListener('click', () => window.close());
            document.getElementById('btn-do-install').addEventListener('click', async () => {
                const statusEl = document.getElementById('status-msg');
                const btn = document.getElementById('btn-do-install');
                btn.disabled = true;
                btn.textContent = 'Rolling back...';
                try {
                    const result = await send({ action: 'revertScript', id: revertId });
                    if (result?.ok) {
                        statusEl.className = 'success';
                        statusEl.textContent = 'Rolled back to v' + (result.revertedTo || meta.version || '?') + '. Closing...';
                        btn.textContent = 'Done';
                        setTimeout(() => window.close(), 1500);
                    } else {
                        throw new Error(result?.error || 'Unknown error');
                    }
                } catch(e) {
                    statusEl.className = 'error';
                    statusEl.textContent = 'Error: ' + e.message;
                    btn.disabled = false;
                    btn.textContent = 'Roll Back';
                }
            });
            return; // revert flow is complete, skip the rest
        } else if (updateId) {
            // Update flow: fetch existing script and remote code
            isUpdate = true;
            const scripts = await send({ action: 'getScripts' });
            existingScript = scripts.find(s => s.id === updateId);
            if (!existingScript) { container.innerHTML = '<p style="color:#f44336">Script not found.</p>'; return; }
            oldCode = existingScript.code || '';
            const { scriptUpdates = {} } = await chrome.storage.local.get('scriptUpdates');
            const updateInfo = scriptUpdates[updateId];
            if (!updateInfo) { container.innerHTML = '<p style="color:#f44336">No update info.</p>'; return; }
            downloadUrl = updateInfo.downloadUrl;
            const res = await fetch(safeDownloadUrl(downloadUrl), { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000) });
            code = await readScriptResponse(res);
            meta = parseMeta(code);
            document.title = `ScriptBridge - Update: ${meta.name || existingScript.name}`;
        } else {
            // Install flow
            const res = await fetch(safeDownloadUrl(scriptUrl), { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000) });
            code = await readScriptResponse(res);
            meta = parseMeta(code);
            document.title = `ScriptBridge - Install: ${meta.name || 'Unknown Script'}`;

            // Check if already installed (same name or same updateURL)
            const scripts = await send({ action: 'getScripts' });
            existingScript = scripts.find(s => {
                if (!s.code) return false;
                const sMeta = parseMeta(s.code);
                return (meta.name && sMeta.name === meta.name) || (meta.updateURL && sMeta.updateURL === meta.updateURL);
            });
            if (existingScript) {
                isUpdate = true;
                oldCode = existingScript.code || '';
            }
        }

        // Build UI
        let html = `<div class="meta-card">
            <h2>${escHtml(meta.name || 'Unknown Script')}${isUpdate ? '<span class="update-badge">UPDATE</span>' : ''}</h2>
            ${meta.description ? `<p class="desc">${escHtml(meta.description)}</p>` : ''}
            <div class="meta-grid">
                ${meta.version ? `<span class="key">Version</span><span class="val">${escHtml(meta.version)}${isUpdate && existingScript ? ' (current: ' + escHtml(parseMeta(oldCode).version || '?') + ')' : ''}</span>` : ''}
                ${meta.author ? `<span class="key">Author</span><span class="val">${escHtml(meta.author)}</span>` : ''}
                ${meta.namespace ? `<span class="key">Namespace</span><span class="val">${escHtml(meta.namespace)}</span>` : ''}
                ${meta.homepage || meta.homepageURL ? `<span class="key">Homepage</span><span class="val">${homepageLink(meta.homepage || meta.homepageURL)}</span>` : ''}
                ${meta._matches.length ? `<span class="key">Runs on</span><span class="val">${meta._matches.map(m => escHtml(m)).join('<br>')}</span>` : ''}
                ${meta.run ? `<span class="key">Run at</span><span class="val">${escHtml(meta.run)}</span>` : ''}
            </div>
        </div>`;

        // Permissions warning
        if (meta._grants.length && !meta._grants.includes('none')) {
            html += `<div class="permissions-warn">
                <h4>Permissions Requested</h4>
                <ul>${meta._grants.map(g => `<li>${escHtml(g)}</li>`).join('')}</ul>
            </div>`;
        }

        // Diff view for updates
        if (isUpdate && oldCode) {
            const diff = simpleDiff(oldCode, code);
            const added = diff.filter(d => d.type === 'add').length;
            const removed = diff.filter(d => d.type === 'del').length;
            const diffHtml = diff.map(d => {
                const cls = d.type === 'add' ? 'diff-add' : d.type === 'del' ? 'diff-del' : 'diff-ctx';
                const prefix = d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' ';
                return `<div class="${cls}">${prefix} ${escHtml(d.line)}</div>`;
            }).join('');
            html += `<details class="diff-view" open>
                <summary>Changes (${added} added, ${removed} removed)</summary>
                <pre>${diffHtml}</pre>
            </details>`;
        }

        // Code preview
        html += `<details class="code-preview"${isUpdate ? '' : ' open'}>
            <summary>Source Code (${code.split('\n').length} lines)</summary>
            <pre>${escHtml(code)}</pre>
        </details>`;

        // Actions
        html += `<div class="actions">
            <button class="btn btn-install" id="btn-do-install">${isUpdate ? 'Update Script' : 'Install Script'}</button>
            <button class="btn btn-cancel" id="btn-cancel">Cancel</button>
        </div>
        <div id="status-msg"></div>`;

        container.innerHTML = html;

        // Wire buttons
        document.getElementById('btn-cancel').addEventListener('click', () => window.close());
        document.getElementById('btn-do-install').addEventListener('click', async () => {
            const statusEl = document.getElementById('status-msg');
            const btn = document.getElementById('btn-do-install');
            btn.disabled = true;
            btn.textContent = isUpdate ? 'Updating...' : 'Installing...';

            try {
                const scripts = await send({ action: 'getScripts' });

                if (isUpdate && existingScript) {
                    const idx = scripts.findIndex(s => s.id === existingScript.id);
                    if (idx !== -1) {
                        scripts[idx].previous_code = scripts[idx].code;
                        scripts[idx].previous_version = scripts[idx].version || '';
                        scripts[idx].code = code;
                        scripts[idx].version = meta.version || scripts[idx].version;
                        scripts[idx].updated_at = new Date().toISOString();
                    }
                } else {
                    // New install
                    const newScript = {
                        id: crypto.randomUUID(),
                        name: meta.name || 'Untitled',
                        description: meta.description || '',
                        version: meta.version || '1.0',
                        category: 'browser',
                        language: 'javascript',
                        enabled: true,
                        code: code,
                        match_patterns: meta._matches.length ? meta._matches : ['*://*/*'],
                        run_at: meta.run || 'document-idle',
                        trigger: 'auto',
                        tags: [],
                        env_vars: {},
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    };
                    scripts.push(newScript);
                }

                await send({ action: 'saveScripts', scripts });

                statusEl.className = 'success';
                statusEl.textContent = isUpdate
                    ? `Updated to v${meta.version || '?'}. Closing...`
                    : `Installed "${meta.name || 'script'}" successfully. Closing...`;
                btn.textContent = 'Done';

                // Close tab after brief delay
                setTimeout(() => window.close(), 1500);
            } catch(e) {
                statusEl.className = 'error';
                statusEl.textContent = 'Error: ' + e.message;
                btn.disabled = false;
                btn.textContent = isUpdate ? 'Update Script' : 'Install Script';
            }
        });

    } catch(e) {
        showLoadError(e);
    }
})();
