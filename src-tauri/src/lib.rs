//! Turbo the Cat core. Spawns the `claude` / `codex` CLIs (which authenticate
//! against your Max / ChatGPT subscriptions) and a real login shell for the
//! terminal, streaming their output to the UI. Also tallies today's spend from
//! Claude Code's logs.

mod usage;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

/// The native "Hey Turbo" listener bundle (built by scripts/build-listener.sh).
/// Launched via `open` so macOS reads its Info.plist and shows the mic/speech
/// permission prompts; it writes transcripts to a log file we tail.
const LISTENER_APP: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../helpers/TurboListen.app");

static VOICE_RUNNING: AtomicBool = AtomicBool::new(false);

/// Latest Claude rate-limit info (captured from stream events), as a JSON string.
fn latest_limits() -> &'static Mutex<Option<String>> {
    static L: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(None))
}

fn limits_file() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".turbothecat").join("limits.json"))
}

const DEFAULT_PERSONA: &str = "\
You are Turbo — the CAT (Coding Agent Terminal): a witty, warm cat who is also a \
highly capable software engineer, living at the top of the user's screen. You write, \
debug, refactor and ship real code, run terminal commands, and build whole apps \
end-to-end. You are genuinely expert and get to the point — favour doing the work \
(reading files, editing, running commands) over long explanations. You have a light \
feline personality: an occasional soft *meow* or purr, sparingly, never at the cost \
of being useful. When you finish a task well, you're quietly proud. You refer to \
yourself as Turbo.";

/// The editable persona/context file at ~/.turbothecat/persona.md. Created with a
/// sensible default on first read so the user can customise how Turbo behaves.
fn persona_file() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(std::path::PathBuf::from(home).join(".turbothecat").join("persona.md"))
}

fn persona() -> Option<String> {
    let path = persona_file()?;
    if !path.exists() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, DEFAULT_PERSONA);
    }
    let s = std::fs::read_to_string(&path).ok()?;
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// GUI apps on macOS launch with a bare PATH that misses `~/.local/bin`,
/// Homebrew, nvm, etc. — so `claude`, `codex`, `node` aren't found. We ask the
/// user's login shell for its real PATH once and reuse it for every child.
pub(crate) fn login_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let out = std::process::Command::new(&shell)
            .args(["-lic", "printf %s \"$PATH\""])
            .output();
        let mut path = match out {
            Ok(o) if o.status.success() && !o.stdout.is_empty() => {
                String::from_utf8_lossy(&o.stdout).trim().to_string()
            }
            _ => String::new(),
        };
        // Belt-and-suspenders: make sure the usual spots are present.
        if let Some(home) = std::env::var_os("HOME").and_then(|h| h.into_string().ok()) {
            for extra in [
                format!("{home}/.local/bin"),
                "/opt/homebrew/bin".into(),
                "/usr/local/bin".into(),
                "/usr/bin".into(),
                "/bin".into(),
            ] {
                if !path.split(':').any(|p| p == extra) {
                    if path.is_empty() {
                        path = extra;
                    } else {
                        path.push(':');
                        path.push_str(&extra);
                    }
                }
            }
        }
        path
    })
}

