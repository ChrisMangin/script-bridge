use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

pub const ALLOWED_HOSTS: [&str; 2] = ["localhost:9876", "127.0.0.1:9876"];
pub const PAIRING_FILE: &str = "pairing.json";
const EXTENSION_ORIGIN_PREFIX: &str = "chrome-extension://";
const PREFLIGHT_HEADERS: [&str; 2] = ["authorization", "content-type"];

// Saved only through the old companion Settings page; nothing ever enforced them, and
// keeping them would let a stale "api_token" be read back or exported.
pub const LEGACY_SECURITY_SETTINGS: [&str; 4] = ["allow_cors", "api_auth", "api_token", "allowed_origins"];

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PairingFile {
    token: String,
    extension_id: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum PairingError {
    Read,
    Malformed,
    Write,
}

pub struct Pairing {
    token: String,
    extension_id: Mutex<Option<String>>,
    path: PathBuf,
}

impl std::fmt::Debug for Pairing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pairing").field("token", &"<redacted>").field("path", &self.path).finish()
    }
}

#[derive(Debug, PartialEq)]
pub enum PairOutcome {
    Paired,
    AlreadyPaired,
}

#[derive(Debug, PartialEq)]
pub enum PairRejection {
    OtherExtension,
    Persist,
}

pub fn generate_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

pub fn is_valid_token(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn is_valid_extension_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'a'..=b'p'))
}

pub fn parse_extension_origin(origin: &str) -> Option<&str> {
    origin.strip_prefix(EXTENSION_ORIGIN_PREFIX).filter(|id| is_valid_extension_id(id))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_file_name(format!(".{}.{}.tmp", PAIRING_FILE, Uuid::new_v4().simple()));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

impl Pairing {
    pub fn path_in(data_dir: &Path) -> PathBuf {
        data_dir.join(PAIRING_FILE)
    }

    pub fn load(data_dir: &Path) -> Result<Option<Pairing>, PairingError> {
        let path = Self::path_in(data_dir);
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(PairingError::Read),
        };
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| PairingError::Malformed)?;
        let has_exact_keys = value
            .as_object()
            .is_some_and(|o| o.len() == 2 && o.contains_key("token") && o.contains_key("extension_id"));
        if !has_exact_keys {
            return Err(PairingError::Malformed);
        }
        let file: PairingFile = serde_json::from_value(value).map_err(|_| PairingError::Malformed)?;
        if !is_valid_token(&file.token) {
            return Err(PairingError::Malformed);
        }
        if let Some(id) = &file.extension_id {
            if !is_valid_extension_id(id) {
                return Err(PairingError::Malformed);
            }
        }
        Ok(Some(Pairing { token: file.token, extension_id: Mutex::new(file.extension_id), path }))
    }

    // Caller must hold the single-instance port lock so no other process creates it concurrently.
    // The file inherits the data folder's ACL: it separates this user from web pages, not from
    // other processes running as the same Windows user.
    pub fn create(data_dir: &Path) -> Result<Pairing, PairingError> {
        std::fs::create_dir_all(data_dir).map_err(|_| PairingError::Write)?;
        let path = Self::path_in(data_dir);
        let pairing = Pairing { token: generate_token(), extension_id: Mutex::new(None), path };
        pairing.persist(None).map_err(|_| PairingError::Write)?;
        Ok(pairing)
    }

    pub fn load_or_create(data_dir: &Path) -> Result<Pairing, PairingError> {
        match Self::load(data_dir)? {
            Some(p) => Ok(p),
            None => Self::create(data_dir),
        }
    }

    #[cfg(test)]
    pub fn in_memory(token: &str, extension_id: Option<&str>, path: PathBuf) -> Pairing {
        Pairing { token: token.into(), extension_id: Mutex::new(extension_id.map(Into::into)), path }
    }

    fn persist(&self, extension_id: Option<&str>) -> std::io::Result<()> {
        let file = PairingFile { token: self.token.clone(), extension_id: extension_id.map(Into::into) };
        let data = serde_json::to_vec_pretty(&file).map_err(std::io::Error::other)?;
        write_atomic(&self.path, &data)
    }

    pub fn token_matches(&self, presented: &str) -> bool {
        constant_time_eq(presented.as_bytes(), self.token.as_bytes())
    }

    pub fn paired_extension(&self) -> Result<Option<String>, ()> {
        self.extension_id.lock().map(|g| g.clone()).map_err(|_| ())
    }

    pub fn is_paired(&self) -> bool {
        matches!(self.paired_extension(), Ok(Some(_)))
    }

    pub fn pair(&self, extension_id: &str) -> Result<PairOutcome, PairRejection> {
        let mut current = self.extension_id.lock().map_err(|_| PairRejection::Persist)?;
        match current.as_deref() {
            Some(id) if id == extension_id => Ok(PairOutcome::AlreadyPaired),
            Some(_) => Err(PairRejection::OtherExtension),
            None => {
                self.persist(Some(extension_id)).map_err(|_| PairRejection::Persist)?;
                *current = Some(extension_id.to_string());
                Ok(PairOutcome::Paired)
            }
        }
    }
}

