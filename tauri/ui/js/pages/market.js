// 插件市场（核心板块）：目录展示 / 安装 / 更新 / 卸载 + 一次性首启引导。
// 目录来自 backend/api/plugins.php（离线回退本地缓存）；安装状态纯本地
// （plugin-state），服务端只提供目录与包下载。

import { api, session } from "../api.js";
import { el, toastOk, toastErr, confirmModal } from "../ui.js";
import { go, rerender } from "../router.js";
import { getActivePlugins } from "../plugin-state.js";
import { installPlugin, uninstallPlugin } from "../plugin-loader.js";

const APP_VERSION_FALLBACK = "2.2.0";
const CATALOG_CACHE_KEY = "plugin_catalog_cache";
const ONBOARD_FLAG_KEY = "plugin_onboarded";

// 市场卡片图标（目录 icon 字段 → 内联 SVG；未知回退拼图）
const CATALOG_ICONS = {
  history: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`,
  tree: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="12" cy="4" r="2.2"/><circle cx="6" cy="13" r="2.2"/><circle cx="18" cy="13" r="2.2"/><circle cx="12" cy="20" r="2.2"/><path d="M12 6.2v4M7 15.2l3.2 2.8M17 15.2l-3.2 2.8M8.2 13h7.6"/></svg>`,
  offline: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M12 8a4 4 0 0 1 4 4M12 5a7 7 0 0 1 7 7"/></svg>`,
  bank: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 9l9-6 9 6M5 9v10M19 9v10M9 19v-6h6v6"/><path d="M3 21h18"/></svg>`,
  hall: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6"/></svg>`,
};
const FALLBACK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M10 3h4v3a2 2 0 0 0 2 2h3v4h-3a2 2 0 0 0-2 2v3h-4v-3a2 2 0 0 0-2-2H5V8h3a2 2 0 0 0 2-2z"/><path d="M4 21h16"/></svg>`;
const TINTS = ["t-sky", "t-mint", "t-powder", "t-warn", "t-pink"];

let _appVersion = null;
async function appVersion() {
  if (_appVersion) return _appVersion;
  try {
    _appVersion = (await window.__TAURI__.app.getVersion()) || APP_VERSION_FALLBACK;
  } catch {
    _appVersion = APP_VERSION_FALLBACK;
  }
  return _appVersion;
}

/** 语义化版本比较：a<b 负 / 相等 0 / a>b 正 */
function cmpVer(a, b) {
  const pa = String(a || "0").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "0").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** 目录条目对当前用户是否可见（角色白名单，客户端再过滤一次） */
function visibleForUser(item) {
  if (!item.roles || !item.roles.length) return true;
  return item.roles.includes(session.user?.user_type || "student");
}

