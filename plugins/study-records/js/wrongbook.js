// 错题本：筛选 + 错题卡（题目/答案对照/解析）+ 标记掌握 / 删除
// 数据：wrong_questions/list.php、toggle_mastered.php、delete.php

import { api } from "api";
import { el, clear, loadingBox, errorBox, emptyBox, chip, pager, htmlToText, fmtScore, confirmModal, toastOk, renderMathIn } from "ui";

const state = { page: 1, type: "", mastered: "", totalPages: 1 };

export async function renderWrongbook(container) {
  const inner = el("div");
  container.append(inner);
  await draw(inner);
}

async function draw(inner) {
  clear(inner).append(loadingBox("正在加载错题本…"));
  let env;
  try {
    env = await api.get("backend/api/wrong_questions/list.php", {
      page: state.page,
      question_type: state.type,
      is_mastered: state.mastered,
    });
  } catch (e) {
    return clear(inner).append(errorBox(e.message, () => draw(inner)));
  }
  const data = env.data || {};
  const list = data.questions || [];
  state.totalPages = data.pagination?.pages ?? data.pagination?.total ?? 1;
  clear(inner);

  // 筛选行（接口参数：question_type / mastered）
  const selType = el("select", { class: "input" },
    el("option", { value: "" }, "全部题型"),
    ...["single_choice", "multiple_choice", "true_false", "fill_blank", "short_answer", "material_analysis"].map((t) =>
      el("option", { value: t, selected: t === state.type ? "" : undefined }, typeName(t))));
  selType.addEventListener("change", () => { state.type = selType.value; state.page = 1; draw(inner); });
  const selMastered = el("select", { class: "input" },
    el("option", { value: "" }, "全部状态"),
    el("option", { value: "0", selected: state.mastered === "0" ? "" : undefined }, "未掌握"),
    el("option", { value: "1", selected: state.mastered === "1" ? "" : undefined }, "已掌握"));
  selMastered.addEventListener("change", () => { state.mastered = selMastered.value; state.page = 1; draw(inner); });
  inner.append(el("div", { class: "toolbar-row" }, selType, selMastered));

  if (!list.length) {
    inner.append(emptyBox("错题本是空的", "做错的题目会自动收录到这里"));
    return;
  }

  for (const w of list) inner.append(wrongCard(w, inner));
  renderMathIn(inner); // 题干/选项/答案里的公式（$...$ / \ce 化学式等）
  const pg = pager({ page: state.page, totalPages: state.totalPages, onGo: (p) => { state.page = p; draw(inner); } });
  if (pg) inner.append(pg);
}

function wrongCard(w, inner) {
  const q = w.question || w;
  // list.php 真实字段：mastered_at / wrong_answer / correct_answer / wrong_count / question_type
  const mastered = !!(q.mastered_at ?? q.is_mastered);

  const card = el("div", { class: "card wrong-card", style: "margin-bottom:var(--sp-2)" });
  card.append(el("div", { class: "q-head" },
    chip(q.type_name || typeName(q.question_type), "sky"),
    mastered ? chip("已掌握", "mint") : chip("未掌握", "warn"),
    q.wrong_count ? chip(`错 ${q.wrong_count} 次`, "pink") : null,
    q.last_wrong_at ? el("span", { style: "font-size:var(--fs-tiny);color:var(--text-3);margin-left:auto" }, `最近做错：${String(q.last_wrong_at).slice(0, 10)}`) : null,
  ));
  card.append(el("div", { class: "q-content" }, htmlToText(q.content)));

  const opts = Array.isArray(q.options) ? q.options : [];
  if (opts.length) {
    const L = "ABCDEFGH";
    opts.forEach((opt, i) => card.append(el("div", { style: "display:flex;gap:10px;font-size:var(--fs-small);color:var(--text-2)" },
      el("span", { class: "letter" }, `${L[i]}.`), el("span", {}, htmlToText(typeof opt === "string" ? opt : opt?.text ?? "")))));
  }

  card.append(answerLine("正确答案", q.correct_answer ?? q.answer, "ok"));
  if (q.wrong_answer !== undefined && q.wrong_answer !== null) card.append(answerLine("我的答案", q.wrong_answer, "warn"));
  const exp = htmlToText(q.explanation || "");
  if (exp) card.append(el("div", { class: "explain" }, "解析：", exp));

  // 删除/标记掌握接口要的是错题记录 ID（wq.id），参数名 id；is_mastered 必传
  const rid = w.id ?? q.id;
  card.append(el("div", { class: "ops" },
    el("button", { class: "btn sm", onclick: async () => {
      try {
        await api.post("backend/api/wrong_questions/toggle_mastered.php", { id: rid, is_mastered: mastered ? 0 : 1 });
        toastOk(mastered ? "已标记为未掌握" : "已标记为掌握");
        draw(inner);
      } catch (e) { toastErr(e.message); }
    } }, mastered ? "取消掌握" : "标记掌握"),
    el("button", { class: "btn sm danger", onclick: () =>
      confirmModal("删除错题", "删除后将无法恢复，确定吗？", async () => {
        await api.post("backend/api/wrong_questions/delete.php", { id: rid });
        toastOk("已删除");
        draw(inner);
      }, "删除", "danger") }, "删除")
  ));
  return card;
}

function answerLine(label, val, tone) {
  return el("div", { class: "answer-line" }, `${label}：`, el("span", { class: tone }, answerText(val)));
}

function answerText(v) {
  if (v === null || v === undefined) return "未作答";
  if (Array.isArray(v)) {
    const L = "ABCDEFGH";
    return v.map((x) => (typeof x === "number" ? L[x] ?? String(x) : String(x))).join("、") || "未作答";
  }
  if (typeof v === "number") {
    const L = "ABCDEFGH";
    return L[v] ?? String(v);
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function typeName(t) {
  const map = {
    single_choice: "单选题", multiple_choice: "多选题", true_false: "判断题",
    fill_blank: "填空题", short_answer: "简答题", material_analysis: "材料分析题",
    essay: "论述题", calculation: "计算题",
  };
  return map[t] || t || "题目";
}
