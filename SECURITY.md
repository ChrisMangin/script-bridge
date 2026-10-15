# Security Policy

## Status: 3.0.0

Version 3.0.0 implements authentication and removes the privileged page bridge that blocked the earlier source. Local regression and browser verification are documented in [docs/VERIFICATION.md](docs/VERIFICATION.md). This is not an independent security certification.

This document describes what the code is designed to do. It is not an audit, and it does not claim that ScriptBridge has no vulnerabilities.

### 1. Companion API: authentication enforced

*Was:* `127.0.0.1:9876` accepted any request with wildcard CORS and no token, so any web page in a local browser could create, run, schedule and delete scripts, read local files through file watch, and read script code, env vars and settings.

*Now* (`companion/src/security.rs`, one guard in front of every route):

- **`Host` check.** The `Host` header must be exactly `127.0.0.1:9876` or `localhost:9876`, and appear once. Other hosts get `403`, which blocks DNS rebinding.
- **`Origin` check.** If a request carries an `Origin`, it must be a `chrome-extension://<id>` origin. Web origins get `403`. For every endpoint except `/api/pair`, the id must be the paired extension.
- **Mandatory token.** Every `/api/…` request, including `/api/pair`, must send `Authorization: Bearer <token>`. The token is 64 hex characters, compared in constant time. Missing or wrong tokens get `401`. There is no setting that turns this off.
- **No wildcard CORS.** CORS headers name only the requesting extension origin. Preflights allow only the route's real methods and the `authorization` / `content-type` headers.
- **First-extension pairing.** `/api/pair` needs an extension `Origin` and a valid token. The first extension that pairs is saved in `pairing.json`; another extension then gets `409`. Requests with no `Origin` (local tools) can use the API with the token but cannot pair.
- **Local token file, no HTTP getter.** The companion generates the token on first start and writes it to `pairing.json` in its data folder. No endpoint returns it. The user copies it into the extension's **Companion** page.
- **Revocation.** Delete `pairing.json` while the companion is **stopped**, then start it: a new token is generated and the old pairing is gone. **Forget Local Token** in the extension removes only the extension's copy; it does not unpair the companion.
- **Schedules paused on migration and on pairing reset.** When the companion starts without `pairing.json` (the first 3.0.0 start, or after a reset) it disables every existing schedule, because those schedules may have been created by a web page. No schedule runs until an extension is paired. Re-create the ones you still want from the paired dashboard.
- **Legacy security settings removed.** The old Settings page's *API auth*, *API token*, *allowed origins* and *CORS* values never did anything. They are now stripped from `settings.json` on load and on save.
- **Legacy dashboard retired.** `/` is a static information page with a strict CSP. The old embedded dashboard, settings page and guide are no longer embedded or served; other non-API paths return `404`.
- **Input limits.** Script ids are restricted to safe file names. Dependency checks run only a fixed allowlist of programs with fixed arguments. File watch accepts only drive-letter absolute paths (no UNC or device paths, which could send Windows credentials to a remote host, no drive-relative paths, no alternate data streams) and refuses the companion's own data folder, so `pairing.json` cannot be read back through a script.

### 2. Page bridge: removed by design

*Was:* `content.js` ran on every page and relayed any page script's `postMessage` to the extension to run external scripts, make `GM_xmlhttpRequest` calls with the extension's `<all_urls>` host permissions, use GM storage and show notifications.

*Now* the privileged page bridge is **removed on purpose**, not gated:

- `manifest.json` registers no content scripts and no longer requests `notifications`. `content.js` and `scriptbridge-api.js` are inert and not injected. If `scriptbridge-api.js` were injected, `ScriptBridge.run` / `runById` / `notify` all reject without contacting the extension.
- `gm-polyfill.js` has no channel to the extension. `GM_xmlhttpRequest`, `GM.xmlHttpRequest` and `GM_download` report an error; `GM_notification` only logs.
- `background.js` answers `chrome.runtime` messages only from this extension's own top-frame UI pages (popup, dashboard, editor, install). Everything else gets `Forbidden`.
- External scripts run only from extension UI: the dashboard, the extension context menu, and chains or schedules created there. Only enabled scripts run.

