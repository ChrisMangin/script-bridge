#![windows_subsystem = "windows"]

mod security;

use axum::{
    extract::{FromRef, Path, State},
    http::StatusCode,
    response::{
        sse::{Event, Sse},
        IntoResponse, Response,
    },
    routing::{delete, get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use security::Pairing;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    convert::Infallible,
    net::TcpListener,
    process::ExitCode,
    sync::{Arc, Mutex},
};
use tokio::io::AsyncBufReadExt;
use tokio::process::Command as AsyncCommand;
use tokio_stream::{wrappers::ReceiverStream, StreamExt};
use uuid::Uuid;

const PORT: u16 = 9876;
const DATA_DIR_OVERRIDE_ENV: &str = "SCRIPTBRIDGE_DATA_DIR";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Script {
    id: String,
    name: String,
    description: String,
    language: ScriptLanguage,
    category: ScriptCategory,
    code: String,
    enabled: bool,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    // Userscript metadata (JS only)
    #[serde(default)]
    match_patterns: Vec<String>,
    #[serde(default)]
    run_at: String,
    // External script config
    #[serde(default)]
    trigger: ScriptTrigger,
    #[serde(default)]
    last_run: Option<DateTime<Utc>>,
    #[serde(default)]
    last_output: Option<String>,
    #[serde(default)]
    last_exit_code: Option<i32>,
    // File watching (dev mode)
    #[serde(default)]
    watch_path: Option<String>,
    #[serde(default)]
    watch_modified: Option<DateTime<Utc>>,
    // Tags
    #[serde(default)]
    tags: Vec<String>,
    // Version tracking
    #[serde(default)]
    version: Option<String>,
    // Per-script environment variables (secrets/config)
    #[serde(default)]
    env_vars: HashMap<String, String>,
    // Manual drag-and-drop ordering
    #[serde(default)]
    order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum ScriptLanguage {
    JavaScript,
    Python,
    Rust,
    C,
    Cmd,
    PowerShell,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum ScriptCategory {
    Browser,
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
enum ScriptTrigger {
    #[default]
    Manual,
    OnBrowserEvent,
    Schedule,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CreateScript {
    #[serde(default)]
    id: Option<String>,
    name: String,
    description: String,
    language: ScriptLanguage,
    category: ScriptCategory,
    code: String,
    #[serde(default)]
    match_patterns: Vec<String>,
    #[serde(default)]
    run_at: String,
    #[serde(default)]
    trigger: ScriptTrigger,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    watch_path: Option<String>,
    #[serde(default)]
    env_vars: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UpdateScript {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    match_patterns: Option<Vec<String>>,
    #[serde(default)]
    run_at: Option<String>,
    #[serde(default)]
    trigger: Option<ScriptTrigger>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    watch_path: Option<String>,
    #[serde(default)]
    env_vars: Option<HashMap<String, String>>,
    #[serde(default)]
    order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RunResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    duration_ms: u64,
}

type ScriptStore = Arc<Mutex<HashMap<String, Script>>>;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Settings {
    #[serde(flatten)]
    values: HashMap<String, serde_json::Value>,
    #[serde(default)]
    tags: Vec<String>,
}

type SettingsStore = Arc<Mutex<Settings>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HistoryEntry {
    id: String,
    script_id: String,
    script_name: String,
    started_at: DateTime<Utc>,
    duration_ms: u64,
    exit_code: i32,
    stdout: String,
    stderr: String,
}
type HistoryStore = Arc<Mutex<Vec<HistoryEntry>>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Schedule {
    id: String,
    script_id: String,
    interval_secs: u64,
    enabled: bool,
    #[serde(default)]
    last_run: Option<DateTime<Utc>>,
}
type ScheduleStore = Arc<Mutex<Vec<Schedule>>>;

#[derive(Clone)]
struct AppState {
    scripts: ScriptStore,
    settings: SettingsStore,
    history: HistoryStore,
    schedules: ScheduleStore,
    data_dir: Arc<String>,
    pairing: Arc<Pairing>,
}

impl FromRef<AppState> for Arc<Pairing> {
    fn from_ref(state: &AppState) -> Self {
        state.pairing.clone()
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let Ok(data_dir) = resolve_data_dir() else {
        return ExitCode::FAILURE;
    };
    // Duplicate instance guard: if the port is taken another instance is running.
    // Holding it also makes this process the only writer of pairing.json.
    let Ok(listener) = TcpListener::bind(format!("127.0.0.1:{}", PORT)) else {
        return ExitCode::SUCCESS;
    };
    if listener.set_nonblocking(true).is_err() {
        return ExitCode::FAILURE;
    }
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
        return ExitCode::FAILURE;
    };

    let mut schedules = load_schedules(&data_dir);
    let pairing = match Pairing::load(std::path::Path::new(&data_dir)) {
        Ok(Some(p)) => p,
        Ok(None) => {
            if pause_unpaired_schedules(&mut schedules) && try_save_json(&data_dir, &get_schedules_path(&data_dir), &schedules).is_err() {
                return ExitCode::FAILURE;
            }
            match Pairing::create(std::path::Path::new(&data_dir)) {
                Ok(p) => p,
                Err(_) => return ExitCode::FAILURE,
            }
        }
        Err(_) => return ExitCode::FAILURE,
    };

    let state = AppState {
        scripts: Arc::new(Mutex::new(load_scripts(&data_dir))),
        settings: Arc::new(Mutex::new(load_settings(&data_dir))),
        history: Arc::new(Mutex::new(load_history(&data_dir))),
        schedules: Arc::new(Mutex::new(schedules)),
        data_dir: Arc::new(data_dir),
        pairing: Arc::new(pairing),
    };

    // Background scheduler: checks every 10s for schedules that are due and runs them
    {
        let sched_state = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                for sched in due_schedules(&sched_state) {
                    let script = {
                        let scripts = sched_state.scripts.lock().unwrap();
                        scripts.get(&sched.script_id).cloned()
                    };
                    if let Some(script) = script {
                        let start = std::time::Instant::now();
                        let result = execute_script(&sched_state.data_dir, &script).await;
                        let duration_ms = start.elapsed().as_millis() as u64;
                        if let Ok((stdout, stderr, code)) = result {
                            record_history(&sched_state, &script, duration_ms, code, &stdout, &stderr);
                            let mut scripts = sched_state.scripts.lock().unwrap();
                            if let Some(s) = scripts.get_mut(&sched.script_id) {
                                s.last_run = Some(Utc::now());
                                s.last_output = Some(stdout);
                                s.last_exit_code = Some(code);
                            }
                            save_scripts(&sched_state.data_dir, &scripts);
                        }
                    }
                    let mut store = sched_state.schedules.lock().unwrap();
                    if let Some(s) = store.iter_mut().find(|s| s.id == sched.id) {
                        s.last_run = Some(Utc::now());
                    }
                    save_schedules(&sched_state.data_dir, &store);
                }
            }
        });
    }

    // Headless: no browser open, no console. Extension handles the UI.
    match axum::serve(listener, build_router(state)).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}

fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/", get(security::info_page))
        .route("/api/pair", post(security::pair_handler))
        .route("/api/scripts", get(list_scripts).post(create_script))
        .route("/api/scripts/:id", get(get_script).put(update_script).delete(delete_script))
        .route("/api/scripts/:id/run", post(run_script))
        .route("/api/scripts/:id/toggle", post(toggle_script))
        .route("/api/browser-scripts", get(get_browser_scripts))
        .route("/api/settings", get(get_settings).put(save_settings_handler).delete(reset_settings))
        .route("/api/reset", post(reset_all_data))
        .route("/api/scripts/:id/watch", post(watch_file))
        .route("/api/scripts/:id/check-file", get(check_file_changes))
        .route("/api/export", get(export_scripts))
        .route("/api/import", post(import_scripts))
        .route("/api/search", get(search_scripts))
        .route("/api/scripts/:id/stream", post(stream_script))
        .route("/api/chain", post(run_chain))
        .route("/api/schedules", get(list_schedules).post(create_schedule))
        .route("/api/schedules/:id", delete(delete_schedule))
        .route("/api/history", get(get_history))
        .route("/api/check-dep", get(check_dependency))
        .route("/api/toolchain", get(check_toolchain))
        .route("/api/ping", get(ping))
        .fallback(security::not_found)
        .layer(axum::middleware::from_fn_with_state(state.pairing.clone(), security::guard))
        .with_state(state)
}

// Schedules created before pairing existed were reachable by any web page, so they stay
// off until the user re-creates them from the paired extension.
fn pause_unpaired_schedules(schedules: &mut [Schedule]) -> bool {
    let mut changed = false;
    for s in schedules.iter_mut().filter(|s| s.enabled) {
        s.enabled = false;
        changed = true;
    }
    changed
}

fn due_schedules(state: &AppState) -> Vec<Schedule> {
    if !state.pairing.is_paired() {
        return Vec::new();
    }
    let scripts = state.scripts.lock().unwrap();
    let store = state.schedules.lock().unwrap();
    store
        .iter()
        .filter(|s| s.enabled && schedule_due(s))
        .filter(|s| scripts.get(&s.script_id).is_some_and(|script| check_runnable(script).is_ok()))
        .cloned()
        .collect()
}

async fn ping() -> &'static str {
    "pong"
}

async fn list_scripts(State(state): State<AppState>) -> Json<Vec<Script>> {
    let store = state.scripts.lock().unwrap();
    let mut scripts: Vec<Script> = store.values().cloned().collect();
    scripts.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Json(scripts)
}

async fn get_script(State(state): State<AppState>, Path(id): Path<String>) -> Result<Json<Script>, StatusCode> {
    let store = state.scripts.lock().unwrap();
    store.get(&id).cloned().map(Json).ok_or(StatusCode::NOT_FOUND)
}

async fn create_script(State(state): State<AppState>, Json(input): Json<CreateScript>) -> Result<Json<Script>, StatusCode> {
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    if !security::is_valid_script_id(&id) || !is_storable_watch_path(input.watch_path.as_deref()) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let now = Utc::now();
    let script = Script {
        id,
        name: input.name,
        description: input.description,
        language: input.language,
        category: input.category,
        code: input.code,
        enabled: true,
        created_at: now,
        updated_at: now,
        match_patterns: input.match_patterns,
        run_at: if input.run_at.is_empty() { "document-idle".into() } else { input.run_at },
        trigger: input.trigger,
        last_run: None,
        last_output: None,
        last_exit_code: None,
        watch_path: input.watch_path,
        watch_modified: None,
        tags: input.tags,
        version: Some("1.0.0".into()),
        env_vars: input.env_vars,
        order: 0,
    };
    let mut store = state.scripts.lock().unwrap();
    store.insert(script.id.clone(), script.clone());
    save_scripts(&state.data_dir, &store);
    Ok(Json(script))
}

async fn update_script(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<UpdateScript>,
) -> Result<Json<Script>, StatusCode> {
    if !is_storable_watch_path(input.watch_path.as_deref()) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut store = state.scripts.lock().unwrap();
    let script = store.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;
    if let Some(name) = input.name { script.name = name; }
    if let Some(desc) = input.description { script.description = desc; }
    if let Some(code) = input.code { script.code = code; }
    if let Some(enabled) = input.enabled { script.enabled = enabled; }
    if let Some(patterns) = input.match_patterns { script.match_patterns = patterns; }
    if let Some(run_at) = input.run_at { script.run_at = run_at; }
    if let Some(trigger) = input.trigger { script.trigger = trigger; }
    if let Some(tags) = input.tags { script.tags = tags; }
    if let Some(wp) = input.watch_path { script.watch_path = if wp.is_empty() { None } else { Some(wp) }; }
    if let Some(env_vars) = input.env_vars { script.env_vars = env_vars; }
    if let Some(order) = input.order { script.order = order; }
    script.updated_at = Utc::now();
    let result = script.clone();
    save_scripts(&state.data_dir, &store);
    Ok(Json(result))
}

fn is_storable_watch_path(path: Option<&str>) -> bool {
    path.map_or(true, |p| p.is_empty() || security::is_local_absolute_path(p))
}

async fn delete_script(State(state): State<AppState>, Path(id): Path<String>) -> StatusCode {
    let mut store = state.scripts.lock().unwrap();
    if store.remove(&id).is_some() {
        save_scripts(&state.data_dir, &store);
        remove_schedules_for(&state, std::slice::from_ref(&id));
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn toggle_script(State(state): State<AppState>, Path(id): Path<String>) -> Result<Json<Script>, StatusCode> {
    let mut store = state.scripts.lock().unwrap();
    let script = store.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;
    script.enabled = !script.enabled;
    script.updated_at = Utc::now();
    let result = script.clone();
    save_scripts(&state.data_dir, &store);
    Ok(Json(result))
}

// Returns only enabled browser (JS) scripts for the extension to inject
async fn get_browser_scripts(State(state): State<AppState>) -> Json<Vec<Script>> {
    let store = state.scripts.lock().unwrap();
    let scripts: Vec<Script> = store
        .values()
        .filter(|s| s.category == ScriptCategory::Browser && s.enabled)
        .cloned()
        .collect();
    Json(scripts)
}

async fn run_script(State(state): State<AppState>, Path(id): Path<String>) -> Result<Json<RunResult>, StatusCode> {
    let script = {
        let store = state.scripts.lock().unwrap();
        store.get(&id).cloned().ok_or(StatusCode::NOT_FOUND)?
    };

    check_runnable(&script).map_err(|e| e.status())?;

    let start = std::time::Instant::now();
    let result = execute_script(&state.data_dir, &script).await;
    let duration_ms = start.elapsed().as_millis() as u64;

    let run_result = match result {
        Ok((stdout, stderr, code)) => {
            // Update last run info
            let mut store = state.scripts.lock().unwrap();
            if let Some(s) = store.get_mut(&id) {
                s.last_run = Some(Utc::now());
                s.last_output = Some(stdout.clone());
                s.last_exit_code = Some(code);
                record_history(&state, s, duration_ms, code, &stdout, &stderr);
                save_scripts(&state.data_dir, &store);
            }
            RunResult { stdout, stderr, exit_code: code, duration_ms }
        }
        Err(e) => RunResult {
            stdout: String::new(),
            stderr: e,
            exit_code: -1,
            duration_ms,
        },
    };

    Ok(Json(run_result))
}

#[derive(Debug, PartialEq)]
enum NotRunnable {
    InvalidId,
    BrowserScript,
    Disabled,
}

impl NotRunnable {
    fn message(&self) -> &'static str {
        match self {
            NotRunnable::InvalidId => "Invalid script id",
            NotRunnable::BrowserScript => "Browser scripts cannot run in the companion",
            NotRunnable::Disabled => "Script is disabled",
        }
    }

    fn status(&self) -> StatusCode {
        match self {
            NotRunnable::Disabled => StatusCode::CONFLICT,
            _ => StatusCode::BAD_REQUEST,
        }
    }
}

// Every native execution path (run, stream, chain, scheduler) goes through this gate.
fn check_runnable(script: &Script) -> Result<(), NotRunnable> {
    if !security::is_valid_script_id(&script.id) {
        return Err(NotRunnable::InvalidId);
    }
    if script.category != ScriptCategory::External {
        return Err(NotRunnable::BrowserScript);
    }
    if !script.enabled {
        return Err(NotRunnable::Disabled);
    }
    Ok(())
}

async fn execute_script(data_dir: &str, script: &Script) -> Result<(String, String, i32), String> {
    check_runnable(script).map_err(|e| e.message().to_string())?;
    let scripts_dir = get_scripts_dir(data_dir);
    let _ = std::fs::create_dir_all(&scripts_dir);

    match script.language {
        ScriptLanguage::Python => {
            let path = format!("{}/{}.py", scripts_dir, script.id);
            std::fs::write(&path, &script.code).map_err(|e| e.to_string())?;
            // Use -B to skip .pyc writing (faster for one-shots), -u for unbuffered
            run_command_env("python", &["-B", "-u", &path], &script.env_vars).await
        }
        ScriptLanguage::PowerShell => {
            let path = format!("{}/{}.ps1", scripts_dir, script.id);
            std::fs::write(&path, &script.code).map_err(|e| e.to_string())?;
            // -NoProfile skips loading profile scripts (big speedup)
            run_command_env("powershell.exe", &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &path], &script.env_vars).await
        }
        ScriptLanguage::Cmd => {
            let path = format!("{}/{}.cmd", scripts_dir, script.id);
            std::fs::write(&path, &script.code).map_err(|e| e.to_string())?;
            run_command_env("cmd.exe", &["/c", &path], &script.env_vars).await
        }
        ScriptLanguage::Rust => {
            let src_path = format!("{}/{}.rs", scripts_dir, script.id);
            let exe_path = format!("{}/{}.exe", scripts_dir, script.id);
            let hash_path = format!("{}/{}.hash", scripts_dir, script.id);

            // Build cache: skip compile if source hash matches
            let code_hash = format!("{:x}", md5_hash(script.code.as_bytes()));
            let cached = std::fs::read_to_string(&hash_path).unwrap_or_default();
            let exe_exists = std::path::Path::new(&exe_path).exists();

            if cached == code_hash && exe_exists {
                // Cache hit: skip compilation
                return run_command_env(&exe_path, &[], &script.env_vars).await;
            }

            std::fs::write(&src_path, &script.code).map_err(|e| e.to_string())?;
            // -C opt-level=0 for fastest compile (no optimizations needed for scripts)
            let compile = run_command("rustc", &["-C", "opt-level=0", "-C", "debuginfo=0", &src_path, "-o", &exe_path]).await?;
            if compile.2 != 0 {
                return Ok(compile);
            }
            // Save hash for cache
            let _ = std::fs::write(&hash_path, &code_hash);
            run_command_env(&exe_path, &[], &script.env_vars).await
        }
        ScriptLanguage::C => {
            let src_path = format!("{}/{}.c", scripts_dir, script.id);
            let exe_path = format!("{}/{}_c.exe", scripts_dir, script.id);
            let hash_path = format!("{}/{}_c.hash", scripts_dir, script.id);

            // Build cache
            let code_hash = format!("{:x}", md5_hash(script.code.as_bytes()));
            let cached = std::fs::read_to_string(&hash_path).unwrap_or_default();
            let exe_exists = std::path::Path::new(&exe_path).exists();

            if cached == code_hash && exe_exists {
                return run_command_env(&exe_path, &[], &script.env_vars).await;
            }

            std::fs::write(&src_path, &script.code).map_err(|e| e.to_string())?;
            // -O0 for fastest compile
            let compile = run_command("gcc", &["-O0", &src_path, "-o", &exe_path]).await?;
            if compile.2 != 0 {
                return Ok(compile);
            }
            let _ = std::fs::write(&hash_path, &code_hash);
            run_command_env(&exe_path, &[], &script.env_vars).await
        }
        ScriptLanguage::JavaScript => {
            let path = format!("{}/{}.js", scripts_dir, script.id);
            std::fs::write(&path, &script.code).map_err(|e| e.to_string())?;
            run_command_env("node", &[&path], &script.env_vars).await
        }
    }
}

// Simple hash for build caching (not crypto, just change detection)
fn md5_hash(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &byte in data {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

async fn run_command(program: &str, args: &[&str]) -> Result<(String, String, i32), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let output = AsyncCommand::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await
        .map_err(|e| format!("Failed to execute {}: {}", program, e))?;

    Ok((
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code().unwrap_or(-1),
    ))
}

fn absolute_utf8_dir(value: std::ffi::OsString) -> Result<String, &'static str> {
    let dir = value.into_string().map_err(|_| "data directory is not valid UTF-8")?;
    if dir.is_empty() || !std::path::Path::new(&dir).is_absolute() {
        return Err("data directory must be an absolute path");
    }
    Ok(dir)
}

fn data_dir_from(override_dir: Option<std::ffi::OsString>, user_profile: Option<std::ffi::OsString>) -> Result<String, &'static str> {
    if let Some(dir) = override_dir {
        return absolute_utf8_dir(dir);
    }
    let home = absolute_utf8_dir(user_profile.ok_or("USERPROFILE is not set")?)?;
    Ok(format!("{}/.scriptbridge", home))
}

