// 刷题（练习）：逐题即时判分 + 解析展示。
// 在线：进度与逐题作答保存为服务器"刷题记录"（每卷最多10条，可续做/重新开始/本次不记录）。
// 离线：回退本地缓存试卷，进度保存在本地（不产生服务器记录）。

import { api } from "../api.js";
import { el, clear, loadingBox, errorBox, chip, toastOk, toastErr, fmtScore, htmlToText, modal, confirmModal, renderMathIn } from "../ui.js";
import { go } from "../router.js";
import { windowControls } from "../win.js";
import { isPluginActive } from "../plugin-state.js";

const LETTER = "ABCDEFGH";

export async function renderPractice(container, param) {
  // 支持复合参数：practice/{examId} 或 practice/{examId}/redo/{recordId}
  const m = String(param ?? "").match(/^(\d+)(?:\/redo\/(\d+))?$/);
  const examId = Number(m?.[1] || 0);
  const redoRecordId = m?.[2] ? Number(m[2]) : null;
  if (!examId) return;

  // 错题重刷：纯临时会话（不写库/不同步/不落本地，退出即丢）
  if (redoRecordId) return startRedo(container, examId, redoRecordId);

  clear(container).append(loadingBox("正在载入试卷…"));

  // 在线：先查该试卷的刷题记录状态（未完成进度 / 记录上限），弹出选择
  let statusData = null;
  try {
    const env = await api.get("backend/api/practice/status.php", { exam_id: examId });
    statusData = env.data ? env.data : env;
  } catch {}

  let mode = "record";
  if (statusData) {
    const choice = await askPracticeChoice(statusData);
    if (choice === null) { go("exams"); return; } // 取消返回
    if (choice === "manage") { go("history/practice"); return; }
    mode = choice; // 'record' | 'restart' | 'no_record'
  }

  // 取卷：start.php（题目+进度+作答快照）；失败回退离线缓存
  let startData = null;
  try {
    const env = await api.post("backend/api/practice/start.php", { exam_id: examId, mode });
    startData = env.data ? env.data : env;
  } catch (e) {
    const msg = String(e?.message || "");
    // 上限被拒（罕见竞态）：提示后返回
    if (msg.includes("上限")) {
      return clear(container).append(errorBox(msg, () => go("exams"), { onBack: () => go("exams"), backLabel: "返回真题市场" }));
    }
    const cached = await api.getCachedPaper(examId);
    if (!cached) return clear(container).append(errorBox("试卷加载失败：请联网重试，或先缓存试卷后离线刷题", () => go("exams"), { onBack: () => go("exams"), backLabel: "返回真题市场" }));
    clear(container);
    new PracticePage(container, examId, { exam: cached.exam, questions: cached.questions }, null).mount();
    return;
  }
  clear(container);
  new PracticePage(container, examId, { exam: startData.exam, questions: startData.questions }, startData).mount();
}

// 错题重刷：拉取记录错题，进入临时会话
async function startRedo(container, examId, recordId) {
  clear(container).append(loadingBox("正在载入错题…"));
  let data;
  try {
    const env = await api.get("backend/api/practice/record_detail.php", { record_id: recordId });
    data = env.data ? env.data : env;
  } catch (e) {
    return clear(container).append(errorBox(e?.message || "加载记录详情失败", () => go("history/practice"), { onBack: () => go("history/practice"), backLabel: "返回刷题记录" }));
  }

  const wrong = (data.questions || []).filter((q) => q.is_correct === false);
  if (!wrong.length) {
    toastOk("该记录当前没有错题，无需重刷");
    return go("history/practice");
  }

  const paper = {
    exam: { title: `${data.record?.exam_title || "刷题"} · 错题重刷` },
    questions: wrong.map((q) => ({
      id: q.question_id,
      question_type: q.question_type,
      type_name: q.type_name,
      content: q.content,
      options: q.options || [],
      answer: q.answer,
      explanation: q.explanation,
      score: Number(q.score) || 0,
      orig_index: q.index,
      sub_questions: (q.sub_questions || []).map((s) => ({
        ...s,
        type: s.type || s.question_type,
        type_name: s.type_name || s.question_type,
      })),
    })),
  };
  clear(container);
  new PracticePage(container, examId, paper, {
    redoRecordId: recordId,
    origIndexes: wrong.map((q) => q.index),
  }).mount();
}

// 进入刷题前的选择弹窗：继续/重新开始；上限时管理记录/本次不记录
function askPracticeChoice(statusData) {
  const u = statusData.unfinished;
  if (u) {
    return askDialog({
      title: "检测到未完成的刷题进度",
      body: el("p", { style: "color:var(--text-2);line-height:2" },
        `该试卷有一次进行中的刷题（已答 ${u.completed_count || 0}/${u.total_questions} 题，最后活跃于 ${u.last_activity_at}）。`,
        el("div", { class: "banner", style: "margin-top:8px" }, "继续将恢复上次的作答与进度；重新开始会把该次记录标记为“未完成”。")),
      actions: [
        { label: "重新开始", kind: "danger", value: "restart" },
        { label: "继续上次进度", kind: "primary", value: "record" },
      ],
    });
  }
  const count = Number(statusData.record_count ?? 0);
  const max = Number(statusData.max_records ?? 10);
  if (count >= max) {
    // 记录管理页属于「学习记录」插件：未安装时不提供管理入口
    const manageAction = isPluginActive("study-records")
      ? [{ label: "管理刷题记录", value: "manage" }]
      : [];
    return askDialog({
      title: "刷题记录已达上限",
      body: el("p", { style: "color:var(--text-2);line-height:2" },
        `该试卷的刷题记录已有 ${count}/${max} 条。可前往刷题记录删除旧记录后重试，或选择本次不记录（不保存进度与记录）。`),
      actions: [
        ...manageAction,
        { label: "本次不记录，直接刷题", kind: "primary", value: "no_record" },
      ],
    });
  }
  return Promise.resolve("record");
}