// --- Request guard ---

#[derive(Clone)]
pub struct RequestingExtension(pub String);

fn single_header<'a>(headers: &'a HeaderMap, name: &HeaderName) -> Result<Option<&'a str>, ()> {
    let mut values = headers.get_all(name).iter();
    let first = match values.next() {
        None => return Ok(None),
        Some(v) => v.to_str().map_err(|_| ())?,
    };
    if values.next().is_some() {
        return Err(());
    }
    Ok(Some(first))
}

fn deny(status: StatusCode, message: &'static str, cors_origin: Option<&str>) -> Response {
    let mut resp = (status, Json(serde_json::json!({ "error": message }))).into_response();
    if status == StatusCode::UNAUTHORIZED {
        resp.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
    }
    apply_api_headers(resp.headers_mut(), cors_origin);
    resp
}

fn apply_api_headers(headers: &mut HeaderMap, cors_origin: Option<&str>) {
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    if let Some(origin) = cors_origin.and_then(|o| HeaderValue::from_str(o).ok()) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
}

pub fn allowed_methods(path: &str) -> Option<&'static [Method]> {
    const GET: &[Method] = &[Method::GET];
    const POST: &[Method] = &[Method::POST];
    const DELETE: &[Method] = &[Method::DELETE];
    const GET_POST: &[Method] = &[Method::GET, Method::POST];
    const GET_PUT_DELETE: &[Method] = &[Method::GET, Method::PUT, Method::DELETE];
    let rest = path.strip_prefix("/api/")?;
    let segs: Vec<&str> = rest.split('/').collect();
    if segs.iter().any(|s| s.is_empty()) {
        return None;
    }
    match segs.as_slice() {
        ["scripts"] => Some(GET_POST),
        ["scripts", _] => Some(GET_PUT_DELETE),
        ["scripts", _, "run" | "toggle" | "watch" | "stream"] => Some(POST),
        ["scripts", _, "check-file"] => Some(GET),
        ["browser-scripts" | "export" | "search" | "history" | "check-dep" | "toolchain" | "ping"] => Some(GET),
        ["settings"] => Some(GET_PUT_DELETE),
        ["reset" | "import" | "chain" | "pair"] => Some(POST),
        ["schedules"] => Some(GET_POST),
        ["schedules", _] => Some(DELETE),
        _ => None,
    }
}

fn preflight(req: &Request, path: &str, origin: &str, requested_method: &str) -> Response {
    let Some(methods) = allowed_methods(path) else {
        return deny(StatusCode::NOT_FOUND, "not found", Some(origin));
    };
    let Ok(method) = Method::from_bytes(requested_method.as_bytes()) else {
        return deny(StatusCode::BAD_REQUEST, "invalid preflight", None);
    };
    if !methods.contains(&method) {
        return deny(StatusCode::METHOD_NOT_ALLOWED, "method not allowed", Some(origin));
    }
    let requested_headers = match single_header(req.headers(), &header::ACCESS_CONTROL_REQUEST_HEADERS) {
        Ok(v) => v.unwrap_or(""),
        Err(()) => return deny(StatusCode::BAD_REQUEST, "invalid preflight", None),
    };
    let headers_ok = requested_headers
        .split(',')
        .map(|h| h.trim().to_ascii_lowercase())
        .filter(|h| !h.is_empty())
        .all(|h| PREFLIGHT_HEADERS.contains(&h.as_str()));
    if !headers_ok {
        return deny(StatusCode::FORBIDDEN, "header not allowed", None);
    }
    let allow_methods = methods.iter().map(Method::as_str).collect::<Vec<_>>().join(", ");
    let mut resp = StatusCode::NO_CONTENT.into_response();
    let h = resp.headers_mut();
    apply_api_headers(h, Some(origin));
    h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_str(&allow_methods).expect("static methods"));
    h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("authorization, content-type"));
    h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
    resp
}

