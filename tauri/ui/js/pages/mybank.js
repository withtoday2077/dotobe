// 我的题库（教师）：我上传的/我收藏的/已购的试卷、发布到真题市场、分享码生成与导入、删除
// 数据：page/my_exams.php?tab=uploaded|favorite_exams|my_purchases
// 操作：publish_exam（发布/下架，真题市场）/ generate_share / toggle_favorite / import_by_share / exam.php?action=delete
// 注意：以下操作接口后端均读 php://input 的 JSON body，必须用 api.postJSON（api.post 发 urlencoded 会报"参数错误"）

import { api } from "../api.js";
import { go } from "../router.js";
import { el, clear, loadingBox, errorBox, emptyBox, chip, pager, fmtScore, toastOk, toastErr, confirmModal, modal, htmlToText, renderMathIn } from "../ui.js";

const state = { tab: "uploaded", page: 1, search: "", totalPages: 1 };

// 布局引用：工具行只建一次常驻不重建；切换标签仅刷新列表区域，避免整页拆建闪烁
let listBox = null;
let tabBtns = [];
let fetchSeq = 0; // 竞态保护：快速连续切换时，仅最后一次请求的结果生效

export async function renderMybank(container) {
  const inner = el("div");
  container.append(inner);
  buildToolbar(inner);
  listBox = el("div");
  inner.append(listBox);
  await refresh();
}

function buildToolbar(inner) {
  const tabs = [
    ["uploaded", "我上传的试卷"], ["favorite_exams", "我收藏的试卷"],
    ["my_purchases", "已购试卷"],
    ["uploaded_questions", "我上传的题目"], ["favorite_questions", "我收藏的题目"],
  ];
  const tabRow = el("div", { class: "toolbar-row" });
  tabBtns = tabs.map(([key, label]) => {
    const b = el("button", {
      class: "btn sm",
      onclick: () => {
        if (state.tab === key) return;
        state.tab = key; state.page = 1;
        syncTabs(); refresh();
      },
    }, label);
    b.dataset.tab = key;
    return b;
  });
  syncTabs();
  for (const b of tabBtns) tabRow.append(b);

  const kw = el("input", { class: "input", placeholder: "搜索试卷名称…", style: "width:200px" });
  kw.value = state.search;
  kw.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { state.search = kw.value.trim(); state.page = 1; refresh(); }
  });
  tabRow.append(kw);

  // 分享码导入：醒目入口按钮 + 弹窗输入（对齐网页端体验）
  tabRow.append(el("button", { class: "btn sm primary", style: "margin-left:auto", onclick: () => importShareModal() }, "⊕ 分享码导入"));
  inner.append(tabRow);
}

function syncTabs() {
  for (const b of tabBtns) b.className = "btn sm" + (b.dataset.tab === state.tab ? " primary" : "");
}

async function refresh() {
  const seq = ++fetchSeq;
  // 首次加载显示占位；后续刷新保留旧内容半透明置灰，新数据到达后原地替换（无中间空白）
  if (!listBox.childElementCount) {
    clear(listBox).append(loadingBox("正在加载我的题库…"));
  } else {
    listBox.style.opacity = "0.55";
    listBox.style.pointerEvents = "none";
  }
  const isQuestionTab = state.tab === "uploaded_questions" || state.tab === "favorite_questions";
  let env;
  try {
    env = await api.get("backend/api/page/my_exams.php", {
      tab: state.tab,
      page: state.page,
      limit: 10,
      search: state.search,
    });
  } catch (e) {
    if (seq !== fetchSeq) return;
    listBox.style.opacity = "";
    listBox.style.pointerEvents = "";
    clear(listBox).append(errorBox(e.message, () => refresh()));
    return;
  }
  if (seq !== fetchSeq) return; // 期间已有更新的切换，丢弃本次结果
  listBox.style.opacity = "";
  listBox.style.pointerEvents = "";
  const data = env.data || {};
  const list = data.items || data.exams || [];
  state.totalPages = data.pagination?.total_pages ?? data.total_pages ?? 1;
  clear(listBox);

  if (!list.length) {
    const hints = {
      uploaded: ["还没有上传过试卷", "用「编辑器」组卷或「真题上传」导入"],
      favorite_exams: ["还没有收藏试卷", ""],
      my_purchases: ["还没有购买过试卷", "去「真题市场」逛逛吧"],
      uploaded_questions: ["还没有上传过题目", "用「题目编辑器」录入题目"],
      favorite_questions: ["还没有收藏题目", ""],
    };
    const [t, h] = hints[state.tab] || ["暂无数据", ""];
    listBox.append(emptyBox(t, h));
    return;
  }

  if (isQuestionTab) {
    for (const q of list) listBox.append(questionItemCard(q));
    renderMathIn(listBox); // 题干/选项里的公式（$...$ / \ce 化学式等）
  } else {
    const grid = el("div", { class: "grid cols-3" });
    for (const e of list) grid.append(paperCard(e));
    listBox.append(grid);
  }
  const pg = pager({ page: state.page, totalPages: state.totalPages, onGo: (p) => { state.page = p; refresh(); } });
  if (pg) listBox.append(pg);
}

