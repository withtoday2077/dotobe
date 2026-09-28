// 仿真模拟考试（全屏沉浸）：A3 纸质小册翻页作答 + 拟物答题卡/草稿纸
// 数据与判分链路与 take.js 相同：
//   拉卷 GET exam/take.php?exam_id=X → 顶层平铺 {exam, questions, record_id, remaining_seconds}
//   交卷 POST exam/submit.php {exam_id, record_id, answers, marked_questions, cheat_violations}
// 草稿与 take.js 共用 Rust 侧 api.saveDraft（同字段）；答案值语义一致：
//   单选=索引 多选=索引数组(排序) 判断="正确"/"错误" 填空/简答=字符串 材料={子题 sub_question_index: 值}

import { api, session } from "../api.js";
import { windowControls } from "../win.js";
import { el, clear, loadingBox, errorBox, toastOk, toastErr, confirmModal, fmtScore, fmtHms, escapeHtml } from "../ui.js";
import { go } from "../router.js";
import { normalizeQ } from "./take.js";
import { isPluginActive } from "../plugin-state.js";

const LETTER = "ABCDEFGH";
const PAGE_BUDGET = 758;

const SECTION_DEFS = {
  single_choice: { cn: "单选题", desc: "在每小题给出的四个选项中，只有一项是符合题目要求的。" },
  multiple_choice: { cn: "多选题", desc: "在每小题给出的选项中，有多项符合题目要求，全部选对得满分，错选、多选不得分。" },
  true_false: { cn: "判断题", desc: "判断下列命题是否正确，正确的填“√”，错误的填“×”。" },
  fill_blank: { cn: "填空题", desc: "请将答案填写在题中横线上。" },
  text: { cn: "简答题", desc: "解答应写出文字说明、证明过程或演算步骤。" },
  material: { cn: "材料分析题", desc: "阅读材料，回答下列问题。" },
};

const SUBJECT_NAMES = {
  math: "数学", chinese: "语文", english: "英语", physics: "物理",
  chemistry: "化学", biology: "生物", history: "历史", geography: "地理",
  politics: "政治", computer_science: "计算机科学", information_technology: "信息技术",
  general_technology: "通用技术", other: "其他",
};
const subjectName = (v) => (v ? SUBJECT_NAMES[v] || v : "");

export async function renderMockExam(container, param) {
  const examId = Number(param);
  clear(container).append(loadingBox("正在拉取试卷…"));
  let paper;
  try {
    const env = await api.get("backend/api/exam/take.php", { exam_id: examId });
    paper = env.data ? env.data : env; // take.php 顶层平铺
  } catch (e) {
    return clear(container).append(errorBox(e.message, () => renderMockExam(container, param), { onBack: () => go("exams"), backLabel: "返回真题市场" }));
  }
  clear(container);
  new MockPage(container, paper).mount();
}

// 在 normalizeQ 基础上补图片与子题索引（排版需要）
function normQ(v) {
  const q = normalizeQ(v);
  q.images = Array.isArray(v.images) ? v.images : [];
  q.optionImages = (v.options || []).map((o) => (o && typeof o === "object" ? o.image || null : null));
  (v.sub_questions || []).forEach((sv, i) => {
    if (q.sub_questions[i]) q.sub_questions[i].subIndex = Number(sv.sub_question_index ?? i);
  });
  return q;
}

class MockPage {
  constructor(container, paper) {
    this.container = container;
    this.exam = paper.exam || {};
    this.questions = (paper.questions || []).map(normQ);
    this.recordId = paper.record_id || 0;
    this.total = Number(this.exam.duration) * 60 || 0;
    this.remaining = Number(paper.remaining_seconds ?? 0) || this.total;
    this.answers = {};   // qid -> 值（语义见文件头）
    this.marked = {};
    this.currentQid = null;
    this.spreads = [];
    this.spreadOfQ = {};
    this.sections = [];
    this.qIndex = {};
    this.curSpread = 0;
    this.animating = false;
    this.violations = 0;
    this.submitted = false;
    this.started = false;
    this.timerId = null;
    this.draftTimerId = null;
    this.rafId = 0;
    this.listeners = [];
    this.baseUrl = (api.baseUrlSync() || "").replace(/\/+$/, "");
  }

  // ---------- 挂载 ----------

  async mount() {
    this.buildChrome();
    this.bindAntiCheat();

    // 恢复本地草稿（与 take.js 共用存储）
    try {
      const draft = await api.loadDraft(this.exam.id);
      if (this.applyDraft(draft)) toastOk("已恢复上次作答进度");
    } catch {}

    await this.buildPaper();
    this.drawCard();
    this.restoreToPaper();
    this.updateProgress();
    this.$(".boot-loading").style.display = "none";
    this.fitPaper();
    this.on(window, "resize", () => this.fitPaper());
    this.startDraftTimer();
    this.parallaxLoop();
    this.on(window, "hashchange", () => { if (!location.hash.startsWith("#/mock/")) this.teardown(); });
  }

