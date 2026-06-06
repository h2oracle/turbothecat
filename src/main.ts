import "./styles.css";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { CatFace } from "./face";
import {
  ask,
  runShell,
  homeDir,
  speak,
  fetchUsage,
  currencySymbol,
  startListening,
  personaPath,
  listSessions,
  loadSession,
  readLimits,
  type Backend,
  type SessionInfo,
  type ChatEntry,
} from "./backend";
import * as fx from "./effects";

const appWindow = getCurrentWindow();
const COLLAPSE = { w: 100, h: 100 };
const OPEN = { w: 620, h: 560 };

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = /* html */ `
  <div class="mascot" id="mascot" title="Click to chat · drag to move"></div>

  <div class="panel" id="panel">
    <div class="tabbar" id="tabbar"></div>
    <div class="views" id="views"></div>
    <div class="composer" id="composer">
      <span class="cwd" id="cwd"></span>
      <input class="prompt" id="prompt" placeholder="Ask Turbo anything…" autocomplete="off" spellcheck="false" />
      <button class="icon-btn" id="mic" title="Hey Turbo — voice">🎙️</button>
    </div>
    <div class="footer">
      <select id="backend" title="AI backend">
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
      <select id="perm" title="Permission mode">
        <option value="default">Ask first</option>
        <option value="acceptEdits">Auto-accept edits</option>
        <option value="plan">Plan mode</option>
        <option value="bypassPermissions">Bypass (YOLO)</option>
      </select>
      <select id="model" title="Model / effort">
        <option value="">Default model</option>
        <option value="opus">Opus</option>
        <option value="sonnet">Sonnet</option>
        <option value="haiku">Haiku</option>
      </select>
      <span class="spacer"></span>
      <span class="usage" id="usage" title="Today's spend"><span id="cost">…</span></span>
    </div>
  </div>

  <div class="slash" id="slash"></div>
  <div class="tabmenu" id="tabmenu"></div>
  <div class="usagepop" id="usagepop"></div>
`;

const mascot = document.querySelector<HTMLDivElement>("#mascot")!;
const face = new CatFace(mascot);
const input = document.querySelector<HTMLInputElement>("#prompt")!;
const panel = document.querySelector<HTMLDivElement>("#panel")!;
const tabbar = document.querySelector<HTMLDivElement>("#tabbar")!;
const views = document.querySelector<HTMLDivElement>("#views")!;
const cwdEl = document.querySelector<HTMLSpanElement>("#cwd")!;
const costEl = document.querySelector<HTMLSpanElement>("#cost")!;
const usageEl = document.querySelector<HTMLDivElement>("#usage")!;
const usagePop = document.querySelector<HTMLDivElement>("#usagepop")!;
const micBtn = document.querySelector<HTMLButtonElement>("#mic")!;
const slashEl = document.querySelector<HTMLDivElement>("#slash")!;
const tabmenu = document.querySelector<HTMLDivElement>("#tabmenu")!;
const backendSel = document.querySelector<HTMLSelectElement>("#backend")!;
const permSel = document.querySelector<HTMLSelectElement>("#perm")!;
const modelSel = document.querySelector<HTMLSelectElement>("#model")!;

// Persist the AI settings (backend / permission mode / model) across sessions.
for (const sel of [backendSel, permSel, modelSel]) {
  const key = `turbo.${sel.id}`;
  const saved = localStorage.getItem(key);
  if (saved !== null) sel.value = saved;
  sel.addEventListener("change", () => localStorage.setItem(key, sel.value));
}

let homePath = "/";
let voiceTurn = false;
let curW = COLLAPSE.w;
let lastPanelDown = 0;

const shortCwd = (p: string) => (homePath && p.startsWith(homePath) ? p.replace(homePath, "~") : p);

// ———————————————————— tabs ————————————————————
type TabType = "chat" | "terminal" | "history";
interface Tab {
  id: number;
  type: TabType;
  title: string;
  view: HTMLDivElement;
  body: HTMLDivElement;
  cwd: string;
  busy: boolean;
  sessionId?: string; // Claude session to resume (chat tabs)
}
interface RestoreTab {
  type: TabType;
  title: string;
  cwd?: string;
  sessionId?: string;
  html?: string;
}
let tabs: Tab[] = [];
let activeId = -1;
let nextId = 1;
const active = () => tabs.find((t) => t.id === activeId)!;

