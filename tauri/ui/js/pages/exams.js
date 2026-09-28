// 真题市场（原考试中心）：筛选（科目/难度/价格/关键词）+ 卡片栅格 + 价格/公益免费标识 + 余额购买 + 收藏 + 缓存 + 开始考试
// 数据：page/exam_list.php（filters.available_subjects + exams[]，含 price/author_name/is_purchased/is_creator）

import { api } from "../api.js";
import { el, clear, loadingBox, errorBox, emptyBox, chip, pager, fmtScore, toastOk, toastErr, modal, htmlToText, renderMathIn } from "../ui.js";
import { go } from "../router.js";
import { refreshShellBalance } from "./shell.js";
import { normalizeQ } from "./take.js";

const LETTER = "ABCDEFGH";

const state = { page: 1, subject: "", difficulty: "", free: "", keyword: "", totalPages: 1 };

// 是否需购买（真题市场）：付费且未购买且非作者
function needsPurchase(e) {
  return Number(e.price) > 0 && !e.is_purchased && !e.is_creator;
}

export async function renderExams(container) {
  const inner = el("div");
  container.append(inner);
  await draw(inner);
}

async function draw(inner) {
  clear(inner).append(loadingBox("正在加载考试列表…"));
  let env;
  try {
    env = await api.get("backend/api/page/exam_list.php", {
      page: state.page,
      subject: state.subject,
      difficulty: state.difficulty,
      free: state.free,
      keyword: state.keyword,
      search: state.keyword, // 接口筛选键为 search；双传兼容
    });
  } catch (e) {
    return clear(inner).append(errorBox(e.message, () => draw(inner)));
  }
  const data = env.data || {};
  const exams = data.exams || [];
  state.totalPages = data.pagination?.total_pages ?? data.total_pages ?? 1;
  clear(inner);

  // 接口不提供科目清单：从当前结果提取
  const subjects = [...new Set(exams.map((e) => e.subject).filter(Boolean))];

  // 工具栏
  const kw = el("input", { class: "input", placeholder: "搜索考试名称…" });
  kw.value = state.keyword;
  kw.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { state.keyword = kw.value.trim(); state.page = 1; draw(inner); }
  });
  const selSub = el("select", { class: "input" },
    el("option", { value: "" }, "全部科目"),
    ...subjects.map((s) => el("option", { value: s, selected: s === state.subject ? "" : undefined }, s)));
  selSub.addEventListener("change", () => { state.subject = selSub.value; state.page = 1; draw(inner); });
  // 后端 exam_list.php 的难度映射键为 easy/medium/hard（数字值会落入默认"中等"）
  const diffs = [["", "全部难度"], ["easy", "简单"], ["medium", "中等"], ["hard", "困难"]];
  const selDiff = el("select", { class: "input" },
    ...diffs.map(([v, t]) => el("option", { value: v, selected: v === state.difficulty ? "" : undefined }, t)));
  selDiff.addEventListener("change", () => { state.difficulty = selDiff.value; state.page = 1; draw(inner); });
  const selPrice = el("select", { class: "input" },
    el("option", { value: "", selected: state.free === "" ? "" : undefined }, "全部价格"),
    el("option", { value: "1", selected: state.free === "1" ? "" : undefined }, "只看公益免费"));
  selPrice.addEventListener("change", () => { state.free = selPrice.value; state.page = 1; draw(inner); });

  inner.append(el("div", { class: "toolbar-row" }, selSub, selDiff, selPrice, kw));

  if (!exams.length) {
    inner.append(emptyBox("没有符合条件的考试", "换个筛选条件试试"));
    return;
  }

  // 缓存状态
  const cached = new Set((await api.listCachedPapers()).map((c) => Number(c.exam_id)));

  const grid = el("div", { class: "grid cols-3" });
  for (const e of exams) {
    grid.append(examCard(e, cached.has(Number(e.id)), inner));
  }
  inner.append(grid);
  const pg = pager({ page: state.page, totalPages: state.totalPages, onGo: (p) => { state.page = p; draw(inner); } });
  if (pg) inner.append(pg);
}

