// 知识树（知根错节）：树形知识体系 + 知识点错题 + 节点笔记
// 数据（整树 JSON 按用户存取）：knowledge_mistakes/index.php?action=load|save
// state: { knowledgeTree:[{id,name,children[]}], mistakes:{nodeId:[m]}, notes:{nodeId:[n]} }
// mistake: { id, question, images[], errorCount, createdAt, lastErrorDate,
//            wrongAnswer, wrongImages[], correctIdea, correctImages[], errorDetail, errorReasonTag }
// note: { id, title, content, created, updated }

import { api } from "api";
import { el, clear, errorBox, emptyBox, chip, toastOk, toastErr, modal, confirmModal, field, svgEl, renderMathIn } from "ui";
import { kmMarkdown } from "km-markdown";
import { isAndroid, pickFiles, fileToB64 } from "mobile";
import { refreshShellBalance } from "shell";

const URGENT_COUNT = 3;
const URGENT_DAYS = 7;
const CACHE_KEY = "km_state";
const IMG_QUALITY = 0.82;      // WebP 压缩质量（对齐网页端 knowledge-app.js，省服务器存储）

// 本地图片 base64 → 压缩 WebP Blob（对齐网页端：选图即压缩，服务端只存压缩小图）
function compressToWebp(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      // WebView2/Chromium 支持 WebP 编码；GIF 仅保留首帧（与网页端一致）
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片编码失败"))), "image/webp", IMG_QUALITY);
    };
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = dataUrl;
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("读取压缩结果失败"));
    r.readAsDataURL(blob);
  });
}

let state = { knowledgeTree: [], mistakes: {}, notes: {} };
let currentNodeId = null;
let detailTab = "mistakes"; // 叶子详情视图：错题 | 笔记
const collapsed = new Set();

// 布局节点引用：路由在游离容器中渲染页面，getElementById 找不到，必须持有引用
let treeBox = null;
let detailBox = null;

function normalizeState(d) {
  return {
    knowledgeTree: Array.isArray(d.knowledgeTree) ? d.knowledgeTree : [],
    mistakes: d.mistakes && typeof d.mistakes === "object" ? d.mistakes : {},
    notes: d.notes && typeof d.notes === "object" ? d.notes : {},
  };
}

function finishRender(container, silent) {
  // 空树：引导创建根节点
  if (!state.knowledgeTree.length) {
    treeBox = detailBox = null;
    clear(container);
    drawEmptyIntro(container);
    return;
  }
  if (!currentNodeId || !findNode(currentNodeId)) {
    currentNodeId = firstLeafId(state.knowledgeTree) || (state.knowledgeTree[0] || {}).id || null;
  }
  if (!detailBox) {
    drawLayout(container);
  } else {
    renderAll();
  }
}

// 渲染代数：后台更新回调据此丢弃过期渲染（页面已离开/重进）
let renderGen = 0;
let activeContainer = null; // 导入/重置后整页重载用

export async function renderKnowledge(container) {
  treeBox = detailBox = null; // 每次进入页面重置布局引用
  activeContainer = container;
  const myGen = ++renderGen;

  // 1) 本地缓存优先：有则立即渲染（离线可用）
  let localData = null;
  try {
    const cache = await api.loadLocalCache(CACHE_KEY);
    if (cache && cache.data && (cache.data.knowledgeTree?.length || cache.data.mistakes || cache.data.notes)) {
      localData = cache.data;
      state = normalizeState(cache.data);
      finishRender(container, true);
    }
  } catch {}

  if (localData) {
    // 2a) 有缓存：页面立即上屏，后台检测远端更新，不阻塞显示
    (async () => {
      let remote;
      try {
        const env = await api.get("backend/api/knowledge_mistakes/index.php", { action: "load" });
        remote = env.data || {};
      } catch { return; } // 离线：保持本地缓存渲染，静默
      if (myGen !== renderGen) return; // 期间已重进页面：本次结果作废
      if (JSON.stringify(normalizeState(remote)) !== JSON.stringify(state)) {
        state = normalizeState(remote);
        try { await api.saveLocalCache(CACHE_KEY, { savedAt: new Date().toISOString(), data: remote }); } catch {}
        finishRender(container, true);
      }
    })();
    return;
  }

  // 2b) 无缓存：同步等待远端（页面转场期间完成）
  let remote = null;
  try {
    const env = await api.get("backend/api/knowledge_mistakes/index.php", { action: "load" });
    remote = env.data || {};
  } catch {
    clear(container).append(errorBox("加载失败：离线且无本地缓存", () => renderKnowledge(container)));
    return;
  }
  if (myGen !== renderGen) return;
  state = normalizeState(remote);
  try { await api.saveLocalCache(CACHE_KEY, { savedAt: new Date().toISOString(), data: remote }); } catch {}
  if (myGen !== renderGen) return;
  finishRender(container, false);
}

function drawEmptyIntro(container) {
  const nameInput = field("根节点名称（如：高等数学）", "");
  const card = el("div", { class: "card", style: "max-width:520px;margin:64px auto;text-align:center" },
    el("h1", {}, "知识树"),
    el("p", { style: "color:var(--text-2);margin:12px 0 24px" }, "把知识整理成一棵树，在每个叶子节点记录错题与笔记"),
    nameInput,
    el("button", { class: "btn primary", style: "margin-top:20px", onclick: () => {
      const v = nameInput.input.value.trim();
      if (!v) return toastErr("请输入名称");
      state.knowledgeTree = [{ id: uid(), name: v, children: [] }];
      persist();
      currentNodeId = state.knowledgeTree[0].id;
      clear(container);
      drawLayout(container);
    } }, "创建知识树"));
  container.append(card);
}

function drawLayout(container) {
  clear(container);
  const wrap = el("div", { class: "km-layout" });

  // —— 左：树 ——
  const treeTools = el("div", { class: "toolbar-row", style: "margin-bottom:10px" },
    el("button", { class: "btn sm", onclick: () => {
      const name = prompt2("根节点名称", "", (v) => {
        if (!v) return;
        state.knowledgeTree.push({ id: uid(), name: v, children: [] });
        persist(); renderKnowledge(container);
      });
    } }, "＋ 根节点"),
    el("button", { class: "btn sm ghost", onclick: () => { collapsed.clear(); renderAll(); } }, "全部展开"),
    el("button", { class: "btn sm ghost", onclick: () => {
      walkTree(state.knowledgeTree, (n) => { if (!isLeaf(n)) collapsed.add(n.id); });
      renderAll();
    } }, "全部折叠"));

  // 工具行：统计 / 复习 / 导入 / 导出（参照 Web 端）；导出依赖 content:// 写盘，Android 隐藏
  const toolRow = el("div", { class: "toolbar-row", style: "margin-bottom:10px" },
    el("button", { class: "btn sm", onclick: showStats }, "📊 统计"),
    el("button", { class: "btn sm", onclick: openReview }, "🎲 复习模式"),
    el("button", { class: "btn sm", onclick: importData }, "📥 导入"),
    ...(!isAndroid() ? [el("button", { class: "btn sm", onclick: exportData }, "📤 导出")] : []));

  treeBox = el("div", { id: "km-tree" });
  const treePane = el("div", { class: "card km-tree-pane", style: "padding:14px" },
    el("div", { class: "card-title" }, el("h3", {}, "知识树")),
    treeTools,
    toolRow,
    treeBox);

  // —— 右：详情 ——
  detailBox = el("div", { class: "km-detail-pane", id: "km-detail" });

  wrap.append(treePane, detailBox);
  container.append(wrap);
  renderAll();
}

function renderAll() {
  renderTree();
  renderDetail();
}

// ---------------- 树 ----------------

