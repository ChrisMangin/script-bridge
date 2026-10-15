# ScriptBridge 3.0.0

**Version:** `3.0.0` for both the extension (`extension/manifest.json`) and the companion (`companion/Cargo.toml`).

## What it is

- **ScriptBridge extension (primary):** a Manifest V3 userscript manager. It stores browser scripts and injects them on matching pages, with no companion needed.
- **ScriptBridge companion (optional):** a headless Windows program on `127.0.0.1:9876` that runs external Python, PowerShell, CMD, Node, Rust (`rustc`) and C (`gcc`) scripts for the paired extension. It has no window, does not open a browser and serves no web dashboard.

## Security changes

The two issues that held the earlier source are addressed, with local regression and end-to-end verification:

1. **Companion API authentication.** Every API request needs the per-install bearer token. `Host` is limited to `127.0.0.1:9876` / `localhost:9876`; any `Origin` must be the paired extension (or, for `/api/pair`, an extension). No wildcard CORS.
2. **Page bridge removed.** Web pages have no path to extension privileges or native execution. `ScriptBridge.run`, the extension-backed `GM_xmlhttpRequest`, GM storage and notifications relays are gone by design.

Details, including what is **not** protected: [SECURITY.md](https://github.com/ChrisMangin/script-bridge/blob/main/SECURITY.md).

## Upgrading from earlier source (incompatible)

- **Pair the extension.** Start the companion once; it creates `%USERPROFILE%\.scriptbridge\pairing.json`. Copy the `token` value from that file into the dashboard's **Companion** page and click **Pair Companion**. No HTTP endpoint returns the token.
- **Re-create schedules.** On its first 3.0.0 start the companion pauses every existing schedule. The same happens after a pairing reset. Review and re-create the ones you still want.
- **Revoking.** Stop the companion, delete `pairing.json` and restart it. **Forget Local Token** in the extension only clears the extension's copy.
- **Page API gone.** Userscripts that call `window.ScriptBridge.run` / `runById` / `notify`, or rely on `GM_xmlhttpRequest`, `GM_download` or `GM_notification`, need changes. Use `fetch` / `XMLHttpRequest` under the page's CORS rules, and run external scripts from the extension UI.
- **GM values.** Async `GM.getValue` / `GM.setValue` now share page `localStorage` with the sync calls. Values from the old shared extension store are not migrated. Never store secrets in GM values.
- **Legacy dashboard retired.** `http://127.0.0.1:9876/` is a static info page. The old Settings security fields are stripped from `settings.json`.
- **Imports and updates.** Imported external scripts arrive disabled. Updates apply only after you review and confirm the diff. Redirecting update URLs and `localhost` / LAN install URLs are refused.

## Known limitations

- Browser userscripts run in the page's MAIN world and are not sandboxed from the page.
- GM values are stored in page `localStorage` and are visible to the site.
- The companion trusts the local Windows account. It does not protect against same-user malware, privileged local processes or another process taking port 9876 first. The token authenticates the client, not the server. Do not run it as Administrator or share its data folder.
- External scripts run with the user's full permissions. Review untrusted scripts before enabling them. There is no run timeout or output cap, closing a streamed run does not stop the child, and per-script env vars can redirect the runtime.
- The Rust/C build cache key is a 64-bit FNV-1a hash, not an integrity check.
- Install / update URL checks do not catch public hostnames that resolve to private addresses.
- `run_at` is not honored. Scripts run after the page has finished loading.
- Some pages' CSP can block injection. Getting past CSP is not guaranteed.
- C needs `gcc` (for example MinGW-w64). MSVC is not supported.
- The companion is Windows only. The extension needs Chromium 103 or later.

## Release assets

| Asset | Contents |
|---|---|
| `ScriptBridge.exe` | Release build of `companion/` from a clean tracked checkout (Windows x64) |
| `ScriptBridge-v3.0.0-windows-x64.zip` | `ScriptBridge.exe`, the `extension/` folder (without `load-tests.js`), `LICENSE`, `README.md`, `SECURITY.md`, `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md` and `docs/` (release notes, `DEPENDENCY_NOTICES.txt`, `RUST_STDLIB_NOTICES.html`) |
| `ScriptBridge-extension-v3.0.0.zip` | Contents of `extension/` without `load-tests.js`, for Load unpacked or store submission, with `LICENSE` and `THIRD_PARTY_NOTICES.md` (highlight.js BSD-3-Clause notice) |
| `ScriptBridge-THIRD_PARTY_NOTICES.txt` | MIT, dependency and Rust standard-library notices for the standalone executable |
| `SHA256SUMS.txt` | SHA-256 checksums of the assets above |

The standalone `ScriptBridge.exe` asset sits next to the zip, whose notices cover it. `docs/DEPENDENCY_NOTICES.txt` and `docs/RUST_STDLIB_NOTICES.html` must match the `Cargo.lock` and toolchain used for the build.

Do not reuse the stale local `dist/ScriptBridge.exe`. It is untracked, its origin is undocumented, and it predates the current source.

## Verification

See [verification evidence](https://github.com/ChrisMangin/script-bridge/blob/main/docs/VERIFICATION.md) for tested behavior and known limits. Binaries are unsigned Windows x64 builds. Source is MIT licensed. Review scripts before enabling them; native execution is not sandboxed.
