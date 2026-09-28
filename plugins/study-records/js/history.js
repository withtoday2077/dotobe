// 历史成绩：统计卡 + 得分率走势（SVG 自绘，发丝细线）+ 科目/分布分析 + 记录表（可删除）。
// 标签页：考试记录 / 刷题记录（go("history/practice") 直达刷题标签）。
// 数据：page/history.php（表格分页）+ page/history.php?per_page=100（分析数据）+ practice/records.php（刷题记录）。
// 删除：history/delete.php（级联清理答题/成绩明细）、practice/record_delete.php（刷题记录）。

import { api } from "api";
import { el, clear, loadingBox, errorBox, emptyBox, chip, pager, fmtScore, fmtDate, toastOk, toastErr, confirmModal, svgEl, modal, htmlToText, renderMathIn } from "ui";
import { go } from "router";

const state = { page: 1, status: "", totalPages: 1 };
let analysisRecords = []; // 近期记录全集（供三张图），删除后同步失效重取

// 标签页与刷题记录分页状态
let activeTab = "exam"; // 'exam' | 'practice'
let pState = { page: 1, totalPages: 1 };
let currentInner = null;

export async function renderHistory(container, param) {
  activeTab = param === "practice" ? "practice" : "exam";
  const inner = el("div");
  container.append(inner);
  currentInner = inner;
  analysisRecords = [];
  if (activeTab === "practice") {
    await drawPractice(inner);
  } else {
    await draw(inner);
  }
}

// 标签栏（考试记录 / 刷题记录）
function tabBar() {
  return el("div", { style: "display:flex;gap:8px;margin-bottom:14px" },
    el("button", { class: `btn ${activeTab === "exam" ? "primary" : ""}`, onclick: () => switchTab("exam") }, "考试记录"),
    el("button", { class: `btn ${activeTab === "practice" ? "primary" : ""}`, onclick: () => switchTab("practice") }, "刷题记录"));
}

function switchTab(tab) {
  if (tab === activeTab || !currentInner) return;
  activeTab = tab;
  if (tab === "practice") drawPractice(currentInner);
  else draw(currentInner);
}

