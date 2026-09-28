// 移动端（Android 平板）适配帮手：平台判定 + 文件选择
//
// 设计原则：Windows 桌面行为零变化——桌面分支仅返回真实路径（沿用原有
// Tauri dialog + Rust 读盘链路）；Android 上 WebView 无法暴露真实路径
// （系统返回 content:// URI），改用 <input type=file> 直读内存：
//   - b64：配合 api.uploadBytes（服务端只认 multipart 字节，与来源无关）
//   - text：Excel/JSON 等前端解析场景

export function isAndroid() {
  return /android/i.test(navigator.userAgent);
}

function readFileAs(file, mode) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      if (mode === "text") return resolve(String(r.result || ""));
      const s = String(r.result || "");
      resolve(s.includes(",") ? s.slice(s.indexOf(",") + 1) : s); // 剥掉 dataURL 前缀
    };
    r.onerror = () => reject(new Error("读取文件失败"));
    mode === "text" ? r.readAsText(file) : r.readAsDataURL(file);
  });
}

/** 已有的 File 对象（如 <input type=file>.files[0]）→ base64 */
export function fileToB64(file) {
  return readFileAs(file, "b64");
}

/**
 * 选择文件。
 * @param {{multiple?:boolean, accept?:string, read?:"b64"|"text"|"none"}} opts
 *   accept：扩展名列表（逗号分隔，如 "xlsx,json" 或 "image/*"），桌面端映射为 dialog filters
 * @returns {Promise<Array<{path?, name, b64?, text?, mime?}>>}
 *   桌面：[{path, name}]（内容由调用方按原逻辑 api.readFileBase64 等读取）
 *   Android：[{name, b64?/text?, mime}]（内容已读入内存，无 path）
 */
export async function pickFiles(opts = {}) {
  const { multiple = false, accept = "", read = "b64" } = opts;
  if (!isAndroid()) {
    const { open } = window.__TAURI__.dialog;
    const extMap = { "image/*": "png,jpg,jpeg,gif,webp,bmp" };
    const filters = accept
      ? [{
          name: "文件",
          extensions: accept.split(",").map((s) => s.trim())
            .flatMap((a) => (extMap[a] || a.replace(/^\./, "")).split(","))
            .filter(Boolean),
        }]
      : undefined;
    const chosen = await open({ multiple, ...(filters ? { filters } : {}) });
    const arr = chosen ? (Array.isArray(chosen) ? chosen : [chosen]) : [];
    return arr.filter(Boolean).map((p) => ({
      path: p,
      name: String(p).split(/[\\/]/).pop() || "file",
    }));
  }
  // Android：WebView 原生文件选择
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    if (accept) input.accept = accept.split(",").map((s) => s.trim()).join(",");
    input.style.display = "none";
    input.addEventListener("change", async () => {
      const out = [];
      for (const f of input.files || []) {
        const it = { name: f.name || "file", mime: f.type || "" };
        if (read === "b64") it.b64 = await readFileAs(f, "b64");
        else if (read === "text") it.text = await readFileAs(f, "text");
        out.push(it);
      }
      input.remove();
      resolve(out);
    });
    document.body.append(input);
    input.click();
  });
}