#[derive(Serialize, Clone, Default)]
pub struct RunResult {
    #[serde(rename = "costUsd")]
    cost_usd: Option<f64>,
    tokens: Option<u64>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

/// Run one prompt through the chosen backend, streaming text to the webview via
/// `turbo://chunk` and tool activity via `turbo://tool`. Resolves with the run's
/// cost/token totals when the process exits.
///
/// If resuming a saved session fails because it no longer exists, we retry once
/// without it so the message still goes through (as a fresh conversation).
#[tauri::command]
async fn ask_agent(
    window: tauri::Window,
    backend: String,
    prompt: String,
    cwd: Option<String>,
    #[allow(non_snake_case)] permissionMode: Option<String>,
    model: Option<String>,
    #[allow(non_snake_case)] sessionId: Option<String>,
) -> Result<RunResult, String> {
    let has_session = sessionId.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
    let first = run_agent_once(
        window.clone(),
        backend.clone(),
        prompt.clone(),
        cwd.clone(),
        permissionMode.clone(),
        model.clone(),
        sessionId.clone(),
    )
    .await;
    match first {
        Err(e) if has_session && (e.contains("No conversation found") || e.contains("session ID")) => {
            run_agent_once(window, backend, prompt, cwd, permissionMode, model, None).await
        }
        other => other,
    }
}

async fn run_agent_once(
    window: tauri::Window,
    backend: String,
    prompt: String,
    cwd: Option<String>,
    permission_mode: Option<String>,
    model: Option<String>,
    session_id: Option<String>,
) -> Result<RunResult, String> {
    let mut cmd = match backend.as_str() {
        "claude" => {
            let mut c = Command::new("claude");
            // Use the logged-in Claude plan (Agent SDK credit), not a stray API key
            // that would bill pay-per-token.
            c.env_remove("ANTHROPIC_API_KEY");
            c.arg("-p")
                .arg(&prompt)
                .arg("--output-format")
                .arg("stream-json")
                .arg("--verbose");
            if let Some(mode) = permission_mode.as_ref().filter(|m| !m.is_empty()) {
                c.arg("--permission-mode").arg(mode);
            }
            if let Some(m) = model.as_ref().filter(|m| !m.is_empty()) {
                c.arg("--model").arg(m);
            }
            if let Some(p) = persona() {
                c.arg("--append-system-prompt").arg(p);
            }
            if let Some(sid) = session_id.as_ref().filter(|s| !s.is_empty()) {
                c.arg("--resume").arg(sid);
            }
            c
        }
        "codex" => {
            let mut c = Command::new("codex");
            c.arg("exec").arg(&prompt);
            if let Some(m) = model.as_ref().filter(|m| !m.is_empty()) {
                c.arg("--model").arg(m);
            }
            c
        }
        other => return Err(format!("Unknown backend: {other}")),
    };

    cmd.env("PATH", login_path());
    if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start `{backend}`: {e}. Is it installed and logged in?"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let is_claude = backend == "claude";
    let win = window.clone();

    let reader = tokio::spawn(async move {
        let mut result = RunResult::default();
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            if is_claude {
                handle_claude_line(&win, &line, &mut result);
            } else {
                let _ = win.emit("turbo://chunk", line);
            }
        }
        result
    });

    let mut err_tail = String::new();
    {
        let mut elines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = elines.next_line().await {
            if !line.trim().is_empty() {
                err_tail.push_str(&line);
                err_tail.push('\n');
            }
        }
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let result = reader.await.unwrap_or_default();

    if !status.success() {
        let tail = err_tail.trim();
        return Err(if tail.is_empty() {
            format!("`{backend}` exited with {status}")
        } else {
            tail.lines()
                .rev()
                .take(4)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n")
        });
    }

    Ok(result)
}

fn handle_claude_line(win: &tauri::Window, line: &str, result: &mut RunResult) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    // Capture the session id (present on most events) so the next turn can resume.
    if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
        result.session_id = Some(sid.to_string());
    }
    // Capture rate-limit info so the usage popup can show what's left.
    if v.get("type").and_then(|t| t.as_str()) == Some("rate_limit_event") {
        if let Some(info) = v.get("rate_limit_info") {
            let s = info.to_string();
            if let Ok(mut g) = latest_limits().lock() {
                *g = Some(s.clone());
            }
            if let Some(p) = limits_file() {
                if let Some(d) = p.parent() {
                    let _ = std::fs::create_dir_all(d);
                }
                let _ = std::fs::write(p, s);
            }
        }
    }
    match v.get("type").and_then(|t| t.as_str()) {
        Some("assistant") => {
            if let Some(content) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                for block in content {
                    match block.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                let _ = win.emit("turbo://chunk", t.to_string());
                            }
                        }
                        Some("tool_use") => {
                            let name =
                                block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                            let id = block.get("id").and_then(|n| n.as_str()).unwrap_or("");
                            let input = block.get("input").cloned().unwrap_or(serde_json::Value::Null);
                            let payload = serde_json::json!({
                                "kind": "use", "id": id, "name": name, "input": input,
                            });
                            let _ = win.emit("turbo://tool", payload.to_string());
                        }
                        _ => {}
                    }
                }
            }
        }
        // tool_result blocks arrive as "user" messages referencing the tool_use id
        Some("user") => {
            if let Some(content) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                for block in content {
                    if block.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                        let id = block
                            .get("tool_use_id")
                            .and_then(|s| s.as_str())
                            .unwrap_or("");
                        let ok = !block
                            .get("is_error")
                            .and_then(|b| b.as_bool())
                            .unwrap_or(false);
                        let mut text = tool_result_text(block.get("content"));
                        if text.chars().count() > 4000 {
                            text = text.chars().take(4000).collect::<String>() + "…";
                        }
                        let payload = serde_json::json!({
                            "kind": "result", "id": id, "ok": ok, "text": text,
                        });
                        let _ = win.emit("turbo://tool", payload.to_string());
                    }
                }
            }
        }
        Some("result") => {
            result.cost_usd = v.get("total_cost_usd").and_then(|c| c.as_f64());
            if let Some(out) = v.pointer("/usage/output_tokens").and_then(|t| t.as_u64()) {
                let inp = v
                    .pointer("/usage/input_tokens")
                    .and_then(|t| t.as_u64())
                    .unwrap_or(0);
                result.tokens = Some(inp + out);
            }
        }
        _ => {}
    }
}