  // 页面骨架（HTML 模板一次性注入，样式全部圈在 .sim-root 作用域）
  buildChrome() {
    const root = el("div", { class: "sim-root" });
    root.innerHTML = `
      <div class="sim-topbar" data-tauri-drag-region="">
        <span class="sim-title" data-tauri-drag-region=""></span>
        <span class="sim-wc"></span>
      </div>
      <div class="desk"></div>
      <div class="stage">
        <div class="paper-3d">
          <div class="paper-scaler"><div class="book"></div></div>
        </div>
      </div>
      <div class="sim-measurer"></div>
      <div class="vignette"></div>
      <div class="clock-ui"><div class="clock-label">考试剩余时间</div><div class="clock-time"></div></div>
      <div class="progress-ui">已作答　<b class="ans-count">0</b> / <span class="total-count">0</span></div>
      <div class="hud-btns">
        <button class="hud-btn btn-card">答 题 卡</button>
        <button class="hud-btn btn-pad">草 稿 纸</button>
      </div>
      <div class="book-nav">
        <button class="nav-btn nav-prev" title="上一册（←）">‹</button>
        <div class="nav-info">第 <b class="nav-cur">1</b> / <b class="nav-total">1</b> 册</div>
        <button class="nav-btn nav-next" title="下一册（→）">›</button>
      </div>
      <button class="submit-btn">交　卷</button>
      <div class="warn-banner"><span class="warn-text"></span><button class="wb-close">✕</button></div>
      <aside class="anscard">
        <div class="ac-head"><h3>答 题 卡</h3><button class="ac-close" title="收起">✕</button></div>
        <div class="ac-stats"><span>已答 <b class="ac-answered">0</b>/<b class="ac-total">0</b></span><span>标记 <b class="ac-marked">0</b></span></div>
        <div class="ac-body"></div>
        <div class="ac-legend">
          <span class="lg"><i></i>未答</span><span class="lg"><i class="answered"></i>已答</span>
          <span class="lg"><i class="marked"></i>标记</span><span class="lg"><i class="current"></i>当前</span>
        </div>
        <button class="ac-submit">交　卷</button>
      </aside>
      <div class="pad hidden">
        <div class="pad-head">
          <span class="pad-title">草 稿 纸</span>
          <button class="pad-tool penbtn sel" data-pen="#1c1c28" title="黑笔"><span class="pad-swatch" style="background:#1c1c28"></span></button>
          <button class="pad-tool penbtn" data-pen="#a3241c" title="红笔"><span class="pad-swatch" style="background:#a3241c"></span></button>
          <button class="pad-tool penbtn" data-pen="#1b3a8a" title="蓝笔"><span class="pad-swatch" style="background:#1b3a8a"></span></button>
          <button class="pad-tool pad-eraser" title="橡皮">◖</button>
          <span class="pad-sizes">
            <button class="sz" data-size="2" title="细"><i></i></button>
            <button class="sz m sel" data-size="3.5" title="中"><i></i></button>
            <button class="sz l" data-size="6" title="粗"><i></i></button>
          </span>
          <button class="pad-tool pad-undo" title="撤销">↶</button>
          <button class="pad-tool danger pad-clear" title="清空">✕</button>
        </div>
        <div><canvas class="pad-canvas" width="452" height="560"></canvas></div>
        <div class="pad-tip">按住头部可拖动 · 内容自动保存</div>
      </div>
      <div class="pad-tab">草 稿 纸</div>
      <div class="intro">
        <div class="intro-title">考 试 开 始</div>
        <div class="intro-sub"></div>
        <div class="intro-meta"></div>
        <div class="intro-tip">点 击 任 意 位 置 开 始 答 题</div>
      </div>
      <div class="overlay-m confirm-modal">
        <div class="m-card"><h3>交 卷 确 认</h3><div class="m-line"></div>
        <div class="m-body confirm-body"></div>
        <div class="m-btns"><button class="m-btn plain confirm-no">继续作答</button><button class="m-btn primary confirm-yes">确定交卷</button></div></div>
      </div>
      <div class="result">
        <div class="result-card"><h2>考 试 结 束</h2><div class="rc-line"></div>
        <div class="rc-main-score">得分 <span class="big rc-score">--</span> / <span class="rc-full">--</span><span class="rc-pass" style="margin-left:10px;"></span></div>
        <div class="rc-score rc-detail" style="text-align:center;"></div>
        <div class="rc-btns"><button class="rc-btn plain rc-back">返回真题市场</button><button class="rc-btn rc-history">查看历史成绩</button></div></div>
      </div>
      <div class="boot-loading">正 在 排 版 试 卷 …</div>`;
    this.container.append(root);
    this.root = root;
    this.root.querySelector(".sim-title").textContent = `${this.exam.title || "考试"} · 仿真模拟`;
    const wc = this.root.querySelector(".sim-wc");
    wc.append(windowControls());
    this.root.querySelector(".intro-sub").textContent = `${this.exam.title || ""} · ${subjectName(this.exam.subject)}`;
    this.root.querySelector(".intro-meta").textContent =
      `满分 ${fmtScore(this.exam.total_score)} 分　·　考试时间 ${this.exam.duration || 0} 分钟　·　共 ${this.questions.length} 题`;
    this.root.querySelector(".clock-time").textContent = fmtHms(this.remaining);
    this.root.querySelector(".total-count").textContent = this.questions.length;
    this.bindChromeEvents();
    this.initPad();
  }

  $(sel) { return this.root.querySelector(sel); }
  $all(sel) { return this.root.querySelectorAll(sel); }
  on(target, ev, fn) { target.addEventListener(ev, fn); this.listeners.push([target, ev, fn]); }

