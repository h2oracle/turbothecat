# 🐱 Turbo the Cat

**Turbo the CAT — your Coding Agent Terminal.**

A cute desktop companion that lives at the top of your screen. Ask it anything,
watch its animated face react, and let it drive the **Claude** or **Codex** CLIs
you already have installed to write code and run terminal commands.

> **CAT** = **C**oding **A**gent **T**erminal

---

## How it works

Turbo is a [Tauri](https://tauri.app) app (Rust core + web UI). It doesn't talk
to any AI API directly. Instead it shells out to the CLIs you already have logged
in, so it rides your subscription auth:

| Backend | Driven via | Auth |
| --- | --- | --- |
| Claude | `claude -p … --output-format stream-json` | your Claude Max login |
| Codex  | `codex exec …` | your ChatGPT plan login |

Output is streamed back to the UI as events, which drive the talking-mouth
animation. A usage meter tallies **today's** spend by reading Claude Code's local
session logs (`~/.claude/projects/**/*.jsonl`) — the same data `ccusage` reads.

## Features

- 🟢 Thin, frameless, transparent, always-on-top **Dynamic-Island pill** pinned to the top-center — drag it anywhere
- 🐱 Expressive flat **cat face** — blinking eyes, a heart nose, a mouth that moves while talking, a tongue that licks, and two ears that twitch / open / close independently
- 💬 **Chat** tab — ask Claude or Codex anything; replies stream in and drive the talking mouth
- ⌨️ **Terminal** tab — a real streaming shell (runs through your login shell, `cd` sticks between commands)
- ⚙️ Claude-style **settings footer** — permission mode (Ask / Auto-accept / Plan / Bypass), model/effort (Opus / Sonnet / Haiku), backend switch
- ↔️ **Resizable** — step through preset sizes, toggle full screen, or drag the right/bottom/corner edges to make it as wide as you like (⌘ + / − / 0 too)
- 🔄 **Live sync** — open chats follow the underlying session, so messages added from another window or the `claude` CLI show up automatically (with an unread dot on inactive tabs)
- ⌨️ **Slash commands** — type `/` to see them all: `/chat`, `/terminal`, `/history`, `/clear`, `/cwd`, `/voice`, `/bigger`, `/smaller`, `/fullscreen`, `/persona`, `/help` …
- 🎙️ **"Hey Turbo" voice** — wake-word listening; if you ask by voice, Turbo answers out loud (system TTS)
- 📊 Live **burn meter** showing today's estimated spend from your Claude logs

> **Voice note:** the macOS webview (WKWebView) doesn't ship the Web Speech API, so the wake word works in browsers today but needs a small native speech helper on macOS — that's the next milestone. Turbo *talking back* (TTS via `say`) already works.

## Requirements

- **Node** ≥ 20, **pnpm**
- **Rust** (stable) — `curl https://sh.rustup.rs -sSf | sh`
- **Claude CLI** logged into your Max plan (`claude`) — required for the Claude backend
- **Codex CLI** logged into your ChatGPT plan (`codex`) — optional, for the Codex backend

## Run it

```bash
pnpm install
pnpm tauri dev      # or: ./node_modules/.bin/tauri dev
```

Build a distributable app:

```bash
pnpm tauri build    # produces a .app / .dmg on macOS, .msi / .exe on Windows
```

## Regenerate the icon

```bash
node scripts/make-icon.mjs
pnpm tauri icon src-tauri/icons/source.png
```

## Project layout

```
index.html              UI shell
src/
  main.ts               wires the bar, chat panel, usage meter
  face.ts               the animated SVG cat (idle / think / talk / error states)
  backend.ts            invokes the Rust commands, listens for streamed chunks
  styles.css            the pill + panel styling
src-tauri/
  src/lib.rs            ask_agent (spawns claude/codex), window placement
  src/usage.rs          today's spend from ~/.claude logs
  tauri.conf.json       frameless / transparent / always-on-top window config
scripts/make-icon.mjs   generates the cat app icon (pure zlib, no deps)
```

## Roadmap ideas

- Token-by-token streaming (`--include-partial-messages`) for smoother mouth sync
- Voice output (TTS) with viseme-driven mouth shapes
- A "build me an app" mode that launches a coding agent in a chosen folder
- Click-through on the transparent areas
- Persist chat history and let Turbo remember context across questions
- Global hotkey to summon/dismiss

## Disclaimer

Turbo is an independent, unofficial tool. It is not affiliated with, endorsed by,
or sponsored by Anthropic or OpenAI. "Claude" and "Codex" are referenced only to
describe the third-party CLIs Turbo invokes.

Turbo runs whichever `claude` / `codex` CLIs you have installed and logged in, and
inherits whatever authentication those tools already use on your machine. You are
responsible for using it in accordance with each provider's Terms of Service.
Consumer subscription plans are generally intended for personal, interactive use —
review the relevant terms before relying on Turbo for anything beyond that.
