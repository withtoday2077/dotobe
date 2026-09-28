// 进行中考试：续考入口列表（对齐 web 端 in_progress 页）
// 数据：page/in_progress.php → { exams[{exam_id,title,duration,remaining_seconds,...}], time_limit_count, total_count }

import { api } from "api";
import { el, clear, loadingBox, errorBox, emptyBox, chip, fmtHms, fmtDate } from "ui";
import { go } from "router";

export async function renderInProgress(container) {
  const inner = el("div");
  container.append(inner);
  inner.append(loadingBox("正在检查进行中的考试…"));

  let data;
  try {
    const env = await api.get("backend/api/page/in_progress.php");
    data = env.data || {};
  } catch (e) {
    return clear(inner).append(errorBox(e.message, () => renderInProgress(container)));
  }
  const exams = data.exams || [];
  clear(inner);

  // 汇总条
  inner.append(el("div", { class: "banner info" },
    `共 ${data.total_count ?? exams.length ?? 0} 场考试进行中` +
    (data.time_limit_count > 0 ? ` · 其中 ${data.time_limit_count} 场已超时将被自动提交` : "")));

  if (!exams.length) {
    inner.append(el("div", { class: "empty" },
      el("p", {}, "（没有进行中的考试）"),
      el("p", { class: "hint" }, "在「考试中心」开始一场考试后，可随时回到这里续考")));
    return;
  }

  const grid = el("div", { class: "grid cols-3" });
  for (const e of exams) {
    const remaining = Number(e.remaining_seconds ?? 0);
    const urgent = remaining <= 300;
    grid.append(el("div", { class: "card hoverable exam-card" },
      el("div", { class: "title" }, e.title || "考试"),
      el("div", { class: "meta" },
        e.duration ? chip(`${e.duration} 分钟`, "sky") : null,
        remaining > 0 ? chip(`剩余 ${fmtHms(remaining)}`, urgent ? "pink" : "mint") : chip("已超时", "warn"),
        e.subject ? chip(e.subject) : null),
      el("div", { class: "desc" }, e.created_at ? `开始于 ${fmtDate(e.created_at)}` : ""),
      el("div", { class: "actions" },
        el("button", { class: "btn sm primary", onclick: () => go(`take/${e.exam_id}`) }, "继续考试")),
    ));
  }
  inner.append(grid);
}