// 可等待的三按钮对话框（ui.js 的 modal 取消按钮无法挂钩子，这里自建同款结构）
function askDialog({ title, body, actions }) {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root");
    const done = (v) => {
      mask.classList.remove("show");
      setTimeout(() => mask.remove(), 520);
      resolve(v);
    };
    const mask = el("div", { class: "modal-mask" },
      el("div", { class: "modal" },
        el("h3", {}, title), body,
        el("div", { class: "modal-actions" },
          el("button", { class: "btn", onclick: () => done(null) }, "取消"),
          ...actions.map((a) => el("button", { class: `btn ${a.kind || ""}`, onclick: () => done(a.value) }, a.label)))));
    root.append(mask);
    requestAnimationFrame(() => mask.classList.add("show"));
  });
}

class PracticePage {
  // startData 为 null 时走离线/本地模式；record_mode==='no_record' 时本次不记录；redoRecordId 时为错题重刷
  constructor(container, examId, paper, startData) {
    this.container = container;
    this.examId = examId;
    this.exam = paper.exam || {};
    this.questions = (paper.questions || []).map(normalizeQ);
    this.startData = startData;
    this.serverMode = startData
      ? (startData.redoRecordId
          ? "redo"
          : (startData.record_mode === "no_record" ? "no_record" : "record"))
      : null; // null = 离线/本地模式
    this.redoRecordId = startData?.redoRecordId || null;
    this.redoOrigIndex = startData?.origIndexes || [];
    this.redoApplied = false;
    this.offline = !startData;
    this.cur = 0;
    this.answers = new Map(); // qid -> { value, ok }
    this.results = new Map(); // qid -> true/false（判题结果，供答题卡着色）
    this.startedAt = Date.now();
    this.syncTimer = null;   // 服务器同步定时器
    this.syncDead = false;   // 记录已被结束（如在别处重新开始）后停止同步
    this.dirty = false;      // 有未同步的作答
  }

