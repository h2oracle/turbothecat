//! Turbo the Cat core. Spawns the `claude` / `codex` CLIs (which authenticate
//! against your Max / ChatGPT subscriptions) and a real login shell for the
//! terminal, streaming their output to the UI. Also tallies today's spend from
//! Claude Code's logs.

mod usage;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager, PhysicalPosition};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

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
    let mut cmd = match backend.as_str() {
        "claude" => {
            let mut c = Command::new("claude");
            c.arg("-p")
                .arg(&prompt)
                .arg("--output-format")
                .arg("stream-json")
                .arg("--verbose");
            if let Some(mode) = permissionMode.as_ref().filter(|m| !m.is_empty()) {
                c.arg("--permission-mode").arg(mode);
            }
            if let Some(m) = model.as_ref().filter(|m| !m.is_empty()) {
                c.arg("--model").arg(m);
            }
            if let Some(p) = persona() {
                c.arg("--append-system-prompt").arg(p);
            }
            if let Some(sid) = sessionId.as_ref().filter(|s| !s.is_empty()) {
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
            stop_listening
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Turbo the Cat");
}
