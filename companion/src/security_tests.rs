// Router and pairing tests. Every test uses its own folder under std::env::temp_dir()
// (run with TMP pointing at a scratch folder) and never binds a port or starts a process:
// requests that would execute are either blocked by the guard or refused before spawning.

use super::*;
use axum::body::Body;
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use http_body_util::BodyExt;
use security::*;
use std::path::PathBuf;
use tower::ServiceExt;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const EXT_A: &str = "abcdefghijklmnopabcdefghijklmnop";
const EXT_B: &str = "ponmlkjihgfedcbaponmlkjihgfedcba";

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join("scriptbridge-tests").join(Uuid::new_v4().simple().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }
    fn data_dir(&self) -> String {
        self.0.join("data").to_str().unwrap().replace('\\', "/")
    }
    fn data_path(&self) -> PathBuf {
        PathBuf::from(self.data_dir())
    }
    fn files(&self) -> Vec<PathBuf> {
        fn walk(p: &std::path::Path, out: &mut Vec<PathBuf>) {
            if let Ok(rd) = std::fs::read_dir(p) {
                for e in rd.flatten() {
                    if e.path().is_dir() { walk(&e.path(), out) } else { out.push(e.path()) }
                }
            }
        }
        let mut out = vec![];
        walk(&self.0, &mut out);
        out
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn origin(id: &str) -> String {
    format!("chrome-extension://{id}")
}

fn fixture_script(id: &str, enabled: bool) -> Script {
    let now = Utc::now();
    Script {
        id: id.into(),
        name: format!("fixture-{id}"),
        description: String::new(),
        language: ScriptLanguage::Cmd,
        category: ScriptCategory::External,
        code: "echo fixture-never-run".into(),
        enabled,
        created_at: now,
        updated_at: now,
        match_patterns: vec![],
        run_at: String::new(),
        trigger: ScriptTrigger::Manual,
        last_run: None,
        last_output: None,
        last_exit_code: None,
        watch_path: None,
        watch_modified: None,
        tags: vec![],
        version: None,
        env_vars: HashMap::new(),
        order: 0,
    }
}

fn state_in(tmp: &TempDir, paired: Option<&str>) -> AppState {
    let data_dir = tmp.data_dir();
    let mut scripts = HashMap::new();
    scripts.insert("x".to_string(), fixture_script("x", true));
    scripts.insert("off".to_string(), fixture_script("off", false));
    let mut settings = Settings::default();
    settings.values.insert("theme".into(), serde_json::json!("dark"));
    AppState {
        scripts: Arc::new(Mutex::new(scripts)),
        settings: Arc::new(Mutex::new(settings)),
        history: Arc::new(Mutex::new(vec![])),
        schedules: Arc::new(Mutex::new(vec![Schedule {
            id: "s".into(),
            script_id: "x".into(),
            interval_secs: 60,
            enabled: true,
            last_run: None,
        }])),
        pairing: Arc::new(Pairing::in_memory(TOKEN, paired, Pairing::path_in(&tmp.data_path()))),
        data_dir: Arc::new(data_dir),
    }
}

fn read_token(tmp: &TempDir) -> String {
    let raw = std::fs::read_to_string(tmp.data_path().join("pairing.json")).unwrap();
    serde_json::from_str::<serde_json::Value>(&raw).unwrap()["token"].as_str().unwrap().to_string()
}

struct Req {
    method: Method,
    uri: String,
    headers: Vec<(String, String)>,
    body: Option<serde_json::Value>,
}

fn req(method: Method, uri: &str) -> Req {
    Req { method, uri: uri.into(), headers: vec![("host".into(), "localhost:9876".into())], body: None }
}

impl Req {
    fn h(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.into(), v.into()));
        self
    }
    fn no_host(mut self) -> Self {
        self.headers.retain(|(k, _)| k != "host");
        self
    }
    fn host(self, v: &str) -> Self {
        self.no_host().h("host", v)
    }
    fn auth(self) -> Self {
        self.h("authorization", &format!("Bearer {TOKEN}"))
    }
    fn from(self, id: &str) -> Self {
        self.h("origin", &origin(id))
    }
    fn json(mut self, v: serde_json::Value) -> Self {
        self.body = Some(v);
        self
    }
}

struct Resp {
    status: StatusCode,
    headers: HeaderMap,
    body: String,
}

async fn send(state: &AppState, r: Req) -> Resp {
    let mut b = Request::builder().method(r.method).uri(r.uri);
    for (k, v) in &r.headers {
        b = b.header(k.as_str(), v.as_str());
    }
    let body = match r.body {
        Some(v) => {
            b = b.header("content-type", "application/json");
            Body::from(v.to_string())
        }
        None => Body::empty(),
    };
    let resp = build_router(state.clone()).oneshot(b.body(body).unwrap()).await.unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&bytes).to_string();
    assert!(!body.contains(TOKEN), "response body leaked the token");
    assert!(headers.values().all(|v| !v.to_str().unwrap_or("").contains(TOKEN)), "header leaked the token");
    Resp { status, headers, body }
}

fn acao(r: &Resp) -> Option<String> {
    r.headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).map(|v| v.to_str().unwrap().to_string())
}

fn snapshot(state: &AppState) -> String {
    let scripts = state.scripts.lock().unwrap();
    let mut ids: Vec<_> = scripts.values().map(|s| (s.id.clone(), s.code.clone(), s.enabled, s.watch_path.clone())).collect();
    ids.sort();
    format!(
        "{:?}|{:?}|{:?}|{:?}|{}",
        ids,
        state.settings.lock().unwrap().values,
        state.schedules.lock().unwrap().iter().map(|s| (&s.id, s.enabled)).collect::<Vec<_>>(),
        state.history.lock().unwrap().len(),
        state.pairing.paired_extension().unwrap().unwrap_or_default()
    )
}