function renderTree() {
  if (!treeBox) return;
  const tree = treeBox;
  clear(tree);
  const ul = el("ul", { class: "km-tree-list" });
  state.knowledgeTree.forEach((n) => ul.append(renderNode(n)));
  tree.append(ul);
}

function renderNode(node) {
  const li = el("li", { class: "km-node" });
  const leaf = isLeaf(node);
  const row = el("div", {
    class: "km-row" + (leaf ? " leaf" : "") + (node.id === currentNodeId ? " selected" : ""),
    draggable: "true",
    onclick: () => selectNode(node.id),
    // 拖拽排序：按住行拖动，落到目标行上半=插其前、下半=插其后（兄弟位置，支持跨父节点）
    ondragstart: (ev) => {
      dragId = node.id;
      row.classList.add("dragging");
      ev.dataTransfer.effectAllowed = "move";
      try { ev.dataTransfer.setData("text/plain", node.id); } catch {}
    },
    ondragend: () => {
      dragId = null;
      row.classList.remove("dragging");
      clearDropMark();
    },
    ondragover: (ev) => {
      if (!dragId) return;
      const dragged = findNode(dragId);
      if (!dragged || subtreeHas(dragged, node.id)) return; // 自身/子孙：不允许落
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      const r = row.getBoundingClientRect();
      const after = ev.clientY > r.top + r.height / 2;
      if (dropRow !== row) clearDropMark();
      dropRow = row;
      row.classList.toggle("drop-before", !after);
      row.classList.toggle("drop-after", after);
    },
    ondragleave: (ev) => {
      if (dropRow === row && !(ev.relatedTarget && row.contains(ev.relatedTarget))) clearDropMark();
    },
    ondrop: (ev) => {
      ev.preventDefault();
      const r = row.getBoundingClientRect();
      const after = ev.clientY > r.top + r.height / 2;
      clearDropMark();
      const src = dragId;
      dragId = null;
      moveByDrag(src, node.id, after);
    },
  });

  const twist = el("span", { class: "km-twist", onclick: (ev) => {
    ev.stopPropagation();
    if (leaf) return;
    collapsed.has(node.id) ? collapsed.delete(node.id) : collapsed.add(node.id);
    renderTree();
  } }, leaf ? "•" : (collapsed.has(node.id) ? "▶" : "▼"));
  row.append(twist);

  row.append(el("span", { class: "km-name", onclick: () => selectNode(node.id) }, node.name));

  // 徽章仅显示数字，含义靠颜色区分 + 悬停 title 提示
  const { total, pending } = countUnder(node);
  const counts = el("span", { class: "km-counts" });
  if (total > 0) counts.append(numChip(total, "sky", "题"));
  if (pending > 0) counts.append(numChip(pending, "warn", "待复习"));
  if (leaf) {
    const nc = (state.notes[node.id] || []).length;
    if (nc > 0) counts.append(numChip(nc, "mint", "笔记"));
  }
  row.append(counts);

  // 悬浮操作菜单：绝对定位不占布局，hover 时徽章淡出、按钮淡入，行高零变化
  const acts = el("span", { class: "km-acts" },
    miniBtn("＋", "添加子节点", () => addChild(node)),
    miniBtn("✎", "重命名", () => renameNode(node)),
    miniBtn("🗑", "删除", () => deleteNode(node)));
  row.append(acts);

  li.append(row);
  if (!leaf && node.children?.length) {
    const childUl = el("ul", { class: "km-tree-list" });
    if (!collapsed.has(node.id)) node.children.forEach((c) => childUl.append(renderNode(c)));
    li.append(childUl);
  }
  return li;
}

function numChip(n, tone, label) {
  return el("span", { class: `chip ${tone}`, title: `${n} ${label}` }, String(n));
}

function miniBtn(label, title, fn) {
  return el("button", { class: "km-mini", title, onclick: (ev) => { ev.stopPropagation(); fn(); } }, label);
}

// ---------------- 拖拽排序 ----------------

let dragId = null;   // 当前拖拽的节点 id
let dropRow = null;  // 正在显示落点指示的行

function subtreeHas(root, id) {
  if (root.id === id) return true;
  for (const c of root.children || []) if (subtreeHas(c, id)) return true;
  return false;
}