/// Extract the text from a tool_result's `content`, which may be a plain string
/// or an array of `{type:"text", text:"…"}` blocks.
fn tool_result_text(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[derive(Serialize)]
pub struct ShellResult {
    code: i32,
    cwd: String,
}

const CWD_MARK: &str = "@@TURBO_CWD@@";

/// Run a shell command through the user's login shell, streaming combined
/// stdout+stderr to the webview via `turbo://term`. Tracks the working
/// directory across calls (so `cd` sticks) by printing $PWD at the end.
#[tauri::command]
async fn run_shell(
    window: tauri::Window,
    cmd: String,
    cwd: Option<String>,
) -> Result<ShellResult, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let start_cwd = cwd
        .filter(|d| !d.is_empty() && std::path::Path::new(d).is_dir())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| "/".into());

    // Run the user's command, then emit a marker line with the resulting PWD and
    // exit code so we can keep the terminal's cwd in sync (handles `cd`).
    let wrapped = format!("{{ {cmd}\n}}; __rc=$?; printf '\\n{CWD_MARK}%s|%d{CWD_MARK}\\n' \"$PWD\" \"$__rc\"");

    let mut child = Command::new(&shell)
        .arg("-lc")
        .arg(&wrapped)
        .current_dir(&start_cwd)
        .env("PATH", login_path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start shell: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // Drain stderr to the same terminal stream.
    let win_err = window.clone();
    let err_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = win_err.emit("turbo://term", line);
        }
    });

    let mut result_cwd = start_cwd.clone();
    let mut code = 0;
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(rest) = line.strip_prefix(CWD_MARK) {
            if let Some(payload) = rest.strip_suffix(CWD_MARK) {
                if let Some((pwd, rc)) = payload.split_once('|') {
                    result_cwd = pwd.to_string();
                    code = rc.parse().unwrap_or(0);
                }
            }
            continue; // don't show the marker line
        }
        let _ = window.emit("turbo://term", line);
    }

    let _ = err_task.await;
    let _ = child.wait().await;

    Ok(ShellResult {
        code,
        cwd: result_cwd,
    })
}

#[tauri::command]
fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

