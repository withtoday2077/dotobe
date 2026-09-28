// 插件加载器：
//   activateAll()      启动时激活本地已安装插件（asset 协议动态 import + 路由注册 + CSS 注入）
//   deactivate(id)     停用（摘路由 + 摘 CSS + 清状态），不删文件
//   installPlugin()    市场「安装/更新」：Rust 下载（SHA-256 校验）→ 解压 → 激活 → 重建壳
//   uninstallPlugin()  市场卸载：停用 + 删除本地目录
// 单个插件加载失败只提示不阻断启动。

import { api } from "./api.js";
import { register, unregister } from "./router.js";
import { registerActivePlugin, unregisterPlugin, getActivePlugins } from "./plugin-state.js";
import { invalidateShell } from "./pages/shell.js";
import { toastErr } from "./ui.js";

const tauriCore = (typeof window !== "undefined" && window.__TAURI__)?.core;
const invoke = tauriCore?.invoke?.bind(tauriCore);
const convertFileSrc = tauriCore?.convertFileSrc?.bind(tauriCore);

/**
 * 数据目录文件的 asset 协议 URL。
 * 注意不能用 convertFileSrc 的返回值直接做模块动态导入：它对整段路径做
 * encodeURIComponent（斜杠变 %2F），WebView 的模块加载器拒绝含 %2F 的 URL
 * （fetch/<link> 不受影响）。这里只借它推导平台相关的 origin（Windows 为
 * http://asset.localhost，Android 为 https://asset.localhost），路径部分
 * 以未编码的正斜杠拼接。
 */
export function toAssetUrl(path) {
  const norm = String(path).replace(/\\/g, "/").replace(/\/+$/, "");
  try {
    const { origin } = new URL(convertFileSrc("/__probe__"));
    return `${origin}/${norm.replace(/^\/+/, "")}`;
  } catch {
    return convertFileSrc(path);
  }
}

/** 数据目录下的 plugins 根（便携/重定向/默认三态由 Rust 决定，前端只读定位结果） */
async function pluginsRoot() {
  const loc = await api.getDataLocation();
  return `${String(loc?.current || "").replace(/[\\/]+$/, "")}/plugins`;
}

/** 激活单个插件：动态 import 入口 → 注册路由 → 注入 CSS → 记入状态 */
async function activate(manifest) {
  if (!invoke || !convertFileSrc) throw new Error("仅在客户端环境可加载插件");
  if (!manifest?.id || !manifest.entry) throw new Error("manifest 不完整");
  const dir = `${await pluginsRoot()}/${manifest.id}`;
  const entryUrl = toAssetUrl(`${dir}/${manifest.entry}`);
  const mod = await import(entryUrl);
  const def = mod?.default;
  if (!def || !Array.isArray(def.routes) || def.routes.length === 0) {
    throw new Error("入口模块缺少 default.routes");
  }
  for (const r of def.routes) {
    if (!r?.name || typeof r?.render !== "function") continue;
    register(r.name, r.render, { shell: r.shell ?? "study", noShell: !!r.noShell });
  }
  const cssLinks = [];
  for (const href of manifest.css || []) {
    const linkId = `plugin-css-${manifest.id}-${cssLinks.length}`;
    if (!document.getElementById(linkId)) {
      const link = document.createElement("link");
      link.id = linkId;
      link.rel = "stylesheet";
      link.href = toAssetUrl(`${dir}/${href}`);
      document.head.appendChild(link);
    }
    cssLinks.push(linkId);
  }
  registerActivePlugin(manifest.id, { manifest, def, cssLinks });
}

/** 停用单个插件（不删文件；卸载与更新替换前调用） */
async function deactivate(id) {
  const info = getActivePlugins().find((p) => p.manifest.id === id);
  if (!info) return;
  for (const r of info.def?.routes || []) {
    if (r?.name) unregister(r.name);
  }
  for (const linkId of info.cssLinks || []) {
    document.getElementById(linkId)?.remove();
  }
  unregisterPlugin(id);
}

/** 启动激活：main.js 在 startRouter 前 await（纯本地，毫秒级） */
export async function activateAll() {
  if (!invoke) return; // 浏览器直开（无 Tauri）时静默跳过
  let manifests = [];
  try {
    manifests = (await invoke("plugin_list_installed")) || [];
  } catch {
    return; // 数据目录不可读等异常：不阻塞启动
  }
  for (const m of manifests) {
    try {
      await activate(m);
    } catch (e) {
      toastErr(`插件「${m.name || m.id}」加载失败：${e?.message || e}`);
    }
  }
}

/**
 * 市场安装/更新。item 为目录 API 条目（key/version/sha256/download_url）。
 * 返回安装后的 manifest。调用方负责随后 invalidateShell + 刷新页面。
 */
export async function installPlugin(item) {
  if (!invoke) throw new Error("仅在客户端环境可安装插件");
  const wasActive = getActivePlugins().some((p) => p.manifest.id === item.key);
  if (wasActive) await deactivate(item.key); // 更新：先停旧再装新
  const dl = await invoke("plugin_download", { path: item.download_url, sha256: item.sha256 || null });
  const manifest = await invoke("plugin_install", { tmpPath: dl.path });
  if (manifest.id !== item.key) {
    // 包内 id 与目录不符（服务端上架错误）：立即回滚
    await invoke("plugin_uninstall", { id: manifest.id }).catch(() => {});
    throw new Error(`包内插件标识（${manifest.id}）与目录（${item.key}）不符`);
  }
  await activate(manifest);
  invalidateShell();
  return manifest;
}

/** 市场卸载：停用 + 删除本地目录（服务端数据与本地缓存不受影响） */
export async function uninstallPlugin(id) {
  if (!invoke) throw new Error("仅在客户端环境可卸载插件");
  await deactivate(id);
  await invoke("plugin_uninstall", { id });
  invalidateShell();
}