// 返回包含 id 节点的兄弟数组（即其父的 children 或根列表）
function findParentList(list, id) {
  for (const n of list) {
    if (n.id === id) return list;
    if (n.children?.length) {
      const found = findParentList(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

function clearDropMark() {
  if (dropRow) {
    dropRow.classList.remove("drop-before", "drop-after");
    dropRow = null;
  }
}

function moveByDrag(srcId, targetId, after) {
  if (!srcId || srcId === targetId) return;
  const dragged = findNode(srcId);
  if (!dragged || subtreeHas(dragged, targetId)) return; // 不能移入自身子树
  const srcList = findParentList(state.knowledgeTree, srcId);
  const dstList = findParentList(state.knowledgeTree, targetId);
  if (!srcList || !dstList) return;
  const si = srcList.findIndex((n) => n.id === srcId);
  let ti = dstList.findIndex((n) => n.id === targetId);
  if (si < 0 || ti < 0) return;
  const [moved] = srcList.splice(si, 1);
  if (srcList === dstList && ti > si) ti--; // 同列表先删后插：索引回补
  dstList.splice(after ? ti + 1 : ti, 0, moved);
  persist();
  renderTree();
}

// ---------------- 详情（错题 + 笔记） ----------------

function renderDetail() {
  if (!detailBox) return;
  const pane = detailBox;
  const node = currentNodeId ? findNode(currentNodeId) : null;
  clear(pane);
  if (!node) return;

  // 面包屑
  const path = [];
  (function walk(list, acc) {
    for (const n of list) {
      const next = [...acc, n.name];
      if (n.id === node.id) { path.push(...next); return true; }
      if (n.children && walk(n.children, next)) return true;
    }
    return false;
  })(state.knowledgeTree, []);
  pane.append(el("div", { class: "page-head" },
    el("div", {},
      el("h1", {}, node.name),
      el("div", { class: "sub" }, path.join(" / "))),
    el("div", { style: "display:flex;gap:10px" },
      el("button", { class: "btn sm", onclick: () => addChild(node) }, "＋ 子节点"),
      node.id !== currentNodeId ? el("button", { class: "btn sm", onclick: () => selectNode(node.id) }, "查看") : null)));

  const { total, pending } = countUnder(node);
  pane.append(el("div", { class: "grid cols-2", style: "max-width:420px;margin-bottom:var(--sp-3)" },
    el("div", { class: "card stat sky" }, el("div", { class: "label" }, "错题总数"), el("div", { class: "value" }, String(total))),
    el("div", { class: "card stat warn" }, el("div", { class: "label" }, "待复习"), el("div", { class: "value" }, String(pending)))));

  // 错题 / 笔记 切换
  const isLeafNode = isLeaf(node);
  if (isLeafNode) {
    const mistakes = (state.mistakes[node.id] || []).slice();
    const notes = state.notes[node.id] || [];
    mistakes.sort((a, b) => (b.errorCount - a.errorCount) || daysSince(a.lastErrorDate) - daysSince(b.lastErrorDate));

    pane.append(el("div", { class: "km-tabs" },
      el("button", { class: "km-tab" + (detailTab === "mistakes" ? " active" : ""), onclick: () => { detailTab = "mistakes"; renderDetail(); } },
        `错题（${mistakes.length}）`),
      el("button", { class: "km-tab" + (detailTab === "notes" ? " active" : ""), onclick: () => { detailTab = "notes"; renderDetail(); } },
        `笔记（${notes.length}）`)));

    if (detailTab === "mistakes") {
      const sec = el("div", {},
        el("div", { class: "card-title", style: "margin-top:var(--sp-3)" },
          el("h3", {}, "错题"),
          el("button", { class: "btn sm primary", onclick: () => mistakeForm(node.id, null) }, "＋ 添加错题")));
      if (!mistakes.length) {
        sec.append(emptyBox("还没有错题", "点「添加错题」记一道吧"));
      } else {
        // 自适应双列：详情面板足够宽时两列排布，窄窗口自动回落单列
        const grid = el("div", { class: "km-mistake-grid" });
        for (const m of mistakes) grid.append(mistakeCard(node.id, m));
        sec.append(grid);
      }
      pane.append(sec);
    } else {
      renderNotes(pane, node);
    }
  } else {
    pane.append(el("div", { class: "banner info" }, "分支节点：错题与笔记挂在其叶子节点下，点选左侧叶子查看。"));
  }

  // 笔记/错题正文可能含 $..$ 公式；tab 切换与后台更新会重建 DOM，需在此补渲染
  renderMathIn(pane);
}

// ---------------- 内容折叠：超高限高 + 渐隐 + 展开/收起（短内容零干预） ----------------

function collapsible(box, maxH) {
  requestAnimationFrame(() => {
    if (box.scrollHeight <= maxH + 4) return; // 不超高：不干预
    box.classList.add("km-collapse", "clamped");
    box.style.maxHeight = maxH + "px";
    const btn = el("button", { class: "km-collapse-btn", onclick: (ev) => {
      ev.stopPropagation();
      const open = box.classList.toggle("clamped");
      box.style.maxHeight = open ? maxH + "px" : "";
      btn.textContent = open ? "展开 ▾" : "收起 ▴";
    } }, "展开 ▾");
    box.after(btn);
  });
}

// ---------------- 卡片整卡点击展开/收起（max-height 过渡动画，错题/笔记共用） ----------------

const FOLD_H = 150;                 // 折叠态内容高度
const kmExpanded = new Set();       // 已展开卡片 key（重渲染后保持展开）

/**
 * 让卡片支持整卡点击展开/收起：挂载后测量内容高度，超高才可折叠（短内容零干预）。
 * @param {HTMLElement} card 卡片根元素（点击目标，追加角标）
 * @param {HTMLElement} body 折叠的内容容器（.km-card-body）
 * @param {object} opts { foldH, key, stopSel }  key=展开状态记忆键；stopSel=卡片内点击不触发折叠的选择器
 */
function makeFoldable(card, body, { foldH = FOLD_H, key, stopSel = "img.mc-img" } = {}) {
  requestAnimationFrame(() => {
    if (body.scrollHeight <= foldH + 4) return;
    const open = kmExpanded.has(key);
    card.classList.add("km-foldable");
    if (!open) {
      // 初始折叠：禁用过渡直接呈现收起完成态（动画只在用户点击时播放）
      body.style.transition = "none";
      card.classList.add("km-folded");
      body.style.maxHeight = foldH + "px";
      void body.offsetHeight; // 强制回流应用无过渡状态
      body.style.transition = ""; // 恢复过渡，后续点击才有动画
    }
    // 折叠状态指示角标（展开时旋转）
    const hint = el("span", { class: "km-fold-hint" + (open ? " open" : "") }, "▾");
    card.append(hint);
    card.addEventListener("click", () => {
      const isOpen = !card.classList.contains("km-folded");
      if (isOpen) {
        kmExpanded.delete(key);
        // 收起：先钉住当前高度 → 过渡到折叠高度
        body.style.maxHeight = body.scrollHeight + "px";
        void body.offsetHeight; // 强制回流，确保过渡生效
        card.classList.add("km-folded");
        body.style.maxHeight = foldH + "px";
        hint.classList.remove("open");
      } else {
        kmExpanded.add(key);
        // 展开：折叠高度 → 内容实际高度，结束后解除限高
        card.classList.remove("km-folded");
        body.style.maxHeight = body.scrollHeight + "px";
        body.addEventListener("transitionend", function onEnd(e) {
          if (e.propertyName !== "max-height") return;
          body.style.maxHeight = "";
          body.removeEventListener("transitionend", onEnd);
        });
        hint.classList.add("open");
      }
    });
    // 命中 stopSel（图片放大等）时不触发折叠
    body.addEventListener("click", (ev) => {
      if (stopSel && ev.target.closest(stopSel)) ev.stopPropagation();
    });
  });
}

function mistakeCard(nodeId, m) {
  const urgent = isUrgent(m);
  const card = el("div", { class: "card km-mistake" + (urgent ? " km-urgent" : "") });

  // 卡片主体（题干/标签/日期/图片/详情）——整卡点击的折叠对象
  const body = el("div", { class: "km-card-body" });
  body.append(el("div", { style: "display:flex;gap:10px;align-items:flex-start" },
    el("div", { style: "flex:1;line-height:1.9;font-size:var(--fs-body)" }, m.question),
    chip(`错 ${m.errorCount} 次`, urgent ? "pink" : "")));
  if (m.errorReasonTag) body.append(chip(m.errorReasonTag, "warn"));
  body.append(el("div", { style: "font-size:var(--fs-tiny);color:var(--text-3);margin-top:6px" },
    `添加 ${m.createdAt || "—"} · 最后出错 ${m.lastErrorDate || "—"}` + (urgent ? " · 急需复习" : "")));
  // 图片三组收进两列网格：两组并排一行，组内图片自适应撑满列宽，消除右侧空窗
  const imgGrid = el("div", { class: "km-img-grid" });
  const imgGroup = (paths, label) => el("div", { class: "km-img-group" },
    el("div", { class: "km-img-label" }, label), imgsRow(paths));
  if (imgUrl(m.images)) imgGrid.append(imgGroup(m.images, "题目图片"));
  if (imgUrl(m.wrongImages)) imgGrid.append(imgGroup(m.wrongImages, "错误答案图片"));
  if (imgUrl(m.correctImages)) imgGrid.append(imgGroup(m.correctImages, "正确思路图片"));
  if (imgGrid.childElementCount) body.append(imgGrid);

  // 文字详情：错误答案 | 正确思路 并排，详细原因整行
  const dl = el("div", { class: "km-mistake-detail" });
  if (m.wrongAnswer) dl.append(el("div", {}, "错误答案：", el("span", { style: "color:var(--danger)" }, m.wrongAnswer)));
  if (m.correctIdea) dl.append(el("div", {}, "正确思路：", el("span", { style: "color:var(--ok)" }, m.correctIdea)));
  if (m.errorDetail) dl.append(el("div", { class: "km-detail-full", style: "color:var(--text-2)" }, "详细原因：" + m.errorDetail));
  if (dl.childElementCount) {
    const box = el("div", { class: "explain", style: "margin-top:10px" });
    box.append(dl);
    body.append(box);
  }
  card.append(body);

  const ops = el("div", { class: "ops", style: "display:flex;gap:10px;margin-top:12px" },
    el("button", { class: "btn sm primary", onclick: () => {
      m.errorCount += 1;
      m.lastErrorDate = today();
      persist(); renderDetail();
      toastOk(`已记一次出错（${m.errorCount}）`);
    } }, "再次出错 +1"),
    el("button", { class: "btn sm", onclick: () => mistakeForm(nodeId, m) }, "编辑"),
    el("button", { class: "btn sm danger", onclick: () =>
      confirmModal("删除错题", "删除后不可恢复，确定吗？", () => {
        state.mistakes[nodeId] = (state.mistakes[nodeId] || []).filter((x) => x.id !== m.id);
        persist(); renderAll();
      }, "删除", "danger") }, "删除"));
  card.append(ops);
  // 操作按钮点击不触发整卡折叠
  ops.addEventListener("click", (ev) => ev.stopPropagation());
  // 整卡点击展开/收起（内容超高时启用，重渲染后保持展开状态）
  makeFoldable(card, body, { key: `m:${m.id}` });
  return card;
}

function mistakeForm(nodeId, existing) {
  const m = existing || { id: uid(), question: "", errorCount: 1, createdAt: today(), lastErrorDate: today(), errorReasonTag: "", wrongAnswer: "", correctIdea: "", errorDetail: "", images: [], wrongImages: [], correctImages: [] };
  const question = field("题目（必填）", m.question, { textarea: true });
  const tag = field("错因标签（如：概念不清 / 计算失误）", m.errorReasonTag || "");
  const count = field("累计出错次数", String(m.errorCount ?? 1));
  const lastDate = field("最后出错日期", m.lastErrorDate || today());
  const wrong = field("错误答案", m.wrongAnswer || "", { textarea: true });
  const correct = field("正确思路", m.correctIdea || "", { textarea: true });
  const detail = field("详细原因", m.errorDetail || "", { textarea: true });

  // 三组图片：{ paths: 已保存的服务端路径[], pending: 新选待上传的本地文件路径[], removed: 移除的服务端路径[] }
  const imgs = [
    { key: "images", label: "题目配图（可选）", paths: [...(m.images || [])], pending: [], removed: [] },
    { key: "wrongImages", label: "错误答案图片（可选）", paths: [...(m.wrongImages || [])], pending: [], removed: [] },
    { key: "correctImages", label: "正确思路图片（可选）", paths: [...(m.correctImages || [])], pending: [], removed: [] },
  ];

  function pickImages(group) {
    (async () => {
      let arr;
      if (isAndroid()) {
        // Android：file input 直读内存（content:// 路径 Rust 读不了）
        arr = await pickFiles({ multiple: true, accept: "image/*", read: "none" });
        if (!arr.length) return;
      } else {
        try {
          const { open } = window.__TAURI__.dialog;
          const chosen = await open({ multiple: true, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }] });
          arr = (chosen ? (Array.isArray(chosen) ? chosen : [chosen]) : []).filter(Boolean)
            .map((p) => ({ name: String(p).split(/[\\/]/).pop() || "image", file: p }));
        } catch (e) {
          return toastErr("打开文件选择器失败：" + e.message);
        }
        if (!arr.length) return;
      }
      for (const it of arr) {
        // 读取 → 压缩为 WebP（服务端只存压缩小图；预览即最终存储内容）
        try {
          const b64 = it.b64 !== undefined ? it.b64 : await api.readFileBase64(it.file);
          // Chromium 按内容嗅探解码，声明的 png 类型不影响 jpg/gif/bmp/webp
          const blob = await compressToWebp("data:image/png;base64," + b64);
          if (blob.size > 5 * 1024 * 1024) {
            toastErr("图片压缩后仍超过 5MB，请更换更小的图片");
            continue;
          }
          const webpB64 = await blobToBase64(blob);
          const name = (it.name || "image").replace(/\.[^.]+$/, "") + ".webp";
          group.pending.push({ name: name, b64: webpB64, preview: "data:image/webp;base64," + webpB64 });
        } catch (e) {
          toastErr("读取图片失败：" + String(e?.message || e));
        }
      }
      drawGroup(group);
    })();
  }

  function drawGroup(group) {
    const box = group.box;
    clear(box);
    const items = [
      ...group.paths.map((p, i) => ({ src: imgUrl(p), del: () => { group.paths.splice(i, 1); group.removed.push(p); drawGroup(group); } })),
      ...group.pending.map((it, i) => ({ src: it.preview, del: () => { group.pending.splice(i, 1); drawGroup(group); } })),
    ];
    for (const it of items) {
      const thumb = el("div", { class: "img-thumb" },
        el("img", { src: it.src, alt: "配图", loading: "lazy", onclick: () => viewImage(it.src) }),
        el("button", { class: "img-del", title: "移除", onclick: (ev) => { ev.stopPropagation(); it.del(); } }, "×"));
      box.append(thumb);
    }
    box.append(el("button", { class: "btn sm", onclick: () => pickImages(group) }, "＋ 选图"));
  }

  // 双栏排版：左列主内容（题目/答案/思路/原因），右列元信息 + 三组图片；整体限高内部滚动
  question.input.rows = 5;
  for (const t of [wrong, correct, detail]) {
    t.input.rows = 3;
    t.input.style.minHeight = "72px";
  }
  const left = el("div", { style: "display:flex;flex-direction:column;gap:var(--sp-2)" },
    question, wrong, correct, detail);
  const right = el("div", { style: "display:flex;flex-direction:column;gap:var(--sp-2)" },
    tag,
    el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:8px" }, count, lastDate));
  for (const g of imgs) {
    right.append(el("div", {},
      el("div", { class: "km-img-label" }, g.label),
      g.box = el("div", { class: "img-preview", style: "display:flex;flex-wrap:wrap;gap:10px;align-items:center" })));
    drawGroup(g);
  }

  const body = el("div", { style: "display:grid;grid-template-columns:1fr 300px;gap:var(--sp-3);max-height:74vh;overflow-y:auto;padding-right:4px" },
    left, right);

  modal({ title: existing ? "编辑错题" : "添加错题", wide: true, body: body, actions: [
    { label: existing ? "保存" : "添加", kind: "primary", onClick: async () => {
      if (!question.input.value.trim()) throw new Error("请填写题目");
      // 上传新增图片，返回最终路径数组
      async function flush(g) {
        const out = [...g.paths];
        for (const it of g.pending) {
          try {
            const up = await api.uploadBytes("backend/api/knowledge_mistakes/index.php?action=upload", "file", it.name, it.b64, "image/webp");
            // 该接口返回扁平结构 {success, path}，区别于其他接口的 {success, data:{...}} 信封
            const p = up?.data?.path || up?.path;
            if (p) out.push(p);
          } catch (e) {
            toastErr("图片上传失败：" + (e.message || "未知错误"));
          }
        }
        // 移除的图片通知后端删除（引用计数保护）
        for (const p of g.removed) {
          api.postJSON("backend/api/knowledge_mistakes/index.php?action=delete_image", { path: p }).catch(() => {});
        }
        return out;
      }
      const next = {
        ...m,
        question: question.input.value.trim(),
        errorReasonTag: tag.input.value.trim(),
        errorCount: Number(count.input.value) || 1,
        lastErrorDate: lastDate.input.value.trim() || today(),
        wrongAnswer: wrong.input.value.trim(),
        correctIdea: correct.input.value.trim(),
        errorDetail: detail.input.value.trim(),
        images: await flush(imgs[0]),
        wrongImages: await flush(imgs[1]),
        correctImages: await flush(imgs[2]),
      };
      const list = state.mistakes[nodeId] || [];
      if (existing) {
        state.mistakes[nodeId] = list.map((x) => (x.id === m.id ? next : x));
      } else {
        state.mistakes[nodeId] = [...list, next];
      }
      persist(); renderAll();
    } },
  ] });
}

// ---------------- 笔记 ----------------

function renderNotes(pane, node) {
  const notes = state.notes[node.id] || [];
  const sec = el("div", {},
    el("div", { class: "card-title", style: "margin-top:var(--sp-4)" },
      el("h3", {}, "笔记"),
      el("button", { class: "btn sm primary", onclick: () => noteForm(node.id, null) }, "＋ 添加笔记")));
  if (!notes.length) {
    sec.append(emptyBox("还没有笔记", "记录这个知识点的理解与心得"));
  } else {
    for (const n of notes) {
      const card = el("div", { class: "card km-note", style: "margin-bottom:var(--sp-2);padding:14px" });
      // 折叠主体：标题行 + 日期 + Markdown 正文
      const body = el("div", { class: "km-card-body" });
      body.append(el("div", { style: "display:flex;gap:10px;align-items:center" },
        el("strong", { style: "font-weight:300" }, n.title || "（无标题）"),
        el("span", { style: "margin-left:auto;font-size:var(--fs-tiny);color:var(--text-3)" }, n.updatedAt || n.createdAt || "")));
      const md = el("div", { class: "km-note-md", style: "font-size:var(--fs-small);line-height:1.9;margin-top:8px" });
      // Markdown 渲染（标题/加粗/表格/公式/图片），渲染器先全文转义再生成标签
      md.innerHTML = kmMarkdown(n.content || "", { baseUrl: api.baseUrlSync() });
      body.append(md);
      card.append(body);

      const ops = el("div", { class: "ops", style: "display:flex;gap:10px;margin-top:10px" },
        el("button", { class: "btn sm", onclick: () => noteForm(node.id, n) }, "编辑"),
        el("button", { class: "btn sm danger", onclick: () =>
          confirmModal("删除笔记", "确定删除这条笔记吗？", () => {
            state.notes[node.id] = (state.notes[node.id] || []).filter((x) => x.id !== n.id);
            persist(); renderAll();
          }, "删除", "danger") }, "删除"));
      card.append(ops);
      ops.addEventListener("click", (ev) => ev.stopPropagation());
      // 整卡点击展开/收起（与错题卡同款动画；点图片放大不触发）
      makeFoldable(card, body, { key: `n:${n.id}`, stopSel: "img" });
      sec.append(card);
    }
  }
  pane.append(el("div", { class: "section-gap" }), sec);
}

// ---------------- 笔记编辑插入工具 ----------------

// 选区包裹（无选区时插入占位文本并选中，可直接输入覆盖）
function mdWrap(ta, before, after, placeholder) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.slice(s, e) || placeholder;
  ta.setRangeText(before + sel + after, s, e, "select");
  ta.setSelectionRange(s + before.length, s + before.length + sel.length);
  ta.focus();
  ta.dispatchEvent(new Event("input"));
}

// 光标处插入文本
function mdInsert(ta, text) {
  ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
  ta.focus();
  ta.dispatchEvent(new Event("input"));
}

// 光标所在行行首加前缀
function mdPrefixLine(ta, prefix) {
  const ls = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
  ta.setRangeText(prefix, ls, ls, "end");
  ta.focus();
  ta.dispatchEvent(new Event("input"));
}

// Markdown 工具栏按钮（对齐 web 端知识笔记编辑器）
function mdTool(symbol, title, fn) {
  return el("button", { class: "km-mini", type: "button", title, onclick: fn }, symbol);
}

// —— 一键适应：AI 公式定界符转换（规则存 note_convert_rules，后台 #latex-rules 可配） ——
let aiConvertSources = null;   // [{source, rules:[{find_text, replace_text, sort_order}]}]
let aiConvertPromise = null;

function fetchAiConvertRules() {
  if (!aiConvertPromise) {
    aiConvertPromise = api.get("backend/api/latex_rules.php", { action: "list" })
      .then((env) => { aiConvertSources = env?.data?.sources || []; return aiConvertSources; })
      .catch(() => { aiConvertPromise = null; return []; });
  }
  return aiConvertPromise;
}

function noteForm(nodeId, existing) {
  const title = field("标题", existing?.title || "");
  const content = field("内容（支持 Markdown：标题/加粗/表格/公式/图片）", existing?.content || "", { textarea: true });
  const ta = content.input;
  ta.rows = 12;
  ta.style.resize = "vertical";

  // —— 实时预览（与 web 端一致：输入防抖 120ms 渲染） ——
  const preview = el("div", {
    class: "km-note-md",
    style: "border:var(--hairline-soft);border-radius:var(--r-md);padding:10px 14px;overflow-y:auto;min-height:280px;max-height:420px;background:var(--faint-bg)",
  });
  let pvTimer = null;
  const renderPreview = () => {
    const v = ta.value;
    preview.innerHTML = v.trim()
      ? kmMarkdown(v, { baseUrl: api.baseUrlSync() })
      : '<p style="color:var(--text-3)">输入内容后此处实时预览</p>';
  };
  ta.addEventListener("input", () => {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(renderPreview, 120);
  });
  renderPreview();

  // —— 工具栏：与 web 端同款 14 个功能 ——
  const TABLE_TPL = "\n\n| 表头 A | 表头 B | 表头 C |\n|---|---|---|\n| 内容 | 内容 | 内容 |\n\n";
  const bar = el("div", { class: "toolbar-row", style: "flex-wrap:wrap;margin-bottom:6px" },
    mdTool("B", "加粗（Ctrl+B）", () => mdWrap(ta, "**", "**", "加粗文字")),
    mdTool("I", "斜体（Ctrl+I）", () => mdWrap(ta, "*", "*", "斜体文字")),
    mdTool("S", "删除线", () => mdWrap(ta, "~~", "~~", "删除文字")),
    mdTool("H1", "一级标题", () => mdPrefixLine(ta, "# ")),
    mdTool("H2", "二级标题", () => mdPrefixLine(ta, "## ")),
    mdTool("H3", "三级标题", () => mdPrefixLine(ta, "### ")),
    mdTool("•", "无序列表", () => mdPrefixLine(ta, "- ")),
    mdTool("1.", "有序列表", () => mdPrefixLine(ta, "1. ")),
    mdTool("❝", "引用", () => mdPrefixLine(ta, "> ")),
    mdTool("⊞", "插入表格", () => mdInsert(ta, TABLE_TPL)),
    mdTool("</>", "代码块", () => mdWrap(ta, "\n```\n", "\n```\n", "代码块")),
    mdTool("🔗", "插入链接", () => mdWrap(ta, "[", "](https://)", "链接文字")),
    mdTool("∫", "行内公式 $LaTeX$", () => mdWrap(ta, "$", "$", "\\int_0^1 x^2 \\, dx")),
    mdTool("∑", "块级公式 $$LaTeX$$", () => mdWrap(ta, "\n$$", "$$\n", "f(x) = \\sum_{n=0}^{\\infty} a_n x^n")),
    mdTool("—", "分割线", () => mdInsert(ta, "\n\n---\n\n")));

  // —— 一键适应：AI 来源下拉 + 转换按钮 ——
  const aiSel = el("select", {
    title: "选择 AI 输出格式",
    style: "padding:3px 6px;border:var(--hairline);border-radius:var(--r-sm,6px);background:var(--card);" +
      "color:var(--text-2);font-size:var(--fs-tiny);max-width:130px",
  }, el("option", { value: "" }, "AI 来源…"));
  fetchAiConvertRules().then((sources) => {
    for (const s of sources) aiSel.append(el("option", { value: s.source }, s.source));
  });
  const applyAiConvert = () => {
    const src = aiSel.value;
    if (!src) { toastErr("请先选择 AI 来源"); return; }
    const entry = (aiConvertSources || []).find((s) => s.source === src);
    if (!entry || !entry.rules.length) { toastErr("该来源暂无可用转换规则"); return; }
    let v = ta.value;
    for (const r of entry.rules) {
      if (r.find_text) v = v.split(r.find_text).join(r.replace_text);
    }
    if (v === ta.value) { toastOk("内容无需转换"); return; }
    ta.value = v;
    ta.dispatchEvent(new Event("input"));
    toastOk(`已按「${src}」规则转换`);
  };
  bar.append(
    el("span", { style: "width:1px;height:14px;background:var(--hairline);margin:0 5px" }),
    aiSel,
    mdTool("一键适应", "把所选 AI 的公式定界符转换为 $ / $$ 标记", applyAiConvert));

  // 常用快捷键（对齐 web 端）
  ta.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === "b") { e.preventDefault(); mdWrap(ta, "**", "**", "加粗文字"); }
    if (k === "i") { e.preventDefault(); mdWrap(ta, "*", "*", "斜体文字"); }
  });

  // 左编辑右预览双栏（宽弹窗）
  const editor = el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:start" },
    content,
    el("div", { style: "display:flex;flex-direction:column;gap:4px" },
      el("div", { style: "font-size:var(--fs-tiny);color:var(--text-3);letter-spacing:0.06em" }, "实时预览"),
      preview));

  modal({ title: existing ? "编辑笔记" : "添加笔记", wide: true, body:
    el("div", { class: "fields", style: "display:flex;flex-direction:column;gap:var(--sp-2)" }, title, bar, editor),
    actions: [
      { label: existing ? "保存" : "添加", kind: "primary", onClick: () => {
        const now = today();
        if (existing) {
          state.notes[nodeId] = (state.notes[nodeId] || []).map((x) =>
            x.id === existing.id ? { ...x, title: title.input.value.trim(), content: ta.value, updatedAt: now } : x);
        } else {
          state.notes[nodeId] = [...(state.notes[nodeId] || []),
            { id: uid(), title: title.input.value.trim(), content: ta.value, createdAt: now, updatedAt: now }];
        }
        persist(); renderAll();
      } },
    ] });
  setTimeout(() => title.input.focus(), 100);
}