  async mount() {
    // 恢复进度：记录模式优先服务器快照；离线模式读本地；不记录/错题重刷不恢复
    if (this.serverMode === "record") {
      this.restoreFromServer(this.startData);
    } else if (this.serverMode === null) {
      await this.restoreFromLocal();
    }

    this.statsBar = el("div", { class: "banner info", style: "display:flex;align-items:center;gap:14px;flex-wrap:wrap" });
    const root = el("div", { class: "take-page", style: "padding:var(--sp-3) var(--sp-5) var(--sp-5)" });
    const isRedo = this.serverMode === "redo";
    const exitBtn = el("button", { class: "btn ghost", onclick: async () => {
      if (isRedo) return go("history/practice");
      await this.flushSync();
      go("exams");
    } }, isRedo ? "← 退出重刷" : "← 退出刷题");
    const top = el("div", { class: "topbar", "data-tauri-drag-region": "", style: "position:sticky;top:0;border-radius:var(--r-card);margin-bottom:var(--sp-3)" },
      el("span", { class: "title", "data-tauri-drag-region": "", style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" },
        `${this.exam.title || "刷题"} · 练习模式`),
      this.curChip = el("span", { style: "font-size:var(--fs-small);color:var(--text-2)" }),
      windowControls(),
      exitBtn);
    root.append(top, this.statsBar);

    this.main = el("div", { class: "take-main" });
    this.side = el("div", { class: "take-side practice-side" });
    root.append(el("div", { class: "take-layout" }, this.main, this.side));
    // 窄窗口隐藏答题卡，避免挤压答题区
    const media = window.matchMedia("(max-width: 1080px)");
    const syncSide = () => { this.side.style.display = media.matches ? "none" : ""; };
    media.addEventListener("change", syncSide); syncSide();

    this.container.append(root);
    this.refresh();
    this.save();
  }

  // 从服务器作答快照恢复（索引 -> {a, ok}，材料题 a={subs:{子题序号:{v,ok}}}）
  restoreFromServer(startData) {
    const map = startData.answers || {};
    Object.keys(map).forEach((k) => {
      const i = Number(k);
      const q = this.questions[i];
      const e = map[k];
      if (!q || !e) return;
      if (q.sub_questions.length) {
        const subs = (e.a && e.a.subs) || {};
        q.sub_questions.forEach((s, si) => {
          const se = subs[String(si)];
          if (se && se.v !== undefined && se.v !== null) {
            this.answers.set(s.id, { value: se.v, ok: !!se.ok });
          }
        });
      } else if (e.a !== undefined && e.a !== null) {
        this.answers.set(q.id, { value: e.a, ok: !!e.ok });
      }
    });
    if (Number.isFinite(Number(startData.current_index))) {
      const idx = Number(startData.current_index);
      if (idx >= 0 && idx < this.questions.length) this.cur = idx;
    }
  }

  // 恢复本地进度（离线模式）
  async restoreFromLocal() {
    try {
      const saved = await api.loadPractice(this.examId);
      if (saved && Array.isArray(saved.answers) && saved.answers.length === this.questions.length) {
        saved.answers.forEach((a, i) => {
          const q = this.questions[i];
          if (!q) return;
          // 材料题：恢复子题答案 {subs: {子题id: 答案}}
          if (a && a.subs && typeof a.subs === "object") {
            q.sub_questions.forEach((s) => {
              if (Object.prototype.hasOwnProperty.call(a.subs, s.id)) {
                this.answers.set(s.id, a.subs[s.id]);
              }
            });
            return;
          }
          if (a && a.hasOwnProperty("value")) {
            this.answers.set(q.id, a);
          }
        });
        if (Number.isFinite(saved.index) && saved.index >= 0 && saved.index < this.questions.length) this.cur = saved.index;
      }
    } catch {}
  }

  // ---------- 统计 / 进度 ----------

  /** 材料题取子题答案；普通题取自身答案 */
  qAnswers(q) {
    if (q.sub_questions.length) {
      const out = new Map();
      q.sub_questions.forEach((s) => { if (this.answers.has(s.id)) out.set(s.id, this.answers.get(s.id)); });
      return out;
    }
    const a = this.answers.get(q.id);
    return a ? new Map([[q.id, a]]) : new Map();
  }

  answeredCount() {
    return this.questions.filter((q) => this.qAnswers(q).size > 0).length;
  }
  correctCount() {
    return this.questions.filter((q) => {
      const m = this.qAnswers(q);
      if (!m.size) return false;
      // 材料题：全部子题已判且全部答对才算答对
      if (q.sub_questions.length) return q.sub_questions.every((s) => m.get(s.id)?.ok === true);
      return m.values().next().value.ok === true;
    }).length;
  }

  modeHint() {
    if (this.serverMode === "redo") return "错题重刷 · 临时会话 · 覆盖前退出即丢失";
    if (this.serverMode === "record") return "练习模式 · 即时判题 · 进度保存到服务器";
    if (this.serverMode === "no_record") return "本次不记录 · 退出后进度不保留";
    return "离线刷题 · 进度保存在本地";
  }

  updateStats() {
    const done = this.answeredCount();
    const correct = this.correctCount();
    this.curChip.textContent = `${this.cur + 1} / ${this.questions.length} 题 · 已答 ${done} · 答对 ${correct}`;
    const pct = done ? Math.round((correct / done) * 100) : 0;
    const stats = el("span", {}, this.modeHint());
    clear(this.statsBar).append(stats,
      el("span", { style: "margin-left:auto;font-size:var(--fs-small);color:var(--text-2)" }, `正确率 ${pct}%`));
  }

  drawSheet() {
    clear(this.side);
    const legend = el("div", { class: "ans-legend" },
      legendDot("ok", "答对"), legendDot("no", "答错"), legendDot("", "未答"));
    const cells = el("div", { class: "cells", style: "display:flex;flex-wrap:wrap" });
    this.questions.forEach((q, i) => {
      const cls = ["cell"];
      const m = this.qAnswers(q);
      let ok = null;
      if (m.size) {
        ok = q.sub_questions.length
          ? q.sub_questions.every((s) => m.get(s.id)?.ok === true)
          : m.values().next().value.ok;
      }
      if (ok === true) cls.push("ok");
      else if (ok === false) cls.push("no");
      if (i === this.cur) cls.push("cur");
      cells.append(el("span", { class: cls.join(" "), onclick: () => { this.cur = i; this.refresh(); } }, String(i + 1)));
    });
    this.side.append(el("div", { class: "card ans-card" },
      el("div", { class: "card-title" }, el("h3", {}, "答题卡"),
        el("span", { style: "font-size:var(--fs-tiny);color:var(--text-3)" }, `已答 ${this.answeredCount()}/${this.questions.length}`)),
      cells, legend));
  }

  refresh() {
    this.updateStats();
    this.drawQ();
    renderMathIn(this.main); // 渲染题目与选项里的公式（$...$ / \ce 化学式等）
    this.drawSheet();
  }

  // ---------- 题目渲染 ----------

  drawQ() {
    const idx = this.cur;
    const q = this.questions[idx];
    clear(this.main);

    const head = el("div", { class: "q-head" },
      el("span", { class: "q-no" }, `第 ${idx + 1} / ${this.questions.length} 题`),
      chip(q.type_name, "sky"),
      q.score ? el("span", { class: "q-score" }, `${fmtScore(q.score)} 分`) : null);

    const card = el("div", { class: "card q-card" }, head,
      el("div", { class: "q-content" }, htmlToText(q.content)));

    if (!q.sub_questions.length) {
      card.append(this.drawSlot(q, (v, ok) => this.answer(q, v, ok)));
    } else {
      q.sub_questions.forEach((sub, i) => {
        card.append(el("div", { class: "subq" },
          el("div", { class: "sq-title" }, el("h3", {}, `（${i + 1}）${sub.type_name}`)),
          this.drawSlot(sub, (v, ok) => this.answer(sub, v, ok, q))));
      });
    }

    const prev = el("button", { class: "btn", disabled: idx === 0 || undefined, onclick: () => { this.cur = idx - 1; this.refresh(); } }, "← 上一题");
    const next = idx < this.questions.length - 1
      ? el("button", { class: "btn primary", onclick: () => { this.cur = idx + 1; this.refresh(); } }, "下一题 →")
      : el("button", { class: "btn primary", onclick: () => this.finish() }, "完成本次刷题");
    const saveHint = el("span", { style: "flex:1;font-size:var(--fs-tiny);color:var(--text-3)" },
      this.serverMode === "redo" ? "临时会话 · 覆盖前退出即丢失"
        : this.serverMode === "no_record" ? "本次不记录 · 关闭后进度不保留"
        : "作答即保存 · 可随时退出");
    card.append(el("div", { class: "take-footer" }, prev, next, saveHint));

    this.main.append(card);

    // 题目评论/记录：作答后才挂载（未答不显示，防讨论剧透；续做恢复/错题重刷同样生效）
    this.commentsBox = el("div", { class: "card", style: "margin-top:12px;padding:14px 16px;display:none" });
    this.main.append(this.commentsBox);
    if (this.qAnswers(q).size > 0) this.mountComments(q);

    document.querySelector(".content")?.scrollTo?.(0, 0);
  }

  // ---------- 题目评论/记录（作答后可见；发表需审核，作者立即可见自己的） ----------

  mountComments(q) {
    if (!this.commentsBox || !q?.id) return;
    const host = clear(this.commentsBox);
    host.style.display = "";
    this.qcQuestionId = q.id;
    this.qcItems = [];

    this.qcList = el("div", { style: "display:grid;gap:10px" },
      el("div", { class: "banner", style: "text-align:center;color:var(--text-3)" }, "正在加载评论…"));
    this.qcInput = el("textarea", { class: "input", placeholder: "写下你的评论或解题记录…（500 字以内）", style: "min-height:70px;resize:vertical" });

    host.append(
      el("div", { class: "card-title", style: "margin-bottom:10px" },
        el("h3", {}, "评论与记录"),
        this.qcCount = el("span", { style: "font-size:var(--fs-tiny);color:var(--text-3)" }, "…")),
      this.qcList,
      el("div", { style: "margin-top:12px" },
        this.qcInput,
        el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap" },
          el("span", { style: "flex:1;font-size:var(--fs-tiny);color:var(--text-3)" },
            "发表后需管理员审核，通过后对其他人可见；自己可立即查看。"),
          this.qcSubmitBtn = el("button", { class: "btn sm primary", onclick: () => this.submitComment() }, "发表"))));

    this.loadComments(q.id);
  }

