// 真题上传（教师）：Excel(.xlsx/.xls) 与试卷包(.zip) 两条导入线
// Excel：选择本地文件 → 客户端解析预览 → 填元信息 → excel_import.php 建卷（解析逻辑在 excel_import.js，与 Web 端 excel-handler.js 同格式）
// 试卷包：选择 .zip → 校验 exam.json + 逐张上传包内图片 → excel_import.php 建卷（逻辑在 package_import.js，对齐 Web package-io.js）

import { api } from "api";
import { el, clear, field, chip, toastOk, toastErr, fmtScore } from "ui";
import { go } from "router";
import { isAndroid, pickFiles } from "mobile";
import {
  parseWorkbook, computeTotalScore, buildTemplateWorkbook, workbookToBase64, TYPE_CHINESE,
} from "./excel_import.js";
import { importPackageFromBase64 } from "./package_import.js";

let previewZone = null;

export async function renderUpload(container) {
  const card = el("div", { class: "card", style: "max-width:860px" });
  container.append(card);

  card.append(
    el("h2", {}, "真题上传"),
    el("p", { style: "color:var(--text-2);font-size:var(--fs-small);margin:8px 0 var(--sp-3)" },
      "选择本地 Excel 模板（.xlsx/.xls）或试卷包（.zip），客户端将解析并预览，确认后导入创建试卷。如需创建自定义题库，请移动至官网处理。"));

  const dlBtn = isAndroid() ? null : el("button", { class: "btn ghost", onclick: downloadTemplate }, "下载 Excel 模板"); // Android：导出走不了 content://
  const pickBtn = el("button", { class: "btn primary", onclick: pickAndParse }, "选择 Excel 文件");
  const pickZipBtn = el("button", { class: "btn", onclick: pickZipAndImport }, "导入试卷包（.zip）");
  previewZone = el("div", { style: "margin-top:var(--sp-3)" });
  card.append(
    el("div", { style: "display:flex;gap:12px;align-items:center;flex-wrap:wrap" },
      pickBtn, pickZipBtn, dlBtn,
      el("span", { style: "font-size:var(--fs-tiny);color:var(--text-3)" },
        "Excel 支持 试卷信息 + 单选/多选/判断/填空/简答/材料分析 工作表；试卷包来自官网编辑器「导出试卷包」")),
    previewZone);

  async function downloadTemplate() {
    try {
      const b64 = workbookToBase64(buildTemplateWorkbook());
      await api.exportFile("Excel导入模板.xlsx", b64);
      toastOk("模板已生成（含全部题型示例）");
    } catch (e) {
      toastErr("模板下载失败：" + (e?.message || e));
    }
  }

  async function pickZipAndImport() {
    let b64, fileName;
    if (isAndroid()) {
      // Android：file input 直读内存（content:// 路径 Rust 读不了）
      const [it] = await pickFiles({ accept: ".zip", read: "b64" });
      if (!it) return;
      b64 = it.b64;
      fileName = it.name || "试卷包.zip";
    } else {
      let filePath;
      try {
        const { open } = window.__TAURI__.dialog;
        filePath = await open({ multiple: false, filters: [{ name: "试卷包", extensions: ["zip"] }] });
      } catch (e) {
        return toastErr("打开文件选择器失败：" + e.message);
      }
      filePath = Array.isArray(filePath) ? filePath[0] : filePath;
      if (!filePath) return;
      fileName = String(filePath).split(/[\\/]/).pop() || "试卷包.zip";
      try {
        b64 = await api.readFileBase64(filePath);
      } catch (e) {
        return toastErr("读取文件失败：" + String(e?.message || e));
      }
    }

    clear(previewZone).append(el("div", { class: "banner info" }, `正在读取试卷包：${fileName}…`));
    try {
      const result = await importPackageFromBase64(b64, (cur, total, name) => {
        clear(previewZone).append(el("div", { class: "banner info" },
          total > 1 ? `正在上传包内图片 ${cur}/${total}：${name}…` : `正在读取试卷包：${fileName}…`));
      });
      clear(previewZone).append(el("div", { class: "banner ok" },
        `试卷包导入成功：${result.title}，共 ${result.count} 道题、${result.images} 张图片，正在跳转…`));
      toastOk("试卷包导入成功");
      go("mybank");
    } catch (e) {
      clear(previewZone).append(el("div", { class: "banner error" },
        "试卷包导入失败：" + (e?.message || e)));
      toastErr("试卷包导入失败：" + (e?.message || e));
    }
  }

  async function pickAndParse() {
    let b64;
    let filePath = ""; // 选中文件的路径/文件名（Android 只有文件名），供预览标题使用
    if (isAndroid()) {
      // Android：file input 直读内存（content:// 路径 Rust 读不了）
      const [it] = await pickFiles({ accept: ".xlsx,.xls", read: "b64" });
      if (!it) return;
      b64 = it.b64;
      filePath = it.name || "Excel 文件";
    } else {
      try {
        const { open } = window.__TAURI__.dialog;
        filePath = await open({ multiple: false, filters: [{ name: "Excel 工作簿", extensions: ["xlsx", "xls"] }] });
      } catch (e) {
        return toastErr("打开文件选择器失败：" + e.message);
      }
      filePath = Array.isArray(filePath) ? filePath[0] : filePath;
      if (!filePath) return;
      try {
        b64 = await api.readFileBase64(filePath);
      } catch (e) {
        return toastErr("读取文件失败：" + String(e?.message || e));
      }
    }

    let workbook;
    try {
      workbook = XLSX.read(b64, { type: "base64" });
    } catch (e) {
      return toastErr("Excel 解析失败，请确认是有效的 .xlsx 文件：" + e.message);
    }

    const { exam, questions } = parseWorkbook(workbook);
    if (!questions.length) {
      return toastErr("未从工作簿解析到任何题目（请检查题型工作表）");
    }
    showPreview(exam, questions, filePath);
  }
}