// 分享码导入弹窗：大号等宽输入框，自动大写 + 自动补连字符，回车提交
function importShareModal() {
  const input = el("input", {
    class: "input", placeholder: "XXXX-XXXX", maxlength: "9", spellcheck: "false",
    style: "width:100%;font-size:1.2rem;letter-spacing:0.3em;text-align:center;text-transform:uppercase;font-family:Consolas,Menlo,monospace",
  });
  input.addEventListener("input", () => {
    const raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    input.value = raw.length > 4 ? raw.slice(0, 4) + "-" + raw.slice(4) : raw;
  });
  async function submit() {
    const v = input.value.trim();
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(v)) throw new Error("分享码格式不正确，应为 XXXX-XXXX");
    const env = await api.postJSON("backend/api/import_by_share.php", { share_code: v });
    toastOk(env.message || "导入成功");
    refresh();
  }
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    submit().catch((err) => toastErr(err.message));
  });
  modal({
    title: "分享码导入试卷",
    body: el("div", { style: "display:flex;flex-direction:column;gap:var(--sp-2)" },
      el("p", { style: "color:var(--text-2);font-size:var(--fs-small);line-height:1.9" },
        "输入其他教师分享的 8 位分享码（如 AB12-CD34），导入后试卷将出现在「我上传的试卷」中。"),
      input),
    actions: [{ label: "导入", kind: "primary", onClick: submit }],
  });
  setTimeout(() => input.focus(), 100);
}

// 题目类标签的卡片（uploaded_questions / favorite_questions）
function questionItemCard(q) {
  const qid = q.question_id ?? q.id;
  const mastered = !!(q.is_mastered ?? q.mastered_at);

  return el("div", { class: "card", style: "margin-bottom:var(--sp-2)" },
    el("div", { style: "display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap" },
      chip(q.type_name || q.question_type || "题目", "sky"),
      q.score !== undefined ? el("span", { style: "font-size:var(--fs-tiny);color:var(--text-3);margin-left:auto" }, `${fmtScore(q.score)} 分`) : null),
    el("div", { style: "line-height:1.9" }, htmlToText(q.content || "").slice(0, 160) || "（空题干）"),
    el("div", { class: "ops", style: "display:flex;gap:10px;margin-top:12px" },
      el("button", { class: "btn sm danger", onclick: () =>
        confirmModal("删除题目", "删除后不可恢复，确定吗？", async () => {
          try {
            await api.postJSON("backend/api/question.php?action=delete", { id: qid });
            toastOk("已删除");
            refresh();
          } catch (e) { toastErr(e.message); }
        }, "删除", "danger") }, "删除")));
}