/// Ensure the persona file exists and return its path (so the user can edit it).
#[tauri::command]
fn persona_path() -> String {
    persona(); // create with default if missing
    persona_file()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Start the native speech listener. Launches the helper app via LaunchServices
/// (so the macOS mic + speech permission prompts appear), then tails the log file
/// it writes, emitting finalised utterances via `turbo://voice` and status via
/// `turbo://voice-status`.
#[tauri::command]
fn start_listening(window: tauri::Window) -> Result<(), String> {
    if VOICE_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(()); // already listening
    }

    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = std::path::Path::new(&home).join(".turbothecat");
    let _ = std::fs::create_dir_all(&dir);
    let log = dir.join("voice.log");
    let partial = dir.join("voice.log.partial");
    let _ = std::fs::write(&log, b""); // truncate previous session
    let _ = std::fs::write(&partial, b"");
    let log_str = log.to_string_lossy().to_string();

    // Launch foreground (no -g) so the first-run mic/speech prompt is shown.
    std::process::Command::new("open")
        .args([LISTENER_APP, "--args", &log_str])
        .spawn()
        .map_err(|e| {
            VOICE_RUNNING.store(false, Ordering::SeqCst);
            format!("Couldn't launch listener: {e}")
        })?;

    let win = window.clone();
    std::thread::spawn(move || {
        let mut emitted = 0usize;
        let mut last_partial = String::new();
        while VOICE_RUNNING.load(Ordering::SeqCst) {
            // events (final / ready / error)
            if let Ok(content) = std::fs::read_to_string(&log) {
                let lines: Vec<&str> = content.lines().collect();
                for line in lines.iter().skip(emitted) {
                    if let Some(t) = line.strip_prefix("FINAL\t") {
                        let _ = win.emit("turbo://voice", t.to_string());
                    } else if *line == "READY" {
                        let _ = win.emit("turbo://voice-status", "ready".to_string());
                    } else if let Some(err) = line.strip_prefix("ERR ") {
                        let _ = win.emit("turbo://voice-status", format!("error:{err}"));
                    }
                }
                emitted = lines.len();
            }
            // live partial transcript
            if let Ok(p) = std::fs::read_to_string(&partial) {
                if !p.is_empty() && p != last_partial {
                    last_partial = p.clone();
                    let _ = win.emit("turbo://voice-partial", p);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(120));
        }
    });
    Ok(())
}

#[tauri::command]
fn stop_listening() -> Result<(), String> {
    VOICE_RUNNING.store(false, Ordering::SeqCst);
    let _ = std::process::Command::new("pkill")
        .args(["-f", "turbo-listen"])
        .status();
    Ok(())
}

#[tauri::command]
fn read_usage() -> Result<usage::UsageSummary, String> {
    usage::today().map_err(|e| e.to_string())
}

/// Latest Claude rate-limit info (5-hour / weekly window status + reset times).
#[tauri::command]
fn read_limits() -> Option<serde_json::Value> {
    let s = latest_limits()
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .or_else(|| limits_file().and_then(|p| std::fs::read_to_string(p).ok()));
    s.and_then(|s| serde_json::from_str(&s).ok())
}

#[derive(Serialize)]
pub struct SessionInfo {
    id: String,
    title: String,
    cwd: String,
    mtime: u64,
}

#[derive(Serialize)]
pub struct ChatEntry {
    role: String,
    text: String,
}

fn claude_projects() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".claude").join("projects"))
}

fn jsonl_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                jsonl_files(&p, out);
            } else if p.extension().map(|x| x == "jsonl").unwrap_or(false) {
                out.push(p);
            }
        }
    }
}

/// Pull the human-readable text out of a transcript message (string or blocks).
fn msg_text(v: &serde_json::Value) -> Option<String> {
    let content = v.pointer("/message/content")?;
    if let Some(s) = content.as_str() {
        let s = s.trim();
        return (!s.is_empty()).then(|| s.to_string());
    }
    if let Some(arr) = content.as_array() {
        let mut out = String::new();
        for b in arr {
            if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(t);
                }
            }
        }
        let out = out.trim();
        return (!out.is_empty()).then(|| out.to_string());
    }
    None
}

fn session_id_of(v: &serde_json::Value) -> Option<&str> {
    v.get("sessionId")
        .and_then(|s| s.as_str())
        .or_else(|| v.get("session_id").and_then(|s| s.as_str()))
}

/// List recent Claude chat sessions from the local logs, newest first.
#[tauri::command]
fn list_sessions() -> Vec<SessionInfo> {
    use std::collections::HashMap;
    let mut files = Vec::new();
    if let Some(root) = claude_projects() {
        jsonl_files(&root, &mut files);
    }
    let mut sessions: HashMap<String, SessionInfo> = HashMap::new();
    for path in files {
        let mtime = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        let mut id = String::new();
        let mut cwd = String::new();
        let mut title = String::new();
        for line in content.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            if id.is_empty() {
                if let Some(s) = session_id_of(&v) {
                    id = s.to_string();
                }
            }
            if cwd.is_empty() {
                if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                    cwd = c.to_string();
                }
            }
            if title.is_empty() && v.get("type").and_then(|t| t.as_str()) == Some("user") {
                if let Some(t) = msg_text(&v) {
                    if !t.starts_with('<') && !t.starts_with("Caveat:") {
                        title = t.chars().take(80).collect();
                    }
                }
            }
        }
        if id.is_empty() {
            id = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
        }
        if id.is_empty() {
            continue;
        }
        if title.is_empty() {
            title = "(no messages)".into();
        }
        sessions
            .entry(id.clone())
            .and_modify(|e| {
                if mtime > e.mtime {
                    e.mtime = mtime;
                    if !title.is_empty() && e.title == "(no messages)" {
                        e.title = title.clone();
                    }
                }
            })
            .or_insert(SessionInfo { id, title, cwd, mtime });
    }
    let mut list: Vec<SessionInfo> = sessions.into_values().collect();
    list.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    list.truncate(60);
    list
}

