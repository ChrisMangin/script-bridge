<div align="center">
  <h1>ScriptBridge</h1>
  <p><strong>Browser userscripts for Chromium, with an optional paired local companion for Python, Rust, C, CMD and PowerShell.</strong></p>
  <p>
    <img src="https://img.shields.io/badge/version-3.0.0-blue" alt="Version 3.0.0">
    <img src="https://img.shields.io/badge/platform-Windows-blue" alt="Windows">
    <img src="https://img.shields.io/badge/extension-Manifest%20V3-blue" alt="Manifest V3">
    <img src="https://img.shields.io/badge/companion-Rust-orange" alt="Rust">
    <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License">
  </p>
</div>

> [!IMPORTANT]
> **Version 3.0.0 changes the security boundary.** Pair the optional companion locally before running native scripts. Page-triggered native execution and privileged GM network/storage relays are removed. Native scripts still run with your Windows account's full permissions. Read [SECURITY.md](SECURITY.md) before use.

**[GitHub repository](https://github.com/ChrisMangin/script-bridge)** | **[Release downloads](https://github.com/ChrisMangin/script-bridge/releases)**


ScriptBridge is a Tampermonkey-style userscript manager. **The browser extension is the main app.** It stores your browser scripts and runs them on matching pages. The optional **companion** is a separate headless Windows program. Once paired with the extension, it runs *external* scripts on your machine: Python, Rust, C, CMD, PowerShell and Node.

## Features

### Browser extension (primary)
- Stores scripts in `chrome.storage.local`; the companion is not needed for browser scripts
- URL match patterns (`*` / `?` wildcards) plus a page blacklist
- Dashboard (options page) with All / Browser / External tabs, editor, run-output view and a **Companion** pairing page
- Syntax highlighting with bundled highlight.js 11.9.0 (core plus PowerShell and DOS grammars)
- `.user.js` install interception: going to a `.user.js` URL opens the ScriptBridge install page, which shows the code before you install
- `@updateURL` update checks every 6 hours. The dashboard lists updates; an update is applied only after you open its preview, review the diff and confirm, and the code you saw is the code that is saved. One-step revert to the previous version
- Install and update URLs must be `http(s)` without redirects: `localhost` and literal private/reserved IP addresses are refused (DNS answers are not checked), so redirecting hosts (for example Greasy Fork) and local dev servers cannot be used by URL
- Context menu to inject a browser script, or run an enabled external script when the companion is paired and online
- GM compatibility layer (see [Compatibility limits](#compatibility-limits))

### Companion (optional, headless)
- Rust (axum) server bound to `127.0.0.1:9876`. It has no window and no console, and it **does not open a browser**
- **Every API request needs the per-install pairing token**, and the companion only accepts the one extension it is paired with (see [Pairing the companion](#pairing-the-companion))
- Runs external scripts: Python (`python -B -u`), PowerShell (`-NoProfile -NonInteractive -ExecutionPolicy Bypass`), CMD, Node (`node`), Rust (`rustc`) and C (`gcc`)
- Caches compiled Rust/C builds per script, keyed on a source hash
- Streams output (SSE), runs script chains, runs interval schedules (minimum 5 s), keeps run history
- File watch: reloads a script's code from a local drive-letter path (UNC / device paths and the companion's own data folder are refused)
- Per-script environment variables
- Toolchain and dependency checks against a fixed allowlist (`node`, `python`, `rustc`, `gcc`, `cargo`, `git`, …)
- `http://127.0.0.1:9876/` shows a static information page only. There is no web dashboard and no settings page

### Compatibility limits
- **Browser scripts run in the page's MAIN world.** They are not sandboxed and have exactly the page's privileges: the site's own code can see and tamper with them, and they can see the site.
- **There is no privileged page bridge.** `window.ScriptBridge.run` / `runById` / `notify` always reject. `GM_xmlhttpRequest` / `GM.xmlHttpRequest` / `GM_download` report an error; use `fetch` or `XMLHttpRequest`, which follow the page's CORS rules. `GM_notification` only logs to the console.
- **GM values are page-local.** `GM_getValue` / `GM_setValue` and the async `GM.getValue` / `GM.setValue` both store in the **page's** `localStorage` (prefix `_SB_GM_`). Any script on that origin can read and change them. They are not per-script and **not a place for secrets**.
- **`run_at` is not honored.** `document-start` / `document-end` / `document-idle` are stored and editable, but every browser script is injected after the tab reports `complete`. A shim calls `load` / `DOMContentLoaded` listeners immediately when they are added after load.
- Other GM stubs: `GM_registerMenuCommand` / `GM_unregisterMenuCommand` do nothing. `GM_getResourceText` / `GM_getResourceURL` return `''`. `GM_openInTab` calls `window.open`. `GM_info` has only `scriptHandler` and `version`. `unsafeWindow` is `window`.
- **No CSP bypass guarantee.** Injection first tries `eval` in the page's main world, then falls back to an inline `<script>`. A page whose CSP blocks both will not run the script.
- Injection targets the top frame only.
- C scripts need **`gcc`** (for example MinGW-w64) on `PATH`. **MSVC `cl` is not supported.**
- Needs Chromium 103 or later (`minimum_chrome_version`).

## Quick Start

Download the Windows bundle or extension ZIP from **Release downloads** above, then extract it. The companion is optional and the extension is installed with **Load unpacked**, not through a browser store.

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**
2. Click **Load unpacked** and select the `extension/` folder
3. Pin ScriptBridge and open the dashboard from the popup or the extension's options
4. Create a **Browser** script, set match patterns such as `*://example.com/*`, and save
5. Load a matching page. The script runs once the page has finished loading

External scripts need the companion running **and paired**. Without it, the popup shows the companion as offline or unpaired and browser scripts still work normally.

## Pairing the companion

The companion and the extension share one secret, the **pairing token**. It is a 64-character hex value that the companion generates on first start and writes to `pairing.json` in its data folder (normally `%USERPROFILE%\.scriptbridge\pairing.json`). **No HTTP endpoint returns it.** You copy it yourself, locally.

1. Start `ScriptBridge.exe` from the Windows bundle, or build the companion (see [Building from Source](#building-from-source)). On first start it creates `pairing.json`.
2. Open `pairing.json` in a local editor and copy only the `token` value. Never paste it into a website, chat, script or export.
3. In the extension dashboard, open **Companion**, paste the token into **Local pairing token** and click **Pair Companion**.

How the companion checks requests:

- The `Host` header must be exactly `127.0.0.1:9876` or `localhost:9876`. Anything else is refused, which blocks DNS-rebinding requests.
- A request that carries an `Origin` header must come from a `chrome-extension://` origin, and for every endpoint except `/api/pair` it must be the **paired** extension. Web-page origins are refused. There is no wildcard CORS; CORS headers name only the extension origin.
- Every `/api/…` request, including `/api/pair`, needs `Authorization: Bearer <token>`. Missing or wrong tokens get `401`.
- The **first** extension that pairs with a valid token is stored in `pairing.json`. A different extension then gets `409 Conflict`.
- Local tools without an `Origin` header (for example a PowerShell script you write) can call the API with the token. They cannot pair.

The extension keeps its copy in `chrome.storage.local`, restricted to extension pages, and sends it only to the fixed loopback companion address.

**Forget vs. revoke.** **Forget Local Token** removes only this browser's copy; the companion stays paired with that extension. To revoke the token or pair a different extension: stop the companion, delete `pairing.json`, start it again (a new token is generated) and pair again.

**Schedules after a pairing reset.** When the companion starts without a `pairing.json` (the first start of 3.0.0, or after you deleted it), it pauses every existing schedule, and no schedule runs until an extension has paired. Review the paused schedules and re-create the ones you still want from the paired dashboard.

Deleting a companion script removes its schedules. Companion imports arrive disabled with manual triggers; overwrite imports remove schedules for the replaced ids. Reset clears scripts, settings, schedules and history but preserves pairing. Chains validate all entries first and contain at most 20 scripts.

## Native scripts run with your permissions

External scripts are **not sandboxed**. They run as your Windows account, with your files, network and credentials. Web pages cannot trigger them: they run only from the extension dashboard, the extension's context menu, chains and schedules you set up.

- Review any script from an untrusted source before you enable it. Imported external scripts arrive **disabled** with a manual trigger; only enabled scripts can be run, chained or scheduled.
- **Do not run the companion as Administrator**, and do not point several users at a shared data folder (`SCRIPTBRIDGE_DATA_DIR`).
- There is no run timeout or output cap, and closing a streamed run does not stop the child process.
- Per-script env vars reach the runtime and can redirect it (`PATH`, `PYTHONPATH`, `NODE_OPTIONS`, …). Treat them like code.
- The Rust/C build cache uses a 64-bit FNV-1a source hash as a cache key, not as an integrity check.
- The companion is built for a single, trusted local Windows account. It is not a multi-user service. See [SECURITY.md](SECURITY.md#threat-model-and-limits) for what it does not protect against.

## Building from Source

### Prerequisites
- Windows 10/11 (the companion uses Windows-only process APIs)
- Rust stable toolchain (`cargo`, `rustc`)
- Node.js 22 to run the extension unit tests
- Python with Playwright, and a local Chromium-based browser, for the browser security suite
- Optional runtimes for external scripts, on `PATH`: `python`, `rustc`, `gcc`, `node`. `cmd.exe` and `powershell.exe` ship with Windows

### Companion

```powershell
cargo build --release --locked --manifest-path companion/Cargo.toml
# Output: companion/target/release/script-bridge.exe
```

The binary starts silently and exits silently if port 9876 is already taken. Data is stored in `%USERPROFILE%\.scriptbridge\` (or the absolute path in `SCRIPTBRIDGE_DATA_DIR`): `pairing.json`, `scripts.json`, `settings.json`, `history.json`, `schedules.json` and a `scripts/` folder with generated source files and executables. Keep this folder private to your account.

### Tests

```powershell
node --test tests/*.test.cjs
cargo test --manifest-path companion/Cargo.toml --locked
python tests/security_browser.py --browser <path-to-chrome-or-edge>
python tests/security_browser.py --browser <path-to-chrome-or-edge> --companion companion/target/release/script-bridge.exe
```

`security_browser.py` loads the unpacked extension in a disposable browser profile. With `--companion` it also starts **only** the freshly built binary you name, on a vacant port 9876, with `SCRIPTBRIDGE_DATA_DIR` set to a disposable folder, and runs one fixed CMD echo fixture. Use it only on a disposable setup, never with your real data folder or an already running companion.

`.github/workflows/ci.yml` runs the Node and Cargo tests and a release compile on `windows-latest`. It does not upload artifacts or publish.

### Versions

Release **3.0.0** is a single version for both parts: `extension/manifest.json` and `companion/Cargo.toml`. It is a major version because the security changes are incompatible with 2.x / 1.x: pairing is mandatory, the page bridge is gone and the legacy dashboard is retired.

## Project Structure

```
script-bridge/
├── extension/                # Chromium extension (Manifest V3), primary app
│   ├── manifest.json         # 3.0.0; no content scripts
│   ├── background.js         # Storage, injection, update checks, context menu, trusted-UI message handling
│   ├── companion-client.js   # Token storage and authenticated loopback fetch
│   ├── script-url-policy.js  # URL rules for install and update downloads
│   ├── gm-polyfill.js        # MAIN-world GM_* / GM.* compatibility layer, no extension channel
│   ├── content.js            # Inert, not registered
│   ├── scriptbridge-api.js   # Inert stub, not registered; every call rejects
│   ├── dashboard.*           # Options page, script manager, Companion pairing page
│   ├── editor.*              # Script editor
│   ├── install.*             # .user.js install, update review and rollback page
│   ├── popup.*               # Toolbar popup
│   ├── syntax-highlight.js
│   ├── lib/                  # highlight.js 11.9.0 (BSD-3-Clause)
│   └── icons/
├── companion/                # Optional headless Rust server, 3.0.0
│   ├── src/                  # main.rs, security.rs (pairing and request guard), tests
│   ├── Cargo.toml
│   └── Cargo.lock
├── tests/
│   ├── *.test.cjs            # Node unit and security checks (no browser, no network)
│   └── security_browser.py   # Playwright checks of the real unpacked extension
├── .github/workflows/ci.yml
├── docs/
│   ├── release-notes.md      # 3.0.0 release notes
│   ├── DEPENDENCY_NOTICES.txt # Full license texts for the companion's Rust crates
│   └── RUST_STDLIB_NOTICES.html # Rust standard library notices (toolchain copy)
├── CHANGELOG.md
├── SECURITY.md
├── THIRD_PARTY_NOTICES.md
├── LICENSE
└── README.md
```

`companion/ui/` still exists in the working tree but is **unused**: the companion no longer embeds or serves it. `dist/` and `companion/target/` hold local build output and are not tracked.

## Tech Stack

| Part | Technology |
|---|---|
| Extension | Manifest V3, vanilla JavaScript, `chrome.scripting` / `storage` / `webNavigation` / `contextMenus` / `tabs` |
| Highlighting | highlight.js 11.9.0 (bundled minified build) |
| Companion | Rust 2021, axum 0.7, tokio, serde, chrono, uuid, regex |
| Storage | `chrome.storage.local` (extension); JSON files in `%USERPROFILE%\.scriptbridge` (companion) |

## License

MIT, see [LICENSE](LICENSE). Bundled and linked third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), with full Rust crate license texts in [docs/DEPENDENCY_NOTICES.txt](docs/DEPENDENCY_NOTICES.txt) and Rust standard library notices in [docs/RUST_STDLIB_NOTICES.html](docs/RUST_STDLIB_NOTICES.html).
