// 任务大厅（冒险公会）：Hero 统计 + 分类 chips 筛选 + 任务卡片 + 详情弹窗（接单）
// 数据：guild/tasks.php?action=list&page&sort&category&keyword；详情 action=detail&id
// 接单：POST guild/assignments.php {action:"accept", task_id, comment}
// 样式：css/guild.css（gd- 命名空间，参照 Web 端排版）

import { api } from "api";
import { el, clear, loadingBox, errorBox, emptyBox, pager, toastOk, toastErr, modal, htmlToText, fmtScore } from "ui";
import { go } from "router";

const CATEGORIES = {
  study: "学习辅导", errand: "跑腿代办", carpool: "拼车拼单",
  skill: "技能交换", borrow: "借用求购", consult: "问题咨询", other: "其他任务",
};
const STATUS = {
  pending_review: ["待审核", "gd-st-review"], open: ["招募中", "gd-st-open"], locked: ["待确认", "gd-st-locked"],
  in_progress: ["执行中", "gd-st-running"], pending_confirm: ["待验收", "gd-st-confirm"], completed: ["已完成", "gd-st-done"],
  cancelled: ["已取消", "gd-st-cancel"], arbitration: ["仲裁中", "gd-st-arb"], rejected: ["已驳回", "gd-st-cancel"],
};
const DANGER_LABEL = ["安全", "注意", "高危"];

const state = { page: 1, sort: "latest", category: "", keyword: "", totalPages: 1 };

export async function renderGuildHall(container) {
  const inner = el("div", { class: "gd-page" });
  container.append(inner);
  await draw(inner);
}

async function draw(inner) {
  // 首屏：加载一次后构建静态骨架（Hero + 工具栏），筛选变化只局部刷新结果区，避免整页闪烁
  clear(inner).append(loadingBox("正在进入任务大厅…"));
  let env;
  try {
    env = await api.get("backend/api/guild/tasks.php", {
      action: "list", page: state.page, sort: state.sort,
      category: state.category, keyword: state.keyword,
    });
  } catch (e) {
    return clear(inner).append(errorBox(e.message, () => draw(inner)));
  }
  clear(inner);
  const data = env.data || {};
  const stats = data.stats || {};

  // —— Hero：标题 + 实时统计 + 快捷入口（静态，不随筛选重画） ——
  inner.append(el("section", { class: "gd-hero" },
    el("div", { class: "gd-hero-main" },
      el("div", {},
        el("span", { class: "eyebrow" }, "ADVENTURERS GUILD"),
        el("h1", {}, "任务大厅"),
        el("p", { class: "lead" }, "接过委托，赢取报酬——每一次交付都在积累你的信用")),
      el("div", { class: "gd-hero-stats" },
        heroStat(data.total ?? stats.total ?? 0, "任务总数"),
        heroStat(stats.open ?? 0, "招募中"),
        heroStat(stats.in_progress ?? 0, "执行中"),
        heroStat(stats.completed ?? 0, "已完成"))),
    el("div", { class: "gd-hero-actions" },
      el("button", { class: "btn primary", onclick: () => go("guild/publish") }, "＋ 发布任务"),
      el("button", { class: "btn", onclick: () => go("guild/mytasks") }, "我的任务"),
      el("button", { class: "btn", onclick: () => go("guild/stories") }, "见闻广场"),
      el("button", { class: "btn", onclick: () => go("guild/team") }, "学习小队"))));

  // —— 工具栏：分类 chips + 搜索/排序（静态） ——
  const kw = el("input", { class: "input", placeholder: "搜索任务…（回车）" });
  kw.value = state.keyword;
  kw.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { state.keyword = kw.value.trim(); state.page = 1; syncChips(); refreshResults(); }
  });
  const sorts = [["latest", "最新发布"], ["reward", "报酬优先"], ["deadline", "截止临近"]];
  const selSort = el("select", { class: "input" },
    ...sorts.map(([v, t]) => el("option", { value: v, selected: v === state.sort ? "" : undefined }, t)));
  selSort.addEventListener("change", () => { state.sort = selSort.value; state.page = 1; syncChips(); refreshResults(); });

  const chips = el("div", { class: "gd-filter-chips" },
    filterChip("", "全部", state.category),
    ...Object.entries(CATEGORIES).map(([v, t]) => filterChip(v, t, state.category)));
  chips.addEventListener("click", (ev) => {
    const c = ev.target.closest(".gd-filter-chip");
    if (c) { state.category = c.dataset.cat || ""; state.page = 1; syncChips(); refreshResults(); }
  });
  function syncChips() {
    chips.querySelectorAll(".gd-filter-chip").forEach((c) =>
      c.classList.toggle("active", (c.dataset.cat || "") === state.category));
  }

  inner.append(el("div", { class: "gd-toolbar" }, chips,
    el("div", { class: "gd-toolbar-right" }, selSort, kw)));

  // —— 结果区：任务网格 + 分页器（局部刷新） ——
  const resultsZone = el("div", { class: "gd-results" });
  inner.append(resultsZone);

  function renderResults(env) {
    const d = env.data || {};
    const list = d.list || [];
    state.totalPages = d.pagination?.total_pages ?? Math.max(1, Math.ceil((d.total || 0) / 10));
    clear(resultsZone);
    if (!list.length) {
      resultsZone.append(emptyBox("大厅暂时没有任务", "换个类别看看，或点「发布任务」发布第一单"));
      return;
    }
    const grid = el("div", { class: "gd-task-grid" });
    for (const t of list) grid.append(taskCard(t));
    resultsZone.append(grid);
    const pg = pager({ page: state.page, totalPages: state.totalPages, onGo: (p) => { state.page = p; refreshResults(); } });
    if (pg) resultsZone.append(pg);
  }

  async function refreshResults() {
    // 旧列表淡出而非清空整页，数据回来后原位替换
    resultsZone.style.opacity = "0.45";
    resultsZone.style.pointerEvents = "none";
    try {
      const env = await api.get("backend/api/guild/tasks.php", {
        action: "list", page: state.page, sort: state.sort,
        category: state.category, keyword: state.keyword,
      });
      renderResults(env);
    } catch (e) {
      clear(resultsZone).append(errorBox(e.message, () => refreshResults()));
    } finally {
      resultsZone.style.opacity = "";
      resultsZone.style.pointerEvents = "";
    }
  }

  renderResults(env);
}

