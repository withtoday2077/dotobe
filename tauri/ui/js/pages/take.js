// 答题页（全屏沉浸）：六种题型 + 材料子题、服务端倒计时、答题卡、
// 标记待复查、本地草稿（作答即存+30s）、切屏防作弊、交卷确认、结果视图
// 数据：GET exam/take.php?exam_id=X[&record=Y] → {exam, questions, record_id, remaining_seconds}
// 交卷：POST exam/submit.php {exam_id, record_id, answers, marked_questions, cheat_violations}

import { api } from "../api.js";
import { windowControls } from "../win.js";
import { el, clear, loadingBox, errorBox, chip, toastOk, toastErr, confirmModal, fmtScore, fmtHms, htmlToText, renderMathIn } from "../ui.js";
import { go } from "../router.js";

const TF_LABEL = ["正确", "错误"];
const LETTER = "ABCDEFGH";

export async function renderTake(container, param) {
  const examId = Number(param);
  clear(container).append(loadingBox("正在拉取试卷…"));

  let paper, cached = null;
  try {
    // take.php 顶层平铺：{success, exam, questions, record_id, remaining_seconds}
    const env = await api.get("backend/api/exam/take.php", { exam_id: examId });
    paper = env.data ? env.data : env;
  } catch (e) {
    // 离线回退：已缓存试卷可浏览（不能交卷计分）
    cached = await api.getCachedPaper(examId);
    if (!cached) return clear(container).append(errorBox(e.message, () => renderTake(container, param), { onBack: () => go("exams"), backLabel: "返回真题市场" }));
    paper = { exam: cached.exam, questions: cached.questions, offline: true };
  }
  clear(container);
  new TakePage(container, paper).mount();
}

class TakePage {
  constructor(container, paper) {
    this.container = container;
    this.paper = paper;
    this.exam = paper.exam || {};
    this.questions = (paper.questions || []).map(normalizeQ);
    this.recordId = paper.record_id || 0;
    this.remaining = Number(paper.remaining_seconds ?? 0) || Number(this.exam.duration) * 60 || 0;
    this.offline = !!paper.offline;
    this.cur = 0;
    this.answers = new Map(); // qid -> slot | {sub: slot}
    this.marked = new Set();
    this.violations = 0;
    this.submitted = false;
    this.notified5 = false;
    this.notified1 = false;
    this.timerId = null;
    this.draftTimerId = null;
    this.onVis = null;
  }

