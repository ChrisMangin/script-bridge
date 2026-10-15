// ScriptBridge GM_* API Polyfill
// Injected into the page (MAIN world) before userscripts that use GM_* functions.
// It has no channel to the extension: everything here runs with the page's own privileges.

(function() {
    "use strict";
    if (window._SB_GM_POLYFILL) return;
    window._SB_GM_POLYFILL = true;

    const UNSUPPORTED = "ScriptBridge does not support privileged GM network requests; use fetch/XMLHttpRequest subject to the page's CORS rules";
    const unsupportedResult = () => ({ error: UNSUPPORTED, status: 0, statusText: "Unsupported", readyState: 4 });
    const noopHandle = () => ({ abort: function() {} });

    window.GM_xmlhttpRequest = function(details) {
        const result = unsupportedResult();
        setTimeout(() => { if (details && typeof details.onerror === "function") details.onerror(result); }, 0);
        return noopHandle();
    };

    if (!window.GM) window.GM = {};
    window.GM.xmlHttpRequest = function() {
        return Promise.reject(unsupportedResult());
    };

    // GM storage lives in the page's own localStorage: any script on the same origin can read or change it.
    // Do not store secrets here.
    const _gmPrefix = "_SB_GM_";

    window.GM_getValue = function(key, defaultValue) {
        const raw = localStorage.getItem(_gmPrefix + key);
        if (raw === null) return defaultValue;
        try { return JSON.parse(raw); } catch { return raw; }
    };

    window.GM_setValue = function(key, value) {
        localStorage.setItem(_gmPrefix + key, JSON.stringify(value));
    };

    window.GM_deleteValue = function(key) {
        localStorage.removeItem(_gmPrefix + key);
    };

    window.GM_listValues = function() {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(_gmPrefix)) keys.push(k.slice(_gmPrefix.length));
        }
        return keys;
    };

    window.GM.getValue = async (key, defaultValue) => window.GM_getValue(key, defaultValue);
    window.GM.setValue = async (key, value) => window.GM_setValue(key, value);
    window.GM.deleteValue = async (key) => window.GM_deleteValue(key);
    window.GM.listValues = async () => window.GM_listValues();

    window.GM_addStyle = function(css) {
        const style = document.createElement("style");
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
        return style;
    };

    window.GM_setClipboard = function(text) {
        navigator.clipboard.writeText(text).catch(() => {});
    };

    // Extension notifications are unavailable to pages; this only logs.
    window.GM_notification = function(details) {
        if (typeof details === "string") details = { text: details };
        console.info("[ScriptBridge] GM_notification:", (details && (details.title || "ScriptBridge")) + ": " + (details && (details.text || details.body) || ""));
    };

    window.GM_openInTab = function(url) {
        window.open(url, "_blank");
    };

    window.GM_log = console.log.bind(console);

    window.GM_info = { scriptHandler: "ScriptBridge", version: "3.0.0" };
    window.GM.info = window.GM_info;

    window.GM_download = function(details) {
        setTimeout(() => {
            if (details && typeof details.onerror === "function") details.onerror({ error: "not_supported", details: UNSUPPORTED });
        }, 0);
        return noopHandle();
    };

    window.GM_registerMenuCommand = function() {};
    window.GM_unregisterMenuCommand = function() {};

    window.GM_getResourceText = function() { return ''; };
    window.GM_getResourceURL = function() { return ''; };

    window.unsafeWindow = window;
})();
