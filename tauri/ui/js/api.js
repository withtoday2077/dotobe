// API 层：所有请求经 Rust 端 api_request 命令（带 Cookie 会话，规避 WebView 跨域）

const { invoke } = window.__TAURI__.core;

// 服务器地址同步缓存（模块加载即取，供图片相对路径解析）
let _baseUrl = "";
try { invoke("get_config").then((c) => { _baseUrl = c.base_url || ""; }).catch(() => {}); } catch {}

// Rust 端 params 是 HashMap<String,String>：统一转字符串，避免数字/布尔导致反序列化失败
function stringifyParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

function parseEnvelope(text) {
  // 后端统一信封 {success, message, data}
  try {
    const v = typeof text === "string" ? JSON.parse(text) : text;
    return v;
  } catch {
    return { success: false, message: "响应解析失败", data: null, raw: text };
  }
}

async function request(path, { method = "GET", params = {}, body = null, json = false, form = false } = {}) {
  let res;
  try {
    res = await invoke("api_request", {
      req: { method, path, params: stringifyParams(params), body: form ? body : body, json: form ? false : json, form },
    });
  } catch (e) {
    // invoke 层失败（参数/命令错误）抛的是字符串，包成带 message 的 Error
    throw new Error(typeof e === "string" ? e : e?.message || "内部调用失败");
  }
  const env = parseEnvelope(res.text);
  if (res.status === 401) {
    const err = new Error(env.message || "请先登录");
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(env.message || `请求失败（HTTP ${res.status}）`);
  }
  if (env.success === false) {
    throw new Error(env.message || "操作失败");
  }
  return env;
}

export const api = {
  get: (path, params = {}) => request(path, { params }),
  post: (path, body = {}, params = {}) => request(path, { method: "POST", params, body }),
  // JSON body（读 php://input 的接口，如交卷 submit.php）
  postJSON: (path, body = {}, params = {}) => request(path, { method: "POST", params, body, json: true }),
  // FormData POST（multipart，如手札发布）
  postForm: (path, formData, params = {}) => request(path, { method: "POST", params, body: formData, form: true }),
  raw: request,

  // 二进制（验证码等）→ data URL
  async dataUrl(path, params = {}) {
    const res = await invoke("fetch_data_url", { path, params });
    if (!res.ok) throw new Error(res.text || `获取失败（HTTP ${res.status}）`);
    return res.text;
  },

  // 读本地文本文件
  readFileText: (path) => invoke("read_file_text", { path }),
  readFileBase64: (path) => invoke("read_file_base64", { path }),

  // 数据存储位置（便携/自定义/默认），set 传 null 恢复默认
  getDataLocation: () => invoke("get_data_location"),
  setDataLocation: (path) => invoke("set_data_location", { path: path ?? null }),

  // 外观插件：主题包（dotobe-theme JSON）
  importTheme: (path) => invoke("import_theme", { path }),
  listThemes: () => invoke("list_themes"),
  deleteTheme: (id) => invoke("delete_theme", { id }),

  // 弹「另存为」对话框，把 base64 内容写入用户选择的位置（Excel 模板/知识树 JSON 导出用）
  exportFile: (defaultName, base64Data, filterName, filterExts) =>
    invoke("export_file", { defaultName, base64Data, filterName, filterExts }),

  // multipart 上传
  async upload(path, fileField, filePath, extra = {}) {
    const res = await invoke("upload_file", { path, fileField, filePath, extra });
    if (!res.ok) throw new Error(parseEnvelope(res.text).message || "上传失败");
    return parseEnvelope(res.text);
  },

  // multipart 上传内存字节（客户端压缩后的图片等），dataBase64 为 base64 内容
  async uploadBytes(path, fileField, fileName, dataBase64, mime = "", extra = {}) {
    const res = await invoke("upload_bytes", { path, fileField, fileName, dataBase64, mime: mime || null, extra });
    if (!res.ok) throw new Error(parseEnvelope(res.text).message || "上传失败");
    return parseEnvelope(res.text);
  },

  // 本地存储命令
  saveCookies: (cookies) => invoke("save_cookies", { cookies }),
  loadCookies: () => invoke("load_cookies"),
  clearCookies: () => invoke("clear_cookies"),
  getConfig: () => invoke("get_config"),
  baseUrlSync: () => _baseUrl,
  setBaseUrl: (baseUrl) => invoke("set_base_url", { baseUrl }),
  saveDraft: (examId, draft) => invoke("save_draft", { examId, draft }),
  loadDraft: (examId) => invoke("load_draft", { examId }),
  clearDraft: (examId) => invoke("clear_draft", { examId }),
  cachePaper: (examId, paper) => invoke("cache_paper", { examId, paper }),
  getCachedPaper: (examId) => invoke("get_cached_paper", { examId }),
  deleteCachedPaper: (examId) => invoke("delete_cached_paper", { examId }),
  listCachedPapers: () => invoke("list_cached_papers"),
  // 刷题进度 / 统计（本地保存）
  savePractice: (examId, progress) => invoke("save_practice", { examId, progress }),
  loadPractice: (examId) => invoke("load_practice", { examId }),
  clearPractice: (examId) => invoke("clear_practice", { examId }),
  recordPractice: (stats) => invoke("record_practice", { stats }),
  loadPracticeStats: () => invoke("load_practice_stats"),
  // 本地通用键值缓存（知识点树离线优先加载）
  saveLocalCache: (key, value) => invoke("save_local_cache", { key, value }),
  loadLocalCache: (key) => invoke("load_local_cache", { key }),
  probeOnline: () => invoke("probe_online"),
  isOffline: () => invoke("is_offline"),

  // 通用信封的 data 提取（data 可能是 {xxx:...} 或数组）
  data(env, key) {
    if (key && env.data && typeof env.data === "object" && !(env.data instanceof Array)) {
      return env.data[key] ?? env.data;
    }
    return env.data;
  },
};

// 会话缓存（当前用户）
export const session = {
  user: null,
  setUser(u) {
    this.user = u;
  },
  /** 当前用户 ID（后端 auth 返回 user_id，个别接口返回 id，两者兼容） */
  id() {
    return this.user?.id ?? this.user?.user_id ?? 0;
  },
  isTeacher() {
    return this.user && ["teacher", "admin", "vip"].includes(this.user.user_type);
  },
  clear() {
    this.user = null;
  },
};