  async mount() {
    // 恢复本地草稿
    try {
      const draft = await api.loadDraft(this.exam.id);
      if (draft && this.applyDraft(draft)) toastOk("已恢复上次作答进度");
    } catch {}
    const root = el("div", { class: "take-page", style: "padding:var(--sp-3) var(--sp-5) var(--sp-5)" });

    // 顶栏：标题 + 倒计时 + 交卷
    this.timerBox = el("span", { class: "timer normal" }, fmtHms(this.remaining));
    this.submitBtn = el("button", { class: "btn primary", onclick: () => this.confirmSubmit(false) }, "交 卷");
    this.banner = el("div", { style: "display:none" });
    root.append(
      el("div", { class: "topbar", "data-tauri-drag-region": "", style: "position:sticky;top:0;border-radius:var(--r-card);margin-bottom:var(--sp-3)" },
        el("span", { class: "title", "data-tauri-drag-region": "", style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, this.exam.title || "考试"),
        this.timerBox,
        windowControls(),
        this.submitBtn),
      this.banner,
      ...(this.offline ? [el("div", { class: "banner warn" }, "当前离线：显示的是本地缓存试卷，仅供浏览作答，恢复联网后请重新进入考试。")] : [])
    );

    // 主体：题目区 + 答题卡
    this.main = el("div", { class: "take-main" });
    this.side = el("div", { class: "take-side" });
    root.append(el("div", { class: "take-layout" }, this.main, this.side));
    // 材料占比大时答题卡收窄；窗口窄时隐藏
    const media = window.matchMedia("(max-width: 1080px)");
    const syncSide = () => { this.side.style.display = media.matches ? "none" : ""; };
    media.addEventListener("change", syncSide); syncSide();

    this.container.append(root);
    this.drawQ();
    renderMathIn(this.main);
    this.drawSheet();
    this.startTimer();
    this.startDraftTimer();
    this.watchVisibility();
  }

  // ---------------- 作答状态 ----------------

  slotOf(q) {
    if (!this.answers.has(q.id)) {
      if (q.sub_questions.length) this.answers.set(q.id, { sub: q.sub_questions.map(() => null) });
      else this.answers.set(q.id, null);
    }
    return this.answers.get(q.id);
  }

  isAnswered(q) {
    const s = this.slotOf(q);
    if (q.sub_questions.length) return s.sub.some((x) => isSlotFilled(x));
    return isSlotFilled(s);
  }

  answeredCount() {
    return this.questions.filter((q) => this.isAnswered(q)).length;
  }

  setSlot(q, value) {
    this.slotOf(q);
    if (q.sub_questions.length) return; // 材料题主槽不可直接写
    this.answers.set(q.id, value);
    this.saveDraft();
    this.refresh(this.cur);
  }

  setSubSlot(q, idx, value) {
    const s = this.slotOf(q);
    s.sub[idx] = value;
    this.saveDraft();
    this.refresh(this.cur);
  }

  async saveDraft() {
    if (this.offline) return;
    const answers = {};
    for (const q of this.questions) {
      const s = this.slotOf(q);
      answers[q.id] = q.sub_questions.length
        ? Object.fromEntries(s.sub.map((v, i) => [subKey(q, i), v]))
        : s;
    }
    try {
      await api.saveDraft(this.exam.id, {
        question_ids: this.questions.map((q) => q.id),
        answers,
        marked: [...this.marked],
        index: this.cur,
        remaining: this.remaining,
      });
    } catch {}
  }

  applyDraft(draft) {
    if (!draft || !Array.isArray(draft.answers)) return false;
    let any = false;
    for (const q of this.questions) {
      const saved = draft.answers?.[q.id];
      if (saved === undefined) continue;
      if (q.sub_questions.length && saved && typeof saved === "object") {
        const s = this.slotOf(q);
        s.sub = q.sub_questions.map((sq, i) => saved[subKey(q, i)] ?? null);
        any = true;
      } else if (isSlotValue(saved)) {
        this.answers.set(q.id, saved);
        any = true;
      }
    }
    (draft.marked || []).forEach((id) => this.marked.add(id));
    if (Number.isFinite(draft.index) && draft.index >= 0 && draft.index < this.questions.length) this.cur = draft.index;
    if (Number.isFinite(draft.remaining) && draft.remaining > 0) this.remaining = draft.remaining;
    return any;
  }

  // ---------------- 渲染 ----------------

  refresh(idx) {
    this.drawQ(idx);
    renderMathIn(this.main); // 翻题后重新渲染公式（$...$ / \(...) / \ce 化学式）
    this.drawSheet();
  }

  drawQ(idx = this.cur) {
    this.cur = idx;
    const q = this.questions[idx];
    clear(this.main);

    const head = el("div", { class: "q-head" },
      el("span", { class: "q-no" }, `第 ${idx + 1} / ${this.questions.length} 题`),
      chip(q.type_name, "sky"),
      this.marked.has(q.id) ? chip("待复查", "pink") : null,
      el("span", { class: "q-score" }, `${fmtScore(q.score)} 分`));

    const card = el("div", { class: "card q-card" }, head,
      el("div", { class: "q-content" }, htmlToText(q.content)));

    if (!q.sub_questions.length) {
      card.append(this.drawSlot(q, this.slotOf(q), (v) => this.setSlot(q, v)));
    } else {
      const slots = this.slotOf(q).sub;
      q.sub_questions.forEach((sub, i) => {
        card.append(el("div", { class: "subq" },
          el("div", { class: "sq-title" },
            el("h3", {}, `（${i + 1}）${sub.type_name}`),
            el("span", { style: "font-size:var(--fs-tiny);color:var(--text-3)" }, `${fmtScore(sub.score)} 分`)),
          this.drawSlot(sub, slots[i], (v) => this.setSubSlot(q, i, v))));
      });
    }

    // 底部导航
    card.append(el("div", { class: "take-footer" },
      el("button", { class: "btn", disabled: idx === 0 || undefined, onclick: () => this.refresh(idx - 1) }, "← 上一题"),
      el("button", { class: "btn", onclick: () => this.toggleMark(q) }, this.marked.has(q.id) ? "取消标记" : "标记待复查"),
      el("span", { style: "flex:1" }),
      idx < this.questions.length - 1
        ? el("button", { class: "btn primary", onclick: () => this.refresh(idx + 1) }, "下一题 →")
        : el("button", { class: "btn primary", onclick: () => this.confirmSubmit(false) }, "检查并交卷")));

    this.main.append(card);
    // 进入页面滚到顶
    document.querySelector(".content")?.scrollTo?.(0, 0);
  }

  drawSlot(q, slot, set) {
    switch (q.qtype) {
      case "single_choice": {
        const cur = Number.isInteger(slot) ? slot : null;
        return el("div", {}, ...(q.options || []).map((opt, i) =>
          el("div", { class: "opt-row" + (cur === i ? " sel" : ""), onclick: () => set(i) },
            el("span", { class: "letter" }, `${LETTER[i]}.`),
            el("div", { class: "text" }, htmlToText(opt)))));
      }
      case "multiple_choice": {
        const cur = Array.isArray(slot) ? slot : [];
        const toggle = (i) => {
          const next = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i];
          next.sort((a, b) => a - b);
          set(next);
        };
        return el("div", {}, ...(q.options || []).map((opt, i) =>
          el("div", { class: "opt-row" + (cur.includes(i) ? " sel" : ""), onclick: () => toggle(i) },
            el("span", { class: "letter" }, `☐ ${LETTER[i]}.`),
            el("div", { class: "text" }, htmlToText(opt)))));
      }
      case "true_false": {
        const cur = typeof slot === "string" ? slot : null;
        return el("div", { style: "display:flex;gap:12px" }, TF_LABEL.map((t) =>
          el("div", { class: "opt-row" + (cur === t ? " sel" : ""), style: "flex:1;justify-content:center", onclick: () => set(t) },
            el("span", { class: "text" }, t))));
      }
      default: {
        const input = el("textarea", { class: "input", placeholder: "在此作答…" });
        input.value = typeof slot === "string" ? slot : "";
        let t = null;
        input.addEventListener("input", () => {
          clearTimeout(t);
          t = setTimeout(() => set(input.value), 400);
        });
        return el("div", {}, input);
      }
    }
  }