function createTab(type: TabType, restore?: RestoreTab): Tab {
  const id = nextId++;
  const n = tabs.filter((t) => t.type === type).length + 1;
  const defaultTitle =
    type === "terminal"
      ? n > 1
        ? `zsh ${n}`
        : "zsh"
      : type === "history"
        ? "History"
        : n > 1
          ? `Chat ${n}`
          : "Chat";
  const title = restore?.title ?? defaultTitle;
  const view = document.createElement("div");
  view.className = "view";
  const body = document.createElement("div");
  body.className = type === "terminal" ? "term" : type === "history" ? "history" : "log";
  view.appendChild(body);
  views.appendChild(view);
  const tab: Tab = {
    id,
    type,
    title,
    view,
    body,
    cwd: restore?.cwd ?? homePath,
    busy: false,
    sessionId: restore?.sessionId,
  };
  tabs.push(tab);
  selectTab(id);
  if (restore?.html !== undefined) {
    body.innerHTML = restore.html;
  } else if (type === "terminal") {
    addTerm(tab, `Turbo terminal — ${shortCwd(tab.cwd)}`, "dim");
  }
  if (type === "history") renderHistory(tab);
  if (!restore) saveState();
  return tab;
}

function closeTab(id: number) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  tabs[i].view.remove();
  tabs.splice(i, 1);
  if (!tabs.length) {
    createTab("chat");
    return;
  }
  if (activeId === id) selectTab(tabs[Math.max(0, i - 1)].id);
  else renderTabs();
  saveState();
}

function selectTab(id: number) {
  activeId = id;
  tabs.forEach((t) => t.view.classList.toggle("hidden", t.id !== id));
  renderTabs();
  updateComposer();
  input.focus();
}

function renderTabs() {
  tabbar.innerHTML = "";
  for (const t of tabs) {
    const b = document.createElement("button");
    b.className = "tab" + (t.id === activeId ? " active" : "");
    const icon = t.type === "terminal" ? "⌨️" : t.type === "history" ? "🕘" : "💬";
    b.innerHTML = `<span class="ti">${icon} ${t.title}</span>`;
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(t.id);
    });
    b.appendChild(x);
    b.addEventListener("click", () => selectTab(t.id));
    tabbar.appendChild(b);
  }
  const plus = document.createElement("button");
  plus.className = "tab plus";
  plus.textContent = "+";
  plus.title = "New tab";
  plus.addEventListener("click", (e) => {
    e.stopPropagation();
    openTabMenu(plus);
  });
  tabbar.appendChild(plus);
}

function openTabMenu(anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  tabmenu.innerHTML = `
    <div class="item" data-t="chat">💬 New chat</div>
    <div class="item" data-t="terminal">⌨️ New terminal</div>
    <div class="item" data-t="history">🕘 History</div>`;
  tabmenu.style.left = `${r.left}px`;
  tabmenu.style.top = `${r.bottom + 4}px`;
  tabmenu.classList.add("open");
  tabmenu.querySelectorAll<HTMLElement>(".item").forEach((el) =>
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      tabmenu.classList.remove("open");
      createTab(el.dataset.t as TabType);
    }),
  );
}
document.addEventListener("click", (e) => {
  const t = e.target as Node;
  if (!tabmenu.contains(t)) tabmenu.classList.remove("open");
  if (!usagePop.contains(t) && !usageEl.contains(t)) usagePop.classList.remove("open");
});

function updateComposer() {
  const t = active();
  const composer = document.querySelector<HTMLDivElement>(".composer")!;
  if (t.type === "history") {
    composer.style.display = "none";
    return;
  }
  composer.style.display = "";
  if (t.type === "terminal") {
    cwdEl.style.display = "";
    cwdEl.textContent = `${shortCwd(t.cwd)} $`;
    input.placeholder = "run a command…";
  } else {
    cwdEl.style.display = "none";
    input.placeholder = "Ask Turbo anything…";
  }
}

// ———————————————————— window open/close ————————————————————
const isOpen = () => panel.classList.contains("open");

