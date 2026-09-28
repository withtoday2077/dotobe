// km_markdown.js — 轻量 Markdown 渲染器（移植自 web 端 km-markdown.js，ESM 化）
// 安全模型：用户输入全文先 HTML 转义，标签只由本解析器生成；链接/图片协议白名单。
// 相对路径（../uploads/...、uploads/...）经 resolveUrl 解析为站点绝对 URL 再输出。
// 公式：$...$ / $$...$$（页面已引入 KaTeX 时渲染，否则降级原始文本）。

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 相对/站点根路径 → 绝对 URL；http(s)/data/blob 原样返回；其余返回 null（拒绝输出） */
export function resolveAssetUrl(u, baseUrl) {
  const raw = String(u || "").trim();
  if (!raw) return null;
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw;
  if (raw.charAt(0) === "#") return null; // 锚点非资源
  // 归一化：剥掉开头的 ../ 或 ./，相对站点根解析
  const rel = raw.replace(/^(\.\.\/|\.\/)+/, "").replace(/^\/+/, "");
  if (!rel) return null;
  if (/\s|["'<>()]/.test(rel)) return null;
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return base ? `${base}/${rel}` : `/${rel}`;
}

/* ---------- LaTeX 公式预提取（公式不参与 Markdown/转义） ---------- */
function extractMath(src) {
  const math = [];
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src.charAt(i) === "`" && src.substr(i, 3) === "```") {
      let fenceEnd = src.indexOf("```", i + 3);
      fenceEnd = fenceEnd === -1 ? n : fenceEnd + 3;
      out += src.slice(i, fenceEnd);
      i = fenceEnd;
      continue;
    }
    if (src.charAt(i) === "`") {
      const tickEnd = src.indexOf("`", i + 1);
      if (tickEnd === -1) { out += src.charAt(i); i++; continue; }
      out += src.slice(i, tickEnd + 1);
      i = tickEnd + 1;
      continue;
    }
    if (src.charAt(i) === "$" && src.charAt(i + 1) === "$") {
      const dd = src.indexOf("$$", i + 2);
      if (dd !== -1) {
        const dl = src.slice(i + 2, dd).trim();
        if (dl) {
          out += `\u0002${math.length}\u0002`;
          math.push({ latex: dl, display: true });
          i = dd + 2;
          continue;
        }
      }
      out += "$$"; i += 2;
      continue;
    }
    if (src.charAt(i) === "$" && i + 1 < n && !/\s/.test(src.charAt(i + 1))) {
      let j = i + 1;
      let hit = -1;
      while (j < n) {
        if (src.charAt(j) === "$") {
          const prev = src.charAt(j - 1);
          if (prev !== " " && prev !== "\t" && prev !== "\n" && prev !== "\\" &&
              !/\d/.test(src.charAt(j + 1) || "")) { hit = j; break; }
        }
        if (src.charAt(j) === "\n") break;
        j++;
      }
      if (hit !== -1) {
        out += `\u0002${math.length}\u0002`;
        math.push({ latex: src.slice(i + 1, hit), display: false });
        i = hit + 1;
        continue;
      }
    }
    if (src.charAt(i) === "\\" && src.charAt(i + 1) === "$") {
      out += "\u0003"; i += 2;
      continue;
    }
    out += src.charAt(i); i++;
  }
  return { text: out, math };
}

function renderMathHTML(list) {
  const k = typeof window !== "undefined" ? window.katex : null;
  const ok = k && typeof k.renderToString === "function";
  return list.map((m) => {
    if (!ok) return `<code class="km-md-math-raw">${escapeHtml(m.latex)}</code>`;
    try {
      return k.renderToString(m.latex, { displayMode: m.display, throwOnError: false, strict: false });
    } catch {
      return `<code class="km-md-math-raw">${escapeHtml(m.latex)}</code>`;
    }
  });
}

/* 行内渲染：入参必须是「已转义」的文本；imgAbs 用于图片/链接 URL 解析 */
function inline(text, imgAbs) {
  // 1) 行内代码先行，占位保护
  const codes = [];
  text = text.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(`<code class="km-md-code">${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // 2) 图片 ![alt](url)：先于链接；解析为绝对 URL，解析失败原样保留文本
  text = text.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (all, alt, u) => {
    const abs = imgAbs(u);
    if (!abs) return all;
    return `<img class="km-md-img" src="${abs}" alt="${alt}" loading="lazy">`;
  });
  // 3) 链接 [text](url)
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (all, t, u) => {
    if (!/^(https?:\/\/|\/|#)/i.test(u)) return all;
    return `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`;
  });
  // 4) 加粗 → 删除线 → 斜体
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  text = text.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  // 5) 还原行内代码
  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
  return text;
}

function isBlockLine(l) {
  return /^```/.test(l) || /^#{1,6}\s/.test(l) ||
    /^\s*>\s?/.test(l) || /^\s*[-*]\s+/.test(l) ||
    /^\s*\d+[.)]\s+/.test(l) || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l) ||
    /^\s*\|.+\|\s*$/.test(l);
}

