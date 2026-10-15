# ScriptBridge 3.0.0 verification

Local Windows x64 validation, 2026-10-14. These are regression checks, not a security certification or exhaustive compatibility test.

## Results

- **70 Rust tests passed**, including 28 security/router tests. Tests use disposable directories; they do not start the server or execute scripts.
- **257 JavaScript tests passed** under native Node v24, including 228 extension-security tests, schema validation, URL rules, sender checks and parsing.
- **41 real-browser checks passed** with the actual unpacked extension and optimized companion in a disposable profile/data directory. This includes pairing using Chromium's real extension Origin, rejected unauthenticated/hostile-Origin/rebound-Host requests, token-free exports, disabled native imports, inert hostile metadata, exact reviewed-code updates, page-bridge removal, a manual authenticated CMD echo with SSE output, and forgetting the browser token.
- Browser-only mode separately passed 25 checks without starting the companion.
- Optimized x64 Windows GUI-subsystem build passed with Rust/Cargo 1.97.1. Three pre-existing unused-import warnings remain.
- A separate static review checked the auth guard, page boundary and native execution/schedule gates. It was an AI-assisted code review, not an external penetration test.

## Reproduce

```powershell
node --test tests/*.test.cjs
cargo test --locked --manifest-path companion/Cargo.toml
cargo build --release --locked --manifest-path companion/Cargo.toml
python tests/security_browser.py --browser <Chromium-executable> --companion companion/target/release/script-bridge.exe
```

The browser harness requires Python Playwright. It refuses to start its companion if port 9876 is occupied. It uses a temporary data folder and browser profile, blocks external network resolution/requests, and terminates its own companion afterwards. It executes only a fixed CMD echo fixture. No existing user scripts or data are loaded. Do not replace its isolated data path with a real user profile.

Release packaging uses a clean tracked checkout. Compiler source paths are remapped to avoid publishing the builder's private profile path. The release includes dependency notices tied to Cargo.lock and Rust standard-library notices for the build toolchain. SHA256SUMS.txt records artifact fingerprints. Binaries are unsigned.

## Limits

Only the CMD echo is covered end to end. Python, Rust/C compilation, PowerShell, long-running schedules, every import format, and every supported Chromium version have not all been exercised live. Unit tests check schedule cleanup and execution gates without running scheduled code. CI runs Node/Cargo tests and compilation, not Playwright.

External scripts have full user permissions, with no enforced run timeout/output cap. Closing a streamed run does not stop the child process. This release does not protect against same-user malware or a local process impersonating the companion. See SECURITY.md for all documented trust limits. Passing checks are not a claim that no vulnerabilities remain.