async function setOpen(open: boolean) {
  if (open === isOpen()) return;
  panel.classList.toggle("open", open);
  mascot.classList.toggle("open", open);
  const tW = open ? OPEN.w : COLLAPSE.w;
  const tH = open ? OPEN.h : COLLAPSE.h;
  try {
    const scale = await appWindow.scaleFactor();
    const pos = await appWindow.outerPosition();
    const centerX = pos.x / scale + curW / 2;
    await appWindow.setSize(new LogicalSize(tW, tH));
    await appWindow.setPosition(new LogicalPosition(Math.max(0, centerX - tW / 2), pos.y / scale));
    curW = tW;
  } catch {
    /* not in tauri */
  }
  if (open) {
    face.greet();
    fx.hearts(7);
    setTimeout(() => input.focus(), 60);
  }
}

// close when the window loses focus (click off), unless we just touched the panel
appWindow.onFocusChanged(({ payload: focused }) => {
  if (!focused && isOpen() && performance.now() - lastPanelDown > 400) setOpen(false);
});
panel.addEventListener("mousedown", () => (lastPanelDown = performance.now()));

// ———————————————————— mascot: click to open, drag to move ————————————————————
let down: { x: number; y: number } | null = null;
let moved = false;
mascot.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  down = { x: e.screenX, y: e.screenY };
  moved = false;
});
window.addEventListener("mousemove", (e) => {
  if (!down) return;
  if (!moved && Math.hypot(e.screenX - down.x, e.screenY - down.y) > 4) {
    moved = true;
    down = null;
    appWindow.startDragging().catch(() => {});
  }
});
window.addEventListener("mouseup", () => {
  if (down && !moved) setOpen(!isOpen());
  down = null;
});

// ———————————————————— chat ————————————————————
function addMsg(t: Tab, kind: "user" | "bot", text = ""): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  el.textContent = text;
  t.body.appendChild(el);
  t.view.scrollTop = t.view.scrollHeight;
  return el;
}

async function runChat(t: Tab, text: string) {
  t.busy = true;
  addMsg(t, "user", text);
  const bot = addMsg(t, "bot", "…");
  face.set("think");
  let first = true;
  let reply = "";
  await ask(
    backendSel.value as Backend,
    text,
    null,
    { permissionMode: permSel.value, model: modelSel.value, sessionId: t.sessionId },
    {
      onChunk: (chunk) => {
        if (first) {
          bot.textContent = "";
          face.set("talk");
          first = false;
        }
        reply += chunk;
        bot.textContent = reply;
        t.view.scrollTop = t.view.scrollHeight;
      },
      onTool: (line) => {
        const s = document.createElement("span");
        s.className = "tool";
        s.textContent = `⚙ ${line}`;
        bot.appendChild(s);
        t.view.scrollTop = t.view.scrollHeight;
      },
      onDone: (result) => {
        face.set("idle");
        t.busy = false;
        if (result?.sessionId) t.sessionId = result.sessionId; // remember for next turn
        fx.confetti(22);
        face.hearts();
        if (voiceTurn && reply.trim()) speak(reply.slice(0, 600));
        voiceTurn = false;
        refreshUsage();
        saveState();
      },
      onError: (msg) => {
        bot.classList.add("error");
        bot.textContent = msg || "Something went wrong.";
        face.set("error");
        t.busy = false;
        voiceTurn = false;
        setTimeout(() => face.set("idle"), 2600);
        saveState();
      },
    },
  );
}

// ———————————————————— terminal ————————————————————
function addTerm(t: Tab, text: string, cls = "") {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text + "\n";
  t.body.appendChild(span);
  t.view.scrollTop = t.view.scrollHeight;
}

async function runTerminal(t: Tab, cmd: string) {
  t.busy = true;
  pushCmd(cmd);
  addTerm(t, `${shortCwd(t.cwd)} $ ${cmd}`, "cmd");
  face.set("think");
  try {
    const res = await runShell(cmd, t.cwd, (line) => addTerm(t, line));
    t.cwd = res.cwd || t.cwd;
    if (res.code !== 0) addTerm(t, `[exit ${res.code}]`, "err");
    if (active().id === t.id) updateComposer();
  } catch (e) {
    addTerm(t, String(e), "err");
  }
  face.set("idle");
  t.busy = false;
  saveState();
}

// ———————————————————— terminal command history ————————————————————
let cmdHistory: string[] = [];
try {
  cmdHistory = JSON.parse(localStorage.getItem("turbo.cmdhist") || "[]");
} catch {
  cmdHistory = [];
}
let cmdIdx = cmdHistory.length;