What this does **not** change:

- **Browser userscripts still run in the page's MAIN world.** They are not sandboxed or isolated from the page. The site can observe and interfere with them, and they share the page's trust level.
- **GM values are page-local and visible.** Sync `GM_getValue` / `GM_setValue` and async `GM.getValue` / `GM.setValue` both use the page's `localStorage` (prefix `_SB_GM_`). Any script on that origin can read and change them. They are not a safe place for secrets.

### Other hardening in 3.0.0

- `@updateURL` updates are never applied silently, and update checks no longer open tabs on their own. The dashboard lists available updates; the install page shows a diff, and only the code you reviewed is saved when you confirm.
- Install and update downloads (`script-url-policy.js`) allow only `http(s)` URLs without credentials, refuse redirects, send no credentials, and block `localhost`, `*.localhost` and literal loopback, private, link-local, CGNAT, documentation, multicast and reserved IPv4 addresses and non-global IPv6 addresses. **Limit:** a public hostname whose DNS resolves to a private address is not blocked. Update URLs that redirect (for example Greasy Fork) fail by design, and userscripts served from `localhost` or LAN dev servers can no longer be installed or updated by URL.
- The worker validates every saved script record (id, category, language, field types). Malformed legacy records are hidden and never run, but are left in storage.
- Imported external scripts are disabled, with a manual trigger, until you review and enable them. Companion imports also disable scripts; overwritten ids lose schedules. Deleting a script removes its schedules; resetting data clears schedules and history. Browser-category scripts cannot run natively through run, stream, chain or schedule routes. Chains validate every entry before starting and contain at most 20 scripts.
- Companion requests from the extension go only to the fixed loopback address, with no credentials, no redirects and no caching. The token is kept in `chrome.storage.local` restricted to trusted extension contexts.

## Threat model and limits

The companion is designed for **one trusted Windows account on one machine**. Its goal is to stop **web pages** from reaching native execution. It does not protect against:

- **Other processes running as the same user, or malware.** Anything that can read your profile can read `pairing.json` and use the API.
- **Privileged local processes**, such as administrators or services.
- **Impersonation of the companion.** The API is plain HTTP on loopback. The token authenticates the client to the companion; it does **not** prove the server's identity. A process that takes port 9876 first can pose as the companion and receive the token the extension sends.
- **Multi-user or shared setups.** It is not a multi-user service. Do not share a data folder (`SCRIPTBRIDGE_DATA_DIR`) between accounts.

The protection of `pairing.json`, your scripts and env vars relies on your Windows user profile's file permissions. Env vars and script code are stored as plaintext JSON.

**External scripts are not sandboxed.** They run with your full Windows user permissions. Review any script from an untrusted source before enabling it. **Do not run the companion as Administrator.** In addition:

- There is **no run timeout and no output size cap**. A script that hangs or prints without end keeps running.
- Closing a streamed (SSE) run in the UI does **not** stop the child process.
- Per-script `env_vars` are passed to the runtime and can change what it loads or runs (for example `PATH`, `PYTHONPATH`, `NODE_OPTIONS`). Treat env vars from an untrusted source like code.
- The Rust/C build cache is keyed on a 64-bit FNV-1a hash of the source. It is a cache key, not an integrity check: it does not detect a tampered cached executable in the data folder.
- The old dashboard's execution settings (timeout, output limit, admin, working directory) did nothing and are removed, not implemented.

## Release verification

The release is built from tracked source, with dependency notices matched to Cargo.lock and SHA-256 checksums. See [verification evidence and limits](docs/VERIFICATION.md). Passing tests do not establish that all vulnerabilities are absent.

## Reporting a vulnerability

Report vulnerabilities privately to the maintainer, Chris Mangin. Do not put tokens, private scripts or exploit details in public issues. A dedicated private reporting channel is not configured.
