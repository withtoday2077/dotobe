// UI 助手：DOM 构建 / toast / modal / 格式化 / 植物线描 SVG

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== null && v !== undefined && v !== false) {
      node.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function toast(msg, kind = "info") {
  const root = document.getElementById("toasts");
  const t = el("div", { class: `toast ${kind}` }, msg);
  root.append(t);
  setTimeout(() => {
    t.style.transition = "opacity 500ms cubic-bezier(0.45,0,0.55,1)";
    t.style.opacity = "0";
    setTimeout(() => t.remove(), 520);
  }, 3200);
}

export const toastOk = (m) => toast(m, "ok");
export const toastErr = (m) => toast(m, "error");

export function modal({ title, body, actions = [], wide = false }) {
  const root = document.getElementById("modal-root");
  const close = () => {
    mask.classList.remove("show");
    setTimeout(() => mask.remove(), 520);
  };
  const mask = el(
    "div",
    { class: "modal-mask" },
    el(
      "div",
      { class: "modal" + (wide ? " wide" : "") },
      el("h3", {}, title),
      body,
      el(
        "div",
        { class: "modal-actions" },
        el("button", { class: "btn", onclick: close }, "取消"),
        ...actions.map((a) =>
          el("button", {
            class: `btn ${a.kind || ""}`,
            onclick: async () => {
              try {
                await a.onClick?.();
                close();
              } catch (e) {
                toastErr(e.message || String(e));
              }
            },
          }, a.label)
        )
      )
    )
  );
  root.append(mask);
  requestAnimationFrame(() => mask.classList.add("show"));
  return { close };
}

export function confirmModal(title, message, onOk, okLabel = "确定", kind = "primary") {
  const body = el("p", { style: "color:var(--text-2);font-size:var(--fs-body);line-height:2" }, message);
  return modal({ title, body, actions: [{ label: okLabel, kind, onClick: onOk }] });
}

// —— 格式化 ——

export function fmtScore(v) {
  const n = Number(v) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function fmtHms(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (x) => String(x).padStart(2, "0");
  return h > 0 ? `${p(h)}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

export function fmtDate(str) {
  if (!str) return "—";
  return String(str).replace("T", " ").slice(0, 16);
}

export function htmlToText(s) {
  if (!s) return "";
  return String(s)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// —— 状态渲染 ——

// 小人看书 · 导航加载场景（背景透明，适配深浅主题；样式见 css/loading-scene.css）
// KaTeX 公式自动渲染（$..$ 行内 / $$..$$ 块级）
export function renderMathIn(root) {
  try {
    if (window.renderMathInElement && root) {
      renderMathInElement(root, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
        ],
        throwOnError: false,
      });
    }
  } catch {}
}

export function loadingScene(text = "加载中") {
  const root = el("div", { class: "load-scene" });
  root.innerHTML = `
    <div class="ls-scene">
      <div class="ls-canvas">
        <div class="ls-chair-shadow"></div>
        <div class="ls-chair">
          <div class="ls-chair-back"></div><div class="ls-chair-back2"></div><div class="ls-chair-seat"></div>
        </div>
        <div class="ls-person">
          <div class="ls-head">
            <div class="ls-hair"></div>
            <div class="ls-eye-left"></div><div class="ls-eye-right"></div>
            <div class="ls-cheek-left"></div><div class="ls-cheek-right"></div>
          </div>
          <div class="ls-neck"></div>
          <div class="ls-body"></div>
          <div class="ls-arm-left"></div><div class="ls-arm-right"></div>
          <div class="ls-leg-left"></div><div class="ls-leg-right"></div>
        </div>
        <div class="ls-book">
          <div class="ls-book-page-left"></div><div class="ls-book-page-right"></div>
          <div class="ls-book-spine"></div><div class="ls-book-line"></div>
        </div>
      </div>
    </div>
    <div class="ls-area">
      <div class="ls-dots"><i></i><i></i><i></i></div>
      <div class="ls-text">${text}</div>
    </div>`;
  return root;
}

export function loadingBox(text = "正在加载…") {
  return el("div", { class: "loading" },
    el("div", { class: "dots" }, el("i"), el("i"), el("i")),
    el("span", {}, text)
  );
}

export function errorBox(msg, onRetry, { onBack, backLabel = "返回" } = {}) {
  const text = msg ?? "未知错误（详见开发者控制台）";
  return el("div", { class: "card", style: "text-align:center" },
    el("p", { style: "color:var(--danger)" }, `⚠ ${text}`),
    el("div", { style: "margin-top:16px;display:flex;gap:12px;justify-content:center" },
      el("button", { class: "btn", onclick: onRetry }, "↻ 重试"),
      onBack ? el("button", { class: "btn ghost", onclick: onBack }, backLabel) : null)
  );
}

export function emptyBox(text, hint = "") {
  return el("div", { class: "empty" },
    el("p", {}, "（暂无数据）"),
    hint ? el("p", { class: "hint" }, hint) : null
  );
}

export function banner(kind, text) {
  return el("div", { class: `banner ${kind}` }, text);
}

export function chip(text, tone = "") {
  return el("span", { class: `chip ${tone}` }, text);
}

// —— SVG 图表元素（el() 走 HTML 命名空间，SVG 必须 createElementNS 才能渲染） ——

const SVG_NS = "http://www.w3.org/2000/svg";
export function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.setAttribute("class", v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

// —— UTF-8 安全的文本 → base64（导出文件用，分块避免大文件爆栈） ——
export function b64Text(str) {
  const bytes = new TextEncoder().encode(String(str ?? ""));
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function pager({ page, totalPages, onGo }) {
  if (totalPages <= 1) return null;
  const wrap = el("div", { class: "pager" });
  const add = (label, target, cur = false, disabled = false) => {
    wrap.append(el("button", {
      class: cur ? "cur" : "",
      disabled: disabled || undefined,
      onclick: () => !cur && !disabled && onGo(target),
    }, label));
  };
  add("«", page - 1, false, page <= 1);
  const pages = new Set([1, totalPages, page - 1, page, page + 1]);
  [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b).forEach((p, i, arr) => {
    if (i > 0 && p - arr[i - 1] > 1) wrap.append(el("span", {}, "…"));
    add(String(p), p, p === page);
  });
  add("»", page + 1, false, page >= totalPages);
  return wrap;
}

// —— 下划线输入（浮动标签） ——

export function field(label, value, { type = "text", textarea = false, oninput } = {}) {
  const wrap = el("div", { class: "field" + (value ? " filled" : "") });
  const input = textarea ? el("textarea") : el("input", { type });
  input.value = value || "";
  const sync = () => wrap.classList.toggle("filled", !!input.value);
  input.addEventListener("input", () => { sync(); oninput?.(input.value); });
  input.addEventListener("blur", sync);
  wrap.append(input, el("label", {}, label));
  wrap.input = input;
  return wrap;
}

// —— 植物线描（每大区块一枚，delicate botanical line drawing） ——

export function botanical(variant = "branch", style = "top:24px;right:32px;width:120px;height:140px") {
  const svg = el("span", { class: "botanical", style });
  const paths = {
    branch: `<path d="M20 130 C 40 90, 34 60, 52 20" />
             <path d="M38 74 C 52 70, 62 58, 64 44" />
             <path d="M44 96 C 30 92, 22 82, 20 68" />
             <circle cx="64" cy="40" r="5" />
             <circle cx="19" cy="64" r="4" />`,
    leaf: `<path d="M16 120 C 20 70, 60 40, 104 34 C 96 80, 60 112, 16 120 Z" />
           <path d="M24 112 C 48 88, 72 64, 96 42" />`,
    sprout: `<path d="M60 130 L 60 70" />
             <path d="M60 84 C 40 80, 30 64, 30 46 C 50 50, 58 62, 60 84 Z" />
             <path d="M60 96 C 80 92, 92 76, 92 58 C 72 62, 62 76, 60 96 Z" />`,
  };
  svg.innerHTML = `<svg viewBox="0 0 120 140" style="width:100%;height:100%">${paths[variant] || paths.branch}</svg>`;
  return svg;
}
