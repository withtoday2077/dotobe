// 个人设置：基本资料 / 头像 / 密码 / 外观（浅色·深色）/ 服务器地址
// 数据：user_settings.php（GET 资料、update_info、change_password、update_avatar）

import { api } from "../api.js";
import { isAndroid, fileToB64 } from "../mobile.js";
import { el, clear, field, toastOk, toastErr, chip, confirmModal, b64Text } from "../ui.js";
import { go } from "../router.js";
import { roleLabel } from "./shell.js";
import { THEME_KEY, validateTheme, applyTheme, applyBuiltIn, persistTheme, themeTemplate } from "../theme.js";

const THEMES = [
  { id: "light", name: "日系清新 · 浅色", swatches: ["#fafaf8", "#64b5f6", "#98d8c8", "#ffb7c5"] },
  { id: "dark", name: "日系清新 · 深色", swatches: ["#1c1f26", "#64b5f6", "#7fc4b2", "#e5a3b1"] },
];

export async function renderSettings(container) {
  const layout = el("div", { class: "settings-layout" });
  const nav = el("div", { class: "settings-nav" });
  const panel = el("div", { class: "card settings-panel" });
  layout.append(nav, panel);
  container.append(layout);

  const tabs = [
    ["profile", "基本资料"], ["appearance", "外观"], ["password", "修改密码"], ["server", "服务器"],
    // Android：目录选择器不可用，存储位置管理为桌面专属
    ...(!isAndroid() ? [["storage", "存储"]] : []),
  ];
  let current = "profile";
  for (const [key, label] of tabs) {
    const b = el("button", { class: "nav-item" + (key === current ? " active" : ""), onclick: () => {
      current = key;
      nav.querySelectorAll(".nav-item").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      showTab(panel, key);
    } }, label);
    nav.append(b);
  }
  showTab(panel, "profile");
}

function showTab(panel, key) {
  clear(panel);
  if (key === "profile") profileTab(panel);
  else if (key === "appearance") appearanceTab(panel);
  else if (key === "password") passwordTab(panel);
  else if (key === "server") serverTab(panel);
  else storageTab(panel);
}

async function profileTab(panel) {
  panel.append(el("h2", {}, "基本资料"), el("p", { class: "lead", style: "color:var(--text-2);font-size:var(--fs-small);margin-bottom:var(--sp-3)" }, "头像与个人信息"));
  let info = {};
  try {
    // 后端按 $_GET['action'] 分发；响应为 {success, user}（无 data 包装）
    const env = await api.get("backend/api/user_settings.php", { action: "get_user_info" });
    info = env.user || env.data?.user || env.data || {};
  } catch (e) {
    panel.append(el("div", { class: "banner error" }, e.message));
  }

  // 头像
  const avatarUrl = info.avatar ? new URL(info.avatar, (await api.getConfig()).base_url).href : null;
  const img = avatarUrl
    ? el("img", { class: "avatar", src: avatarUrl })
    : el("div", { class: "avatar", style: "display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:1.6rem;font-weight:200" }, (info.full_name || info.username || "?").slice(0, 1));
  const filePick = el("input", { type: "file", accept: "image/*", style: "display:none" });
  filePick.addEventListener("change", async () => {
    // 桌面：WebView 出于安全不暴露文件路径，经 dialog 插件获取真实路径后走 Rust multipart
    // Android：直接用 file input 的 File 对象内存读取（跳过 dialog，content:// 路径 Rust 读不了）
    let filePath = null;
    if (!isAndroid()) {
      try {
        const { open } = window.__TAURI__.dialog;
        filePath = await open({
          multiple: false,
          filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
        });
      } catch { filePath = null; }
      filePath = Array.isArray(filePath) ? filePath[0] : filePath;
      if (!filePath) return;
    }
    try {
      // 两步头像更新（与 web 端一致）：先传文件拿路径，再提交路径
      let up;
      if (isAndroid()) {
        // file input 在 Android WebView 上直接唤起系统相册，change 事件里已有 File
        const f = filePick.files?.[0];
        if (!f) return;
        up = await api.uploadBytes("backend/api/upload_avatar.php", "avatar", f.name, await fileToB64(f), f.type);
      } else {
        up = await api.upload("backend/api/upload_avatar.php", "avatar", filePath, {});
      }
      const avatarPath = up?.data?.avatar_path;
      if (!avatarPath) throw new Error("上传响应缺少 avatar_path");
      await api.postJSON("backend/api/user_settings.php?action=update_avatar", { avatar_path: avatarPath });
      toastOk("头像已更新");
      renderSettingsTabAgain();
    } catch (e) { toastErr("头像上传：" + e.message); }
  });
  panel.append(el("div", { class: "avatar-row" },
    img,
    el("div", {},
      el("button", { class: "btn sm", onclick: () => filePick.click() }, "更换头像"),
      filePick),
    el("div", { style: "margin-left:auto;text-align:right" },
      el("div", { style: "font-weight:300" }, info.full_name || info.username || ""),
      el("div", { style: "font-size:var(--fs-tiny);color:var(--text-2)" }, `${info.username || ""} · ${roleLabel(info)}`))));

  const fullName = field("真实姓名", info.full_name || "");
  const email = field("邮箱", info.email || "");
  email.input.readOnly = true; // 后端安全策略：注册后邮箱不可改
  panel.append(el("div", { class: "fields" }, fullName, email));
  panel.append(el("div", { style: "margin-top:var(--sp-2)" },
    el("button", { class: "btn primary", onclick: async () => {
      try {
        await api.postJSON("backend/api/user_settings.php?action=update_info", {
          full_name: fullName.input.value.trim(),
        });
        toastOk("资料已保存");
      } catch (e) { toastErr(e.message); }
    } }, "保存资料")));
}

