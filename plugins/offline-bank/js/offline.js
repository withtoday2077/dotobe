// 本地题库：离线试卷缓存清单 + 刷题进度/统计 + 复用练习页刷题
// 数据：api.listCachedPapers / api.loadPractice / api.loadPracticeStats

import { api } from "api";
import { el, clear, loadingBox, emptyBox, chip, toastOk, toastErr, confirmModal } from "ui";
import { go } from "router";

export async function renderOffline(container) {
  const inner = el("div");
  container.append(inner);
  await draw(inner);
}

async function draw(inner) {
  clear(inner).append(loadingBox("正在读取本地题库…"));
  const list = await api.listCachedPapers();
  const stats = await api.loadPracticeStats().catch(() => []);
  clear(inner);

  inner.append(el("div", { class: "banner info" },
    "缓存的试卷可离线刷题：不限时、逐题即时判分；刷题进度与记录保存在本地。"));

  // 刷题统计卡
  inner.append(statsCard(stats));

  if (!list.length) {
    inner.append(emptyBox("还没有缓存试卷", "去「真题市场」点卡片上的「缓存」按钮"));
    return;
  }
  const grid = el("div", { class: "grid cols-3" });
  for (const p of list) {
    const saved = await api.loadPractice(p.exam_id).catch(() => null);
    const done = saved && Array.isArray(saved.answers)
      ? saved.answers.filter((a) => a && a.hasOwnProperty("value")).length
      : 0;
    const correct = saved && Array.isArray(saved.answers)
      ? saved.answers.filter((a) => a && a.ok === true).length
      : 0;
    // 联网拉取该卷最新内容，覆盖本地缓存（真题市场只负责缓存/状态，更新在这里管理）
    const updBtn = el("button", { class: "btn sm", title: "联网拉取最新试卷内容覆盖本地缓存" }, "更新缓存");
    updBtn.addEventListener("click", async () => {
      updBtn.disabled = true;
      updBtn.textContent = "更新中…";
      try {
        const env = await api.get("backend/api/exam.php", { action: "detail", id: p.exam_id });
        // detail 返回扁平结构 {success, exam:{...,questions:[]}}——questions 嵌在 exam 内
        const examObj = env.data?.exam || env.exam || env.data || {};
        const questions = env.data?.questions || env.questions || examObj.questions || [];
        if (!questions.length) throw new Error("试卷内容为空");
        const { questions: _nested, questions_json: _snap, ...examMeta } = examObj;
        await api.cachePaper(p.exam_id, {
          exam: { ...examMeta, cached_at: new Date().toISOString().slice(0, 19).replace("T", " ") },
          questions,
        });
        toastOk("缓存已更新");
        draw(inner);
      } catch (err) {
        toastErr("更新失败（需联网）：" + err.message);
        updBtn.textContent = "更新缓存";
        updBtn.disabled = false;
      }
    });

    grid.append(el("div", { class: "card hoverable exam-card" },
      el("div", { class: "title" }, p.title),
      el("div", { class: "meta" },
        chip(`${p.question_count} 题`, "mint"),
        p.cached_at ? chip(String(p.cached_at).slice(0, 10)) : null,
        done ? chip(`已刷 ${done} 题`, "sky") : null,
        done ? chip(`答对 ${correct}`, "mint") : null),
      el("div", { class: "actions" },
        el("button", { class: "btn sm primary", onclick: () => go(`practice/${p.exam_id}`) }, done ? "继续刷题" : "开始刷题"),
        el("span", { style: "flex:1" }),
        updBtn,
        el("button", { class: "btn sm danger", onclick: () =>
          confirmModal("删除缓存", `删除「${p.title}」的本地缓存？`, async () => {
            await api.deleteCachedPaper(p.exam_id);
            await api.clearPractice(p.exam_id).catch(() => {});
            toastOk("已删除");
            draw(inner);
          }, "删除", "danger") }, "删除"))));
  }
  inner.append(grid);
}

// ---------------- 刷题统计 ----------------

function statsCard(stats) {
  const total = stats.reduce((s, r) => s + (Number(r.question_count) || 0), 0);
  const correct = stats.reduce((s, r) => s + (Number(r.correct_count) || 0), 0);
  const days = new Set(stats.map((r) => String(r.at || "").slice(0, 10)).filter(Boolean)).size;
  const rate = total ? Math.round((correct / total) * 100) : 0;
  const latest = stats[stats.length - 1];

  const card = el("div", { class: "card", style: "margin-bottom:var(--sp-3)" },
    el("div", { class: "card-title" }, el("h3", {}, "刷题统计"),
      el("span", { style: "font-size:var(--fs-tiny);color:var(--text-3)" },
        latest ? `最近：${latest.title || "刷题"} ${latest.correct_count || 0}/${latest.question_count || 0}` : "暂无记录")),
    el("div", { class: "grid cols-4", style: "margin-top:10px" },
      statBox("累计刷题", String(total), "题", "sky"),
      statBox("累计答对", String(correct), "题", "mint"),
      statBox("总正确率", `${rate}`, "%", "pink"),
      statBox("练习天数", String(days), "天", "warn")));
  return card;
}

function statBox(label, value, unit, tone) {
  return el("div", { class: `card stat ${tone}` },
    el("div", { class: "label" }, label),
    el("div", { class: "value" }, value, el("small", { style: "font-size:0.9rem;color:var(--text-3)" }, " " + unit)));
}