fn resolve_data_dir() -> Result<String, &'static str> {
    data_dir_from(std::env::var_os(DATA_DIR_OVERRIDE_ENV), std::env::var_os("USERPROFILE"))
}

fn get_scripts_dir(data_dir: &str) -> String {
    format!("{}/scripts", data_dir)
}

fn get_db_path(data_dir: &str) -> String {
    format!("{}/scripts.json", data_dir)
}

fn try_save_json<T: Serialize>(data_dir: &str, path: &str, value: &T) -> Result<(), ()> {
    std::fs::create_dir_all(data_dir).map_err(|_| ())?;
    let data = serde_json::to_string_pretty(value).map_err(|_| ())?;
    std::fs::write(path, data).map_err(|_| ())
}

fn load_scripts(data_dir: &str) -> HashMap<String, Script> {
    let path = get_db_path(data_dir);
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn save_scripts(data_dir: &str, scripts: &HashMap<String, Script>) {
    let _ = try_save_json(data_dir, &get_db_path(data_dir), scripts);
}

fn get_settings_path(data_dir: &str) -> String {
    format!("{}/settings.json", data_dir)
}

fn strip_legacy_security_settings(values: &mut HashMap<String, serde_json::Value>) {
    for key in security::LEGACY_SECURITY_SETTINGS {
        values.remove(key);
    }
}

fn load_settings(data_dir: &str) -> Settings {
    let path = get_settings_path(data_dir);
    let mut settings: Settings = match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => Settings::default(),
    };
    strip_legacy_security_settings(&mut settings.values);
    settings
}