pub async fn guard(State(pairing): State<Arc<Pairing>>, mut req: Request, next: Next) -> Response {
    let host = match single_header(req.headers(), &header::HOST) {
        Ok(Some(h)) => h.to_string(),
        Ok(None) => return deny(StatusCode::BAD_REQUEST, "missing host", None),
        Err(()) => return deny(StatusCode::BAD_REQUEST, "invalid host", None),
    };
    if !ALLOWED_HOSTS.contains(&host.as_str()) {
        return deny(StatusCode::FORBIDDEN, "host not allowed", None);
    }
    if let Some(authority) = req.uri().authority() {
        if authority.as_str() != host {
            return deny(StatusCode::BAD_REQUEST, "invalid host", None);
        }
    }

    let origin_id = match single_header(req.headers(), &header::ORIGIN) {
        Err(()) => return deny(StatusCode::BAD_REQUEST, "invalid origin", None),
        Ok(None) => None,
        Ok(Some(o)) => match parse_extension_origin(o) {
            Some(id) => Some(id.to_string()),
            None => return deny(StatusCode::FORBIDDEN, "origin not allowed", None),
        },
    };

    let path = req.uri().path().to_string();
    if !path.starts_with("/api/") {
        if path != "/" || !(req.method() == Method::GET || req.method() == Method::HEAD) {
            return deny(StatusCode::NOT_FOUND, "not found", None);
        }
        let mut resp = next.run(req).await;
        resp.headers_mut().insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
        return resp;
    }

    let is_pair = path == "/api/pair";
    let paired = match pairing.paired_extension() {
        Ok(p) => p,
        Err(()) => return deny(StatusCode::INTERNAL_SERVER_ERROR, "pairing state unavailable", None),
    };
    let origin = origin_id.as_ref().map(|id| format!("{EXTENSION_ORIGIN_PREFIX}{id}"));
    match (&origin_id, is_pair) {
        (None, true) => return deny(StatusCode::FORBIDDEN, "pairing requires an extension origin", None),
        (None, false) | (Some(_), true) => {}
        (Some(id), false) => {
            if paired.as_deref() != Some(id.as_str()) {
                return deny(StatusCode::FORBIDDEN, "extension not paired", None);
            }
        }
    }

    if req.method() == Method::OPTIONS {
        match single_header(req.headers(), &header::ACCESS_CONTROL_REQUEST_METHOD) {
            Err(()) => return deny(StatusCode::BAD_REQUEST, "invalid preflight", None),
            Ok(Some(m)) => {
                let Some(origin) = origin.as_deref() else {
                    return deny(StatusCode::FORBIDDEN, "preflight requires an extension origin", None);
                };
                return preflight(&req, &path, origin, m);
            }
            Ok(None) => {}
        }
    }

    let presented = match single_header(req.headers(), &header::AUTHORIZATION) {
        Err(()) => return deny(StatusCode::BAD_REQUEST, "invalid authorization", origin.as_deref()),
        Ok(None) => return deny(StatusCode::UNAUTHORIZED, "authorization required", origin.as_deref()),
        Ok(Some(v)) => v,
    };
    let authorized = presented
        .strip_prefix("Bearer ")
        .is_some_and(|t| is_valid_token(t) && pairing.token_matches(t));
    if !authorized {
        return deny(StatusCode::UNAUTHORIZED, "invalid token", origin.as_deref());
    }

    if let Some(id) = &origin_id {
        req.extensions_mut().insert(RequestingExtension(id.clone()));
    }
    let mut resp = next.run(req).await;
    apply_api_headers(resp.headers_mut(), origin.as_deref());
    resp
}