// Every route that mutates, executes or reveals data.
fn sensitive_requests() -> Vec<Req> {
    vec![
        req(Method::POST, "/api/scripts/x/run"),
        req(Method::POST, "/api/scripts/x/stream"),
        req(Method::POST, "/api/chain").json(serde_json::json!({ "script_ids": ["x"] })),
        req(Method::POST, "/api/reset"),
        req(Method::POST, "/api/import").json(serde_json::json!({ "scripts": [], "overwrite": true })),
        req(Method::PUT, "/api/settings").json(serde_json::json!({ "settings": {} })),
        req(Method::DELETE, "/api/settings"),
        req(Method::GET, "/api/settings"),
        req(Method::GET, "/api/export"),
        req(Method::GET, "/api/check-dep?kind=exe&name=node"),
        req(Method::GET, "/api/toolchain"),
        req(Method::POST, "/api/schedules").json(serde_json::json!({ "script_id": "x", "interval_secs": 5 })),
        req(Method::DELETE, "/api/schedules/s"),
        req(Method::GET, "/api/schedules"),
        req(Method::POST, "/api/scripts").json(serde_json::json!({
            "name": "n", "description": "", "language": "cmd", "category": "external", "code": "echo"
        })),
        req(Method::PUT, "/api/scripts/x").json(serde_json::json!({ "code": "echo changed" })),
        req(Method::DELETE, "/api/scripts/x"),
        req(Method::POST, "/api/scripts/x/toggle"),
        req(Method::POST, "/api/scripts/x/watch").json(serde_json::json!({ "path": "C:/Windows/win.ini" })),
        req(Method::GET, "/api/scripts/x/check-file"),
        req(Method::GET, "/api/scripts"),
        req(Method::GET, "/api/search?q=fixture"),
        req(Method::GET, "/api/history"),
        req(Method::GET, "/api/ping"),
        req(Method::POST, "/api/pair"),
    ]
}

// --- Token, identifiers, inputs ---

#[test]
fn generated_token_is_two_v4_uuids_as_64_lowercase_hex() {
    let a = generate_token();
    let b = generate_token();
    assert!(is_valid_token(&a) && is_valid_token(&b));
    assert_ne!(a, b);
    assert_eq!(&a[12..13], "4");
    assert_eq!(&a[44..45], "4");
    for bad in ["".to_string(), a[..63].to_string(), a.to_uppercase(), format!("{}g", &a[..63]), format!("{a}0")] {
        assert!(!is_valid_token(&bad), "{bad}");
    }
}

#[test]
fn extension_origin_must_be_exact() {
    assert_eq!(parse_extension_origin(&origin(EXT_A)), Some(EXT_A));
    for bad in [
        "null".to_string(),
        "https://example.com".into(),
        format!("{}/", origin(EXT_A)),
        format!("chrome-extension://{}", EXT_A.to_uppercase()),
        format!("chrome-extension://{}", &EXT_A[..31]),
        format!("chrome-extension://{EXT_A}a"),
        format!("chrome-extension://{}q", &EXT_A[..31]),
        format!("moz-extension://{EXT_A}"),
        format!("CHROME-EXTENSION://{EXT_A}"),
        format!(" chrome-extension://{EXT_A}"),
    ] {
        assert_eq!(parse_extension_origin(&bad), None, "{bad}");
    }
}

#[test]
fn script_ids_used_as_file_stems_reject_traversal_and_devices() {
    for ok in ["x", "abc-DEF_123", "6f9619ff-8b86-4011-b42d-00c04fc964ff", "console", "com10"] {
        assert!(is_valid_script_id(ok), "{ok}");
    }
    let long = "a".repeat(129);
    for bad in ["", "..", "../x", "..\\x", "a/b", "a\\b", "C:x", "a.b", "a b", "con", "NUL", "Com1", "lpt9", "x\0", long.as_str()] {
        assert!(!is_valid_script_id(bad), "{bad}");
    }
}

#[test]
fn dependency_commands_are_allowlisted_and_never_take_options() {
    assert_eq!(dependency_command("exe", "node").unwrap(), ("node", vec!["--version".to_string()]));
    assert_eq!(dependency_command("pip", "requests").unwrap(), ("pip", vec!["show".to_string(), "requests".to_string()]));
    assert_eq!(dependency_command("npm", "@scope/pkg.js").unwrap().0, "npm");
    assert_eq!(dependency_command("cargo", "--anything").unwrap(), ("cargo", vec!["--version".to_string()]));
    let rejected = [
        ("exe", "cmd.exe"), ("exe", "powershell"), ("exe", "C:\\tools\\node.exe"), ("exe", "node --eval"),
        ("exe", "NODE"), ("exe", ""), ("pip", "-r"), ("pip", "--index-url=http://x"), ("pip", "requests==1.0"),
        ("pip", "a b"), ("pip", ""), ("npm", "-g"), ("npm", "--prefix"), ("npm", "@scope"), ("npm", "Upper"),
        ("npm", ".hidden"), ("npm", "a/b"), ("bogus", "node"), ("", ""),
    ];
    for (kind, name) in rejected {
        assert!(dependency_command(kind, name).is_err(), "{kind}:{name}");
    }
}

#[test]
fn data_dir_override_must_be_absolute_and_profile_default_is_unchanged() {
    use std::ffi::OsString;
    let profile = || Some(OsString::from("C:\\Users\\u"));
    assert_eq!(data_dir_from(None, profile()).unwrap(), "C:\\Users\\u/.scriptbridge");
    assert_eq!(data_dir_from(Some(OsString::from("C:\\t\\d")), profile()).unwrap(), "C:\\t\\d");
    assert!(data_dir_from(Some(OsString::from("relative")), profile()).is_err(), "bad override never falls back");
    assert!(data_dir_from(Some(OsString::new()), profile()).is_err());
    assert!(data_dir_from(None, None).is_err());
    assert!(data_dir_from(None, Some(OsString::from("."))).is_err());
}

#[test]
fn watch_paths_reject_unc_relative_streams_and_the_data_folder() {
    let tmp = TempDir::new();
    let data = tmp.data_path();
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("pairing.json"), "{}").unwrap();
    let outside = tmp.0.join("outside.txt");
    std::fs::write(&outside, "hello").unwrap();
    let outside_str = outside.to_str().unwrap().to_string();
    assert!(resolve_watch_path(&outside_str, &data).is_some());

    let pairing = data.join("pairing.json").to_str().unwrap().to_string();
    let dotted = format!("{}/../data/pairing.json", data.to_str().unwrap());
    let stream = format!("{outside_str}:stream");
    let missing = format!("{}/missing.txt", tmp.0.to_str().unwrap());
    for bad in [
        pairing.as_str(), dotted.as_str(), data.to_str().unwrap(),
        "\\\\server\\share\\f.txt", "//server/share/f.txt", "\\\\?\\C:\\Windows\\win.ini", "\\\\.\\pipe\\x",
        "C:relative.txt", "\\rooted.txt", "relative.txt", stream.as_str(), missing.as_str(),
    ] {
        assert!(resolve_watch_path(bad, &data).is_none(), "{bad}");
    }
    assert!(resolve_watch_path(&outside_str, &tmp.0.join("no-such-data-dir")).is_none(), "unresolvable data dir fails closed");
}

