// hash 路由：#/page/param → 注册表渲染；未登录守卫。
// 壳复用：登录后的页面共享持久化的侧边栏/顶栏，导航只替换内容区
// （grid 叠放双缓冲：新页面渲染完成前旧页面保持可见，避免闪烁）。

import { session } from "./api.js";
import { clear, el, renderMathIn } from "./ui.js";
import { ensureShell, updateShell, animateTitle } from "./pages/shell.js";
import { knownRoutePlugin } from "./plugin-state.js";

const routes = new Map(); // name -> { renderer, shell }  shell: "study" | "guild" | null(全屏)
const AUTH_PAGES = new Set(["login", "register", "forgot"]);
let current = { page: null, params: {} };
let cleanup = null;
let frame = 0; // 导航竞态防护：只保留最近一次切换
let showScene = true; // 首次进入不闪加载场景

export function register(name, renderer, { shell = "study", noShell = false } = {}) {
  routes.set(name, { renderer, shell: noShell ? null : shell });
}

/** 注销路由（插件卸载/更新时由 loader 调用） */
export function unregister(name) {
  routes.delete(name);
}

export function go(path) {
  location.hash = "#/" + path.replace(/^#\/?/, "");
}

export function currentRoute() {
  return { ...current };
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const segs = raw.split("/");
  // 最长前缀匹配：优先按整段路由名查找（支持 guild/hall 等嵌套名），余下部分作为参数
  for (let i = segs.length; i >= 1; i--) {
    const candidate = segs.slice(0, i).join("/");
    if (routes.has(candidate)) {
      return { name: candidate, param: segs.slice(i).join("/") };
    }
  }
  return { name: raw, param: "" };
}

async function render() {
  const app = document.getElementById("app");
  const { name, param } = parseHash();

  // 登录守卫
  const isAuthPage = AUTH_PAGES.has(name);
  if (!isAuthPage && !session.user) {
    location.hash = "#/login";
    return;
  }
  if (isAuthPage && session.user) {
    location.hash = "#/dashboard";
    return;
  }

  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  current = { page: name, params: { param } };

  const entry = routes.get(name);
  if (!entry) {
    clear(app);
    const pluginName = knownRoutePlugin(name);
    if (pluginName) {
      // 属于某个功能插件但未安装：友好引导去插件市场
      app.append(el("div", { class: "page-enter", style: "padding:48px;text-align:center;color:var(--text-2)" },
        el("p", { style: "margin-bottom:6px" }, `「${pluginName}」属于功能插件，尚未安装`),
        el("p", { style: "font-size:var(--fs-small);color:var(--text-3);margin-bottom:20px" }, "到插件市场安装后即可使用"),
        el("button", { class: "btn primary", onclick: () => { location.hash = "#/market"; } }, "前往插件市场")));
    } else {
      app.append(el("div", { class: "page-enter", style: "padding:48px;text-align:center;color:var(--text-2)" },
        `页面不存在：${name}`));
    }
    return;
  }

  // 认证页 / 全屏页（take）：整页渲染
  if (isAuthPage || entry.shell === null) {
    clear(app);
    const container = el("div", { class: "page-enter" });
    app.append(container);
    try {
      await entry.renderer(container, param);
    } catch (e) {
      container.innerHTML = fatalHTML(e);
    }
    window.scrollTo(0, 0);
    return;
  }

  // 带壳页面：和风切换 —— 旧页柔和消散 → 新页上浮淡入（错峰出场 + 背景水色联动）
  const content = ensureShell(entry.shell);
  const myFrame = ++frame;
  updateShell(name, myFrame === 1 ? false : true); // 首次进入不闪标题动画

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const leaveMs = showScene ? 550 : 0;
  showScene = true;

  // 背景水色随切换缓缓移位（参照"静けさ"：1.5s 光影流转）
  const wash = document.querySelector(".wa-wash");
  if (wash) {
    wash.classList.remove("pos-0", "pos-2", "pos-3");
    // 同一页面重复切换时也触发一次移动，避免停在原地
    void wash.offsetWidth;
    wash.classList.add(washPos(name));
  }

  // 1) 旧页面柔和消散（淡出 + 上浮 + 模糊）
  const old = content.lastElementChild;
  if (old && leaveMs > 0) {
    old.classList.add("page-wa-leave");
    await Promise.race([wait(leaveMs), new Promise((r) => {
      old.addEventListener("animationend", r, { once: true });
    })]);
  } else if (old) {
    old.style.display = "none";
  }

  if (myFrame !== frame) return; // 期间又发生了导航：放弃本次

  // 2) 渲染新页面（渲染期间内容区保持留白，不再显示加载场景）
  const fresh = el("div");
  try {
    await entry.renderer(fresh, param);
  } catch (e) {
    fresh.innerHTML = fatalHTML(e);
  }
  renderMathIn(fresh);
  if (myFrame !== frame) return;

  // 3) 新页面上浮淡入 + 页内元素错峰出场
  clear(content);
  fresh.classList.add("page-wa-enter");
  markStagger(fresh);
  content.append(fresh);
  window.scrollTo(0, 0);
}

/** 依据路由名给出水色落点（纸窗外光影的三个位置） */
function washPos(name) {
  if (name.startsWith("guild/")) return "pos-2";
  if (name === "history" || name === "wrongbook" || name === "knowledge") return "pos-3";
  return "pos-0";
}

/** 为页内主要区块标记错峰出场（标签/标题/正文/分隔线逐层显现） */
function markStagger(root) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const sel = [
    ".gd-page > *", ".gd-page-head, .gd-hero, .gd-me-hero",
    ".card, .gd-panel, .gd-task-card, .gd-team-card, .gd-story-card, .gd-mine-item, .gd-prop",
    ".page-head", ".toolbar-row, .gd-toolbar, .gd-tabs, .gd-tagbar",
    ".table, .gd-matrix-wrap, .gd-chat, .gd-form-section",
    ".stat, .gd-hero-stat, .gd-me-stat",
    ".empty, .loading, .banner",
  ];
  const nodes = [];
  for (const s of sel) root.querySelectorAll(s).forEach((n) => nodes.push(n));
  // 去重且限制数量，避免太多元素排队太久
  const seen = new Set();
  let i = 0;
  for (const n of nodes) {
    if (seen.has(n)) continue;
    seen.add(n);
    if (i > 12) break;
    n.classList.add("wa-child");
    n.style.setProperty("--wa-d", `${Math.min(0.09 * i, 0.36)}s`);
    i++;
  }
}

function fatalHTML(e) {
  return `<div class="card" style="text-align:center;margin:48px auto;max-width:560px">
    <p style="color:var(--danger)">⚠ ${String(e?.message || e).replace(/</g, "&lt;")}</p>
    <div style="margin-top:16px"><button class="btn" onclick="location.reload()">重新加载</button></div></div>`;
}

export function setCleanup(fn) { cleanup = fn; }

export function startRouter() {
  window.addEventListener("hashchange", render);
  if (!location.hash) location.hash = "#/login";
  render();
}

/** 按当前 hash 强制重渲染（插件装/卸重建壳后使用，不改变路由） */
export function rerender() {
  render();
}
