// 见闻广场（冒险公会）：手札文章流（对齐 web 端 guild_stories 排版）
// 数据：community/articles.php?action=list&page&search&sort；热门标签 action=get_popular_tags
// 详情：action=detail&id
// 样式：css/guild.css（gd- 命名空间）

import { api } from "api";
import { el, clear, loadingBox, errorBox, emptyBox, pager, toastErr, htmlToText } from "ui";
import { modal } from "ui";
import { go } from "router";
import { kmMarkdown, stripImages, firstImage } from "km-markdown";

const state = { page: 1, search: "", tag: "", sort: "latest", totalPages: 1 };

export async function renderGuildStories(container) {
  const inner = el("div", { class: "gd-page" });
  container.append(inner);
  await draw(inner);
}

async function draw(inner) {
  clear(inner).append(loadingBox("正在加载见闻广场…"));
  let env;
  try {
    env = await api.get("backend/api/community/articles.php", {
      action: "list", page: state.page, search: state.search, tag: state.tag, sort: state.sort,
    });
  } catch (e) {
    return clear(inner).append(errorBox(e.message, () => draw(inner)));
  }
  const data = env.data || {};
  const articles = data.articles || [];
  state.totalPages = data.pagination?.total_pages ?? Math.max(1, Math.ceil((data.pagination?.total ?? 0) / 10));
  let tags = [];
  try {
    const t = await api.get("backend/api/community/articles.php", { action: "get_popular_tags" });
    tags = t.data || [];
  } catch {}
  clear(inner);

  // 页头 + 写手札入口
  inner.append(el("div", { class: "gd-page-head" },
    el("div", {},
      el("span", { class: "eyebrow" }, "ADVENTURERS GUILD"),
      el("h1", {}, "见闻广场"),
      el("div", { class: "sub" }, "冒险者们的手札与见闻")),
    el("div", { class: "head-actions" },
      el("button", { class: "btn primary", onclick: () => go("guild/write") }, "✍ 写手札"))));

  // 热门标签
  if (tags.length) {
    const tagRow = el("div", { class: "gd-tagbar" });
    tagRow.append(el("span", { class: "cap" }, "热门标签"));
    for (const t of tags.slice(0, 10)) {
      tagRow.append(el("button", {
        class: "gd-filter-chip" + (state.tag === t.name ? " active" : ""),
        "data-tag": t.name,
      }, `${t.name} · ${t.article_count || 0}`));
    }
    tagRow.addEventListener("click", (ev) => {
      const c = ev.target.closest(".gd-filter-chip");
      if (c) {
        state.tag = state.tag === c.dataset.tag ? "" : c.dataset.tag;
        state.page = 1;
        draw(inner);
      }
    });
    inner.append(tagRow);
  }

  // 筛选行
  const kw = el("input", { class: "input", placeholder: "搜索手札…（回车）" });
  kw.value = state.search;
  kw.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { state.search = kw.value.trim(); state.page = 1; draw(inner); }
  });
  const selSort = el("select", { class: "input" },
    ...[["latest", "最新"], ["popular", "最热"]].map(([v, t]) => el("option", { value: v, selected: v === state.sort ? "" : undefined }, t)));
  selSort.addEventListener("change", () => { state.sort = selSort.value; state.page = 1; draw(inner); });
  inner.append(el("div", { class: "gd-toolbar" },
    el("div", {}),
    el("div", { class: "gd-toolbar-right" }, selSort, kw)));

  if (!articles.length) {
    inner.append(emptyBox("还没有手札", "点「写手札」发布第一篇见闻"));
    return;
  }

  const list = el("div", { class: "gd-story-list" });
  for (const a of articles) list.append(articleCard(a));
  inner.append(list);
  const pg = pager({ page: state.page, totalPages: state.totalPages, onGo: (p) => { state.page = p; draw(inner); } });
  if (pg) inner.append(pg);
}

function articleCard(a) {
  // 列表接口无正文：摘要剥掉图片语法，缩略图取封面或摘要中第一张图
  const excerpt = stripImages(a.excerpt || "").slice(0, 160);
  const img = a.cover_image || firstImage(a.excerpt || "");
  return el("article", { class: "gd-story-card", onclick: () => storyDetail(a.id) },
    el("div", { class: "gd-story-top" },
      el("span", { class: "gd-tag gd-cat-skill" }, a.category_name || "手札"),
      a.is_featured ? el("span", { class: "gd-tag gd-reward" }, "精华") : null,
      el("span", { class: "by" }, `${a.author_username || "冒险者"} · ${String(a.published_at || "").slice(0, 10)}`)),
    el("h3", { class: "gd-story-title" }, a.title || "（无标题）"),
    img ? el("img", { class: "gd-story-thumb", src: resolveSite(img), loading: "lazy", alt: "" }) : null,
    excerpt ? el("p", { class: "gd-story-excerpt" }, excerpt) : null,
    el("div", { class: "gd-story-foot" },
      el("span", { class: "stat" }, `👁 ${a.view_count ?? 0}`),
      el("span", { class: "stat" }, `♥ ${a.like_count ?? 0}`),
      el("span", { class: "stat" }, `💬 ${a.comment_count ?? 0}`),
      el("span", { class: "stat" }, `⭐ ${a.collect_count ?? 0}`),
      ...(a.tags || []).slice(0, 3).map((t) => el("span", { class: "gd-tag gd-cat-other" }, "#" + t))));
}

/** 站点根相对路径 → 绝对 URL（列表缩略图用） */
function resolveSite(u) {
  const raw = String(u || "").trim();
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw;
  const base = (api.baseUrlSync() || "").replace(/\/+$/, "");
  const rel = raw.replace(/^(\.\.\/|\.\/)+/, "").replace(/^\/+/, "");
  return base ? `${base}/${rel}` : `/${rel}`;
}

/** Markdown 容器（渲染 + 图片点击放大），详情/预览共用 */
function mdContainer(src) {
  const box = el("div", { class: "gd-md" });
  box.innerHTML = kmMarkdown(src, { baseUrl: api.baseUrlSync() });
  box.addEventListener("click", (ev) => {
    const img = ev.target.closest("img.km-md-img");
    if (!img) return;
    modal({ title: "查看图片", body: el("div", { style: "text-align:center" },
      el("img", { src: img.src, style: "max-width:100%;max-height:70vh;border-radius:var(--r-lg)" })), actions: [] });
  });
  return box;
}

async function storyDetail(id) {
  let env;
  try {
    env = await api.get("backend/api/community/articles.php", { action: "detail", id });
  } catch (e) { return toastErr(e.message); }
  const a = env.data?.article || env.data || {};
  const md = a.content_markdown || a.content || a.content_html || "";
  modal({ title: a.title || "手札", body: el("div", {},
    el("div", { style: "font-size:var(--fs-tiny);color:var(--text-3);margin-bottom:12px;letter-spacing:0.06em" },
      `${a.author_username || a.author?.nickname || "冒险者"} · ${String(a.published_at || a.created_at || "").slice(0, 16)} · 👁 ${a.view_count ?? 0}`),
    el("div", { class: "gd-detail-desc", style: "max-height:60vh;overflow-y:auto" },
      mdContainer(md) || "（无内容）")) });
}
