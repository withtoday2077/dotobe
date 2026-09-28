// 应用壳：持久化的侧边栏（核心板块 + 已装插件菜单）+ 顶栏（标题/离线态）。
// ensureShell() 幂等：壳已存在则只更新菜单高亮与标题，不重建（消除导航闪烁）。
// 插件菜单、底部入口与公会壳导航均来自 plugin-state（装/卸后 invalidateShell 重建）。

import { api, session } from "../api.js";
import { el } from "../ui.js";
import { go, currentRoute } from "../router.js";
import { windowControls } from "../win.js";
import { pluginMenuEntries, pluginFooterButtons, getShellKind } from "../plugin-state.js";

const ICONS = {
  dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/></svg>`,
  exams: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M9.5 8h5M9.5 12h5M9.5 16h3"/></svg>`,
  mybank: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 19V5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z"/><path d="M8 7h7M8 11h7"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.5-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.5 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.5-2-1.5c.07-.4.1-.8.1-1.2z"/></svg>`,
  market: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 8h16l-1.2 11a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8L4 8z"/><path d="M8.5 8a3.5 3.5 0 0 1 7 0"/></svg>`,
};

// 核心常驻菜单：控制面板 / 真题市场 / 我的题库；插件市场与个人设置收在“扩展”组
const CORE_MENU = [
  { page: "dashboard", title: "控制面板", icon: "dashboard" },
  { page: "exams", title: "真题市场", icon: "exams" },
  { page: "mybank", title: "我的题库", icon: "mybank" },
];
const TAIL_MENU = [
  { page: "market", title: "插件市场", icon: "market" },
  { page: "settings", title: "个人设置", icon: "settings" },
];

/**
 * 完整侧栏菜单 = 核心 + 已装插件菜单（按插件 order）+ 扩展（插件市场/个人设置）。
 * 插件项的图标是插件自带的内联 SVG（iconSvg），核心项查 ICONS。
 */
export function composeMenu() {
  return [
    ...CORE_MENU,
    ...pluginMenuEntries().map((m) => ({ page: m.page, title: m.title, iconSvg: m.iconSvg })),
    ...TAIL_MENU,
  ];
}

/** 插件菜单是否存在（决定是否渲染“插件”分隔标题） */
function hasPluginMenu() {
  return pluginMenuEntries().length > 0;
}

export function roleLabel(user) {
  const map = { student: "学生", teacher: "教师", admin: "管理员", vip: "VIP" };
  return map[user?.user_type] || "学生";
}

// —— 壳的持久化状态 ——
let refs = null; // { content, title, offlineTag, navItems: [{el, page}] }
let offlineWatchStarted = false;

/**
 * 确保壳存在：不存在则构建，存在则仅更新高亮/标题（幂等）。
 * 返回内容区元素（页面渲染挂载点，支持 grid 叠放双缓冲）。
 */