fn persist_settings(data_dir: &str, settings: &Settings) {
    let _ = try_save_json(data_dir, &get_settings_path(data_dir), settings);
}

#[derive(Deserialize)]
struct SettingsPayload {
    settings: HashMap<String, serde_json::Value>,
    #[serde(default)]
    tags: Vec<String>,
}

async fn get_settings(State(state): State<AppState>) -> Json<serde_json::Value> {
    let s = state.settings.lock().unwrap();
    Json(serde_json::json!({
        "settings": s.values,
        "tags": s.tags
    }))
}

async fn save_settings_handler(State(state): State<AppState>, Json(input): Json<SettingsPayload>) -> StatusCode {
    let mut values = input.settings;
    strip_legacy_security_settings(&mut values);
    let mut s = state.settings.lock().unwrap();
    s.values = values;
    s.tags = input.tags;
    persist_settings(&state.data_dir, &s);
    StatusCode::OK
}

async fn reset_settings(State(state): State<AppState>) -> StatusCode {
    let mut s = state.settings.lock().unwrap();
    *s = Settings::default();
    persist_settings(&state.data_dir, &s);
    StatusCode::OK
}

async fn reset_all_data(State(state): State<AppState>) -> StatusCode {
    // Clear scripts
    let mut scripts = state.scripts.lock().unwrap();
    scripts.clear();
    save_scripts(&state.data_dir, &scripts);
    {
        let mut schedules = state.schedules.lock().unwrap();
        schedules.clear();
        save_schedules(&state.data_dir, &schedules);
    }
    {
        let mut history = state.history.lock().unwrap();
        history.clear();
        save_history(&state.data_dir, &history);
    }
    // Clear settings
    let mut settings = state.settings.lock().unwrap();
    *settings = Settings::default();
    persist_settings(&state.data_dir, &settings);
    // Delete script files
    let dir = get_scripts_dir(&state.data_dir);
    let _ = std::fs::remove_dir_all(&dir);
    StatusCode::OK
}