  async loadComments(qid) {
    let items = null;
    try {
      const env = await api.get("backend/api/practice/comments.php", { action: "list", question_id: qid });
      if (this.qcQuestionId !== qid) return; // 已切题，丢弃
      items = env.data?.comments || [];
    } catch {
      if (this.qcQuestionId !== qid) return;
    }
    this.qcItems = items;
    this.renderComments();
  }

  renderComments() {
    if (!this.qcList) return;
    this.qcCount.textContent = this.qcItems ? String(this.qcItems.length) : "—";

    if (this.qcItems === null) {
      clear(this.qcList).append(el("div", { class: "banner", style: "text-align:center;color:var(--text-3)" }, "评论加载失败（离线或网络异常）"));
      return;
    }
    if (!this.qcItems.length) {
      clear(this.qcList).append(el("div", { class: "banner", style: "text-align:center;color:var(--text-3)" }, "还没有评论，来写下第一条记录吧。"));
      return;
    }

    const list = clear(this.qcList);
    for (const c of this.qcItems) {
      const name = c.full_name || c.username || "用户";
      const statusBadge = c.is_mine && c.status === "pending"
        ? el("span", { style: "font-size:11px;padding:1px 7px;border-radius:9999px;background:var(--warn-t);color:var(--warn)" }, "审核中 · 仅自己可见")
        : (c.is_mine && c.status === "rejected"
          ? el("span", { style: "font-size:11px;padding:1px 7px;border-radius:9999px;background:var(--pink-t);color:var(--danger)" }, "未通过 · 仅自己可见")
          : null);
      const avatar = c.avatar
        ? el("img", { src: c.avatar, alt: "", style: "width:32px;height:32px;border-radius:9999px;object-fit:cover;flex-shrink:0" })
        : el("span", { style: "width:32px;height:32px;border-radius:9999px;background:var(--sky-t);color:var(--sky);display:inline-flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0" }, (name[0] || "友").toUpperCase());
      list.append(el("div", { style: "display:flex;gap:10px;align-items:flex-start" },
        avatar,
        el("div", { style: "flex:1;min-width:0" },
          el("div", { style: "display:flex;align-items:center;gap:6px;flex-wrap:wrap" },
            el("span", { style: "font-size:var(--fs-small);color:var(--text)" }, name),
            c.user_type === "admin" ? el("span", { class: "chip mint", style: "font-size:11px;padding:0 6px" }, "管理员") : null,
            c.user_type === "teacher" ? el("span", { class: "chip sky", style: "font-size:11px;padding:0 6px" }, "教师") : null,
            statusBadge,
            el("span", { style: "margin-left:auto;font-size:var(--fs-tiny);color:var(--text-3)" }, String(c.created_at || "").slice(0, 16)),
            c.is_mine ? el("button", { class: "btn sm danger ghost", title: "删除这条评论", onclick: () => this.deleteComment(c.id) }, "删除") : null),
          el("div", { style: "font-size:var(--fs-small);color:var(--text-2);line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:2px" }, c.content))));
    }
  }

