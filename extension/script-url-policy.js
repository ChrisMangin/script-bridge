// Shared by the service worker (importScripts) and install.html (script tag): which userscript source URLs
// the extension itself may fetch for install/update. Page userscripts' own @match patterns are unaffected.
(function (global) {
    'use strict';
    if (global.SBScriptUrlPolicy) return;

    const BLOCKED_IPV4_CIDRS = [
        ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
        ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
        ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
    ];

    function ipv4ToInt(text) {
        const parts = text.split('.');
        if (parts.length !== 4 || !parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
        return parts.reduce((acc, p) => acc * 256 + Number(p), 0);
    }

    function isBlockedIpv4(int) {
        return BLOCKED_IPV4_CIDRS.some(([base, bits]) => Math.floor(int / 2 ** (32 - bits)) === Math.floor(ipv4ToInt(base) / 2 ** (32 - bits)));
    }

    // The URL parser has already canonicalised the literal (lowercase, '::' compression, embedded IPv4 as hex).
    function ipv6Groups(text) {
        const [head, tail] = text.includes('::') ? text.split('::') : [text, null];
        const left = head ? head.split(':') : [];
        const right = tail ? tail.split(':') : [];
        const fill = tail === null ? [] : Array(8 - left.length - right.length).fill('0');
        const groups = [...left, ...fill, ...right].map(g => parseInt(g, 16));
        return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
    }

    function isBlockedIpv6(groups) {
        if (!groups) return true;
        const [g0, g1] = groups;
        if ((g0 & 0xe000) !== 0x2000) return true;          // only global unicast 2000::/3 is allowed (blocks ::1, ::ffff:0:0/96, fc00::/7, fe80::/10, ff00::/8)
        if (g0 === 0x2001 && g1 < 0x0200) return true;      // 2001::/23 protocol assignments (Teredo, benchmarking, ORCHID)
        if (g0 === 0x2001 && g1 === 0x0db8) return true;    // documentation
        if (g0 === 0x2002) return true;                     // 6to4 can embed any IPv4 address
        return false;
    }

    // Blocks literal loopback/private/reserved destinations and localhost names only. A public hostname whose DNS
    // answer is a private address (including DNS rebinding) is NOT detected: the extension cannot see resolution results.
    function isBlockedUpdateHost(hostname) {
        const host = hostname.toLowerCase().replace(/\.$/, '');
        if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
        if (host.startsWith('[')) return isBlockedIpv6(ipv6Groups(host.slice(1, -1)));
        const v4 = ipv4ToInt(host);
        return v4 !== null && isBlockedIpv4(v4);
    }

    function fetchableScriptUrl(raw) {
        let url;
        try { url = new URL(raw); } catch { throw new Error('Invalid script URL'); }
        if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
            throw new Error('Script URLs must be http(s) without credentials');
        }
        if (isBlockedUpdateHost(url.hostname)) throw new Error('Script URLs must not target local, private or reserved addresses');
        return url.href;
    }

    Object.defineProperty(global, 'SBScriptUrlPolicy', {
        value: Object.freeze({ fetchableScriptUrl, isBlockedHost: isBlockedUpdateHost }),
        writable: false,
        configurable: false,
        enumerable: false
    });
})(globalThis);
