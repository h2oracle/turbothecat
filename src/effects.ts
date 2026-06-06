// Particle bursts — floating hearts and confetti — that Turbo throws on cue.
// Pure DOM + Web Animations, no deps. Renders into a full-window overlay.

let layer: HTMLDivElement | null = null;

function getLayer(): HTMLDivElement {
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "fx-layer";
    document.body.appendChild(layer);
  }
  return layer;
}

interface Origin {
  x: number;
  y: number;
}

// Default origin: the mascot (top-centre of the window).
function defaultOrigin(): Origin {
  const m = document.querySelector(".mascot");
  if (m) {
    const r = m.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return { x: window.innerWidth / 2, y: 40 };
}

export function hearts(count = 12, origin?: Origin) {
  const o = origin ?? defaultOrigin();
  const l = getLayer();
  const colors = ["#ff5d8f", "#ff8ad1", "#ff3b6b", "#ff9ed3"];
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = "fx-heart";
    const size = 10 + Math.random() * 14;
    el.style.cssText = `left:${o.x}px;top:${o.y}px;width:${size}px;height:${size}px;color:${
      colors[(Math.random() * colors.length) | 0]
    }`;
    el.innerHTML = HEART;
    l.appendChild(el);
    const dx = (Math.random() * 2 - 1) * 70;
    const rise = 70 + Math.random() * 90;
    const rot = (Math.random() * 2 - 1) * 40;
    el.animate(
      [
        { transform: "translate(-50%,-50%) scale(0.3) rotate(0deg)", opacity: 0 },
        { transform: `translate(calc(-50% + ${dx * 0.4}px), -${rise * 0.4}px) scale(1) rotate(${rot * 0.5}deg)`, opacity: 1, offset: 0.3 },
        { transform: `translate(calc(-50% + ${dx}px), -${rise}px) scale(0.9) rotate(${rot}deg)`, opacity: 0 },
      ],
      { duration: 1300 + Math.random() * 700, easing: "cubic-bezier(.2,.7,.3,1)" },
    ).onfinish = () => el.remove();
  }
}

export function confetti(count = 30, origin?: Origin) {
  const o = origin ?? defaultOrigin();
  const l = getLayer();
  const colors = ["#5ee0c8", "#ff8ad1", "#ffd84c", "#6ea8ff", "#46d860", "#ff5d8f"];
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = "fx-confetti";
    const w = 5 + Math.random() * 5;
    const h = 8 + Math.random() * 6;
    el.style.cssText = `left:${o.x}px;top:${o.y}px;width:${w}px;height:${h}px;background:${
      colors[(Math.random() * colors.length) | 0]
    };border-radius:${Math.random() < 0.5 ? "1px" : "50%"}`;
    l.appendChild(el);
    const ang = Math.random() * Math.PI * 2;
    const dist = 50 + Math.random() * 130;
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist + 60; // bias downward (gravity)
    const rot = (Math.random() * 2 - 1) * 540;
    el.animate(
      [
        { transform: "translate(-50%,-50%) rotate(0deg)", opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${rot}deg)`, opacity: 0 },
      ],
      { duration: 1100 + Math.random() * 800, easing: "cubic-bezier(.15,.6,.3,1)" },
    ).onfinish = () => el.remove();
  }
}

const HEART = `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor"><path d="M12 21s-7.5-4.9-10-9.2C.5 8.5 2 5 5.3 5c2 0 3.3 1.1 4.2 2.3l.5.7.5-.7C11.4 6.1 12.7 5 14.7 5 18 5 19.5 8.5 22 11.8 19.5 16.1 12 21 12 21z"/></svg>`;
