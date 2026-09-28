// theme.js — 外观插件运行时（v2.1）
// 一切皆插件：内置 light/dark + 用户导入的 JSON 令牌包（dotobe-theme v1）。
// 应用方式：dataset.theme = mode；tokens 序列化注入 <style id="custom-theme">（head 末尾，
// 同特异性后序覆盖 tokens.css 的 :root 与 [data-theme="dark"]）。
// 可选 css 字段：主题包可携带附加样式表（装饰层/内嵌 data-URI 插画字体），
// 注入 <style id="custom-theme-css">（在 custom-theme 之后，可引用 tokens 变量）。
// 持久化：localStorage "dotobe.theme" = "light" | "dark" | "custom:<id>"。
// 主题包存放于 Rust 端数据目录 themes/<id>.json（随便携/自定义/默认三级优先级）。

import { api } from "./api.js";

export const THEME_KEY = "dotobe.theme";

/** 允许被主题覆盖的令牌白名单（= css/tokens.css :root 全集） */
export const ALLOWED_TOKENS = [
  // 色板
  "--sky", "--rice", "--mint", "--pink", "--powder",
  // 文字/边框
  "--text", "--text-2", "--text-3", "--border",
  "--faint-bg",
  // 语义
  "--ok", "--warn", "--danger", "--info",
  // 语义 tint
  "--sky-t", "--mint-t", "--pink-t", "--powder-t", "--warn-t", "--danger-t", "--ok-t",
  // 圆角
  "--r-card", "--r-lg", "--r-md", "--r-full",
  // 发丝边框（整值，含 1px solid）
  "--hairline", "--hairline-soft",
  // 阴影/动效/和风
  "--shadow-hover", "--ease", "--dur", "--wa-ease", "--wa-shu",
  // 间距
  "--sp-1", "--sp-2", "--sp-3", "--sp-4", "--sp-5", "--sp-6", "--sp-7",
  // 字号/字体
  "--fs-hero", "--fs-h1", "--fs-h2", "--fs-h3", "--fs-body", "--fs-small", "--fs-tiny",
  "--font",
];
const ALLOWED = new Set(ALLOWED_TOKENS);