function showPreview(exam, questions, filePath) {
  clear(previewZone);
  const totalScore = computeTotalScore(questions);

  // 题型分布（材料分析题计 1 道，分值取子小题合计）
  const dist = new Map();
  for (const q of questions) {
    const name = TYPE_CHINESE[q.type] || q.type;
    dist.set(name, (dist.get(name) || 0) + 1);
  }

  const meta = el("div", { class: "grid cols-3", style: "margin-bottom:var(--sp-3)" },
    el("div", { class: "card stat sky" }, el("div", { class: "label" }, "题目总数"), el("div", { class: "value" }, String(questions.length))),
    el("div", { class: "card stat mint" }, el("div", { class: "label" }, "合计分值"), el("div", { class: "value" }, fmtScore(totalScore))),
    el("div", { class: "card stat pink" },
      el("div", { class: "label" }, "题型分布"),
      el("div", { style: "margin-top:6px;display:flex;flex-wrap:wrap;gap:6px" },
        [...dist.entries()].map(([k, v]) => chip(`${k}×${v}`, "sky")))));

  const title = field("试卷标题", exam.title || "导入试卷");
  const description = field("试卷描述（可选）", exam.description || "", { textarea: true });
  const subject = field("科目", exam.subject || "");
  const grade = field("年级", exam.grade || "");
  const duration = field("时长（分钟）", String(exam.time_limit ?? 60));
  const passing = field("及格分", String(exam.passing_score ?? Math.ceil(totalScore * 0.6)));
  const tags = field("标签（逗号分隔）", exam.tags || "");
  const diffSelect = el("select", { class: "input", style: "width:auto" },
    ...[["easy", "简单"], ["medium", "中等"], ["hard", "困难"]].map(([v, t]) =>
      el("option", { value: v, selected: (exam.difficulty_label || exam.difficulty) === t || v === "medium" ? "" : undefined }, t)));

  const importBtn = el("button", { class: "btn primary", style: "margin-top:var(--sp-2)", onclick: async () => {
    importBtn.disabled = true;
    importBtn.textContent = "导入中…";
    try {
      if (!title.input.value.trim()) return toastErr("请填写试卷标题");
      if (!subject.input.value.trim()) return toastErr("请填写科目");
      const env = await api.postJSON("backend/api/excel_import.php", {
        exam_data: {
          title: title.input.value.trim(),
          description: description.input.value.trim(),
          subject: subject.input.value.trim(),
          grade: grade.input.value.trim() || "other",
          type: exam.type || "exam",
          difficulty: diffSelect.value,
          total_score: totalScore,
          time_limit: Number(duration.input.value) || 60,
          passing_score: Number(passing.input.value) || Math.ceil(totalScore * 0.6),
          tags: tags.input.value.trim(),
          questions,
        },
        images: [],
      });
      toastOk(env.message || "试卷导入成功");
      go("mybank");
    } catch (e) {
      importBtn.disabled = false;
      importBtn.textContent = "导入创建试卷";
      toastErr("导入失败：" + e.message);
    }
  } }, "导入创建试卷");

  previewZone.append(
    el("h3", { style: "margin-bottom:12px" }, `预览 · ${filePath.split(/[\\/]/).pop()}`),
    meta,
    el("div", { class: "fields", style: "display:flex;flex-direction:column;gap:var(--sp-2);max-width:640px;margin-bottom:var(--sp-3)" },
      title, description, subject, grade, duration, passing, tags,
      (() => { const w = el("div", { class: "field" }); w.append(diffSelect, el("label", { style: "font-size:var(--fs-tiny);color:var(--text-3);letter-spacing:0.12em" }, "难度")); return w; })()),
    importBtn);
}