// Bridge to the Rust side. Rust spawns the `claude` / `codex` CLIs (which use
// your Max / ChatGPT subscription auth) and a login shell for the terminal,
// streaming output back as events.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Backend = "claude" | "codex";

export interface AgentHandlers {
  onChunk: (text: string) => void;
  onTool?: (line: string) => void;
  onDone: (result?: { costUsd?: number; tokens?: number; sessionId?: string }) => void;
  onError: (message: string) => void;
}

export interface AskOptions {
  permissionMode?: string;
  model?: string;
  sessionId?: string | null;
}

// Ask the AI. Resolves when the run finishes.
export async function ask(
  backend: Backend,
  prompt: string,
  cwd: string | null,
  opts: AskOptions,
  h: AgentHandlers,
): Promise<void> {
  const unlisten: UnlistenFn[] = [];
  unlisten.push(await listen<string>("turbo://chunk", (e) => h.onChunk(e.payload)));
  unlisten.push(await listen<string>("turbo://tool", (e) => h.onTool?.(e.payload)));
  try {
    const result = await invoke<{ costUsd?: number; tokens?: number; sessionId?: string } | null>(
      "ask_agent",
      {
        backend,
        prompt,
        cwd,
        permissionMode: opts.permissionMode ?? null,
        model: opts.model ?? null,
        sessionId: opts.sessionId ?? null,
      },
    );
    h.onDone(result ?? undefined);
  } catch (err) {
    h.onError(String(err));
  } finally {
    unlisten.forEach((u) => u());
  }
}

export interface ShellResult {
  code: number;
  cwd: string;
}

// Run a shell command, streaming combined stdout/stderr line-by-line.
export async function runShell(
  cmd: string,
  cwd: string,
  onLine: (line: string) => void,
): Promise<ShellResult> {
  const un = await listen<string>("turbo://term", (e) => onLine(e.payload));
  try {
    return await invoke<ShellResult>("run_shell", { cmd, cwd });
  } finally {
    un();
  }
}

export async function homeDir(): Promise<string> {
  return invoke("home_dir");
}

export async function personaPath(): Promise<string> {
  return invoke("persona_path");
}

export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  mtime: number;
}
export interface ChatEntry {
  role: "user" | "bot";
  text: string;
}

export async function listSessions(): Promise<SessionInfo[]> {
  return invoke("list_sessions");
}
export async function loadSession(id: string): Promise<ChatEntry[]> {
  return invoke("load_session", { id });
}

// Native "Hey Turbo" listener. Returns a stop function.
export async function startListening(
  onText: (transcript: string) => void,
  onPartial: (transcript: string) => void,
  onStatus: (status: string) => void,
): Promise<() => void> {
  const un1 = await listen<string>("turbo://voice", (e) => onText(e.payload));
  const un2 = await listen<string>("turbo://voice-partial", (e) => onPartial(e.payload));
  const un3 = await listen<string>("turbo://voice-status", (e) => onStatus(e.payload));
  await invoke("start_listening");
  return () => {
    un1();
    un2();
    un3();
    invoke("stop_listening").catch(() => {});
  };
}

export async function speak(text: string): Promise<void> {
  try {
    await invoke("speak", { text });
  } catch {
    /* non-macOS or unavailable */
  }
}

export interface ModelUsage {
  name: string;
  cost: number;
  calls: number;
}
export async function fetchUsage(): Promise<{
  todayCost: number;
  currency: string;
  todayTokens: number;
  source: string;
  models: ModelUsage[];
}> {
  return invoke("read_usage");
}

export interface RateLimit {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  overageResetsAt?: number;
  isUsingOverage?: boolean;
}
export async function readLimits(): Promise<RateLimit | null> {
  return invoke("read_limits");
}

// ———————————————————— git ————————————————————
export interface RepoInfo {
  path: string;
  name: string;
}
export interface GitFile {
  status: string;
  path: string;
}
export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFile[];
  clean: boolean;
}

export async function pickFolder(): Promise<string | null> {
  return invoke("pick_folder");
}
export async function findGitRepos(root: string): Promise<RepoInfo[]> {
  return invoke("find_git_repos", { root });
}
export async function gitStatus(repo: string): Promise<GitStatus> {
  return invoke("git_status", { repo });
}
export async function gitAiMessage(repo: string): Promise<string> {
  return invoke("git_ai_message", { repo });
}
export async function gitCommit(repo: string, message: string): Promise<string> {
  return invoke("git_commit", { repo, message });
}
export async function gitUnpushed(repo: string): Promise<string[]> {
  return invoke("git_unpushed", { repo });
}
export async function gitUnpulled(repo: string): Promise<string[]> {
  return invoke("git_unpulled", { repo });
}
export async function gitLog(repo: string): Promise<string> {
  return invoke("git_log", { repo });
}
export async function gitFetch(repo: string): Promise<string> {
  return invoke("git_fetch", { repo });
}
export async function gitPull(repo: string): Promise<string> {
  return invoke("git_pull", { repo });
}
export async function gitPush(repo: string): Promise<string> {
  return invoke("git_push", { repo });
}

export function currencySymbol(code: string): string {
  switch (code) {
    case "GBP":
      return "£";
    case "EUR":
      return "€";
    case "USD":
      return "$";
    default:
      return code + " ";
  }
}