/** 值安全校验：短字符串、拒绝标签/危险函数/花括号（防逃逸 :root{} 注入任意 CSS） */
function safeValue(v) {
  if (typeof v !== "string" || !v.trim() || v.length > 64) return false;
  return !/[{}<]|url\s*\(|expression\s*\(|javascript\s*:|behavior\s*:/i.test(v);
}

/** 附加样式表（css 字段）校验：≤3MB（容纳内嵌 CJK 子集字体/插画）；拒绝 @import 与脚本向量；
 *  url( 仅允许 data:（防外链/追踪）。url 检查用扫描式实现（与 Rust 端 valid_theme_css 逐字对齐） */
const CSS_MAX = 3 * 1024 * 1024;
function safeCss(css) {
  if (typeof css !== "string" || !css.trim() || css.length > CSS_MAX) return false;
  const low = css.toLowerCase();
  if (low.includes("@import") || low.includes("javascript:") || low.includes("expression(")
    || low.includes("behavior:") || low.includes("<script")) return false;
  let i = 0;
  for (;;) {
    const pos = low.indexOf("url(", i);
    if (pos === -1) return true;
    let j = pos + 4;
    while (j < low.length && /[\s"']/.test(low[j])) j++;
    if (!low.startsWith("data:", j)) return false;
    i = j;
  }
}

/**
 * 校验主题包对象，返回错误数组（空 = 合法）。
 * 前端/启动恢复均走此函数；Rust 端另有基础形状校验，双保险。
 */
export function validateTheme(t) {
  const errs = [];
  if (!t || typeof t !== "object") return ["主题包不是 JSON 对象"];
  if (t.format !== "dotobe-theme") errs.push("缺少 format: \"dotobe-theme\" 标识");
  if (t.version !== 1) errs.push("不支持的版本（当前仅支持 1）");
  if (!/^[a-z0-9-]{2,40}$/.test(String(t.id || ""))) errs.push("id 需为 2-40 位小写字母/数字/连字符");
  if (!String(t.name || "").trim() || String(t.name).length > 24) errs.push("name 需为 1-24 个字符");
  if (t.mode !== "light" && t.mode !== "dark") errs.push("mode 需为 \"light\" 或 \"dark\"");
  const tokens = t.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens) || !Object.keys(tokens).length) {
    errs.push("tokens 需为非空对象");
  } else {
    for (const [k, v] of Object.entries(tokens)) {
      if (!ALLOWED.has(k)) errs.push(`不支持的令牌：${k}（不在白名单）`);
      else if (!safeValue(v)) errs.push(`令牌 ${k} 的值不合法（≤64 字符，禁止标签/URL/函数）`);
    }
  }
  if (t.swatches != null && (!Array.isArray(t.swatches) || t.swatches.some((s) => !safeValue(s)))) {
    errs.push("swatches 需为合法颜色值数组");
  }
  if (t.css != null && !safeCss(t.css)) {
    errs.push("css 字段不合法（≤3MB，禁止 @import 与脚本向量，url( 仅允许 data:）");
  }
  if (t.decor != null) {
    if (!Array.isArray(t.decor) || t.decor.length > 8 || t.decor.some((d) => !DECOR.has(d))) {
      errs.push(`decor 需为装饰列表（最多 8 项，可选：${[...DECOR].join("/")}）`);
    }
  }
  return [...new Set(errs)].slice(0, 6);
}

/** 把 tokens 写成 :root{...} cssText */
function tokensToCss(tokens) {
  return ":root{" + Object.entries(tokens)
    .filter(([k]) => ALLOWED.has(k))
    .map(([k, v]) => `${k}:${v}`)
    .join(";") + "}";
}

/** 可声明的装饰能力（decor 字段白名单）：petals = 内置樱花瓣物理层（decor-petals.js） */
const DECOR = new Set(["petals"]);

/** 装饰模块生命周期：按主题声明拉起/停掉对应模块（同步多余声明，忽略动态导入失败） */
let petalsModPromise = null;
function syncDecor(theme) {
  const want = Array.isArray(theme?.decor) && theme.decor.includes("petals");
  if (want && !petalsModPromise) {
    petalsModPromise = import("./decor-petals.js")
      .then((m) => { m.start(); return m; })
      .catch(() => { petalsModPromise = null; return null; });
  } else if (!want && petalsModPromise) {
    petalsModPromise.then((m) => m && m.stop());
    petalsModPromise = null;
  }
}

/** 应用自定义主题：mode 决定底色模式，tokens 注入末序 style；css 字段（附加样式表）注入其后 */
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme.mode === "dark" ? "dark" : "";
  let style = document.getElementById("custom-theme");
  if (!style) {
    style = document.createElement("style");
    style.id = "custom-theme";
    document.head.appendChild(style);
  }
  style.textContent = tokensToCss(theme.tokens || {});
  let cssStyle = document.getElementById("custom-theme-css");
  if (!cssStyle) {
    cssStyle = document.createElement("style");
    cssStyle.id = "custom-theme-css";
    document.head.appendChild(cssStyle);
  }
  // 已过 validateTheme 才会走到这里；双保险再拦一次非法 css
  cssStyle.textContent = typeof theme.css === "string" && safeCss(theme.css) ? theme.css : "";
  syncDecor(theme);
}

/** 应用内置主题（light/dark），移除自定义注入与装饰 */
export function applyBuiltIn(id) {
  document.documentElement.dataset.theme = id === "dark" ? "dark" : "";
  document.getElementById("custom-theme")?.remove();
  document.getElementById("custom-theme-css")?.remove();
  syncDecor(null);
}

/** 持久化当前选择（内置 id 或 custom:<id>） */
export function persistTheme(id) {
  localStorage.setItem(THEME_KEY, id);
}

/**
 * 启动恢复：读 localStorage；custom:<id> 时从数据目录加载，
 * 缺失/损坏回退浅色并清理键。main.js 启动时调用。
 */
export async function restoreTheme() {
  const saved = localStorage.getItem(THEME_KEY) || "light";
  if (saved === "dark") { applyBuiltIn("dark"); return; }
  if (saved === "light" || !saved.startsWith("custom:")) { applyBuiltIn("light"); return; }
  const id = saved.slice("custom:".length);
  try {
    const list = await api.listThemes();
    const t = (list || []).find((x) => x.id === id);
    if (!t || validateTheme(t).length) {
      localStorage.removeItem(THEME_KEY);
      applyBuiltIn("light");
      return;
    }
    applyTheme(t);
  } catch {
    localStorage.removeItem(THEME_KEY);
    applyBuiltIn("light");
  }
}

/** 生成主题模板 JSON 文本（帮助创作：含全部可覆盖令牌与注释性说明字段） */
export function themeTemplate() {
  const tpl = {
    format: "dotobe-theme",
    version: 1,
    id: "my-theme",
    name: "我的主题",
    author: "",
    mode: "light",
    swatches: ["#fafaf8", "#64b5f6", "#98d8c8", "#ffb7c5"],
    tokens: {},
    css: "/* 可选附加样式表：装饰层，可引用 var() 令牌；内嵌图片字体请用 data URI */",
    decor: [],
    _说明: "tokens 中列出要覆盖的令牌即可（其余沿用默认）。可用令牌见 ALLOWED_TOKENS：色板 --sky/--rice/--mint/--pink/--powder；文字 --text/--text-2/--text-3/--border/--faint-bg；语义 --ok/--warn/--danger/--info 及其 -t 浅底；圆角 --r-*；发丝边框 --hairline*；动效 --dur/--ease；间距 --sp-*；字号 --fs-*；字体 --font。css 为可选附加样式表（装饰层）：在令牌之后注入，可用 var() 引用令牌，内嵌图片/字体用 data: URI（url( 仅允许 data:），禁止 @import 与脚本向量。decor 为可选装饰声明（客户端内置的交互装饰），目前支持 \"petals\"（樱花瓣飘落+鼠标风场）。mode 为 dark 时请提供全套深色值。文件后缀建议 .dtheme（导入时也接受 .json）。",
  };
  return JSON.stringify(tpl, null, 2);
}