/* ---------- 表格（GFM）：整行竖线包裹 + 下一行为 --- 分隔行 ---------- */
function splitRow(l) {
  let s = l.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isSepRow(l) {
  const cells = splitRow(l);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function alignOf(sepCell) {
  const c = String(sepCell || "").trim();
  if (c.startsWith(":") && c.endsWith(":")) return "center";
  if (c.endsWith(":")) return "right";
  return "";
}

function parse(src, imgAbs) {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length) i++;
      out.push(`<pre class="km-md-pre"><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(escapeHtml(h[2]), imgAbs)}</h${lv}>`);
      i++; continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++; continue;
    }

    // 表格：当前行含 | 且下一行为分隔行
    if (line.includes("|") && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|") && !/^```/.test(lines[i])) {
        rows.push(splitRow(lines[i])); i++;
      }
      const cellAttr = (k) => aligns[k] ? ` style="text-align:${aligns[k]}"` : "";
      const th = head.map((c, k) => `<th${cellAttr(k)}>${inline(escapeHtml(c), imgAbs)}</th>`).join("");
      const tb = rows.map((r) =>
        `<tr>${head.map((_, k) => `<td${cellAttr(k)}>${inline(escapeHtml(r[k] ?? ""), imgAbs)}</td>`).join("")}</tr>`
      ).join("");
      out.push(`<div class="km-md-twrap"><table class="km-md-table"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inline(escapeHtml(q.join("\n")), imgAbs).replace(/\n/g, "<br>")}</blockquote>`);
      continue;
    }

    const ulm = line.match(/^\s*[-*]\s+(.*)$/);
    const olm = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ulm || olm) {
      const isOl = !!olm;
      const re = isOl ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*]\s+(.*)$/;
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(re);
        if (!m) break;
        items.push(`<li>${inline(escapeHtml(m[1]), imgAbs)}</li>`);
        i++;
      }
      out.push(isOl ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }

    // 独立成行的图片：单独输出（居中块）
    const solo = line.trim().match(/^!\[([^\]\n]*)\]\(([^)\s]+)\)$/);
    if (solo) {
      const abs = imgAbs(solo[2]);
      out.push(abs
        ? `<p class="km-md-imgrow"><img class="km-md-img" src="${abs}" alt="${escapeHtml(solo[1])}" loading="lazy"></p>`
        : `<p>${inline(escapeHtml(line), imgAbs)}</p>`);
      i++; continue;
    }

    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockLine(lines[i])) {
      para.push(lines[i]); i++;
    }
    out.push(`<p>${inline(escapeHtml(para.join("\n")), imgAbs).replace(/\n/g, "<br>")}</p>`);
  }
  return out.join("");
}

/**
 * Markdown → 安全 HTML。
 * @param {string} src 原文
 * @param {object} opts { baseUrl } 相对资源（../uploads/... 等）解析基准（站点根）
 */
export function kmMarkdown(src, opts = {}) {
  if (src == null || !String(src).trim()) return "";
  const baseUrl = opts.baseUrl || "";
  const imgAbs = (u) => {
    if (/^(https?:\/\/|\/|#)/i.test(u)) {
      // / 开头的站点根路径补 baseUrl（客户端 file 协议下 / 相对无效）
      if (u.charAt(0) === "/" && baseUrl) return baseUrl + u;
      return u;
    }
    return resolveAssetUrl(u, baseUrl);
  };
  const ex = extractMath(String(src));
  const html = parse(ex.text, imgAbs);
  let result = html;
  if (ex.math.length) {
    const rendered = renderMathHTML(ex.math);
    result = result.replace(/\u0002(\d+)\u0002/g, (_, i) => rendered[+i]);
  }
  return result.replace(/\u0003/g, "$");
}

/** 从 Markdown 原文中剥掉图片语法（列表摘要用），保留 alt 文本 */
export function stripImages(md) {
  return String(md || "").replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, "$1").trim();
}

/** 提取第一张图片的 URL（原文，未解析），无则 null */
export function firstImage(md) {
  const m = String(md || "").match(/!\[[^\]\n]*\]\(([^)\s]+)\)/);
  return m ? m[1] : null;
}