// --- File Watching ---

#[derive(Deserialize)]
struct WatchRequest {
    path: String,
}

async fn watch_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<WatchRequest>,
) -> Result<Json<Script>, StatusCode> {
    let resolved = security::resolve_watch_path(&input.path, std::path::Path::new(state.data_dir.as_str()))
        .ok_or(StatusCode::FORBIDDEN)?;
    let mut store = state.scripts.lock().unwrap();
    let script = store.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;

    // Read the file and update the script code
    let content = std::fs::read_to_string(&resolved).map_err(|_| StatusCode::BAD_REQUEST)?;
    let modified = std::fs::metadata(&resolved)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| DateTime::<Utc>::from(t));

    script.code = content;
    script.watch_path = Some(input.path);
    script.watch_modified = modified;
    script.updated_at = Utc::now();
    let result = script.clone();
    save_scripts(&state.data_dir, &store);
    Ok(Json(result))
}

async fn check_file_changes(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let mut store = state.scripts.lock().unwrap();
    let script = store.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;

    let watch_path = script.watch_path.clone().ok_or(StatusCode::BAD_REQUEST)?;
    let resolved = security::resolve_watch_path(&watch_path, std::path::Path::new(state.data_dir.as_str()))
        .ok_or(StatusCode::FORBIDDEN)?;
    let current_modified = std::fs::metadata(&resolved)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| DateTime::<Utc>::from(t));

    let changed = match (current_modified, script.watch_modified) {
        (Some(current), Some(last)) => current > last,
        (Some(_), None) => true,
        _ => false,
    };

    if changed {
        if let Ok(content) = std::fs::read_to_string(&resolved) {
            script.code = content.clone();
            script.watch_modified = current_modified;
            script.updated_at = Utc::now();
            save_scripts(&state.data_dir, &store);
            return Ok(Json(serde_json::json!({ "changed": true, "code": content })));
        }
    }

    Ok(Json(serde_json::json!({ "changed": false })))
}