// 试卷卡片：排版对齐 web 端我的题库（标签行 / 标题 / 描述 / 元信息 / 操作行）
function paperCard(e) {
  const id = e.id;
  const isPublic = !!e.is_public;
  const isFav = state.tab === "favorite_exams";
  const isPurchasedTab = state.tab === "my_purchases";
  const priceNum = Number(e.price) || 0;

  const startBtn = el("button", { class: "btn sm primary", onclick: () => go(`take/${id}`) },
    e.attempt_count ? "再考一次" : "开始");
  const actions = [startBtn];

  if (isPurchasedTab) {
    // 已购 tab：买断制，仅保留开始入口
  } else if (isFav) {
    // 收藏 tab：他人试卷无发布/分享/删除权限，只留开始与取消收藏（对齐 web 端）
    actions.push(el("button", { class: "btn sm", onclick: async () => {
      try {
        await api.postJSON("backend/api/toggle_favorite.php", { exam_id: id });
        toastOk("已取消收藏");
        refresh();
      } catch (err) { toastErr(err.message); }
    } }, "取消收藏"));
  } else {
    // 发布 / 下架（真题市场）：下架保留定价，重新发布可改价；已购用户不受影响
    const publishBtn = el("button", { class: "btn sm" }, isPublic ? "下架" : "发布到市场");
    publishBtn.addEventListener("click", () => {
      if (isPublic) {
        confirmModal("从真题市场下架", `「${e.title}」将不再在市场展示，已购用户不受影响。确定下架吗？`, async () => {
          const env = await api.postJSON("backend/api/publish_exam.php", { action: "unpublish", exam_id: id });
          toastOk(env.message || "已下架");
          refresh();
        }, "下架", "primary");
      } else {
        publishModal(e);
      }
    });

    const shareBtn = el("button", { class: "btn sm", onclick: async () => {
      try {
        const env = await api.postJSON("backend/api/generate_share.php", { type: "exam", id });
        // 响应为顶层字段：share_code + share_info.remaining_days/remaining_uses
        const si = env.share_info || {};
        modal({
          title: "分享码已生成",
          body: el("div", { style: "text-align:center;padding:8px 0" },
            el("div", { style: "font-size:2rem;font-weight:200;letter-spacing:0.3em;color:var(--sky)" }, env.share_code || "—"),
            el("p", { style: "color:var(--text-2);font-size:var(--fs-small);margin-top:10px" },
              [si.remaining_days ? `有效期 ${si.remaining_days} 天` : "", si.remaining_uses ? `可用 ${si.remaining_uses} 次` : ""].filter(Boolean).join(" · ") || "将分享码提供给其他教师导入"),
        ),
        });
      } catch (err) { toastErr(err.message); }
    } }, "分享码");

    const delBtn = el("button", { class: "btn sm danger", onclick: () =>
      confirmModal("删除试卷", `确定删除「${e.title}」吗？该操作不可恢复。`, async () => {
        try {
          await api.postJSON("backend/api/exam.php?action=delete", { id });
          toastOk("已删除");
          refresh();
        } catch (err) { toastErr(err.message); }
      }, "删除", "danger") }, "删除");

    const favBtn = el("button", { class: "btn sm ghost fav", title: "收藏" },
      e.is_favorite ? "♥" : "♡");
    favBtn.addEventListener("click", async () => {
      try {
        await api.postJSON("backend/api/toggle_favorite.php", { exam_id: id });
        favBtn.textContent = favBtn.textContent === "♥" ? "♡" : "♥";
        toastOk("已更新收藏");
      } catch (err) { toastErr(err.message); }
    });

    actions.push(publishBtn, shareBtn, delBtn, favBtn);
  }

  const qn = e.question_count ?? e.total_questions;
  const metaText = [
    e.exam_type_name || "",
    qn ? `${qn} 题` : "",
    e.duration ? `${e.duration} 分钟` : "",
    e.total_score ? `满分 ${fmtScore(e.total_score)}` : "",
    e.attempt_count ? `${e.attempt_count} 次考试` : "",
  ].filter(Boolean).join(" · ");

  // 真题市场发布状态角标（作者视角）
  const marketChipEl = !isPublic || isFav || isPurchasedTab ? null
    : (priceNum > 0 ? chip(`已发布 ¥${priceNum.toFixed(2)}`, "sky") : chip("公益免费", "mint"));

  return el("div", { class: "card hoverable exam-card" },
    el("div", { class: "meta" },
      e.subject ? chip(e.subject, "sky") : null,
      (e.difficulty_name || e.difficulty_label) ? chip(e.difficulty_name || e.difficulty_label, "warn") : null,
      marketChipEl),
    el("div", { class: "title" }, e.title || "试卷"),
    el("div", { class: "desc", style: "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden" },
      htmlToText(e.description || "") || "暂无描述"),
    metaText ? el("div", { class: "desc" }, metaText) : null,
    el("div", { class: "actions" }, ...actions),
    isPurchasedTab
      ? el("div", { style: "font-size:var(--fs-tiny);color:var(--text-3)" },
          `购买于 ${e.purchased_at || "—"}${e.purchase_amount != null ? ` · 实付 ¥${Number(e.purchase_amount).toFixed(2)}` : ""}`)
      : (isFav && e.favorite_at) ? el("div", { style: "font-size:var(--fs-tiny);color:var(--text-3)" }, `收藏于 ${e.favorite_at}`) : null);
}