function heroStat(value, label) {
  return el("div", { class: "gd-hero-stat" }, el("strong", {}, String(value)), el("span", {}, label));
}

function filterChip(value, label, cur) {
  return el("button", { class: "gd-filter-chip" + (cur === value ? " active" : ""), "data-cat": value }, label);
}

function catChip(cat) {
  return CATEGORIES[cat] ? el("span", { class: `gd-tag gd-cat-${cat}` }, CATEGORIES[cat]) : null;
}

function statusChip(status) {
  const [label, cls] = STATUS[status] || [status || "—", "gd-cat-other"];
  return el("span", { class: `gd-tag ${cls}` }, label);
}

/** 报酬展示：gold → 金币；cash → ¥（线下结算）；金额为 0 → 面议 */
function rewardParts(t) {
  const raw = t.reward_amount;
  const amount = raw != null && raw !== "" ? Number(raw) : 0;
  if (!amount) return { num: "面议", unit: "", cash: false };
  return t.reward_type === "cash"
    ? { num: "¥" + fmtScore(amount), unit: "", cash: true }
    : { num: fmtScore(amount), unit: "金币", cash: false };
}

function taskCard(t) {
  return el("article", { class: "gd-task-card", onclick: () => taskDetail(t.id) },
    el("div", { class: "gd-card-top" }, catChip(t.category), statusChip(t.status),
      t.is_urgent ? el("span", { class: "gd-tag gd-urgent" }, "紧急") : null,
      t.danger_level >= 1 ? el("span", { class: `gd-tag gd-danger-${t.danger_level}` },
        `危险 · ${DANGER_LABEL[t.danger_level] || "注意"}`) : null),
    el("h3", { class: "gd-card-title" }, t.title || "任务"),
    htmlToText(t.description)
      ? el("p", { class: "gd-card-desc" }, htmlToText(t.description).slice(0, 120))
      : null,
    el("div", { class: "gd-card-meta" },
      t.deadline ? el("span", {}, `⏱ 截止 ${String(t.deadline).slice(0, 10)}`) : null,
      t.location ? el("span", {}, `📍 ${t.location}`) : null,
      t.min_level ? el("span", {}, `Lv.${t.min_level}+`) : null,
      t.offline_required ? el("span", {}, "需线下") : null),
    el("div", { class: "gd-card-foot" },
      el("span", { class: "who" }, t.publisher?.nickname || t.publisher?.username || "冒险者发布"),
      (() => {
        const r = rewardParts(t);
        return el("span", { class: "reward-lg" }, r.num,
          r.unit ? el("small", {}, r.unit) : null,
          r.cash ? el("small", {}, " 线下结算") : null);
      })()));
}

