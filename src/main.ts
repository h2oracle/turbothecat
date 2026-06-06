import "./styles.css";
import { getCurrentWindow, currentMonitor, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
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
// Roomy enough for the soft shadow AND the tail that sweeps over her head.
const COLLAPSE = { w: 150, h: 150 };
// Discrete open sizes the user can step through (S / M / L / XL).
const SIZES = [
  { w: 460, h: 420 },
  { w: 620, h: 560 },
  { w: 820, h: 720 },
  { w: 1040, h: 880 },
];
const clampIdx = (n: number) => Math.max(0, Math.min(SIZES.length - 1, n));
let sizeIdx = clampIdx(parseInt(localStorage.getItem("turbo.size") ?? "1", 10) || 1);
let fullscreen = localStorage.getItem("turbo.fs") === "1";
// A free-form size from dragging the resize handles; overrides the preset when set.
let customSize: { w: number; h: number } | null = null;
try {
  customSize = JSON.parse(localStorage.getItem("turbo.custom") || "null");
} catch {
  customSize = null;
}
// Where the cat was floating before we opened, so we can return there on close.
let preOpen: { x: number; y: number } | null = null;

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = /* html */ `
  <div class="mascot" id="mascot" title="Click to chat · drag to move"></div>

  <div class="bubble" id="bubble"><span class="bubble-content" id="bubbleContent"></span></div>

  <div class="panel" id="panel">
    <div class="header">
      <div class="tabbar" id="tabbar"></div>
      <div class="winctrls" id="winctrls">
        <button class="wc" id="wcSmaller" title="Smaller (⌘−)">−</button>
        <button class="wc" id="wcBigger" title="Bigger (⌘+)">+</button>
        <button class="wc" id="wcFull" title="Full screen">⤢</button>
      </div>
    </div>
    <div class="views" id="views">
      <button class="toend" id="toEnd" title="Jump to latest">↓</button>
    </div>
    <div class="rz rz-e" id="rzE" title="Drag to resize"></div>
    <div class="rz rz-s" id="rzS" title="Drag to resize"></div>
    <div class="rz rz-se" id="rzSE" title="Drag to resize"></div>
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

// A tiny wagging tail poking out of the top-right of the circle. Appended after
// CatFace (which owns the mascot's inner SVG) so it isn't overwritten.
const tail = document.createElement("div");
tail.className = "tail";
tail.innerHTML = /* html */ `<svg viewBox="0 0 24 36" xmlns="http://www.w3.org/2000/svg">
  <path d="M9 36 C 6 28 7 18 11 12 C 14 8 17 7 16 4 C 20 6 20 12 17 17 C 14 22 14 30 15 36 Z" fill="#0a0a0c"/>
</svg>`;
mascot.appendChild(tail);
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
const wcSmaller = document.querySelector<HTMLButtonElement>("#wcSmaller")!;
const wcBigger = document.querySelector<HTMLButtonElement>("#wcBigger")!;
const wcFull = document.querySelector<HTMLButtonElement>("#wcFull")!;
const toEndBtn = document.querySelector<HTMLButtonElement>("#toEnd")!;
const bubble = document.querySelector<HTMLDivElement>("#bubble")!;
const bubbleContent = document.querySelector<HTMLSpanElement>("#bubbleContent")!;

// Whether a scroll container is parked at (or near) its bottom.
const NEAR_BOTTOM = 80;
const atBottom = (v: HTMLElement) => v.scrollHeight - v.scrollTop - v.clientHeight < NEAR_BOTTOM;
const scrollToEnd = (v: HTMLElement) => (v.scrollTop = v.scrollHeight);

// Show the "jump to latest" arrow when the active view is scrolled up.
function updateToEnd() {
  const t = tabs.find((x) => x.id === activeId);
  toEndBtn.classList.toggle("show", !!t && t.type !== "history" && !atBottom(t.view));
}
toEndBtn.addEventListener("click", () => {
  const t = tabs.find((x) => x.id === activeId);
  if (t) {
    scrollToEnd(t.view);
    updateToEnd();
  }
});

// Persist the AI settings (backend / permission mode / model) across sessions.
for (const sel of [backendSel, permSel, modelSel]) {
  const key = `turbo.${sel.id}`;
  const saved = localStorage.getItem(key);
  if (saved !== null) sel.value = saved;
  sel.addEventListener("change", () => localStorage.setItem(key, sel.value));
}

let homePath = "/";
let voiceTurn = false;
let lastPanelDown = 0;
let lastInteract = 0; // last time the user touched the cat (to time idle quips)

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
  syncCount?: number; // session entries already shown (for live cross-window sync)
  unread?: boolean; // external messages arrived while this tab was inactive
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
  view.addEventListener("scroll", () => {
    if (id === activeId) updateToEnd();
  });
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
  const t = tabs.find((x) => x.id === id);
  if (t) {
    t.unread = false;
    t.view.scrollTop = t.view.scrollHeight;
  }
  tabs.forEach((x) => x.view.classList.toggle("hidden", x.id !== id));
  renderTabs();
  updateComposer();
  updateToEnd();
  input.focus();
}

function renderTabs() {
  tabbar.innerHTML = "";
  for (const t of tabs) {
    const b = document.createElement("button");
    b.className = "tab" + (t.id === activeId ? " active" : "");
    const icon = t.type === "terminal" ? "⌨️" : t.type === "history" ? "🕘" : "💬";
    const dot = t.unread ? `<span class="dot" title="New messages"></span>` : "";
    b.innerHTML = `<span class="ti">${icon} ${t.title}</span>${dot}`;
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

// ———————————————————— window open/close + resize ————————————————————
const isOpen = () => panel.classList.contains("open");

// The window's target geometry when open: a preset size centred horizontally, or
// the whole monitor (minus margins for the menu bar) when full-screen.
async function targetDims() {
  if (fullscreen) {
    try {
      const mon = await currentMonitor();
      if (mon) {
        const s = mon.scaleFactor;
        return {
          w: mon.size.width / s - 16,
          h: mon.size.height / s - 36,
          full: true,
          x: mon.position.x / s + 8,
          y: mon.position.y / s + 28,
        };
      }
    } catch {
      /* fall back to a preset size */
    }
  }
  const base = customSize ?? SIZES[sizeIdx];
  return { w: base.w, h: base.h, full: false, x: 0, y: 0 };
}

// Set window size + position directly (logical px), guarding our own events.
async function place(w: number, h: number, x: number, y: number) {
  try {
    await appWindow.setSize(new LogicalSize(w, h));
    await appWindow.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
  } catch {
    /* not in tauri */
  }
}

// Position an absolutely-placed element within the window.
function setBox(el: HTMLElement, x: number, y: number, w?: number, h?: number) {
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
  if (w != null) el.style.width = `${Math.round(w)}px`;
  if (h != null) el.style.height = `${Math.round(h)}px`;
}

const clampv = (v: number, a: number, b: number) => (b < a ? a : Math.max(a, Math.min(v, b)));
const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

type Bounds = { x: number; y: number; w: number; h: number };
// The monitor's *work area* (excludes the menu bar / Dock / taskbar) so the chat
// never tucks behind them.
async function monBounds(): Promise<Bounds> {
  try {
    const mon = await currentMonitor();
    if (mon) {
      const s = mon.scaleFactor;
      const wa = mon.workArea;
      return { x: wa.position.x / s, y: wa.position.y / s, w: wa.size.width / s, h: wa.size.height / s };
    }
  } catch {
    /* not in tauri */
  }
  return { x: 0, y: 0, w: 1920, h: 1200 };
}

// Cat geometry.
const CAT_W = 92;
const CAT_H = 92;
const CAT_TOP_OFF = 34; // cat top within the collapsed window (leaves room for tail)
const CAT_LEFT_OFF = (COLLAPSE.w - CAT_W) / 2; // cat left within the collapsed window
// Extra space the wagging tail needs above / beside the cat, so it isn't clipped.
const HALO_T = 30;
const HALO_S = 26;
type Anchor = { catTop: number; catCenterX: number };
type Side = "below" | "above" | "right" | "left";

// Place the panel on one side of the (fixed) cat, sliding it along the cross-axis
// to stay on screen. Returns the window rect + element offsets within it.
function computeLayout(anchor: Anchor, side: Side, pw: number, ph: number, mon: Bounds, OM: number, G: number) {
  const catLeft = anchor.catCenterX - CAT_W / 2;
  const catTop = anchor.catTop;
  const catRight = catLeft + CAT_W;
  const catBottom = catTop + CAT_H;
  let pLeft: number;
  let pTop: number;
  if (side === "below") {
    pTop = catBottom + G;
    pLeft = clampv(anchor.catCenterX - pw / 2, mon.x + OM, mon.x + mon.w - OM - pw);
  } else if (side === "above") {
    pTop = catTop - G - ph;
    pLeft = clampv(anchor.catCenterX - pw / 2, mon.x + OM, mon.x + mon.w - OM - pw);
  } else if (side === "right") {
    pLeft = catRight + G;
    pTop = clampv(catTop + CAT_H / 2 - ph / 2, mon.y + OM, mon.y + mon.h - OM - ph);
  } else {
    pLeft = catLeft - G - pw;
    pTop = clampv(catTop + CAT_H / 2 - ph / 2, mon.y + OM, mon.y + mon.h - OM - ph);
  }
  // include the tail's halo (above + sides of the cat) so it's never clipped
  const x0 = Math.min(catLeft - HALO_S, pLeft) - OM;
  const y0 = Math.min(catTop - HALO_T, pTop) - OM;
  const x1 = Math.max(catRight + HALO_S, pLeft + pw) + OM;
  const y1 = Math.max(catBottom, pTop + ph) + OM;
  return {
    winLeft: x0,
    winTop: y0,
    winW: x1 - x0,
    winH: y1 - y0,
    catX: catLeft - x0,
    catY: catTop - y0,
    pX: pLeft - x0,
    pY: pTop - y0,
  };
}

// The cat's current on-screen anchor, read from the live window + mascot offset.
async function currentCatAnchorOpen(): Promise<Anchor> {
  const scale = await appWindow.scaleFactor();
  const pos = await appWindow.outerPosition();
  const catX = parseFloat(mascot.style.left) || 0;
  const catY = parseFloat(mascot.style.top) || 0;
  return { catTop: pos.y / scale + catY, catCenterX: pos.x / scale + catX + CAT_W / 2 };
}

// Same, but for the collapsed cat (falls back to CSS defaults if no inline yet).
async function collapsedAnchor(): Promise<Anchor> {
  const scale = await appWindow.scaleFactor();
  const pos = await appWindow.outerPosition();
  const catX = parseFloat(mascot.style.left) || CAT_LEFT_OFF;
  const catY = parseFloat(mascot.style.top) || CAT_TOP_OFF;
  return { catTop: pos.y / scale + catY, catCenterX: pos.x / scale + catX + CAT_W / 2 };
}

function layoutCollapsed(winW: number) {
  setBox(mascot, (winW - CAT_W) / 2, CAT_TOP_OFF);
}

// Open the chat on whichever side of the cat has the most room, keeping the cat
// anchored where she floats so the whole window stays on screen.
async function applyOpen(anchor: Anchor) {
  try {
    const d = await targetDims();
    const mon = await monBounds();
    const OM = 14;
    const G = 10;
    const MINW = 300;
    const MINH = 200;

    if (d.full) {
      await place(d.w, d.h, d.x, d.y);
      setBox(mascot, (d.w - CAT_W) / 2, OM);
      setBox(panel, OM, OM + CAT_H + G, d.w - 2 * OM, d.h - (OM + CAT_H + G) - OM);
      return;
    }

    const catLeft = anchor.catCenterX - CAT_W / 2;
    const catTop = anchor.catTop;
    const catRight = catLeft + CAT_W;
    const catBottom = catTop + CAT_H;
    const PW = d.w;
    const PH = d.h;
    const fullW = mon.w - 2 * OM;
    const fullH = mon.h - 2 * OM;

    const spaceBelow = mon.y + mon.h - OM - (catBottom + G);
    const spaceAbove = catTop - G - (mon.y + OM);
    const spaceRight = mon.x + mon.w - OM - (catRight + G);
    const spaceLeft = catLeft - G - (mon.x + OM);

    type Cand = { side: Side; pw: number; ph: number; score: number };
    const cands: Cand[] = [];
    if (spaceBelow >= MINH) {
      const pw = Math.min(PW, fullW);
      const ph = Math.min(PH, spaceBelow);
      cands.push({ side: "below", pw, ph, score: pw * ph * 1.15 }); // prefer below
    }
    if (spaceAbove >= MINH) {
      const pw = Math.min(PW, fullW);
      const ph = Math.min(PH, spaceAbove);
      cands.push({ side: "above", pw, ph, score: pw * ph });
    }
    if (spaceRight >= MINW) {
      const pw = Math.min(PW, spaceRight);
      const ph = Math.min(PH, fullH);
      cands.push({ side: "right", pw, ph, score: pw * ph * 1.05 });
    }
    if (spaceLeft >= MINW) {
      const pw = Math.min(PW, spaceLeft);
      const ph = Math.min(PH, fullH);
      cands.push({ side: "left", pw, ph, score: pw * ph });
    }

    let best = cands.sort((a, b) => b.score - a.score)[0];
    if (!best) {
      // nothing fits cleanly — fall back to below, clamped to the screen
      best = { side: "below", pw: Math.min(Math.max(MINW, PW), fullW), ph: Math.min(Math.max(MINH, PH), fullH), score: 0 };
    }

    const L = computeLayout(anchor, best.side, best.pw, best.ph, mon, OM, G);
    await place(L.winW, L.winH, L.winLeft, L.winTop);
    setBox(mascot, L.catX, L.catY);
    setBox(panel, L.pX, L.pY, best.pw, best.ph);
  } catch {
    /* not in tauri */
  }
}

// Collapse back to the floating cat, returning to where it was before opening.
async function collapseWindow() {
  try {
    const scale = await appWindow.scaleFactor();
    const pos = await appWindow.outerPosition();
    const x = preOpen ? preOpen.x : pos.x / scale;
    const y = preOpen ? preOpen.y : pos.y / scale;
    await place(COLLAPSE.w, COLLAPSE.h, Math.max(0, x), Math.max(0, y));
    layoutCollapsed(COLLAPSE.w);
  } catch {
    /* not in tauri */
  }
  preOpen = null;
}

async function setOpen(open: boolean) {
  if (open === isOpen()) return;
  panel.classList.toggle("open", open);
  mascot.classList.toggle("open", open);
  if (open) {
    await hideBubble(); // collapse any bubble first
    let anchor: Anchor = { catTop: 0, catCenterX: 0 };
    try {
      anchor = await collapsedAnchor();
      // collapsed-equivalent window top-left, for returning here on close
      preOpen = { x: anchor.catCenterX - COLLAPSE.w / 2, y: anchor.catTop - CAT_TOP_OFF };
    } catch {
      preOpen = null;
    }
    await applyOpen(anchor);
    lastInteract = performance.now();
    face.greet();
    fx.hearts(7);
    setTimeout(() => input.focus(), 60);
  } else {
    await collapseWindow();
  }
}

// ———————————————————— speech bubble (collapsed feedback) ————————————————————
// While Turbo is floating (panel closed) she shows what she's doing in a little
// speech bubble under her: a thinking animation, or a short statement.
const THINK_BUBBLE = `<span class="think-dots"><i></i><i></i><i></i></span>`;
let bubbleTimer: number | undefined;
let bubbleMode = ""; // dedupe so streaming voice partials don't keep resizing

async function showBubble(html: string, opts: { thinking?: boolean; hold?: number } = {}) {
  const mode = opts.thinking ? "think" : "say:" + html;
  clearTimeout(bubbleTimer);
  if (!(bubble.classList.contains("show") && bubbleMode === mode)) {
    bubbleMode = mode;
    bubbleContent.innerHTML = opts.thinking ? THINK_BUBBLE : html;
    bubble.classList.add("show");
    if (!isOpen()) await fitBubble();
  }
  if (opts.hold) bubbleTimer = window.setTimeout(hideBubble, opts.hold);
}

async function hideBubble() {
  clearTimeout(bubbleTimer);
  bubbleMode = "";
  if (!bubble.classList.contains("show")) return;
  bubble.classList.remove("show");
  if (!isOpen()) {
    try {
      const a = await collapsedAnchor();
      await place(COLLAPSE.w, COLLAPSE.h, a.catCenterX - COLLAPSE.w / 2, a.catTop - CAT_TOP_OFF);
      layoutCollapsed(COLLAPSE.w);
    } catch {
      /* not in tauri */
    }
  }
}

// Grow the floating window to hold the cat + a speech bubble below her, keeping
// the cat anchored. Measure the bubble at a comfortable width first.
async function fitBubble() {
  const anchor = await collapsedAnchor();
  const mon = await monBounds();
  try {
    await appWindow.setSize(new LogicalSize(320, 320));
  } catch {
    /* not in tauri */
  }
  await raf();
  const bw = Math.min(Math.ceil(bubble.offsetWidth) || 200, 260);
  const bh = Math.ceil(bubble.offsetHeight) || 44;
  const L = computeLayout(anchor, "below", bw, bh, mon, 12, 8);
  await place(L.winW, L.winH, L.winLeft, L.winTop);
  setBox(mascot, L.catX, L.catY);
  setBox(bubble, L.pX, L.pY, bw, bh);
}

// Trim a reply down to something that fits in a small bubble.
function shortText(s: string): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > 140 ? clean.slice(0, 138).trimEnd() + "…" : clean;
}

// Tap the bubble to open the full chat.
bubble.addEventListener("click", () => setOpen(true));

// Little things Turbo says from her bubble while floating, so she feels alive.
const QUIPS = [
  "meow — tap me to chat 🐾",
  "need a hand with some code?",
  "purr… ready when you are",
  "what are we building?",
  "drag me anywhere you like",
  "got a bug? point me at it 🐱",
];
function maybeQuip() {
  if (isOpen() || document.hidden) return;
  if (performance.now() - lastInteract < 25_000) return; // don't interrupt activity
  showBubble(QUIPS[Math.floor(Math.random() * QUIPS.length)], { hold: 4500 });
}

// Re-apply the current size/fullscreen state to the live window (opening first
// if needed), then refresh the control buttons.
async function reapplySize() {
  if (!isOpen()) {
    await setOpen(true);
  } else {
    await applyOpen(await currentCatAnchorOpen());
  }
  updateWinCtrls();
}

function forgetCustom() {
  customSize = null;
  localStorage.removeItem("turbo.custom");
}

async function changeSize(delta: number) {
  // Stepping the preset starts from whatever size is showing now.
  if (customSize) sizeIdx = nearestPreset(customSize.w);
  fullscreen = false;
  forgetCustom();
  sizeIdx = clampIdx(sizeIdx + delta);
  localStorage.setItem("turbo.size", String(sizeIdx));
  localStorage.setItem("turbo.fs", "0");
  await reapplySize();
}

function nearestPreset(w: number): number {
  let best = 0;
  for (let i = 1; i < SIZES.length; i++) {
    if (Math.abs(SIZES[i].w - w) < Math.abs(SIZES[best].w - w)) best = i;
  }
  return best;
}

async function resetSize() {
  fullscreen = false;
  forgetCustom();
  sizeIdx = 1;
  localStorage.setItem("turbo.size", "1");
  localStorage.setItem("turbo.fs", "0");
  await reapplySize();
}

async function toggleFullscreen() {
  fullscreen = !fullscreen;
  localStorage.setItem("turbo.fs", fullscreen ? "1" : "0");
  await reapplySize();
}

function updateWinCtrls() {
  wcFull.classList.toggle("active", fullscreen);
  wcFull.textContent = fullscreen ? "⤡" : "⤢";
  wcFull.title = fullscreen ? "Exit full screen" : "Full screen";
  wcSmaller.style.opacity = !fullscreen && (customSize || sizeIdx > 0) ? "1" : "0.35";
  wcBigger.style.opacity = !fullscreen && (customSize || sizeIdx < SIZES.length - 1) ? "1" : "0.35";
}

wcSmaller.addEventListener("click", () => changeSize(-1));
wcBigger.addEventListener("click", () => changeSize(1));
wcFull.addEventListener("click", () => toggleFullscreen());

// Drag the right / bottom / corner of the panel to resize it live. The panel is
// a fixed-size element now, so we adjust the desired size and re-lay-out.
const rzE = document.querySelector<HTMLDivElement>("#rzE")!;
const rzS = document.querySelector<HTMLDivElement>("#rzS")!;
const rzSE = document.querySelector<HTMLDivElement>("#rzSE")!;
let relayoutQueued = false;
function scheduleRelayout() {
  if (relayoutQueued) return;
  relayoutQueued = true;
  requestAnimationFrame(async () => {
    relayoutQueued = false;
    if (isOpen()) await applyOpen(await currentCatAnchorOpen());
  });
}
function startResize(dir: "E" | "S" | "SE") {
  return (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    lastPanelDown = performance.now();
    fullscreen = false;
    localStorage.setItem("turbo.fs", "0");
    const sx = e.screenX;
    const sy = e.screenY;
    const sw = panel.offsetWidth;
    const sh = panel.offsetHeight;
    const onMove = (m: MouseEvent) => {
      let w = sw;
      let h = sh;
      if (dir === "E" || dir === "SE") w = sw + (m.screenX - sx);
      if (dir === "S" || dir === "SE") h = sh + (m.screenY - sy);
      customSize = {
        w: Math.max(280, Math.min(Math.round(w), 2200)),
        h: Math.max(200, Math.min(Math.round(h), 1700)),
      };
      scheduleRelayout();
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (customSize) localStorage.setItem("turbo.custom", JSON.stringify(customSize));
      updateWinCtrls();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
}
rzE.addEventListener("mousedown", startResize("E"));
rzS.addEventListener("mousedown", startResize("S"));
rzSE.addEventListener("mousedown", startResize("SE"));


// ⌘/Ctrl +  −  0  to grow / shrink / reset the window.
window.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  if (e.key === "=" || e.key === "+") {
    e.preventDefault();
    changeSize(1);
  } else if (e.key === "-" || e.key === "_") {
    e.preventDefault();
    changeSize(-1);
  } else if (e.key === "0") {
    e.preventDefault();
    resetSize();
  }
});

// close when the window loses focus (click off), unless we just touched the panel
appWindow.onFocusChanged(({ payload: focused }) => {
  if (!focused && isOpen() && performance.now() - lastPanelDown > 400) setOpen(false);
});
panel.addEventListener("mousedown", () => (lastPanelDown = performance.now()));

// ———————————————————— mascot: click to open, drag to move ————————————————————
// Dragging collapses the chat to just the cat (so she moves freely with no
// constraints), follows the cursor manually, and reopens the chat — recalculated
// for her new spot — when you let go. A click without movement toggles the chat.
let down: { x: number; y: number } | null = null;
let moved = false;
let openAtDragStart = false;
let dragOff: { x: number; y: number } | null = null;
let monTopLimit = -Infinity;

mascot.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  down = { x: e.screenX, y: e.screenY };
  moved = false;
  openAtDragStart = isOpen();
  dragOff = null;
  lastInteract = performance.now();
});

window.addEventListener("mousemove", async (e) => {
  if (!down) return;
  if (!moved) {
    if (Math.hypot(e.screenX - down.x, e.screenY - down.y) <= 4) return;
    moved = true;
    lastPanelDown = performance.now();
    // collapse to just the cat, keeping her under the cursor
    if (openAtDragStart) {
      try {
        const a = await currentCatAnchorOpen();
        panel.classList.remove("open");
        mascot.classList.remove("open");
        await place(COLLAPSE.w, COLLAPSE.h, a.catCenterX - COLLAPSE.w / 2, a.catTop - CAT_TOP_OFF);
        layoutCollapsed(COLLAPSE.w);
      } catch {
        /* not in tauri */
      }
    }
    // cursor offset within the (collapsed) window, + top limit so she stays visible
    try {
      const scale = await appWindow.scaleFactor();
      const pos = await appWindow.outerPosition();
      dragOff = { x: e.screenX - pos.x / scale, y: e.screenY - pos.y / scale };
      const mon = await monBounds();
      monTopLimit = mon.y;
    } catch {
      dragOff = { x: e.screenX, y: e.screenY };
      monTopLimit = -Infinity;
    }
  }
  if (!dragOff) return;
  const x = e.screenX - dragOff.x;
  const y = Math.max(monTopLimit, e.screenY - dragOff.y);
  appWindow.setPosition(new LogicalPosition(Math.round(x), Math.round(y))).catch(() => {});
});

window.addEventListener("mouseup", async () => {
  const wasClick = down && !moved;
  const wasDrag = down && moved;
  down = null;
  if (wasClick) {
    setOpen(!isOpen());
    return;
  }
  if (wasDrag) {
    dragOff = null;
    // record where she landed, then reopen the chat there if it was open
    try {
      const scale = await appWindow.scaleFactor();
      const pos = await appWindow.outerPosition();
      preOpen = { x: pos.x / scale, y: pos.y / scale };
    } catch {
      /* not in tauri */
    }
    if (openAtDragStart) await setOpen(true);
  }
});

// ———————————————————— chat ————————————————————
function addMsg(t: Tab, kind: "user" | "bot", text = ""): HTMLDivElement {
  // The user's own message always pins to the bottom; other appends only do so
  // if you were already there (so reading back isn't interrupted).
  const stick = kind === "user" || atBottom(t.view);
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  el.textContent = text;
  t.body.appendChild(el);
  if (stick) scrollToEnd(t.view);
  if (t.id === activeId) updateToEnd();
  return el;
}

async function runChat(t: Tab, text: string) {
  t.busy = true;
  addMsg(t, "user", text);
  const bot = addMsg(t, "bot", "");
  // animated "Turbo is thinking" feedback until the first content arrives
  bot.classList.add("thinking");
  bot.innerHTML = `<span class="think-dots"><i></i><i></i><i></i></span>`;
  face.set("think");
  // if Turbo is floating (collapsed), mirror the state in her speech bubble
  const collapsed = !isOpen();
  if (collapsed) showBubble("", { thinking: true });
  let first = true;
  let reply = "";
  // clear the thinking placeholder the first time any content (text/tool) lands
  const clearThinking = () => {
    if (first) {
      bot.classList.remove("thinking");
      bot.textContent = "";
      first = false;
    }
  };
  await ask(
    backendSel.value as Backend,
    text,
    null,
    { permissionMode: permSel.value, model: modelSel.value, sessionId: t.sessionId },
    {
      onChunk: (chunk) => {
        const stick = atBottom(t.view);
        if (first) {
          clearThinking();
          face.set("talk");
        }
        reply += chunk;
        bot.textContent = reply;
        if (stick) scrollToEnd(t.view);
        if (t.id === activeId) updateToEnd();
      },
      onTool: (line) => {
        const stick = atBottom(t.view);
        clearThinking();
        const s = document.createElement("span");
        s.className = "tool";
        s.textContent = `⚙ ${line}`;
        bot.appendChild(s);
        if (stick) scrollToEnd(t.view);
        if (t.id === activeId) updateToEnd();
      },
      onDone: (result) => {
        face.set("idle");
        t.busy = false;
        // a turn that produced nothing visible: drop the empty thinking bubble
        if (first) {
          clearThinking();
          if (!reply.trim()) bot.remove();
        }
        if (result?.sessionId) t.sessionId = result.sessionId; // remember for next turn
        t.syncCount = undefined; // re-baseline against the log so we don't echo our own turn
        fx.confetti(22);
        face.hearts();
        if (voiceTurn && reply.trim()) speak(reply.slice(0, 600));
        voiceTurn = false;
        refreshUsage();
        saveState();
        // show the gist in the bubble if she's still floating
        if (collapsed && !isOpen()) {
          const txt = shortText(reply);
          if (txt) showBubble(txt, { hold: 6500 });
          else hideBubble();
        }
      },
      onError: (msg) => {
        clearThinking();
        bot.classList.add("error");
        bot.textContent = msg || "Something went wrong.";
        face.set("error");
        t.busy = false;
        voiceTurn = false;
        setTimeout(() => face.set("idle"), 2600);
        saveState();
        if (collapsed && !isOpen()) showBubble(shortText(msg) || "Something went wrong.", { hold: 5000 });
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
  t.syncCount = entries.length; // baseline for live sync
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

// ———————————————————— live cross-window sync ————————————————————
// The same Claude session can be driven from another Turbo window or the
// `claude` CLI. We poll each chat tab's session log and append anything that
// shows up that we didn't render ourselves, so open chats stay in step.
let polling = false;
async function pollSessions() {
  if (polling) return;
  polling = true;
  try {
    for (const t of tabs) {
      if (t.type !== "chat" || !t.sessionId || t.busy) continue;
      let entries: ChatEntry[];
      try {
        entries = await loadSession(t.sessionId);
      } catch {
        continue;
      }
      // First sight of this tab's log → baseline without re-rendering what's shown.
      if (t.syncCount === undefined) {
        t.syncCount = entries.length;
        continue;
      }
      if (entries.length > t.syncCount) {
        for (const e of entries.slice(t.syncCount)) addMsg(t, e.role, e.text);
        t.syncCount = entries.length;
        if (t.id !== activeId) {
          t.unread = true;
          renderTabs();
        }
        saveState();
      }
    }
  } finally {
    polling = false;
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
  { cmd: "/history", desc: "Browse past chats", run: () => createTab("history") },
  { cmd: "/clear", desc: "Clear this tab", run: () => (active().body.innerHTML = "") },
  { cmd: "/cwd", desc: "Show the working folder", run: showCwd },
  { cmd: "/voice", desc: "Toggle “Hey Turbo” voice", run: () => toggleVoice() },
  { cmd: "/bigger", desc: "Grow the window", run: () => changeSize(1) },
  { cmd: "/smaller", desc: "Shrink the window", run: () => changeSize(-1) },
  { cmd: "/fullscreen", desc: "Toggle full screen", run: () => toggleFullscreen() },
  { cmd: "/persona", desc: "Edit Turbo's personality", run: showPersona },
  { cmd: "/hearts", desc: "Throw some love", run: () => { fx.hearts(16); face.hearts(); } },
  { cmd: "/confetti", desc: "Celebrate!", run: () => fx.confetti(40) },
  { cmd: "/lick", desc: "Turbo licks", run: () => face.licks() },
  { cmd: "/close", desc: "Close this tab", run: () => closeTab(activeId) },
  { cmd: "/help", desc: "List all commands", run: showHelp },
];

async function showPersona() {
  const p = await personaPath();
  const t = tabs.find((x) => x.type === "chat") ?? createTab("chat");
  selectTab(t.id);
  addMsg(t, "bot", `My personality lives in this file — edit it and I'll change:\n${p}`);
}