// ---------------- 树操作 ----------------

function selectNode(id) { currentNodeId = id; renderAll(); }

function addChild(parent) {
  prompt2("子节点名称", "", (v) => {
    if (!v) return;
    parent.children = parent.children || [];
    parent.children.push({ id: uid(), name: v, children: [] });
    currentNodeId = parent.children[parent.children.length - 1].id;
    collapsed.delete(parent.id);
    persist(); renderAll();
  });
}

function renameNode(node) {
  prompt2("重命名", node.name, (v) => {
    if (!v) return;
    node.name = v;
    persist(); renderAll();
  });
}

function deleteNode(node) {
  const { total } = countUnder(node);
  confirmModal("删除节点", `确定删除「${node.name}」吗？` +
    (total > 0 ? `其下 ${total} 道错题将一并删除！` : ""), () => {
    (function del(list) {
      const i = list.findIndex((x) => x.id === node.id);
      if (i >= 0) { list.splice(i, 1); return true; }
      return list.some((n) => n.children && del(n.children));
    })(state.knowledgeTree);
    if (currentNodeId === node.id) currentNodeId = null;
    persist(); renderAll();
  }, "删除", "danger");
}

// ---------------- 统计 / 复习模式 / 导入 / 导出（参照 Web 端） ----------------

/** 节点路径面包屑（根 › … › 节点名） */
function pathToNode(id) {
  const path = [];
  (function walk(list, acc) {
    for (const n of list) {
      const next = [...acc, n.name];
      if (n.id === id) { path.push(...next); return true; }
      if (n.children && walk(n.children, next)) return true;
    }
    return false;
  })(state.knowledgeTree, []);
  return path;
}

