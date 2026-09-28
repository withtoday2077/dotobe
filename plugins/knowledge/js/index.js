// 知识树插件入口

import { renderKnowledge } from "./knowledge.js";

const ICON_TREE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="12" cy="4" r="2.2"/><circle cx="6" cy="13" r="2.2"/><circle cx="18" cy="13" r="2.2"/><circle cx="12" cy="20" r="2.2"/><path d="M12 6.2v4M7 15.2l3.2 2.8M17 15.2l-3.2 2.8M8.2 13h7.6"/></svg>`;

export default {
  routes: [
    { name: "knowledge", render: renderKnowledge, shell: "study",
      menu: { title: "知识树", icon: ICON_TREE, order: 20 } },
  ],
};
