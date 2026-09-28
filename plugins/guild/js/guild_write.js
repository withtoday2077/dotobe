// 撰写/编辑手札（冒险公会）：分区表单（标题/分类/可见性 + 正文工具行 + 图片上传 + 实时预览）
// 新建：POST community/articles.php（FormData：action=create）→ 存草稿，到「我的手札」提交发布
// 编辑：路由 guild/write/<id> → detail 回填 → action=update 保存
// 图片：dialog 选图 → Rust multipart → upload_image.php（字段 image）→ 返回 image_path 插入 Markdown
// 样式：css/guild.css（gd- 命名空间）

import { api } from "api";
import { el, clear, field, toastOk, toastErr, modal } from "ui";
import { go } from "router";
import { kmMarkdown } from "km-markdown";
import { isAndroid, pickFiles } from "mobile";

export async function renderGuildWrite(container, param) {
  const root = el("div", { class: "gd-page" });
  container.append(root);

  const editId = Number(param) || 0; // 编辑模式：路由参数为文章 id
  let coverImage = "";               // 编辑时透传原封面，防止 update 空值覆盖

  const title = field("手札标题（必填）", "");
  const content = field("正文（支持 Markdown 与 LaTeX 公式语法）", "", { textarea: true });
  content.input.style.minHeight = "42vh";

  // 分类下拉（categories.php?action=list）
  const catSelect = el("select", { class: "input" },
    el("option", { value: "" }, "选择分类…"));
  try {
    const env = await api.get("backend/api/community/categories.php", { action: "list" });
    for (const c of env.data || []) {
      catSelect.append(el("option", { value: c.id }, c.name));
    }
  } catch {}
  const catWrap = el("div", { class: "field filled" });
  catWrap.append(catSelect, el("label", {}, "分类"));
  catWrap.input = catSelect;

  // 可见性
  const visSelect = el("select", { class: "input" },
    el("option", { value: "public" }, "公开"),
    el("option", { value: "followers_only" }, "仅关注者"),
    el("option", { value: "private" }, "私密"));
  const visWrap = el("div", { class: "field filled" });
  visWrap.append(visSelect, el("label", {}, "可见性"));
  visWrap.input = visSelect;

  // 编辑模式：detail 回填（分类/可见性控件就绪后再设值）
  if (editId) {
    try {
      const env = await api.get("backend/api/community/articles.php", { action: "detail", id: editId });
      const art = env.data || {};
      title.input.value = art.title || "";
      title.classList.add("filled");
      content.input.value = art.content_markdown || "";
      if (art.category_id) catSelect.value = String(art.category_id);
      if (art.visibility) visSelect.value = art.visibility;
      coverImage = art.cover_image || "";
    } catch (e) {
      toastErr("载入手札失败：" + (e.message || e));
    }
  }

  // 工具行：公式编辑器 / 图片 / 标题层级 / 行内格式 / 块级结构
  const headSel = el("select", { class: "input", title: "标题层级", style: "width:auto;padding:4px 8px" },
    el("option", { value: "" }, "标题"),
    el("option", { value: "1" }, "H1 大标题"),
    el("option", { value: "2" }, "H2"),
    el("option", { value: "3" }, "H3"),
    el("option", { value: "4" }, "H4"));
  headSel.addEventListener("change", () => {
    const lv = Number(headSel.value);
    if (lv >= 1 && lv <= 4) insertTo(content.input, `\n${"#".repeat(lv)} 标题文字\n`);
    headSel.value = "";
  });

  const tools = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center" },
    toolBtn("ƒ 公式", openFormulaEditor),
    toolBtn("🖼 图片", pickAndUploadImage),
    headSel,
    toolBtn("B", () => insertTo(content.input, "**加粗文字**", "加粗文字")),
    toolBtn("I", () => insertTo(content.input, "*斜体文字*", "斜体文字")),
    toolBtn("S̶", () => insertTo(content.input, "~~删除线文字~~", "删除线文字")),
    toolBtn("🔗", () => insertTo(content.input, "[链接文字](https://)", "链接文字")),
    toolBtn("• 列表", () => insertTo(content.input, "\n- 列表项\n")),
    toolBtn("1. 有序", () => insertTo(content.input, "\n1. 列表项\n")),
    toolBtn("`码`", () => insertTo(content.input, "`行内代码`", "行内代码")),
    toolBtn("代码块", () => insertTo(content.input, "\n```\n代码块\n```\n")),
    toolBtn("引用", () => insertTo(content.input, "\n> 引用内容\n")),
    toolBtn("表格", () => insertTo(content.input, "\n| 列一 | 列二 |\n| --- | --- |\n| 内容 | 内容 |\n")),
    toolBtn("分割线", () => insertTo(content.input, "\n---\n")));

  // 快捷键：Ctrl+B/I/K
  content.input.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === "b") { e.preventDefault(); insertTo(content.input, "**加粗文字**", "加粗文字"); }
    else if (k === "i") { e.preventDefault(); insertTo(content.input, "*斜体文字*", "斜体文字"); }
    else if (k === "k") { e.preventDefault(); insertTo(content.input, "[链接文字](https://)", "链接文字"); }
  });

  // 实时预览：左编辑右预览（窄屏上下堆叠）
  const preview = el("div", { class: "gd-md gd-write-preview", style: "flex:1;min-width:0" });
  const editorCol = el("div", { style: "flex:1;min-width:0" }, content);
  const split = el("div", { class: "gd-write-split" }, editorCol, preview);

  let previewTimer = null;
  content.input.addEventListener("input", () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 250);
  });
  function renderPreview() {
    preview.innerHTML = kmMarkdown(content.input.value, { baseUrl: api.baseUrlSync() }) ||
      `<p style="color:var(--text-3)">（预览区：输入正文，实时预览）</p>`;
  }

  // 选图 → 上传 → 光标处插入 Markdown
  async function pickAndUploadImage() {
    let filePath = null;
    if (!isAndroid()) {
      try {
        const { open } = window.__TAURI__.dialog;
        filePath = await open({ multiple: false, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }] });
      } catch (e) {
        return toastErr("打开文件选择器失败：" + e.message);
      }
      filePath = Array.isArray(filePath) ? filePath[0] : filePath;
      if (!filePath) return;
    }
    toastOk("图片上传中…");
    try {
      let up, name;
      if (isAndroid()) {
        // Android：file input 直读内存 → uploadBytes（content:// 路径 Rust 读不了）
        const [it] = await pickFiles({ accept: "image/*", read: "b64" });
        if (!it) return;
        up = await api.uploadBytes("backend/api/upload_image.php", "image", it.name, it.b64, it.mime);
        name = it.name;
      } else {
        up = await api.upload("backend/api/upload_image.php", "image", filePath);
        name = String(filePath).split(/[\\/]/).pop();
      }
      const path = up?.data?.image_path || up?.data?.image;
      if (!path) throw new Error("上传响应缺少图片路径");
      insertTo(content.input, `![${name}](${path})`);
      renderPreview();
      toastOk("图片已插入");
    } catch (e) {
      toastErr("图片上传失败：" + (e.message || e));
    }
  }

  // —— LaTeX 公式编辑器弹窗（模板 + 实时 KaTeX 预览） ——
  function openFormulaEditor() {
    // 若正文选中文本恰为 $..$ / $$..$$ 包裹，解包载入编辑
    let initial = "";
    let replaceSel = null;
    const selText = content.input.value.slice(content.input.selectionStart, content.input.selectionEnd);
    const mBlock = selText.match(/^\$\$([\s\S]+)\$\$$/);
    const mInline = selText.match(/^\$([^$\n]+)\$$/);
    if (mBlock) { initial = mBlock[1]; replaceSel = { display: true }; }
    else if (mInline) { initial = mInline[1]; replaceSel = { display: false }; }

    const input = el("input", { class: "input", placeholder: "输入 LaTeX，例如 \\frac{a}{b}", style: "width:100%" });
    input.value = initial;
    const previewBox = el("div", { class: "gd-fm-preview" });

    let display = replaceSel ? replaceSel.display : false;
    const modeInline = el("button", { class: "btn sm primary", onclick: () => setMode(false) }, "行内 $..$");
    const modeBlock = el("button", { class: "btn sm", onclick: () => setMode(true) }, "块级 $$..$$");
    function setMode(d) {
      display = d;
      modeInline.className = "btn sm" + (d ? "" : " primary");
      modeBlock.className = "btn sm" + (d ? " primary" : "");
      renderFm();
    }

    let fmTimer = null;
    input.addEventListener("input", () => {
      clearTimeout(fmTimer);
      fmTimer = setTimeout(renderFm, 200);
    });
    function renderFm() {
      const latex = input.value.trim();
      clear(previewBox);
      if (!latex) {
        previewBox.append(el("span", { style: "color:var(--text-3);font-size:var(--fs-small)" }, "输入公式后实时预览"));
        return;
      }
      if (window.katex) {
        try {
          const html = window.katex.renderToString(latex, { displayMode: display, throwOnError: false, strict: false });
          const holder = el("div");
          holder.innerHTML = html;
          previewBox.append(...holder.childNodes);
        } catch {
          previewBox.append(el("span", { style: "color:var(--danger);font-size:var(--fs-small)" }, "公式语法错误"));
        }
      } else {
        previewBox.append(el("code", {}, latex));
      }
    }

    // 模板：分类 tab + 网格按钮（点击追加到输入框）
    const TPL = {
      basic: [
        ["a/b 分数", "\\frac{a}{b}"], ["√ 根号", "\\sqrt{x}"], ["ⁿ√ n次根", "\\sqrt[n]{x}"],
        ["xⁿ 上标", "x^{n}"], ["xₙ 下标", "x_{n}"], ["|x| 绝对值", "\\left| x \\right|"],
        ["∑ 求和", "\\sum_{i=1}^{n}"], ["∫ 积分", "\\int_{a}^{b}"], ["lim 极限", "\\lim_{x \\to 0}"],
        ["( ) 括号", "\\left( \\right)"], ["⏟ 上划线", "\\overline{ab}"], ["⃗ 向量", "\\vec{a}"],
        ["̂ 头帽", "\\hat{y}"], ["⬀ 箭头向量", "\\overrightarrow{AB}"],
      ],
      math: [
        ["≥", "\\geq"], ["≤", "\\leq"], ["≠", "\\neq"], ["≈", "\\approx"], ["±", "\\pm"],
        ["×", "\\times"], ["÷", "\\div"], ["∈", "\\in"], ["∉", "\\notin"], ["⊂", "\\subset"],
        ["∪", "\\cup"], ["∩", "\\cap"], ["→", "\\to"], ["⇒", "\\Rightarrow"], ["∞", "\\infty"], ["∅", "\\emptyset"],
      ],
      greek: [
        ["α", "\\alpha"], ["β", "\\beta"], ["γ", "\\gamma"], ["δ", "\\delta"], ["θ", "\\theta"],
        ["λ", "\\lambda"], ["μ", "\\mu"], ["π", "\\pi"], ["σ", "\\sigma"], ["φ", "\\phi"],
        ["ω", "\\omega"], ["Δ", "\\Delta"], ["Ω", "\\Omega"], ["Σ", "\\Sigma"], ["Π", "\\Pi"],
      ],
    };
    const gridBox = el("div", { class: "gd-fm-grid" });
    const tabsRow = el("div", { style: "display:flex;gap:8px;margin-bottom:8px" });
    const tabs = [["basic", "基础"], ["math", "数学"], ["greek", "希腊"]];
    let curCat = "basic";
    function drawGrid() {
      clear(gridBox);
      for (const [label, latex] of TPL[curCat]) {
        gridBox.append(el("button", {
          class: "gd-fm-tpl", title: latex,
          onclick: () => {
            input.value += latex;
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
            renderFm();
          },
        }, label));
      }
      tabsRow.querySelectorAll("button").forEach((b, i) =>
        b.classList.toggle("primary", tabs[i][0] === curCat));
    }
    for (const [cat, label] of tabs) {
      tabsRow.append(el("button", { class: "btn sm" + (cat === curCat ? " primary" : ""), onclick: () => { curCat = cat; drawGrid(); } }, label));
    }
    drawGrid();

    modal({ title: "ƒ LaTeX 公式编辑器", body:
      el("div", { style: "display:flex;flex-direction:column;gap:12px" },
        el("div", { style: "display:flex;gap:8px;align-items:center" }, modeInline, modeBlock),
        input,
        previewBox,
        el("div", {},
          el("div", { style: "font-size:var(--fs-tiny);color:var(--text-3);margin-bottom:6px;letter-spacing:.08em" }, "常用模板（点击加入公式）"),
          tabsRow, gridBox)),
      actions: [
        { label: "插入公式", kind: "primary", onClick: () => {
          const latex = input.value.trim();
          if (!latex) throw new Error("请输入公式");
          if (replaceSel) {
            // 编辑已有：原位替换选区
            const s = content.input.selectionStart, e = content.input.selectionEnd;
            content.input.setRangeText(display ? `$$${latex}$$` : `$${latex}$`, s, e, "end");
          } else {
            insertTo(content.input, display ? `$$${latex}$$` : `$${latex}$`);
          }
          renderPreview();
        } },
      ] });

    setMode(display);
    renderFm();
    setTimeout(() => input.focus(), 60);
  }

  root.append(el("div", { class: "gd-page-head" },
    el("div", {},
      el("span", { class: "eyebrow" }, "ADVENTURERS GUILD"),
      el("h1", {}, editId ? "编辑手札" : "撰写手札"),
      el("div", { class: "sub" }, editId ? "修改后保存，如需重新送审请到「我的手札」提交发布" : "记录你的冒险见闻与学习心得"))));

  root.append(el("div", { class: "gd-form" },
    el("section", { class: "gd-form-section" }, el("h3", {}, "标题与分类"),
      el("div", { class: "fields" },
        el("div", { class: "gd-form-row" }, title),
        el("div", { class: "gd-form-row" }, catWrap, visWrap))),
    el("section", { class: "gd-form-section" }, el("h3", {}, "正文（右侧实时预览）"),
      tools, split)));

  root.append(el("div", { class: "gd-form-actions", style: "margin-top:var(--sp-3)" },
    el("button", { class: "btn", onclick: () => go("guild/stories") }, "取消"),
    el("button", { class: "btn primary", onclick: submit }, editId ? "保存修改" : "保存手札")));

  renderPreview();

  async function submit() {
    const t = title.input.value.trim();
    const c = content.input.value;
    if (!t) return toastErr("请填写标题");
    if (!c.trim()) return toastErr("请填写正文");
    try {
      if (editId) {
        // 编辑已有：update 全量字段（cover_image 透传原值防被空值覆盖）
        await api.postForm("backend/api/community/articles.php", {
          action: "update",
          article_id: editId,
          title: t,
          content: c,
          category_id: catSelect.value || "",
          cover_image: coverImage,
          visibility: visSelect.value,
        });
        toastOk("已保存修改");
        go("guild/myarticles");
      } else {
        // 新建：create 实为存草稿，发布需到「我的手札」提交送审
        const env = await api.postForm("backend/api/community/articles.php", {
          action: "create",
          title: t,
          content: c,
          category_id: catSelect.value || "", // 未选则空（后端归一为 NULL，分类可为空）
          visibility: visSelect.value,
        });
        toastOk((env.message || "草稿已保存") + "，可在「我的手札」提交发布");
        go("guild/myarticles");
      }
    } catch (e) { toastErr("保存失败：" + (e.message || e)); }
  }

  function toolBtn(label, fn) {
    return el("button", { class: "btn sm ghost", onclick: fn }, label);
  }
  /** 在光标处插入文本；selectText 非空时插入后选中该占位文字（打字即替换） */
  function insertTo(target, text, selectText) {
    const start = target.selectionStart ?? target.value.length;
    target.setRangeText(text, start, start, "end");
    if (selectText) {
      const s = start + text.indexOf(selectText);
      if (s >= start) {
        target.setSelectionRange(s, s + selectText.length);
      }
    }
    target.focus();
    target.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