// --- Import/Export ---

async fn export_scripts(State(state): State<AppState>) -> Json<serde_json::Value> {
    let store = state.scripts.lock().unwrap();
    let settings = state.settings.lock().unwrap();
    let scripts: Vec<Script> = store.values().cloned().collect();
    Json(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "exported_at": Utc::now(),
        "scripts": scripts,
        "settings": { "values": settings.values, "tags": settings.tags }
    }))
}

#[derive(Deserialize)]
struct ImportPayload {
    scripts: Vec<Script>,
    #[serde(default)]
    overwrite: bool,
}

async fn import_scripts(
    State(state): State<AppState>,
    Json(input): Json<ImportPayload>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !input.scripts.iter().all(|s| security::is_valid_script_id(&s.id) && is_storable_watch_path(s.watch_path.as_deref())) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut store = state.scripts.lock().unwrap();
    let mut imported = 0;
    let mut skipped = 0;

    let mut replaced = Vec::new();
    for mut script in input.scripts {
        if store.contains_key(&script.id) {
            if !input.overwrite {
                skipped += 1;
                continue;
            }
            replaced.push(script.id.clone());
        }
        // Imported code must be reviewed and enabled explicitly before it can run.
        script.enabled = false;
        script.trigger = ScriptTrigger::Manual;
        store.insert(script.id.clone(), script);
        imported += 1;
    }
    save_scripts(&state.data_dir, &store);
    remove_schedules_for(&state, &replaced);
    Ok(Json(serde_json::json!({ "imported": imported, "skipped": skipped })))
}

// --- Search ---

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    #[serde(default)]
    regex: bool,
}