function pushCmd(c: string) {
  if (!c.trim()) return;
  cmdHistory = cmdHistory.filter((x) => x !== c);
  cmdHistory.push(c);
  if (cmdHistory.length > 200) cmdHistory = cmdHistory.slice(-200);
  localStorage.setItem("turbo.cmdhist", JSON.stringify(cmdHistory));
  cmdIdx = cmdHistory.length;
}
function recallCmd(dir: number) {
  if (active().type !== "terminal" || !cmdHistory.length) return;
  cmdIdx = Math.max(0, Math.min(cmdHistory.length, cmdIdx + dir));
  input.value = cmdHistory[cmdIdx] ?? "";
}

// ———————————————————— history tab ————————————————————
async function renderHistory(tab: Tab) {
  tab.body.innerHTML = `<div class="hinfo">Loading past chats…</div>`;
  let sessions: SessionInfo[] = [];
  try {
    sessions = await listSessions();
  } catch {
    tab.body.innerHTML = `<div class="hinfo">Couldn't read history.</div>`;
    return;
  }
  if (!sessions.length) {
    tab.body.innerHTML = `<div class="hinfo">No past chats yet.</div>`;
    return;
  }
  tab.body.innerHTML = "";
  for (const s of sessions) {
    const el = document.createElement("div");
    el.className = "hitem";
    const when = new Date(s.mtime * 1000).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const proj = s.cwd.split("/").filter(Boolean).pop() || "";
    const title = document.createElement("div");
    title.className = "htitle";
    title.textContent = s.title;
    const meta = document.createElement("div");
    meta.className = "hmeta";
    meta.textContent = `${when}${proj ? " · " + proj : ""}`;
    el.append(title, meta);
    el.addEventListener("click", () => reloadSession(s));
    tab.body.appendChild(el);
  }
}

async function reloadSession(s: SessionInfo) {
  const t = createTab("chat", {
    type: "chat",
    title: s.title.slice(0, 22) || "Chat",
    sessionId: s.id,
    cwd: s.cwd,
  });
  addMsg(t, "bot", "…");
  let entries: ChatEntry[] = [];
  try {
    entries = await loadSession(s.id);
  } catch {
    /* */
  }
  t.body.innerHTML = "";
  if (!entries.length) addMsg(t, "bot", "(couldn't load this chat's messages, but I can still continue it)");
  for (const e of entries) addMsg(t, e.role, e.text);
  t.view.scrollTop = t.view.scrollHeight;
  saveState();
}

// ———————————————————— persistence ————————————————————
function saveState() {
  const snap = tabs
    .filter((t) => t.type !== "history")
    .map((t) => ({ type: t.type, title: t.title, cwd: t.cwd, sessionId: t.sessionId, html: t.body.innerHTML }));
  const activeIdx = tabs.findIndex((t) => t.id === activeId);
  localStorage.setItem("turbo.tabs", JSON.stringify({ tabs: snap, active: activeIdx }));
}
function loadState(): boolean {
  try {
    const raw = localStorage.getItem("turbo.tabs");
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data?.tabs?.length) return false;
    for (const s of data.tabs as RestoreTab[]) createTab(s.type, s);
    return tabs.length > 0;
  } catch {
    return false;
  }
}

// ———————————————————— slash commands ————————————————————
interface Slash {
  cmd: string;
  desc: string;
  run: () => void;
}
const COMMANDS: Slash[] = [
  { cmd: "/chat", desc: "New chat tab", run: () => createTab("chat") },
  { cmd: "/terminal", desc: "New terminal tab", run: () => createTab("terminal") },
  { cmd: "/clear", desc: "Clear this tab", run: () => (active().body.innerHTML = "") },
  { cmd: "/hearts", desc: "Throw some love", run: () => { fx.hearts(16); face.hearts(); } },
  { cmd: "/confetti", desc: "Celebrate!", run: () => fx.confetti(40) },
  { cmd: "/lick", desc: "Turbo licks", run: () => face.licks() },
  { cmd: "/close", desc: "Close this tab", run: () => closeTab(activeId) },
  { cmd: "/persona", desc: "Edit Turbo's personality", run: showPersona },
  { cmd: "/help", desc: "List commands", run: showHelp },
];

