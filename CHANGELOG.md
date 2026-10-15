# Changelog

All notable changes to ScriptBridge are documented here.

No release has been published.


## [3.0.0] — unreleased (draft)

First planned public release, and a single version for both parts (previously extension `2.0.0`, companion `1.0.0`). Major version because the security changes below are **incompatible** with the earlier source.

> **Status:** security fixes implemented in source; independent verification and the final test pass are in progress. Not published. See [SECURITY.md](SECURITY.md).

### Security
- **Companion: mandatory token auth on every API route**, including `/api/pair`. `Host` must be `127.0.0.1:9876` or `localhost:9876`; any `Origin` must be a `chrome-extension://` origin, and the paired one outside `/api/pair`. Wildcard CORS removed
- **Pairing:** the companion writes a per-install token to `pairing.json` in its data folder; no HTTP endpoint returns it. The first extension that pairs with it is bound; others get `409`
- **Revocation:** delete `pairing.json` while the companion is stopped. The extension's **Forget Local Token** clears only the extension's copy
- **Schedules paused** when the companion starts without `pairing.json` (first 3.0.0 start or pairing reset), and none run until an extension is paired. Re-create the ones you need
- **Privileged page bridge removed.** No content scripts; `ScriptBridge.run` / `runById` / `notify` are not injected and reject if they ever are. `GM_xmlhttpRequest`, `GM.xmlHttpRequest` and `GM_download` fail as unsupported; `GM_notification` only logs. The `notifications` permission is dropped
- The worker accepts messages only from the extension's own UI pages. The page-reachable `gmXhr`, `gmStorage`, `notify`, `runExternalByName` and direct `applyUpdate` actions are gone
- Updates apply only after review and confirmation on the install page; update checks no longer open tabs. Install and update downloads refuse redirects, credentials, `localhost` and literal private / reserved addresses
- Imported external scripts arrive disabled; only enabled external scripts run, chain, schedule or sync
- Legacy *API auth*, *API token*, *allowed origins* and *CORS* settings (which never did anything) are stripped from `settings.json`
- File watch accepts only drive-letter absolute paths (no UNC, device, drive-relative or alternate-data-stream paths) and refuses the companion's own data folder. Dependency checks use a fixed program allowlist. Script ids are validated

### Changed
- The legacy localhost dashboard, settings page and guide are retired. `http://127.0.0.1:9876/` is a static information page. `companion/ui/` is no longer embedded or served
- GM storage: async `GM.getValue` / `GM.setValue` now use the same page `localStorage` as the sync calls. Values are page-visible and not secret
- Companion pairing page added to the extension dashboard
- Non-working external execution settings (timeout, output limit, admin, working directory) removed from the dashboard and replaced by a warning: no timeout or output cap, closing a stream does not stop the child, env vars can redirect runtimes
- `SCRIPTBRIDGE_DATA_DIR` overrides the data folder (absolute path)
- Minimum Chromium version 103
- Companion dependencies `rust-embed`, `mime_guess` and `tower-http` removed

### Not changed
- Browser userscripts still run in the page's MAIN world and are not sandboxed
- External scripts still run with the full permissions of the Windows user

### Repository
- `tests/security_browser.py` Playwright suite against the real unpacked extension, optionally with a fresh companion binary in a disposable data folder; the old warning-page browser checks are retired
- Full Rust dependency notices in `docs/DEPENDENCY_NOTICES.txt` and Rust standard library notices in `docs/RUST_STDLIB_NOTICES.html`
- Docs rewritten for 3.0.0; the outdated legacy guide and its API examples are no longer shipped


## Pre-3.0.0 source (never released)

Extension `2.0.0` and companion `1.0.0` were prepared for release but held because of an unauthenticated wildcard-CORS companion API and an all-page content bridge. Both are addressed in 3.0.0 above.