  async submitComment() {
    const content = (this.qcInput?.value || "").trim();
    if (!content) return toastErr("请输入评论内容");
    if (content.length > 500) return toastErr("评论最多 500 字");
    if (!this.qcQuestionId) return;

    this.qcSubmitBtn.disabled = true;
    try {
      const env = await api.post("backend/api/practice/comments.php", {
        action: "add",
        question_id: this.qcQuestionId,
        content,
      });
      const comment = env.data?.comment;
      if (comment && Array.isArray(this.qcItems)) {
        this.qcItems.unshift(comment);
        this.renderComments();
        this.qcInput.value = "";
        toastOk(env.message || "已发表，审核通过后对其他人可见");
      }
    } catch (e) {
      toastErr(e?.message || "发表失败");
    }
    this.qcSubmitBtn.disabled = false;
  }

  deleteComment(id) {
    confirmModal("删除评论", "确定删除这条评论吗？", async () => {
      try {
        await api.post("backend/api/practice/comments.php", { action: "delete", comment_id: id });
        this.qcItems = (this.qcItems || []).filter((c) => c.id !== id);
        this.renderComments();
        toastOk("已删除");
      } catch (e) {
        toastErr(e?.message || "删除失败");
      }
    }, "删除", "danger");
  }

  // 题目作答区：选择题即时判分；主观题"看答案 + 自评"。
  drawSlot(q, onAnswer) {
    // 已答：直接展示判定结果（正确绿 / 错误红 + 正确答案 + 解析）
    const saved = this.answers.get(q.id);
    if (saved) return this.renderResult(q, saved);

    if (["single_choice", "multiple_choice", "true_false"].includes(q.qtype)) {
      const multi = q.qtype === "multiple_choice";
      const picked = new Set();
      const wrap = el("div", {});
      const opts = q.options.length ? q.options : (q.qtype === "true_false" ? ["正确", "错误"] : []);
      const rows = opts.map((opt, i) => {
        const row = el("div", { class: "opt-row", onclick: () => {
          if (saved) return;
          if (!multi) {
            rows.forEach((r) => r.classList.remove("sel"));
            row.classList.add("sel");
            onAnswer(i, null);
          } else {
            picked.has(i) ? picked.delete(i) : picked.add(i);
            row.classList.toggle("sel");
          }
        } },
          el("span", { class: "letter" }, multi ? `☐ ${LETTER[i]}.` : `${LETTER[i]}.`),
          el("div", { class: "text" }, htmlToText(opt)));
        wrap.append(row);
        return row;
      });
      if (multi) {
        wrap.append(el("div", { class: "take-footer" },
          el("button", { class: "btn primary", onclick: () => onAnswer([...picked].sort(), null) }, "确认作答")));
      }
      return wrap;
    }

    // 填空 / 简答：输入 + 看答案 + 自评（主观题由用户对照参考答案自评）
    const input = el("textarea", { class: "input", placeholder: "在此作答…" });
    const viewAns = el("button", { class: "btn", onclick: () => {
      toastOk(`参考答案：${answerDisplay(q)}`);
    } }, "看参考答案");
    const submit = el("button", { class: "btn primary", onclick: () => {
      if (!input.value.trim()) return toastErr("请先填写作答内容");
      modal({
        title: "自评",
        body: el("p", { style: "color:var(--text-2);line-height:2" },
          "你的作答与参考答案一致吗？", el("div", { class: "banner", style: "margin-top:8px" }, `参考答案：${answerDisplay(q)}`)),
        actions: [
          { label: "答对了", kind: "ok", onClick: () => onAnswer(input.value, true) },
          { label: "答错了", kind: "danger", onClick: () => onAnswer(input.value, false) },
        ],
      });
    } }, "提交自评");
    return el("div", {}, input, el("div", { class: "take-footer" }, viewAns, submit));
  }

  // 判分并落库
  async answer(q, value, forceOk, parent) {
    if (this.answers.has(q.id)) return;
    const ok = forceOk != null ? forceOk : judge(q, value);
    this.answers.set(q.id, { value, ok, at: Date.now() });
    this.results.set(q.id, ok);
    await this.save();
    this.queueSync();
    this.refresh();
  }

