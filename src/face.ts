// Turbo — a white, minimal cat that lives in a small black square at the top of
// the screen. It idles on its own: blinks, looks around, twitches each ear
// independently, licks, and gets happy. think / talk / error are working moods.

export type FaceState = "idle" | "think" | "talk" | "error";

const WHITE = "#f4f6fb";
const DARK = "#0a0a0c"; // pupils read as cut-outs of the black square
const PINK = "#ff7eb6"; // tongue
const GREEN = "#46d860"; // iris
const LOVE = "#ff5d8f"; // heart eyes

export class CatFace {
  private root: SVGSVGElement;
  private earL: SVGGElement;
  private earR: SVGGElement;
  private eyesWrap: SVGGElement;
  private eyesNormal: SVGGElement;
  private eyesHappy: SVGGElement;
  private eyesError: SVGGElement;
  private eyesLove: SVGGElement;
  private pupils: SVGGElement;
  private mouth: SVGPathElement;
  private tongue: SVGGElement;

  private state: FaceState = "idle";
  private baseL = 0;
  private baseR = 0;
  private px = 0;
  private py = 0;
  private tx = 0;
  private ty = 0;

  private blinkT = 1500;
  private lookT = 2400;
  private twitchLT = 1800;
  private twitchRT = 2600;
  private lickT = 6000;
  private happyT = 9000;
  private loveT = 13000;
  private tiltT = 7000;
  private dropT = 9000;
  private raf = 0;
  private t = 0;

  constructor(mount: HTMLElement) {
    mount.innerHTML = svg();
    this.root = mount.querySelector("svg")!;
    this.earL = this.root.querySelector("#earL")!;
    this.earR = this.root.querySelector("#earR")!;
    this.eyesWrap = this.root.querySelector("#eyes")!;
    this.eyesNormal = this.root.querySelector("#eyesNormal")!;
    this.eyesHappy = this.root.querySelector("#eyesHappy")!;
    this.eyesError = this.root.querySelector("#eyesError")!;
    this.eyesLove = this.root.querySelector("#eyesLove")!;
    this.pupils = this.root.querySelector("#pupils")!;
    this.mouth = this.root.querySelector("#mouth")!;
    this.tongue = this.root.querySelector("#tongue")!;
    this.root.style.transformOrigin = "center";
    this.loop = this.loop.bind(this);
    this.applyEars();
    this.raf = requestAnimationFrame(this.loop);
  }

  set(state: FaceState) {
    if (state === this.state) return;
    this.state = state;
    this.root.dataset.state = state;
    this.showEyes(state === "error" ? "error" : "normal");
    switch (state) {
      case "talk":
        this.baseL = -8;
        this.baseR = 8;
        break;
      case "think":
        this.baseL = 12;
        this.baseR = -7;
        this.setLook(-1.6, -2);
        break;
      case "error":
        this.baseL = 34;
        this.baseR = -34;
        break;
      default:
        this.baseL = 0;
        this.baseR = 0;
    }
    this.applyEars();
  }

  greet() {
    this.set("idle");
    this.showEyes("happy");
    this.lick();
    setTimeout(() => {
      if (this.state === "idle") this.showEyes("normal");
    }, 900);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
  }

  private showEyes(which: "normal" | "happy" | "error" | "love") {
    this.eyesNormal.classList.toggle("hidden", which !== "normal");
    this.eyesHappy.classList.toggle("hidden", which !== "happy");
    this.eyesError.classList.toggle("hidden", which !== "error");
    this.eyesLove.classList.toggle("hidden", which !== "love");
  }

  // Public lick — trigger a tongue lick on cue.
  licks() {
    this.lick();
  }

  // Heart eyes — when Turbo loves something. Public so chat can trigger it too.
  hearts() {
    if (this.state !== "idle") return;
    this.showEyes("love");
    this.eyesLove.animate(
      [
        { transform: "scale(0.5)", opacity: 0.3 },
        { transform: "scale(1.18)", opacity: 1 },
        { transform: "scale(1)" },
      ],
      { duration: 480, easing: "ease-out" },
    );
    setTimeout(() => {
      if (this.state === "idle") this.showEyes("normal");
    }, 1600);
  }

  // One ear flops right down and slowly perks back up.
  private earDrop() {
    const left = Math.random() < 0.5;
    const ear = left ? this.earL : this.earR;
    const base = left ? this.baseL : this.baseR;
    const dir = left ? 1 : -1; // droop outward/down
    const drop = 44 + Math.random() * 14;
    ear.animate(
      [
        { transform: `rotate(${base}deg)`, easing: "ease-in" },
        { transform: `rotate(${base + dir * drop}deg)`, offset: 0.25 },
        { transform: `rotate(${base + dir * drop}deg)`, offset: 0.75 },
        { transform: `rotate(${base}deg)` },
      ],
      { duration: 1800, easing: "ease-in-out" },
    );
  }

