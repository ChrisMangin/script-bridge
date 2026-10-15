// Pure, in-memory tests. Nothing here may call save_*/load_*, execute_script,
// run_command*, stream/watch handlers or main: those touch the data folder,
// spawn processes or bind TCP. Router/security tests live in security_tests.rs.

use super::*;
use chrono::Duration;

const TRUNCATION_SUFFIX: &str = "\n... (truncated)";

fn ts(secs: i64) -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp(1_700_000_000 + secs, 0).unwrap()
}

fn script(id: &str, category: ScriptCategory, enabled: bool) -> Script {
    Script {
        id: id.into(),
        name: format!("name-{id}"),
        description: String::new(),
        language: ScriptLanguage::Python,
        category,
        code: String::new(),
        enabled,
        created_at: ts(0),
        updated_at: ts(0),
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

fn state_with(scripts: Vec<Script>) -> AppState {
    AppState {
        scripts: Arc::new(Mutex::new(scripts.into_iter().map(|s| (s.id.clone(), s)).collect())),
        settings: Arc::new(Mutex::new(Settings::default())),
        history: Arc::new(Mutex::new(Vec::new())),
        schedules: Arc::new(Mutex::new(Vec::new())),
        // Never created: these tests do not call handlers that persist.
        data_dir: Arc::new("Z:/scriptbridge-pure-tests-never-written".into()),
        pairing: Arc::new(Pairing::in_memory(&"0".repeat(64), None, "Z:/never/pairing.json".into())),
    }
}

fn sorted_ids(scripts: &[Script]) -> Vec<String> {
    let mut ids: Vec<String> = scripts.iter().map(|s| s.id.clone()).collect();
    ids.sort();
    ids
}

fn schedule(interval_secs: u64, last_run: Option<DateTime<Utc>>) -> Schedule {
    Schedule { id: "s".into(), script_id: "x".into(), interval_secs, enabled: true, last_run }
}

async fn search(state: &AppState, q: &str, regex: bool) -> Vec<String> {
    let Json(found) = search_scripts(
        State(state.clone()),
        axum::extract::Query(SearchQuery { q: q.into(), regex }),
    )
    .await;
    sorted_ids(&found)
}

// --- truncate_output ---

#[test]
fn truncate_output_keeps_empty_and_short_ascii() {
    assert_eq!(truncate_output(""), "");
    assert_eq!(truncate_output("hello\nworld"), "hello\nworld");
}

#[test]
fn truncate_output_keeps_exactly_5000_ascii_chars() {
    let s = "a".repeat(5000);
    assert_eq!(truncate_output(&s), s);
}

#[test]
fn truncate_output_cuts_5001_ascii_chars_to_5000_plus_suffix() {
    let s = format!("{}Z", "a".repeat(5000));
    let out = truncate_output(&s);
    assert_eq!(out, format!("{}{}", "a".repeat(5000), TRUNCATION_SUFFIX));
    assert!(!out.contains('Z'));
}

#[test]
fn truncate_output_counts_chars_not_bytes_for_multibyte() {
    // 5000 two-byte chars = 10000 bytes but still within the char limit.
    let s = "é".repeat(5000);
    assert_eq!(s.len(), 10_000);
    assert_eq!(truncate_output(&s), s);
}

#[test]
fn truncate_output_cuts_on_char_boundary_for_4_byte_chars() {
    let s = "😀".repeat(5001);
    let out = truncate_output(&s);
    let body = out.strip_suffix(TRUNCATION_SUFFIX).expect("suffix present");
    assert_eq!(body.chars().count(), 5000);
    assert!(body.chars().all(|c| c == '😀'));
}

#[test]
fn truncate_output_mixed_widths_keeps_first_5000_chars() {
    let s: String = "a€😀".repeat(1700); // 5100 chars of 1-, 3- and 4-byte widths
    let out = truncate_output(&s);
    let expected: String = s.chars().take(5000).collect();
    assert_eq!(out, format!("{expected}{TRUNCATION_SUFFIX}"));
}

#[test]
fn truncate_output_splits_grapheme_clusters_by_scalar_value() {
    // Documents current behaviour: truncation is per Unicode scalar, so a base
    // letter at position 5000 keeps the letter but drops its combining accent.
    let s = format!("{}e\u{301}", "a".repeat(4999));
    assert_eq!(s.chars().count(), 5001);
    let out = truncate_output(&s);
    assert_eq!(out, format!("{}e{}", "a".repeat(4999), TRUNCATION_SUFFIX));
}

// --- schedule_due ---

#[test]
fn schedule_due_when_never_run() {
    assert!(schedule_due(&schedule(3600, None)));
}

#[test]
fn schedule_not_due_just_after_running() {
    assert!(!schedule_due(&schedule(60, Some(Utc::now()))));
}

#[test]
fn schedule_due_once_interval_elapsed() {
    assert!(schedule_due(&schedule(60, Some(Utc::now() - Duration::seconds(61)))));
    assert!(schedule_due(&schedule(60, Some(Utc::now() - Duration::hours(5)))));
}

#[test]
fn schedule_not_due_well_before_interval() {
    assert!(!schedule_due(&schedule(3600, Some(Utc::now() - Duration::seconds(30)))));
}

#[test]
fn schedule_with_future_last_run_is_not_due() {
    // Clock skew: negative elapsed is clamped to 0.
    assert!(!schedule_due(&schedule(5, Some(Utc::now() + Duration::hours(1)))));
}

#[test]
fn schedule_due_ignores_enabled_flag() {
    // The scheduler loop filters on `enabled`; schedule_due itself only checks time.
    let mut s = schedule(60, None);
    s.enabled = false;
    assert!(schedule_due(&s));
}

// --- serde enums / defaults ---

#[test]
fn script_language_serializes_lowercase() {
    let cases = [
        (ScriptLanguage::JavaScript, "javascript"),
        (ScriptLanguage::Python, "python"),
        (ScriptLanguage::Rust, "rust"),
        (ScriptLanguage::C, "c"),
        (ScriptLanguage::Cmd, "cmd"),
        (ScriptLanguage::PowerShell, "powershell"),
    ];
    for (lang, name) in cases {
        assert_eq!(serde_json::to_value(&lang).unwrap(), serde_json::json!(name));
        assert_eq!(serde_json::from_value::<ScriptLanguage>(serde_json::json!(name)).unwrap(), lang);
    }
}

#[test]
fn script_language_rejects_other_casing() {
    assert!(serde_json::from_str::<ScriptLanguage>("\"JavaScript\"").is_err());
    assert!(serde_json::from_str::<ScriptLanguage>("\"js\"").is_err());
}

#[test]
fn script_category_serializes_lowercase() {
    assert_eq!(serde_json::to_string(&ScriptCategory::Browser).unwrap(), "\"browser\"");
    assert_eq!(serde_json::to_string(&ScriptCategory::External).unwrap(), "\"external\"");
    assert!(serde_json::from_str::<ScriptCategory>("\"Browser\"").is_err());
}

#[test]
fn script_trigger_serializes_lowercase_without_separators() {
    assert_eq!(serde_json::to_string(&ScriptTrigger::Manual).unwrap(), "\"manual\"");
    assert_eq!(serde_json::to_string(&ScriptTrigger::OnBrowserEvent).unwrap(), "\"onbrowserevent\"");
    assert_eq!(serde_json::to_string(&ScriptTrigger::Schedule).unwrap(), "\"schedule\"");
    assert!(serde_json::from_str::<ScriptTrigger>("\"on_browser_event\"").is_err());
    assert_eq!(ScriptTrigger::default(), ScriptTrigger::Manual);
}

#[test]
fn script_minimal_json_fills_defaults() {
    let s: Script = serde_json::from_value(serde_json::json!({
        "id": "1", "name": "n", "description": "d",
        "language": "python", "category": "external", "code": "print(1)",
        "enabled": true,
        "created_at": "2024-01-01T00:00:00Z", "updated_at": "2024-01-01T00:00:00Z"
    }))
    .unwrap();
    assert!(s.match_patterns.is_empty());
    assert_eq!(s.run_at, "");
    assert_eq!(s.trigger, ScriptTrigger::Manual);
    assert!(s.last_run.is_none() && s.last_output.is_none() && s.last_exit_code.is_none());
    assert!(s.watch_path.is_none() && s.watch_modified.is_none());
    assert!(s.tags.is_empty());
    assert!(s.version.is_none());
    assert!(s.env_vars.is_empty());
    assert_eq!(s.order, 0);
}

#[test]
fn script_missing_required_field_fails() {
    let r = serde_json::from_value::<Script>(serde_json::json!({
        "id": "1", "name": "n", "language": "python", "category": "external",
        "code": "", "enabled": true,
        "created_at": "2024-01-01T00:00:00Z", "updated_at": "2024-01-01T00:00:00Z"
    }));
    assert!(r.is_err(), "description is required");
}

#[test]
fn script_round_trips_through_json() {
    let mut s = script("rt", ScriptCategory::Browser, false);
    s.language = ScriptLanguage::JavaScript;
    s.trigger = ScriptTrigger::OnBrowserEvent;
    s.tags = vec!["t1".into()];
    s.env_vars.insert("K".into(), "V".into());
    s.order = -3;
    let back: Script = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
    assert_eq!(back.id, "rt");
    assert_eq!(back.language, ScriptLanguage::JavaScript);
    assert_eq!(back.category, ScriptCategory::Browser);
    assert_eq!(back.trigger, ScriptTrigger::OnBrowserEvent);
    assert!(!back.enabled);
    assert_eq!(back.tags, vec!["t1".to_string()]);
    assert_eq!(back.env_vars.get("K").map(String::as_str), Some("V"));
    assert_eq!(back.order, -3);
    assert_eq!(back.created_at, s.created_at);
}

#[test]
fn create_script_defaults() {
    let c: CreateScript = serde_json::from_value(serde_json::json!({
        "name": "n", "description": "", "language": "cmd", "category": "external", "code": ""
    }))
    .unwrap();
    assert!(c.id.is_none());
    assert!(c.match_patterns.is_empty());
    assert_eq!(c.run_at, "");
    assert_eq!(c.trigger, ScriptTrigger::Manual);
    assert!(c.tags.is_empty() && c.watch_path.is_none() && c.env_vars.is_empty());
}

#[test]
fn update_script_empty_object_is_all_none() {
    let u: UpdateScript = serde_json::from_str("{}").unwrap();
    assert!(u.name.is_none() && u.description.is_none() && u.code.is_none());
    assert!(u.enabled.is_none() && u.match_patterns.is_none() && u.run_at.is_none());
    assert!(u.trigger.is_none() && u.tags.is_none() && u.watch_path.is_none());
    assert!(u.env_vars.is_none() && u.order.is_none());
}

#[test]
fn create_schedule_enabled_defaults_true_and_respects_false() {
    let c: CreateSchedule = serde_json::from_str(r#"{"script_id":"a","interval_secs":30}"#).unwrap();
    assert!(c.enabled);
    assert_eq!(c.interval_secs, 30);
    let c: CreateSchedule =
        serde_json::from_str(r#"{"script_id":"a","interval_secs":30,"enabled":false}"#).unwrap();
    assert!(!c.enabled);
}

#[test]
fn schedule_last_run_defaults_none() {
    let s: Schedule =
        serde_json::from_str(r#"{"id":"i","script_id":"a","interval_secs":10,"enabled":true}"#).unwrap();
    assert!(s.last_run.is_none());
}

#[test]
fn search_query_and_import_payload_defaults() {
    let q: SearchQuery = serde_json::from_str(r#"{"q":"x"}"#).unwrap();
    assert!(!q.regex);
    let p: ImportPayload = serde_json::from_str(r#"{"scripts":[]}"#).unwrap();
    assert!(!p.overwrite && p.scripts.is_empty());
    let p: SettingsPayload = serde_json::from_str(r#"{"settings":{"a":1}}"#).unwrap();
    assert!(p.tags.is_empty());
    assert_eq!(p.settings.get("a"), Some(&serde_json::json!(1)));
}

#[test]
fn settings_flatten_separates_tags_from_values() {
    let s: Settings = serde_json::from_str(r#"{"theme":"dark","n":2,"tags":["x"]}"#).unwrap();
    assert_eq!(s.tags, vec!["x".to_string()]);
    assert_eq!(s.values.get("theme"), Some(&serde_json::json!("dark")));
    assert_eq!(s.values.get("n"), Some(&serde_json::json!(2)));
    assert!(!s.values.contains_key("tags"));

    let v = serde_json::to_value(&s).unwrap();
    assert_eq!(v, serde_json::json!({"theme": "dark", "n": 2, "tags": ["x"]}));
}

#[test]
fn settings_empty_object_is_default() {
    let s: Settings = serde_json::from_str("{}").unwrap();
    assert!(s.values.is_empty() && s.tags.is_empty());
}

// --- md5_hash (FNV-1a used for build caching) ---

#[test]
fn md5_hash_matches_fnv1a_reference_values() {
    assert_eq!(md5_hash(b""), 0xcbf29ce484222325);
    assert_eq!(md5_hash(b"a"), 0xaf63dc4c8601ec8c);
    assert_ne!(md5_hash(b"ab"), md5_hash(b"ba"));
}

// --- read-only handlers over in-memory state ---

#[tokio::test]
async fn browser_scripts_only_enabled_browser_category() {
    let state = state_with(vec![
        script("b-on", ScriptCategory::Browser, true),
        script("b-off", ScriptCategory::Browser, false),
        script("e-on", ScriptCategory::External, true),
        script("e-off", ScriptCategory::External, false),
    ]);
    let Json(found) = get_browser_scripts(State(state)).await;
    assert_eq!(sorted_ids(&found), vec!["b-on"]);
}

#[tokio::test]
async fn browser_scripts_empty_store() {
    let Json(found) = get_browser_scripts(State(state_with(vec![]))).await;
    assert!(found.is_empty());
}

#[tokio::test]
async fn list_scripts_sorted_by_updated_at_desc() {
    let mut a = script("a", ScriptCategory::External, true);
    a.updated_at = ts(10);
    let mut b = script("b", ScriptCategory::Browser, false);
    b.updated_at = ts(30);
    let mut c = script("c", ScriptCategory::External, true);
    c.updated_at = ts(20);
    let Json(found) = list_scripts(State(state_with(vec![a, b, c]))).await;
    let ids: Vec<&str> = found.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, vec!["b", "c", "a"]);
}

#[tokio::test]
async fn get_script_found_and_not_found() {
    let state = state_with(vec![script("x", ScriptCategory::External, true)]);
    let Json(s) = get_script(State(state.clone()), Path("x".into())).await.unwrap();
    assert_eq!(s.id, "x");
    let err = get_script(State(state), Path("missing".into())).await.unwrap_err();
    assert_eq!(err, StatusCode::NOT_FOUND);
}

fn search_fixture() -> AppState {
    let mut by_name = script("name", ScriptCategory::External, true);
    by_name.name = "Deploy Tool".into();
    let mut by_desc = script("desc", ScriptCategory::External, true);
    by_desc.description = "Cleans the DEPLOY cache".into();
    let mut by_code = script("code", ScriptCategory::Browser, false);
    by_code.code = "console.log('deploy')".into();
    let mut by_tag = script("tag", ScriptCategory::External, true);
    by_tag.tags = vec!["Deployment".into()];
    let unrelated = script("none", ScriptCategory::External, true);
    state_with(vec![by_name, by_desc, by_code, by_tag, unrelated])
}

#[tokio::test]
async fn plain_search_is_case_insensitive_across_name_description_code_tags() {
    let state = search_fixture();
    assert_eq!(search(&state, "DePlOy", false).await, vec!["code", "desc", "name", "tag"]);
}

#[tokio::test]
async fn plain_search_ignores_enabled_and_category() {
    let state = search_fixture();
    assert_eq!(search(&state, "console.log", false).await, vec!["code"]);
}

#[tokio::test]
async fn plain_search_empty_query_matches_everything() {
    let state = search_fixture();
    assert_eq!(search(&state, "", false).await.len(), 5);
}

#[tokio::test]
async fn plain_search_no_match() {
    let state = search_fixture();
    assert!(search(&state, "zzz-not-here", false).await.is_empty());
}

#[tokio::test]
async fn plain_search_treats_regex_metachars_literally() {
    let state = search_fixture();
    assert!(search(&state, "dep.oy", false).await.is_empty());
}

#[tokio::test]
async fn regex_search_is_case_sensitive_and_skips_tags() {
    let state = search_fixture();
    assert_eq!(search(&state, "Deploy", true).await, vec!["name"]);
    assert_eq!(search(&state, "(?i)deploy", true).await, vec!["code", "desc", "name"]);
    assert!(search(&state, "Deployment", true).await.is_empty(), "tags not searched by regex");
}

#[tokio::test]
async fn regex_search_invalid_pattern_returns_empty() {
    let state = search_fixture();
    assert!(search(&state, "(unclosed", true).await.is_empty());
}

#[tokio::test]
async fn list_schedules_and_history_return_in_memory_copies() {
    let state = state_with(vec![]);
    state.schedules.lock().unwrap().push(schedule(30, None));
    state.history.lock().unwrap().push(HistoryEntry {
        id: "h".into(),
        script_id: "x".into(),
        script_name: "n".into(),
        started_at: ts(0),
        duration_ms: 5,
        exit_code: 0,
        stdout: "out".into(),
        stderr: String::new(),
    });
    let Json(sched) = list_schedules(State(state.clone())).await;
    assert_eq!(sched.len(), 1);
    assert_eq!(sched[0].interval_secs, 30);
    let Json(hist) = get_history(State(state)).await;
    assert_eq!(hist.len(), 1);
    assert_eq!(hist[0].stdout, "out");
}

#[tokio::test]
async fn get_settings_wraps_values_and_tags() {
    let state = state_with(vec![]);
    {
        let mut s = state.settings.lock().unwrap();
        s.values.insert("theme".into(), serde_json::json!("dark"));
        s.tags = vec!["a".into()];
    }
    let Json(v) = get_settings(State(state)).await;
    assert_eq!(v, serde_json::json!({"settings": {"theme": "dark"}, "tags": ["a"]}));
}

#[tokio::test]
async fn ping_returns_pong() {
    assert_eq!(ping().await, "pong");
}