async function draw(inner) {
  clear(inner).append(tabBar(), loadingBox("正在加载历史成绩…"));
  let env, anaEnv;
  try {
    // 表格分页数据 + 分析全集并行获取
    [env, anaEnv] = await Promise.all([
      api.get("backend/api/page/history.php", { page: state.page, status: state.status }),
      analysisRecords.length
        ? Promise.resolve({ data: { records: analysisRecords } })
        : api.get("backend/api/page/history.php", { page: 1, per_page: 100 }),
    ]);
  } catch (e) {
    return clear(inner).append(errorBox(e.message, () => draw(inner)));
  }
  const data = env.data || {};
  const records = data.records || [];
  analysisRecords = anaEnv?.data?.records || [];
  state.totalPages = data.pagination?.total_pages ?? data.total_pages ?? 1;
  const stats = data.statistics || {};

  clear(inner);
  inner.append(tabBar());

  inner.append(el("div", { class: "grid cols-4" },
    el("div", { class: "card stat sky" }, el("div", { class: "label" }, "考试总数"), el("div", { class: "value" }, String(stats.total_exams ?? records.length ?? 0))),
    el("div", { class: "card stat mint" }, el("div", { class: "label" }, "通过次数"), el("div", { class: "value" }, String(stats.passed_exams ?? "—"))),
    el("div", { class: "card stat pink" }, el("div", { class: "label" }, "平均得分"), el("div", { class: "value" }, fmtScore(stats.average_score ?? 0))),
    el("div", { class: "card stat warn" }, el("div", { class: "label" }, "通过率"), el("div", { class: "value" }, fmtScore(stats.pass_rate ?? 0) + "%"))));

  // —— 分析区：走势 + 科目 + 分布（基于近期记录全集）——
  const completed = analysisRecords
    .filter((r) => r.status === "completed" && r.score_percentage != null)
    .sort((a, b) => String(a.completed_at || "").localeCompare(String(b.completed_at || "")));
  const trend = completed.slice(-12);

  inner.append(el("div", { class: "section-gap" }), lineChart(trend));
  inner.append(el("div", { class: "section-gap" }));
  inner.append(el("div", { class: "grid cols-2" },
    subjectChart(completed),
    distChart(completed)));

  // —— 记录表 ——
  inner.append(el("div", { class: "section-gap" }));
  if (!records.length) {
    inner.append(emptyBox("暂无考试记录"));
    return;
  }
  const tbody = el("tbody");
  for (const r of records) {
    const passed = r.score_percentage !== undefined
      ? r.score_percentage >= 60
      : (Number(r.score) >= Number(r.passing_score ?? 60));
    tbody.append(el("tr", { style: "cursor:pointer", onclick: () => go(`review/${r.exam_id},${r.record_id}`) },
      el("td", { style: "max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, r.title || "考试"),
      el("td", {}, fmtScore(r.score)),
      el("td", {}, fmtScore(r.total_score ?? "—")),
      el("td", {}, chip(passed ? "通过" : "未通过", passed ? "mint" : "pink")),
      el("td", { style: "color:var(--text-3);font-size:var(--fs-small)" }, fmtDate(r.completed_at)),
      el("td", { style: "text-align:right" },
        el("button", {
          class: "btn sm danger ghost",
          title: "删除这条记录",
          onclick: (ev) => { ev.stopPropagation(); deleteRecord(inner, r); },
        }, "删除"))));
  }
  inner.append(el("div", { class: "card" },
    el("table", { class: "table" },
      el("thead", {}, el("tr", {},
        el("th", {}, "考试"), el("th", {}, "得分"), el("th", {}, "满分"), el("th", {}, "状态"), el("th", {}, "时间"), el("th", {}))),
      tbody)));
  const pg = pager({ page: state.page, totalPages: state.totalPages, onGo: (p) => { state.page = p; draw(inner); } });
  if (pg) inner.append(pg);
}

// 删除一条考试记录（后端级联清理答题/成绩明细/警示）
function deleteRecord(inner, r) {
  confirmModal("删除考试记录",
    `确定删除「${r.title || "考试"}」（${fmtDate(r.completed_at)}）吗？` +
    "答题记录与成绩明细将一并删除，且不可恢复。",
    async () => {
      try {
        await api.post("backend/api/history/delete.php", { record_id: r.record_id });
        toastOk("已删除");
        analysisRecords = []; // 分析数据失效，重取
        // 当前页删空则回退一页
        const remaining = document.querySelectorAll("tbody tr").length;
        if (remaining <= 1 && state.page > 1) state.page -= 1;
        await draw(inner);
      } catch (e) {
        toastErr("删除失败：" + e.message);
      }
    }, "删除", "danger");
}

// ---------------- 刷题记录标签 ----------------

async function drawPractice(inner) {
  clear(inner).append(tabBar(), loadingBox("正在加载刷题记录…"));
  let data;
  try {
    const env = await api.get("backend/api/practice/records.php", { page: pState.page, per_page: 10 });
    data = env.data ? env.data : env;
  } catch (e) {
    return clear(inner).append(tabBar(), errorBox(e.message, () => drawPractice(inner)));
  }
  const records = data.records || [];
  const summary = data.summary || {};
  pState.totalPages = data.total_pages ?? 1;

  clear(inner).append(tabBar());

  inner.append(el("div", { class: "grid cols-4" },
    pStatCard("总记录数", summary.total ?? 0, "sky"),
    pStatCard("进行中", summary.in_progress ?? 0, "warn"),
    pStatCard("已完成", summary.completed ?? 0, "mint"),
    pStatCard("未完成", summary.abandoned ?? 0, "pink")));

  inner.append(el("div", { class: "banner", style: "margin:12px 0" },
    "每次刷题独立成记录（单张试卷最多保留 10 条），中途退出自动保存进度；记录需手动删除。"));

  if (!records.length) {
    inner.append(emptyBox("暂无刷题记录", "在考试中心选择「刷题模式」即可开始"));
    return;
  }

  const tbody = el("tbody");
  for (const r of records) {
    const statusChip = r.status === "completed" ? chip("已完成", "mint")
      : r.status === "in_progress" ? chip("进行中", "warn") : chip("未完成", "pink");
    tbody.append(el("tr", {},
      el("td", { style: "max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, r.exam_title || "刷题"),
      el("td", {}, statusChip),
      el("td", {}, `${r.answered}/${r.total_questions}`),
      el("td", {}, `${r.correct_count} / ${r.wrong_count}`),
      el("td", {}, `${fmtScore(r.accuracy)}%`),
      el("td", { style: "color:var(--text-3);font-size:var(--fs-small)" }, fmtDate(r.completed_at || r.last_activity_at)),
      el("td", { style: "text-align:right;white-space:nowrap" },
        el("button", { class: "btn sm", onclick: () => openPracticeDetail(r.id) }, "详情"),
        r.status === "in_progress" ? el("button", { class: "btn sm primary", style: "margin-left:6px", onclick: () => go(`practice/${r.exam_id}`) }, "继续") : null,
        r.wrong_count > 0 ? el("button", { class: "btn sm", style: "margin-left:6px", title: "重刷本条记录中的错题", onclick: () => go(`practice/${r.exam_id}/redo/${r.id}`) }, "重刷") : null,
        el("button", { class: "btn sm danger ghost", style: "margin-left:6px", onclick: () => deletePracticeRecord(r) }, "删除"))));
  }
  inner.append(el("div", { class: "card" },
    el("table", { class: "table" },
      el("thead", {}, el("tr", {},
        el("th", {}, "试卷"), el("th", {}, "状态"), el("th", {}, "进度"), el("th", {}, "对/错"),
        el("th", {}, "正确率"), el("th", {}, "时间"), el("th", {}))),
      tbody)));
  const pg = pager({ page: pState.page, totalPages: pState.totalPages, onGo: (p) => { pState.page = p; drawPractice(currentInner); } });
  if (pg) inner.append(pg);
}

function pStatCard(label, value, tone) {
  return el("div", { class: `card stat ${tone}` },
    el("div", { class: "label" }, label), el("div", { class: "value" }, String(value)));
}

// 删除一条刷题记录（手动删除）
function deletePracticeRecord(r) {
  confirmModal("删除刷题记录",
    `确定删除「${r.exam_title || "刷题"}」的这条刷题记录吗？作答详情与分析数据将一并删除，不可恢复。`,
    async () => {
      try {
        await api.post("backend/api/practice/record_delete.php", { record_id: r.id });
        toastOk("已删除");
        await drawPractice(currentInner);
      } catch (e) {
        toastErr("删除失败：" + e.message);
      }
    }, "删除", "danger");
}

// 刷题记录详情：汇总 + 错题题型分布 + 错题回顾
async function openPracticeDetail(recordId) {
  let data;
  try {
    const env = await api.get("backend/api/practice/record_detail.php", { record_id: recordId });
    data = env.data ? env.data : env;
  } catch (e) {
    return toastErr(e.message || "加载详情失败");
  }
  const { record, analytics, questions } = data;
  const wrong = (questions || []).filter((q) => q.is_correct === false);
  const redone = (questions || []).filter((q) => q.redo);
  const redoFixed = analytics?.redo_fixed || 0;
  const redoTotal = analytics?.redo_total || 0;
  const statusChip = record.status === "completed" ? chip("已完成", "mint")
    : record.status === "in_progress" ? chip("进行中", "warn") : chip("未完成", "pink");

  const body = el("div", { style: "max-height:58vh;overflow-y:auto;padding-right:4px" });

  body.append(el("div", { class: "banner", style: "margin-bottom:10px;display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center" },
    el("b", {}, record.exam_title || "刷题"), statusChip,
    el("span", { style: "color:var(--text-3);font-size:var(--fs-small)" },
      `共 ${record.total_questions} 题 · 已答 ${record.answered} · 答对 ${record.correct_count} · 答错 ${record.wrong_count} · 正确率 ${fmtScore(record.accuracy)}% · 用时 ${pFmtDuration(record.time_taken)}`,
      redoTotal > 0 ? ` · 二刷纠正 ${redoFixed}` : "")));

  // —— 错题题型分布 ——
  const distCard = el("div", { class: "card", style: "margin-bottom:12px" },
    el("div", { class: "card-title" }, el("h3", {}, "错题题型分布")));
  if (!wrong.length) {
    distCard.append(emptyBox("没有错题，继续保持！"));
  } else {
    for (const t of analytics?.wrong_types || []) {
      distCard.append(el("div", { style: "display:flex;align-items:center;gap:10px;margin:6px 0" },
        el("span", { style: "width:76px;text-align:right;color:var(--text-2);font-size:var(--fs-small);flex-shrink:0" }, t.type_name),
        el("div", { style: "flex:1;height:10px;background:var(--pink-t);border-radius:5px;overflow:hidden" },
          el("div", { style: `width:${t.percent}%;height:100%;background:var(--danger);opacity:.75;border-radius:5px` })),
        el("span", { style: "width:84px;color:var(--text-3);font-size:var(--fs-small)" }, `${t.count} 题 · ${fmtScore(t.percent)}%`)));
    }
  }
  body.append(distCard);

  // —— 错题回顾 ——
  const reviewCard = el("div", { class: "card" },
    el("div", { class: "card-title" }, el("h3", {}, `错题回顾（${wrong.length} 题）`)));
  if (!wrong.length) {
    reviewCard.append(emptyBox("没有错题，继续保持！"));
  } else {
    for (const q of wrong) {
      reviewCard.append(el("div", { style: "border:1px solid var(--border);border-left:3px solid var(--danger);border-radius:8px;padding:10px 12px;margin-bottom:10px" },
        el("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:6px" },
          el("b", {}, `第 ${q.index + 1} 题`), chip(q.type_name || q.question_type, "sky")),
        el("div", { style: "color:var(--text-2);line-height:1.8;margin-bottom:8px" }, htmlToText(q.content)),
        el("div", { style: "font-size:var(--fs-small);line-height:2" },
          el("div", {}, el("span", { style: "color:var(--danger)" }, q.redo ? "首刷作答：" : "您的答案："), pFmtAnswer(q.user_answer, q.question_type)),
          q.redo ? el("div", {}, el("span", { style: "color:var(--danger)" }, "二刷作答："), pFmtAnswer(q.redo.a, q.question_type)) : null,
          el("div", {}, el("span", { style: "color:var(--ok)" }, "正确答案："), pFmtAnswer(q.answer, q.question_type))),
        q.explanation ? el("div", { class: "banner", style: "margin-top:8px" }, el("b", {}, "解析："), htmlToText(q.explanation)) : null));
    }
  }
  body.append(reviewCard);

  // —— 二刷明细（覆盖过二刷结果的题，含已纠正与仍答错）——
  if (redoTotal > 0) {
    const redoCard = el("div", { class: "card", style: "margin-bottom:12px" },
      el("div", { class: "card-title" }, el("h3", {}, `二刷明细（${redoTotal} 题 · 已纠正 ${redoFixed}）`)));
    const ordered = redone.slice().sort((a, b) => a.index - b.index);
    for (const q of ordered) {
      const fixed = !!q.redo.ok;
      redoCard.append(el("div", { style: `border:1px solid var(--border);border-left:3px solid ${fixed ? "var(--ok)" : "var(--danger)"};border-radius:8px;padding:10px 12px;margin-bottom:10px` },
        el("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:6px" },
          el("b", {}, `第 ${q.index + 1} 题`), chip(q.type_name || q.question_type, "sky"),
          el("span", { style: `margin-left:auto;font-size:var(--fs-small);color:${fixed ? "var(--ok)" : "var(--danger)"}` }, fixed ? "✓ 已纠正" : "✗ 仍答错")),
        el("div", { style: "color:var(--text-2);line-height:1.8;margin-bottom:8px" }, htmlToText(q.content)),
        el("div", { style: "font-size:var(--fs-small);line-height:2" },
          el("div", {}, el("span", { style: "color:var(--text-3)" }, "首刷："), pFmtAnswer(q.user_answer, q.question_type)),
          el("div", {}, el("span", { style: "color:var(--text-3)" }, "二刷："), pFmtAnswer(q.redo.a, q.question_type)),
          el("div", {}, el("span", { style: "color:var(--ok)" }, "正确答案："), pFmtAnswer(q.answer, q.question_type))),
        q.explanation ? el("div", { class: "banner", style: "margin-top:8px" }, el("b", {}, "解析："), htmlToText(q.explanation)) : null));
    }
    body.append(redoCard);
  }

  const detailActions = [];
  if (record.status === "in_progress") {
    detailActions.push({ label: "继续本次刷题", kind: "primary", onClick: () => go(`practice/${record.exam_id}`) });
  }
  if (record.wrong_count > 0) {
    detailActions.push({ label: `错题重刷（${record.wrong_count}）`, kind: "primary", onClick: () => go(`practice/${record.exam_id}/redo/${record.id}`) });
  }

  modal({
    title: "刷题记录详情",
    wide: true,
    body,
    actions: detailActions,
  });
  renderMathIn(body);
}

// 用时格式化（秒 → x分y秒）
function pFmtDuration(seconds) {
  if (!seconds || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

// 答案格式化（索引转字母、布尔转正确/错误、材料题展开小题；兼容 web/桌面两种材料答案形态）
function pFmtAnswer(answer, type) {
  if (answer === null || answer === undefined || answer === "") return "未作答";
  if (typeof answer === "boolean") return answer ? "正确" : "错误";
  if (Array.isArray(answer)) return answer.map((i) => (typeof i === "number" ? ("ABCDEFGH"[i] ?? i) : String(i).toUpperCase())).join(" , ");
  if (typeof answer === "object") {
    // 桌面端材料题形态：{subs: {子题序号: {v, ok}}}
    if (answer.subs && typeof answer.subs === "object") {
      const entries = Object.entries(answer.subs);
      if (!entries.length) return "未作答";
      return entries.map(([k, v]) => `第${Number(k) + 1}小题：${pFmtAnswer(v && v.v !== undefined ? v.v : v)}`).join("；");
    }
    // web 端材料题形态：{子题序号: 答案}
    const entries = Object.entries(answer);
    if (!entries.length) return "未作答";
    return entries.map(([k, v]) => `第${Number(k) + 1}小题：${pFmtAnswer(v)}`).join("；");
  }
  if (type === "true_false") {
    const s = String(answer).toLowerCase();
    if (s === "true" || s === "1") return "正确";
    if (s === "false" || s === "0") return "错误";
  }
  return String(answer);
}

// ---------------- 图表（纯 SVG 自绘，日系发丝风，CSS 变量配色适配暗色） ----------------

// var() 只在 style 中生效，SVG 属性里无效——颜色一律走 style
const T_STYLE = "fill:var(--text-3);font-size:10.5px;letter-spacing:.04em";
const T2_STYLE = "fill:var(--text-2);font-size:10.5px;letter-spacing:.04em";

function shortDate(str) {
  const m = String(str || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}-${m[3]}` : "—";
}

/** 得分率走势：固定 0-100% 轴 + 网格 + 及格线 + 面积折线 */
function lineChart(trend) {
  const card = el("div", { class: "card" },
    el("div", { class: "card-title" }, el("h3", {}, "最近得分率走势")));

  if (trend.length < 2) {
    card.append(emptyBox("完成 2 场考试后展示走势", "走势仅统计已完成的考试"));
    return card;
  }

  const W = 920, H = 220, L = 44, R = 20, T = 18, B = 34;
  const iw = W - L - R, ih = H - T - B;
  const y = (v) => T + ih - (v / 100) * ih;
  const x = (i) => L + (trend.length === 1 ? iw / 2 : (i * iw) / (trend.length - 1));
  const pts = trend.map((r, i) => ({ x: x(i), y: y(r.score_percentage), r }));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${(T + ih).toFixed(1)} L${pts[0].x.toFixed(1)},${(T + ih).toFixed(1)} Z`;
  const showVal = trend.length <= 8; // 点多时不标数值，靠悬停提示

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, style: "width:100%;min-width:520px;height:auto" });
  // 网格 + Y 刻度
  for (let v = 0; v <= 100; v += 25) {
    svg.append(svgEl("line", { x1: L, y1: y(v), x2: W - R, y2: y(v), style: `stroke:var(--border);stroke-width:${v === 0 ? 1 : 0.5};opacity:${v === 0 ? 0.9 : 0.45}` }));
    svg.append(svgEl("text", { x: L - 8, y: y(v) + 3.5, "text-anchor": "end", style: T_STYLE }, String(v)));
  }
  // 及格线
  svg.append(svgEl("line", { x1: L, y1: y(60), x2: W - R, y2: y(60), style: "stroke:var(--pink);stroke-width:1;stroke-dasharray:4 5;opacity:.6" }));
  svg.append(svgEl("text", { x: W - R, y: y(60) - 6, "text-anchor": "end", style: T_STYLE }, "及格线 60%"));
  // 面积 + 折线
  svg.append(svgEl("path", { d: area, style: "fill:var(--sky);opacity:.07" }));
  svg.append(svgEl("path", { d: line, style: "fill:none;stroke:var(--sky);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round" }));
  // 数据点 + 悬停提示 + 数值标签
  for (const [i, p] of pts.entries()) {
    svg.append(svgEl("circle", { cx: p.x, cy: p.y, r: "3.2", style: "fill:var(--sky);opacity:.9" },
      svgEl("title", {}, `${p.r.title || "考试"} · ${shortDate(p.r.completed_at)} · 得分率 ${fmtScore(p.r.score_percentage)}%`)));
    if (showVal) svg.append(svgEl("text", { x: p.x, y: p.y - 9, "text-anchor": "middle", style: T2_STYLE }, fmtScore(p.r.score_percentage)));
  }
  // X 轴日期（点多时隔一显示）
  for (const [i, p] of pts.entries()) {
    if (trend.length > 8 && i % 2 === 1 && i !== trend.length - 1) continue;
    svg.append(svgEl("text", { x: p.x, y: H - 12, "text-anchor": "middle", style: T_STYLE }, shortDate(p.r.completed_at)));
  }
  card.append(el("div", { style: "width:100%;overflow-x:auto" }, svg));
  return card;
}

/** 按科目平均得分率（水平条形 + 及格参考线） */
function subjectChart(completed) {
  const card = el("div", { class: "card" },
    el("div", { class: "card-title" }, el("h3", {}, "各科目平均得分率")));
  const groups = new Map();
  for (const r of completed) {
    const key = r.subject || "未分类";
    groups.set(key, [...(groups.get(key) || []), r.score_percentage]);
  }
  const rows = [...groups.entries()]
    .map(([name, vals]) => ({ name, avg: vals.reduce((a, b) => a + b, 0) / vals.length, count: vals.length }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 8);
  if (!rows.length) {
    card.append(emptyBox("暂无数据", "完成考试后按科目汇总"));
    return card;
  }

  const W = 460, rowH = 30, labelW = 96, valW = 64;
  const barMax = W - labelW - valW;
  const H = rows.length * rowH + 14;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, style: "width:100%;height:auto" });
  const passX = labelW + (60 / 100) * barMax;
  rows.forEach((row, i) => {
    const top = 7 + i * rowH;
    const cy = top + rowH / 2;
    const w = Math.max(2, (row.avg / 100) * barMax);
    svg.append(svgEl("text", { x: labelW - 8, y: cy + 3.5, "text-anchor": "end", style: T2_STYLE },
      row.name.length > 7 ? row.name.slice(0, 7) + "…" : row.name));
    svg.append(svgEl("line", { x1: labelW, y1: top + 3, x2: labelW, y2: top + rowH - 3, style: "stroke:var(--border);stroke-width:.5;opacity:.5" }));
    svg.append(svgEl("rect", { x: labelW, y: top + 7, width: w, height: rowH - 14, rx: "4",
      style: row.avg >= 60 ? "fill:var(--sky);opacity:.75" : "fill:var(--pink);opacity:.65" },
      svgEl("title", {}, `${row.name}：平均 ${fmtScore(row.avg)}% · ${row.count} 次`)));
    svg.append(svgEl("text", { x: labelW + w + 8, y: cy + 3.5, style: T2_STYLE }, `${fmtScore(row.avg)}% · ${row.count}次`));
  });
  // 及格参考线
  svg.append(svgEl("line", { x1: passX, y1: 4, x2: passX, y2: H - 6, style: "stroke:var(--pink);stroke-width:1;stroke-dasharray:4 5;opacity:.55" }));
  svg.append(svgEl("text", { x: passX + 4, y: 14, style: T_STYLE }, "60%"));
  card.append(svg);
  return card;
}

/** 得分率分布（4 档柱状） */
function distChart(completed) {
  const card = el("div", { class: "card" },
    el("div", { class: "card-title" }, el("h3", {}, "得分率分布")));
  const buckets = [
    { label: "<60", min: -1, max: 60, fill: "var(--danger)" },
    { label: "60-79", min: 60, max: 80, fill: "var(--warn)" },
    { label: "80-89", min: 80, max: 90, fill: "var(--sky)" },
    { label: "≥90", min: 90, max: 101, fill: "var(--mint)" },
  ].map((b) => ({ ...b, count: completed.filter((r) => r.score_percentage >= b.min && r.score_percentage < b.max).length }));

  if (!completed.length) {
    card.append(emptyBox("暂无数据", "完成考试后统计分布"));
    return card;
  }

  const W = 460, H = 200, T = 26, B = 30, gap = 18;
  const iw = W - gap * 2;
  const bw = iw / buckets.length * 0.52;
  const maxC = Math.max(1, ...buckets.map((b) => b.count));
  const step = Math.max(1, Math.ceil(maxC / 4));
  const top = maxC + step - 1; // Y 轴上界（留一格余量）
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, style: "width:100%;height:auto" });
  // Y 网格（整数步进）
  for (let v = 0; v <= top; v += step) {
    const gy = H - B - (v / top) * (H - T - B);
    svg.append(svgEl("line", { x1: gap, y1: gy, x2: W - gap, y2: gy, style: `stroke:var(--border);stroke-width:${v === 0 ? 1 : 0.5};opacity:${v === 0 ? 0.9 : 0.4}` }));
    svg.append(svgEl("text", { x: gap - 6, y: gy + 3.5, "text-anchor": "end", style: T_STYLE }, String(v)));
  }
  buckets.forEach((b, i) => {
    const cx = gap + (iw / buckets.length) * (i + 0.5);
    const h = (b.count / top) * (H - T - B);
    svg.append(svgEl("rect", { x: cx - bw / 2, y: H - B - h, width: bw, height: Math.max(b.count ? 3 : 0, h), rx: "5",
      style: `fill:${b.fill};opacity:.72` },
      svgEl("title", {}, `${b.label}%：${b.count} 场`)));
    if (b.count) svg.append(svgEl("text", { x: cx, y: H - B - h - 7, "text-anchor": "middle", style: T2_STYLE }, String(b.count)));
    svg.append(svgEl("text", { x: cx, y: H - 10, "text-anchor": "middle", style: T_STYLE }, b.label));
  });
  card.append(svg);
  return card;
}
