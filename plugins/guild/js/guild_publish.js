// 发布任务（冒险公会）：分区表单（基本信息 / 时间地点 / 报酬与要求 / 附加选项）
// POST guild/tasks.php {action:"publish", ...}
// 样式：css/guild.css（gd- 命名空间）；类别/报酬类型/危险等级为下拉选择

import { api } from "api";
import { el, field, toastOk, toastErr } from "ui";
import { go } from "router";

const CATEGORIES = {
  study: "学习辅导", errand: "跑腿代办", carpool: "拼车拼单",
  skill: "技能交换", borrow: "借用求购", consult: "问题咨询", other: "其他任务",
};

/** 下拉版下划线字段（与 field() 同构） */
function selectField(label, value, options) {
  const wrap = el("div", { class: "field filled" });
  const sel = el("select", { class: "input" },
    ...options.map(([v, t]) => el("option", { value: v, selected: v === value ? "" : undefined }, t)));
  wrap.append(sel, el("label", {}, label));
  wrap.input = sel;
  return wrap;
}

export async function renderGuildPublish(container) {
  const root = el("div", { class: "gd-page" });
  container.append(root);

  root.append(el("div", { class: "gd-page-head" },
    el("div", {},
      el("span", { class: "eyebrow" }, "ADVENTURERS GUILD"),
      el("h1", {}, "发布任务"),
      el("div", { class: "sub" }, "发布后会出现在任务大厅，冒险者可以接单"))));

  const title = field("任务标题（必填）", "");
  const description = field("任务描述（必填）", "", { textarea: true });
  description.input.style.minHeight = "120px";

  const location = field("地点（选填）", "");
  const deadline = field("截止日期（选填）", "");
  deadline.input.type = "date";

  const category = selectField("任务类别（必填）", "study", Object.entries(CATEGORIES));
  const reward = field("报酬数额（必填）", "10");
  const rewardType = selectField("报酬类型", "gold", [["gold", "金币（站内结算）"], ["cash", "现金（线下结算）"]]);
  const danger = selectField("危险等级", "0", [["0", "0 · 安全"], ["1", "1 · 注意"], ["2", "2 · 高危"]]);

  const tags = field("标签（逗号分隔，选填）", "");
  const minLevel = field("最低冒险者等级（选填）", "");
  const minCredit = field("最低信用分（选填）", "");

  const offline = el("input", { type: "checkbox" });
  const autoAccept = el("input", { type: "checkbox", checked: "" });
  const negotiable = el("input", { type: "checkbox", checked: "" });

  const form = el("form", { class: "gd-form", onsubmit: (e) => { e.preventDefault(); submit(); } });
  form.append(
    el("section", { class: "gd-form-section" }, el("h3", {}, "基本信息"),
      el("div", { class: "fields" }, title,
        el("div", { class: "gd-form-row" }, category),
        description)),
    el("section", { class: "gd-form-section" }, el("h3", {}, "时间与地点"),
      el("div", { class: "gd-form-row" }, deadline, location)),
    el("section", { class: "gd-form-section" }, el("h3", {}, "报酬与要求"),
      el("div", { class: "fields" },
        el("div", { class: "gd-form-row cols-3" }, reward, rewardType, danger),
        el("div", { class: "gd-form-row cols-3" }, minLevel, minCredit, tags))),
    el("section", { class: "gd-form-section" }, el("h3", {}, "附加选项"),
      el("div", { class: "gd-check-group" },
        el("label", {}, offline, "需要线下完成"),
        el("label", {}, negotiable, "报酬可面议"),
        el("label", {}, autoAccept, "免确认（自动接受接单者）"))));
  root.append(form);

  root.append(el("div", { class: "gd-form-actions" },
    el("button", { class: "btn", onclick: () => go("guild/hall") }, "取消"),
    el("button", { class: "btn primary", onclick: submit }, "发布任务")));

  async function submit() {
    const body = {
      action: "publish",
      title: title.input.value.trim(),
      category: category.input.value || "other",
      description: description.input.value.trim(),
      location: location.input.value.trim(),
      deadline: deadline.input.value.trim() || null,
      reward_amount: Number(reward.input.value) || 0,
      reward_type: rewardType.input.value || "gold",
      negotiable: negotiable.checked ? 1 : 0,
      offline_required: offline.checked ? 1 : 0,
      is_urgent: 0,
      danger_level: Number(danger.input.value) || 0,
      min_level: Number(minLevel.input.value) || 0,
      min_credit: Number(minCredit.input.value) || 0,
      auto_accept: autoAccept.checked ? 1 : 0,
      tags: tags.input.value.trim() ? tags.input.value.trim().split(/[,，]/).map((x) => x.trim()).filter(Boolean) : [],
    };
    if (!body.title) return toastErr("请填写任务标题");
    if (!body.description) return toastErr("请填写任务描述");
    try {
      const env = await api.postJSON("backend/api/guild/tasks.php", body);
      toastOk(env.message || "发布成功");
      go("guild/hall");
    } catch (e) { toastErr("发布失败：" + (e.message || e)); }
  }
}
