// 无边框窗口控制：自绘 最小化/最大化/关闭 按钮 + 可拖动条
// 依赖 capabilities: core:window:allow-minimize / toggle-maximize / close / start-dragging
// Android：系统提供标题栏与返回键，自绘控件无意义——仅保留占位高度（布局不变）

import { isAndroid } from "./mobile.js";

const { getCurrentWindow } = window.__TAURI__.window;
const appWindow = getCurrentWindow();

/**
 * 窗口控制按钮组（最小化/最大化/关闭），日系清新风格。
 * 图标为纯 CSS 绘制（.wc-btn i），保证三者视觉尺寸一致。
 * 返回可 append 的容器元素。Android 上返回空容器。
 */
export function windowControls() {
  const wrap = el0("div", { class: "win-controls" });
  if (isAndroid()) return wrap;
  const btn = (label, cls, fn) => {
    const b = el0("button", { class: `wc-btn ${cls}`, title: label, "aria-label": label });
    b.append(el0("i", {}));
    b.addEventListener("click", fn);
    return b;
  };
  wrap.append(
    btn("最小化", "min", () => appWindow.minimize()),
    btn("最大化", "max", () => appWindow.toggleMaximize()),
    btn("关闭", "close", () => appWindow.close())
  );
  // 最大化状态切换图标（CSS 画：单框 ↔ 还原叠框）
  appWindow.onResized(({ payload: rect }) => {
    const maximized = rect.width >= window.screen?.width ?? false;
    wrap.querySelector(".max").classList.toggle("maximized", maximized);
  });
  return wrap;
}

/**
 * 可拖动区域条（无边框窗口顶部）。
 * data-tauri-drag-region 命中元素本身即可拖动/双击最大化。
 * Android 上仅保留占位高度（保持各页顶栏布局一致）。
 */
export function dragBar({ height = 38, withControls = true } = {}) {
  const bar = el0("div", {
    class: "drag-bar",
    ...(isAndroid() ? {} : { "data-tauri-drag-region": "" }),
    style: `height:${height}px`,
  });
  const spacer = el0("div", { ...(isAndroid() ? {} : { "data-tauri-drag-region": "" }), style: "flex:1;height:100%" });
  bar.append(spacer);
  if (withControls) bar.append(windowControls());
  return bar;
}

function el0(tag, attrs = {}) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "innerText") n.innerText = v;
    else if (v !== undefined && v !== null) n.setAttribute(k, v === true ? "" : v);
  }
  return n;
}