function examCard(e, isCached, inner) {
  let isFav = !!e.is_favorite;
  const toBuy = needsPurchase(e);
  const favBtn = el("button", { class: "btn sm ghost fav", title: "收藏" }, isFav ? "♥" : "♡");

  async function toggleFav() {
    // 付费未购试卷不能收藏（收藏即持有可考试，需先购买）
    if (toBuy) { toastErr("付费试卷需先购买后再收藏"); return; }
    try {
      // 该接口读 php://input（JSON body），必须用 postJSON；用 api.post(urlencoded) 会静默失败
      await api.postJSON("backend/api/toggle_favorite.php", { exam_id: e.id });
      isFav = !isFav;
      favBtn.textContent = isFav ? "♥" : "♡";
      favBtn.style.color = isFav ? "var(--danger)" : "";
      toastOk(isFav ? "已收藏" : "已取消收藏");
    } catch (err) { toastErr(err.message); }
  }
  favBtn.addEventListener("click", (ev) => { ev.stopPropagation(); toggleFav(); });
  if (isFav) favBtn.style.color = "var(--danger)";

  const diffText = { easy: "简单", medium: "中等", hard: "困难" }[e.difficulty] || e.difficulty || "";

  // 市场状态角标：我的发布 / 已购 / 价格 / 公益免费
  const marketChipEl = e.is_creator
    ? chip(Number(e.price) > 0 ? `已发布 ¥${Number(e.price).toFixed(2)}` : "公益免费", "sky")
    : e.is_purchased
      ? chip("已购", "mint")
      : Number(e.price) > 0
        ? chip(`¥${Number(e.price).toFixed(2)}`, "warn")
        : chip("公益免费", "mint");

  // 操作区：付费未购只留「购买 + 收藏」（开始/仿真/刷题/缓存对未购者会被服务端拦截）
  const actionBtns = [];
  if (toBuy) {
    actionBtns.push(el("button", {
      class: "btn sm primary",
      onclick: (ev) => { ev.stopPropagation(); buyExam(e, inner); },
    }, `¥${Number(e.price).toFixed(2)} 购买`));
  } else {
    actionBtns.push(
      el("button", { class: "btn sm primary", onclick: () => go(`take/${e.id}`) }, e.attempt_count ? "再考一次" : "开始考试"),
      el("button", { class: "btn sm", onclick: () => go(`mock/${e.id}`) }, "仿真"),
      el("button", { class: "btn sm", onclick: () => go(`practice/${e.id}`) }, "刷题"),
    );
    // 缓存按钮只做状态区分：未缓存可点击缓存，已缓存置灰（更新/删除在「本地题库」页管理）
    const cacheBtn = el("button", { class: "btn sm" }, isCached ? "已缓存" : "缓存");
    if (isCached) {
      cacheBtn.disabled = true;
      cacheBtn.title = "已缓存到本地题库，更新或删除请到「本地题库」页";
    } else {
      cacheBtn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        cacheBtn.disabled = true;
        cacheBtn.textContent = "缓存中…";
        try {
          const env = await api.get("backend/api/exam.php", { action: "detail", id: e.id });
          // detail 返回扁平结构 {success, exam:{...,questions:[]}}——questions 嵌在 exam 内
          const examObj = env.data?.exam || env.exam || env.data || {};
          const questions = env.data?.questions || env.questions || examObj.questions || [];
          // 剥离 exam 内嵌的 questions 与 questions_json 快照（体积翻倍且无必要），分离存储
          const { questions: _nested, questions_json: _snap, ...examMeta } = examObj;
          const paper = { exam: { ...examMeta, cached_at: new Date().toISOString().slice(0, 19).replace("T", " ") }, questions };
          await api.cachePaper(e.id, paper);
          cacheBtn.textContent = "已缓存";
          toastOk("已缓存到本地题库，可离线刷题");
        } catch (err) {
          toastErr("缓存失败：" + err.message);
          cacheBtn.textContent = "缓存";
          cacheBtn.disabled = false;
        }
      });
    }
    actionBtns.push(cacheBtn);
  }
  actionBtns.push(favBtn);

  const card = el("div", {
    class: "card hoverable exam-card exam-card-preview",
    title: toBuy ? "付费试卷，购买后可预览与作答" : "点击预览试卷",
    // 只有卡片空白处的点击才是"预览"；按钮区的点击会冒泡到卡片，若不排除会同时触发预览弹窗
    onclick: (ev) => { if (ev.target.closest(".actions")) return; toBuy ? previewPurchase(e, inner) : previewExam(e); }
  },
    el("div", { class: "title" }, e.title || "考试"),
    el("div", { class: "meta" },
      e.subject ? chip(e.subject, "sky") : null,
      (e.difficulty_name || e.difficulty_label) ? chip(e.difficulty_name || e.difficulty_label, "warn") : null,
      marketChipEl,
      e.attempt_count ? chip(`已考 ${e.attempt_count} 次`) : null,
      (e.best_score !== null && e.best_score !== undefined && e.best_score !== false) ? chip(`最高 ${fmtScore(e.best_score)} 分`, "mint") : null),
    el("div", { class: "desc" },
      [e.author_name ? `作者 ${e.author_name}` : "", e.duration ? `${e.duration} 分钟` : "", e.question_count ? `${e.question_count} 题` : "", e.total_score ? `满分 ${fmtScore(e.total_score)}` : ""].filter(Boolean).join(" · ")),
    el("div", { class: "actions" }, ...actionBtns)
  );
  return card;
}