/// Load the messages of one session for display when reopened.
#[tauri::command]
fn load_session(id: String) -> Vec<ChatEntry> {
    let mut files = Vec::new();
    if let Some(root) = claude_projects() {
        jsonl_files(&root, &mut files);
    }
    let mut out = Vec::new();
    for path in files {
        let stem_match = path
            .file_stem()
            .map(|s| s.to_string_lossy() == id)
            .unwrap_or(false);
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        if !stem_match && !content.contains(&id) {
            continue;
        }
        for line in content.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            if session_id_of(&v) != Some(id.as_str()) {
                continue;
            }
            match v.get("type").and_then(|t| t.as_str()) {
                Some("user") => {
                    if let Some(t) = msg_text(&v) {
                        if !t.starts_with('<') {
                            out.push(ChatEntry { role: "user".into(), text: t });
                        }
                    }
                }
                Some("assistant") => {
                    if let Some(t) = msg_text(&v) {
                        out.push(ChatEntry { role: "bot".into(), text: t });
                    }
                }
                _ => {}
            }
        }
        if !out.is_empty() {
            break;
        }
    }
    out
}

/// Speak text aloud with the system voice (drives the talking mouth + is fun).
#[tauri::command]
fn speak(text: String) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("say").arg(text).spawn();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
    }
}

// ———————————————————— git ————————————————————

#[derive(Serialize)]
pub struct RepoInfo {
    path: String,
    name: String,
}

/// Native folder picker (macOS) — returns the chosen path, or None if cancelled.
#[tauri::command]
async fn pick_folder() -> Result<Option<String>, String> {
    let script =
        "POSIX path of (choose folder with prompt \"Pick a folder to scan for git repos\")";
    let out = tokio::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(None); // user cancelled
    }
    let p = String::from_utf8_lossy(&out.stdout)
        .trim()
        .trim_end_matches('/')
        .to_string();
    Ok((!p.is_empty()).then_some(p))
}

/// Find git repositories under `root` (a few levels deep), skipping noisy dirs.
#[tauri::command]
fn find_git_repos(root: String) -> Vec<RepoInfo> {
    fn walk(dir: &std::path::Path, depth: usize, out: &mut Vec<RepoInfo>) {
        if depth == 0 || out.len() > 200 {
            return;
        }
        if dir.join(".git").exists() {
            out.push(RepoInfo {
                path: dir.display().to_string(),
                name: dir
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            });
            return; // don't descend into a repo
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let n = e.file_name();
            let n = n.to_string_lossy();
            if n.starts_with('.') || matches!(n.as_ref(), "node_modules" | "target" | "Pods" | "build" | "dist" | "vendor") {
                continue;
            }
            walk(&p, depth - 1, out);
        }
    }
    let mut out = Vec::new();
    walk(std::path::Path::new(&root), 5, &mut out);
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Run a git command in `repo`, returning combined stdout (or stderr on failure).
fn run_git(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("PATH", login_path())
        .output()
        .map_err(|e| format!("git not found: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() {
        Ok(stdout)
    } else {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        Err(if err.trim().is_empty() { stdout } else { err })
    }
}

#[derive(Serialize)]
pub struct GitFile {
    status: String,
    path: String,
}

#[derive(Serialize)]
pub struct GitStatus {
    branch: String,
    ahead: u32,
    behind: u32,
    files: Vec<GitFile>,
    clean: bool,
}

/// Branch, ahead/behind, and the list of changed files for a repo.
#[tauri::command]
fn git_status(repo: String) -> Result<GitStatus, String> {
    let raw = run_git(&repo, &["status", "--porcelain=v1", "--branch"])?;
    let mut branch = String::new();
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut files = Vec::new();
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            // e.g. "main...origin/main [ahead 1, behind 2]"
            branch = rest
                .split(['.', ' '])
                .next()
                .unwrap_or("")
                .to_string();
            if let Some(i) = rest.find("ahead ") {
                ahead = rest[i + 6..].split([',', ']']).next().unwrap_or("0").trim().parse().unwrap_or(0);
            }
            if let Some(i) = rest.find("behind ") {
                behind = rest[i + 7..].split([',', ']']).next().unwrap_or("0").trim().parse().unwrap_or(0);
            }
        } else if line.len() > 3 {
            files.push(GitFile {
                status: line[..2].trim().to_string(),
                path: line[3..].to_string(),
            });
        }
    }
    if branch.is_empty() {
        branch = run_git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])?
            .trim()
            .to_string();
    }
    let clean = files.is_empty();
    Ok(GitStatus { branch, ahead, behind, files, clean })
}