/** 拉目录：在线优先，失败回退本地缓存（离线市场） */
async function fetchCatalog() {
  try {
    const env = await api.get("backend/api/plugins.php", { action: "list" });
    const plugins = env?.data?.plugins || [];
    if (plugins.length) {
      api.saveLocalCache(CATALOG_CACHE_KEY, plugins).catch(() => {});
      return { plugins, offline: false };
    }
  } catch { /* 离线/未登录等 → 走缓存 */ }
  let cached = null;
  try { cached = await api.loadLocalCache(CATALOG_CACHE_KEY); } catch {}
  return { plugins: Array.isArray(cached) ? cached : [], offline: true };
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ============ 市场页 ============

let curTab = "all";

export async function renderMarket(container) {
  const installed = getActivePlugins();
  const { plugins, offline } = await fetchCatalog();
  const visible = plugins.filter(visibleForUser);

  const head = el("div", { class: "page-head" },
    el("h1", {}, "插件市场"),
    el("div", { class: "sub" }, `已安装 ${installed.length}${visible.length ? ` / ${visible.length}` : ""} · 按需安装，不用不装`));
  container.append(head);

  if (offline) {
    container.append(el("div", { class: "banner warn" },
      "当前离线，仅显示缓存的目录；已安装插件可正常使用，安装/更新需要联网。"));
  }

  const tabs = el("div", { class: "market-tabs" },
    ...[["all", "全部"], ["installed", "已安装"], ["available", "未安装"]].map(([k, t]) =>
      el("button", { class: "tab" + (curTab === k ? " active" : ""), onclick: () => { curTab = k; rerender(); } }, t)));
  container.append(tabs);

  const list = visible.filter((p) => {
    const has = installed.some((i) => i.manifest.id === p.key);
    return curTab === "all" || (curTab === "installed") === has;
  });

  const grid = el("div", { class: "plugin-grid" });
  if (!list.length) {
    grid.append(el("div", { class: "empty", style: "grid-column:1/-1" },
      offline ? "离线且暂无缓存目录" : "这里空空如也"));
  } else {
    for (let i = 0; i < list.length; i++) grid.append(await cardEl(list[i], list[i].key, i));
  }
  container.append(grid);
}

async function cardEl(item, key, index) {
  const installedInfo = getActivePlugins().find((i) => i.manifest.id === item.key);
  const has = !!installedInfo;
  const updatable = has && cmpVer(item.version, installedInfo.manifest.version) > 0;
  const meets = await meetsMinClient(item.min_client);
  const offlineNow = await isOfflineNow();

  const iconHtml = CATALOG_ICONS[item.icon] || FALLBACK_ICON;
  // 按钮区先建容器、卡片组装完再填充：footButtons 需要拿到已初始化的 card
  // （安装进度条定位用），不能在 const card = el(...) 的参数里传 card —— TDZ。
  const foot = el("div", { class: "plugin-foot" },
    el("span", { class: "foot-l" },
      has ? el("span", { class: "state" }, `✓ 已安装 v${installedInfo.manifest.version}`) : el("span"),
      el("div", { class: "progress", style: "display:none" }, el("i"))),
    el("span", { class: "grow" }));
  const card = el("div", { class: "plugin-card" + (has ? " installed" : "") },
    el("div", { class: "row1" },
      el("div", { class: `plugin-icon ${TINTS[index % TINTS.length]}`, html: iconHtml }),
      el("div", {},
        el("div", { class: "plugin-name" }, item.name),
        el("div", { class: "plugin-ver" },
          `v${has && !updatable ? installedInfo.manifest.version : item.version} · ${item.file_size_text || fmtSize(item.file_size)}`))),
    el("div", { class: "plugin-desc" }, item.description || ""),
    el("div", { class: "plugin-tags" },
      ...(item.roles?.length ? [el("span", { class: "tag role" }, "教师专用")] : []),
      el("span", { class: "tag" }, item.key),
      ...(updatable ? [el("span", { class: "tag update" }, `可更新 → v${item.version}`)] : [])),
    foot);
  foot.append(await footButtons(item, { has, updatable, meets, offlineNow }, card));

  return card;
}

async function footButtons(item, st, card) {
  const wrap = el("span", { class: "plugin-foot-btns" });
  const { has, updatable, meets, offlineNow } = st;
  if (!meets) {
    wrap.append(el("button", { class: "btn sm", disabled: true },
      `需客户端 v${item.min_client}+`));
    return wrap;
  }
  if (offlineNow) {
    wrap.append(el("button", { class: "btn sm", disabled: true }, has ? (updatable ? "离线不可更新" : "已安装") : "离线不可安装"));
    return wrap;
  }
  if (!has) {
    wrap.append(el("button", { class: "btn sm primary", onclick: () => runInstall(item, card, "安装") }, "安装"));
    return wrap;
  }
  if (updatable) {
    wrap.append(el("button", { class: "btn sm primary", onclick: () => runInstall(item, card, "更新") }, "更新"));
  }
  wrap.append(el("button", {
    class: "btn sm ghost-danger",
    onclick: () => runUninstall(item),
  }, "卸载"));
  return wrap;
}

async function isOfflineNow() {
  try { return await api.isOffline(); } catch { return false; }
}

async function meetsMinClient(min) {
  if (!min) return true;
  return cmpVer(await appVersion(), min) >= 0;
}

/** 安装/更新：按钮态 + 进度条示意（Rust 下载为一次性 invoke，进度以动画示意） */
async function runInstall(item, card, label) {
  const bar = card?.querySelector(".progress");
  const state = card?.querySelector(".state");
  const btn = card?.querySelector(".plugin-foot-btns .btn");
  if (btn) { btn.disabled = true; btn.textContent = `${label}中…`; }
  if (bar) {
    bar.style.display = "";
    let v = 0;
    const t = setInterval(() => {
      v = Math.min(v + 9 + Math.random() * 14, 92);
      bar.querySelector("i").style.width = `${v}%`;
      if (v >= 92) clearInterval(t);
    }, 160);
    card._barTimer = t;
  }
  try {
    await installPlugin(item);
    if (card?._barTimer) clearInterval(card._barTimer);
    if (bar) bar.querySelector("i").style.width = "100%";
    toastOk(`「${item.name}」${label === "更新" ? "已更新到" : "已安装"} v${item.version}`);
    await new Promise((r) => setTimeout(r, 260)); // 让进度条走完一眼
    rerender();
  } catch (e) {
    if (card?._barTimer) clearInterval(card._barTimer);
    if (bar) bar.style.display = "none";
    toastErr(e?.message || `${label}失败`);
    rerender();
  }
}

async function runUninstall(item) {
  confirmModal(
    `卸载「${item.name}」`,
    "卸载后侧栏入口与功能页面将被移除；账号内的服务端数据（成绩/错题/手札等）不受影响，随时可重新安装。",
    async () => {
      try {
        await uninstallPlugin(item.key);
        toastOk(`「${item.name}」已卸载`);
        if ((parseRouteName() || "").startsWith("guild/") && item.key === "guild") {
          go("market"); // 正处于公会页：先回市场
        } else {
          rerender();
        }
      } catch (e) {
        toastErr(e?.message || "卸载失败");
      }
    },
    "卸载",
    "danger");
}

function parseRouteName() {
  return location.hash.replace(/^#\/?/, "").split("?")[0];
}

// ============ 首启引导（一次性） ============

/**
 * 登录 settle 后调用：从未引导过且目录可得时，弹一次“选择你要的功能”。
 * 稍后再说/安装完成都会记标记；离线等异常静默跳过，下次启动再试。
 */
export async function maybeShowPluginOnboarding() {
  try {
    if (!window.__TAURI__?.core) return; // 浏览器直开时跳过
    const done = await api.loadLocalCache(ONBOARD_FLAG_KEY);
    if (done) return;
    const { plugins, offline } = await fetchCatalog();
    if (offline) return; // 没目录就先不引导
    const visible = plugins.filter(visibleForUser).filter((p) =>
      !getActivePlugins().some((i) => i.manifest.id === p.key));
    if (!visible.length) {
      await api.saveLocalCache(ONBOARD_FLAG_KEY, true);
      return;
    }
    showOnboarding(visible);
  } catch { /* 静默 */ }
}

function showOnboarding(items) {
  const root = document.getElementById("modal-root");
  const close = () => {
    mask.classList.remove("show");
    setTimeout(() => mask.remove(), 520);
  };
  const mask = el("div", { class: "modal-mask" });

  const picks = items.map((item, i) => {
    const checkbox = el("input", { type: "checkbox" });
    checkbox.addEventListener("change", syncBtn);
    return el("label", { class: "pick" },
      checkbox,
      el("div", { class: `plugin-icon sm ${TINTS[i % TINTS.length]}`, html: CATALOG_ICONS[item.icon] || FALLBACK_ICON }),
      el("div", {},
        el("div", { class: "pn" }, item.name),
        el("div", { class: "pd" }, item.description || "")),
      el("div", { class: "cnt" }, item.file_size_text || ""));
  });

  const installBtn = el("button", { class: "btn primary", disabled: true }, "安装所选（0）");
  const skipBtn = el("button", {
    class: "btn",
    onclick: async () => {
      try { await api.saveLocalCache(ONBOARD_FLAG_KEY, true); } catch {}
      close();
    },
  }, "稍后再说");

  function syncBtn() {
    const n = picks.filter((p) => p.querySelector("input").checked).length;
    installBtn.disabled = n === 0;
    installBtn.textContent = `安装所选（${n}）`;
  }

  installBtn.addEventListener("click", async () => {
    const chosen = [];
    items.forEach((item, i) => {
      if (picks[i].querySelector("input").checked) chosen.push(item);
    });
    if (!chosen.length) return;
    installBtn.disabled = true;
    skipBtn.disabled = true;
    picks.forEach((p) => { p.querySelector("input").disabled = true; });
    let ok = 0;
    for (let i = 0; i < chosen.length; i++) {
      installBtn.textContent = `安装中 ${i + 1}/${chosen.length}…`;
      try {
        await installPlugin(chosen[i]);
        ok++;
      } catch (e) {
        toastErr(`「${chosen[i].name}」安装失败：${e?.message || e}`);
      }
    }
    try { await api.saveLocalCache(ONBOARD_FLAG_KEY, true); } catch {}
    close();
    if (ok) {
      toastOk(`已安装 ${ok} 个插件，入口已加入侧栏`);
      rerender();
    }
  });

  mask.append(
    el("div", { class: "modal onboarding" },
      el("h3", {}, "选择你要的功能"),
      el("p", { class: "hint" },
        "途变客户端采用插件化设计，核心只保留四个板块。勾选需要的功能插件，安装后即可在侧栏使用；之后随时可以在「插件市场」里安装或卸载。"),
      el("div", { class: "pick-list" }, ...picks),
      el("div", { class: "modal-actions" }, skipBtn, installBtn)));
  root.append(mask);
  requestAnimationFrame(() => mask.classList.add("show"));
}