// ---------------- 余额购买（真题市场） ----------------

async function buyExam(e, inner) {
  const price = Number(e.price) || 0;
  let balance = 0;
  try {
    // purchase.php get_balance 为扁平信封 {success, balance, ...}
    const env = await api.get("backend/api/purchase.php", { action: "get_balance" });
    balance = Number(env?.data?.balance ?? env?.balance) || 0;
  } catch { /* 获取失败按 0 处理，支付时服务端仍会兜底 */ }

  const shortage = Math.max(0, price - balance);
  const body = el("div", { style: "font-size:var(--fs-body);line-height:2.1;color:var(--text-2)" },
    el("div", { style: "color:var(--text-1);font-weight:600" }, e.title || ""),
    el("div", {}, "价格：", el("span", { style: "color:var(--warn);font-weight:700" }, `¥${price.toFixed(2)}`)),
    el("div", {}, `当前余额：¥${balance.toFixed(2)}`),
    shortage > 0
      ? el("div", { style: "color:var(--danger);font-size:var(--fs-small)" }, `余额不足，还需 ¥${shortage.toFixed(2)}。请先在侧边栏「充值」补充余额后再购买。`)
      : el("div", { style: "font-size:var(--fs-tiny);color:var(--text-3)" }, "支付使用账户余额，购买后永久可用。"));

  modal({
    title: "确认购买",
    body,
    actions: shortage > 0 ? [] : [{
      label: `确认支付 ¥${price.toFixed(2)}`,
      kind: "primary",
      onClick: async () => {
        // purchase.php 从 $_GET 读 action，业务参数走 JSON body
        const env = await api.postJSON(
          "backend/api/purchase.php",
          { product_type: "exam", product_id: e.id },
          { action: "pay" },
        );
        toastOk(env.message || "购买成功，已可开始考试");
        refreshShellBalance().catch(() => {});
        draw(inner);
      },
    }],
  });
}