  teardown() {
    clearTimeout(this.timerId);
    clearInterval(this.draftTimerId);
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.padSaveTimer);
    this.listeners.forEach(([t, e, f]) => t.removeEventListener(e, f));
    this.listeners = [];
  }

  resolveImg(p) {
    if (!p) return "";
    return this.baseUrl + "/" + String(p).replace(/^\//, "");
  }

  // ---------- 排版 ----------

  paperHeadBlock() {
    const u = session.user || {};
    const d = document.createElement("div");
    d.innerHTML =
      `<div class="p-title">${escapeHtml(this.exam.title || "")}</div>` +
      `<div class="p-subject">${escapeHtml(subjectName(this.exam.subject))}</div>` +
      `<div class="p-meta">（满分 ${fmtScore(this.exam.total_score)} 分　　考试时间 ${this.exam.duration || 0} 分钟）</div>` +
      `<div class="info-line">` +
      `<span>姓名：<span class="u">${escapeHtml(u.full_name || u.username || "")}</span></span>` +
      `<span>考号：<span class="u">${escapeHtml(u.username || "")}</span></span>` +
      `<span>班级：<span class="u"></span></span></div>` +
      `<div class="notice"><b>注意事项：</b><br>` +
      `1. 答卷前，请将姓名、考号、班级填写在试卷规定的位置。<br>` +
      `2. 选择题用 2B 铅笔填涂，非选择题用 0.5 毫米黑色签字笔书写。<br>` +
      `3. 请在各题目的答题区域内作答，超出答题区域的答案无效。<br>` +
      `4. 切换屏幕 3 次将被视为违规，系统将强制收卷。</div>` +
      `<div class="rule"></div><div class="rule thin"></div>`;
    return d.firstElementChild;
  }

  sectionHeaderBlock(no, def, count, perScore, totalScore) {
    const d = document.createElement("div");
    d.className = "sec-title";
    d.innerHTML = `${cnNum(no)}、${def.cn}（本大题共 ${count} 小题，` +
      `${perScore !== null ? `每小题 ${fmtScore(perScore)} 分，` : ""}共 ${fmtScore(totalScore)} 分。${def.desc}）`;
    return d;
  }

  optHtml(text) {
    if (!text) return "";
    if (text.indexOf("\\") >= 0 && text.indexOf("$") < 0) return `$${text}$`;
    return text;
  }

  optsHtml(opts, optImgs) {
    let h = '<div class="opts">';
    (opts || []).forEach((t, i) => {
      h += `<span class="opt" data-idx="${i}">${LETTER[i] || "·"}．${this.optHtml(t)}`;
      const img = optImgs && optImgs[i] ? this.resolveImg(optImgs[i]) : "";
      if (img) h += `<img class="opt-img" src="${escapeHtml(img)}" alt="选项图片">`;
      h += `</span>`;
    });
    return h + "</div>";
  }

  writeLines(n) {
    return `<div class="solve-label">解：</div><div class="write-lines" contenteditable="true" spellcheck="false" style="--n:${n}"></div>`;
  }
  linesForScore(score) { return Math.max(8, Math.min(24, Math.round(Number(score)) || 12)); }

  questionBlock(q, no) {
    const d = document.createElement("div");
    d.className = "q";
    d.dataset.qid = q.id;
    d.dataset.qtype = q.qtype;
    let stem = q.content || "";
    (q.images || []).forEach((p) => { stem += `<img src="${escapeHtml(this.resolveImg(p))}" alt="题目图片">`; });
    let h = `<button class="q-mark" title="标记本题（M）" tabindex="-1">⚑</button>`;
    const t = q.qtype;

    if (t === "single_choice" || t === "multiple_choice") {
      h += `<div class="q-text"><span class="q-no">${no}.</span>（<span class="answer-slot"></span>）${stem}</div>` + this.optsHtml(q.options, q.optionImages);
    } else if (t === "true_false") {
      h += `<div class="q-text"><span class="q-no">${no}.</span>（<span class="answer-slot"></span>）${stem}</div>` +
        `<div class="opts" style="padding-left:26px;">` +
        `<span class="opt" data-val="正确" style="width:auto;padding-right:30px;">A．正确</span>` +
        `<span class="opt" data-val="错误" style="width:auto;padding-right:30px;">B．错误</span></div>`;
    } else if (t === "fill_blank") {
      h += `<div class="q-text"><span class="q-no">${no}.</span>${stem}　<span class="blank" contenteditable="true" spellcheck="false"></span></div>`;
    } else if (t === "text") {
      h += `<div class="q-text"><span class="q-no">${no}.</span>（${fmtScore(q.score)} 分）${stem}</div>` + this.writeLines(this.linesForScore(q.score));
    } else if (t === "material") {
      h += `<div class="q-text"><span class="q-no">${no}.</span>（${fmtScore(q.score)} 分）${stem}</div>`;
      q.sub_questions.forEach((sub) => {
        const subLines = Math.max(6, Math.min(16, Math.round(Number(sub.score)) || 8));
        h += `<div class="subq" data-sidx="${sub.subIndex}" data-subtype="${sub.qtype}">`;
        if (sub.qtype === "single_choice" || sub.qtype === "multiple_choice") {
          h += `<div class="subq-text">${sub.content || ""}（<span class="answer-slot"></span>）</div>` + this.optsHtml(sub.options);
        } else if (sub.qtype === "true_false") {
          h += `<div class="subq-text">${sub.content || ""}（<span class="answer-slot"></span>）</div>` +
            `<div class="opts" style="padding-left:20px;">` +
            `<span class="opt" data-val="正确" style="width:auto;padding-right:30px;">A．正确</span>` +
            `<span class="opt" data-val="错误" style="width:auto;padding-right:30px;">B．错误</span></div>`;
        } else if (sub.qtype === "fill_blank") {
          h += `<div class="subq-text">${sub.content || ""}<span class="blank" contenteditable="true" spellcheck="false"></span></div>`;
        } else {
          h += `<div class="subq-text">${sub.content || ""}</div><div class="solve-label">答：</div>` +
            `<div class="write-lines" contenteditable="true" spellcheck="false" style="--n:${subLines}"></div>`;
        }
        h += `</div>`;
      });
    }
    d.innerHTML = h;
    return d;
  }

  paginate(blocks) {
    const measurer = this.$(".sim-measurer");
    blocks.forEach((b) => measurer.appendChild(b.el));
    if (window.renderMathInElement) {
      try {
        renderMathInElement(measurer, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false },
            { left: "\\(", right: "\\)", display: false },
          ],
          throwOnError: false,
        });
      } catch {}
    }
    const imgs = Array.from(measurer.querySelectorAll("img"));
    return Promise.all(imgs.map((im) => (im.complete ? Promise.resolve() : new Promise((r) => { im.onload = im.onerror = r; }))))
      .then(() => {
        blocks.forEach((b) => { b.h = b.el.offsetHeight; });
        const pages = [[]];
        let used = 0, i = 0;
        while (i < blocks.length) {
          const b = blocks[i];
          if (used + b.h <= PAGE_BUDGET) {
            if (b.isHeader) {
              const nextH = blocks[i + 1] ? blocks[i + 1].h : 0;
              if (used + b.h + nextH > PAGE_BUDGET && used > 0) { pages.push([]); used = 0; continue; }
            }
            pages[pages.length - 1].push(b);
            used += b.h;
            i++;
          } else {
            const lines = b.el.querySelector(".write-lines");
            if (lines && used === 0) {
              const lh = 28;
              const other = b.h - lines.offsetHeight;
              const fit = Math.floor((PAGE_BUDGET - other - 14) / lh);
              if (fit >= 4) {
                lines.style.setProperty("--n", fit);
                b.h = b.el.offsetHeight;
                pages[pages.length - 1].push(b);
                used = b.h;
                i++;
                continue;
              }
            }
            if (used === 0) { pages[pages.length - 1].push(b); used = PAGE_BUDGET; i++; }
            else { pages.push([]); used = 0; }
          }
        }
        measurer.innerHTML = "";
        return pages;
      });
  }

  async buildPaper() {
    const blocks = [{ el: this.paperHeadBlock() }];
    this.sections = [];
    let no = 0, i = 0;
    while (i < this.questions.length) {
      const t = this.questions[i].qtype;
      const seg = [];
      let j = i;
      while (j < this.questions.length && this.questions[j].qtype === t) { seg.push(this.questions[j]); j++; }
      no++;
      const def = Object.assign({}, SECTION_DEFS[t] || { cn: t, desc: "" });
      if (t === "text" && seg[0] && seg[0].type_name) def.cn = seg[0].type_name.replace(/题$/, "") + "题";
      let totalScore = 0, perScore = null, samePer = true;
      seg.forEach((q) => {
        const s = t === "material"
          ? q.sub_questions.reduce((a, b) => a + (Number(b.score) || 0), 0)
          : Number(q.score) || 0;
        totalScore += s;
        if (perScore === null) perScore = s;
        else if (Math.abs(perScore - s) > 0.001) samePer = false;
      });
      this.sections.push({ type: t, cn: def.cn, ids: seg.map((q) => q.id) });
      blocks.push({ isHeader: true, el: this.sectionHeaderBlock(no, def, seg.length, samePer ? perScore : null, totalScore) });
      seg.forEach((q) => {
        this.qIndex[q.id] = this.questions.indexOf(q) + 1;
        blocks.push({ el: this.questionBlock(q, this.qIndex[q.id]), qid: q.id });
      });
      i = j;
    }
    const pages = await this.paginate(blocks);
    // 组册
    const book = this.$(".book");
    book.innerHTML = "";
    book.insertAdjacentHTML("beforeend", PEN_SVG); // 笔挂在桌面杂志下，翻页时不消失
    this.spreads = [];
    this.spreadOfQ = {};
    for (let s = 0; s < pages.length; s += 2) {
      const paper = document.createElement("div");
      paper.className = "paper";
      const leftPage = document.createElement("section");
      leftPage.className = "page page-left";
      const rightPage = document.createElement("section");
      rightPage.className = "page page-right";
      pages[s].forEach((b) => leftPage.appendChild(b.el));
      if (pages[s + 1]) pages[s + 1].forEach((b) => rightPage.appendChild(b.el));
      else {
        const end = document.createElement("div");
        end.className = "paper-end";
        end.style.marginTop = "auto";
        end.textContent = "—— 全 卷 完 ——";
        rightPage.appendChild(end);
      }
      leftPage.appendChild(this.footer(s + 1, pages.length));
      rightPage.appendChild(this.footer(pages[s + 1] ? s + 2 : null, pages.length));
      paper.append(leftPage, rightPage);
      book.appendChild(paper);
      this.spreads.push(paper);
    }
    this.spreads.forEach((sp, si) => {
      sp.querySelectorAll(".q[data-qid]").forEach((q) => { this.spreadOfQ[q.dataset.qid] = si; });
    });
    this.$(".nav-total").textContent = this.spreads.length;
    this.showSpread(0);
    this.attachInteractions();
  }

  footer(no, total) {
    const f = document.createElement("div");
    f.className = "page-footer";
    f.textContent = no ? `第 ${no} 页　共 ${total} 页` : "（本面空白）";
    return f;
  }

  // ---------- 翻册（真实纸页翻转） ----------

  showSpread(idx) {
    if (idx < 0 || idx >= this.spreads.length) return;
    this.spreads.forEach((sp) => sp.classList.remove("active"));
    this.spreads[idx].classList.add("active");
    this.curSpread = idx;
    this.updateNav();
  }
  updateNav() {
    this.$(".nav-cur").textContent = this.curSpread + 1;
    this.$(".nav-prev").disabled = this.animating || this.curSpread === 0;
    this.$(".nav-next").disabled = this.animating || this.curSpread === this.spreads.length - 1;
  }
  flipStep(dir, dur, done) {
    const from = this.spreads[this.curSpread];
    const to = this.spreads[this.curSpread + dir];
    if (!to) { if (done) done(); return; }
    const cls = dir > 0 ? "fwd" : "bwd";
    const frontPage = from.querySelector(dir > 0 ? ".page-right" : ".page-left").cloneNode(true);
    const backPage = to.querySelector(dir > 0 ? ".page-left" : ".page-right").cloneNode(true);
    const coverPage = from.querySelector(dir > 0 ? ".page-left" : ".page-right").cloneNode(true);
    from.classList.remove("active");
    to.classList.add("active", "no-anim");
    const cover = document.createElement("div");
    cover.className = "flip-cover " + cls;
    cover.appendChild(coverPage);
    const cast = document.createElement("div");
    cast.className = "flip-cast";
    const leaf = document.createElement("div");
    leaf.className = "flip-leaf " + cls;
    const paper = document.createElement("div");
    paper.className = "flip-paper";
    const front = document.createElement("div");
    front.className = "flip-face flip-front";
    front.appendChild(frontPage);
    const back = document.createElement("div");
    back.className = "flip-face flip-back";
    back.appendChild(backPage);
    paper.append(front, back);
    leaf.appendChild(paper);
    const book = this.$(".book");
    book.append(cover, cast, leaf);
    void paper.offsetWidth;
    paper.style.animation = `${dir > 0 ? "simFlipFwd" : "simFlipBwd"} ${dur}ms cubic-bezier(.5,.05,.32,1) forwards`;
    cast.style.animation = `simFlipCast ${dur}ms ease forwards`;
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      this.curSpread += dir;
      leaf.remove(); cover.remove(); cast.remove();
      this.updateNav();
      if (done) done();
    };
    paper.addEventListener("animationend", cleanup, { once: true });
    setTimeout(cleanup, dur * 2 + 400);
  }
  flipTo(target, done) {
    target = Math.max(0, Math.min(this.spreads.length - 1, target));
    if (this.animating) return;
    if (target === this.curSpread) { if (done) done(); return; }
    this.animating = true;
    this.updateNav();
    const dir = target > this.curSpread ? 1 : -1;
    const dur = Math.abs(target - this.curSpread) > 1 ? 360 : 640;
    const chain = () => {
      if (this.curSpread === target) {
        this.animating = false;
        this.updateNav();
        if (done) done();
        return;
      }
      this.flipStep(dir, dur, chain);
    };
    chain();
  }
  goToQuestion(qid) {
    const si = this.spreadOfQ[qid];
    if (si === undefined) return;
    this.flipTo(si, () => {
      const qEl = this.spreads[si].querySelector(`.q[data-qid="${qid}"]`);
      if (qEl) { qEl.classList.remove("locate"); void qEl.offsetWidth; qEl.classList.add("locate"); }
      this.setCurrent(qid);
    });
  }

  // ---------- 作答 ----------

  setCurrent(qid) { this.currentQid = qid; this.drawCardStates(); }

  attachInteractions() {
    this.spreads.forEach((sp) => {
      sp.querySelectorAll('.q[data-qtype="single_choice"], .q[data-qtype="multiple_choice"]').forEach((qEl) => {
        const qid = qEl.dataset.qid;
        const multi = qEl.dataset.qtype === "multiple_choice";
        const slot = qEl.querySelector(".answer-slot");
        qEl.querySelectorAll(".opt").forEach((opt) => {
          opt.addEventListener("click", () => {
            if (this.submitted || !this.started) return;
            const idx = Number(opt.dataset.idx);
            if (multi) {
              const arr = Array.isArray(this.answers[qid]) ? this.answers[qid] : [];
              const pos = arr.indexOf(idx);
              if (pos > -1) arr.splice(pos, 1); else arr.push(idx);
              if (arr.length) this.answers[qid] = arr; else delete this.answers[qid];
              qEl.querySelectorAll(".opt").forEach((o) => o.classList.toggle("chosen", arr.includes(Number(o.dataset.idx))));
              const letters = arr.slice().sort((a, b) => a - b).map((n) => LETTER[n]).join("");
              slot.textContent = letters;
              slot.classList.toggle("filled", !!letters);
            } else {
              this.answers[qid] = idx;
              qEl.querySelectorAll(".opt").forEach((o) => o.classList.remove("chosen"));
              opt.classList.add("chosen");
              slot.textContent = LETTER[idx];
              slot.classList.add("filled");
            }
            this.setCurrent(qid); this.updateProgress(); this.saveDraft();
          });
        });
      });

      sp.querySelectorAll('.q[data-qtype="true_false"]').forEach((qEl) => {
        const qid = qEl.dataset.qid;
        const slot = qEl.querySelector(".answer-slot");
        qEl.querySelectorAll(".opt").forEach((opt) => {
          opt.addEventListener("click", () => {
            if (this.submitted || !this.started) return;
            const val = opt.dataset.val;
            this.answers[qid] = val;
            qEl.querySelectorAll(".opt").forEach((o) => o.classList.remove("chosen"));
            opt.classList.add("chosen");
            slot.textContent = val === "正确" ? "√" : "×";
            slot.classList.add("filled");
            this.setCurrent(qid); this.updateProgress(); this.saveDraft();
          });
        });
      });

      sp.querySelectorAll('.q[data-qtype="material"]').forEach((qEl) => {
        const qid = qEl.dataset.qid;
        qEl.querySelectorAll(".subq").forEach((sub) => {
          const sidx = Number(sub.dataset.sidx);
          const subType = sub.dataset.subtype;
          sub.querySelectorAll(".opt").forEach((opt) => {
            opt.addEventListener("click", () => {
              if (this.submitted || !this.started) return;
              const obj = this.answers[qid] = this.answers[qid] || {};
              const slot = sub.querySelector(".answer-slot");
              if (subType === "true_false") {
                const val = opt.dataset.val;
                obj[sidx] = val;
                sub.querySelectorAll(".opt").forEach((o) => o.classList.remove("chosen"));
                opt.classList.add("chosen");
                if (slot) { slot.textContent = val === "正确" ? "√" : "×"; slot.classList.add("filled"); }
              } else if (subType === "multiple_choice") {
                const idx = Number(opt.dataset.idx);
                const arr = Array.isArray(obj[sidx]) ? obj[sidx] : [];
                const pos = arr.indexOf(idx);
                if (pos > -1) arr.splice(pos, 1); else arr.push(idx);
                if (arr.length) obj[sidx] = arr; else delete obj[sidx];
                sub.querySelectorAll(".opt").forEach((o) => o.classList.toggle("chosen", arr.includes(Number(o.dataset.idx))));
                if (slot) {
                  const letters = arr.slice().sort((a, b) => a - b).map((n) => LETTER[n]).join("");
                  slot.textContent = letters;
                  slot.classList.toggle("filled", !!letters);
                }
              } else {
                const single = Number(opt.dataset.idx);
                obj[sidx] = single;
                sub.querySelectorAll(".opt").forEach((o) => o.classList.remove("chosen"));
                opt.classList.add("chosen");
                if (slot) { slot.textContent = LETTER[single]; slot.classList.add("filled"); }
              }
              this.setCurrent(qid); this.updateProgress(); this.saveDraft();
            });
          });
          sub.querySelectorAll(".blank").forEach((b) => this.bindBlank(b, qid, sidx));
          sub.querySelectorAll(".write-lines").forEach((w) => this.bindWrite(w, qid, sidx));
        });
      });

      sp.querySelectorAll('.q[data-qtype="fill_blank"] .blank').forEach((b) => {
        this.bindBlank(b, b.closest(".q").dataset.qid, null);
      });
      sp.querySelectorAll('.q[data-qtype="text"] .write-lines').forEach((w) => {
        this.bindWrite(w, w.closest(".q").dataset.qid, null);
      });

      sp.querySelectorAll(".q-mark").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (this.submitted) return;
          this.toggleMark(btn.closest(".q").dataset.qid);
        });
      });
      sp.querySelectorAll(".q").forEach((qEl) => {
        qEl.addEventListener("mousedown", () => this.setCurrent(qEl.dataset.qid));
      });
    });
  }

  bindBlank(b, qid, sidx) {
    b.addEventListener("input", () => {
      if (b.textContent.length > 16) {
        b.textContent = b.textContent.slice(0, 16);
        const r = document.createRange();
        r.selectNodeContents(b);
        r.collapse(false);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
      this.setAnswer(qid, sidx, b.textContent.trim() || undefined);
      this.setCurrent(qid); this.updateProgress(); this.saveDraft();
    });
    b.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); b.blur(); } });
    b.addEventListener("paste", (e) => {
      e.preventDefault();
      const txt = (e.clipboardData || window.clipboardData).getData("text");
      document.execCommand("insertText", false, txt.replace(/[\r\n]/g, " ").trim());
    });
  }

  bindWrite(w, qid, sidx) {
    w.addEventListener("input", () => {
      this.setAnswer(qid, sidx, w.innerText.replace(/\u00a0/g, " ").trim() || undefined);
      this.setCurrent(qid); this.updateProgress(); this.saveDraft();
    });
    w.addEventListener("focus", () => this.setCurrent(qid));
    w.addEventListener("paste", (e) => {
      e.preventDefault();
      const txt = (e.clipboardData || window.clipboardData).getData("text");
      document.execCommand("insertText", false, txt.replace(/\r/g, ""));
    });
    w.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); document.execCommand("insertLineBreak"); w.scrollTop = w.scrollHeight; }
    });
  }

  setAnswer(qid, sidx, value) {
    if (this.submitted || !this.started) return;
    if (sidx === null || sidx === undefined) {
      if (value === undefined) delete this.answers[qid];
      else this.answers[qid] = value;
    } else {
      const obj = this.answers[qid] = this.answers[qid] || {};
      if (value === undefined) delete obj[sidx];
      else obj[sidx] = value;
      if (!Object.keys(obj).length) delete this.answers[qid];
    }
  }

  toggleMark(qid) {
    if (this.marked[qid]) delete this.marked[qid]; else this.marked[qid] = true;
    this.spreads.forEach((sp) => {
      const qEl = sp.querySelector(`.q[data-qid="${qid}"]`);
      if (qEl) qEl.classList.toggle("marked", !!this.marked[qid]);
    });
    this.drawCardStates();
    this.saveDraft();
  }

  // ---------- 进度 / 答题卡 ----------

  isAnswered(qid) {
    const q = this.findQ(qid);
    if (!q) return false;
    const a = this.answers[qid];
    if (q.qtype === "material") {
      const subs = q.sub_questions;
      return subs.length > 0 && subs.every((sub) => {
        const v = a ? a[sub.subIndex] : undefined;
        return v !== undefined && v !== null && v !== "" && (!Array.isArray(v) || v.length > 0);
      });
    }
    if (Array.isArray(a)) return a.length > 0;
    return a !== undefined && a !== null && String(a) !== "";
  }
  findQ(id) { return this.questions.find((q) => String(q.id) === String(id)); }
  answeredCount() { return this.questions.filter((q) => this.isAnswered(q.id)).length; }

  updateProgress() {
    this.$(".ans-count").textContent = this.answeredCount();
    this.drawCardStates();
  }

  drawCard() {
    const body = this.$(".ac-body");
    body.innerHTML = "";
    this.$(".ac-total").textContent = this.questions.length;
    this.sections.forEach((sec) => {
      const g = document.createElement("div");
      g.className = "ac-group";
      const title = document.createElement("div");
      title.className = "ac-group-title";
      title.textContent = `${sec.cn}（${sec.ids.length} 题）`;
      const grid = document.createElement("div");
      grid.className = "ac-grid";
      sec.ids.forEach((qid) => {
        const c = document.createElement("div");
        c.className = "ac-cell";
        c.dataset.qid = qid;
        c.textContent = this.qIndex[qid];
        c.addEventListener("click", () => { this.closeCard(); this.goToQuestion(qid); });
        grid.appendChild(c);
      });
      g.append(title, grid);
      body.appendChild(g);
    });
  }

  drawCardStates() {
    let marks = 0;
    this.questions.forEach((q) => { if (this.marked[q.id]) marks++; });
    this.$(".ac-answered").textContent = this.answeredCount();
    this.$(".ac-marked").textContent = marks;
    this.$all(".ac-cell").forEach((c) => {
      const qid = c.dataset.qid;
      c.classList.toggle("answered", this.isAnswered(qid));
      c.classList.toggle("marked", !!this.marked[qid]);
      c.classList.toggle("current", String(qid) === String(this.currentQid));
    });
  }

  openCard() { this.$(".anscard").classList.add("open"); this.$(".btn-card").classList.add("on"); }
  closeCard() { this.$(".anscard").classList.remove("open"); this.$(".btn-card").classList.remove("on"); }

  // ---------- 草稿（与 take.js 共用 Rust 存储） ----------

  async saveDraft() {
    if (this.submitted) return;
    clearTimeout(this._draftDebounce);
    this._draftDebounce = setTimeout(async () => {
      try {
        await api.saveDraft(this.exam.id, {
          question_ids: this.questions.map((q) => q.id),
          answers: this.answers,
          marked: Object.keys(this.marked).map(Number),
          index: this.currentQid !== null ? this.questions.findIndex((q) => String(q.id) === String(this.currentQid)) : 0,
          remaining: this.remaining,
        });
      } catch {}
    }, 500);
  }

  applyDraft(draft) {
    if (!draft || typeof draft.answers !== "object" || !draft.answers) return false;
    let any = false;
    for (const q of this.questions) {
      const saved = draft.answers[q.id];
      if (saved === undefined || saved === null) continue;
      this.answers[q.id] = saved;
      any = true;
    }
    (draft.marked || []).forEach((id) => { this.marked[id] = true; });
    if (Number.isFinite(draft.remaining) && draft.remaining > 0) this.remaining = draft.remaining;
    return any;
  }

  startDraftTimer() {
    this.draftTimerId = setInterval(() => this.saveDraft(), 30000);
  }

  restoreToPaper() {
    this.questions.forEach((q) => {
      const qid = q.id;
      const a = this.answers[qid];
      const qEl = this.root.querySelector(`.q[data-qid="${qid}"]`);
      if (!qEl) return;
      if (this.marked[qid]) qEl.classList.add("marked");
      const t = q.qtype;
      const slot = qEl.querySelector(".answer-slot");
      if ((t === "single_choice" || t === "multiple_choice") && a !== undefined) {
        const arr = Array.isArray(a) ? a : [a];
        qEl.querySelectorAll(".opt").forEach((o) => o.classList.toggle("chosen", arr.includes(Number(o.dataset.idx))));
        if (slot) {
          const letters = Array.isArray(a) ? a.slice().sort((x, y) => x - y).map((n) => LETTER[n]).join("") : LETTER[a] || "";
          slot.textContent = letters;
          slot.classList.toggle("filled", !!letters);
        }
      } else if (t === "true_false" && a !== undefined) {
        qEl.querySelectorAll(".opt").forEach((o) => o.classList.toggle("chosen", o.dataset.val === a));
        if (slot) { slot.textContent = a === "正确" ? "√" : "×"; slot.classList.add("filled"); }
      } else if (t === "fill_blank" && typeof a === "string") {
        const b = qEl.querySelector(".blank");
        if (b) b.textContent = a;
      } else if (t === "text" && typeof a === "string") {
        const w = qEl.querySelector(".write-lines");
        if (w) w.innerText = a;
      } else if (t === "material" && a && typeof a === "object") {
        qEl.querySelectorAll(".subq").forEach((sub) => {
          const sidx = Number(sub.dataset.sidx);
          const v = a[sidx];
          if (v === undefined || v === null) return;
          const subSlot = sub.querySelector(".answer-slot");
          if (Array.isArray(v)) {
            sub.querySelectorAll(".opt").forEach((o) => o.classList.toggle("chosen", v.includes(Number(o.dataset.idx))));
            if (subSlot) {
              subSlot.textContent = v.slice().sort((x, y) => x - y).map((n) => LETTER[n]).join("");
              subSlot.classList.add("filled");
            }
          } else if (v === "正确" || v === "错误") {
            sub.querySelectorAll(".opt").forEach((o) => o.classList.toggle("chosen", o.dataset.val === v));
            if (subSlot) { subSlot.textContent = v === "正确" ? "√" : "×"; subSlot.classList.add("filled"); }
          } else if (typeof v === "number") {
            sub.querySelectorAll(".opt").forEach((o) => o.classList.toggle("chosen", Number(o.dataset.idx) === v));
            if (subSlot) { subSlot.textContent = LETTER[v] || ""; subSlot.classList.add("filled"); }
          } else {
            const blank = sub.querySelector(".blank");
            if (blank) blank.textContent = String(v);
            const wl = sub.querySelector(".write-lines");
            if (wl) wl.innerText = String(v);
          }
        });
      }
    });
  }

  // ---------- 草稿纸（canvas） ----------

  initPad() {
    this.padColor = "#1c1c28";
    this.padSize = 3.5;
    this.padErasing = false;
    this.padUndo = [];
    this.canvas = this.$(".pad-canvas");
    this.pctx = this.canvas.getContext("2d");
    this.padKey = `sim_pad_${this.exam.id}`;
    const root = this.root;

    root.querySelectorAll(".penbtn").forEach((b) => {
      b.addEventListener("click", () => {
        root.querySelectorAll(".penbtn").forEach((x) => x.classList.remove("sel"));
        b.classList.add("sel");
        this.padColor = b.dataset.pen;
        this.padErasing = false;
        this.$(".pad-eraser").classList.remove("sel");
      });
    });
    this.$(".pad-eraser").addEventListener("click", (e) => {
      this.padErasing = !this.padErasing;
      e.currentTarget.classList.toggle("sel", this.padErasing);
    });
    root.querySelectorAll(".pad-sizes .sz").forEach((b) => {
      b.addEventListener("click", () => {
        root.querySelectorAll(".pad-sizes .sz").forEach((x) => x.classList.remove("sel"));
        b.classList.add("sel");
        this.padSize = parseFloat(b.dataset.size);
      });
    });
    this.$(".pad-undo").addEventListener("click", () => this.padUndoStep());
    this.$(".pad-clear").addEventListener("click", () => {
      this.pushPadUndo();
      this.pctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.padSave();
    });

    const pos = (e) => {
      const r = this.canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (this.canvas.width / r.width),
        y: (e.clientY - r.top) * (this.canvas.height / r.height),
      };
    };
    let drawing = false, last = null;
    this.canvas.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      drawing = true;
      this.pushPadUndo();
      last = pos(e);
      this.padDab(last);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      const p = pos(e);
      this.padStroke(last, p);
      last = p;
    });
    const up = () => { if (drawing) { drawing = false; this.padSave(); } };
    this.canvas.addEventListener("pointerup", up);
    this.canvas.addEventListener("pointercancel", up);

    // 拖动
    const pad = this.$(".pad");
    const head = this.root.querySelector(".pad-head");
    let drag = null;
    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".pad-tool") || e.target.closest(".pad-sizes")) return;
      e.preventDefault();
      head.setPointerCapture(e.pointerId);
      const r = pad.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      pad.style.transform = "none";
    });
    head.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const x = Math.max(8, Math.min(root.clientWidth - 80, e.clientX - drag.dx));
      const y = Math.max(46, Math.min(root.clientHeight - 60, e.clientY - drag.dy));
      pad.style.left = x + "px";
      pad.style.top = y + "px";
    });
    head.addEventListener("pointerup", () => { drag = null; });

    // 恢复
    try {
      const saved = localStorage.getItem(this.padKey);
      if (saved) {
        const img = new Image();
        img.onload = () => this.pctx.drawImage(img, 0, 0);
        img.src = saved;
      }
    } catch {}
  }

  padSetup(c) {
    c.lineCap = "round";
    c.lineJoin = "round";
    c.lineWidth = this.padErasing ? this.padSize * 4 : this.padSize;
    c.strokeStyle = this.padColor;
  }
  padDab(p) {
    const c = this.pctx;
    c.save();
    this.padSetup(c);
    if (this.padErasing) c.globalCompositeOperation = "destination-out";
    c.beginPath();
    c.arc(p.x, p.y, c.lineWidth / 2, 0, Math.PI * 2);
    c.fillStyle = this.padColor;
    c.fill();
    c.restore();
  }
  padStroke(a, b) {
    const c = this.pctx;
    c.save();
    this.padSetup(c);
    if (this.padErasing) c.globalCompositeOperation = "destination-out";
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.stroke();
    c.restore();
  }
  pushPadUndo() {
    try {
      this.padUndo.push(this.canvas.toDataURL());
      if (this.padUndo.length > 25) this.padUndo.shift();
    } catch {}
  }
  padUndoStep() {
    const url = this.padUndo.pop();
    if (!url) return;
    this.pctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const img = new Image();
    img.onload = () => { this.pctx.drawImage(img, 0, 0); this.padSave(); };
    img.src = url;
  }
  padSave() {
    clearTimeout(this.padSaveTimer);
    this.padSaveTimer = setTimeout(() => {
      try { localStorage.setItem(this.padKey, this.canvas.toDataURL()); } catch {}
    }, 800);
  }
  openPad() { this.$(".pad").classList.remove("hidden"); this.$(".pad-tab").classList.remove("show"); this.$(".btn-pad").classList.add("on"); }
  closePad() { this.$(".pad").classList.add("hidden"); this.$(".pad-tab").classList.add("show"); this.$(".btn-pad").classList.remove("on"); }

  // ---------- 计时 / 防作弊 ----------

  startTimer() {
    const tick = () => {
      if (this.submitted) return;
      this.remaining -= 1;
      const clock = this.$(".clock-time");
      clock.textContent = fmtHms(Math.max(0, this.remaining));
      clock.classList.toggle("warn", this.remaining <= 300);
      if (this.remaining <= 0) {
        this.forceFinish("考试时间已到，系统已自动交卷。");
        return;
      }
      this.timerId = setTimeout(tick, 1000);
    };
    this.$(".clock-time").textContent = fmtHms(this.remaining);
    tick();
  }

  bindAntiCheat() {
    this.on(document, "visibilitychange", () => {
      if (!document.hidden || this.submitted || !this.started) return;
      this.violations += 1;
      if (this.violations >= 3) {
        this.forceFinish(`检测到您第 ${this.violations} 次离开考试页面，根据反作弊规则，考试已被强制终止。`);
      } else if (this.violations === 1) {
        this.showWarn("警告：检测到您离开了考试页面，已记录 1/3 次");
      } else {
        this.showWarn(`严重警告：检测到您离开了考试页面，已记录 ${this.violations}/3 次，再次离开将自动终止考试！`, true);
      }
    });
    this.on(document, "contextmenu", (e) => {
      if (this.started && !this.submitted) { e.preventDefault(); this.showWarn("考试期间禁止使用右键菜单"); }
    });
    this.on(document, "keydown", (e) => {
      if (e.key === "F12" || (e.ctrlKey && e.shiftKey && e.key === "I")) {
        e.preventDefault();
        if (this.started && !this.submitted) this.showWarn("考试期间禁止打开开发者工具");
      }
      if (!this.started || this.submitted) return;
      const ae = document.activeElement;
      const editing = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
      if (editing) return;
      if (e.key === "ArrowLeft") this.flipTo(this.curSpread - 1);
      if (e.key === "ArrowRight") this.flipTo(this.curSpread + 1);
      if ((e.key === "m" || e.key === "M") && this.currentQid !== null) { e.preventDefault(); this.toggleMark(this.currentQid); }
      if (e.key === "c" || e.key === "C") { this.$(".anscard").classList.contains("open") ? this.closeCard() : this.openCard(); }
    });
  }

  showWarn(msg, danger) {
    const banner = this.$(".warn-banner");
    this.root.querySelector(".warn-text").textContent = msg;
    banner.className = danger ? "warn-banner danger" : "warn-banner";
    banner.style.display = "flex";
    clearTimeout(this._warnTimer);
    this._warnTimer = setTimeout(() => { banner.style.display = "none"; }, danger ? 8000 : 5000);
  }

  // ---------- 交卷 ----------

  askSubmit() {
    if (this.submitted || !this.started) return;
    const miss = [];
    this.questions.forEach((q, i) => { if (!this.isAnswered(q.id)) miss.push(i + 1); });
    this.root.querySelector(".confirm-body").innerHTML = miss.length
      ? `还有 <b class="miss-list">${miss.join("、")}</b> 共 ${miss.length} 题未作答。<br>交卷后将无法继续修改，确定交卷吗？`
      : "所有题目均已作答。<br>交卷后将无法继续修改，确定交卷吗？";
    this.$(".confirm-modal").classList.add("show");
  }

  async submitExam() {
    if (this.submitted) return;
    this.submitted = true;
    clearTimeout(this.timerId);
    clearInterval(this.draftTimerId);
    this.closeCard();
    this.closePad();
    try { await api.clearDraft(this.exam.id); } catch {}
    try { localStorage.removeItem(this.padKey); } catch {}

    let env;
    try {
      env = await api.postJSON("backend/api/exam/submit.php", {
        exam_id: this.exam.id,
        record_id: this.recordId,
        answers: this.answers,
        marked_questions: Object.keys(this.marked).map(Number),
        cheat_violations: this.violations,
      });
    } catch (e) {
      this.submitted = false;
      this.showWarn("交卷失败：" + e.message + "（已恢复考试状态）", true);
      this.startTimer();
      this.startDraftTimer();
      return;
    }
    this.showResult(env.data || env);
  }

  forceFinish(message) {
    if (this.submitted) return;
    confirmModal("考试终止", message, () => {}, "我知道了");
    this.submitExam();
  }

  showResult(data) {
    const used = Math.max(0, this.total - this.remaining);
    const done = this.answeredCount();
    this.root.querySelector(".rc-score").textContent = fmtScore(data.total_score ?? 0);
    this.root.querySelector(".rc-full").textContent = fmtScore(this.exam.total_score);
    this.root.querySelector(".rc-pass").innerHTML = data.is_passed
      ? '<span class="rc-pass">及　格</span>' : '<span class="rc-fail">未及格</span>';
    let html =
      `用时：<b>${Math.floor(used / 60)}</b> 分 <b>${used % 60}</b> 秒<br>` +
      `已作答：<b>${done}</b> / ${this.questions.length} 题<br>` +
      `答对：<b>${data.correct_count || 0}</b> 题次（含材料小题）<br>` +
      `切出页面：<b>${this.violations}</b> 次`;
    if (data.status === "cheated") html += '<br><span class="rc-note">（切屏超限，考试已被强制终止）</span>';
    else if (this.remaining <= 0) html += '<br><span class="rc-note">（考试时间到，自动交卷）</span>';
    this.root.querySelector(".rc-detail").innerHTML = html;
    this.$(".rc-back").onclick = () => go("exams");
    // 历史成绩属于「学习记录」插件：未安装时隐藏该按钮
    const rcHistory = this.$(".rc-history");
    if (isPluginActive("study-records")) {
      rcHistory.onclick = () => go("history");
    } else {
      rcHistory.style.display = "none";
    }
    this.$(".confirm-modal").classList.remove("show");
    this.$(".result").classList.add("show");
  }

  // ---------- 视差 / 缩放 ----------

  fitPaper() {
    const scaler = this.root.querySelector(".paper-scaler");
    scaler.style.setProperty("--s", 1);
    const sp = this.spreads[this.curSpread] || this.spreads[0];
    if (!sp) return;
    const s = Math.min((this.root.clientHeight * 0.9) / 877, (this.root.clientWidth * 0.94) / 1240, 1);
    scaler.style.setProperty("--s", s.toFixed(4));
  }

  parallaxLoop() {
    let tRX = 13, tRY = 0, tRZ = -0.4, cRX = 13, cRY = 0, cRZ = -0.4;
    this.on(window, "mousemove", (e) => {
      const nx = e.clientX / Math.max(1, this.root.clientWidth) - 0.5;
      const ny = e.clientY / Math.max(1, this.root.clientHeight) - 0.5;
      tRX = 13 - ny * 3.4;
      tRY = nx * 2.8;
      tRZ = -0.4 + nx * 0.45;
    });
    const p3d = this.root.querySelector(".paper-3d");
    const loop = () => {
      cRX += (tRX - cRX) * 0.075;
      cRY += (tRY - cRY) * 0.075;
      cRZ += (tRZ - cRZ) * 0.075;
      p3d.style.transform = `rotateX(${cRX.toFixed(3)}deg) rotateY(${cRY.toFixed(3)}deg) rotateZ(${cRZ.toFixed(3)}deg)`;
      this.rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  // ---------- 静态事件 ----------

  bindChromeEvents() {
    const r = this.root;
    r.querySelector(".btn-card").addEventListener("click", () => {
      this.$(".anscard").classList.contains("open") ? this.closeCard() : this.openCard();
    });
    r.querySelector(".ac-close").addEventListener("click", () => this.closeCard());
    r.querySelector(".btn-pad").addEventListener("click", () => this.openPad());
    r.querySelector(".pad-tab").addEventListener("click", () => this.openPad());
    r.querySelector(".nav-prev").addEventListener("click", () => this.flipTo(this.curSpread - 1));
    r.querySelector(".nav-next").addEventListener("click", () => this.flipTo(this.curSpread + 1));
    r.querySelector(".submit-btn").addEventListener("click", () => this.askSubmit());
    r.querySelector(".ac-submit").addEventListener("click", () => { this.closeCard(); this.askSubmit(); });
    r.querySelector(".confirm-no").addEventListener("click", () => this.$(".confirm-modal").classList.remove("show"));
    r.querySelector(".confirm-yes").addEventListener("click", () => {
      this.$(".confirm-modal").classList.remove("show");
      this.submitExam();
    });
    r.querySelector(".wb-close").addEventListener("click", () => { this.$(".warn-banner").style.display = "none"; });
    r.querySelector(".intro").addEventListener("click", () => {
      if (this.started) return;
      this.started = true;
      this.$(".intro").classList.add("hide");
      this.startTimer();
    });
  }
}

function cnNum(n) {
  const s = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  if (n <= 10) return s[n - 1];
  if (n < 20) return "十" + s[n - 11];
  return s[Math.floor(n / 10) - 1] + "十" + (n % 10 ? s[n % 10 - 1] : "");
}

const PEN_SVG = `
<svg class="pen" viewBox="0 0 300 46" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="simPenBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#4a4a52"/><stop offset="28%" stop-color="#22222a"/>
      <stop offset="55%" stop-color="#121218"/><stop offset="100%" stop-color="#2e2e36"/>
    </linearGradient>
    <linearGradient id="simPenClip" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#d9dde4"/><stop offset="50%" stop-color="#8d939c"/><stop offset="100%" stop-color="#c3c8cf"/>
    </linearGradient>
    <linearGradient id="simPenTip" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#c9ced6"/><stop offset="45%" stop-color="#7e848d"/><stop offset="100%" stop-color="#b6bbc3"/>
    </linearGradient>
  </defs>
  <rect x="248" y="15" width="42" height="16" rx="8" fill="url(#simPenBody)"/>
  <rect x="255" y="15" width="4" height="16" fill="#5b6068" opacity=".55"/>
  <rect x="70" y="13" width="186" height="20" rx="9" fill="url(#simPenBody)"/>
  <rect x="70" y="13" width="186" height="6" rx="3" fill="#ffffff" opacity=".07"/>
  <rect x="228" y="6" width="34" height="7" rx="3.5" fill="url(#simPenClip)"/>
  <rect x="96" y="13.5" width="52" height="19" rx="6" fill="#17171d" opacity=".9"/>
  <rect x="100" y="15" width="44" height="3" rx="1.5" fill="#ffffff" opacity=".06"/>
  <rect x="100" y="22" width="44" height="3" rx="1.5" fill="#ffffff" opacity=".05"/>
  <path d="M70 13 L70 33 L30 26.5 L30 19.5 Z" fill="url(#simPenTip)"/>
  <path d="M70 13 L70 20 L34 19.5 L70 13 Z" fill="#ffffff" opacity=".18"/>
  <path d="M30 19.5 L30 26.5 L8 24.6 L8 21.4 Z" fill="#3d4249"/>
  <path d="M8 21.4 L8 24.6 L0 23.6 L0 22.4 Z" fill="#1c1f24"/>
</svg>`;