// 发布定价弹窗：公益免费 / 付费定价（收入全额进作者余额）
function publishModal(e) {
  const price = Number(e.price) || 0;
  const freeRadio = el("input", { type: "radio", name: "pubType", value: "free", checked: price <= 0 ? "" : undefined });
  const paidRadio = el("input", { type: "radio", name: "pubType", value: "paid", checked: price > 0 ? "" : undefined });
  const priceInput = el("input", {
    class: "input", type: "number", min: "0.01", max: "9999.99", step: "0.01",
    placeholder: "0.01 ~ 9999.99", style: "width:150px",
  });
  if (price > 0) priceInput.value = price.toFixed(2);

  const priceRow = el("div", { style: "display:none;align-items:center;gap:10px;margin-left:26px" },
    el("span", { style: "font-size:var(--fs-small);color:var(--text-2)" }, "定价（元）"), priceInput);
  function syncRow() { priceRow.style.display = paidRadio.checked ? "flex" : "none"; }
  freeRadio.addEventListener("change", syncRow);
  paidRadio.addEventListener("change", syncRow);
  syncRow();

  async function submit() {
    let p = 0;
    if (paidRadio.checked) {
      p = parseFloat(priceInput.value);
      if (!Number.isFinite(p) || p <= 0) throw new Error("请输入有效的定价（大于 0，最多两位小数）");
      if (p > 9999.99) throw new Error("定价不能超过 ¥9999.99");
      p = Math.round(p * 100) / 100;
    }
    const env = await api.postJSON("backend/api/publish_exam.php", { action: "publish", exam_id: e.id, price: p });
    toastOk(env.message || "发布成功");
    refresh();
  }

  modal({
    title: "发布到真题市场",
    body: el("div", { style: "display:flex;flex-direction:column;gap:var(--sp-2);font-size:var(--fs-body);color:var(--text-2)" },
      el("p", { style: "margin:0;font-weight:700;color:var(--text-1)" }, `《${e.title}》`),
      el("label", { style: "display:flex;gap:10px;align-items:flex-start;cursor:pointer" },
        freeRadio,
        el("span", {},
          el("div", { style: "font-weight:600;color:var(--text-1)" }, "公益免费"),
          el("div", { style: "font-size:var(--fs-tiny);color:var(--text-3)" }, "所有用户可直接使用，市场展示「公益免费」标识"))),
      el("label", { style: "display:flex;gap:10px;align-items:flex-start;cursor:pointer" },
        paidRadio,
        el("span", {},
          el("div", { style: "font-weight:600;color:var(--text-1)" }, "付费定价"),
          el("div", { style: "font-size:var(--fs-tiny);color:var(--text-3)" }, "其他用户购买后可用，卖出收入全额进入你的账户余额"))),
      priceRow,
      el("p", { style: "margin:0;font-size:var(--fs-tiny);color:var(--text-3);line-height:1.8" },
        "发布后试卷将在真题市场展示；下架不影响已购买的用户，重新发布可修改价格。")),
    actions: [{ label: "发布", kind: "primary", onClick: submit }],
  });
}
