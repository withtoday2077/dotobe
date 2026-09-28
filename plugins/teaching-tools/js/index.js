// 教学工具插件入口：题库管理 + 真题上传（教师/管理员）
// Excel 解析与试卷包导入逻辑随包分发（excel_import.js / package_import.js）

import { renderQuestionbank } from "./questionbank.js";
import { renderUpload } from "./upload.js";

const ICON_BANK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 9l9-6 9 6M5 9v10M19 9v10M9 19v-6h6v6"/><path d="M3 21h18"/></svg>`;
const ICON_UPLOAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 20h16"/></svg>`;

export default {
  routes: [
    { name: "questionbank", render: renderQuestionbank, shell: "study",
      menu: { title: "题库管理", icon: ICON_BANK, order: 40 } },
    { name: "upload", render: renderUpload, shell: "study",
      menu: { title: "真题上传", icon: ICON_UPLOAD, order: 41 } },
  ],
};
