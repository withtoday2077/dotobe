// 学习小队 · 详情页（冒险公会）
// 路由: guild/team-detail/<id>
// Tabs: 概览 / 学习计划 / 打卡任务 / 投票中心 / 打卡 / 聊天室 / 成员管理(队长)
// 接口: guild/team.php（create_plan/list_plans/complete_plan/create_task/list_tasks/disable_task/
//        vote/list_votes/checkin/today_status/checkin_history/upload_evidence/
//        messages/send_message/delete_message/list_applications/approve/kick）
// 样式：css/guild.css（gd- 命名空间）

import { api, session } from "api";
import { el, clear, loadingBox, errorBox, emptyBox, toastOk, toastErr, confirmModal, field, modal } from "ui";
import { go } from "router";
import { isAndroid, pickFiles } from "mobile";

let teamId = 0;
let state = {};
let chatTimer = null;

export async function renderGuildTeamDetail(container, param) {
  reset();
  teamId = Number(param) || 0;
  const root = el("div", { class: "gd-page" });
  container.append(root);
  root.append(loadingBox("正在打开小队…"));

  let env;
  try {
    env = await api.get("backend/api/guild/team.php", { action: "detail", team_id: teamId });
  } catch (e) {
    return clear(root).append(errorBox(e.message, () => go("guild/team")));
  }
  if (!env.success) {
    clear(root).append(errorBox(env.message || "小队不存在或已解散", () => go("guild/team")));
    return;
  }
  const d = env.data || {};
  state = {
    team: d.team || {},
    members: d.members || [],
    me: d.my_membership,
    pendingApps: d.pending_applications || 0,
    todayProgress: d.today_progress || {},
    tab: "overview",
  };
  if (!state.me) {
    clear(root).append(el("div", { class: "card", style: "text-align:center;padding:64px;margin:48px auto;max-width:520px" },
      el("h2", {}, "还不是该小队成员"),
      el("p", { style: "color:var(--text-2);margin:12px 0 20px" }, "申请加入后才能查看小队内容"),
      el("button", { class: "btn primary", onclick: () => go("guild/team") }, "返回小队列表")));
    return;
  }
  drawShell(root);
  await switchTab("overview");
}

function reset() {
  if (chatTimer) { clearInterval(chatTimer); chatTimer = null; }
  teamId = 0;
  state = {};
}

function isLeader() { return state.me?.role === "leader"; }
function meId() { return session.id(); }
function baseUrl() { return api.baseUrlSync(); }
function avatarOf(name) { return el("div", { class: "gd-avatar sm" }, (name || "?").slice(0, 1)); }

const PROP_STATUS = {
  voting: ["投票中", "gd-st-voting"], active: ["进行中", "gd-st-active"], completed: ["已完成", "gd-st-completed"],
  expired: ["已过期", "gd-st-expired"], rejected: ["已否决", "gd-st-rejected"], disabled: ["已停用", "gd-st-disabled"],
};

function teamStatusChip(s) {
  const [label, cls] = { recruiting: ["招募中", "gd-st-open"], active: ["进行中", "gd-st-running"], disbanded: ["已解散", "gd-st-cancel"] }[s]
    || [s, "gd-cat-other"];
  return el("span", { class: `gd-tag ${cls}` }, label);
}

// ---------------- 壳与 Tab ----------------

function drawShell(root) {
  const t = state.team;
  clear(root);

  const head = el("div", { class: "gd-team-head" },
    el("button", { class: "gd-back", onclick: () => go("guild/team") }, "← 返回小队列表"),
    el("div", { class: "card", style: "padding:var(--sp-3) var(--sp-4)" },
      el("div", { class: "row" },
        el("h1", { style: "flex:1;min-width:200px" }, t.name || "小队"),
        teamStatusChip(t.status),
        el("span", { class: "gd-tag" }, `👥 ${state.members.length}/${t.max_members ?? "?"}`),
        isLeader() ? el("span", { class: "gd-tag gd-st-confirm" }, "👑 队长") : null),
      t.description ? el("p", { class: "desc" }, t.description) : null,
      el("div", { class: "gd-card-meta", style: "margin-top:8px" },
        t.checkin_deadline_time ? el("span", {}, `⏱ 每日打卡截止 ${t.checkin_deadline_time}`) : null,
        state.pendingApps > 0 && isLeader() ? el("span", { class: "gd-tag gd-st-review" }, `${state.pendingApps} 条申请待审批`) : null)));
  root.append(head);

  const tabs = [
    ["overview", "概览"], ["plans", "学习计划"], ["tasks", "打卡任务"],
    ["votes", "投票中心"], ["checkin", "打卡"], ["chat", "聊天室"],
  ];
  if (isLeader()) tabs.push(["members", `成员管理`]);
  const tabBar = el("div", { class: "gd-tabs" });
  const tabBtns = {};
  for (const [key, label] of tabs) {
    const b = el("button", { class: "gd-tab" + (key === "overview" ? " active" : ""), onclick: () => switchTab(key) }, label);
    if (key === "members" && state.pendingApps > 0) b.append(el("span", { class: "cnt" }, String(state.pendingApps)));
    tabBtns[key] = b;
    tabBar.append(b);
  }
  root.append(tabBar);

  const tabBody = el("div");
  root.append(tabBody);
  state.tabBar = tabBar;
  state.tabBtns = tabBtns;
  state.tabBody = tabBody;
}