  private headTilt() {
    const dir = Math.random() < 0.5 ? -1 : 1;
    this.root.animate(
      [
        { transform: "rotate(0deg)" },
        { transform: `rotate(${dir * 7}deg)` },
        { transform: `rotate(${dir * 7}deg)` },
        { transform: "rotate(0deg)" },
      ],
      { duration: 1100, easing: "ease-in-out" },
    );
  }

  private applyEars() {
    this.earL.style.transform = `rotate(${this.baseL}deg)`;
    this.earR.style.transform = `rotate(${this.baseR}deg)`;
  }

  private setLook(x: number, y: number) {
    this.tx = x;
    this.ty = y;
  }

  private loop(now: number) {
    const dt = this.t ? now - this.t : 16;
    this.t = now;
    const idle = this.state === "idle";

    this.px += (this.tx - this.px) * 0.15;
    this.py += (this.ty - this.py) * 0.15;
    this.pupils.setAttribute("transform", `translate(${this.px} ${this.py})`);

    this.blinkT -= dt;
    if (this.blinkT <= 0) {
      if (this.state !== "error") this.blink();
      this.blinkT = 2200 + Math.random() * 2800;
    }

    this.twitchLT -= dt;
    if (this.twitchLT <= 0) {
      if (this.state !== "error") this.twitch(this.earL, this.baseL);
      this.twitchLT = 1500 + Math.random() * 3200;
    }
    this.twitchRT -= dt;
    if (this.twitchRT <= 0) {
      if (this.state !== "error") this.twitch(this.earR, this.baseR);
      this.twitchRT = 1500 + Math.random() * 3200;
    }

    if (idle) {
      this.lookT -= dt;
      if (this.lookT <= 0) {
        if (Math.random() < 0.4) this.setLook(0, 0);
        else this.setLook((Math.random() * 2 - 1) * 2.4, (Math.random() * 2 - 1) * 2);
        this.lookT = 1600 + Math.random() * 2600;
      }
      this.lickT -= dt;
      if (this.lickT <= 0) {
        this.lick();
        this.lickT = 5000 + Math.random() * 7000;
      }
      this.happyT -= dt;
      if (this.happyT <= 0) {
        this.showEyes("happy");
        setTimeout(() => {
          if (this.state === "idle") this.showEyes("normal");
        }, 1100);
        this.happyT = 8000 + Math.random() * 9000;
      }
      this.loveT -= dt;
      if (this.loveT <= 0) {
        this.hearts();
        this.loveT = 12000 + Math.random() * 14000;
      }
      this.tiltT -= dt;
      if (this.tiltT <= 0) {
        this.headTilt();
        this.tiltT = 6000 + Math.random() * 8000;
      }
      this.dropT -= dt;
      if (this.dropT <= 0) {
        this.earDrop();
        this.dropT = 5000 + Math.random() * 7000;
      }
    } else if (this.state !== "think") {
      this.setLook(0, 0);
    }

    if (this.state === "talk") {
      const open = (Math.sin(now / 75) + 1) / 2;
      this.mouth.setAttribute("d", `M 40 74 Q 50 ${76 + open * 10} 60 74`);
    } else if (this.state === "think") {
      this.mouth.setAttribute("d", "M 43 75 L 57 75");
    } else if (this.state === "error") {
      this.mouth.setAttribute("d", "M 41 77 Q 50 71 59 77");
    } else {
      this.mouth.setAttribute("d", "M 41 74 Q 50 80 59 74");
    }

    this.raf = requestAnimationFrame(this.loop);
  }

  private blink() {
    this.eyesWrap.animate(
      [{ transform: "scaleY(1)" }, { transform: "scaleY(0.06)" }, { transform: "scaleY(1)" }],
      { duration: 150, easing: "ease-in-out" },
    );
  }

  private twitch(ear: SVGGElement, base: number) {
    const dir = Math.random() < 0.5 ? -1 : 1;
    const delta = 8 + Math.random() * 9;
    ear.animate(
      [
        { transform: `rotate(${base}deg)` },
        { transform: `rotate(${base + dir * delta}deg)` },
        { transform: `rotate(${base}deg)` },
      ],
      { duration: 250, easing: "ease-in-out" },
    );
  }

