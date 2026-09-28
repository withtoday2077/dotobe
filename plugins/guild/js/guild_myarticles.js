// 我的手札（文章管理）：全部状态列表 + 状态筛选 + 编辑 / 提交发布 / 删除
// 数据：community/articles.php  action=list&mine=1（我的全部状态）/ detail / publish / delete
// 流程：撰写手札（create 存草稿）→ 此页「提交发布」送审 → 管理员审核通过后见闻广场可见

import { api } from "api";
import { el, clear, loadingBox, errorBox, emptyBox, chip, pager, toastOk, toastErr, confirmModal } from "ui";
import { go } from "router";

const state = { page: 1, filter: "all", totalPages: 1 };

// 筛选 → 后端 mine 模式 status/review 参数组合
const FILTERS = [
  ["all", "全部"],
  ["draft", "草稿"],
  ["pending", "审核中"],
  ["approved", "已发布"],
  ["rejected", "已驳回"],
  ["archived", "已归档"],
];
function filterParams(f) {
  switch (f) {
    case "draft": return { status: "draft" };
    case "pending": return { status: "published", review: "pending" };
    case "approved": return { status: "published", review: "approved" };
    case "rejected": return { review: "rejected" };
    case "archived": return { status: "archived" };
    default: return {};
  }
}

// status × review 组合 → 中文状态与徽章色
function statusBadge(a) {
  if (a.status === "archived") return { text: "已归档", tone: "" };
  if (a.status === "draft") return { text: "草稿", tone: "warn" };
  if (a.review_status === "approved") return { text: "已发布", tone: "mint" };
  if (a.review_status === "rejected") return { text: "已驳回", tone: "pink" };
  return { text: "审核中", tone: "sky" };
}

const VIS_TEXT = { public: "公开", followers_only: "粉丝可见", private: "私密" };

export async function renderGuildMyArticles(container) {
  const inner = el("div");
  container.append(inner);

  const loading = loadingBox("正在加载我的手札…");
  container.append(loading);

  const head = el("div", { class: "gd-page-head" },
    el("div", {},
      el("span", { class: "eyebrow" }, "ADVENTURERS GUILD"),
      el("h1", {}, "我的手札"),
      el("div", { class: "sub" }, "管理你的手札：草稿续写、提交发布、下架归档")));

  const selFilter = el("select", { class: "input", style: "width:140px" },
    ...FILTERS.map(([v, t]) => el("option", { value: v, selected: v === state.filter ? "" : undefined }, t)));
  selFilter.addEventListener("change", () => { state.filter = selFilter.value; state.page = 1; refresh(); });
  const newBtn = el("button", { class: "btn sm primary", onclick: () => go("guild/write") }, "＋ 撰写新手札");
  const toolbar = el("div", { class: "toolbar-row", style: "margin-top:var(--sp-2)" }, selFilter,
    el("span", { style: "flex:1" }), newBtn);

  const listBox = el("div", { style: "margin-top:var(--sp-2)" });

  inner.append(head, toolbar, listBox);
  loading.remove();

  let fetchSeq = 0;
  async function refresh() {
    const seq = ++fetchSeq;
    if (!listBox.childElementCount) listBox.append(loadingBox("正在加载…"));
    else { listBox.style.opacity = "0.55"; listBox.style.pointerEvents = "none"; }
    let env;
    try {
      env = await api.get("backend/api/community/articles.php", {
        action: "list", mine: 1, page: state.page, limit: 10, ...filterParams(state.filter),
      });
    } catch (e) {
      if (seq !== fetchSeq) return;
      listBox.style.opacity = ""; listBox.style.pointerEvents = "";
      clear(listBox).append(errorBox(e.message, () => refresh()));
      return;
    }
    if (seq !== fetchSeq) return;
    listBox.style.opacity = ""; listBox.style.pointerEvents = "";
    const data = env.data || {};
    const list = data.articles || [];
    state.totalPages = data.pagination?.total_pages ?? data.total_pages ?? 1;
    clear(listBox);
    if (!list.length) {
      listBox.append(emptyBox("暂无手札", "点右上「撰写新手札」记录你的冒险见闻"));
      return;
    }
    for (const a of list) listBox.append(articleRow(a));
    const pg = pager({ page: state.page, totalPages: state.totalPages, onGo: (p) => { state.page = p; refresh(); } });
    if (pg) listBox.append(pg);
  }

  function articleRow(a) {
    const badge = statusBadge(a);
    const time = String(a.updated_at || a.published_at || "").slice(0, 16);
    const canSubmit = a.status === "draft" || a.status === "archived" || a.review_status === "rejected";
    const submitLabel = a.status === "draft" ? "提交发布" : (a.status === "archived" ? "重新发布" : "重新送审");

    const submitBtn = canSubmit ? el("button", { class: "btn sm primary", onclick: async () => {
      submitBtn.disabled = true;
      submitBtn.textContent = "提交中…";
      try {
        // publish 接口会用传入字段整体覆盖，须先取 detail 带全量字段提交
        const d = await api.get("backend/api/community/articles.php", { action: "detail", id: a.id });
        const art = d.data || {};
        await api.postForm("backend/api/community/articles.php", {
          action: "publish",
          article_id: a.id,
          title: art.title || a.title,
          content: art.content_markdown || "",
          category_id: art.category_id ?? "",
          cover_image: art.cover_image || "",
          visibility: art.visibility || "public",
        });
        toastOk("已提交审核，通过后将在见闻广场展示");
        refresh();
      } catch (e) {
        toastErr("提交失败：" + (e.message || e));
        submitBtn.disabled = false;
        submitBtn.textContent = submitLabel;
      }
    } }, submitLabel) : null;

    const delBtn = a.status === "archived" ? null : el("button", { class: "btn sm danger", onclick: () =>
      confirmModal("删除手札", `确定删除「${a.title}」吗？删除后归档保存，可重新发布恢复。`, async () => {
        try {
          await api.get("backend/api/community/articles.php", { action: "delete", id: a.id });
          toastOk("已归档");
          refresh();
        } catch (e) { toastErr(e.message); }
      }, "删除", "danger") }, "删除");

    return el("div", { class: "card", style: "margin-bottom:var(--sp-2);padding:14px" },
      el("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" },
        el("strong", { style: "font-weight:400;flex:1;min-width:160px" }, a.title || "（无标题）"),
        chip(badge.text, badge.tone),
        a.category_name ? chip(a.category_name, "sky") : null,
        chip(VIS_TEXT[a.visibility] || a.visibility || "公开")),
      el("div", { style: "font-size:var(--fs-tiny);color:var(--text-3);margin-top:6px" },
        [time, `浏览 ${a.view_count ?? 0}`, `赞 ${a.like_count ?? 0}`, `评论 ${a.comment_count ?? 0}`].filter(Boolean).join(" · ")),
      el("div", { class: "ops", style: "display:flex;gap:10px;margin-top:10px" },
        el("button", { class: "btn sm", onclick: () => go(`guild/write/${a.id}`) }, "编辑"),
        submitBtn,
        delBtn));
  }

  refresh();
}
