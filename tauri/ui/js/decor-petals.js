// decor-petals.js — 樱花瓣装饰层（主题包 decor: ["petals"] 时由 theme.js 激活）
// 慢速飘落 + 鼠标风场：指针经过时吹开/拨动花瓣，风力衰减后回落为自然飘落。
// 层级：z-index:-1 固定层 —— 纸纹之上、一切内容之下，只在留白处可见，不遮挡任何组件。
// 无障碍：prefers-reduced-motion 不启动；页面隐藏时暂停 rAF。

let raf = 0;
let container = null;
let petals = [];
let running = false;
let suspended = false;
let last = 0;
let vw = 0, vh = 0;

const mouse = { x: -1e4, y: -1e4, wind: 0 };

const COUNT = 18;
const R = 110;        // 指针风场半径
const PUSH = 560;     // 径向推力（px/s²）
const WIND = 26;      // 指针横向掠过的吹力系数

const COLORS = ["var(--pink)", "#ff9db4", "#ffb7c5", "#ffc9d4"];

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function onMove(e) {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  mouse.wind = clamp(mouse.wind + (e.movementX || 0) * WIND, -700, 700);
}

function onLeave() {
  mouse.x = -1e4;
  mouse.y = -1e4;
  mouse.wind = 0;
}

function onVisibility() {
  if (!running) return;
  if (document.hidden) {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    suspended = true;
  } else {
    suspended = false;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }
}

function tick(now) {
  const dt = clamp((now - last) / 1000, 0, 0.05);
  last = now;
  vw = window.innerWidth;
  vh = window.innerHeight;
  mouse.wind *= Math.exp(-4 * dt);

  for (const p of petals) {
    p.phase += p.swayFreq * dt;

    // 指针风场：半径内径向吹开 + 横向风 + 轻微上托，旋转被"拨动"
    const dx = p.x - mouse.x;
    const dy = p.y - mouse.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < R * R) {
      const d = Math.sqrt(d2) || 1;
      const f = (1 - d / R) * PUSH;
      p.vx += (dx / d) * f * dt + mouse.wind * (1 - d / R) * dt * 2.2;
      p.rotV += (dx / d) * f * 0.22 * dt;
      p.y -= (dy / d) * f * 0.22 * dt;
    }

    p.vx *= Math.exp(-2.2 * dt);
    p.rotV *= Math.exp(-1.5 * dt);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += (p.rotV + Math.sin(p.phase) * 10) * dt;

    // 出界回卷
    if (p.y > vh + 24) { p.y = -24; p.x = rand(0, vw); p.vx = 0; }
    if (p.x < -30) p.x = vw + 28;
    else if (p.x > vw + 30) p.x = -28;

    const drawX = p.x + Math.sin(p.phase) * p.swayAmp;
    p.el.style.transform = `translate3d(${drawX.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) rotate(${p.rot.toFixed(1)}deg)`;
  }
  raf = requestAnimationFrame(tick);
}

export function start() {
  if (running || typeof document === "undefined") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  running = true;
  suspended = false;

  container = document.createElement("div");
  container.id = "dotobe-petals";
  container.setAttribute("aria-hidden", "true");
  container.style.cssText =
    "position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden";
  document.body.appendChild(container);

  vw = window.innerWidth;
  vh = window.innerHeight;
  petals = [];
  for (let i = 0; i < COUNT; i++) {
    const el = document.createElement("span");
    const size = rand(10, 16);
    el.style.cssText =
      "position:absolute;left:0;top:0;will-change:transform;" +
      `width:${size.toFixed(1)}px;height:${(size * 1.25).toFixed(1)}px;` +
      `background:${COLORS[i % COLORS.length]};` +
      "border-radius:100% 0 100% 0;" +
      `opacity:${rand(0.55, 0.9).toFixed(2)}`;
    container.appendChild(el);
    petals.push({
      el,
      x: rand(0, vw),
      y: rand(-vh, 0),
      vy: rand(20, 42),
      vx: 0,
      rot: rand(0, 360),
      rotV: rand(-26, 26),
      swayAmp: rand(8, 24),
      swayFreq: rand(0.5, 1.1),
      phase: rand(0, Math.PI * 2),
    });
  }

  window.addEventListener("mousemove", onMove, { passive: true });
  document.documentElement.addEventListener("mouseleave", onLeave);
  document.addEventListener("visibilitychange", onVisibility);
  last = performance.now();
  raf = requestAnimationFrame(tick);
}

export function stop() {
  if (!running) return;
  running = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  window.removeEventListener("mousemove", onMove);
  document.documentElement.removeEventListener("mouseleave", onLeave);
  document.removeEventListener("visibilitychange", onVisibility);
  container?.remove();
  container = null;
  petals = [];
}
