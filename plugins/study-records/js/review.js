// 结果回顾：成绩头卡 + 逐题（判定/你的答案/正确答案/解析）
// exam.php?action=review&exam_id=X&record_id=Y 顶层平铺：
// { success, exam:{..., questions_json:"[{id,type,score,answer,content,options,type_name,explanation,sub_questions}]", total_score },
//   record:{ answers:"{qid:答案}", score, ... } }

import { api } from "api";
import { el, clear, loadingBox, errorBox, chip, fmtScore, htmlToText, renderMathIn } from "ui";
import { go } from "router";

const LETTER = "ABCDEFGH";

export async function renderReview(container, param) {
  const [examId, recordId] = param.split(",").map(Number);
  clear(container).append(loadingBox("正在加载回顾…"));
  let env;
  try {
    env = await api.get("backend/api/exam.php", {
      action: "review",
      exam_id: examId || "",
      record_id: recordId || "",
    });
  } catch (e) {
    return clear(container).append(errorBox(e.message, () => renderReview(container, param)));
  }
  clear(container);

  // 顶层平铺（兼容 data 信封）
  const top = env.data && env.data.exam ? env.data : env;
  const exam = top.exam || {};
  const record = top.record || {};

  // 解析试卷与用户答案
  let questions = parseQuestions(exam.questions_json);
  let userAnswers = parseAnswers(record.answers);
  if (!questions.length && Array.isArray(top.questions)) questions = top.questions.map(normalizeQ);
  const totalScore = Number(exam.total_score ?? record.total_score ?? 0) || 100;
  const score = Number(record.score ?? 0);

  // 头卡（通过线按及格 60%）
  const pct = totalScore > 0 ? (score / totalScore) * 100 : 0;
  const passed = pct >= 60;
  container.append(
    el("div", { class: "result-hero" },
      el("div", { class: `verdict ${passed ? "pass" : "fail"}` }, passed ? "✔ 恭喜通过" : "未通过"),
      el("div", { class: "score" }, fmtScore(score), el("small", {}, ` / ${fmtScore(totalScore)} 分`)),
      el("div", { class: "meta" }, exam.title || "考试回顾"))
  );

  for (let i = 0; i < questions.length; i++) {
    container.append(reviewCard(i, questions[i], userAnswers));
  }
  renderMathIn(container); // 题干/选项/解析里的公式（$...$ / \ce 化学式等）

  container.append(el("div", { style: "text-align:center;margin-top:var(--sp-4)" },
    el("button", { class: "btn", onclick: () => go("history") }, "返回历史成绩")));
}

function reviewCard(i, q, userAnswers) {
  const my = userAnswers[q.id];
  const card = el("div", { class: "card review-q" });
  const head = el("div", { class: "verdict-line" },
    el("h3", {}, `第 ${i + 1} 题`),
    chip(q.type_name || "", "sky"));
  if (my !== undefined) {
    head.append(chip(isCorrect(q, my) ? "✔ 正确" : "✘ 错误", isCorrect(q, my) ? "mint" : "pink"));
  }
  head.append(el("span", { style: "margin-left:auto;font-size:var(--fs-tiny);color:var(--text-3)" }, `${fmtScore(q.score)} 分`));
  card.append(head);
  card.append(el("div", { class: "q-content", style: "margin-bottom:8px" }, htmlToText(q.content)));

  if (!q.sub_questions.length) {
    card.append(answerLines(q, my), explanation(q));
  } else {
    q.sub_questions.forEach((sub, j) => {
      const subMy = my && typeof my === "object" ? my[sub.id ?? j] : undefined;
      card.append(el("div", { class: "subq" },
        el("div", { class: "sq-title" }, el("h3", {}, `（${j + 1}）${sub.type_name || ""}`)),
        el("div", { class: "q-content" }, htmlToText(sub.content)),
        answerLines(sub, subMy),
        explanation(sub)));
    });
  }
  return card;
}

function answerLines(q, my) {
  const frag = [];
  frag.push(el("div", { class: "answer-line" },
    "你的答案：",
    el("span", { class: "warn" }, my === undefined || my === null ? "未作答" : answerText(q, my))));
  if (q.answer !== null && q.answer !== undefined && q.answer !== "") {
    frag.push(el("div", { class: "answer-line" },
      "正确答案：",
      el("span", { class: "ok" }, answerText(q, q.answer))));
  }
  return el("div", {}, frag);
}

function explanation(q) {
  const exp = htmlToText(q.explanation || "");
  if (!exp) return null;
  return el("div", { class: "explain" }, "解析：", exp);
}

// ---------- 解析与判定 ----------

function parseQuestions(json) {
  try {
    const arr = typeof json === "string" ? JSON.parse(json) : json;
    return (arr || []).map(normalizeQ);
  } catch {
    return [];
  }
}

function parseAnswers(json) {
  try {
    const obj = typeof json === "string" ? JSON.parse(json) : json;
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function normalizeQ(v) {
  let rawType = v.question_type || v.type || "";
  const typeName = v.type_name || rawType;
  let qtype = "text";
  if (/single|单选/i.test(rawType + typeName)) qtype = "single_choice";
  else if (/multi|多选/i.test(rawType + typeName)) qtype = "multiple_choice";
  else if (/judge|判断|true/i.test(rawType + typeName)) qtype = "true_false";
  else if (/fill|填空/i.test(rawType + typeName)) qtype = "fill_blank";
  else if (/material|材料/i.test(rawType + typeName)) qtype = "material";
  return {
    id: Number(v.id) || 0,
    qtype,
    type_name: typeName,
    content: v.content || "",
    options: (v.options || []).map((o) => (typeof o === "string" ? o : o?.text ?? "")),
    answer: v.answer,
    score: Number(v.score) || 0,
    explanation: v.explanation || "",
    sub_questions: (v.sub_questions || []).map((s) => normalizeQ(s)),
  };
}

// 答案展示：把索引/数组转成 "A（选项文本）"
function answerText(q, ans) {
  if (ans === null || ans === undefined) return "未作答";
  if (Array.isArray(ans)) return ans.map((a) => single(q, a)).join("、") || "未作答";
  return single(q, ans);
}

function single(q, a) {
  if (typeof a === "number") {
    const L = "ABCDEFGH";
    return q.options?.[a] !== undefined ? `${L[a]}（${String(q.options[a]).slice(0, 24)}）` : L[a] || String(a);
  }
  return String(a);
}

// 判定：接口答案存字母/文本，用户答案存索引/文本
function isCorrect(q, my) {
  const right = q.answer;
  if (q.qtype === "single_choice" || q.qtype === "true_false") {
    return norm(q, my) === norm(q, right);
  }
  if (q.qtype === "multiple_choice") {
    const mine = (Array.isArray(my) ? my : [my]).map((x) => norm(q, x)).sort().join("|");
    const theirs = (Array.isArray(right) ? right : String(right).split("")).map((x) => norm(q, x)).sort().join("|");
    return mine === theirs && mine.length > 0;
  }
  if (q.qtype === "fill_blank") {
    return String(my ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
  }
  return false; // 主观题不判定
}

function norm(q, v) {
  if (typeof v === "number") return String(v);
  const s = String(v ?? "").trim();
  // 字母 → 索引
  if (s.length === 1 && /[A-H]/i.test(s)) {
    return String(s.toUpperCase().charCodeAt(0) - 65);
  }
  // 选项文本 → 索引
  const idx = (q.options || []).findIndex((o) => String(o).trim() === s);
  return idx >= 0 ? String(idx) : s.toLowerCase();
}
