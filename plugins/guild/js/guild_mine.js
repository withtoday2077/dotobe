// 我的任务（冒险公会）：我发布的 / 我接受的（下划线 Tabs + 列表行）
// 数据：guild/tasks.php?action=mine&role=published|accepted
// 样式：css/guild.css（gd- 命名空间）

import { api } from "api";
import { el, clear, loadingBox, errorBox, emptyBox, toastOk, toastErr, confirmModal } from "ui";
import { go } from "router";

const state = { role: "published" };

const STATUS = {
  pending_review: ["待审核", "gd-st-review"], open: ["招募中", "gd-st-open"], locked: ["待确认", "gd-st-locked"],
  in_progress: ["执行中", "gd-st-running"], pending_confirm: ["待验收", "gd-st-confirm"], completed: ["已完成", "gd-st-done"],
  cancelled: ["已取消", "gd-st-cancel"], arbitration: ["仲裁中", "gd-st-arb"], rejected: ["已驳回", "gd-st-cancel"],
};

export async function renderGuildMytasks(container) {
  const inner = el("div", { class: "gd-page" });
  container.append(inner);
  await draw(inner);
}

async function draw(inner) {
  // 首屏：骨架（页头 + Tabs）只建一次，切换 tab 只局部刷新列表区，避免整页闪烁
  clear(inner).append(loadingBox("正在加载我的任务…"));
  let env;
  try {
    env = await api.get("backend/api/guild/tasks.php", { action: "mine", role: state.role });
  } catch (e) {
    return clear(inner).append(errorBox(e.message, () => draw(inner)));
  }
  clear(inner);

  inner.append(el("div", { class: "gd-page-head" },
    el("div", {},
      el("span", { class: "eyebrow" }, "ADVENTURERS GUILD"),
      el("h1", {}, "我的任务"),
      el("div", { class: "sub" }, "追踪委托的执行与验收")),
    el("div", { class: "head-actions" },
      el("button", { class: "btn primary", onclick: () => go("guild/publish") }, "＋ 发布任务"))));

  // 下划线 Tabs（静态，激活态就地切换）
  const tabs = el("div", { class: "gd-tabs" },
    tabBtn("published", "我发布的"), tabBtn("accepted", "我接受的"));
  tabs.addEventListener("click", (ev) => {
    const b = ev.target.closest(".gd-tab");
    if (b && state.role !== b.dataset.role) {
      state.role = b.dataset.role;
      tabs.querySelectorAll(".gd-tab").forEach((x) => x.classList.toggle("active", x === b));
      refreshList();
    }
  });
  inner.append(tabs);

  // 列表区（局部刷新）
  const listZone = el("div", { class: "gd-results" });
  inner.append(listZone);

  function renderList(env) {
    const data = env.data || {};
    const list = data.list || data.tasks || [];
    clear(listZone);
    if (!list.length) {
      listZone.append(emptyBox(state.role === "published" ? "还没有发布过任务" : "还没有接受任务",
        state.role === "published" ? "点右上「发布任务」发布第一单" : "去「任务大厅」看看有什么可以帮忙的"));
      return;
    }
    const wrap = el("div", { class: "gd-mine-list" });
    for (const t of list) wrap.append(taskRow(t, refreshList));
    listZone.append(wrap);
  }

  async function refreshList() {
    listZone.style.opacity = "0.45";
    listZone.style.pointerEvents = "none";
    try {
      const env = await api.get("backend/api/guild/tasks.php", { action: "mine", role: state.role });
      renderList(env);
    } catch (e) {
      clear(listZone).append(errorBox(e.message, () => refreshList()));
    } finally {
      listZone.style.opacity = "";
      listZone.style.pointerEvents = "";
    }
  }

  renderList(env);
}

function tabBtn(role, label) {
  return el("button", { class: "gd-tab" + (state.role === role ? " active" : ""), "data-role": role }, label);
}

function taskRow(t, onChanged) {
  const id = t.task_id ?? t.id;
  const [stLabel, stCls] = STATUS[t.status] || [t.status || "—", "gd-cat-other"];

  const ops = [];
  if (state.role === "published" && (t.status === "open" || t.status === "pending_review")) {
    ops.push(el("button", { class: "btn sm danger", onclick: () =>
      confirmModal("取消任务", `确定取消「${t.title}」吗？`, async () => {
        try {
          await api.postJSON("backend/api/guild/tasks.php", { action: "cancel", task_id: id });
          toastOk("已取消");
          onChanged();
        } catch (e) { toastErr(e.message); }
      }, "取消", "danger") }, "取消任务"));
  }
  if (state.role === "accepted" && t.status === "in_progress") {
    ops.push(el("button", { class: "btn sm primary", onclick: () =>
      confirmModal("提交完成", "确认已完成该任务并提交发布者验收吗？", async () => {
        try {
          await api.postJSON("backend/api/guild/assignments.php", { action: "submit", task_id: id });
          toastOk("已提交验收");
          onChanged();
        } catch (e) { toastErr(e.message); }
      }, "提交", "primary") }, "提交完成"));
  }
  if (state.role === "published" && t.status === "pending_confirm") {
    ops.push(el("button", { class: "btn sm primary", onclick: () =>
      confirmModal("验收通过", "确认执行者已完成任务吗？通过后任务完成。", async () => {
        try {
          await api.postJSON("backend/api/guild/assignments.php", { action: "complete", task_id: id });
          toastOk("已验收，任务完成");
          onChanged();
        } catch (e) { toastErr(e.message); }
      }, "验收通过") }, "验收"));
  }

  return el("div", { class: "gd-mine-item" },
    el("div", { class: "gd-mine-main" },
      el("div", { class: "gd-mine-top" },
        el("span", { class: "t" }, t.title || "任务"),
        el("span", { class: `gd-tag ${stCls}` }, stLabel),
        t.reward_amount != null && Number(t.reward_amount) > 0
          ? el("span", { class: "gd-tag gd-reward" + (t.reward_type === "cash" ? " cash" : "") },
              t.reward_type === "cash" ? `¥${Number(t.reward_amount)}` : `${Number(t.reward_amount)} 金币`)
          : null),
      el("div", { class: "gd-mine-meta" },
        el("span", {}, `发布 ${String(t.created_at || "").slice(0, 10)}`),
        t.deadline ? el("span", {}, `截止 ${String(t.deadline).slice(0, 10)}`) : null,
        t.assignee?.nickname ? el("span", {}, `执行者 ${t.assignee.nickname}`) : null)),
    el("div", { class: "gd-mine-side" }, ...ops));
}