function setTabActive(key) {
  if (!state.tabBtns) return;
  for (const [k, b] of Object.entries(state.tabBtns)) b.classList.toggle("active", k === key);
  state.tab = key;
}

async function switchTab(key) {
  const body = state.tabBody;
  if (!body) return;
  if (chatTimer && key !== "chat") { clearInterval(chatTimer); chatTimer = null; }
  setTabActive(key);
  clear(body).append(loadingBox("加载中…"));
  try {
    if (key === "overview") await drawOverview(body);
    else if (key === "plans") await drawPlans(body);
    else if (key === "tasks") await drawTasks(body);
    else if (key === "votes") await drawVotes(body);
    else if (key === "checkin") await drawCheckin(body);
    else if (key === "chat") await drawChat(body);
    else if (key === "members") await drawMembers(body);
  } catch (e) {
    clear(body).append(errorBox("加载失败：" + (e.message || e), () => switchTab(key)));
  }
}

// ---------------- 概览 ----------------

async function drawOverview(body) {
  const env = await api.get("backend/api/guild/team.php", { action: "today_status", team_id: teamId });
  const d = env.data || {};
  const tasks = d.tasks || [];
  const matrix = d.matrix || [];

  clear(body);
  body.append(el("div", { class: "gd-sec" }, `今日打卡进度 · ${d.today || ""}`));

  if (!tasks.length) {
    body.append(emptyBox("今天没有启用的打卡任务"));
  } else {
    const p = state.todayProgress || {};
    body.append(el("div", { class: "card", style: "padding:var(--sp-2) var(--sp-3);margin-bottom:var(--sp-2)" },
      el("div", { style: "display:flex;align-items:center;gap:14px;flex-wrap:wrap" },
        el("span", { style: "font-size:var(--fs-h3);font-weight:300" },
          `必做完成 ${p.required_done ?? 0} / ${p.required_total ?? 0}`),
        el("span", { class: "gd-tag gd-st-active" }, `${p.pct ?? 0}%`)),
      el("div", { class: "gd-seat-bar", style: "margin-top:10px" },
        el("i", { style: `width:${Math.min(100, p.pct ?? 0)}%` }))));

    const table = el("table", { class: "table gd-matrix" });
    const headRow = el("tr", {}, el("th", {}, "成员"));
    for (const t of tasks) headRow.append(el("th", { style: "text-align:center" }, String(t.title).slice(0, 8)));
    table.append(el("thead", {}, headRow));
    const tbody = el("tbody");
    for (const row of matrix) {
      const tr = el("tr", {}, el("td", {}, row.nickname));
      for (const t of tasks) {
        const done = (row.done_task_ids || []).includes(t.id);
        tr.append(el("td", { style: "text-align:center" },
          el("span", { class: `mark ${done ? "ok" : "no"}` }, done ? "✔" : "—")));
      }
      tbody.append(tr);
    }
    table.append(tbody);
    body.append(el("div", { class: "card gd-matrix-wrap", style: "padding:14px" }, table));
  }

  body.append(el("div", { class: "gd-sec" }, `成员（${state.members.length}）`));
  const mList = el("div", { class: "gd-panel" });
  for (const m of state.members) {
    mList.append(el("div", { class: "gd-row" },
      avatarOf(m.nickname || m.username),
      el("div", { class: "m" },
        el("div", { class: "t" }, m.nickname || m.username),
        el("div", { class: "s" }, `加入于 ${String(m.joined_at || "").slice(0, 10)}`)),
      m.role === "leader"
        ? el("span", { class: "gd-tag gd-st-confirm" }, "👑 队长")
        : el("span", { class: "gd-tag" }, `Lv.${m.level ?? 1}`)));
  }
  body.append(mList);
}