pub async fn pair_handler(
    State(pairing): State<Arc<Pairing>>,
    ext: Option<Extension<RequestingExtension>>,
) -> Response {
    let Some(Extension(RequestingExtension(id))) = ext else {
        return deny(StatusCode::FORBIDDEN, "pairing requires an extension origin", None);
    };
    match pairing.pair(&id) {
        Ok(outcome) => Json(serde_json::json!({
            "paired": true,
            "already_paired": outcome == PairOutcome::AlreadyPaired,
            "extension_id": id,
        }))
        .into_response(),
        Err(PairRejection::OtherExtension) => {
            deny(StatusCode::CONFLICT, "companion is paired with a different extension", None)
        }
        Err(PairRejection::Persist) => deny(StatusCode::INTERNAL_SERVER_ERROR, "failed to save pairing", None),
    }
}

// --- Info page (the legacy localhost dashboard is retired) ---

const INFO_PAGE: &str = "<!DOCTYPE html>
<html lang=\"en\">
<head><meta charset=\"utf-8\"><title>ScriptBridge companion</title></head>
<body>
<h1>ScriptBridge companion is running</h1>
<p>This local service has no web dashboard. Manage scripts from the ScriptBridge browser extension.</p>
<p>The extension pairs with this companion using the per-install token stored in <code>pairing.json</code> in the ScriptBridge data folder (normally <code>%USERPROFILE%\\.scriptbridge</code>). Every API request must send that token in an <code>Authorization: Bearer</code> header. Keep the token private.</p>
</body>
</html>
";

pub async fn info_page() -> Response {
    let mut resp = ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], INFO_PAGE).into_response();
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

pub async fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "not found" }))).into_response()
}

// --- Input validation ---

const RESERVED_DEVICE_NAMES: [&str; 4] = ["con", "prn", "aux", "nul"];

// Script ids become file stems under the scripts directory.
pub fn is_valid_script_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    if !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return false;
    }
    let lower = id.to_ascii_lowercase();
    let is_port = (lower.starts_with("com") || lower.starts_with("lpt"))
        && lower.len() == 4
        && lower.as_bytes()[3].is_ascii_digit();
    !(RESERVED_DEVICE_NAMES.contains(&lower.as_str()) || is_port)
}

const EXE_ALLOWLIST: [&str; 10] = ["node", "npm", "python", "python3", "py", "pip", "rustc", "cargo", "gcc", "git"];

fn is_valid_pip_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 100
        && b[0].is_ascii_alphanumeric()
        && b[b.len() - 1].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

fn is_valid_npm_part(part: &str) -> bool {
    let b = part.as_bytes();
    !b.is_empty()
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-' | b'~'))
}

fn is_valid_npm_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 214 {
        return false;
    }
    match name.strip_prefix('@') {
        Some(scoped) => match scoped.split_once('/') {
            Some((scope, pkg)) => is_valid_npm_part(scope) && is_valid_npm_part(pkg),
            None => false,
        },
        None => is_valid_npm_part(name),
    }
}

pub fn dependency_command(kind: &str, name: &str) -> Result<(&'static str, Vec<String>), &'static str> {
    match kind {
        "pip" if is_valid_pip_name(name) => Ok(("pip", vec!["show".into(), name.into()])),
        "npm" if is_valid_npm_name(name) => Ok(("npm", vec!["list".into(), "-g".into(), name.into()])),
        "cargo" => Ok(("cargo", vec!["--version".into()])),
        "exe" => EXE_ALLOWLIST
            .iter()
            .find(|e| **e == name)
            .map(|e| (*e, vec!["--version".to_string()]))
            .ok_or("executable is not on the allowlist"),
        "pip" | "npm" => Err("invalid package name"),
        _ => Err("unknown dependency type"),
    }
}

// Drive-letter absolute paths only: no UNC/device paths (opening them can send NTLM
// credentials to a remote host), no drive-relative paths and no alternate data streams.
pub fn is_local_absolute_path(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() >= 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && matches!(b[2], b'\\' | b'/')
        && !path[2..].contains(':')
        && !path.contains('\0')
}

// The companion's own data folder (pairing.json, stored scripts) must never be read into a
// script, where it could be returned over HTTP. Returns the canonical path to read from;
// anything that cannot be resolved, including the data folder itself, fails closed.
pub fn resolve_watch_path(requested: &str, data_dir: &Path) -> Option<PathBuf> {
    if !is_local_absolute_path(requested) {
        return None;
    }
    let data = std::fs::canonicalize(data_dir).ok()?;
    let target = std::fs::canonicalize(requested).ok()?;
    let target_str = target.to_str()?;
    if target_str.starts_with(r"\\?\UNC\") || target.starts_with(&data) {
        return None;
    }
    Some(target)
}