function showCwd() {
  const cur = active();
  const t = cur.type === "history" ? (tabs.find((x) => x.type === "chat") ?? createTab("chat")) : cur;
  selectTab(t.id);
  addMsg(t, "bot", `Working folder: ${shortCwd(t.cwd)}`);
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
  const m = text.match(WAKE);
  if (m) {
    // heard the wake word — show we're listening (bubble if floating, input if open)
    face.set("think");
    if (isOpen()) input.value = (m[1] || "").trim();
    else showBubble("", { thinking: true });
  }
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
    const t = tabs.find((x) => x.type === "chat") ?? createTab("chat");
    if (t.busy) return;
    // Stay floating and answer in the bubble; if already open, run in the panel.
    if (isOpen()) {
      selectTab(t.id);
      input.value = "";
    }
    runChat(t, cmd);
  } else {
    face.set("idle");
    if (!isOpen()) hideBubble();
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
  updateWinCtrls();
  layoutCollapsed(COLLAPSE.w); // centre the floating cat
  // restored chats should open scrolled to the latest message
  for (const t of tabs) t.view.scrollTop = t.view.scrollHeight;
  refreshUsage();
  setInterval(refreshUsage, 30_000);
  setInterval(pollSessions, 3_000);
  // a greeting bubble so you can see her speak, then occasional idle quips
  setTimeout(() => {
    if (!isOpen()) showBubble("hi, I'm Turbo 🐱 — tap me to chat", { hold: 5000 });
  }, 1400);
  setInterval(maybeQuip, 45_000);
  // Resume "Hey Turbo" listening if it was enabled last session.
  if (localStorage.getItem("turbo.voice") === "1") toggleVoice();
})();