// —— 📊 统计 ——

function showStats() {
  const t2 = { total: 0, last7: 0, reason: {}, kp: [], urgent: [] };
  state.knowledgeTree.forEach((root) => {
    (function walk(node, trail) {
      const path = trail.concat(node.name);
      if (isLeaf(node)) {
        const list = state.mistakes[node.id] || [];
        if (!list.length) return;
        let sum = 0, topM = null;
        for (const m of list) {
          t2.total++;
          sum += m.errorCount || 0;
          if (daysSince(m.createdAt) <= 7) t2.last7++;
          if (m.errorReasonTag) t2.reason[m.errorReasonTag] = (t2.reason[m.errorReasonTag] || 0) + 1;
          if (!topM || (m.errorCount || 0) > (topM.errorCount || 0)) topM = m;
          if (isUrgent(m)) t2.urgent.push({ m, path: path.join(" › ") });
        }
        t2.kp.push({ name: node.name, path: path.join(" › "), total: list.length, avg: sum / list.length, sum, top: topM });
      } else if (node.children) {
        node.children.forEach((c) => walk(c, path));
      }
    })(root, []);
  });

  const body = el("div", { style: "max-height:70vh;overflow-y:auto" });
  body.append(el("div", { class: "grid cols-4" },
    el("div", { class: "card stat sky" }, el("div", { class: "label" }, "错题总数"), el("div", { class: "value" }, String(t2.total))),
    el("div", { class: "card stat mint" }, el("div", { class: "label" }, "近一周新增"), el("div", { class: "value" }, String(t2.last7))),
    el("div", { class: "card stat pink" }, el("div", { class: "label" }, "错误原因种类"), el("div", { class: "value" }, String(Object.keys(t2.reason).length))),
    el("div", { class: "card stat warn" }, el("div", { class: "label" }, "急需复习"), el("div", { class: "value" }, String(t2.urgent.length)))));

  // 高频错误原因
  const reasonRow = el("div", { style: "display:flex;flex-wrap:wrap;gap:8px;margin-top:8px" });
  const reasons = Object.entries(t2.reason).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of reasons) reasonRow.append(chip(`${k} · ${v}`, "warn"));
  if (!reasons.length) reasonRow.append(el("span", { style: "color:var(--text-3);font-size:var(--fs-small)" }, "暂无数据"));
  body.append(el("div", { style: "margin-top:var(--sp-3)" }, el("h4", { style: "font-weight:300;margin-bottom:6px" }, "高频错误原因"), reasonRow));

  // 急需复习
  const urgentBox = el("div", { style: "margin-top:var(--sp-3)" },
    el("h4", { style: "font-weight:300;margin-bottom:6px" }, `急需复习（错≥${URGENT_COUNT} 次且近 ${URGENT_DAYS} 天出错）`));
  if (!t2.urgent.length) {
    urgentBox.append(el("div", { style: "color:var(--ok);font-size:var(--fs-small)" }, "🎉 暂无急需复习的错题"));
  } else {
    const ul = el("div", { style: "display:flex;flex-direction:column;gap:6px" });
    for (const u of t2.urgent.sort((a, b) => (b.m.errorCount || 0) - (a.m.errorCount || 0))) {
      ul.append(el("div", { style: "font-size:var(--fs-small);display:flex;gap:8px;align-items:baseline;flex-wrap:wrap" },
        el("span", { style: "flex:1;min-width:120px" }, String(u.m.question || "").slice(0, 30) + ((u.m.question || "").length > 30 ? "…" : "")),
        el("span", { style: "color:var(--text-3);font-size:var(--fs-tiny)" }, u.path),
        el("span", { style: "color:var(--danger)" }, `错 ${u.m.errorCount} 次`)));
    }
    urgentBox.append(ul);
  }
  body.append(urgentBox);

  // 各知识点统计
  const kpBox = el("div", { style: "margin-top:var(--sp-3)" },
    el("h4", { style: "font-weight:300;margin-bottom:6px" }, "各知识点统计（按错题数排序）"));
  const kpList = el("div", { style: "display:flex;flex-direction:column;gap:6px" });
  for (const k of t2.kp.sort((a, b) => b.total - a.total)) {
    kpList.append(el("div", { style: "font-size:var(--fs-small);display:flex;gap:8px;align-items:baseline;flex-wrap:wrap" },
      el("span", { title: k.path, style: "font-weight:300" }, `${k.name} (${k.total}题)`),
      el("span", { style: "color:var(--text-3)" }, `均错 ${k.avg.toFixed(1)} 次`),
      el("span", { style: "color:var(--text-2);flex:1;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" },
        "最高频：" + String(k.top.question || "").slice(0, 18) + ((k.top.question || "").length > 18 ? "…" : ""))));
  }
  if (!t2.kp.length) kpList.append(el("span", { style: "color:var(--text-3);font-size:var(--fs-small)" }, "暂无错题"));
  kpBox.append(kpList);
  body.append(kpBox);

  // 错题次数 Top15（水平条形，SVG 自绘）
  body.append(el("div", { style: "margin-top:var(--sp-3)" },
    el("h4", { style: "font-weight:300;margin-bottom:6px" }, "知识点错误次数 Top 15"),
    errorCountChart(t2.kp)));

  modal({ title: "📊 统计", body, actions: [] });
}

