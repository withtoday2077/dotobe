// 控制面板：时段问候 + 统计卡 + 打卡日历（事件增删/标记完成/颜色标签） + 最近考试 + 推荐考试
// 数据：page/dashboard.php（statistics/recent_exams/recommended_exams）；日历事件走 calendar.php

import { api, session } from "../api.js";
import { el, clear, loadingBox, errorBox, emptyBox, chip, fmtScore, fmtDate, botanical, toastOk, toastErr, modal, confirmModal, field } from "../ui.js";
import { go } from "../router.js";
import { getActivePlugins } from "../plugin-state.js";

const DOW = ["一", "二", "三", "四", "五", "六", "日"];

export async function renderDashboard(container) {
  const inner = el("div");
  container.append(inner);
  inner.append(loadingBox("正在获取数据…"));

  let data;
  try {
    const env = await api.get("backend/api/page/dashboard.php");
    data = env.data || {};
  } catch (e) {
    return clear(inner).append(errorBox(e.message, () => renderDashboard(container)));
  }
  clear(inner);

  const now = new Date();
  const hour = now.getHours();
  const greet = hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
  const name = (session.user?.full_name || session.user?.username || "").split(" ")[0];

  // 真实接口结构（与 web 端对齐）：
  // statistics{overall{total_exams,avg_score,max_score}, week{avg_score,exam_count}, month{avg_score,exam_count}}
  // progress{completed,total,percentage} / exam_records[] / available_exams[]
  // 日历数据来自独立的 calendar.php
  const stats = data.statistics || {};
  const overall = stats.overall || {};
  const month = stats.month || {};
  const week = stats.week || {};
  const progress = data.progress || {};
  const recent = data.exam_records || [];
  const available = data.available_exams || [];

  const greetBox = el("div", { class: "dash-greet", style: "position:relative" },
    el("h1", {}, `${greet}，${name}`),
    el("div", { class: "date" }, `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · 星期${DOW[(now.getDay() + 6) % 7]}`,
      progress.total ? el("span", { style: "margin-left:18px;color:var(--info)" }, `学习进度 ${fmtScore(progress.percentage ?? 0)}%（${progress.completed ?? 0}/${progress.total} 场已通过）`) : null)
  );

  const statCards = el("div", { class: "grid cols-4" },
    statCard("本月平均分", fmtScore(month.avg_score ?? 0), "分", "sky"),
    statCard("本周考试", String(week.exam_count ?? 0), "次", "mint"),
    statCard("历史最高分", fmtScore(overall.max_score ?? 0), "分", "pink"),
    statCard("累计学习", String(overall.total_exams ?? 0), "次", "warn"),
  );

  // 插件市场引导卡（常驻：核心四板块之外的功能都从这里进入）
  const installedCount = getActivePlugins().length;
  const discoverCard = el("div", { class: "discover-card", onclick: () => go("market") },
    el("span", { class: "big" }, "🧩"),
    el("div", {},
      el("div", { class: "t" }, "插件市场 · 发现更多功能"),
      el("div", { class: "d" }, installedCount
        ? `已安装 ${installedCount} 个功能插件，点击管理或发现新的`
        : "知识树、学习记录、本地题库、冒险公会……按需安装，不用不装")),
    el("span", { class: "arrow" }, "→"));

  // 双栏：日历 + 最近考试；下方：可参加的考试
  const calBox = calendarCard();
  const recentBox = recentCard(recent);
  const recoBox = availableCard(available);

  inner.append(
    greetBox,
    statCards,
    el("div", { class: "section-gap" }),
    discoverCard,
    el("div", { class: "section-gap" }),
    el("div", { class: "grid cols-2" }, calBox, recentBox),
    el("div", { class: "section-gap" }),
    recoBox
  );
}