function renderSettingsTabAgain() {
  const content = document.querySelector(".content .page");
  if (content) import("./settings.js").then((m) => { clear(content); m.renderSettings(content); });
}

function appearanceTab(panel) {
  panel.append(el("h2", {}, "外观"),
    el("p", { class: "lead", style: "color:var(--text-2);font-size:var(--fs-small);margin-bottom:var(--sp-3)" }, "选择底色或导入主题包，即时生效"));
  const cur = localStorage.getItem(THEME_KEY) || "light";
  const list = el("div", { class: "theme-list" });
  for (const t of THEMES) {
    const active = t.id === cur;
    list.append(el("button", {
      class: "theme-card" + (active ? " active" : ""),
      onclick: () => {
        applyBuiltIn(t.id);
        persistTheme(t.id);
        toastOk(`已切换：${t.name}`);
        showTab(panel, "appearance");
      },
    },
      el("div", { class: "swatches" }, t.swatches.map((c) => el("i", { style: `background:${c}` }))),
      el("div", { class: "name" }, t.name, active ? " " : null),
      active ? el("div", { class: "badge-cur" }, "当前使用") : null));
  }
  panel.append(list);

  // —— 外观插件：用户导入的主题包 ——
  const customZone = el("div");
  panel.append(el("div", { style: "display:flex;gap:10px;align-items:center;margin:var(--sp-3) 0 8px" },
    el("h3", { style: "font-weight:300;margin:0" }, "已导入主题"),
    ...(!isAndroid() ? [
      el("button", { class: "btn sm", onclick: importThemePick }, "📥 导入主题"),
      el("button", { class: "btn sm ghost", onclick: exportTemplate }, "📤 导出主题模板")] : [])));
  panel.append(customZone);
  loadCustomThemes();

  async function loadCustomThemes() {
    let themes = [];
    try { themes = await api.listThemes(); } catch { /* 非 Tauri 环境静默 */ }
    clear(customZone);
    if (!themes.length) {
      customZone.append(el("p", { style: "color:var(--text-3);font-size:var(--fs-small)" },
        "还没有导入主题。选择 .json 主题包（可先「导出主题模板」了解格式）"));
      return;
    }
    const list2 = el("div", { class: "theme-list" });
    for (const t of themes) {
      const errs = validateTheme(t);
      const customId = `custom:${t.id}`;
      const active = cur === customId && !errs.length;
      const sw = (t.swatches && t.swatches.length ? t.swatches : ["var(--rice)", "var(--sky)", "var(--mint)", "var(--pink)"]);
      const card = el("button", {
        class: "theme-card" + (active ? " active" : ""),
        onclick: () => {
          if (errs.length) return toastErr(`主题包校验失败：${errs[0]}`);
          applyTheme(t);
          persistTheme(customId);
          toastOk(`已切换：${t.name}`);
          showTab(panel, "appearance");
        },
      },
        el("div", { class: "swatches" }, sw.slice(0, 4).map((c) => el("i", { style: `background:${c}` }))),
        el("div", { class: "name" },
          `${t.name}${t.mode === "dark" ? " · 深色" : ""}`, active ? " " : null),
        active ? el("div", { class: "badge-cur" }, "当前使用") : null,
        errs.length ? el("div", { class: "badge-cur", style: "background:var(--danger-t);color:var(--danger)" }, "校验失败") : null);
      // 删除角标（阻止冒泡，不触发选中）
      card.append(el("span", { class: "theme-del", title: "删除此主题", onclick: (ev) => {
        ev.stopPropagation();
        confirmModal("删除主题", `确定删除主题「${t.name}」吗？（不影响其他数据）`, async () => {
          try {
            await api.deleteTheme(t.id);
            if (localStorage.getItem(THEME_KEY) === customId) {
              localStorage.removeItem(THEME_KEY);
              applyBuiltIn("light");
            }
            toastOk("已删除");
            showTab(panel, "appearance");
          } catch (e) { toastErr(e.message || String(e)); }
        }, "删除", "danger");
      } }, "×"));
      list2.append(card);
    }
    customZone.append(list2);
  }

  async function importThemePick() {
    let filePath;
    try {
      const { open } = window.__TAURI__.dialog;
      // 品牌后缀 .dtheme 为主，兼容 .json
      filePath = await open({ multiple: false, filters: [{ name: "途变主题包", extensions: ["dtheme", "json"] }] });
    } catch (e) {
      return toastErr("打开文件选择器失败：" + e.message);
    }
    filePath = Array.isArray(filePath) ? filePath[0] : filePath;
    if (!filePath) return;
    let theme;
    try {
      theme = await api.importTheme(filePath);
    } catch (e) {
      return toastErr("导入失败：" + (e.message || String(e)));
    }
    const errs = validateTheme(theme);
    if (errs.length) {
      // 已落盘但校验不过：立即清理，避免重启后进列表
      try { await api.deleteTheme(theme.id); } catch {}
      return toastErr(`主题包校验失败：${errs[0]}`);
    }
    toastOk(`已导入：${theme.name}`);
    showTab(panel, "appearance");
  }

  async function exportTemplate() {
    try {
      await api.exportFile("我的主题.dtheme", b64Text(themeTemplate()), "途变主题包", ["dtheme"]);
      toastOk("模板已导出，按说明填好后即可导入");
    } catch (e) {
      toastErr("导出失败：" + (e.message || String(e)));
    }
  }
}