function errorCountChart(kpStats) {
  const rows = kpStats.slice().sort((a, b) => b.sum - a.sum).slice(0, 15);
  if (!rows.length) return el("div", { style: "color:var(--text-3);font-size:var(--fs-small)" }, "暂无数据");
  const W = 440, rowH = 24, labelW = 108, valW = 44;
  const barMax = W - labelW - valW;
  const H = rows.length * rowH + 8;
  const maxV = Math.max(1, ...rows.map((r) => r.sum));
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, style: "width:100%;height:auto" });
  rows.forEach((row, i) => {
    const top = 4 + i * rowH;
    const cy = top + rowH / 2;
    const w = Math.max(2, (row.sum / maxV) * barMax);
    svg.append(svgEl("text", { x: labelW - 8, y: cy + 3.5, "text-anchor": "end",
      style: "fill:var(--text-2);font-size:10.5px" },
      row.name.length > 8 ? row.name.slice(0, 8) + "…" : row.name));
    svg.append(svgEl("rect", { x: labelW, y: top + 5, width: w, height: rowH - 10, rx: "4",
      style: "fill:var(--sky);opacity:.72" },
      svgEl("title", {}, `${row.path}：累计错误 ${row.sum} 次`)));
    svg.append(svgEl("text", { x: labelW + w + 8, y: cy + 3.5,
      style: "fill:var(--text-2);font-size:10.5px" }, String(row.sum)));
  });
  return svg;
}