  // 已答后展示：高亮正确选项 + 判定 + 解析
  renderResult(q, saved) {
    const ok = !!saved.ok;
    const right = normalizeAnswer(q.answer);
    const wrap = el("div", {});

    if (["single_choice", "multiple_choice", "true_false"].includes(q.qtype)) {
      const my = normalizeAnswer(saved.value);
      const opts = q.options.length ? q.options : (q.qtype === "true_false" ? ["正确", "错误"] : []);
      opts.forEach((opt, i) => {
        const isRight = right.includes(i);
        const isMine = my.includes(i);
        const cls = ["opt-row"];
        if (isRight) cls.push("right");
        else if (isMine) cls.push("wrong");
        wrap.append(el("div", { class: cls.join(" ") },
          el("span", { class: "letter" }, `${LETTER[i]}.`),
          el("div", { class: "text" }, htmlToText(opt))));
      });
    } else {
      wrap.append(el("div", { class: "verdict", style: `color:${ok ? "var(--ok)" : "var(--danger)"};margin-bottom:10px` },
        ok ? "✔ 回答正确" : `✘ 参考答案：${answerDisplay(q)}`));
    }

    if (!ok) {
      wrap.append(el("div", { class: "banner" },
        el("b", {}, "参考答案："), " ", answerDisplay(q)));
    }
    if (q.explanation) {
      wrap.append(el("div", { class: "banner sky" }, el("b", {}, "解析："), " ", htmlToText(q.explanation)));
    }
    return wrap;
  }

  // ---------- 保存 / 服务器同步 / 完成 ----------

  // 本地保存（仅离线模式；记录/不记录/重刷均不走本地通道）
  async save() {
    if (this.serverMode !== null) return;
    try {
      await api.savePractice(this.examId, {
        index: this.cur,
        answers: this.questions.map((q) => {
          // 材料题：存子题答案映射；普通题：存自身答案
          if (q.sub_questions.length) {
            const subs = {};
            q.sub_questions.forEach((s) => { if (this.answers.has(s.id)) subs[s.id] = this.answers.get(s.id); });
            return Object.keys(subs).length ? { subs } : null;
          }
          return this.answers.get(q.id) || null;
        }),
      });
    } catch {}
  }

  // —— 服务器同步（记录模式）——

  queueSync() {
    if (this.serverMode !== "record" || !this.startData?.progress_id || this.syncDead) return;
    this.dirty = true;
    if (!this.syncTimer) {
      this.syncTimer = setTimeout(() => this.flushSync(), 5000);
    }
  }

  // 构建逐题作答快照：索引 -> {a, ok}；材料题 a={subs:{子题序号:{v,ok}}}
  buildAnswersMap() {
    const map = {};
    this.questions.forEach((q, i) => {
      if (q.sub_questions.length) {
        const subs = {};
        let any = false;
        let allOk = true;
        q.sub_questions.forEach((s, si) => {
          const a = this.answers.get(s.id);
          if (a) {
            subs[String(si)] = { v: a.value, ok: !!a.ok };
            any = true;
            if (!a.ok) allOk = false;
          }
        });
        if (any) map[i] = { a: { subs }, ok: allOk };
      } else {
        const a = this.answers.get(q.id);
        if (a) map[i] = { a: a.value, ok: !!a.ok };
      }
    });
    return map;
  }

  // 已答/错题索引数组（与 web 端口径一致：错题是已答的子集）
  buildIndexArrays() {
    const completedIdx = [];
    const wrongIdx = [];
    this.questions.forEach((q, i) => {
      const m = this.qAnswers(q);
      if (!m.size) return;
      completedIdx.push(i);
      const ok = q.sub_questions.length
        ? q.sub_questions.every((s) => m.get(s.id)?.ok === true)
        : m.values().next().value.ok === true;
      if (!ok) wrongIdx.push(i);
    });
    return { completedIdx, wrongIdx };
  }

  async flushSync() {
    if (this.serverMode !== "record" || !this.startData?.progress_id || this.syncDead) return;
    if (this.syncTimer) { clearTimeout(this.syncTimer); this.syncTimer = null; }
    if (!this.dirty) return;
    this.dirty = false;
    const { completedIdx, wrongIdx } = this.buildIndexArrays();
    try {
      await api.post("backend/api/practice/submit.php", {
        progress_id: this.startData.progress_id,
        question_index: this.cur,
        completed_questions: JSON.stringify(completedIdx),
        wrong_questions: JSON.stringify(wrongIdx),
        answers: JSON.stringify(this.buildAnswersMap()),
      });
    } catch (e) {
      if (String(e?.message || "").includes("已结束")) {
        this.syncDead = true;
        return;
      }
      this.dirty = true; // 网络失败：稍后重试
      if (!this.syncTimer) this.syncTimer = setTimeout(() => this.flushSync(), 5000);
    }
  }

