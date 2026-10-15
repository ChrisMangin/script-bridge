# Third-Party Notices

ScriptBridge's own code is MIT licensed (see [LICENSE](LICENSE)). It bundles or links the third-party components below. Most are under permissive MIT / Apache-2.0 terms, but note the **BSD-3-Clause** components, whose license text and copyright notice must travel with any binary or package: highlight.js (bundled in the extension) and the `matchit` crate (linked into the companion, via axum).

## Bundled in the extension

### highlight.js 11.9.0

- Files: `extension/lib/hljs.min.js` (core, header `Highlight.js v11.9.0 (git: f47103d4f1)`, `License: BSD-3-Clause`), `extension/lib/hljs-powershell.min.js` and `extension/lib/hljs-dos.min.js` (headers: grammar "compiled for Highlight.js 11.9.0")
- Upstream: highlightjs/highlight.js, tag `11.9.0`
- License text below is the upstream `LICENSE` file at tag `11.9.0`:

```
BSD 3-Clause License

Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

The minified core header says `(c) 2006-2023 undefined and other contributors`. The "undefined" is an artifact of the upstream build. The license file above is authoritative.

## Linked into the companion binary

The companion statically links Rust crates from crates.io. **Full license texts and copyright notices for every crate are in [docs/DEPENDENCY_NOTICES.txt](docs/DEPENDENCY_NOTICES.txt).** Ship that file, [docs/RUST_STDLIB_NOTICES.html](docs/RUST_STDLIB_NOTICES.html) and `LICENSE` with any companion binary.

How it was produced: the crate graph comes from `companion/Cargo.lock` via `cargo metadata --locked --offline --format-version 1 --filter-platform x86_64-pc-windows-msvc`, keeping normal (non-dev, non-build) dependencies only. The texts are copied from each crate's own `LICENSE*` / `COPYING*` / `COPYRIGHT*` / `NOTICE*` / `UNLICENSE*` files in the local Cargo registry; nothing was downloaded. The file records the SHA-256 of the `Cargo.lock` it was generated from. If the lock changes, regenerate it.

Summary for companion `3.0.0` (see the file for the exact list):

- 58 crates linked into the executable, plus 8 compile-time-only procedural-macro crates and their dependencies (`serde_derive`, `tokio-macros`, `async-trait`, `syn`, `quote`, `proc-macro2`, `rustversion`, `unicode-ident`). These run at build time; the derive and macro crates generate code that is compiled into the binary, so they are included conservatively
- Licenses: mostly `MIT OR Apache-2.0` or `MIT`. Also `matchit` (`MIT AND BSD-3-Clause`, from httprouter), `sync_wrapper` (`Apache-2.0`), `ryu` (`Apache-2.0 OR BSL-1.0`), `memchr` / `aho-corasick` (`Unlicense OR MIT`) and `unicode-ident` (`(MIT OR Apache-2.0) AND Unicode-3.0`)
- Every crate ships a text for each license it declares. 16 crates (including `serde`, `serde_json`, `syn` and `ryu`) ship license texts that name no specific copyright holder; they are flagged in the file and no holder line was invented
- Not covered by `Cargo.lock`: the Microsoft Visual C++ runtime that the MSVC target links against. Its notices are not reproduced

## Rust standard library

The Rust standard library is compiled into the companion executable. It is `MIT OR Apache-2.0` and includes out-of-tree components under their own terms. Its full notices are in [docs/RUST_STDLIB_NOTICES.html](docs/RUST_STDLIB_NOTICES.html), an unmodified copy of `share/doc/rust/COPYRIGHT-library.html` from the local `stable-x86_64-pc-windows-msvc` toolchain (rustc 1.97.1, file SHA-256 `0a65bb747c49c7bb816cbc7188319bd6e4e8d08091c1190b8a3c0971c47968ed`). If the release binary is built with a different toolchain, replace it with that toolchain's copy.

This is a reproduction of upstream notices, not legal advice, and it has not been legally reviewed.
