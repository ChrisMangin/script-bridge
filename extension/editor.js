// ScriptBridge Editor - full page code editor
const TEMPLATES = {
    javascript: `// ==UserScript==
// @name         New Userscript
// @namespace    scriptbridge
// @version      ${new Date().toISOString().slice(0,10)}
// @description  try to take over the world!
// @author       You
// @match        https://*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Your code here...
})();`,
    python: `#!/usr/bin/env python3
"""
Script: New Script
Description: 
Author: You
Date: ${new Date().toISOString().slice(0,10)}
"""

def main():
    print("Hello from ScriptBridge!")

if __name__ == "__main__":
    main()`,
    rust: `// Script: New Script
// Date: ${new Date().toISOString().slice(0,10)}

fn main() {
    println!("Hello from ScriptBridge!");
}`,
    c: `/* Script: New Script */
/* Date: ${new Date().toISOString().slice(0,10)} */

#include <stdio.h>

int main() {
    printf("Hello from ScriptBridge!\\n");
    return 0;
}`,
    cmd: `@echo off
REM Script: New Script
REM Date: ${new Date().toISOString().slice(0,10)}

echo Hello from ScriptBridge!
pause`,
    powershell: `# Script: New Script
# Date: ${new Date().toISOString().slice(0,10)}
# Description: 

Write-Host "Hello from ScriptBridge!"`
};

let currentScript = null;
let dirty = false;

async function send(msg) { const response = await chrome.runtime.sendMessage(msg); if (response && !Array.isArray(response) && response.error) throw new Error(response.error); return response; }

// ============ INIT ============
async function init() {
    const params = new URLSearchParams(location.search);
    const id = params.get('id');
    const lang = params.get('lang') || 'javascript';

    if (id) {
        // Editing existing script
        const scripts = await send({ action: 'getScripts' }) || [];
        currentScript = scripts.find(s => s.id === id);
        if (currentScript) {
            document.getElementById('script-title').textContent = currentScript.name;
            document.getElementById('meta-name').value = currentScript.name;
            document.getElementById('meta-category').value = currentScript.category;
            document.getElementById('meta-language').value = currentScript.language || 'javascript';
            document.getElementById('meta-match').value = (currentScript.match_patterns||[]).join(', ');
            document.getElementById('code-editor').value = currentScript.code;
            document.getElementById('script-id').value = currentScript.id;
            updateMatchVisibility();
        }
    } else {
        // New script
        document.getElementById('meta-language').value = lang;
        document.getElementById('meta-category').value = lang === 'javascript' ? 'browser' : 'external';
        document.getElementById('code-editor').value = TEMPLATES[lang] || TEMPLATES.javascript;
        updateMatchVisibility();
    }

    updateLineNumbers();
    document.getElementById('code-editor').focus();
}

// ============ LINE NUMBERS ============
function updateLineNumbers() {
    const editor = document.getElementById('code-editor');
    const lines = editor.value.split('\n').length;
    const nums = document.getElementById('line-numbers');
    nums.textContent = Array.from({length: lines}, (_, i) => i + 1).join('\n');
}

// ============ SAVE ============
async function saveScript() {
    const editor = document.getElementById('code-editor');
    const name = document.getElementById('meta-name').value || 'Untitled';
    const category = document.getElementById('meta-category').value;
    const language = document.getElementById('meta-language').value;
    const matchVal = document.getElementById('meta-match').value;
    const code = editor.value;

    // Parse description from code comments
    let description = '';
    const descMatch = code.match(/@description\s+(.+)/);
    if (descMatch) description = descMatch[1].trim();

    const scripts = await send({ action: 'getScripts' }) || [];
    const id = document.getElementById('script-id').value;

    if (id) {
        // Update existing
        const idx = scripts.findIndex(s => s.id === id);
        if (idx >= 0) {
            scripts[idx].name = name;
            scripts[idx].code = code;
            scripts[idx].language = language;
            scripts[idx].category = category;
            scripts[idx].description = description;
            scripts[idx].match_patterns = matchVal.split(',').map(m => m.trim()).filter(Boolean);
            scripts[idx].updated_at = new Date().toISOString();
        }
    } else {
        // Create new
        const newScript = {
            id: crypto.randomUUID(),
            name, description, language, category, code,
            enabled: true,
            match_patterns: matchVal.split(',').map(m => m.trim()).filter(Boolean),
            run_at: 'document-idle',
            trigger: 'manual',
            tags: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        scripts.push(newScript);
        document.getElementById('script-id').value = newScript.id;
    }

    await send({ action: 'saveScripts', scripts });
    document.getElementById('script-title').textContent = name;
    dirty = false;
    document.title = `ScriptBridge - ${name}`;

    // Brief flash to confirm save
    const btn = document.getElementById('btn-save');
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.textContent = 'Save (Ctrl+S)'; }, 1500);
}

// ============ VISIBILITY ============
function updateMatchVisibility() {
    const cat = document.getElementById('meta-category').value;
    document.getElementById('meta-match-row').style.display = cat === 'browser' ? 'flex' : 'none';
}

// ============ EVENTS ============
document.addEventListener('DOMContentLoaded', () => {
    const editor = document.getElementById('code-editor');

    // Line numbers sync
    editor.addEventListener('input', () => { updateLineNumbers(); dirty = true; });
    editor.addEventListener('scroll', () => {
        document.getElementById('line-numbers').scrollTop = editor.scrollTop;
    });

    // Tab key
    editor.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = editor.selectionStart;
            editor.value = editor.value.substring(0, start) + '    ' + editor.value.substring(editor.selectionEnd);
            editor.selectionStart = editor.selectionEnd = start + 4;
            updateLineNumbers();
        }
    });

    // Ctrl+S save
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveScript(); }
        if (e.key === 'Escape') { window.close(); }
    });

    // Buttons
    document.getElementById('btn-save').addEventListener('click', saveScript);
    document.getElementById('btn-file').addEventListener('click', saveScript);
    document.getElementById('nav-back').addEventListener('click', () => {
        if (dirty && !confirm('Unsaved changes. Leave anyway?')) return;
        window.location.href = 'dashboard.html';
    });
    document.getElementById('nav-settings').addEventListener('click', () => {
        window.location.href = 'dashboard.html#settings';
    });

    // Meta changes
    document.getElementById('meta-category').addEventListener('change', updateMatchVisibility);
    document.getElementById('meta-language').addEventListener('change', () => {
        const lang = document.getElementById('meta-language').value;
        if (!document.getElementById('script-id').value && !dirty) {
            document.getElementById('code-editor').value = TEMPLATES[lang] || '';
            document.getElementById('meta-category').value = lang === 'javascript' ? 'browser' : 'external';
            updateMatchVisibility();
            updateLineNumbers();
        }
    });
    document.getElementById('meta-name').addEventListener('input', (e) => {
        document.getElementById('script-title').textContent = e.target.value || '<New userscript>';
    });

    init();
});