async function showPersona() {
  const p = await personaPath();
  const t = tabs.find((x) => x.type === "chat") ?? createTab("chat");
  selectTab(t.id);
  addMsg(t, "bot", `My personality lives in this file — edit it and I'll change:\n${p}`);
}
let slashItems: Slash[] = [];
let slashSel = 0;

function showHelp() {
  const t = active().type === "chat" ? active() : (tabs.find((x) => x.type === "chat") ?? createTab("chat"));
  selectTab(t.id);
  addMsg(t, "bot", "Commands:\n" + COMMANDS.map((c) => `  ${c.cmd} — ${c.desc}`).join("\n"));
}
function updateSlash() {
  const v = input.value;
  if (!v.startsWith("/") || v.includes(" ")) return hideSlash();
  slashItems = COMMANDS.filter((c) => c.cmd.startsWith(v.toLowerCase()));
  if (!slashItems.length) return hideSlash();
  slashSel = Math.min(slashSel, slashItems.length - 1);
  slashEl.innerHTML = slashItems
    .map(
      (c, i) =>
        `<div class="item ${i === slashSel ? "sel" : ""}" data-i="${i}"><span class="cmd">${c.cmd}</span><span class="desc">${c.desc}</span></div>`,
    )
    .join("");
  const r = input.getBoundingClientRect();
  slashEl.style.left = `${r.left}px`;
  slashEl.style.bottom = `${window.innerHeight - r.top + 6}px`;
  slashEl.classList.add("open");
  slashEl.querySelectorAll<HTMLElement>(".item").forEach((el) =>
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pickSlash(Number(el.dataset.i));
    }),
  );
}
function hideSlash() {
  slashEl.classList.remove("open");
}
function pickSlash(i: number) {
  const c = slashItems[i];
  if (!c) return;
  input.value = "";
  hideSlash();
  c.run();
}

// ———————————————————— submit ————————————————————
async function submit() {
  if (slashEl.classList.contains("open")) {
    pickSlash(slashSel);
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  const t = active();
  if (t.busy) return;
  input.value = "";
  hideSlash();
  if (t.type === "chat") await runChat(t, text);
  else await runTerminal(t, text);
}

input.addEventListener("input", updateSlash);
input.addEventListener("keydown", (e) => {
  if (slashEl.classList.contains("open")) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      slashSel = (slashSel + 1) % slashItems.length;
      updateSlash();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      slashSel = (slashSel - 1 + slashItems.length) % slashItems.length;
      updateSlash();
      return;
    }
    if (e.key === "Escape") return hideSlash();
  } else if (active().type === "terminal") {
    // recall previous commands in a terminal tab
    if (e.key === "ArrowUp") {
      e.preventDefault();
      recallCmd(-1);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      recallCmd(1);
      return;
    }
  }
  if (e.key === "Enter") submit();
  else if (e.key === "Escape") setOpen(false);
});

// ———————————————————— voice: native "Hey Turbo" ————————————————————
let voiceOn = false;
let voiceStop: (() => void) | null = null;
let voicePartial = "";
let voiceSilence: number | undefined;
// matches "hey turbo …", "ok turbo …", or just "turbo …"; captures the command.
const WAKE = /(?:hey |hi |ok |hey,? )?turbo\b[\s,.:!?-]*(.*)/i;

// Live transcript while you speak. If we hear the wake word, open up, show the
// command building in the box, and submit it after a brief silence.
function onVoicePartial(text: string) {
  if (!voiceOn) return;
  voicePartial = text;
  setOpen(true);
  const m = text.match(WAKE);
  // Live dictation: show the command (after the wake word) or the raw words so
  // you can see Turbo is hearing you. Auto-submits only when the wake word fired.
  input.value = m ? (m[1] || "").trim() : text.trim();
  if (m) face.set("think");
  clearTimeout(voiceSilence);
  voiceSilence = window.setTimeout(finalizeVoice, 1100);
}

// Recognizer marked an utterance final — act on it now.
function onVoiceText(text: string) {
  if (!voiceOn) return;
  if (WAKE.test(text)) {
    voicePartial = text;
    finalizeVoice();
  }
}

function finalizeVoice() {
  clearTimeout(voiceSilence);
  const m = voicePartial.match(WAKE);
  voicePartial = "";
  const cmd = (m?.[1] || "").trim();
  if (cmd.length > 1) {
    voiceTurn = true;
    setOpen(true);
    input.value = cmd;
    submit();
  } else {
    face.set("idle");
  }
}