  async finish() {
    if (this.syncTimer) { clearTimeout(this.syncTimer); this.syncTimer = null; }
    // 错题重刷：完成即生成错题回顾（临时，覆盖前不落任何存储）
    if (this.serverMode === "redo") return this.showRedoReview();
    const done = this.answeredCount();
    const correct = this.correctCount();
    const rate = done ? Math.round((correct / done) * 100) : 0;

    let extraBtn = null;
    if (this.serverMode === "record") {
      // 完成刷题记录：最终同步 + 落库为已完成
      try {
        const { completedIdx, wrongIdx } = this.buildIndexArrays();
        await this.flushSync();
        await api.post("backend/api/practice/complete.php", {
          progress_id: this.startData.progress_id,
          completed_questions: JSON.stringify(completedIdx),
          correct_count: correct,
          wrong_count: done - correct,
          wrong_questions: JSON.stringify(wrongIdx),
          answers: JSON.stringify(this.buildAnswersMap()),
          validation_key: this.startData.validation_key || "",
        });
        api.clearPractice(this.examId).catch(() => {});
        if (isPluginActive("study-records")) {
          extraBtn = el("button", { class: "btn primary", onclick: () => go("history/practice") }, "查看刷题记录");
        }
      } catch (e) {
        toastErr(e?.message || "完成同步失败，请检查网络后重试");
      }
    } else if (this.serverMode === null) {
      // 离线：本地归档本次统计
      try {
        await api.recordPractice({
          exam_id: this.examId,
          title: this.exam.title || "刷题",
          question_count: done,
          correct_count: correct,
          total: this.questions.length,
          duration: Math.round((Date.now() - this.startedAt) / 1000),
          at: new Date().toISOString().slice(0, 19).replace("T", " "),
          offline: this.offline,
        });
      } catch {}
    }

    const retryBtn = this.serverMode === null
      ? el("button", { class: "btn primary", onclick: () => {
          this.answers.clear(); this.results.clear(); this.cur = 0;
          api.clearPractice(this.examId).catch(() => {});
          this.refresh();
        } }, "重新刷一遍")
      : el("button", { class: "btn primary", onclick: () => go(`practice/${this.examId}`) }, "重新刷一遍");

    const card = el("div", { class: "card", style: "max-width:560px;margin:var(--sp-7) auto;text-align:center;position:relative" },
      el("div", { class: "verdict", style: `color:${rate >= 60 ? "var(--ok)" : "var(--danger)"}` }, "本次刷题完成"),
      el("div", { class: "score" }, String(correct), el("small", {}, ` / ${done} 题答对`)),
      el("p", { class: "meta" }, `正确率 ${rate}%${done < this.questions.length ? ` · 还有 ${this.questions.length - done} 题未答` : ""}`),
      el("div", { style: "display:flex;gap:14px;justify-content:center;margin-top:var(--sp-3);flex-wrap:wrap" },
        retryBtn,
        ...(extraBtn ? [extraBtn] : []),
        el("button", { class: "btn", onclick: () => go("exams") }, "返回真题市场")));
    clear(this.container).append(card);
  }

  // ---------- 错题重刷：回顾与覆盖 ----------

  // 汇总二刷结果并渲染错题回顾（临时卡片）
  showRedoReview() {
    const results = [];
    let skipped = 0;
    this.questions.forEach((q, i) => {
      const m = this.qAnswers(q);
      if (!m.size) { skipped++; return; }
      if (q.sub_questions.length) {
        const subs = {};
        let any = false;
        let allOk = true;
        q.sub_questions.forEach((s, si) => {
          const a = this.answers.get(s.id);
          if (a) { subs[String(si)] = { v: a.value, ok: !!a.ok }; any = true; if (!a.ok) allOk = false; }
        });
        if (!any) { skipped++; return; }
        results.push({ index: this.redoOrigIndex[i], a: { subs }, ok: allOk, redoNo: i });
      } else {
        const a = this.answers.get(q.id);
        results.push({ index: this.redoOrigIndex[i], a: a.value, ok: !!a.ok, redoNo: i });
      }
    });

    const fixed = results.filter((r) => r.ok).length;
    const stillWrong = results.length - fixed;
    const rate = results.length ? Math.round((fixed / results.length) * 100) : 0;
    results.sort((x, y) => x.index - y.index);

    const applyBtn = el("button", { class: "btn primary", onclick: () => this.applyRedo(applyBtn, results) }, "覆盖本次记录");

    const items = results.map((r) => {
      const q = this.questions[r.redoNo];
      return el("div", { class: "card", style: `border-left:2px solid ${r.ok ? "var(--ok)" : "var(--danger)"};padding:14px 16px;margin-bottom:10px` },
        el("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap" },
          el("b", {}, `原卷第 ${r.index + 1} 题`),
          chip(q.type_name, "sky"),
          el("span", { style: `margin-left:auto;font-size:var(--fs-small);color:${r.ok ? "var(--ok)" : "var(--danger)"}` }, r.ok ? "✓ 已纠正" : "✗ 仍答错")),
        el("div", { style: "color:var(--text-2);line-height:1.8;margin-bottom:8px" }, htmlToText(q.content)),
        el("div", { style: "font-size:var(--fs-small);line-height:2" },
          el("div", {}, el("span", { style: "color:var(--text-3)" }, "二刷作答："), fmtRedoAnswer(r.a, q.qtype)),
          el("div", {}, el("span", { style: "color:var(--text-3)" }, "正确答案："), fmtRedoAnswer(q.answer, q.qtype))),
        q.explanation ? el("div", { class: "banner sky", style: "margin-top:8px" }, el("b", {}, "解析："), htmlToText(q.explanation)) : null);
    });