  toggleMark(q) {
    this.marked.has(q.id) ? this.marked.delete(q.id) : this.marked.add(q.id);
    this.saveDraft();
    this.refresh(this.cur);
  }

  drawSheet() {
    clear(this.side);
    const legend = el("div", { class: "ans-legend" },
      legendDot("answered", "已答"), legendDot("", "未答"), legendDot("marked", "标记"));
    const cells = el("div", { style: "display:flex;flex-wrap:wrap" });
    this.questions.forEach((q, i) => {
      const cls = ["cell"];
      const answered = this.isAnswered(q);
      if (this.marked.has(q.id)) cls.push("marked");
      else if (answered) cls.push("answered");
      if (i === this.cur) cls.push("cur");
      cells.append(el("span", { class: cls.join(" "), onclick: () => this.refresh(i) }, String(i + 1)));
    });
    this.side.append(el("div", { class: "card ans-card" },
      el("div", { class: "card-title" }, el("h3", {}, "答题卡"),
        el("span", { style: "font-size:var(--fs-tiny);color:var(--text-3)" }, `已答 ${this.answeredCount()}/${this.questions.length}`)),
      cells, legend,
      el("button", { class: "btn block", style: "margin-top:14px", onclick: () => this.confirmSubmit(false) }, "交 卷")));
  }

  // ---------------- 计时 / 草稿 / 防切屏 ----------------

  startTimer() {
    const tick = () => {
      if (this.submitted) return;
      this.remaining -= 1;
      if (this.remaining <= 300 && !this.notified5) {
        this.notified5 = true;
        toastErr("考试时间不足 5 分钟");
      }
      if (this.remaining <= 60 && !this.notified1) {
        this.notified1 = true;
        toastErr("考试时间不足 1 分钟！");
      }
      this.timerBox.textContent = fmtHms(this.remaining);
      this.timerBox.className = "timer " + (this.remaining <= 60 ? "danger" : this.remaining <= 300 ? "warn" : "normal");
      if (this.remaining <= 0) {
        this.doSubmit(true, "考试时间已到，系统自动交卷");
        return;
      }
      this.timerId = setTimeout(tick, 1000);
    };
    tick();
  }

  startDraftTimer() {
    this.draftTimerId = setInterval(() => this.saveDraft(), 30000);
  }

  watchVisibility() {
    this.onVis = () => {
      if (document.hidden || this.submitted) return;
      this.violations += 1;
      if (this.violations >= 3) {
        confirmModal("警告：离开考场", "已多次离开考试页面，系统将自动交卷。", () => {}, "我知道了");
        this.doSubmit(true, "cheating");
      } else {
        toastErr(`警告：离开考试页面（第 ${this.violations}/3 次），达到 3 次将自动交卷`);
      }
    };
    document.addEventListener("visibilitychange", this.onVis);
  }

  // ---------------- 交卷 ----------------

  confirmSubmit(auto = false) {
    const unanswered = this.questions.length - this.answeredCount();
    const msg = unanswered > 0
      ? `还有 ${unanswered} 题未作答，确定交卷吗？`
      : "全部作答完成，确定交卷吗？";
    confirmModal(auto ? "自动交卷" : "交卷确认", msg, () => this.doSubmit(false), "确认交卷");
  }