// —— 🎲 复习模式（随机抽题） ——

let reviewPool = [];
let reviewIdx = 0;

function openReview() {
  reviewPool = [];
  reviewIdx = 0;

  const rangeSel = el("select", { class: "input", style: "width:auto;min-width:130px" },
    el("option", { value: "all" }, "全部错题"),
    el("option", { value: "high" }, "高频错题（≥3次）"),
    el("option", { value: "urgent" }, "急需复习"));
  const progress = el("span", { style: "font-size:var(--fs-small);color:var(--text-3)" }, "");
  const cardZone = el("div", { style: "margin-top:var(--sp-2)" });

  const body = el("div", { style: "max-height:72vh;overflow-y:auto" },
    el("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" },
      rangeSel,
      el("button", { class: "btn sm primary", onclick: () => startReview() }, "开始 / 重抽"),
      progress),
    cardZone);

  function startReview() {
    const range = rangeSel.value;
    reviewPool = [];
    const walk = (node) => {
      if (isLeaf(node)) {
        for (const m of state.mistakes[node.id] || []) {
          if (range === "all") reviewPool.push({ nodeId: node.id, m });
          else if (range === "high" && (m.errorCount || 0) >= 3) reviewPool.push({ nodeId: node.id, m });
          else if (range === "urgent" && isUrgent(m)) reviewPool.push({ nodeId: node.id, m });
        }
      } else if (node.children) node.children.forEach(walk);
    };
    state.knowledgeTree.forEach((root) => walk(root));
    // 洗牌
    for (let i = reviewPool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [reviewPool[i], reviewPool[j]] = [reviewPool[j], reviewPool[i]];
    }
    reviewIdx = 0;
    drawCard();
  }

  function drawCard() {
    clear(cardZone);
    if (!reviewPool.length) {
      cardZone.append(emptyBox("该范围内还没有错题", "先去记录几道吧"));
      progress.textContent = "";
      return;
    }
    const cur = reviewPool[reviewIdx];
    if (!cur) { // 本轮完成
      cardZone.append(emptyBox("本轮复习完成 🎉", "点「开始 / 重抽」再来一轮"));
      progress.textContent = "";
      return;
    }
    const m = cur.m;
    progress.textContent = `第 ${reviewIdx + 1} / ${reviewPool.length} 道`;

    const answerBox = el("div", { style: "display:none" });
    const revealBtn = el("button", { class: "btn sm", onclick: () => {
      answerBox.style.display = "";
      revealBtn.disabled = true;
    } }, "显示答案");
    revealBtn.disabled = false;

    const card = el("div", { class: "card", style: "padding:14px" },
      el("div", { style: "font-size:var(--fs-tiny);color:var(--text-3);margin-bottom:8px" },
        "考点：" + pathToNode(cur.nodeId).join(" › ")),
      el("div", { style: "line-height:1.9;font-size:var(--fs-body);white-space:pre-line" }, m.question || ""),
      imgsRow(m.images),
      el("div", { style: "margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap" },
        revealBtn,
        el("span", { style: "font-size:var(--fs-tiny);color:var(--text-3)" }, `已错 ${m.errorCount || 0} 次`)));

    // 答案区
    const dl = el("div", { class: "explain", style: "margin-top:10px;font-size:var(--fs-small)" });
    dl.append(el("div", {}, "错误答案：", el("span", { style: "color:var(--danger);white-space:pre-line" }, m.wrongAnswer || "（无）")));
    if (imgUrl(m.wrongImages)) dl.append(el("div", { style: "margin-top:6px" }, el("div", { class: "km-img-label" }, "错误答案图片"), imgsRow(m.wrongImages)));
    dl.append(el("div", { style: "margin-top:6px" }, "正确思路：", el("span", { style: "color:var(--ok);white-space:pre-line" }, m.correctIdea || "（无）")));
    if (imgUrl(m.correctImages)) dl.append(el("div", { style: "margin-top:6px" }, el("div", { class: "km-img-label" }, "正确思路图片"), imgsRow(m.correctImages)));
    if (m.errorDetail) dl.append(el("div", { style: "margin-top:6px;color:var(--text-2);white-space:pre-line" }, "详细原因：" + m.errorDetail));
    answerBox.append(dl,
      el("div", { style: "display:flex;gap:10px;margin-top:12px" },
        el("button", { class: "btn sm primary", onclick: () => { reviewIdx++; drawCard(); } }, "答对了"),
        el("button", { class: "btn sm danger", onclick: () => {
          m.errorCount = (m.errorCount || 0) + 1;
          m.lastErrorDate = today();
          persist();
          reviewIdx++;
          drawCard();
        } }, "答错了"),
        el("button", { class: "btn sm ghost", onclick: () => {
          if (reviewPool.length > 1) {
            let r;
            do { r = Math.floor(Math.random() * reviewPool.length); } while (r === reviewIdx);
            reviewIdx = r;
          }
          drawCard();
        } }, "换一道")));
    card.append(answerBox);
    renderMathIn(card); // 题目与答案可能含 $..$ 公式
    cardZone.append(card);
  }

  drawCard();
  modal({ title: "🎲 复习模式", body, actions: [] });
}

// —— 📥 导入 / 📤 导出 ——
// 导出 = 选一个根节点 → 扣 ¥2.00 + AES 加密包（.kmt）+ 一次性分享码（密钥仅后端存哈希）
// 导入 = 上传 .kmt + 分享码，后端校验解密后将该树【追加】为新根，不影响现有数据