// ---------------- 学习计划 / 打卡任务（提案卡） ----------------

async function drawPlans(body) {
  const env = await api.get("backend/api/guild/team.php", { action: "list_plans", team_id: teamId });
  const plans = env.data?.list || [];
  clear(body);

  body.append(el("div", { class: "gd-page-head" },
    el("div", {}, el("h1", {}, "学习计划")),
    el("div", { class: "head-actions" },
      el("button", { class: "btn sm primary", onclick: () => planForm() }, "＋ 发起计划提案"))));

  if (!plans.length) return body.append(emptyBox("还没有计划提案", "发起一个计划，全队投票通过后生效"));
  for (const p of plans) body.append(propCard(p, "plan"));
}

async function drawTasks(body) {
  const env = await api.get("backend/api/guild/team.php", { action: "list_tasks", team_id: teamId });
  const tasks = env.data?.list || [];
  clear(body);

  body.append(el("div", { class: "gd-page-head" },
    el("div", {}, el("h1", {}, "打卡任务")),
    el("div", { class: "head-actions" },
      el("button", { class: "btn sm primary", onclick: () => taskForm() }, "＋ 发起新任务提案"))));

  if (!tasks.length) return body.append(emptyBox("还没有打卡任务", "发起新任务提案，全队投票通过后生效"));
  for (const t of tasks) body.append(propCard(t, "task"));
}

/** 提案卡：状态 + 标题 + 描述 + 投票进度条 + 操作 */
function propCard(p, kind) {
  const [stLabel, stCls] = PROP_STATUS[p.status] || [p.status, "gd-cat-other"];
  const total = (p.votes_yes || 0) + (p.votes_no || 0);
  const yesPct = total > 0 ? Math.round((p.votes_yes || 0) / total * 100) : 0;

  const ops = el("div", { class: "gd-prop-ops" });
  if (p.status === "voting") {
    ops.append(
      el("button", { class: "btn sm", onclick: () => doVote(kind, p.id, 1) }, "👍 赞成"),
      el("button", { class: "btn sm", onclick: () => doVote(kind, p.id, -1) }, "👎 反对"));
  }
  if (kind === "plan" && p.status === "active" && (isLeader() || p.created_by === meId())) {
    ops.append(el("button", { class: "btn sm", onclick: async () => {
      try {
        const r = await api.postJSON("backend/api/guild/team.php", { action: "complete_plan", plan_id: p.id });
        toastOk(r.message || "已完成");
        switchTab("plans");
      } catch (e) { toastErr(e.message); }
    } }, "标记完成"));
  }
  if (kind === "task" && p.status === "active" && (isLeader() || p.created_by === meId())) {
    ops.append(el("button", { class: "btn sm danger", onclick: async () => {
      try {
        const r = await api.postJSON("backend/api/guild/team.php", { action: "disable_task", task_id: p.id });
        toastOk(r.message || "已停用");
        switchTab("tasks");
      } catch (e) { toastErr(e.message); }
    } }, "停用任务"));
  }

  const card = el("div", { class: "gd-prop" },
    el("div", { class: "gd-prop-top" },
      el("span", { class: `gd-tag ${stCls}` }, stLabel),
      kind === "task" && t_required(p) ? el("span", { class: "gd-tag gd-urgent" }, "必做") : null,
      el("span", { class: "t" }, p.title),
      el("span", { class: "votes" }, `👍 ${p.votes_yes} · 👎 ${p.votes_no}`)),
    p.description ? el("div", { class: "desc" }, p.description) : null,
    el("div", { class: "meta" },
      [p.start_date && p.end_date ? `周期 ${p.start_date} ~ ${p.end_date}` : "",
       p.status === "voting" && p.vote_end_time ? `投票截止 ${String(p.vote_end_time).slice(0, 16)}` : "",
       p.status === "voting" ? `还需 ${Math.max(0, (p.votes_needed ?? 0) - (p.votes_yes || 0))} 票通过` : ""]
        .filter(Boolean).join(" · ")),
    el("div", { class: "gd-vote-bar" },
      el("i", { class: "yes", style: `width:${yesPct}%` }),
      el("i", { class: "no", style: `width:${total > 0 ? 100 - yesPct : 0}%` })),
    ops.children.length ? ops : null);
  return card;
}