// --- pairing.json ---

#[test]
fn pairing_file_is_created_once_and_reloaded_unchanged() {
    let tmp = TempDir::new();
    let dir = tmp.data_path();
    assert!(Pairing::load(&dir).unwrap().is_none());
    let created = Pairing::load_or_create(&dir).unwrap();
    let raw = std::fs::read_to_string(dir.join("pairing.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let token = read_token(&tmp);
    assert!(is_valid_token(&token));
    assert_eq!(v["extension_id"], serde_json::Value::Null);
    assert_eq!(v.as_object().unwrap().len(), 2);
    assert!(created.token_matches(&token));
    assert!(!format!("{created:?}").contains(&token), "Debug must redact the token");

    let again = Pairing::load_or_create(&dir).unwrap();
    assert!(again.token_matches(&token));
    assert_eq!(std::fs::read_to_string(dir.join("pairing.json")).unwrap(), raw);
    assert_eq!(tmp.files().len(), 1, "no temp files left behind");
}

#[test]
fn malformed_or_unreadable_pairing_fails_closed_without_overwrite() {
    let cases = [
        "".to_string(),
        "not json".into(),
        "[]".into(),
        format!(r#"{{"token":"{TOKEN}"}}"#),
        format!(r#"{{"token":"{TOKEN}","extension_id":null,"extra":1}}"#),
        format!(r#"{{"token":"{}","extension_id":null}}"#, TOKEN.to_uppercase()),
        format!(r#"{{"token":"{}","extension_id":null}}"#, &TOKEN[..63]),
        format!(r#"{{"token":"{TOKEN}","extension_id":"ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP"}}"#),
        format!(r#"{{"token":"{TOKEN}","extension_id":"abc"}}"#),
        format!(r#"{{"token":"{TOKEN}","extension_id":5}}"#),
        r#"{"token":null,"extension_id":null}"#.into(),
    ];
    for content in cases {
        let tmp = TempDir::new();
        let dir = tmp.data_path();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pairing.json"), &content).unwrap();
        assert_eq!(Pairing::load_or_create(&dir).unwrap_err(), PairingError::Malformed, "{content}");
        assert_eq!(std::fs::read_to_string(dir.join("pairing.json")).unwrap(), content);
    }

    let tmp = TempDir::new();
    std::fs::create_dir_all(tmp.data_path().join("pairing.json")).unwrap();
    assert_eq!(Pairing::load_or_create(&tmp.data_path()).unwrap_err(), PairingError::Read);

    let tmp = TempDir::new();
    let blocker = tmp.0.join("blocker");
    std::fs::write(&blocker, "").unwrap();
    assert_eq!(Pairing::load_or_create(&blocker.join("data")).unwrap_err(), PairingError::Write);
}

#[test]
fn pair_persists_first_extension_is_idempotent_and_rejects_others() {
    let tmp = TempDir::new();
    let dir = tmp.data_path();
    let p = Pairing::create(&dir).unwrap();
    assert_eq!(p.pair(EXT_A), Ok(PairOutcome::Paired));
    assert_eq!(p.pair(EXT_A), Ok(PairOutcome::AlreadyPaired));
    assert_eq!(p.pair(EXT_B), Err(PairRejection::OtherExtension));
    let reloaded = Pairing::load(&dir).unwrap().unwrap();
    assert_eq!(reloaded.paired_extension().unwrap().as_deref(), Some(EXT_A));
    assert_eq!(tmp.files().len(), 1);

    let unwritable = Pairing::in_memory(TOKEN, None, tmp.0.join("missing-dir").join("pairing.json"));
    assert_eq!(unwritable.pair(EXT_A), Err(PairRejection::Persist));
    assert!(!unwritable.is_paired(), "failed persist must not pair in memory");
}

#[test]
fn concurrent_pairing_has_exactly_one_winner() {
    let tmp = TempDir::new();
    let dir = tmp.data_path();
    let p = Arc::new(Pairing::create(&dir).unwrap());
    let handles: Vec<_> = (0..8u8)
        .map(|i| {
            let id: String = std::iter::repeat((b'a' + i) as char).take(32).collect();
            let p = p.clone();
            std::thread::spawn(move || {
                let r = p.pair(&id);
                (id, r)
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let winners: Vec<_> = results.iter().filter(|(_, r)| *r == Ok(PairOutcome::Paired)).collect();
    assert_eq!(winners.len(), 1);
    assert!(results.iter().filter(|(_, r)| r.is_err()).all(|(_, r)| *r == Err(PairRejection::OtherExtension)));
    let on_disk = Pairing::load(&dir).unwrap().unwrap().paired_extension().unwrap();
    assert_eq!(on_disk.as_deref(), Some(winners[0].0.as_str()));
}

#[test]
fn schedules_are_paused_on_first_pairing_and_never_run_while_unpaired_or_disabled() {
    let tmp = TempDir::new();
    let mut legacy = vec![
        Schedule { id: "a".into(), script_id: "x".into(), interval_secs: 5, enabled: true, last_run: None },
        Schedule { id: "b".into(), script_id: "x".into(), interval_secs: 5, enabled: false, last_run: None },
    ];
    assert!(pause_unpaired_schedules(&mut legacy));
    assert!(legacy.iter().all(|s| !s.enabled));
    assert!(!pause_unpaired_schedules(&mut legacy));

    assert!(due_schedules(&state_in(&tmp, None)).is_empty());
    let paired = state_in(&tmp, Some(EXT_A));
    assert_eq!(due_schedules(&paired).len(), 1);
    paired.schedules.lock().unwrap()[0].script_id = "off".into();
    assert!(due_schedules(&paired).is_empty(), "disabled scripts are not scheduled");
    assert!(tmp.files().is_empty());
}

// --- Router: Host / Origin / Authorization ---

#[tokio::test]
async fn host_must_be_exactly_localhost_or_loopback_9876() {
    let tmp = TempDir::new();
    let state = state_in(&tmp, Some(EXT_A));
    for host in ["localhost:9876", "127.0.0.1:9876"] {
        assert_eq!(send(&state, req(Method::GET, "/api/ping").host(host).auth()).await.status, StatusCode::OK, "{host}");
        assert_eq!(send(&state, req(Method::GET, "/").host(host)).await.status, StatusCode::OK, "{host}");
    }
    for host in [
        "attacker.example:9876", "localhost", "127.0.0.1", "localhost:80", "LOCALHOST:9876", "[::1]:9876",
        "127.0.0.1.nip.io:9876", "localhost:9876.attacker.example", "0.0.0.0:9876", "localhost:09876", "",
    ] {
        for path in ["/api/ping", "/"] {
            let r = send(&state, req(Method::GET, path).host(host).auth()).await;
            assert!(matches!(r.status, StatusCode::FORBIDDEN | StatusCode::BAD_REQUEST), "{host} {path}: {}", r.status);
        }
    }
    assert_eq!(send(&state, req(Method::GET, "/api/ping").no_host().auth()).await.status, StatusCode::BAD_REQUEST);
    let dup = send(&state, req(Method::GET, "/api/ping").h("host", "localhost:9876").auth()).await;
    assert_eq!(dup.status, StatusCode::BAD_REQUEST, "duplicate Host");
    let absolute = send(&state, req(Method::GET, "http://attacker.example:9876/api/ping").auth()).await;
    assert_eq!(absolute.status, StatusCode::BAD_REQUEST, "absolute-form authority must match Host");
}

#[tokio::test]
async fn origins_web_null_and_unpaired_extensions_are_forbidden_even_with_token() {
    let tmp = TempDir::new();
    let state = state_in(&tmp, Some(EXT_A));
    let ok = send(&state, req(Method::GET, "/api/ping").auth().from(EXT_A)).await;
    assert_eq!((ok.status, acao(&ok)), (StatusCode::OK, Some(origin(EXT_A))));
    assert_eq!(ok.body, "pong");
    let cli = send(&state, req(Method::GET, "/api/ping").auth()).await;
    assert_eq!((cli.status, acao(&cli)), (StatusCode::OK, None), "no Origin = authenticated local CLI");

    let other = origin(EXT_B);
    let slash = format!("{}/", origin(EXT_A));
    for o in ["null", "https://attacker.example", "http://localhost:9876", "file://", other.as_str(), slash.as_str()] {
        let r = send(&state, req(Method::GET, "/api/ping").auth().h("origin", o)).await;
        assert_eq!((r.status, acao(&r)), (StatusCode::FORBIDDEN, None), "{o}");
    }
    let dup = send(&state, req(Method::GET, "/api/ping").auth().from(EXT_A).from(EXT_A)).await;
    assert_eq!(dup.status, StatusCode::BAD_REQUEST);

    let unpaired = state_in(&tmp, None);
    let r = send(&unpaired, req(Method::GET, "/api/ping").auth().from(EXT_A)).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "extension must pair before calling the API");
}

#[tokio::test]
async fn authorization_is_header_only_exact_bearer_token() {
    let tmp = TempDir::new();
    let state = state_in(&tmp, Some(EXT_A));
    let values = [
        format!("Bearer {}", "f".repeat(64)),
        format!("bearer {TOKEN}"),
        format!("Bearer  {TOKEN}"),
        format!("Bearer {TOKEN} "),
        format!("Basic {TOKEN}"),
        TOKEN.to_string(),
        format!("Bearer {}", TOKEN.to_uppercase()),
        "Bearer ".to_string(),
    ];
    for value in &values {
        let r = send(&state, req(Method::GET, "/api/ping").from(EXT_A).h("authorization", value)).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{value}");
    }
    let missing = send(&state, req(Method::GET, "/api/ping").from(EXT_A)).await;
    assert_eq!(missing.status, StatusCode::UNAUTHORIZED);
    assert_eq!(missing.headers.get(header::WWW_AUTHENTICATE).unwrap(), "Bearer");
    assert_eq!(acao(&missing), Some(origin(EXT_A)), "paired extension can read its own auth errors");

    for uri in [
        format!("/api/ping?token={TOKEN}"),
        format!("/api/ping?access_token={TOKEN}"),
        format!("/api/ping?authorization=Bearer%20{TOKEN}"),
    ] {
        assert_eq!(send(&state, req(Method::GET, &uri)).await.status, StatusCode::UNAUTHORIZED, "{uri}");
    }
    let cookie = send(&state, req(Method::GET, "/api/ping").h("cookie", &format!("token={TOKEN}"))).await;
    assert_eq!(cookie.status, StatusCode::UNAUTHORIZED);
    assert_eq!(send(&state, req(Method::GET, "/api/ping").auth().auth()).await.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn sensitive_routes_are_blocked_before_side_effects() {
    let tmp = TempDir::new();
    let state = state_in(&tmp, Some(EXT_A));
    let before = snapshot(&state);
    type Variant = fn(Req) -> Req;
    let variants: [(&str, Variant); 7] = [
        ("no auth", |r| r),
        ("no auth, paired origin", |r| r.from(EXT_A)),
        ("web origin + token", |r| r.auth().h("origin", "https://attacker.example")),
        ("null origin + token", |r| r.auth().h("origin", "null")),
        ("other extension + token", |r| r.auth().from(EXT_B)),
        ("rebound host + token", |r| r.auth().host("attacker.example:9876")),
        ("wrong token", |r| r.h("authorization", &format!("Bearer {}", "e".repeat(64)))),
    ];
    for (label, variant) in variants {
        for r in sensitive_requests() {
            let what = format!("{label}: {} {}", r.method, r.uri);
            // A different extension may attempt to pair; it is refused because one is already paired.
            let conflict_ok = r.uri == "/api/pair" && label == "other extension + token";
            let resp = send(&state, variant(r)).await;
            assert!(
                matches!(resp.status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::BAD_REQUEST)
                    || (conflict_ok && resp.status == StatusCode::CONFLICT),
                "{what} -> {}",
                resp.status
            );
            assert!(!resp.body.contains("fixture"), "{what} leaked data");
        }
    }
    assert_eq!(snapshot(&state), before);
    assert!(tmp.files().is_empty(), "blocked requests must not write files: {:?}", tmp.files());
}

#[tokio::test]
async fn all_api_paths_and_methods_require_auth_and_other_paths_404() {
    let tmp = TempDir::new();
    let state = state_in(&tmp, Some(EXT_A));
    for (method, uri) in [
        (Method::PATCH, "/api/scripts"),
        (Method::POST, "/api/ping"),
        (Method::GET, "/api/nope"),
        (Method::GET, "/api/ping?x=1"),
        (Method::GET, "/api/ping/"),
        (Method::OPTIONS, "/api/scripts"),
        (Method::GET, "/api/scripts/x/run"),
    ] {
        assert_eq!(send(&state, req(method.clone(), uri)).await.status, StatusCode::UNAUTHORIZED, "{method} {uri}");
    }
    assert_eq!(send(&state, req(Method::PATCH, "/api/scripts").auth()).await.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(send(&state, req(Method::GET, "/api/nope").auth()).await.status, StatusCode::NOT_FOUND);
    assert_eq!(send(&state, req(Method::GET, "/api/ping?x=1").auth()).await.status, StatusCode::OK);

    for uri in [
        "/index.html", "/app.js", "/settings.html", "/settings.js", "/guide.html", "/style.css", "/api",
        "//api/ping", "/API/ping", "/%61pi/ping", "/x/../api/ping", "/favicon.ico",
    ] {
        assert_eq!(send(&state, req(Method::GET, uri).auth()).await.status, StatusCode::NOT_FOUND, "{uri}");
    }
    for method in [Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS] {
        assert_eq!(send(&state, req(method.clone(), "/").auth()).await.status, StatusCode::NOT_FOUND, "{method} /");
    }
}

#[tokio::test]
async fn root_is_a_static_info_page_without_script_or_framing() {
    let tmp = TempDir::new();
    let state = state_in(&tmp, None);
    let r = send(&state, req(Method::GET, "/")).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.headers[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/html"));
    let csp = r.headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
    assert!(csp.contains("default-src 'none'") && csp.contains("frame-ancestors 'none'"));
    assert_eq!(r.headers[header::X_FRAME_OPTIONS], "DENY");
    assert_eq!(r.headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(acao(&r), None);
    let lower = r.body.to_lowercase();
    for banned in ["<script", "onload", "onclick", "javascript:", "<iframe", "<form", "/api/"] {
        assert!(!lower.contains(banned), "{banned}");
    }
    assert_eq!(send(&state, req(Method::HEAD, "/")).await.status, StatusCode::OK);
    let web = send(&state, req(Method::GET, "/").h("origin", "https://attacker.example")).await;
    assert_eq!(web.status, StatusCode::FORBIDDEN);
}

// --- Router: CORS preflight ---

fn preflight_req(uri: &str, method: &str) -> Req {
    req(Method::OPTIONS, uri)
        .h("access-control-request-method", method)
        .h("access-control-request-headers", "authorization, content-type")
}

#[tokio::test]
async fn preflight_allows_only_paired_origin_known_routes_methods_and_headers() {
    let tmp = TempDir::new();
    let state = state_in(&tmp, Some(EXT_A));
    let before = snapshot(&state);
    for (uri, m) in [
        ("/api/reset", "POST"),
        ("/api/scripts/x/run", "POST"),
        ("/api/settings", "PUT"),
        ("/api/scripts", "GET"),
        ("/api/schedules/s", "DELETE"),
    ] {
        let r = send(&state, preflight_req(uri, m).from(EXT_A)).await;
        assert_eq!(r.status, StatusCode::NO_CONTENT, "{uri}");
        assert_eq!(acao(&r), Some(origin(EXT_A)));
        assert!(r.headers[header::ACCESS_CONTROL_ALLOW_METHODS].to_str().unwrap().contains(m));
        assert_eq!(r.headers[header::ACCESS_CONTROL_ALLOW_HEADERS], "authorization, content-type");
        assert!(r.headers.get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS).is_none());
        assert!(r.body.is_empty());
    }
    let cases: Vec<(&str, Req, StatusCode)> = vec![
        ("web", preflight_req("/api/reset", "POST").h("origin", "https://attacker.example"), StatusCode::FORBIDDEN),
        ("null", preflight_req("/api/reset", "POST").h("origin", "null"), StatusCode::FORBIDDEN),
        ("other ext", preflight_req("/api/reset", "POST").from(EXT_B), StatusCode::FORBIDDEN),
        ("no origin", preflight_req("/api/reset", "POST"), StatusCode::FORBIDDEN),
        ("method", preflight_req("/api/reset", "DELETE").from(EXT_A), StatusCode::METHOD_NOT_ALLOWED),
        ("route", preflight_req("/api/nope", "GET").from(EXT_A), StatusCode::NOT_FOUND),
        ("host", preflight_req("/api/reset", "POST").host("attacker.example:9876").from(EXT_A), StatusCode::FORBIDDEN),
        (
            "header",
            req(Method::OPTIONS, "/api/reset").h("access-control-request-method", "POST").h("access-control-request-headers", "x-evil").from(EXT_A),
            StatusCode::FORBIDDEN,
        ),
        (
            "dup acrm",
            req(Method::OPTIONS, "/api/reset").h("access-control-request-method", "POST").h("access-control-request-method", "POST").from(EXT_A),
            StatusCode::BAD_REQUEST,
        ),
    ];
    for (label, r, want) in cases {
        let resp = send(&state, r).await;
        assert_eq!(resp.status, want, "{label}");
        if want == StatusCode::FORBIDDEN {
            assert_eq!(acao(&resp), None, "{label}");
        }
    }
    assert_eq!(snapshot(&state), before, "preflight never runs a handler");

    let unpaired = state_in(&tmp, None);
    assert_eq!(send(&unpaired, preflight_req("/api/pair", "POST").from(EXT_B)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(send(&unpaired, preflight_req("/api/ping", "GET").from(EXT_B)).await.status, StatusCode::FORBIDDEN);
    let r = send(&state, preflight_req("/api/pair", "POST").from(EXT_B)).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "structurally valid origin may preflight pair");
    assert!(tmp.files().is_empty());
}

// --- Router: pairing ---

#[tokio::test]
async fn pair_endpoint_requires_token_and_extension_origin_and_persists_first_id() {
    let tmp = TempDir::new();
    let mut state = state_in(&tmp, None);
    state.pairing = Arc::new(Pairing::create(&tmp.data_path()).unwrap());
    let token = read_token(&tmp);
    let bearer = format!("Bearer {token}");
    let pair = || req(Method::POST, "/api/pair");
    let wrong = format!("Bearer {}", "a".repeat(64));

    for (label, r, want) in [
        ("no token", pair().from(EXT_A), StatusCode::UNAUTHORIZED),
        ("no origin", pair().h("authorization", &bearer), StatusCode::FORBIDDEN),
        ("web origin", pair().h("authorization", &bearer).h("origin", "https://attacker.example"), StatusCode::FORBIDDEN),
        ("null origin", pair().h("authorization", &bearer).h("origin", "null"), StatusCode::FORBIDDEN),
        ("rebound", pair().h("authorization", &bearer).from(EXT_A).host("attacker.example:9876"), StatusCode::FORBIDDEN),
        ("wrong token", pair().h("authorization", &wrong).from(EXT_A), StatusCode::UNAUTHORIZED),
    ] {
        let r = send(&state, r).await;
        assert_eq!(r.status, want, "{label}");
        assert!(!r.body.contains(&token));
    }
    assert!(!state.pairing.is_paired());

    let first = send(&state, pair().h("authorization", &bearer).from(EXT_A)).await;
    assert_eq!(first.status, StatusCode::OK);
    assert!(!first.body.contains(&token));
    let v: serde_json::Value = serde_json::from_str(&first.body).unwrap();
    assert_eq!(v, serde_json::json!({ "paired": true, "already_paired": false, "extension_id": EXT_A }));
    assert_eq!(acao(&first), Some(origin(EXT_A)));

    let again = send(&state, pair().h("authorization", &bearer).from(EXT_A)).await;
    assert_eq!(serde_json::from_str::<serde_json::Value>(&again.body).unwrap()["already_paired"], true);
    let other = send(&state, pair().h("authorization", &bearer).from(EXT_B)).await;
    assert_eq!(other.status, StatusCode::CONFLICT);
    assert!(!other.body.contains(EXT_A), "conflict does not reveal the paired id");

    let raw = std::fs::read_to_string(tmp.data_path().join("pairing.json")).unwrap();
    let on_disk: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(on_disk, serde_json::json!({ "token": token, "extension_id": EXT_A }));

    let ping = |id: &str| req(Method::GET, "/api/ping").h("authorization", &bearer).from(id);
    assert_eq!(send(&state, ping(EXT_A)).await.status, StatusCode::OK);
    assert_eq!(send(&state, ping(EXT_B)).await.status, StatusCode::FORBIDDEN);
}

// --- Router: authenticated behaviour (no process execution) ---

fn create_body(id: serde_json::Value, watch_path: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "id": id, "name": "n", "description": "", "language": "python", "category": "external",
        "code": "print(1)", "watch_path": watch_path
    })
}

#[tokio::test]
async fn authenticated_crud_validates_ids_and_watch_paths_and_writes_only_temp_dir() {
    let tmp = TempDir::new();
    let state = state_in(&tmp, Some(EXT_A));
    let null = serde_json::Value::Null;
    for (id, wp) in [
        (serde_json::json!("../../evil"), null.clone()),
        (serde_json::json!("a\\b"), null.clone()),
        (serde_json::json!("con"), null.clone()),
        (serde_json::json!(""), null.clone()),
        (serde_json::json!("ok"), serde_json::json!("\\\\server\\share\\x.py")),
        (serde_json::json!("ok"), serde_json::json!("relative.py")),
    ] {
        let r = send(&state, req(Method::POST, "/api/scripts").auth().from(EXT_A).json(create_body(id.clone(), wp.clone()))).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{id} {wp}");
    }
    assert!(tmp.files().is_empty());

    let created = send(&state, req(Method::POST, "/api/scripts").auth().from(EXT_A).json(create_body(serde_json::json!("good-id"), null))).await;
    assert_eq!(created.status, StatusCode::OK);
    let generated = send(
        &state,
        req(Method::POST, "/api/scripts").auth().json(serde_json::json!({
            "name": "n", "description": "", "language": "cmd", "category": "external", "code": "echo"
        })),
    )
    .await;
    let gen_id = serde_json::from_str::<serde_json::Value>(&generated.body).unwrap()["id"].as_str().unwrap().to_string();
    assert!(is_valid_script_id(&gen_id));
    let files = tmp.files();
    assert_eq!(files.len(), 1, "{files:?}");
    assert_eq!(files[0].file_name().unwrap(), "scripts.json");

    let bad_update = send(
        &state,
        req(Method::PUT, "/api/scripts/x").auth().json(serde_json::json!({ "code": "changed", "watch_path": "//host/share/a" })),
    )
    .await;
    assert_eq!(bad_update.status, StatusCode::BAD_REQUEST);
    assert_eq!(state.scripts.lock().unwrap()["x"].code, "echo fixture-never-run", "rejected update must not partially apply");

    let mut evil = fixture_script("x", true);
    evil.id = "..\\..\\evil".into();
    let import_before = snapshot(&state);
    let r = send(
        &state,
        req(Method::POST, "/api/import").auth().json(serde_json::json!({ "scripts": [fixture_script("new-one", true), evil], "overwrite": true })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(snapshot(&state), import_before, "imports are all-or-nothing");
    let ok = send(&state, req(Method::POST, "/api/import").auth().json(serde_json::json!({ "scripts": [fixture_script("new-one", false)] }))).await;
    assert_eq!(serde_json::from_str::<serde_json::Value>(&ok.body).unwrap(), serde_json::json!({ "imported": 1, "skipped": 0 }));
}

#[tokio::test]
async fn watch_and_check_file_refuse_the_pairing_file() {
    let tmp = TempDir::new();
    let mut state = state_in(&tmp, None);
    state.pairing = Arc::new(Pairing::create(&tmp.data_path()).unwrap());
    let token = read_token(&tmp);
    let bearer = format!("Bearer {token}");
    let secret = tmp.data_path().join("pairing.json").to_str().unwrap().to_string();

    for path in [secret.clone(), secret.replace('/', "\\"), format!("{}/../data/pairing.json", tmp.data_dir())] {
        let r = send(&state, req(Method::POST, "/api/scripts/x/watch").h("authorization", &bearer).json(serde_json::json!({ "path": path }))).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{path}");
    }
    state.scripts.lock().unwrap().get_mut("x").unwrap().watch_path = Some(secret);
    let r = send(&state, req(Method::GET, "/api/scripts/x/check-file").h("authorization", &bearer)).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert!(!r.body.contains(&token));
    assert!(!state.scripts.lock().unwrap()["x"].code.contains(&token));
    for uri in ["/api/scripts", "/api/export", "/api/settings"] {
        let r = send(&state, req(Method::GET, uri).h("authorization", &bearer)).await;
        assert!(!r.body.contains(&token), "{uri}");
    }
}

#[tokio::test]
async fn settings_and_export_drop_legacy_security_keys() {
    let tmp = TempDir::new();
    let state = state_in(&tmp, Some(EXT_A));
    let r = send(
        &state,
        req(Method::PUT, "/api/settings").auth().json(serde_json::json!({
            "settings": { "theme": "light", "api_token": "sb_legacy", "api_auth": true, "allow_cors": true, "allowed_origins": "*" },
            "tags": ["t"]
        })),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    let got: serde_json::Value = serde_json::from_str(&send(&state, req(Method::GET, "/api/settings").auth()).await.body).unwrap();
    assert_eq!(got, serde_json::json!({ "settings": { "theme": "light" }, "tags": ["t"] }));

    let export: serde_json::Value = serde_json::from_str(&send(&state, req(Method::GET, "/api/export").auth()).await.body).unwrap();
    assert_eq!(export["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(export["version"], "3.0.0");
    assert_eq!(export["settings"]["values"], serde_json::json!({ "theme": "light" }));
    assert!(!export.to_string().contains("sb_legacy"));

    let settings_path = format!("{}/settings.json", state.data_dir);
    assert!(!std::fs::read_to_string(&settings_path).unwrap().contains("sb_legacy"));
    std::fs::write(&settings_path, r#"{"theme":"dark","api_token":"sb_old","allow_cors":true,"tags":[]}"#).unwrap();
    let loaded = load_settings(&state.data_dir);
    assert_eq!(loaded.values, HashMap::from([("theme".to_string(), serde_json::json!("dark"))]));
}

#[tokio::test]
async fn execution_routes_refuse_disabled_browser_and_invalid_inputs_without_spawning() {
    let tmp = TempDir::new();
    let state = state_in(&tmp, Some(EXT_A));
    let before = snapshot(&state);
    for (r, want) in [
        (req(Method::POST, "/api/scripts/off/run"), StatusCode::CONFLICT),
        (req(Method::POST, "/api/scripts/off/stream"), StatusCode::CONFLICT),
        (req(Method::POST, "/api/scripts/missing/run"), StatusCode::NOT_FOUND),
        (req(Method::POST, "/api/scripts/missing/stream"), StatusCode::NOT_FOUND),
        (req(Method::GET, "/api/check-dep?kind=exe&name=cmd.exe"), StatusCode::BAD_REQUEST),
        (req(Method::GET, "/api/check-dep?kind=exe&name=powershell"), StatusCode::BAD_REQUEST),
        (req(Method::GET, "/api/check-dep?kind=pip&name=--index-url%3Dhttp://x"), StatusCode::BAD_REQUEST),
        (req(Method::GET, "/api/check-dep?kind=npm&name=-g"), StatusCode::BAD_REQUEST),
        (req(Method::GET, "/api/check-dep?kind=shell&name=x"), StatusCode::BAD_REQUEST),
    ] {
        let what = r.uri.clone();
        assert_eq!(send(&state, r.auth().from(EXT_A)).await.status, want, "{what}");
    }
    let chain = send(&state, req(Method::POST, "/api/chain").auth().json(serde_json::json!({ "script_ids": ["x", "off"] }))).await;
    assert_eq!(chain.status, StatusCode::BAD_REQUEST, "chain is validated before the first run");
    let v: serde_json::Value = serde_json::from_str(&chain.body).unwrap();
    assert_eq!(v, serde_json::json!({ "error": "Script is disabled", "script_id": "off" }));

    let mut browser = fixture_script("b", true);
    browser.category = ScriptCategory::Browser;
    state.scripts.lock().unwrap().insert("b".into(), browser);
    assert_eq!(send(&state, req(Method::POST, "/api/scripts/b/run").auth()).await.status, StatusCode::BAD_REQUEST);
    state.scripts.lock().unwrap().remove("b");

    let legacy_bad_id = fixture_script("..\\evil", true);
    assert!(execute_script(&state.data_dir, &legacy_bad_id).await.unwrap_err().contains("Invalid script id"));
    assert_eq!(snapshot(&state), before);
    assert!(tmp.files().is_empty(), "{:?}", tmp.files());
}

// --- Native execution gate, schedules and stale state ---

fn browser_script(id: &str) -> Script {
    let mut s = fixture_script(id, true);
    s.category = ScriptCategory::Browser;
    s.language = ScriptLanguage::JavaScript;
    s
}

#[tokio::test]
async fn browser_disabled_and_missing_scripts_cannot_run_via_any_path() {
    let tmp = TempDir::new();
    let state = state_in(&tmp, Some(EXT_A));
    state.scripts.lock().unwrap().insert("b".into(), browser_script("b"));
    let before = snapshot(&state);

    let chain = |ids: serde_json::Value| req(Method::POST, "/api/chain").auth().json(serde_json::json!({ "script_ids": ids }));
    let too_long: Vec<&str> = vec!["x"; 21];
    for (label, r, want) in [
        ("run browser", req(Method::POST, "/api/scripts/b/run").auth(), StatusCode::BAD_REQUEST),
        ("stream browser", req(Method::POST, "/api/scripts/b/stream").auth(), StatusCode::BAD_REQUEST),
        ("chain browser", chain(serde_json::json!(["x", "b"])), StatusCode::BAD_REQUEST),
        ("chain missing", chain(serde_json::json!(["x", "missing"])), StatusCode::BAD_REQUEST),
        ("chain empty", chain(serde_json::json!([])), StatusCode::BAD_REQUEST),
        ("chain > 20", chain(serde_json::json!(too_long)), StatusCode::BAD_REQUEST),
        ("schedule browser", req(Method::POST, "/api/schedules").auth().json(serde_json::json!({ "script_id": "b", "interval_secs": 5 })), StatusCode::BAD_REQUEST),
        ("schedule disabled", req(Method::POST, "/api/schedules").auth().json(serde_json::json!({ "script_id": "off", "interval_secs": 5 })), StatusCode::BAD_REQUEST),
        ("schedule missing", req(Method::POST, "/api/schedules").auth().json(serde_json::json!({ "script_id": "nope", "interval_secs": 5 })), StatusCode::NOT_FOUND),
    ] {
        assert_eq!(send(&state, r).await.status, want, "{label}");
    }
    assert_eq!(snapshot(&state), before, "nothing ran, nothing was scheduled");
    assert!(state.scripts.lock().unwrap()["x"].last_run.is_none());
    assert!(tmp.files().is_empty(), "{:?}", tmp.files());

    assert_eq!(execute_script(&state.data_dir, &browser_script("b")).await.unwrap_err(), "Browser scripts cannot run in the companion");
    state.schedules.lock().unwrap()[0].script_id = "b".into();
    assert!(due_schedules(&state).is_empty(), "scheduler skips browser scripts");
    state.schedules.lock().unwrap()[0].script_id = "missing".into();
    assert!(due_schedules(&state).is_empty(), "scheduler skips missing scripts");

    let ok = send(&state, req(Method::POST, "/api/schedules").auth().json(serde_json::json!({ "script_id": "x", "interval_secs": 1 }))).await;
    assert_eq!(ok.status, StatusCode::OK);
    assert_eq!(serde_json::from_str::<serde_json::Value>(&ok.body).unwrap()["interval_secs"], 5);
}

#[tokio::test]
async fn deleting_and_recreating_a_script_leaves_no_schedule() {
    let tmp = TempDir::new();
    let state = state_in(&tmp, Some(EXT_A));
    let created = send(&state, req(Method::POST, "/api/schedules").auth().json(serde_json::json!({ "script_id": "x", "interval_secs": 30 }))).await;
    assert_eq!(created.status, StatusCode::OK);
    assert_eq!(state.schedules.lock().unwrap().iter().filter(|s| s.script_id == "x").count(), 2);

    assert_eq!(send(&state, req(Method::DELETE, "/api/scripts/x").auth()).await.status, StatusCode::NO_CONTENT);
    assert!(state.schedules.lock().unwrap().is_empty());
    let recreated = send(&state, req(Method::POST, "/api/scripts").auth().json(serde_json::json!({
        "id": "x", "name": "n", "description": "", "language": "cmd", "category": "external", "code": "echo"
    }))).await;
    assert_eq!(recreated.status, StatusCode::OK);
    assert!(state.schedules.lock().unwrap().is_empty());
    assert!(due_schedules(&state).is_empty());
    let on_disk: Vec<Schedule> = serde_json::from_str(&std::fs::read_to_string(format!("{}/schedules.json", state.data_dir)).unwrap()).unwrap();
    assert!(on_disk.is_empty());
}

#[tokio::test]
async fn reset_clears_scripts_settings_schedules_and_history_but_keeps_pairing() {
    let tmp = TempDir::new();
    let mut state = state_in(&tmp, None);
    state.pairing = Arc::new(Pairing::create(&tmp.data_path()).unwrap());
    state.pairing.pair(EXT_A).unwrap();
    let bearer = format!("Bearer {}", read_token(&tmp));
    state.history.lock().unwrap().push(HistoryEntry {
        id: "h".into(), script_id: "x".into(), script_name: "n".into(), started_at: Utc::now(),
        duration_ms: 1, exit_code: 0, stdout: "out".into(), stderr: String::new(),
    });
    let r = send(&state, req(Method::POST, "/api/reset").h("authorization", &bearer).from(EXT_A)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(state.scripts.lock().unwrap().is_empty());
    assert!(state.schedules.lock().unwrap().is_empty());
    assert!(state.history.lock().unwrap().is_empty());
    assert!(state.settings.lock().unwrap().values.is_empty());
    for f in ["schedules.json", "history.json"] {
        assert_eq!(std::fs::read_to_string(tmp.data_path().join(f)).unwrap().trim(), "[]", "{f}");
    }
    assert!(Pairing::load(&tmp.data_path()).unwrap().unwrap().is_paired(), "reset does not unpair");
}

#[tokio::test]
async fn imports_arrive_disabled_manual_and_overwrites_drop_stale_schedules() {
    let tmp = TempDir::new();
    let state = state_in(&tmp, Some(EXT_A));
    let mut replacement = fixture_script("x", true);
    replacement.trigger = ScriptTrigger::Schedule;
    replacement.code = "echo replaced".into();
    let mut fresh = fixture_script("fresh", true);
    fresh.trigger = ScriptTrigger::OnBrowserEvent;

    let skip = send(&state, req(Method::POST, "/api/import").auth().json(serde_json::json!({ "scripts": [replacement.clone()] }))).await;
    assert_eq!(serde_json::from_str::<serde_json::Value>(&skip.body).unwrap(), serde_json::json!({ "imported": 0, "skipped": 1 }));
    assert_eq!(state.schedules.lock().unwrap().len(), 1, "skipped ids keep their schedules");

    let r = send(&state, req(Method::POST, "/api/import").auth().json(serde_json::json!({ "scripts": [replacement, fresh], "overwrite": true }))).await;
    assert_eq!(serde_json::from_str::<serde_json::Value>(&r.body).unwrap(), serde_json::json!({ "imported": 2, "skipped": 0 }));
    let scripts = state.scripts.lock().unwrap().clone();
    for id in ["x", "fresh"] {
        assert!(!scripts[id].enabled, "{id}");
        assert_eq!(scripts[id].trigger, ScriptTrigger::Manual, "{id}");
    }
    assert_eq!(scripts["x"].code, "echo replaced");
    assert!(state.schedules.lock().unwrap().is_empty(), "replaced id loses its schedules");
    assert_eq!(send(&state, req(Method::POST, "/api/scripts/x/run").auth()).await.status, StatusCode::CONFLICT);
}