  private lick() {
    this.tongue.animate(
      [
        { transform: "translateY(0) scaleY(0.2)", opacity: 0 },
        { transform: "translateY(7px) scaleY(1)", opacity: 1 },
        { transform: "translateY(7px) scaleY(1)", opacity: 1 },
        { transform: "translateY(0) scaleY(0.2)", opacity: 0 },
      ],
      { duration: 650, easing: "ease-in-out" },
    );
  }
}

function svg(): string {
  return /* html */ `
<svg viewBox="0 0 100 100" width="100%" height="100%" data-state="idle" xmlns="http://www.w3.org/2000/svg"
     fill="none" stroke="${WHITE}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round">
  <style>
    .hidden{display:none}
    #earL,#earR{transform-box:fill-box}
    #earL{transform-origin:78% 92%}
    #earR{transform-origin:22% 92%}
    #eyes{transform-box:fill-box;transform-origin:center}
    #tongue{transform-box:fill-box;transform-origin:50% 0%;opacity:0}
    #eyesLove{transform-box:fill-box;transform-origin:center}
  </style>
  <defs>
    <clipPath id="eyeClip">
      <ellipse cx="36" cy="51" rx="9" ry="11"/>
      <ellipse cx="64" cy="51" rx="9" ry="11"/>
    </clipPath>
  </defs>

  <!-- ears: small, solid white, rounded tips -->
  <g id="earL"><path d="M 32 30 L 27 16 L 42 26 Z" fill="${WHITE}" stroke="${WHITE}" stroke-width="3.4"/></g>
  <g id="earR"><path d="M 68 30 L 73 16 L 58 26 Z" fill="${WHITE}" stroke="${WHITE}" stroke-width="3.4"/></g>

  <!-- whiskers -->
  <g stroke="${WHITE}" stroke-width="1.4" opacity="0.6">
    <line x1="13" y1="66" x2="30" y2="67"/>
    <line x1="12" y1="72" x2="30" y2="71"/>
    <line x1="87" y1="66" x2="70" y2="67"/>
    <line x1="88" y1="72" x2="70" y2="71"/>
  </g>

  <!-- tongue (behind mouth) -->
  <g id="tongue"><path d="M 44 76 L 44 83 Q 44 88 50 88 Q 56 88 56 83 L 56 76 Z" fill="${PINK}" stroke="none"/>
    <line x1="50" y1="78" x2="50" y2="86" stroke="#d65f96" stroke-width="1.6"/></g>

  <!-- eyes -->
  <g id="eyes">
    <g id="eyesNormal">
      <ellipse cx="36" cy="51" rx="9" ry="11" fill="${WHITE}" stroke="none"/>
      <ellipse cx="64" cy="51" rx="9" ry="11" fill="${WHITE}" stroke="none"/>
      <g id="pupils" clip-path="url(#eyeClip)">
        <circle cx="36" cy="51" r="6.4" fill="${GREEN}"/>
        <circle cx="64" cy="51" r="6.4" fill="${GREEN}"/>
        <circle cx="36" cy="51" r="4.6" fill="${DARK}"/>
        <circle cx="64" cy="51" r="4.6" fill="${DARK}"/>
        <circle cx="33.6" cy="48.4" r="1.7" fill="#ffffff"/>
        <circle cx="61.6" cy="48.4" r="1.7" fill="#ffffff"/>
      </g>
    </g>
    <g id="eyesHappy" class="hidden" fill="none" stroke="${WHITE}" stroke-width="3">
      <path d="M 30 54 Q 37 47 44 54"/>
      <path d="M 56 54 Q 63 47 70 54"/>
    </g>
    <g id="eyesError" class="hidden" stroke="${WHITE}" stroke-width="3">
      <path d="M 31 47 L 43 57 M 43 47 L 31 57"/>
      <path d="M 57 47 L 69 57 M 69 47 L 57 57"/>
    </g>
    <g id="eyesLove" class="hidden" stroke="none">
      <path d="M 36 56 C 28 49 30 43 36 47 C 42 43 44 49 36 56 Z" fill="${LOVE}"/>
      <path d="M 64 56 C 56 49 58 43 64 47 C 70 43 72 49 64 56 Z" fill="${LOVE}"/>
    </g>
  </g>

  <!-- nose + mouth -->
  <path d="M 46 65 Q 50 63 54 65 Q 52 69 50 70 Q 48 69 46 65 Z" fill="${WHITE}" stroke="none"/>
  <path id="mouth" d="M 41 78 Q 50 84 59 78"/>
</svg>`;
}
