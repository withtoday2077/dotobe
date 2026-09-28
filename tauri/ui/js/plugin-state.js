// 插件运行时状态（枢纽模块）：plugin-loader 写入，shell/main/router/market 读取。
// 刻意不 import shell/router，避免与它们的相互依赖成环。
//
// 数据形态：
//   active: Map<id, { manifest, def, cssLinks: string[] }>
//     manifest —— 包内 manifest.json（id/name/version/icon/…）
//     def      —— 入口模块 default 导出（routes / footerButton / shellKind）

const active = new Map();

/** 激活一个插件（loader 在 import 成功、路由注册完毕后调用） */
export function registerActivePlugin(id, info) {
  active.set(id, info);
}

/** 停用一个插件 */
export function unregisterPlugin(id) {
  active.delete(id);
}

/** 是否已激活（供核心页门控交叉入口，如答题完成的"查看成绩"） */
export function isPluginActive(id) {
  return active.has(id);
}

/** 所有已激活插件信息（按 id 排序，保证菜单顺序稳定） */
export function getActivePlugins() {
  return [...active.values()].sort((a, b) =>
    (a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0));
}

/**
 * 学习壳侧栏的插件菜单项（展平各插件 routes 中带 menu 的 study 项，按 order 排序）。
 * icon 直接是插件提供的内联 SVG 字符串。
 */
export function pluginMenuEntries() {
  const list = [];
  for (const info of active.values()) {
    for (const r of info.def?.routes || []) {
      if (r.menu && (r.shell ?? "study") === "study") {
        list.push({
          page: r.name,
          title: r.menu.title,
          iconSvg: r.menu.icon,
          order: r.menu.order ?? 500,
        });
      }
    }
  }
  return list.sort((a, b) => a.order - b.order);
}

/** 学习壳侧栏底部的插件入口按钮（如公会），可能为空数组 */
export function pluginFooterButtons() {
  const list = [];
  for (const info of active.values()) {
    const fb = info.def?.footerButton;
    if (fb && fb.title && fb.route) list.push(fb);
  }
  return list;
}

/** 取插件注册的独立壳配置（如公会 shellKind），未安装返回 null */
export function getShellKind(kind) {
  for (const info of active.values()) {
    const sk = info.def?.shellKind;
    if (sk && sk.kind === kind) return sk;
  }
  return null;
}

/**
 * 已知插件路由表（随客户端内置，供"插件未安装"兜底提示）。
 * 上架全新插件时在下次客户端发版补一行即可；未收录的路由走通用"页面不存在"。
 */
const KNOWN_PLUGIN_ROUTES = {
  in_progress: "学习记录", history: "学习记录", review: "学习记录", wrongbook: "学习记录",
  knowledge: "知识树",
  offline: "本地题库",
  questionbank: "教学工具", upload: "教学工具",
  "guild/hall": "冒险公会", "guild/publish": "冒险公会", "guild/mytasks": "冒险公会",
  "guild/stories": "冒险公会", "guild/write": "冒险公会", "guild/myarticles": "冒险公会",
  "guild/adventurer": "冒险公会", "guild/team": "冒险公会", "guild/team-detail": "冒险公会",
};

/**
 * 路由名 → 所属插件名（router 命中未注册路由时的兜底提示用）。
 * 支持前缀匹配（如 guild/team-detail/5 → 冒险公会）。未知返回 null。
 */
export function knownRoutePlugin(routeName) {
  if (!routeName) return null;
  if (KNOWN_PLUGIN_ROUTES[routeName]) return KNOWN_PLUGIN_ROUTES[routeName];
  // 去尾参最长前缀：guild/team-detail/5 → guild/team-detail → guild/team
  const segs = routeName.split("/");
  for (let i = segs.length; i >= 1; i--) {
    const cand = segs.slice(0, i).join("/");
    if (KNOWN_PLUGIN_ROUTES[cand]) return KNOWN_PLUGIN_ROUTES[cand];
  }
  return null;
}