/// Stage everything and draft a commit message from the diff using Claude.
#[tauri::command]
async fn git_ai_message(repo: String) -> Result<String, String> {
    run_git(&repo, &["add", "-A"])?;
    let diff = run_git(&repo, &["diff", "--staged"])?;
    if diff.trim().is_empty() {
        return Err("Nothing staged to commit.".into());
    }
    let clipped: String = diff.chars().take(12000).collect();
    let prompt = format!(
        "Write a git commit message for the following diff. Use the Conventional Commits style: \
a concise one-line summary (max ~70 chars), then a blank line and 1-3 short bullet points if useful. \
Output ONLY the commit message, no code fences, no preamble.\n\n{clipped}"
    );
    let out = tokio::process::Command::new("claude")
        .arg("-p")
        .arg(&prompt)
        .env("PATH", login_path())
        .env_remove("ANTHROPIC_API_KEY") // use the plan, not a pay-per-token key
        .output()
        .await
        .map_err(|e| format!("Couldn't run claude: {e}"))?;
    if !out.status.success() {
        return Err("claude couldn't draft a message.".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Commit whatever is staged with the given message.
#[tauri::command]
fn git_commit(repo: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Commit message is empty.".into());
    }
    run_git(&repo, &["add", "-A"])?;
    run_git(&repo, &["commit", "-m", &message])
}

/// Commits we have that the upstream doesn't (unpushed). Empty if no upstream.
#[tauri::command]
fn git_unpushed(repo: String) -> Vec<String> {
    run_git(&repo, &["log", "@{u}..HEAD", "--oneline", "--color=never"])
        .map(|s| s.lines().filter(|l| !l.is_empty()).map(String::from).collect())
        .unwrap_or_default()
}

/// Commits the upstream has that we don't (unpulled). Reflects the last fetch.
#[tauri::command]
fn git_unpulled(repo: String) -> Vec<String> {
    run_git(&repo, &["log", "HEAD..@{u}", "--oneline", "--color=never"])
        .map(|s| s.lines().filter(|l| !l.is_empty()).map(String::from).collect())
        .unwrap_or_default()
}

/// The commit graph (all branches), decorated so HEAD shows where we are.
#[tauri::command]
fn git_log(repo: String) -> Result<String, String> {
    run_git(
        &repo,
        &["log", "--graph", "--oneline", "--decorate", "--all", "-40", "--color=never"],
    )
}

/// Refresh remote-tracking refs so unpulled/behind counts are accurate.
#[tauri::command]
fn git_fetch(repo: String) -> Result<String, String> {
    run_git(&repo, &["fetch", "--all", "--prune"])
}

#[tauri::command]
fn git_pull(repo: String) -> Result<String, String> {
    run_git(&repo, &["pull", "--ff-only"])
}

#[tauri::command]
fn git_push(repo: String) -> Result<String, String> {
    run_git(&repo, &["push"])
}

// ———————————————————— IDE bridge (Claude Code IDE integration) ————————————————————
// Turbo acts as an "IDE": it runs a WebSocket MCP server and drops a lock file in
// ~/.claude/ide/<port>.lock, so an interactive `claude` (run in our terminal with
// CLAUDE_CODE_SSE_PORT set) connects to us — letting Claude show diffs in Turbo.
// NOTE: this protocol is undocumented/reverse-engineered; expect to iterate.

fn ide_info() -> &'static OnceLock<(u16, String)> {
    static I: OnceLock<(u16, String)> = OnceLock::new();
    &I
}
fn ide_workspace() -> &'static Mutex<String> {
    static W: OnceLock<Mutex<String>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(std::env::var("HOME").unwrap_or_else(|_| "/".into())))
}
fn ide_pending() -> &'static Mutex<HashMap<String, oneshot::Sender<bool>>> {
    static P: OnceLock<Mutex<HashMap<String, oneshot::Sender<bool>>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}