function t_required(t) { return !!t.is_required; }

function planForm() {
  const title = field("计划标题", "");
  const desc = field("计划描述（可选）", "", { textarea: true });
  const start = field("开始日期（选填）", "");
  start.input.type = "date";
  const end = field("结束日期（选填）", "");
  end.input.type = "date";
  modal({ title: "发起学习计划提案", body:
    el("div", { class: "fields", style: "display:flex;flex-direction:column;gap:var(--sp-2)" }, title, desc, start, end,
      el("p", { style: "font-size:var(--fs-tiny);color:var(--text-3)" }, "提案需要全队投票，通过后正式生效")),
    actions: [
      { label: "提交提案", kind: "primary", onClick: async () => {
        try {
          const env = await api.postJSON("backend/api/guild/team.php", {
            action: "create_plan", team_id: teamId,
            title: title.input.value.trim(),
            description: desc.input.value.trim(),
            start_date: start.input.value.trim() || null,
            end_date: end.input.value.trim() || null,
          });
          toastOk(env.message || "提案已提交");
          switchTab("plans");
        } catch (e) { toastErr(e.message); }
      } },
    ] });
}

function taskForm() {
  const title = field("任务标题", "");
  const desc = field("任务描述（可选）", "", { textarea: true });
  const required = el("input", { type: "checkbox", checked: "" });
  modal({ title: "发起新打卡任务提案", body:
    el("div", { class: "fields", style: "display:flex;flex-direction:column;gap:var(--sp-2)" },
      title, desc,
      el("label", { style: "display:flex;gap:8px;align-items:center;font-size:var(--fs-small);color:var(--text-2)" },
        required, "设为必做任务（全队完成有全勤奖励）"),
      el("p", { style: "font-size:var(--fs-tiny);color:var(--text-3)" }, "提案需要全队投票，通过后正式生效")),
    actions: [
      { label: "提交提案", kind: "primary", onClick: async () => {
        try {
          const env = await api.postJSON("backend/api/guild/team.php", {
            action: "create_task", team_id: teamId,
            title: title.input.value.trim(),
            description: desc.input.value.trim(),
            is_required: required.checked ? 1 : 0,
          });
          toastOk(env.message || "提案已提交");
          switchTab("tasks");
        } catch (e) { toastErr(e.message); }
      } },
    ] });
}

// ---------------- 投票中心 ----------------

async function drawVotes(body) {
  const [plansEnv, tasksEnv] = await Promise.all([
    api.get("backend/api/guild/team.php", { action: "list_plans", team_id: teamId }),
    api.get("backend/api/guild/team.php", { action: "list_tasks", team_id: teamId }),
  ]);
  const voting = [
    ...(plansEnv.data?.list || []).filter((x) => x.status === "voting").map((x) => ({ ...x, _kind: "plan" })),
    ...(tasksEnv.data?.list || []).filter((x) => x.status === "voting").map((x) => ({ ...x, _kind: "task" })),
  ];
  clear(body);

  body.append(el("div", { class: "gd-page-head" },
    el("div", {}, el("h1", {}, "投票中心"),
      el("div", { class: "sub" }, "正在等待你表决的提案"))));

  if (!voting.length) return body.append(emptyBox("没有进行中的投票", "新的计划/任务提案发起后会出现在这里"));
  for (const p of voting) body.append(propCard(p, p._kind));
}

async function doVote(type, id, val) {
  try {
    const env = await api.postJSON("backend/api/guild/team.php", {
      action: "vote", team_id: teamId, target_type: type, target_id: id, vote: val,
    });
    toastOk(env.message || "已投票");
    switchTab(state.tab);
  } catch (e) { toastErr(e.message); }
}

// ---------------- 打卡 ----------------