    const card = el("div", { style: "max-width:680px;margin:var(--sp-5) auto" },
      el("div", { class: "card", style: "text-align:center;margin-bottom:14px" },
        el("div", { class: "verdict", style: `color:${rate >= 60 ? "var(--ok)" : "var(--danger)"}` }, "错题回顾 · 二刷结果"),
        el("div", { class: "meta", style: "color:var(--text-2);margin-top:6px" },
          `重刷 ${results.length} 题 · 纠正 ${fixed} · 仍答错 ${stillWrong}${skipped ? ` · 未重刷 ${skipped}` : ""} · 二刷正确率 ${rate}%`),
        el("div", { class: "banner", style: "margin-top:10px" }, "回顾为临时展示：覆盖后二刷结果才附加到原记录，在此之前退出即丢失。"),
        el("div", { style: "display:flex;gap:14px;justify-content:center;margin-top:var(--sp-3);flex-wrap:wrap" },
          el("button", { class: "btn", onclick: () => go("history/practice") }, "返回记录列表"),
          applyBtn)),
      el("div", {}, items),
      skipped ? el("div", { class: "banner", style: "margin-top:10px" }, `另有 ${skipped} 题未作答，保持原记录中的错题状态（不参与覆盖）。`) : null);
    clear(this.container).append(card);
  }

  // 覆盖本次记录：把二刷结果附加到原记录（保留首刷，统计按最新状态重算）
  async applyRedo(btn, results) {
    if (this.redoApplied) return;
    if (!results.length) return toastErr("本次没有作答任何错题，无可覆盖的内容");
    confirmModal("覆盖本次记录",
      `确定把 ${results.length} 题的二刷结果覆盖到原刷题记录吗？二刷明细将附加到对应题目上，记录统计按最新状态重算。`,
      async () => {
        btn.disabled = true;
        try {
          const env = await api.post("backend/api/practice/redo_apply.php", {
            record_id: this.redoRecordId,
            results: JSON.stringify(results.map(({ index, a, ok }) => ({ index, a, ok }))),
          });
          this.redoApplied = true;
          btn.textContent = "已覆盖本次记录";
          toastOk(env?.message || "已覆盖本次记录");
        } catch (e) {
          btn.disabled = false;
          toastErr(e?.message || "覆盖失败，请重试");
        }
      }, "覆盖", "primary");
  }
}

// ---------------- 判分 / 工具 ----------------

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
    options: (v.options || []).map((o) => typeof o === "string" ? o : (o?.text ?? o?.content ?? "")),
    answer: v.answer ?? "",
    explanation: v.explanation || "",
    score: Number(v.score) || 0,
    sub_questions: (v.sub_questions || []).map((s) => normalizeQ(s)),
  };
}

/** 判分：my 为索引（选择题）/字符串（主观题） */
function judge(q, my) {
  const right = q.answer;
  if (q.qtype === "single_choice") return my === normalizeAnswer(right)[0];
  if (q.qtype === "multiple_choice") {
    const arr = normalizeAnswer(right);
    return Array.isArray(my) && my.length === arr.length && arr.every((x) => my.includes(x));
  }
  if (q.qtype === "true_false") return (Number(my) === 0 && right === "正确") || (Number(my) === 1 && right === "错误") || String(my) === String(right);
  if (q.qtype === "fill_blank") return String(my ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
  return false; // 简答/材料由用户自评
}

/** 将答案归一化为选项索引数组（供高亮与展示） */
function normalizeAnswer(a) {
  if (Array.isArray(a)) return a.map((x) => (typeof x === "number" ? x : "ABCDEFGH".indexOf(String(x).toUpperCase()))).filter((x) => x >= 0);
  if (typeof a === "number") return [a];
  const s = String(a ?? "").trim();
  if (/^[A-Oa-o]+$/.test(s)) return s.toUpperCase().split("").map((ch) => "ABCDEFGH".indexOf(ch)).filter((x) => x >= 0);
  if (s === "正确") return [0];
  if (s === "错误") return [1];
  return [];
}

function answerDisplay(q) {
  const a = q.answer;
  if (Array.isArray(a)) return a.map((x) => (typeof x === "number" ? "ABCDEFGH"[x] ?? x : x)).join("、");
  if (typeof a === "number") return "ABCDEFGH"[a] ?? String(a);
  return String(a ?? "—");
}

// 二刷答案展示格式化（索引转字母、布尔转正确/错误、材料题展开小题；兼容 web/桌面两种材料形态）
function fmtRedoAnswer(answer, qtype) {
  if (answer === null || answer === undefined || answer === "") return "未作答";
  if (typeof answer === "boolean") return answer ? "正确" : "错误";
  if (Array.isArray(answer)) return answer.map((i) => (typeof i === "number" ? ("ABCDEFGH"[i] ?? i) : String(i).toUpperCase())).join(" , ");
  if (typeof answer === "object") {
    if (answer.subs && typeof answer.subs === "object") {
      const entries = Object.entries(answer.subs);
      if (!entries.length) return "未作答";
      return entries.map(([k, v]) => `第${Number(k) + 1}小题：${fmtRedoAnswer(v && v.v !== undefined ? v.v : v)}`).join("；");
    }
    const entries = Object.entries(answer);
    if (!entries.length) return "未作答";
    return entries.map(([k, v]) => `第${Number(k) + 1}小题：${fmtRedoAnswer(v)}`).join("；");
  }
  if (qtype === "true_false") {
    const s = String(answer).toLowerCase();
    if (s === "true" || s === "1") return "正确";
    if (s === "false" || s === "0") return "错误";
  }
  return String(answer);
}

function legendDot(cls, label) {
  return el("span", {}, el("i", { class: cls, style: `display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;background:${cls === "ok" ? "var(--ok-t);border:1px solid var(--ok)" : cls === "no" ? "var(--danger-t);border:1px solid var(--danger)" : "var(--hairline);background:#fff"}` }), label);
}