function passwordTab(panel) {
  panel.append(el("h2", {}, "修改密码"));
  const oldP = field("当前密码", "", { type: "password" });
  const newP = field("新密码（至少 6 位）", "", { type: "password" });
  const cf = field("确认新密码", "", { type: "password" });
  panel.append(el("div", { class: "fields" }, oldP, newP, cf));
  panel.append(el("div", { style: "margin-top:var(--sp-2)" },
    el("button", { class: "btn primary", onclick: async () => {
      try {
        if (newP.input.value !== cf.input.value) throw new Error("两次输入的新密码不一致");
        await api.postJSON("backend/api/user_settings.php?action=change_password", {
          old_password: oldP.input.value,
          new_password: newP.input.value,
        });
        toastOk("密码已修改");
        oldP.input.value = newP.input.value = cf.input.value = "";
      } catch (e) { toastErr(e.message); }
    } }, "修改密码")));
}

async function serverTab(panel) {
  panel.append(el("h2", {}, "服务器"),
    el("p", { class: "lead", style: "color:var(--text-2);font-size:var(--fs-small);margin-bottom:var(--sp-3)" }, "，可更换私人地址。（官方地址：https://www.dotobe.cn）"));
  const cfg = await api.getConfig();
  const url = field("服务器地址", cfg.base_url);
  panel.append(el("div", { class: "fields" }, url));
  panel.append(el("div", { style: "margin-top:var(--sp-2);display:flex;gap:12px" },
    el("button", { class: "btn primary", onclick: async () => {
      await api.setBaseUrl(url.input.value.trim());
      toastOk("已保存，即将返回登录页");
      await api.clearCookies();
      go("login");
    } }, "保存并重新登录"),
    el("button", { class: "btn danger", onclick: () =>
      confirmModal("清除本地会话", "将清除本机保存的登录凭据（不影响服务器数据）。", async () => {
        await api.clearCookies();
        toastOk("已清除");
      }, "清除", "danger") }, "清除登录凭据")));
}