async function drawCheckin(body) {
  const env = await api.get("backend/api/guild/team.php", { action: "today_status", team_id: teamId });
  const d = env.data || {};
  const tasks = d.tasks || [];
  clear(body);

  body.append(el("div", { class: "gd-page-head" },
    el("div", {}, el("h1", {}, "今日打卡"),
      el("div", { class: "sub" }, "上传证据图完成打卡，全队全勤有额外奖励"))));
  if (!tasks.length) {
    body.append(emptyBox("今天没有启用的打卡任务"));
    return;
  }

  const sel = el("select", { class: "input", style: "max-width:360px" },
    ...tasks.map((t) => el("option", { value: t.id }, `${t.title}${t.is_required ? "（必做）" : ""}`)));
  const note = field("打卡备注（选填）", "", { textarea: true });
  note.input.style.minHeight = "60px";
  const evPath = el("span", { style: "font-size:var(--fs-tiny);color:var(--ok)" });
  let imagePath = "";

  const pickBtn = el("button", { class: "btn sm", onclick: async () => {
    let filePath = null;
    if (!isAndroid()) {
      try {
        const { open } = window.__TAURI__.dialog;
        filePath = await open({ multiple: false, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }] });
      } catch { return; }
      filePath = Array.isArray(filePath) ? filePath[0] : filePath;
      if (!filePath) return;
    }
    pickBtn.disabled = true;
    pickBtn.textContent = "上传中…";
    try {
      // Android：file input 直读内存 → uploadBytes（content:// 路径 Rust 读不了）
      const up = isAndroid()
        ? await (async () => {
            const [it] = await pickFiles({ accept: "image/*", read: "b64" });
            if (!it) return null;
            return api.uploadBytes("backend/api/guild/team.php?action=upload_evidence", "image", it.name, it.b64, it.mime);
          })()
        : await api.upload("backend/api/guild/team.php?action=upload_evidence", "image", filePath);
      if (!up) { pickBtn.disabled = false; return; }
      imagePath = up.data?.image_path || "";
      evPath.textContent = imagePath ? "✓ 证据图已上传" : "";
      pickBtn.textContent = "重新上传";
    } catch (e) {
      toastErr("上传失败：" + (e.message || e));
      pickBtn.disabled = false;
      pickBtn.textContent = "上传打卡证据图";
    }
  } }, "上传打卡证据图");

  body.append(el("div", { class: "card gd-checkin-form", style: "padding:var(--sp-3) var(--sp-4)" },
    el("div", { class: "field filled" }, sel, el("label", {}, "选择任务")),
    el("div", { style: "display:flex;gap:12px;align-items:center;margin:14px 0" }, pickBtn, evPath),
    note));

  body.append(el("button", { class: "btn primary", style: "margin-top:var(--sp-2)", onclick: async () => {
    try {
      const env = await api.postJSON("backend/api/guild/team.php", {
        action: "checkin", team_id: teamId,
        task_id: Number(sel.value) || 0,
        evidence_image: imagePath,
        note: note.input.value.trim(),
      });
      const bonus = env.data?.full_bonus ? "（达成全勤！全队奖励金币）" : "";
      toastOk(`打卡成功！金币 +${env.data?.gold_gained ?? 0}，经验 +${env.data?.exp_gained ?? 0} ${bonus}`);
      drawCheckin(body);
    } catch (e) { toastErr(e.message); }
  } }, "提交打卡"));

  // 打卡历史
  body.append(el("div", { class: "gd-sec" }, "打卡记录"));
  const env2 = await api.get("backend/api/guild/team.php", { action: "checkin_history", team_id: teamId, page: 1 });
  const list = env2.data?.list || [];
  if (!list.length) {
    body.append(emptyBox("还没有打卡记录"));
    return;
  }
  const hist = el("div", { class: "gd-panel" });
  for (const c of list.slice(0, 15)) {
    hist.append(el("div", { class: "gd-history-item" },
      c.evidence_url ? el("img", { src: baseUrl() + c.evidence_url }) : null,
      el("div", { class: "m" },
        el("div", { class: "t" }, c.task_title || "任务"),
        el("div", { class: "s" }, `${c.nickname || c.username} · ${c.checkin_date}${c.note ? " · " + c.note : ""}`))));
  }
  body.append(hist);
}

// ---------------- 聊天室 ----------------