export function ensureShell(kind = "study") {
  const app = document.getElementById("app");
  const shellId = kind === "guild" ? "__guild_shell" : "__shell";
  const existing = document.getElementById(shellId);
  if (existing && refs?.kind === kind) {
    updateShell(currentRoute().page);
    return document.getElementById("__content");
  }
  if (kind === "guild") return buildGuildShell(app);

  const route = currentRoute();
  const user = session.user || {};

  const balanceEl = el("div", { class: "balance" }, "余额 ¥ —");
  const nav = el("nav", { class: "sidebar" });
  nav.append(
    el("div", { class: "brand", "data-tauri-drag-region": "" },
      el("div", { class: "logo", "data-tauri-drag-region": "" }, "途变"),
      el("div", { class: "tagline", "data-tauri-drag-region": "" }, "知道你在改变")),
    el("div", { class: "nav-user" },
      el("div", { class: "name" }, user.full_name || user.username || "—"),
      el("div", { class: "meta" }, `${user.username || ""} · ${roleLabel(user)}`),
      balanceEl)
  );

  const navItems = [];
  const box = el("div", { class: "nav-group" });
  let pluginGroupOpen = false;
  for (const m of composeMenu()) {
    // 进入插件区前加“插件”分隔标题（区分核心与可选功能）
    if (!pluginGroupOpen && m.iconSvg) {
      if (hasPluginMenu()) {
        box.append(el("div", { class: "nav-sep" }, "插件"));
        pluginGroupOpen = true;
      }
    }
    const iconHtml = m.iconSvg || ICONS[m.icon] || "";
    const item = el("button", {
      class: "nav-item" + (route.page === m.page ? " active" : ""),
      onclick: () => go(m.page),
    }, el("span", { html: iconHtml }), m.title);
    navItems.push({ el: item, page: m.page });
    box.append(item);
  }
  // “扩展”分隔：插件市场 + 个人设置
  const sepIndex = navItems.findIndex((n) => n.page === "market");
  if (sepIndex > 0) box.insertBefore(el("div", { class: "nav-sep" }, "扩展"), navItems[sepIndex].el);
  nav.append(box);

  const footerBox = el("div", { class: "footer" });
  footerBox.append(`v2.2 · Tauri`);
  for (const fb of pluginFooterButtons()) {
    footerBox.append(el("button", {
      class: "btn sm block", style: "margin-bottom:8px", onclick: () => go(fb.route),
    }, fb.title));
  }
  footerBox.append(
    el("button", {
      class: "btn sm block",
      onclick: async () => {
        try { await api.post("backend/api/auth.php", { action: "logout" }); } catch {}
        await api.clearCookies();
        session.clear();
        location.hash = "#/login";
      },
    }, "退出登录"));
  nav.append(footerBox);

  const title = el("span", { class: "title", "data-tauri-drag-region": "" }, "");
  const offlineTag = el("span", { class: "offline", style: "display:none" }, "● 离线");

  const main = el("div", { class: "main" },
    el("div", { class: "wa-wash", "aria-hidden": "true" }),
    el("div", { class: "topbar", "data-tauri-drag-region": "" },
      title,
      el("div", { class: "right" }, windowControls(), offlineTag)),
    el("div", { class: "content", id: "__content" }));

  clear0(app).append(el("div", { class: "shell", id: "__shell" }, nav, main));

  refs = { title, offlineTag, navItems, balanceEl };
  updateShell(route.page);
  startOfflineWatch(offlineTag);
  refreshShellBalance();
  return main.querySelector(".content");
}

/**
 * 作废当前壳（插件安装/卸载后由 loader 调用）：移除壳节点与内部状态，
 * 下一次 ensureShell（随路由 rerender）按最新插件状态重建侧栏。
 */
export function invalidateShell() {
  for (const id of ["__shell", "__guild_shell"]) {
    document.getElementById(id)?.remove();
  }
  refs = null;
}

/** 拉取账户余额并刷新侧栏显示（登录构建壳时与导出扣费后调用） */
export async function refreshShellBalance() {
  if (!refs?.balanceEl) return;
  try {
    // purchase.php get_balance 为扁平信封 { success, balance, ... }（无 data 嵌套）
    const env = await api.get("backend/api/purchase.php", { action: "get_balance" });
    const bal = Number(env?.data?.balance ?? env?.balance);
    refs.balanceEl.textContent = Number.isFinite(bal) ? `余额 ¥${bal.toFixed(2)}` : "余额 ¥ —";
  } catch {
    refs.balanceEl.textContent = "余额 ¥ —";
  }
}