static IDE_DIFF_SEQ: AtomicU64 = AtomicU64::new(1);

fn rand_token() -> String {
    let mut b = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut b);
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The frontend resolves an openDiff request (accept = apply the edit).
#[tauri::command]
fn ide_diff_result(id: String, accept: bool) {
    if let Some(tx) = ide_pending().lock().unwrap().remove(&id) {
        let _ = tx.send(accept);
    }
}

/// Start the IDE WebSocket server + write the lock file. Best-effort.
fn start_ide_server(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(l) => l,
            Err(_) => return,
        };
        let port = match listener.local_addr() {
            Ok(a) => a.port(),
            Err(_) => return,
        };
        let token = rand_token();
        let _ = ide_info().set((port, token.clone()));

        // write ~/.claude/ide/<port>.lock
        if let Some(home) = std::env::var_os("HOME") {
            let dir = std::path::PathBuf::from(home).join(".claude").join("ide");
            let _ = std::fs::create_dir_all(&dir);
            let ws = ide_workspace().lock().unwrap().clone();
            let lock = serde_json::json!({
                "pid": std::process::id(),
                "workspaceFolders": [ws],
                "ideName": "Turbo",
                "transport": "ws",
                "authToken": token,
            });
            let _ = std::fs::write(dir.join(format!("{port}.lock")), lock.to_string());
        }

        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
                    return;
                };
                let (mut tx, mut rx) = ws.split();
                while let Some(Ok(msg)) = rx.next().await {
                    if let Message::Text(t) = msg {
                        if let Some(resp) = handle_ide_rpc(t.as_str(), &app2).await {
                            if tx.send(Message::Text(resp.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });
}

fn ide_tool_list() -> serde_json::Value {
    let tool = |name: &str, desc: &str| {
        serde_json::json!({
            "name": name, "description": desc,
            "inputSchema": {"type": "object", "properties": {}}
        })
    };
    serde_json::json!({
        "tools": [
            tool("openDiff", "Show a diff and ask the user to accept or reject it."),
            tool("getDiagnostics", "Return language diagnostics (none in Turbo)."),
            tool("getOpenEditors", "Return open editors (none in Turbo)."),
            tool("getWorkspaceFolders", "Return the workspace folder."),
            tool("getCurrentSelection", "Return the editor selection (none in Turbo)."),
            tool("closeAllDiffTabs", "Close diff tabs."),
            tool("close_tab", "Close a tab."),
            tool("saveDocument", "Save a document."),
            tool("checkDocumentDirty", "Whether a document has unsaved changes."),
        ]
    })
}

fn text_result(s: &str) -> serde_json::Value {
    serde_json::json!({ "content": [{ "type": "text", "text": s }] })
}

async fn handle_ide_rpc(text: &str, app: &AppHandle) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let method = v.get("method").and_then(|m| m.as_str())?; // notifications/responses → ignore if no method
    let id = v.get("id").cloned();
    let reply = |result: serde_json::Value| {
        Some(serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string())
    };

    match method {
        "initialize" => reply(serde_json::json!({
            "protocolVersion": v.pointer("/params/protocolVersion").and_then(|p| p.as_str()).unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "Turbo", "version": "0.1.0" },
        })),
        "ping" => reply(serde_json::json!({})),
        "tools/list" => reply(ide_tool_list()),
        "tools/call" => {
            let name = v.pointer("/params/name").and_then(|n| n.as_str()).unwrap_or("");
            let args = v.pointer("/params/arguments").cloned().unwrap_or(serde_json::Value::Null);
            match name {
                "openDiff" => {
                    let new_path = args.get("new_file_path").and_then(|x| x.as_str()).unwrap_or("");
                    let old_path = args.get("old_file_path").and_then(|x| x.as_str()).unwrap_or("");
                    let new_c = args.get("new_file_contents").and_then(|x| x.as_str()).unwrap_or("");
                    let old_c = std::fs::read_to_string(if old_path.is_empty() { new_path } else { old_path }).unwrap_or_default();
                    let did = format!("diff-{}", IDE_DIFF_SEQ.fetch_add(1, Ordering::Relaxed));
                    let (tx, rx) = oneshot::channel();
                    ide_pending().lock().unwrap().insert(did.clone(), tx);
                    let _ = app.emit(
                        "turbo://ide-diff",
                        serde_json::json!({ "id": did, "path": if new_path.is_empty() { old_path } else { new_path }, "old": old_c, "new": new_c }).to_string(),
                    );
                    let accepted = rx.await.unwrap_or(false);
                    reply(text_result(if accepted { "FILE_SAVED" } else { "DIFF_REJECTED" }))
                }
                "getWorkspaceFolders" => {
                    let ws = ide_workspace().lock().unwrap().clone();
                    reply(text_result(&serde_json::json!({ "workspaceFolders": [ws] }).to_string()))
                }
                "getDiagnostics" => reply(text_result("[]")),
                "getOpenEditors" => reply(text_result(&serde_json::json!({ "tabs": [] }).to_string())),
                "getCurrentSelection" => reply(text_result(&serde_json::json!({ "success": false }).to_string())),
                _ => reply(text_result("OK")),
            }
        }
        _ => id.map(|_| serde_json::json!({ "jsonrpc": "2.0", "id": v.get("id").cloned(), "result": {} }).to_string()),
    }
}

