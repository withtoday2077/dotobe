// 题库管理（教师）：题型筛选 + 搜索 + 分页 + 编辑跳转 + 删除
// 数据：question_bank.php?action=list；删除：question.php?action=delete&id=N

import { api } from "api";
import { el, clear, loadingBox, errorBox, emptyBox, chip, pager, htmlToText, fmtScore, toastOk, toastErr, confirmModal, renderMathIn } from "ui";

const state = { page: 1, search: "", type: "", totalPages: 1 };

const TYPES = [
  ["single_choice", "单选题"], ["multiple_choice", "多选题"], ["true_false", "判断题"],
  ["fill_blank", "填空题"], ["short_answer", "简答题"], ["essay", "论述题"], ["material_analysis", "材料分析题"],
];

export async function renderQuestionbank(container) {
  const inner = el("div");
  container.append(inner);
  await draw(inner);
}

async function draw(inner) {
  clear(inner).append(loadingBox("正在加载题目…"));
  let env;
  try {
    env = await api.get("backend/api/question_bank.php", {
      action: "list",
      page: state.page,
      limit: 10,
      search: state.search,
      question_type: state.type,
    });
  } catch (e) {
    return clear(inner).append(errorBox(e.message, () => draw(inner)));
  }
  const data = env.data || {};
  const list = data.questions || data.list || [];
  state.totalPages = data.pagination?.total_pages ?? data.total_pages ?? 1;
  clear(inner);

  const kw = el("input", { class: "input", placeholder: "搜索题干…", style: "width:240px" });
  kw.value = state.search;
  kw.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { state.search = kw.value.trim(); state.page = 1; draw(inner); }
  });
  const selType = el("select", { class: "input" },
    el("option", { value: "" }, "全部题型"),
    ...TYPES.map(([v, t]) => el("option", { value: v, selected: v === state.type ? "" : undefined }, t)));
  selType.addEventListener("change", () => { state.type = selType.value; state.page = 1; draw(inner); });

  inner.append(el("div", { class: "toolbar-row" }, selType, kw));

  if (!list.length) {
    inner.append(emptyBox("没有符合条件的题目"));
    return;
  }

  for (const q of list) inner.append(qCard(q, inner));
  renderMathIn(inner); // 题干/选项里的公式（$...$ / \ce 化学式等）
  const pg = pager({ page: state.page, totalPages: state.totalPages, onGo: (p) => { state.page = p; draw(inner); } });
  if (pg) inner.append(pg);
}

function qCard(q, inner) {
  const content = htmlToText(q.content || "").slice(0, 120);
  const diffText = { 1: "简单", 2: "较易", 3: "中等", 4: "较难", 5: "困难" }[q.difficulty] || "";

  return el("div", { class: "card", style: "margin-bottom:var(--sp-2)" },
    el("div", { style: "display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap" },
      chip(q.type_name || typeName(q.question_type || q.type), "sky"),
      diffText ? chip(diffText, "warn") : null,
      q.subject ? chip(q.subject) : null,
      q.score !== undefined ? el("span", { style: "font-size:var(--fs-tiny);color:var(--text-3);margin-left:auto" }, `${fmtScore(q.score)} 分`) : null),
    el("div", { style: "line-height:1.9" }, content || "（空题干）"),
    el("div", { class: "ops", style: "display:flex;gap:10px;margin-top:12px" },
      el("button", { class: "btn sm danger", onclick: () =>
        confirmModal("删除题目", "删除后不可恢复，确定吗？", async () => {
          try {
            await api.get("backend/api/question.php", { action: "delete", id: q.id });
            toastOk("已删除");
            draw(inner);
          } catch (e) { toastErr(e.message); }
        }, "删除", "danger") }, "删除")));
}

function typeName(t) {
  const map = {
    single_choice: "单选题", multiple_choice: "多选题", true_false: "判断题",
    fill_blank: "填空题", short_answer: "简答题", essay: "论述题", material_analysis: "材料分析题",
  };
  return map[t] || t || "题目";
}