async fn search_scripts(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<SearchQuery>,
) -> Json<Vec<Script>> {
    let store = state.scripts.lock().unwrap();
    let scripts: Vec<Script> = if query.regex {
        // Regex search
        if let Ok(re) = regex::Regex::new(&query.q) {
            store.values()
                .filter(|s| {
                    re.is_match(&s.name) || re.is_match(&s.description) || re.is_match(&s.code)
                })
                .cloned()
                .collect()
        } else {
            vec![]
        }
    } else {
        // Plain text search (case-insensitive)
        let q = query.q.to_lowercase();
        store.values()
            .filter(|s| {
                s.name.to_lowercase().contains(&q)
                    || s.description.to_lowercase().contains(&q)
                    || s.code.to_lowercase().contains(&q)
                    || s.tags.iter().any(|t| t.to_lowercase().contains(&q))
            })
            .cloned()
            .collect()
    };
    Json(scripts)
}

// --- Execution History ---

fn get_history_path(data_dir: &str) -> String {
    format!("{}/history.json", data_dir)
}

fn load_history(data_dir: &str) -> Vec<HistoryEntry> {
    let path = get_history_path(data_dir);
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn save_history(data_dir: &str, history: &Vec<HistoryEntry>) {
    let _ = try_save_json(data_dir, &get_history_path(data_dir), history);
}

// Truncate long output so history.json doesn't grow unbounded
fn truncate_output(s: &str) -> String {
    const MAX: usize = 5000;
    if s.chars().count() > MAX {
        let truncated: String = s.chars().take(MAX).collect();
        format!("{}\n... (truncated)", truncated)
    } else {
        s.to_string()
    }
}

fn record_history(state: &AppState, script: &Script, duration_ms: u64, exit_code: i32, stdout: &str, stderr: &str) {
    let entry = HistoryEntry {
        id: Uuid::new_v4().to_string(),
        script_id: script.id.clone(),
        script_name: script.name.clone(),
        started_at: Utc::now(),
        duration_ms,
        exit_code,
        stdout: truncate_output(stdout),
        stderr: truncate_output(stderr),
    };
    let mut h = state.history.lock().unwrap();
    h.insert(0, entry);
    const MAX_ENTRIES: usize = 300;
    if h.len() > MAX_ENTRIES {
        h.truncate(MAX_ENTRIES);
    }
    save_history(&state.data_dir, &h);
}

async fn get_history(State(state): State<AppState>) -> Json<Vec<HistoryEntry>> {
    let h = state.history.lock().unwrap();
    Json(h.clone())
}

// --- Script Chaining ---

#[derive(Debug, Deserialize)]
struct ChainRequest {
    script_ids: Vec<String>,
}

const MAX_CHAIN_LEN: usize = 20;

fn validate_chain(state: &AppState, ids: &[String]) -> Result<(), serde_json::Value> {
    if ids.is_empty() || ids.len() > MAX_CHAIN_LEN {
        return Err(serde_json::json!({ "error": format!("A chain must contain 1 to {MAX_CHAIN_LEN} scripts") }));
    }
    let store = state.scripts.lock().unwrap();
    for id in ids {
        let problem = match store.get(id) {
            None => "Script not found",
            Some(script) => match check_runnable(script) {
                Ok(()) => continue,
                Err(e) => e.message(),
            },
        };
        return Err(serde_json::json!({ "error": problem, "script_id": id }));
    }
    Ok(())
}

async fn run_chain(State(state): State<AppState>, Json(input): Json<ChainRequest>) -> Response {
    if let Err(body) = validate_chain(&state, &input.script_ids) {
        return (StatusCode::BAD_REQUEST, Json(body)).into_response();
    }
    let mut results: Vec<serde_json::Value> = Vec::new();

    for id in input.script_ids {
        let script = {
            let store = state.scripts.lock().unwrap();
            store.get(&id).cloned()
        };
        let script = match script {
            Some(s) => s,
            None => {
                results.push(serde_json::json!({ "script_id": id, "error": "Script not found" }));
                break;
            }
        };

        let start = std::time::Instant::now();
        let result = execute_script(&state.data_dir, &script).await;
        let duration_ms = start.elapsed().as_millis() as u64;

        match result {
            Ok((stdout, stderr, code)) => {
                record_history(&state, &script, duration_ms, code, &stdout, &stderr);
                {
                    let mut store = state.scripts.lock().unwrap();
                    if let Some(s) = store.get_mut(&script.id) {
                        s.last_run = Some(Utc::now());
                        s.last_output = Some(stdout.clone());
                        s.last_exit_code = Some(code);
                        save_scripts(&state.data_dir, &store);
                    }
                }
                let stop = code != 0;
                results.push(serde_json::json!({
                    "script_id": script.id,
                    "script_name": script.name,
                    "stdout": stdout,
                    "stderr": stderr,
                    "exit_code": code,
                    "duration_ms": duration_ms
                }));
                if stop {
                    break;
                }
            }
            Err(e) => {
                results.push(serde_json::json!({
                    "script_id": script.id,
                    "script_name": script.name,
                    "error": e
                }));
                break;
            }
        }
    }

    Json(serde_json::json!({ "results": results })).into_response()
}

// --- Scheduling ---

fn get_schedules_path(data_dir: &str) -> String {
    format!("{}/schedules.json", data_dir)
}

fn load_schedules(data_dir: &str) -> Vec<Schedule> {
    let path = get_schedules_path(data_dir);
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn save_schedules(data_dir: &str, schedules: &Vec<Schedule>) {
    let _ = try_save_json(data_dir, &get_schedules_path(data_dir), schedules);
}

fn schedule_due(s: &Schedule) -> bool {
    match s.last_run {
        None => true,
        Some(last) => {
            let elapsed = (Utc::now() - last).num_seconds().max(0) as u64;
            elapsed >= s.interval_secs
        }
    }
}

#[derive(Debug, Deserialize)]
struct CreateSchedule {
    script_id: String,
    interval_secs: u64,
    #[serde(default = "default_enabled")]
    enabled: bool,
}

fn default_enabled() -> bool {
    true
}

async fn list_schedules(State(state): State<AppState>) -> Json<Vec<Schedule>> {
    Json(state.schedules.lock().unwrap().clone())
}

async fn create_schedule(State(state): State<AppState>, Json(input): Json<CreateSchedule>) -> Result<Json<Schedule>, StatusCode> {
    let scripts = state.scripts.lock().unwrap();
    match scripts.get(&input.script_id) {
        None => return Err(StatusCode::NOT_FOUND),
        Some(script) => check_runnable(script).map_err(|_| StatusCode::BAD_REQUEST)?,
    }
    let sched = Schedule {
        id: Uuid::new_v4().to_string(),
        script_id: input.script_id,
        interval_secs: input.interval_secs.max(5), // don't allow tighter than 5s
        enabled: input.enabled,
        last_run: None,
    };
    let mut store = state.schedules.lock().unwrap();
    store.push(sched.clone());
    save_schedules(&state.data_dir, &store);
    Ok(Json(sched))
}

// Callers hold the scripts lock, so the lock order (scripts, then schedules) matches the scheduler.
fn remove_schedules_for(state: &AppState, script_ids: &[String]) {
    if script_ids.is_empty() {
        return;
    }
    let mut store = state.schedules.lock().unwrap();
    let before = store.len();
    store.retain(|s| !script_ids.contains(&s.script_id));
    if store.len() != before {
        save_schedules(&state.data_dir, &store);
    }
}

async fn delete_schedule(State(state): State<AppState>, Path(id): Path<String>) -> StatusCode {
    let mut store = state.schedules.lock().unwrap();
    let before = store.len();
    store.retain(|s| s.id != id);
    save_schedules(&state.data_dir, &store);
    if store.len() < before { StatusCode::NO_CONTENT } else { StatusCode::NOT_FOUND }
}

// --- Live Output Streaming ---

async fn run_command_env(program: &str, args: &[&str], envs: &HashMap<String, String>) -> Result<(String, String, i32), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = AsyncCommand::new(program);
    cmd.args(args);
    cmd.creation_flags(CREATE_NO_WINDOW);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to execute {}: {}", program, e))?;

    Ok((
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code().unwrap_or(-1),
    ))
}

// Compile Rust/C scripts without running them (used by streaming, which runs the exe separately)
async fn compile_for_stream(data_dir: &str, script: &Script) -> Result<String, String> {
    let scripts_dir = get_scripts_dir(data_dir);
    let _ = std::fs::create_dir_all(&scripts_dir);
    match script.language {
        ScriptLanguage::Rust => {
            let src_path = format!("{}/{}.rs", scripts_dir, script.id);
            let exe_path = format!("{}/{}.exe", scripts_dir, script.id);
            let hash_path = format!("{}/{}.hash", scripts_dir, script.id);
            let code_hash = format!("{:x}", md5_hash(script.code.as_bytes()));
            let cached = std::fs::read_to_string(&hash_path).unwrap_or_default();
            if cached == code_hash && std::path::Path::new(&exe_path).exists() {
                return Ok(exe_path);
            }
            std::fs::write(&src_path, &script.code).map_err(|e| e.to_string())?;
            let compile = run_command("rustc", &["-C", "opt-level=0", "-C", "debuginfo=0", &src_path, "-o", &exe_path]).await?;
            if compile.2 != 0 {
                return Err(format!("Compile failed:\n{}", compile.1));
            }
            let _ = std::fs::write(&hash_path, &code_hash);
            Ok(exe_path)
        }
        ScriptLanguage::C => {
            let src_path = format!("{}/{}.c", scripts_dir, script.id);
            let exe_path = format!("{}/{}_c.exe", scripts_dir, script.id);
            let hash_path = format!("{}/{}_c.hash", scripts_dir, script.id);
            let code_hash = format!("{:x}", md5_hash(script.code.as_bytes()));
            let cached = std::fs::read_to_string(&hash_path).unwrap_or_default();
            if cached == code_hash && std::path::Path::new(&exe_path).exists() {
                return Ok(exe_path);
            }
            std::fs::write(&src_path, &script.code).map_err(|e| e.to_string())?;
            let compile = run_command("gcc", &["-O0", &src_path, "-o", &exe_path]).await?;
            if compile.2 != 0 {
                return Err(format!("Compile failed:\n{}", compile.1));
            }
            let _ = std::fs::write(&hash_path, &code_hash);
            Ok(exe_path)
        }
        _ => Err("Not a compiled language".into()),
    }
}

async fn stream_script(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let script = {
        let store = state.scripts.lock().unwrap();
        match store.get(&id).cloned() {
            Some(s) => s,
            None => return StatusCode::NOT_FOUND.into_response(),
        }
    };
    if let Err(e) = check_runnable(&script) {
        return (e.status(), Json(serde_json::json!({ "error": e.message() }))).into_response();
    }

    let scripts_dir = get_scripts_dir(&state.data_dir);
    let _ = std::fs::create_dir_all(&scripts_dir);

    // Resolve program + args to run, writing script file to disk first (compiling if needed)
    let prep: Result<(String, Vec<String>), String> = match script.language {
        ScriptLanguage::Python => {
            let path = format!("{}/{}.py", scripts_dir, script.id);
            std::fs::write(&path, &script.code)
                .map(|_| ("python".to_string(), vec!["-B".to_string(), "-u".to_string(), path]))
                .map_err(|e| e.to_string())
        }
        ScriptLanguage::PowerShell => {
            let path = format!("{}/{}.ps1", scripts_dir, script.id);
            std::fs::write(&path, &script.code)
                .map(|_| {
                    (
                        "powershell.exe".to_string(),
                        vec![
                            "-NoProfile".to_string(),
                            "-NonInteractive".to_string(),
                            "-ExecutionPolicy".to_string(),
                            "Bypass".to_string(),
                            "-File".to_string(),
                            path,
                        ],
                    )
                })
                .map_err(|e| e.to_string())
        }
        ScriptLanguage::Cmd => {
            let path = format!("{}/{}.cmd", scripts_dir, script.id);
            std::fs::write(&path, &script.code)
                .map(|_| ("cmd.exe".to_string(), vec!["/c".to_string(), path]))
                .map_err(|e| e.to_string())
        }
        ScriptLanguage::JavaScript => {
            let path = format!("{}/{}.js", scripts_dir, script.id);
            std::fs::write(&path, &script.code)
                .map(|_| ("node".to_string(), vec![path]))
                .map_err(|e| e.to_string())
        }
        ScriptLanguage::Rust | ScriptLanguage::C => {
            compile_for_stream(&state.data_dir, &script).await.map(|exe| (exe, vec![]))
        }
    };

    let (program, args) = match prep {
        Ok(pa) => pa,
        Err(e) => {
            let stream = tokio_stream::once(Ok::<Event, Infallible>(Event::default().event("error").data(e)));
            return Sse::new(stream).into_response();
        }
    };

    let (tx, rx) = tokio::sync::mpsc::channel::<String>(200);
    let envs = script.env_vars.clone();

    tokio::spawn(async move {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut cmd = AsyncCommand::new(&program);
        cmd.args(&args);
        cmd.creation_flags(CREATE_NO_WINDOW);
        for (k, v) in &envs {
            cmd.env(k, v);
        }
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        match cmd.spawn() {
            Ok(mut child) => {
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();

                let out_task = stdout.map(|out| {
                    let tx1 = tx.clone();
                    tokio::spawn(async move {
                        let mut lines = tokio::io::BufReader::new(out).lines();
                        while let Ok(Some(line)) = lines.next_line().await {
                            let _ = tx1.send(format!("OUT|{}", line)).await;
                        }
                    })
                });
                let err_task = stderr.map(|err| {
                    let tx2 = tx.clone();
                    tokio::spawn(async move {
                        let mut lines = tokio::io::BufReader::new(err).lines();
                        while let Ok(Some(line)) = lines.next_line().await {
                            let _ = tx2.send(format!("ERR|{}", line)).await;
                        }
                    })
                });

                if let Some(t) = out_task { let _ = t.await; }
                if let Some(t) = err_task { let _ = t.await; }

                let status = child.wait().await;
                let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
                let _ = tx.send(format!("DONE|{}", code)).await;
            }
            Err(e) => {
                let _ = tx.send(format!("ERR|Failed to start: {}", e)).await;
                let _ = tx.send("DONE|-1".to_string()).await;
            }
        }
    });

    let stream = ReceiverStream::new(rx).map(|line| Ok::<Event, Infallible>(Event::default().data(line)));
    Sse::new(stream)
        .keep_alive(axum::response::sse::KeepAlive::default())
        .into_response()
}

// --- Dependency Checking (@require) ---

#[derive(Debug, Deserialize)]
struct CheckDepQuery {
    kind: String,
    name: String,
}

async fn check_dependency(axum::extract::Query(q): axum::extract::Query<CheckDepQuery>) -> Response {
    let (program, args) = match security::dependency_command(&q.kind, &q.name) {
        Ok(cmd) => cmd,
        Err(reason) => {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "ok": false, "output": reason }))).into_response()
        }
    };
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    match run_command(program, &args_ref).await {
        Ok((stdout, stderr, code)) => Json(serde_json::json!({
            "ok": code == 0,
            "output": if code == 0 { stdout } else { stderr }
        }))
        .into_response(),
        Err(e) => Json(serde_json::json!({ "ok": false, "output": e })).into_response(),
    }
}