async function importData() {
  let filePath = null;
  if (!isAndroid()) {
    try {
      const { open } = window.__TAURI__.dialog;
      filePath = await open({ multiple: false, filters: [{ name: "知识树加密包（KMT）", extensions: ["kmt"] }] });
    } catch (e) {
      return toastErr("打开文件选择器失败：" + e.message);
    }
    filePath = Array.isArray(filePath) ? filePath[0] : filePath;
    if (!filePath) return;
  }
  // 输入对方提供的分享码（一次性解密密钥）
  prompt2("输入分享码（XXXX-XXXX）", "", (code) => {
    if (!code) { toastErr("请输入对方提供的 8 位分享码"); return; }
    confirmModal("导入知识树", "导入的树将作为新根节点加入当前知识树，不影响现有内容。确定继续？", async () => {
      try {
        if (isAndroid()) {
          // Android：file input 直读内存 → uploadBytes（服务端读 $_FILES，与来源无关）
          const [it] = await pickFiles({ accept: ".kmt", read: "b64" });
          if (!it) return;
          await api.uploadBytes("backend/api/knowledge_mistakes/index.php?action=import", "file", it.name, it.b64, "application/octet-stream", { code });
        } else {
          await api.upload("backend/api/knowledge_mistakes/index.php?action=import", "file", filePath, { code });
        }
        toastOk("导入成功");
        if (activeContainer) renderKnowledge(activeContainer);
      } catch (e) {
        toastErr("导入失败：" + (e.message || "未知错误"));
      }
    }, "导入", "primary");
  });
}

async function exportData() {
  const roots = state.knowledgeTree || [];
  if (!roots.length) { toastErr("暂无可导出的根节点"); return; }
  // 选根下拉：每次只导出一棵根子树
  const sel = el("select", {
    style: "width:100%;padding:9px 12px;border:var(--hairline);border-radius:var(--r-lg);" +
      "background:var(--card);color:var(--text);font-size:var(--fs-body)",
  });
  for (const r of roots) {
    const opt = el("option", {}, `${r.name}（${countUnder(r).total} 道错题）`);
    opt.value = r.id;
    sel.append(opt);
  }
  modal({
    title: "📤 导出知识树",
    body: el("div", {},
      sel,
      el("p", { style: "color:var(--text-3);font-size:var(--fs-tiny);line-height:1.9;margin-top:10px" },
        "将打包该根节点下的全部子节点、错题与笔记为加密文件（.kmt），本次扣除 ¥2.00 余额。导出后获得一次性分享码，把文件与分享码一起发给对方即可导入。")),
    actions: [
      { label: "导出（¥2.00）", kind: "primary", onClick: async () => {
        const rootId = sel.value;
        if (!rootId) throw new Error("请选择要导出的根节点");
        const env = await api.post("backend/api/knowledge_mistakes/index.php?action=export", { root_id: rootId });
        const d = env?.data || {};
        if (!d.share_code || !d.file_b64) throw new Error(env?.message || "导出响应异常");
        const name = d.filename || "knowledge-tree-" + today().replace(/-/g, "") + ".kmt";
        await api.exportFile(name, d.file_b64, "知识树加密包（KMT）", ["kmt"]);
        showShareCodeModal(d);
        refreshShellBalance().catch(() => {});
      } },
    ],
  });
}

/** 导出成功：展示一次性分享码（文本可全选，点按钮复制） */
function showShareCodeModal(d) {
  const codeEl = el("div", {
    style: "margin:10px 0 4px;padding:14px 10px;text-align:center;border:1px dashed var(--sky);" +
      "border-radius:var(--r-card);font-family:ui-monospace,Consolas,monospace;font-size:22px;letter-spacing:4px;user-select:all",
  }, d.share_code || "");
  modal({
    title: "📤 导出成功",
    body: el("div", {},
      el("p", { style: "color:var(--text-2);font-size:var(--fs-body);line-height:2" },
        (d.root_name ? `已导出根节点「${d.root_name}」。` : "") +
        "请把文件与分享码一起发给对方，对方导入时将作为新根节点加入其知识树："),
      codeEl,
      el("p", { style: "color:var(--text-3);font-size:var(--fs-tiny);line-height:1.9;margin-top:8px" },
        `分享码仅可使用一次，${d.expires_in_days || 7} 天内有效；再次导出同一根节点会使其旧分享码作废。`)),
    actions: [
      { label: "复制分享码", kind: "primary", onClick: async () => {
        await copyTextToClipboard(d.share_code || "");
        toastOk("已复制：" + d.share_code);
      } },
    ],
  });
}

/** 剪贴板写入（WebView 无 clipboard API 时降级 execCommand） */
function copyTextToClipboard(text) {
  return new Promise((resolve, reject) => {
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        ok ? resolve() : reject(new Error("复制失败"));
      } catch (e) {
        reject(e);
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(resolve, fallback);
    } else {
      fallback();
    }
  });
}

// ---------------- 工具 ----------------

/** 图片路径 → 可显示的 URL（兼容完整 URL / 站点根绝对路径 / 相对路径） */
function imgUrl(path) {
  if (!path) return "";
  if (Array.isArray(path)) {
    const arr = path.map(imgUrl).filter(Boolean);
    return arr.length ? arr : "";
  }
  if (typeof path !== "string" || !path.trim()) return "";
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  const base = api.baseUrlSync();
  if (path.charAt(0) === "/") return base ? base + path : path;
  if (base) {
    try { return new URL(path, base.replace(/\/+$/, "") + "/").href; } catch {}
  }
  return path;
}

/** 错题卡图片行（缩略 + 点击放大） */
function imgsRow(paths, label) {
  const arr = imgUrl(paths);
  if (!Array.isArray(arr) || !arr.length) return null;
  const wrap = el("div", { class: "mc-imgs" });
  for (const u of arr) {
    wrap.append(el("img", { class: "mc-img", src: u, alt: label || "配图", loading: "lazy",
      onclick: () => viewImage(u) }));
  }
  return wrap;
}

/** 大图查看（内置 modal，客户端无新窗口） */
function viewImage(src) {
  modal({ title: "查看图片", body: el("div", { style: "text-align:center" },
    el("img", { src, style: "max-width:100%;max-height:70vh;border-radius:var(--r-lg)" })),
    actions: [] });
}

function isLeaf(n) { return !n.children || n.children.length === 0; }

function firstLeafId(nodes) {
  for (const n of nodes) {
    if (isLeaf(n)) return n.id;
    if (n.children) {
      const r = firstLeafId(n.children);
      if (r) return r;
    }
  }
  return null;
}

function findNode(id, nodes) {
  nodes = nodes || state.knowledgeTree;
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const r = findNode(id, n.children);
      if (r) return r;
    }
  }
  return null;
}

function walkTree(list, fn) {
  for (const n of list) {
    fn(n);
    if (n.children) walkTree(n.children, fn);
  }
}

function countUnder(node) {
  let total = 0, pending = 0;
  (function walk(n) {
    if (isLeaf(n)) {
      const list = state.mistakes[n.id] || [];
      total += list.length;
      for (const m of list) if (isUrgent(m)) pending++;
    } else if (n.children) {
      n.children.forEach(walk);
    }
  })(node);
  return { total, pending };
}

function isUrgent(m) {
  return m.errorCount >= URGENT_COUNT && daysSince(m.lastErrorDate) <= URGENT_DAYS;
}

function daysSince(dateStr) {
  if (!dateStr) return 9999;
  const d = new Date(dateStr);
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function today() { return new Date().toISOString().slice(0, 10); }

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function persist() {
  // save 接口读 php://input 的 JSON，必须用 postJSON（api.post 是表单编码）
  api.postJSON("backend/api/knowledge_mistakes/index.php?action=save", state)
    .then(() => toastOk("已保存"))
    .catch((e) => toastErr("保存失败：" + e.message));
}

// 简易输入弹窗（modal + field 组合）
function prompt2(title, value, onOk) {
  const f = field(title, value);
  modal({ title, body: el("div", {}, f), actions: [
    { label: "确定", kind: "primary", onClick: async () => { await Promise.resolve(); onOk(f.input.value.trim()); } },
  ] });
  setTimeout(() => f.input.focus(), 60);
}