// 存储：数据目录位置（便携/自定义/默认）查看与迁移
async function storageTab(panel) {
  panel.append(el("h2", {}, "数据存储"),
    el("p", { class: "lead", style: "color:var(--text-2);font-size:var(--fs-small);margin-bottom:var(--sp-3)" },
      "客户端数据（登录会话、缓存试卷、刷题进度、知识树缓存）的保存位置"));

  const infoBox = el("div");
  panel.append(infoBox);

  async function load() {
    let loc;
    try {
      loc = await api.getDataLocation();
    } catch (e) {
      infoBox.textContent = "";
      infoBox.append(el("div", { class: "banner error" }, "读取存储位置失败：" + e.message));
      return;
    }
    infoBox.textContent = "";
    const mode = loc.portable ? chip("便携模式", "mint") : (loc.custom ? chip("自定义位置", "sky") : chip("系统默认", ""));
    infoBox.append(el("div", { class: "card", style: "padding:14px" },
      el("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" },
        el("div", { style: "flex:1;min-width:240px" },
          el("div", { style: "font-size:var(--fs-tiny);color:var(--text-3);letter-spacing:.08em" }, "当前位置"),
          el("div", { style: "font-family:Consolas,monospace;font-size:var(--fs-small);word-break:break-all;margin-top:4px" }, String(loc.current))),
        mode),
      el("div", { style: "display:flex;gap:10px;margin-top:12px" },
        loc.portable ? el("span", { style: "font-size:var(--fs-tiny);color:var(--text-3);align-self:center" },
          "数据固定存于 exe 旁的 data 文件夹（随 exe 移动，便携使用）") : null,
        loc.portable ? null : el("button", { class: "btn sm", onclick: changeLocation }, "更改位置…"),
        loc.portable || !loc.custom ? null : el("button", { class: "btn sm ghost", onclick: resetLocation }, "恢复默认"))));

    infoBox.append(el("div", { class: "banner info", style: "margin-top:var(--sp-2)" },
      "便携模式：在 exe 同目录新建名为 data 的文件夹后重启客户端。"));
  }

  async function changeLocation() {
    let dir;
    try {
      const { open } = window.__TAURI__.dialog;
      dir = await open({ multiple: false, directory: true });
    } catch (e) {
      return toastErr("打开文件夹选择器失败：" + e.message);
    }
    dir = Array.isArray(dir) ? dir[0] : dir;
    if (!dir) return;
    confirmModal("迁移存储位置",
      `将把全部客户端数据迁移到：\n${dir}\n原位置的数据将被移除（登录凭据加密不变，仍仅限本机本账户可用）。确定继续？`,
      async () => {
        try {
          const r = await api.setDataLocation(dir);
          toastOk("存储位置已更新：" + (r?.current || dir));
          load();
        } catch (e) {
          toastErr("迁移失败：" + e.message);
        }
      }, "迁移");
  }

  async function resetLocation() {
    confirmModal("恢复默认存储位置",
      "将把数据迁回系统默认位置（AppData\Roaming\DotobeClientWeb）。确定继续？",
      async () => {
        try {
          await api.setDataLocation(null);
          toastOk("已恢复默认位置");
          load();
        } catch (e) {
          toastErr("恢复失败：" + e.message);
        }
      }, "恢复");
  }

  load();
}