  buildAnswers() {
    const answers = {};
    for (const q of this.questions) {
      const s = this.slotOf(q);
      if (q.sub_questions.length) {
        const subs = {};
        s.sub.forEach((v, i) => { if (isSlotFilled(v)) subs[subKey(q, i)] = v; });
        if (Object.keys(subs).length) answers[q.id] = subs;
      } else if (isSlotFilled(s)) {
        answers[q.id] = s;
      }
    }
    return answers;
  }

  async doSubmit(auto, reason) {
    if (this.submitted) return;
    this.submitted = true;
    clearTimeout(this.timerId);
    clearInterval(this.draftTimerId);
    document.removeEventListener("visibilitychange", this.onVis);
    if (auto) toastErr(reason);

    try { await api.clearDraft(this.exam.id); } catch {}

    if (this.offline) {
      showResultView(this.container, {
        offline: true,
        exam: this.exam,
        total: this.questions.length,
        message: "离线状态下无法计分交卷",
      });
      return;
    }

    let env;
    try {
      env = await api.postJSON("backend/api/exam/submit.php", {
        exam_id: this.exam.id,
        record_id: this.recordId,
        answers: this.buildAnswers(),
        marked_questions: [...this.marked],
        cheat_violations: this.violations,
      });
    } catch (e) {
      this.submitted = false;
      toastErr("交卷失败：" + e.message + "（已恢复考试状态）");
      this.startTimer();
      this.startDraftTimer();
      this.watchVisibility();
      return;
    }
    showResultView(this.container, env.data || env);
  }
}

// ---------------- 结果视图（交卷后内嵌展示） ----------------

function showResultView(container, data) {
  clear(container);
  const passed = data.is_passed ?? data.passed;
  const score = data.score ?? data.total_score;
  const verdict = el("div", { class: `verdict ${passed === undefined ? "" : passed ? "pass" : "fail"}` },
    passed === undefined ? "已交卷" : passed ? "✔ 恭喜通过" : "未通过");
  const box = el("div", { class: "card", style: "max-width:560px;margin:var(--sp-7) auto;text-align:center;position:relative" },
    verdict,
    score !== undefined && score !== null
      ? el("div", { class: "score" }, fmtScore(score), el("small", {}, " 分"))
      : el("p", { style: "color:var(--text-2);margin-top:10px" }, data.message || "试卷已提交，成绩以历史记录为准"),
    data.correct_count !== undefined
      ? el("p", { class: "meta", style: "margin-top:6px" }, `答对 ${data.correct_count}/${data.total_count ?? data.total ?? data.question_count ?? "—"} 题`)
      : null,
    data.offline ? el("p", { style: "color:var(--warn);margin-top:8px" }, "离线模式：本次作答未提交") : null,
    el("div", { style: "display:flex;gap:14px;justify-content:center;margin-top:var(--sp-3)" },
      el("button", { class: "btn primary", onclick: () => (location.hash = "#/history") }, "查看历史成绩"),
      el("button", { class: "btn", onclick: () => (location.hash = "#/exams") }, "返回真题市场")));
  container.append(box);
}

// ---------------- 工具 ----------------

/** 材料子题的答案键：用 sub_question_index（服务端判分按此取值），缺字段时回退数组下标 */
function subKey(q, i) {
  const sq = q.sub_questions[i];
  return (sq && sq.subIndex !== null && sq.subIndex !== undefined) ? sq.subIndex : i;
}

function isSlotFilled(v) {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}
function isSlotValue(v) {
  return isSlotFilled(v) || Array.isArray(v);
}

// 题目归一化（题型识别 + 选项取文本 + 子题递归）；真题市场预览共用
export function normalizeQ(v) {
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
    // options 元素是 {text, image} 或字符串，统一取文本
    options: (v.options || []).map((o) =>
      typeof o === "string" ? o : (o?.text ?? o?.content ?? "")),
    score: Number(v.score) || 0,
    // 答案键用 sub_question_index（服务端判分按此取值）；缺字段时为 null，调用处回退数组下标
    subIndex: (v.sub_question_index !== undefined && v.sub_question_index !== null)
      ? Number(v.sub_question_index) : null,
    sub_questions: (v.sub_questions || []).map((s) => normalizeQ(s)),
  };
}

function legendDot(cls, label) {
  return el("span", {}, el("i", { class: cls, style: `display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;background:${cls === "answered" ? "var(--sky-t);border:1px solid var(--sky)" : cls === "marked" ? "var(--pink-t);border:1px solid var(--pink)" : "var(--hairline);background:#fff"}` }), label);
}
