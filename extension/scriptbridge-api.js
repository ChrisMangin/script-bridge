// Not registered in manifest.json. Page-triggered native execution is intentionally disabled, so if this
// file is ever injected into a page every call rejects without contacting the extension.
(function () {
    'use strict';
    const unavailable = () => Promise.reject(new Error('ScriptBridge page bridge is unavailable: run external scripts from the ScriptBridge extension UI'));
    window.ScriptBridge = Object.freeze({ run: unavailable, runById: unavailable, notify: unavailable });
})();