async function taskDetail(id) {
  let env;
  try {
    env = await api.get("backend/api/guild/tasks.php", { action: "detail", id });
  } catch (e) { return toastErr(e.message); }
  if (!env.success) return toastErr(env.message || "任务不存在");
  const t = env.data?.task || env.data || {};
  const pub = env.data?.publisher || {};
  const asg = env.data?.assignment;
  const myRole = env.data?.my_role;

  const body = el("div", {},
    el("div", { class: "gd-detail-chips" },
      catChip(t.category), statusChip(t.status),
      t.is_urgent ? el("span", { class: "gd-tag gd-urgent" }, "紧急") : null,
      t.danger_level >= 1 ? el("span", { class: `gd-tag gd-danger-${t.danger_level}` },
        `危险 · ${DANGER_LABEL[t.danger_level] || "注意"}`) : null),
    el("div", { class: "gd-detail-desc" }, htmlToText(t.description) || "（无描述）"),
    el("div", { class: "gd-detail-meta" },
      (() => {
        const r = rewardParts(t);
        return el("div", { class: "row" }, el("b", {}, "报酬"),
          el("span", { class: "gold" }, `${r.num}${r.unit ? " " + r.unit : ""}${r.cash ? "（线下结算）" : ""}`,
            t.negotiable ? el("span", { style: "color:var(--text-3);margin-left:6px;font-size:var(--fs-tiny)" }, "可面议") : null));
      })(),
      t.deadline ? el("div", { class: "row" }, el("b", {}, "截止"), `${String(t.deadline).slice(0, 16)}`) : null,
      t.location ? el("div", { class: "row" }, el("b", {}, "地点"), t.location) : null,
      t.min_level ? el("div", { class: "row" }, el("b", {}, "等级要求"), `Lv.${t.min_level} 及以上`) : null,
      t.min_credit ? el("div", { class: "row" }, el("b", {}, "信用要求"), `${t.min_credit} 分`) : null,
      t.offline_required ? el("div", { class: "row" }, el("b", {}, "完成方式"), "需线下完成") : null,
      pub.nickname || pub.username ? el("div", { class: "row" }, el("b", {}, "发布者"), `${pub.nickname || pub.username}`) : null,
      asg ? el("div", { class: "row" }, el("b", {}, "执行者"), `${asg.nickname || asg.assignee || "—"}`) : null,
      t.view_count ? el("div", { class: "row" }, el("b", {}, "热度"), `${t.view_count} 次浏览`) : null));

  const actions = [];
  const canAccept = t.status === "open" && myRole !== "publisher";
  if (canAccept) {
    actions.push({ label: "接受任务", kind: "primary", onClick: async () => {
      try {
        const r = await api.postJSON("backend/api/assignments.php", { action: "accept", task_id: t.id });
        toastOk(r.message || "已接受任务");
        go("guild/mytasks");
      } catch (e) { toastErr(e.message); }
    } });
  }

  modal({ title: t.title || "任务详情", body, actions });
}