function onVoiceStatus(status: string) {
  if (status === "ready") {
    micBtn.classList.add("listening");
    return;
  }
  if (status.startsWith("error:")) {
    voiceOn = false;
    micBtn.classList.remove("listening");
    localStorage.setItem("turbo.voice", "0");
    const pane = status.includes("mic") ? "Microphone" : "Speech Recognition";
    const t = tabs.find((x) => x.type === "chat") ?? createTab("chat");
    selectTab(t.id);
    addMsg(
      t,
      "bot",
      `I need ${pane} permission. Open System Settings → Privacy & Security → ${pane}, enable Turbo, then tap the mic again. 🐱`,
    );
  }
}

async function toggleVoice() {
  if (voiceOn) {
    voiceStop?.();
    voiceStop = null;
    voiceOn = false;
    micBtn.classList.remove("listening");
    micBtn.title = "Hey Turbo — voice";
    localStorage.setItem("turbo.voice", "0");
    return;
  }
  voiceOn = true;
  micBtn.classList.add("listening");
  micBtn.title = "Listening for “Hey Turbo” — click to stop";
  localStorage.setItem("turbo.voice", "1");
  try {
    voiceStop = await startListening(onVoiceText, onVoicePartial, onVoiceStatus);
  } catch (e) {
    voiceOn = false;
    micBtn.classList.remove("listening");
    onVoiceStatus("error:" + String(e));
  }
}
micBtn.addEventListener("click", toggleVoice);

// ———————————————————— usage meter + limits popup ————————————————————
type Usage = Awaited<ReturnType<typeof fetchUsage>>;
let lastUsage: Usage | null = null;

async function refreshUsage() {
  try {
    const u = await fetchUsage();
    lastUsage = u;
    costEl.textContent = `${currencySymbol(u.currency)}${u.todayCost.toFixed(2)}`;
  } catch {
    /* no logs yet */
  }
}

async function showUsagePopup() {
  if (usagePop.classList.contains("open")) {
    usagePop.classList.remove("open");
    return;
  }
  const u = lastUsage;
  const sym = u ? currencySymbol(u.currency) : "£";
  let html = `<div class="uphead">Today's spend</div>`;
  if (u && u.models.length) {
    for (const m of u.models) {
      html += `<div class="uprow"><span>${m.name}</span><span>${sym}${m.cost.toFixed(2)} · ${m.calls} calls</span></div>`;
    }
    html += `<div class="uprow total"><span>Total</span><span>${sym}${u.todayCost.toFixed(2)}</span></div>`;
    html += `<div class="upmeta">${(u.todayTokens / 1e6).toFixed(1)}M tokens today</div>`;
  } else {
    html += `<div class="upmeta">No usage yet today.</div>`;
  }

  let lim = null;
  try {
    lim = await readLimits();
  } catch {
    /* */
  }
  if (lim && lim.resetsAt) {
    const reset = new Date(lim.resetsAt * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const label = lim.rateLimitType === "five_hour" ? "5-hour limit" : lim.rateLimitType || "Limit";
    const ok = (lim.status || "allowed") === "allowed";
    html += `<div class="uphead">${label}</div>`;
    html += `<div class="uprow"><span class="${ok ? "ok" : "warn"}">${lim.status || "allowed"}</span><span>resets ${reset}</span></div>`;
    if (lim.isUsingOverage) html += `<div class="upmeta warn">using overage credits</div>`;
  } else {
    html += `<div class="upmeta">Ask Turbo something to load live limits.</div>`;
  }

  usagePop.innerHTML = html;
  const r = usageEl.getBoundingClientRect();
  usagePop.style.right = `${Math.max(6, window.innerWidth - r.right)}px`;
  usagePop.style.bottom = `${window.innerHeight - r.top + 8}px`;
  usagePop.classList.add("open");
}
usageEl.addEventListener("click", (e) => {
  e.stopPropagation();
  showUsagePopup();
});

// ———————————————————— boot ————————————————————
(async () => {
  try {
    homePath = await homeDir();
  } catch {
    /* */
  }
  if (!loadState()) createTab("chat");
  refreshUsage();
  setInterval(refreshUsage, 30_000);
  // Resume "Hey Turbo" listening if it was enabled last session.
  if (localStorage.getItem("turbo.voice") === "1") toggleVoice();
})();
