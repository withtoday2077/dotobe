// 冒险者档案（冒险公会）：档案 Hero（等级/称号/经验）+ 金币统计 + 每日签到 + 关注/粉丝
// 数据：guild/profile.php?action=me / checkin(POST)；community/users.php?action=get_following|get_followers
// 样式：css/guild.css（gd- 命名空间，参照 Web 端 gd-me-hero 排版）

import { api, session } from "api";
import { el, clear, loadingBox, errorBox, emptyBox, toastOk, toastErr } from "ui";
import { go } from "router";

export async function renderGuildAdventurer(container) {
  const root = el("div", { class: "gd-page" });
  const loading = loadingBox("正在加载冒险者档案…");
  container.append(loading, root);
  let me;
  try {
    const env = await api.get("backend/api/guild/profile.php", { action: "me" });
    me = env.data?.profile || {};
  } catch (e) {
    return clear(container).append(errorBox(e.message, () => renderGuildAdventurer(container)));
  }
  loading.remove();

  // —— 档案 Hero：头像 / 名称 / 等级 / 经验条 ——
  const expPct = me.exp_to_next > 0 ? Math.min(100, Math.round((me.exp_in_level / me.exp_to_next) * 100)) : 100;
  const avatar = me.avatar
    ? el("img", { class: "gd-avatar", src: api.baseUrlSync() + "/" + String(me.avatar).replace(/^\//, "") })
    : el("div", { class: "gd-avatar" }, (me.nickname || "?").slice(0, 1));

  root.append(el("section", { class: "gd-me-hero" },
    el("div", { class: "gd-me-id" },
      avatar,
      el("div", {},
        el("div", { class: "gd-me-name" },
          me.nickname || me.username || "冒险者",
          el("span", { class: "gd-tag gd-level" }, `Lv.${me.level ?? 1}`)),
        el("div", { class: "gd-me-title" }, me.title || "见习冒险者"),
        el("div", { class: "gd-exp-bar" },
          el("div", { class: "gd-exp-fill", style: `width:${expPct}%` })),
        el("div", { class: "gd-exp-text" }, `经验 ${me.exp_in_level ?? 0} / ${me.exp_to_next ?? 100}`))),
    el("div", { class: "gd-me-side" },
      el("div", { class: "gd-me-stats" },
        meStat(me.gold ?? 0, "金币", "gold"), meStat(me.credit_score ?? 100, "信用分"),
        meStat(me.tasks_published ?? 0, "发布任务"), meStat(me.tasks_completed ?? 0, "完成任务")),
      el("button", { class: "btn" + (me.checked_today ? "" : " primary"), disabled: me.checked_today || undefined,
        onclick: async () => {
          try {
            await api.postJSON("backend/api/guild/profile.php", { action: "checkin" });
            toastOk("签到成功！");
            clear(container);
            renderGuildAdventurer(container);
          } catch (e) { toastErr(e.message); }
        } }, me.checked_today ? "今日已签到" : "每日签到"))));

  // —— 关注 / 粉丝面板 ——
  const followSection = el("div", { class: "gd-panel-grid", style: "margin-top:var(--sp-3)" });
  const followingBox = el("div", { class: "gd-panel" }, el("h3", {}, "我的关注"), emptyBox("加载中…"));
  const followersBox = el("div", { class: "gd-panel" }, el("h3", {}, "我的粉丝"), emptyBox("加载中…"));
  followSection.append(followingBox, followersBox);
  root.append(followSection);

  loadUserList(followingBox, "get_following");
  loadUserList(followersBox, "get_followers");

  // —— 快捷入口 ——
  root.append(el("div", { style: "display:flex;gap:12px;margin-top:var(--sp-4)" },
    el("button", { class: "btn", onclick: () => go("guild/stories") }, "我的手札与见闻"),
    el("button", { class: "btn", onclick: () => go("guild/mytasks") }, "我的任务")));
}

function meStat(value, label, tone = "") {
  return el("div", { class: `gd-me-stat ${tone}` }, el("strong", {}, String(value)), el("span", {}, label));
}

async function loadUserList(box, action) {
  const title = action === "get_following" ? "我的关注" : "我的粉丝";
  const key = action === "get_following" ? "following" : "followers";
  try {
    // 该接口要求显式传 user_id（当前用户）
    const env = await api.get("backend/api/community/users.php", { action, user_id: session.id() });
    const list = env.data?.[key] ?? env.data?.list ?? [];
    clear(box).append(el("h3", {}, title));
    if (!Array.isArray(list) || !list.length) {
      box.append(emptyBox(action === "get_following" ? "还没有关注的人" : "还没有粉丝"));
      return;
    }
    for (const u of list.slice(0, 10)) {
      const name = u.nickname || u.full_name || u.username || "冒险者";
      box.append(el("div", { class: "gd-user-row" },
        el("div", { class: "gd-avatar sm" }, name.slice(0, 1)),
        el("div", { class: "u" }, name,
          el("div", { class: "lv" }, `Lv.${u.level ?? "?"}`))));
    }
  } catch (e) {
    clear(box).append(el("h3", {}, title),
      el("div", { class: "banner warn", style: "margin:0" }, e.message));
  }
}
