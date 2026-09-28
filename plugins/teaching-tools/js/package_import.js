// 试卷包（.zip）导入：exam.json（试卷文字信息）+ images/（包内图片）
// 逻辑对齐 Web 端 frontend/js/package-io.js 的严格报错策略：
//   包损坏 / exam.json 缺失或非法 / 图片缺失·过大·上传被拒 —— 一律整体中止并抛出明确错误。
// 与 Web 的差异：客户端无编辑器，校验通过后直接走 backend/api/excel_import.php 建卷；
//   图片经 api.uploadBytes（Rust multipart）传 backend/api/upload_image.php（与 Web 同字段名 image）。

import { api } from "api";

const EXAM_JSON_PATH = "exam.json";
const IMAGE_DIR_PREFIX = "images/";
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 与 backend/functions/image_helper.php 的 MAX_FILE_SIZE 一致

const MIME_BY_EXT = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
};

function pathOf(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry.path === "string") return entry.path;
  return "";
}

function isPackageImagePath(p) {
  return typeof p === "string" && p.startsWith(IMAGE_DIR_PREFIX);
}

/** 遍历题目数组全部图片字段（image/images[]/optionImages[]/options[].image/sub_questions[].options[].image），去重保序 */
export function collectImagePaths(questions, predicate) {
  const paths = [];
  const seen = new Set();
  const push = (entry) => {
    const p = pathOf(entry);
    if (p && predicate(p) && !seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  };
  (questions || []).forEach((q) => {
    if (!q) return;
    push(q.image);
    (Array.isArray(q.images) ? q.images : []).forEach(push);
    (Array.isArray(q.optionImages) ? q.optionImages : []).forEach(push);
    (Array.isArray(q.options) ? q.options : []).forEach((opt) => push(opt && opt.image));
    (Array.isArray(q.sub_questions) ? q.sub_questions : []).forEach((sq) => {
      (sq && Array.isArray(sq.options) ? sq.options : []).forEach((opt) => push(opt && opt.image));
    });
  });
  return paths;
}

/** 按 map{旧路径→新路径} 深拷贝改写题目数组全部图片字段，map 中不存在的路径原样保留 */
export function rewriteImagePaths(questions, map) {
  const rw = (entry) => {
    const p = pathOf(entry);
    if (!p) return entry;
    const np = map[p];
    if (!np) return entry;
    if (typeof entry === "string") return np;
    return { ...entry, path: np };
  };
  return (questions || []).map((q) => {
    const nq = { ...q };
    if (nq.image) nq.image = rw(nq.image);
    if (Array.isArray(nq.images)) nq.images = nq.images.map(rw);
    if (Array.isArray(nq.optionImages)) nq.optionImages = nq.optionImages.map(rw);
    if (Array.isArray(nq.options)) {
      nq.options = nq.options.map((opt) => (opt ? { ...opt, image: rw(opt.image) } : opt));
    }
    if (Array.isArray(nq.sub_questions)) {
      nq.sub_questions = nq.sub_questions.map((sq) => {
        if (!sq) return sq;
        const nsq = { ...sq };
        if (Array.isArray(nsq.options)) {
          nsq.options = nsq.options.map((opt) => (opt ? { ...opt, image: rw(opt.image) } : opt));
        }
        return nsq;
      });
    }
    return nq;
  });
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** 合计分值（材料分析题取子小题总分），与 excel_import.js 的 computeTotalScore 同口径 */
function computeTotal(questions) {
  return (questions || []).reduce((sum, q) => {
    if (q && q.type === "material_analysis" && Array.isArray(q.sub_questions) && q.sub_questions.length) {
      return sum + q.sub_questions.reduce((a, sq) => a + (Number(sq && sq.score) || 0), 0);
    }
    return sum + (Number(q && q.score) || 0);
  }, 0);
}

/**
 * 从 base64 内容导入试卷包并直接创建试卷。
 * onProgress(current, total, name) 用于进度展示。
 * 返回 { examId, title, count, images }。
 */
export async function importPackageFromBase64(b64, onProgress) {
  // 1. 解包（非 zip / 损坏 → 报错）
  let zip;
  try {
    zip = await JSZip.loadAsync(b64ToBytes(b64));
  } catch (e) {
    throw new Error("数据包损坏或不是有效的试卷包（.zip）");
  }

  // 2. exam.json 校验
  const examFile = zip.file(EXAM_JSON_PATH);
  if (!examFile) throw new Error("包内缺少 exam.json，不是有效的试卷包");
  let json;
  try {
    json = JSON.parse(await examFile.async("string"));
  } catch (e) {
    throw new Error("exam.json 内容不是合法 JSON");
  }
  if (!json.questions || !Array.isArray(json.questions) || !json.questions.length) {
    throw new Error("exam.json 缺少 questions 数组");
  }

  // 3. 图片预检：包内引用的图片必须存在且不超过大小上限
  const refs = collectImagePaths(json.questions, isPackageImagePath);
  const imageB64 = {}; // 包内路径 → base64
  for (const ref of refs) {
    const entry = zip.file(ref);
    if (!entry) throw new Error(`包内缺少图片文件：${ref}`);
    const b = await entry.async("base64");
    if (b.length * 0.75 > MAX_IMAGE_SIZE) {
      throw new Error(`图片过大：${ref}（上限 5MB）`);
    }
    imageB64[ref] = b;
  }

  // 4. 逐张上传（服务端做白名单/真实 MIME/压缩校验，拒绝即整体中止）
  const serverPaths = {}; // 包内路径 → 服务器新路径
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    const name = ref.split("/").pop() || "image.jpg";
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (onProgress) onProgress(i + 1, refs.length, name);
    const env = await api.uploadBytes(
      "backend/api/upload_image.php", "image", name, imageB64[ref], MIME_BY_EXT[ext] || "image/jpeg");
    if (!env || env.success !== true || !env.data || !env.data.image_path) {
      throw new Error(`图片上传失败：${name}（${(env && env.message) || "服务端拒绝"}）`);
    }
    serverPaths[ref] = env.data.image_path;
  }

  // 5. 全部成功：改写路径并建卷
  const questions = rewriteImagePaths(json.questions, serverPaths);
  const total = computeTotal(questions);
  const examData = {
    title: json.title || "导入试卷",
    description: json.description || "",
    subject: json.subject || "",
    grade: json.grade || "other",
    type: json.type || "exam",
    difficulty: json.difficulty || "medium",
    total_score: Number.isFinite(Number(json.total_score)) && Number(json.total_score) > 0
      ? Number(json.total_score) : total,
    time_limit: Number(json.time_limit) || 60,
    passing_score: Number(json.passing_score) || Math.ceil((total || 100) * 0.6),
    tags: json.tags || "",
    questions,
  };
  const env = await api.postJSON("backend/api/excel_import.php", { exam_data: examData, images: [] });
  return {
    examId: env.data && env.data.exam_id,
    title: examData.title,
    count: questions.length,
    images: refs.length,
  };
}
