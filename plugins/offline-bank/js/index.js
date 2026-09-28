// 本地题库插件入口：离线试卷缓存 + 无网刷题

import { renderOffline } from "./offline.js";

const ICON_OFFLINE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M12 8a4 4 0 0 1 4 4M12 5a7 7 0 0 1 7 7"/></svg>`;

export default {
  routes: [
    { name: "offline", render: renderOffline, shell: "study",
      menu: { title: "本地题库", icon: ICON_OFFLINE, order: 30 } },
  ],
};