function clear0(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

// —— 冒险公会壳：独立侧边栏与内容区（导航数据由公会插件经 plugin-state 提供） ——
function guildShellConf() {
  const sk = getShellKind("guild");
  return {
    brand: sk?.brand || { logo: "⚔ 冒险公会", name: "冒险者公会", meta: "接任务 · 交朋友 · 共同成长" },
    nav: sk?.nav || [],
    icons: sk?.icons || {},
    subRoutes: sk?.subRoutes || [],
    fallbackTitle: sk?.fallbackTitle || "冒险公会",
  };
}

function buildGuildShell(app) {
  const conf = guildShellConf();
  const route = currentRoute();
  const nav = el("nav", { class: "sidebar guild-sidebar" });
  nav.append(
    el("div", { class: "brand", "data-tauri-drag-region": "" },
      el("div", { class: "logo", style: "color:var(--pink)" }, conf.brand.logo),
      el("div", { class: "tagline", "data-tauri-drag-region": "" }, "知 道 你 在 改 变")),
    el("div", { class: "nav-user" },
      el("div", { class: "name" }, conf.brand.name),
      el("div", { class: "meta" }, conf.brand.meta)));

  const box = el("div", { class: "nav-group" });
  const navItems = [];
  for (const m of conf.nav) {
    const item = el("button", {
      class: "nav-item" + (route.page === m.page ? " active" : ""),
      onclick: () => go(m.page),
    }, el("span", { html: conf.icons[m.icon] || "" }), m.title);
    navItems.push({ el: item, page: m.page });
    box.append(item);
  }
  nav.append(box);

  nav.append(
    el("div", { class: "footer" },
      el("button", { class: "btn sm block", style: "margin-bottom:8px", onclick: () => go("dashboard") },
        "← 返回学习"),
      "v2.2 · 途变"));

  const title = el("span", { class: "title", "data-tauri-drag-region": "" }, "");
  const main = el("div", { class: "main" },
    el("div", { class: "wa-wash", "aria-hidden": "true" }),
    el("div", { class: "topbar", "data-tauri-drag-region": "" },
      title,
      el("div", { class: "right" }, windowControls())),
    el("div", { class: "content", id: "__content" }));

  clear0(app).append(el("div", { class: "shell", id: "__guild_shell" }, nav, main));

  refs = { kind: "guild", title, offlineTag: null, navItems };
  updateShell(route.page);
  return main.querySelector(".content");
}

/**
 * 导航时更新菜单高亮与顶栏标题。
 * @param {string} name 当前路由名
 * @param {boolean} [titleAnim] 标题是否播放切换动画（默认 true；首屏进入传 false）
 */
export function updateShell(name, titleAnim = true) {
  if (!refs) return;
  const setTitle = (text) => {
    if (refs.title.textContent === text) return;
    refs.title.textContent = text;
    if (titleAnim) {
      refs.title.classList.remove("swap");
      void refs.title.offsetWidth; // 重启动画
      refs.title.classList.add("swap");
    }
  };
  if (refs.kind === "guild") {
    // 公会壳：标题取自公会菜单；子页（如 guild/team-detail/<id>）回退到所属菜单项
    const conf = guildShellConf();
    const sub = conf.subRoutes.find((r) => name === r.prefix || name.startsWith(r.prefix + "/"));
    const page = sub ? sub.page : name;
    const item = conf.nav.find((m) => m.page === page);
    setTitle(item?.title || conf.fallbackTitle);
    for (const { el: navItem, page: p } of refs.navItems) {
      navItem.classList.toggle("active", p === item?.page);
    }
    return;
  }
  setTitle((composeMenu().find((m) => m.page === name) || {}).title || "");
  for (const { el: navItem, page } of refs.navItems) {
    navItem.classList.toggle("active", page === name);
  }
}

/** 供外部触发的顶栏标题动画（如菜单快捷跳转后） */
export function animateTitle() {
  if (!refs?.title) return;
  refs.title.classList.remove("swap");
  void refs.title.offsetWidth;
  refs.title.classList.add("swap");
}

/** 离线标签可见性（由全局轮询驱动） */
export function setOfflineVisible(visible) {
  if (refs?.offlineTag) refs.offlineTag.style.display = visible ? "" : "none";
}

function startOfflineWatch(tag) {
  if (offlineWatchStarted) return;
  offlineWatchStarted = true;
  setInterval(async () => {
    try {
      tag.style.display = (await api.isOffline()) ? "" : "none";
    } catch {}
  }, 3000);
}