// —— 打卡日历：颜色即标签 ——
// calendar.php?year&month → data 为按日期分组对象 { "YYYY-MM-DD": [{id, event_title, event_description, color, is_completed}] }
const TAG_COLORS = ["#667eea", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899"];

// 本地日期键（toISOString 是 UTC，UTC+8 凌晨会算成前一天）
function todayKey() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

// 标签色 → 同色 40% 透明填充（圆圈勾选徽标统一透明度）
function fillRgba(hex) {
  const h = String(hex || "#667eea").replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.4)`;
}

function calendarCard() {
  const evMap = new Map(); // "YYYY-MM-DD" → [事件]
  let view = new Date();
  view.setDate(1);

  const card = el("div", { class: "card cal", style: "position:relative;min-height:340px" },
    botanical("leaf", "top:-8px;right:-6px;width:90px;height:100px;opacity:0.25"));
  const body = el("div");
  card.append(body);

  async function loadMonth() {
    evMap.clear();
    try {
      const env = await api.get("backend/api/calendar.php", {
        year: view.getFullYear(),
        month: view.getMonth() + 1,
      });
      const d = env.data;
      if (d && typeof d === "object" && !Array.isArray(d)) {
        for (const [date, list] of Object.entries(d)) {
          if (Array.isArray(list) && list.length) evMap.set(String(date).slice(0, 10), list);
        }
      }
    } catch {
      // 加载失败保持空日历，不打断面板其余区块
    }
    draw();
  }

  function draw() {
    const y = view.getFullYear(), m = view.getMonth();
    const first = new Date(y, m, 1);
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7; // 周一为首
    const todayStr = todayKey();

    const grid = el("div", { class: "cal-grid" });
    for (const d of DOW) grid.append(el("div", { class: "dow" }, d));
    for (let i = 0; i < lead; i++) grid.append(el("div", { class: "cal-cell dim" }));
    for (let day = 1; day <= daysInMonth; day++) {
      const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const evs = evMap.get(key) || [];
      const allDone = evs.length > 0 && evs.every((e) => Number(e.is_completed));
      const cell = el("div", {
        class: "cal-cell" + (key === todayStr ? " today" : "") + (evs.length ? " has-event" : "") + (allDone ? " alldone" : ""),
        onclick: () => openDayModal(key),
      }, String(day));
      if (evs.length) {
        const dots = el("div", { class: "cal-dots" });
        for (const ev of evs.slice(0, 3)) {
          dots.append(el("span", {
            class: "cal-chk",
            style: `color:${ev.color || "#667eea"};background:${fillRgba(ev.color)}`,
          }));
        }
        if (evs.length > 3) dots.append(el("span", { class: "cal-more" }, `+${evs.length - 3}`));
        cell.append(dots);
      }
      grid.append(cell);
    }

    clear(body).append(
      el("div", { class: "cal-head" },
        el("button", { onclick: () => { view = new Date(y, m - 1, 1); loadMonth(); } }, "‹"),
        el("div", { class: "month" }, `${y} 年 ${m + 1} 月`),
        el("button", { onclick: () => { view = new Date(y, m + 1, 1); loadMonth(); } }, "›")),
      grid
    );
  }

  // 点击日期：当日事件管理（标记完成 / 删除 / 添加带颜色标签的事件）
  function openDayModal(dateKey) {
    // 统一兜底：API 报错 → toast，弹窗不闪退
    const act = (fn) => async () => {
      try { await fn(); } catch (e) { toastErr(e.message || String(e)); }
    };
    const refresh = act(async () => {
      await loadMonth();
      drawList(evMap.get(dateKey) || []);
    });

    const list = el("div", { class: "ev-list" });
    let picked = TAG_COLORS[0];
    const title = field("事件标题");
    const desc = field("事件描述（可选）", "", { textarea: true });
    const picker = el("div", { class: "color-picker" },
      TAG_COLORS.map((c, i) => el("div", {
        class: "color-option" + (i === 0 ? " selected" : ""),
        style: `background:${c}`,
        onclick: (e) => {
          picked = c;
          picker.querySelectorAll(".color-option").forEach((o) => o.classList.remove("selected"));
          e.currentTarget.classList.add("selected");
        },
      }))
    );

    function drawList(evs) {
      clear(list);
      if (!evs.length) {
        list.append(el("div", { class: "ev-empty" }, "暂无事件，在下方添加一条吧"));
        return;
      }
      for (const ev of evs) {
        const done = !!Number(ev.is_completed);
        list.append(el("div", { class: "ev-item" },
          el("span", { class: "ev-chk", style: `color:${ev.color || "#667eea"};background:${fillRgba(ev.color)}` }),
          el("div", { class: "ev-content" },
            el("div", { class: "ev-title" + (done ? " done" : "") }, ev.event_title || "（无标题）"),
            ev.event_description ? el("div", { class: "ev-desc" }, ev.event_description) : null),
          el("div", { class: "ev-actions" },
            el("button", {
              class: "ev-btn",
              title: done ? "标记为未完成" : "标记为完成",
              onclick: act(async () => {
                await api.raw("backend/api/calendar.php", {
                  method: "PUT",
                  body: { id: ev.id, action: "toggle_complete" },
                  json: true,
                });
                toastOk(done ? "已标记为未完成" : "已完成 ✓");
                await refresh();
              }),
            }, done ? "↺" : "✓"),
            el("button", {
              class: "ev-btn del",
              title: "删除事件",
              onclick: () => confirmModal("删除事件", `确定删除「${ev.event_title || "无标题"}」吗？`, act(async () => {
                await api.raw("backend/api/calendar.php", { method: "DELETE", params: { id: ev.id } });
                toastOk("事件已删除");
                await refresh();
              }), "删除", "danger"),
            }, "×")),
        ));
      }
    }
    drawList(evMap.get(dateKey) || []);

    modal({
      title: `${Number(dateKey.slice(5, 7))} 月 ${Number(dateKey.slice(8, 10))} 日 · 学习安排`,
      body: el("div", {},
        list,
        el("div", { class: "ev-form" },
          el("div", { class: "ev-form-label" }, "添加新事件"),
          title,
          desc,
          el("div", { class: "ev-form-label" }, "标签颜色"),
          picker,
          el("button", {
            class: "btn primary block",
            onclick: act(async () => {
              const t = title.input.value.trim();
              if (!t) {
                toastErr("请输入事件标题");
                return;
              }
              await api.postJSON("backend/api/calendar.php", {
                event_date: dateKey,
                event_title: t,
                event_description: desc.input.value.trim(),
                color: picked,
              });
              toastOk("事件已添加");
              title.input.value = "";
              desc.input.value = "";
              title.classList.remove("filled");
              desc.classList.remove("filled");
              await refresh();
            }),
          }, "添加事件"))),
    });
  }

  loadMonth();
  return card;
}

function statCard(label, value, unit, tone) {
  return el("div", { class: `card stat ${tone}` },
    el("div", { class: "label" }, label),
    el("div", { class: "value" }, value, unit ? el("small", { style: "font-size:0.9rem;color:var(--text-3)" }, " " + unit) : null)
  );
}

function recentCard(recent) {
  const card = el("div", { class: "card" },
    el("div", { class: "card-title" }, el("h3", {}, "最近考试")));
  if (!recent.length) {
    card.append(emptyBox("还没有考试记录", "去「考试中心」开始第一场考试吧"));
    return card;
  }
  const tbody = el("tbody");
  for (const r of recent.slice(0, 6)) {
    tbody.append(el("tr", { style: "cursor:pointer", onclick: () => go(`review/${r.exam_id},${r.id}`) },
      el("td", { style: "max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, r.title || "考试"),
      el("td", {}, fmtScore(r.score)),
      el("td", { style: "color:var(--text-3);font-size:var(--fs-small)" }, fmtDate(r.completed_at)),
    ));
  }
  card.append(el("table", { class: "table" },
    el("thead", {}, el("tr", {},
      el("th", {}, "考试"), el("th", {}, "得分"), el("th", {}, "时间"))),
    tbody));
  return card;
}

function availableCard(available) {
  const card = el("div", { class: "card" },
    el("div", { class: "card-title" }, el("h3", {}, "可参加的考试")));
  if (!available.length) {
    card.append(emptyBox("暂无可参加的考试"));
    return card;
  }
  const grid = el("div", { class: "grid cols-3" });
  for (const e of available.slice(0, 6)) {
    grid.append(el("div", { class: "card hoverable exam-card", style: "cursor:pointer", onclick: () => go(`take/${e.id}`) },
      el("div", { class: "title" }, e.title || "考试"),
      el("div", { class: "meta" },
        e.duration ? chip(`${e.duration} 分钟`, "sky") : null,
        e.total_questions ? chip(`${e.total_questions} 题`, "mint") : null,
        e.attempts ? chip(`已考 ${e.attempts} 次`) : null),
    ));
  }
  card.append(grid);
  return card;
}
