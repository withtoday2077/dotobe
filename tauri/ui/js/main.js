// 装配：主题应用 + 会话恢复 + 路由注册 + 启动

import { api, session } from "./api.js";
import { startRouter, register, go } from "./router.js";
import { el, modal, toastOk, toastErr } from "./ui.js";
import { isAndroid } from "./mobile.js";

// 全局错误兜底：把错误面板插入页面顶部（无论内容是否已渲染）
function showFatal(msg) {
  let d = document.getElementById("__fatal");
  if (!d) {
    d = document.createElement("div");
    d.id = "__fatal";
    d.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:999999;background:#ffe;border-bottom:2px solid #c73e4d;color:#c73e4d;padding:10px 18px;font-size:14px";
    (document.body || document.documentElement).appendChild(d);
  }
  d.textContent = "⚠ " + String(msg).replace(/</g, "&lt;");
  try { markAppReady(); } catch {} // 致命错误时立即撤启动层，保证错误可见
}
window.addEventListener("error", (ev) => showFatal(`${ev.message} (${ev.filename}:${ev.lineno})`));
window.addEventListener("unhandledrejection", (ev) => showFatal(ev.reason?.message || ev.reason || "未处理的异步错误"));

// —— 启动衔接：页内启动层与启动屏窗口同画面。会话定稿（进控制面板或留登录页）后
// 淡出启动层并 emit "app-ready"，Rust 端随之显示主窗、撤掉启动屏窗口。 ——
// 最短停留须 ≥ 启动屏编舞总时长（末颗圆果 1.9s 起笔 + 0.5s 运笔 ≈ 2.4s，再留一口气缓冲），
// 否则植物长到一半就被切走，观感突兀；系统要求减弱动效时动画已静态化，直接放行。
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
const BOOT_MIN_MS = REDUCED_MOTION ? 300 : 2600;
const BOOT_MAX_MS = 4000; // 会话探测卡死兜底：超时直接放行（此时页面已是登录页）
const bootStart = Date.now();
let bootReady = false;
function markAppReady() {
  if (bootReady) return;
  bootReady = true;
  const wait = Math.max(0, BOOT_MIN_MS - (Date.now() - bootStart));
  setTimeout(() => {
    const overlay = document.getElementById("boot-splash");
    if (overlay) {
      overlay.classList.add("boot-fade");
      setTimeout(() => overlay.remove(), 600);
    }
    try { window.__TAURI__.event.emit("app-ready"); } catch {} // 浏览器直开时无 Tauri，静默
  }, wait);
}
setTimeout(markAppReady, BOOT_MAX_MS);

import { renderAuth } from "./pages/auth.js";
import { renderDashboard } from "./pages/dashboard.js";
import { renderExams } from "./pages/exams.js";
import { renderTake } from "./pages/take.js";
import { renderPractice } from "./pages/practice.js";
import { renderMockExam } from "./pages/mock.js";
import { renderSettings } from "./pages/settings.js";
import { renderMybank } from "./pages/mybank.js";
import { renderMarket, maybeShowPluginOnboarding } from "./pages/market.js";

// 插件加载器：激活本地已装插件（asset 协议动态 import，注册路由与菜单）
import { activateAll } from "./plugin-loader.js";

// 外观：内置浅/深或用户导入的主题包（custom:<id>，异步恢复，失败回退浅色）
import { restoreTheme } from "./theme.js";
restoreTheme();

register("login", (c) => renderAuth(c, "login"));
register("register", (c) => renderAuth(c, "register"));
register("forgot", (c) => renderAuth(c, "forgot"));
// —— 核心板块：控制面板 / 真题市场 / 我的题库 / 个人设置 + 插件市场 ——
register("dashboard", renderDashboard);
register("exams", renderExams);
register("mybank", renderMybank);
register("settings", renderSettings);
register("market", renderMarket);
// —— 核心流程页（无菜单入口，真题市场/我的题库/本地题库插件共用）——
register("take", renderTake, { noShell: true }); // 全屏沉浸答题
register("practice", renderPractice, { noShell: true }); // 全屏刷题（即时判分）
register("mock", renderMockExam, { noShell: true }); // 全屏仿真模拟考试（A3 纸质小册）
// —— 其余板块均为插件：学习记录 / 知识树 / 本地题库 / 教学工具 / 冒险公会，
//    由 plugin-loader 从数据目录激活（市场安装后可用）——

// 启动：先激活本地已装插件（纯本地毫秒级），再起路由（会话恢复期间显示登录页），
// 最后异步恢复会话。插件路由注册完成后 startRouter 才解析 hash，避免恢复的
// 插件页 hash 命中“页面不存在”。DPAPI cookies 已由 Rust 端启动时注入 jar。
const INITIAL_HASH = location.hash;
const isAuthHash = (h) => !h || h.startsWith("#/login") || h.startsWith("#/register") || h.startsWith("#/forgot");

await activateAll();
startRouter();

// 首次启动初始化：一次性选择数据存储位置（location.json 兼作标记，之后不再弹）
(async () => {
  try {
    if (isAndroid()) return; // 应用私有目录由 Rust 端 setup 决定，无需选择
    const loc = await api.getDataLocation();
    if (!loc?.firstRun) return;
    const { open } = window.__TAURI__.dialog;
    modal({ title: "初始化 · 数据存储位置", body:
      el("div", {},
        el("p", { style: "color:var(--text-2);line-height:1.9;margin-bottom:10px" },
          "选择客户端数据（登录会话、试卷缓存、刷题进度）的保存位置。"),
        el("p", { style: "color:var(--text-3);font-size:var(--fs-small);line-height:1.9" },
          "默认保存于系统 AppData 目录，适合大多数用户；自定义路径适合把数据集中到指定盘符。之后可随时在「个人设置 → 存储」中更改。")),
      actions: [
        { label: "自定义路径…", onClick: async () => {
          const dir = await open({ multiple: false, directory: true });
          const p = Array.isArray(dir) ? dir[0] : dir;
          if (!p) throw new Error("未选择文件夹，请重试");
          await api.setDataLocation(p);
        } },
        { label: "使用默认（推荐）", kind: "primary", onClick: async () => {
          await api.setDataLocation(null);
        } },
      ] });
  } catch { /* 非 Tauri 环境（浏览器测试）静默 */ }
})();

(async () => {
  const settle = (user) => {
    session.setUser(user);
    toastOk(`欢迎回来，${user.full_name || user.username}`);
    if (isAuthHash(location.hash)) go(isAuthHash(INITIAL_HASH) ? "dashboard" : INITIAL_HASH.replace(/^#\//, ""));
    markAppReady(); // 目标页已渲染，撤启动层
    maybeShowPluginOnboarding(); // 一次性首启引导（勾选安装插件），已引导过则静默
  };
  try {
    const env = await api.get("backend/api/auth.php", { action: "check" });
    const user = env.data?.user || env.data;
    if (user && (user.id || user.username)) return settle(user);
    throw new Error("无会话");
  } catch {
    // 会话失效：尝试记住我自动登录（remember_token 在 Rust 端 jar 中自动携带）
    try {
      const env = await api.get("backend/api/auth.php", { action: "auto_login" });
      const user = env.data?.user || env.data;
      if (user && (user.id || user.username)) return settle(user);
      session.clear();
    } catch { session.clear(); }
    if (isAuthHash(location.hash)) go("login");
    markAppReady(); // 留在登录页，撤启动层
  }
})();