// ———————————————————— PTY terminal ————————————————————
// A real pseudo-terminal so you can run *interactive* programs (like `claude`),
// which bill to your plan's interactive limits rather than the Agent SDK credit.
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

fn pty_sessions() -> &'static Mutex<HashMap<String, PtySession>> {
    static S: OnceLock<Mutex<HashMap<String, PtySession>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Open a login shell in a PTY of the given size; streams output as base64 via
/// `turbo://pty` ({id,data}) and signals exit via `turbo://pty-exit`.
#[tauri::command]
fn pty_open(
    window: tauri::Window,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sys = native_pty_system();
    let pair = sys
        .openpty(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-i");
    cmd.arg("-l");
    let dir = cwd
        .filter(|d| !d.is_empty() && std::path::Path::new(d).is_dir())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| "/".into());
    cmd.cwd(&dir);
    cmd.env("PATH", login_path());
    cmd.env("TERM", "xterm-256color");
    // let `claude` in this shell connect to Turbo as its IDE
    *ide_workspace().lock().unwrap() = dir.clone();
    if let Some((port, _)) = ide_info().get() {
        cmd.env("CLAUDE_CODE_SSE_PORT", port.to_string());
        cmd.env("ENABLE_IDE_INTEGRATION", "true");
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let win = window.clone();
    let rid = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = win.emit("turbo://pty", serde_json::json!({ "id": rid, "data": data }).to_string());
                }
            }
        }
        let _ = win.emit("turbo://pty-exit", rid);
    });

    pty_sessions()
        .lock()
        .unwrap()
        .insert(id, PtySession { writer, master: pair.master, child });
    Ok(())
}

/// Send keystrokes / text to a PTY.
#[tauri::command]
fn pty_write(id: String, data: String) -> Result<(), String> {
    let mut map = pty_sessions().lock().unwrap();
    let s = map.get_mut(&id).ok_or("no such pty")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    let _ = s.writer.flush();
    Ok(())
}

/// Resize a PTY to match the terminal viewport.
#[tauri::command]
fn pty_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = pty_sessions().lock().unwrap();
    if let Some(s) = map.get(&id) {
        s.master
            .resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Kill a PTY's process and drop the session.
#[tauri::command]
fn pty_kill(id: String) {
    if let Some(mut s) = pty_sessions().lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ask_agent,
            run_shell,
            home_dir,
            persona_path,
            read_usage,
            read_limits,
            list_sessions,
            load_session,
            speak,
            start_listening,
            stop_listening,
            pick_folder,
            find_git_repos,
            git_status,
            git_ai_message,
            git_commit,
            git_unpushed,
            git_unpulled,
            git_log,
            git_fetch,
            git_pull,
            git_push,
            pty_open,
            pty_write,
            pty_resize,
            pty_kill,
            ide_diff_result
        ])
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = win.primary_monitor() {
                    let screen = monitor.size();
                    if let Ok(wsize) = win.outer_size() {
                        let x = ((screen.width as i32 - wsize.width as i32) / 2).max(0);
                        let _ = win.set_position(PhysicalPosition::new(x, 0));
                    }
                }
            }
            start_ide_server(app.handle().clone()); // Claude Code IDE bridge
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Turbo the Cat");
}
