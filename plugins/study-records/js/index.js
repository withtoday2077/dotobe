// 学习记录插件入口：进行中考试 + 历史成绩 + 错题本（含成绩回顾子页）
// 核心约定：default export 的 routes 由 plugin-loader 注册到路由表；
// menu.icon 直接给出内联 SVG（shell 渲染时无需查核心图标表）。

import { renderInProgress } from "./in_progress.js";
import { renderHistory } from "./history.js";
import { renderReview } from "./review.js";
import { renderWrongbook } from "./wrongbook.js";

const ICON_HISTORY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`;
const ICON_WRONGBOOK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M12 3l9 16H3l9-16z"/><path d="M12 10v4M12 17h.01"/></svg>`;

export default {
  routes: [
    { name: "in_progress", render: renderInProgress, shell: "study",
      menu: { title: "进行中考试", icon: ICON_HISTORY, order: 10 } },
    { name: "history", render: renderHistory, shell: "study",
      menu: { title: "历史成绩", icon: ICON_HISTORY, order: 11 } },
    { name: "review", render: renderReview, shell: "study" }, // 历史成绩的回顾子页，无菜单
    { name: "wrongbook", render: renderWrongbook, shell: "study",
      menu: { title: "错题本", icon: ICON_WRONGBOOK, order: 12 } },
  ],
};
