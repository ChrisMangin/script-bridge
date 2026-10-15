// Shared by the service worker (importScripts) and dashboard.html (script tag).
// The pairing token lives only in chrome.storage.local under TOKEN_KEY and never leaves this closure
// except as the Authorization header of requests to the fixed loopback companion origin.
(function (global) {
    'use strict';
    if (global.SBCompanion) return;

    const BASE = 'http://127.0.0.1:9876';
    const ALIAS_ORIGINS = new Set(['http://127.0.0.1:9876', 'http://localhost:9876']);
    const TOKEN_KEY = 'companionToken';
    const TOKEN_RE = /^[0-9a-f]{64}$/;
    const ENCODED_SEPARATOR_RE = /%(?:2e|2f|5c)/i;
    const nativeFetch = global.fetch.bind(global);
    const storage = () => global.chrome.storage.local;

    let accessRestricted = null;
    function restrictStorage() {
        if (!accessRestricted) {
            accessRestricted = Promise.resolve()
                .then(() => storage().setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }))
                .catch(() => {
                    accessRestricted = null;
                    throw new Error('Companion storage could not be restricted to extension pages');
                });
        }
        return accessRestricted;
    }

    async function readToken() {
        await restrictStorage();
        const stored = (await storage().get(TOKEN_KEY))[TOKEN_KEY];
        return typeof stored === 'string' && TOKEN_RE.test(stored) ? stored : null;
    }

    function resolveCompanionUrl(input) {
        const raw = input instanceof URL ? input.href : input;
        if (typeof raw !== 'string') throw new Error('Companion URL rejected');
        let url;
        try { url = new URL(raw, BASE); } catch { throw new Error('Companion URL rejected'); }
        if (!ALIAS_ORIGINS.has(url.origin) || url.username || url.password) throw new Error('Companion URL rejected');
        const rawPath = raw.startsWith('/') ? raw : raw.slice(url.origin.length);
        if (!rawPath.startsWith('/api/') || ENCODED_SEPARATOR_RE.test(rawPath.split(/[?#]/)[0])
            || !url.pathname.startsWith('/api/') || url.pathname.includes('\\')) {
            throw new Error('Companion URL rejected');
        }
        return BASE + url.pathname + url.search;
    }

    function hardened(init, token) {
        const headers = new Headers(init && init.headers);
        headers.set('Authorization', 'Bearer ' + token);
        return { ...init, headers, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' };
    }

    async function companionFetch(input, init) {
        const url = resolveCompanionUrl(input);
        const token = await readToken();
        if (!token) throw new Error('Companion is not paired');
        return nativeFetch(url, hardened(init, token));
    }

    async function pair(token) {
        if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new Error('Pairing token must be 64 lowercase hex characters');
        await restrictStorage();
        let res;
        try {
            res = await nativeFetch(BASE + '/api/pair', hardened({ method: 'POST' }, token));
        } catch {
            throw new Error('Companion pairing request failed');
        }
        if (!res.ok) throw new Error('Companion rejected pairing (HTTP ' + res.status + ')');
        await storage().set({ [TOKEN_KEY]: token });
        return { ok: true };
    }

    async function forget() {
        try { await restrictStorage(); } catch { /* removal only reduces exposure */ }
        await storage().remove(TOKEN_KEY);
        return { ok: true };
    }

    async function isPaired() {
        try { return (await readToken()) !== null; } catch { return false; }
    }

    Object.defineProperty(global, 'SBCompanion', {
        value: Object.freeze({ fetch: companionFetch, pair, forget, isPaired }),
        writable: false,
        configurable: false,
        enumerable: false
    });
    restrictStorage().catch(() => {});
})(globalThis);