// --- Toolchain Status ---

async fn check_toolchain() -> Json<serde_json::Value> {
    let tools = vec![
        ("node", "node", vec!["--version"]),
        ("python", "python", vec!["--version"]),
        ("rustc", "rustc", vec!["--version"]),
        ("gcc", "gcc", vec!["--version"]),
        ("powershell", "powershell.exe", vec!["-NoProfile", "-Command", ".PSVersion.ToString()"]),
        ("bash", "bash", vec!["--version"]),
        ("cmd", "cmd.exe", vec!["/c", "ver"]),
        ("cscript", "cscript.exe", vec!["//NoLogo", "/?"]),
        ("sqlite3", "sqlite3", vec!["--version"]),
        ("sqlcmd", "sqlcmd", vec!["-?"]),
    ];

    let mut results = serde_json::Map::new();
    for (name, program, args) in tools {
        let args_ref: Vec<&str> = args.iter().map(|s| s.as_ref()).collect();
        let status = match run_command(program, &args_ref).await {
            Ok((stdout, stderr, code)) => {
                let version = stdout.lines().next().unwrap_or("").trim().to_string();
                let version = if version.is_empty() { stderr.lines().next().unwrap_or("").trim().to_string() } else { version };
                serde_json::json!({
                    "installed": code == 0 || !version.is_empty(),
                    "version": version,
                    "path": program
                })
            }
            Err(_) => serde_json::json!({
                "installed": false,
                "version": "",
                "path": program
            })
        };
        results.insert(name.to_string(), status);
    }
    Json(serde_json::Value::Object(results))
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod security_tests;