// 付费未购试卷的预览：只展示市场信息，不拉取题目内容（服务端也会拒绝）
function previewPurchase(e, inner) {
  const price = Number(e.price) || 0;
  const body = el("div", { style: "font-size:var(--fs-body);line-height:2;color:var(--text-2)" },
    e.author_name ? el("div", {}, `作者：${e.author_name}`) : null,
    el("div", {}, [e.duration ? `${e.duration} 分钟` : "", e.question_count ? `${e.question_count} 题` : "", e.total_score ? `满分 ${fmtScore(e.total_score)}` : ""].filter(Boolean).join(" · ")),
    el("div", { style: "margin-top:6px" }, htmlToText(e.description || "") || "暂无描述"),
    el("div", { style: "color:var(--text-3);font-size:var(--fs-tiny);margin-top:8px" }, "题目详情购买后可见；支付使用账户余额，购买后永久可用。"));

  modal({
    title: e.title || "试卷",
    body,
    actions: [{
      label: `¥${price.toFixed(2)} 立即购买`,
      kind: "primary",
      onClick: () => buyExam(e, inner),
    }],
  });
}

// ---------------- 试卷预览（点击卡片弹出，只读、不含答案与解析） ----------------

async function previewExam(e) {
  const body = el("div", { style: "max-height:75vh;overflow-y:auto;padding-right:4px" },
    loadingBox("正在加载试卷…"));
  modal({
    title: `预览：${e.title || "考试"}`,
    wide: true,
    body,
    actions: [{ label: "开始考试", kind: "primary", onClick: () => go(`take/${e.id}`) }],
  });

  // 数据源：practice.php（无副作用、含材料子题；与刷题按钮同源），失败回退本地缓存卷
  let paper = null;
  try {
    const env = await api.get("backend/api/exam/practice.php", { exam_id: e.id });
    paper = { exam: env.data?.exam || env.exam || {}, questions: env.data?.questions || env.questions || [] };
  } catch { /* 离线或失败：尝试缓存 */ }
  if (!paper.questions?.length) {
    try { paper = await api.getCachedPaper(e.id); } catch { paper = null; }
  }
  if (!paper?.questions?.length) {
    clear(body).append(errorBox("无法获取试卷内容（离线且无本地缓存）"));
    return;
  }
  const qs = paper.questions.map(normalizeQ);
  clear(body);
  body.append(el("div", { class: "pv-head" },
    e.subject ? chip(e.subject, "sky") : null,
    (e.difficulty_name || e.difficulty_label) ? chip(e.difficulty_name || e.difficulty_label, "warn") : null,
    e.duration ? chip(`${e.duration} 分钟`) : null,
    qs.length ? chip(`${qs.length} 题`) : null,
    e.total_score ? chip(`满分 ${fmtScore(e.total_score)}`, "mint") : null,
    el("span", { style: "color:var(--text-3);font-size:var(--fs-tiny);margin-left:auto" }, "预览不含答案与解析")));
  qs.forEach((q, i) => body.append(pvQ(q, i, qs.length)));
  renderMathIn(body);
}

function pvQ(q, idx, total) {
  const box = el("div", { class: "card pv-q" },
    el("div", { class: "pv-qhead" },
      el("span", { class: "pv-no" }, `第 ${idx + 1}/${total} 题`),
      chip(q.type_name || "题目", "sky"),
      q.score ? el("span", { class: "pv-score" }, `${fmtScore(q.score)} 分`) : null),
    el("div", { class: "pv-content" }, htmlToText(q.content) || "（空题干）"),
    pvOptions(q));
  for (const [si, s] of (q.sub_questions || []).entries()) {
    box.append(el("div", { class: "pv-subq" },
      el("div", { class: "pv-sqtitle" },
        `（${si + 1}）`, s.type_name ? ` ${s.type_name}` : "", s.score ? ` · ${fmtScore(s.score)} 分` : ""),
      el("div", { class: "pv-content" }, htmlToText(s.content) || "（空题干）"),
      pvOptions(s)));
  }
  return box;
}

function pvOptions(q) {
  if (!q.options?.length) return null;
  const opts = el("div", { class: "pv-opts" });
  q.options.forEach((o, i) => opts.append(el("div", { class: "pv-opt" },
    el("span", { class: "pv-letter" }, `${LETTER[i]}. `),
    String(o ?? ""))));
  return opts;
}