async function drawChat(body) {
  clear(body);
  const list = el("div", { class: "gd-chat-body" });
  const input = el("input", { class: "input", placeholder: "输入消息，回车发送…" });
  const send = el("button", { class: "btn primary", onclick: () => sendMsg() }, "发送");
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") sendMsg(); });

  body.append(el("h1", { style: "margin-bottom:var(--sp-2)" }, "小队聊天室"),
    el("div", { class: "gd-chat" },
      el("div", { class: "gd-chat-head" },
        el("span", { class: "dot-live" }),
        el("span", { style: "font-size:var(--fs-small);color:var(--text-2)" }, ""),
        el("span", { style: "margin-left:auto;font-size:var(--fs-tiny);color:var(--text-3)" }, `${state.members.length} 名成员`)),
      list,
      el("div", { class: "gd-chat-composer" }, input, send)));

  async function refresh() {
    try {
      const env = await api.get("backend/api/guild/team.php", { action: "messages", team_id: teamId });
      const msgs = env.data?.list || [];
      clear(list);
      for (const m of msgs) {
        list.append(el("div", { class: "gd-msg" + (m.is_me ? " me" : "") },
          el("div", { class: "who" }, `${m.nickname || m.username} · ${String(m.created_at || "").slice(11, 16)}`),
          el("div", { class: "bubble" + (m.is_deleted ? " deleted" : "") },
            m.is_deleted ? "（消息已删除）" : m.content)));
      }
      list.scrollTop = list.scrollHeight;
    } catch {}
  }
  async function sendMsg() {
    const v = input.value.trim();
    if (!v) return;
    try {
      await api.postJSON("backend/api/guild/team.php", { action: "send_message", team_id: teamId, content: v });
      input.value = "";
      await refresh();
    } catch (e) { toastErr(e.message); }
  }
  await refresh();
  chatTimer = setInterval(refresh, 5000);
}

// ---------------- 成员管理（队长） ----------------

async function drawMembers(body) {
  clear(body);
  body.append(el("div", { class: "gd-page-head" },
    el("div", {}, el("h1", {}, "成员管理"))));

  let appEnv;
  try {
    appEnv = await api.get("backend/api/guild/team.php", { action: "list_applications", team_id: teamId });
  } catch (e) { appEnv = { data: { list: [] } }; }
  const apps = appEnv.data?.list || [];

  body.append(el("div", { class: "gd-sec" }, `待审批申请（${apps.length}）`));
  if (!apps.length) {
    body.append(emptyBox("没有待处理的申请"));
  } else {
    const box = el("div", { class: "gd-panel" });
    for (const a of apps) {
      box.append(el("div", { class: "gd-row" },
        avatarOf(a.nickname || a.username),
        el("div", { class: "m" },
          el("div", { class: "t" }, a.nickname || a.username || `用户${a.user_id}`),
          a.message ? el("div", { class: "s" }, a.message) : null),
        el("div", { class: "ops" },
          el("button", { class: "btn sm primary", onclick: () => reviewApp(a.id, true) }, "通过"),
          el("button", { class: "btn sm danger", onclick: () => reviewApp(a.id, false) }, "拒绝"))));
    }
    body.append(box);
  }

  body.append(el("div", { class: "gd-sec" }, `成员列表（${state.members.length}）`));
  const mList = el("div", { class: "gd-panel" });
  for (const m of state.members) {
    const isSelf = m.user_id === meId();
    const isLeaderMember = m.role === "leader";
    mList.append(el("div", { class: "gd-row" },
      avatarOf(m.nickname || m.username),
      el("div", { class: "m" },
        el("div", { class: "t" }, m.nickname || m.username),
        el("div", { class: "s" }, `加入于 ${String(m.joined_at || "").slice(0, 10)}`)),
      m.role === "leader"
        ? el("span", { class: "gd-tag gd-st-confirm" }, "👑 队长")
        : el("span", { class: "gd-tag" }, `Lv.${m.level ?? 1}`),
      (!isSelf && !isLeaderMember) ? el("div", { class: "ops" },
        el("button", { class: "btn sm danger", onclick: () =>
          confirmModal("移出成员", `确定将「${m.nickname || m.username}」移出小队吗？`, async () => {
            try {
              await api.postJSON("backend/api/guild/team.php", { action: "kick", team_id: teamId, user_id: m.user_id });
              toastOk("已移出");
              switchTab("members");
            } catch (e) { toastErr(e.message); }
          }, "移出", "danger") }, "移出")) : null));
  }
  body.append(mList);
}

async function reviewApp(appId, approve) {
  try {
    const env = await api.postJSON("backend/api/guild/team.php", {
      action: "approve", application_id: appId, approve: approve ? 1 : 0,
    });
    toastOk(env.message || "已处理");
    switchTab("members");
  } catch (e) { toastErr(e.message); }
}
