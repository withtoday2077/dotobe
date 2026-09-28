// 学习小队（冒险公会）：我的小队 + 招募中小队（申请加入）+ 创建小队
// 数据：guild/team.php?action=list|create|apply
// 样式：css/guild.css（gd- 命名空间；座位进度条参照 Web 端卡片排版）

import { api } from "api";
import { go } from "router";
import { el, clear, loadingBox, errorBox, emptyBox, toastOk, toastErr, modal, field } from "ui";

const TEAM_STATUS = { recruiting: ["招募中", "gd-st-open"], active: ["进行中", "gd-st-running"], disbanded: ["已解散", "gd-st-cancel"] };

export async function renderGuildTeam(container) {
  const inner = el("div", { class: "gd-page" });
  container.append(inner);
  await draw(inner);
}

async function draw(inner) {
  clear(inner).append(loadingBox("正在加载学习小队…"));
  let env;
  try {
    env = await api.get("backend/api/guild/team.php", { action: "list" });
  } catch (e) {
    return clear(inner).append(errorBox(e.message, () => draw(inner)));
  }
  const data = env.data || {};
  const mine = data.my_teams || [];
  const recruiting = data.recruiting || [];
  clear(inner);

  inner.append(el("div", { class: "gd-page-head" },
    el("div", {},
      el("span", { class: "eyebrow" }, "ADVENTURERS GUILD"),
      el("h1", {}, "学习小队"),
      el("div", { class: "sub" }, "组队打卡，互相监督，一起养成学习习惯")),
    el("div", { class: "head-actions" },
      el("button", { class: "btn primary", onclick: () => createTeamModal(inner) }, "＋ 创建小队"))));

  // —— 我的小队 ——
  inner.append(el("div", { class: "gd-sec" }, "我的小队"));
  if (!mine.length) {
    inner.append(emptyBox("还没有加入任何小队", "下方有招募中的小队可以申请加入"));
  } else {
    const grid = el("div", { class: "gd-team-grid" });
    for (const t of mine) grid.append(teamCard(t, true));
    inner.append(grid);
  }

  // —— 招募中 ——
  inner.append(el("div", { class: "gd-sec" }, "招募中的小队"));
  if (!recruiting.length) {
    inner.append(emptyBox("暂无招募中的小队", "可以自己创建一个"));
    return;
  }
  const grid2 = el("div", { class: "gd-team-grid" });
  for (const t of recruiting) grid2.append(teamCard(t, false));
  inner.append(grid2);
}

function teamCard(t, clickable) {
  const cnt = t.member_count ?? 0;
  const max = t.max_members ?? 0;
  const full = max > 0 && cnt >= max;
  const [stLabel, stCls] = TEAM_STATUS[t.status] || [t.status, "gd-cat-other"];
  const leaderName = t.leader?.nickname || t.leader?.username || "—";

  return el("div", { class: "gd-team-card" + (clickable ? " clickable" : ""), onclick: clickable ? () => go(`guild/team-detail/${t.id}`) : undefined },
    el("div", { class: "gd-card-top" },
      el("span", { class: "name", style: "flex:1" }, t.name || "小队"),
      el("span", { class: `gd-tag ${stCls}` }, stLabel)),
    t.description ? el("p", { class: "desc" }, String(t.description)) : null,
    el("div", { class: "gd-seat-bar" + (full ? " full" : "") },
      el("i", { style: `width:${max > 0 ? Math.min(100, Math.round(cnt / max * 100)) : 0}%` })),
    el("div", { class: "gd-card-meta" },
      el("span", {}, `👥 ${cnt}/${max} 人`),
      t.checkin_deadline_time ? el("span", {}, `⏱ 打卡截止 ${String(t.checkin_deadline_time).slice(0, 5)}`) : null),
    el("div", { class: "gd-team-foot" },
      el("span", {}, `队长 ${leaderName}`),
      clickable ? el("span", { style: "margin-left:auto;color:var(--text-3)" }, "进入小队 →")
        : (full ? el("span", { class: "gd-tag gd-st-cancel", style: "margin-left:auto" }, "已满员")
          : el("button", { class: "btn sm primary", onclick: (ev) => { ev.stopPropagation(); applyTeam(t); } }, "申请加入"))));
}

async function applyTeam(t) {
  const remark = field("申请留言（选填）", "");
  const body = el("div", { class: "fields", style: "display:flex;flex-direction:column;gap:var(--sp-2)" }, remark);
  modal({ title: `申请加入「${t.name}」`, body, actions: [
    { label: "提交申请", kind: "primary", onClick: async () => {
      try {
        const env = await api.postJSON("backend/api/guild/team.php", {
          action: "apply", team_id: t.id, message: remark.input.value.trim(),
        });
        toastOk(env.message || "申请已提交，等待队长审核");
      } catch (e) { toastErr(e.message); }
    } },
  ] });
}

function createTeamModal(inner) {
  const name = field("小队名称（必填）", "");
  const desc = field("小队简介", "", { textarea: true });
  const deadline = field("每日打卡截止时间（如 22:00）", "22:00");
  const maxMembers = field("人数上限", "6");
  modal({ title: "创建学习小队", body:
    el("div", { class: "fields", style: "display:flex;flex-direction:column;gap:var(--sp-2)" }, name, desc, deadline, maxMembers),
    actions: [
      { label: "创建", kind: "primary", onClick: async () => {
        try {
          const env = await api.postJSON("backend/api/guild/team.php", {
            action: "create",
            name: name.input.value.trim(),
            description: desc.input.value.trim(),
            checkin_deadline_time: deadline.input.value.trim() || "23:59:59",
            max_members: Number(maxMembers.input.value) || 6,
          });
          toastOk(env.message || "小队创建成功");
          draw(document.querySelector(".content > div") || document.querySelector(".content"));
        } catch (e) { toastErr(e.message); }
      } },
    ] });
}
