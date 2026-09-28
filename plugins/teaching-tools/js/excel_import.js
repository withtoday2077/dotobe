// Excel 真题导入：解析 + 模板生成（客户端）
// 逻辑移植自 Web 端 frontend/js/excel-handler.js（2026-09-24 新格式版），依赖全局 XLSX（index.html 已引入 SheetJS）
// 工作簿结构：'试卷信息' 键值表 + 6 个题型工作表（单选/多选/判断/填空/简答/材料分析）
// 材料分析题新格式：主行 col0='材料分析题' 关键词（导入时以此分割下一条材料题），
//   col1=题目内容 col2=答案 col3=分值 col4=解析 col5=图片 col6=材料内容；小题行选项从 col6 起。
// 旧格式（标记行 "材料分析题（见下方小题目）"/早期 col4 材料/历史 col5 错位）仍兼容。

const SHEET_TYPES = {
  "单选题": "single_choice",
  "多选题": "multiple_choice",
  "判断题": "true_false",
  "填空题": "fill_blank",
  "简答题": "short_answer",
  "材料分析题": "material_analysis",
};

export const TYPE_CHINESE = {
  single_choice: "单选题",
  multiple_choice: "多选题",
  true_false: "判断题",
  fill_blank: "填空题",
  short_answer: "简答题",
  material_analysis: "材料分析题",
};

const LETTERS = Array.from({ length: 15 }, (_, i) => String.fromCharCode(65 + i)); // A-O

function safeTrim(v) { return v == null ? "" : String(v).trim(); }
function safeString(v) { return v == null ? "" : String(v); }
function isQuestionType(text) { return Object.prototype.hasOwnProperty.call(SHEET_TYPES, text); }
function getTypeFromChinese(text) { return SHEET_TYPES[text] || "short_answer"; }
function getSheetType(sheetName) { return SHEET_TYPES[sheetName] || ""; }

/** 解析'试卷信息'工作表（跳过表头行，键→值） */
export function parseExamInfo(sheet) {
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const info = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const key = safeTrim(row[0]);
    if (!key) continue;
    const value = safeTrim(row[1]);
    switch (key) {
      case "试卷标题": info.title = value; break;
      case "科目": info.subject = value; break;
      case "年级": info.grade = value; break;
      case "试卷类型": info.type = value; break;
      case "难度": info.difficulty = value; break;
      case "考试时长(分钟)": info.time_limit = parseInt(value, 10) || 0; break;
      case "及格分数": info.passing_score = parseInt(value, 10) || 60; break;
      case "试卷描述": info.description = value; break;
      case "标签": info.tags = value; break;
    }
  }
  return info;
}

/**
 * 答案规范化：编辑器/落库的 canonical 格式为逗号分隔字母（多选 "A,B,D"）。
 * Excel 模板中多选题答案常写作 "ABDE"（无分隔），统一转为逗号分隔；
 * 兼容 "A、B"、"A B"、"a,b" 等变体；单选/判断题原样返回。
 */
export function normalizeAnswer(questionType, answer) {
  const raw = safeString(answer).trim();
  if (questionType !== "multiple_choice") return raw;
  const letters = raw.toUpperCase().match(/[A-O]/g) || [];
  return [...new Set(letters)].sort().join(",");
}

function parseChoiceOptions(row, startIndex) {
  const options = [];
  const maxOptions = 15;
  for (let j = 0; j < maxOptions; j++) {
    const content = safeString(row[startIndex + j * 2]);
    // 图片列忽略，导入后手动上传
    if (content && content.trim()) options.push({ text: content, image: "" });
  }
  return options;
}

/** 解析单个题型工作表（material_analysis 含子小题解析），返回题目数组 */
export function parseQuestions(sheet, questionType) {
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const questions = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!safeString(row[0])) continue; // 跳过空行/表头

    const question = {
      type: questionType,
      content: safeString(row[0]),
      answer: normalizeAnswer(questionType, safeString(row[1])),
      score: parseFloat(row[2]) || 5,
      explanation: safeString(row[3]),
      options: [],
      image: "",
    };

    if (["single_choice", "multiple_choice", "true_false"].includes(questionType)) {
      // 选项从第 5 列起，每项两列：内容 + 图片
      question.options = parseChoiceOptions(row, 5);
      if (questionType === "true_false") {
        // 判断题固定两个选项
        if (question.options.length === 0) {
          question.options = [{ text: "正确", image: "" }, { text: "错误", image: "" }];
        }
      } else if (question.options.length === 0) {
        // 无选项时补 4 个空选项（与 Web 端一致）
        for (let j = 0; j < 4; j++) question.options.push({ text: "", image: "" });
      }
    } else if (questionType === "material_analysis") {
      // 材料主行（新格式）：col0='材料分析题'，col1=题目内容 col2=答案 col3=分值 col4=解析 col5=图片 col6=材料内容
      // 小题目行：col0=小题题型 col1=内容 col2=答案 col3=分值 col4=解析 col5=图片，选项从 col6 起
      const typeCell = safeString(row[0]);

      if (typeCell === "材料分析题") {
        // 新格式：答案/分值/解析在正确列上（通用读取把 A 列当题目内容，此处覆盖）
        question.answer = normalizeAnswer(questionType, safeString(row[2]));
        question.score = parseFloat(row[3]) || question.score;
        question.explanation = safeString(row[4]);
        // 材料内容优先取"材料内容"列，兜底"题目内容"列
        const material = safeString(row[6]) || safeString(row[1]);
        question.material_text = material;
        // 材料分析题的题目内容即材料内容（落库字段为 content）
        question.content = material;
      } else {
        // 旧格式：A 列是题目内容/材料本身（含"材料分析题（见下方小题目）"标记行），
        // 材料 内容在第 4 列（早期模板）、第 5 列（历史导出错位）或第 6 列（按表头手工填写）
        let material = safeString(row[4]);
        if (!material || material === "[图片]") material = safeString(row[5]);
        if (!material) material = safeString(row[6]);
        question.material_text = material || question.content;
        question.content = question.material_text;
      }

      // 解析子小题：从后续行提取，直到遇到下一条材料（A 列含"材料分析题"）或新的主题目行
      question.sub_questions = [];
      let nextRow = i + 1;
      while (nextRow < data.length) {
        const nr = data[nextRow];
        const firstCell = safeString(nr[0]);

        // A 列出现"材料分析题"关键词：下一条材料分析题开始
        if (firstCell && firstCell.includes("材料分析题")) break;
        // 新的主题目行（第一列不为空且不是题型名称）
        if (firstCell && !isQuestionType(firstCell)) break;

        if (firstCell) {
          let subType = "short_answer";
          let subContent, subAnswer, subScore, subExplanation;
          let optionStartCol;

          if (isQuestionType(firstCell)) {
            // 新格式：第0列=题型 col1=内容 col2=答案 col3=分值 col4=解析，选项从 col6 起
            subType = getTypeFromChinese(firstCell);
            subContent = safeString(nr[1]);
            subAnswer = safeString(nr[2]);
            subScore = parseFloat(nr[3]) || 5;
            subExplanation = safeString(nr[4]);
            optionStartCol = 6;
            // 兼容旧版客户端模板：小题行 col5/col6 为空而 col7 有选项内容（旧版选项从 col7 起）
            if (["single_choice", "multiple_choice", "true_false"].includes(subType)) {
              const c6 = safeString(nr[6]);
              const c7 = safeString(nr[7]);
              if (!c6 && c7 && c7 !== "[图片]") optionStartCol = 7;
            }
          } else {
            // 旧格式：col0=内容 col1=答案 col2=分值 col3=解析，选项从 col5 起
            subContent = firstCell;
            subAnswer = safeString(nr[1]);
            subScore = parseFloat(nr[2]) || 5;
            subExplanation = safeString(nr[3]);
            optionStartCol = 5;
            // 依据选项/答案推断题型（向后兼容）
            const optionA = safeString(nr[5]);
            const optionB = safeString(nr[7]);
            if (optionA || optionB) {
              if (optionA.includes("正确") || optionA.includes("错误")) subType = "true_false";
              else if (subAnswer && subAnswer.length > 1 && subAnswer.includes(",")) subType = "multiple_choice";
              else subType = "single_choice";
            }
          }

          const subQuestion = {
            type: subType,
            content: subContent,
            answer: normalizeAnswer(subType, subAnswer),
            score: subScore,
            explanation: subExplanation,
            options: [],
          };
          if (["single_choice", "multiple_choice", "true_false"].includes(subType)) {
            subQuestion.options = parseChoiceOptions(nr, optionStartCol);
            if (subType === "true_false" && subQuestion.options.length === 0) {
              subQuestion.options = [{ text: "正确", image: "" }, { text: "错误", image: "" }];
            }
          }
          question.sub_questions.push(subQuestion);
          i++; // 跳过已处理的小题目行
        }
        nextRow++;
      }

      if (question.sub_questions.length === 0) {
        question.sub_questions = [{
          type: "short_answer",
          content: "请根据材料内容回答问题",
          answer: "",
          score: 10,
          explanation: "",
          options: [],
        }];
      }
    }

    questions.push(question);
  }

  return questions;
}

/** 解析整个工作簿：返回 { exam, questions }（按固定题型工作表顺序） */
export function parseWorkbook(workbook) {
  const exam = workbook.Sheets["试卷信息"] ? parseExamInfo(workbook.Sheets["试卷信息"]) : {};
  const questions = [];
  const order = ["单选题", "多选题", "判断题", "填空题", "简答题", "材料分析题"];
  for (const name of order) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const type = getSheetType(name);
    questions.push(...parseQuestions(sheet, type));
  }
  return { exam, questions };
}

/** 合计分值（材料分析题取子小题总分） */
export function computeTotalScore(questions) {
  return questions.reduce((sum, q) => {
    if (q.type === "material_analysis" && Array.isArray(q.sub_questions) && q.sub_questions.length) {
      return sum + q.sub_questions.reduce((a, sq) => a + (Number(sq.score) || 0), 0);
    }
    return sum + (Number(q.score) || 0);
  }, 0);
}

// ---------- 模板生成（列格式与解析口径互为镜像） ----------

function examInfoRows(exam) {
  return [
    ["项目", "值"],
    ["试卷标题", exam.title || ""],
    ["科目", exam.subject || ""],
    ["年级", exam.grade || ""],
    ["试卷类型", exam.type || ""],
    ["难度", exam.difficulty || ""],
    ["考试时长(分钟)", exam.time_limit || ""],
    ["及格分数", exam.passing_score || 60],
    ["试卷描述", exam.description || ""],
    ["标签", exam.tags || ""],
  ];
}

function createChoiceSheet(questions, questionType) {
  const rows = [];
  const isChoice = ["single_choice", "multiple_choice", "true_false"].includes(questionType);
  let optionCols = 0; // 表头选项列数（用于补齐空列对齐）

  if (isChoice) {
    let maxOptions = questionType === "true_false" ? 2 : 4;
    questions.forEach((q) => {
      if (Array.isArray(q.options) && q.options.length > maxOptions) maxOptions = q.options.length;
    });
    optionCols = Math.max(1, Math.min(15, maxOptions));
    const headers = ["题目内容", "参考答案", "分值", "解析", "题目图片"];
    for (let i = 0; i < optionCols; i++) {
      headers.push(`选项${LETTERS[i]}内容`, `选项${LETTERS[i]}图片`);
    }
    rows.push(headers);
  } else {
    rows.push(["题目内容", "参考答案", "分值", "解析", "题目图片"]);
  }

  questions.forEach((q) => {
    const row = [q.content || "", q.answer || "", q.score || 5, q.explanation || "", q.image ? "[图片]" : ""];
    if (isChoice) {
      const opts = Array.isArray(q.options) && q.options.length
        ? q.options
        : (questionType === "true_false" ? [{ text: "正确" }, { text: "错误" }] : []);
      const shown = opts.slice(0, 15);
      shown.forEach((o) => {
        row.push(o.text || "");
        row.push(o.image ? "[图片]" : "");
      });
      for (let i = shown.length; i < optionCols; i++) row.push("", "");
    }
    rows.push(row);
  });

  return XLSX.utils.aoa_to_sheet(rows);
}

function createMaterialSheet(questions) {
  const headers = ["题型", "题目内容", "参考答案", "分值", "解析", "题目图片", "材料内容"];
  for (let i = 0; i < 15; i++) headers.push(`选项${LETTERS[i]}内容`, `选项${LETTERS[i]}图片`);
  const rows = [headers];

  questions.forEach((q) => {
    // 材料主行：col0='材料分析题' 关键词（导入时以它分隔多条材料分析题），材料内容在最后一列
    const subTotalScore = (Array.isArray(q.sub_questions) ? q.sub_questions : [])
      .reduce((sum, sq) => sum + (parseFloat(sq.score) || 0), 0);
    rows.push([
      "材料分析题",
      "", // 材料题无独立题干，材料内容在最后一列
      q.answer || "",
      q.score || subTotalScore || 0,
      q.explanation || "",
      q.image ? "[图片]" : "",
      q.material_text || q.content || "",
    ]);
    (Array.isArray(q.sub_questions) ? q.sub_questions : []).forEach((sq) => {
      // 小题行：col0=题型 col1=内容 col2=答案 col3=分值 col4=解析 col5=图片，选项从 col6 起
      const subRow = [
        TYPE_CHINESE[sq.type] || "简答题",
        sq.content || "",
        sq.answer || "",
        sq.score || 5,
        sq.explanation || "",
        "",
      ];
      if (["single_choice", "multiple_choice", "true_false"].includes(sq.type)) {
        const opts = Array.isArray(sq.options) ? sq.options.slice(0, 15) : [];
        if (opts.length) {
          opts.forEach((o) => {
            subRow.push(o.text || "");
            subRow.push(o.image ? "[图片]" : "");
          });
        } else if (sq.type === "true_false") {
          subRow.push("正确", "", "错误", "");
        } else {
          for (let i = 0; i < 4; i++) subRow.push("", "");
        }
      }
      rows.push(subRow);
    });
  });

  return XLSX.utils.aoa_to_sheet(rows);
}

function groupByType(questions) {
  const grouped = {
    single_choice: [], multiple_choice: [], true_false: [],
    fill_blank: [], short_answer: [], material_analysis: [],
  };
  questions.forEach((q) => { if (grouped[q.type]) grouped[q.type].push(q); });
  return grouped;
}

const TEMPLATE_DATA = {
  exam: {
    title: "示例试卷",
    subject: "数学",
    grade: "一年级",
    type: "期末考试",
    difficulty: "medium",
    time_limit: 60,
    passing_score: 60,
    description: "这是一个示例试卷，包含所有题型示例，支持最多15个选项（A-O）",
    tags: "示例,测试,完整模板",
  },
  questions: [
    { type: "single_choice", content: "1 + 1 = ?", answer: "A", score: 5,
      explanation: "基础加法运算",
      options: [{ text: "2" }, { text: "3" }, { text: "4" }, { text: "5" }] },
    { type: "multiple_choice", content: "以下哪些是偶数？（多选）", answer: "ABDE", score: 8,
      explanation: "2、4、6、8、10都是偶数",
      options: [{ text: "2" }, { text: "4" }, { text: "6" }, { text: "7" }, { text: "8" }] },
    { type: "true_false", content: "地球是圆的", answer: "正确", score: 3,
      explanation: "地球是一个近似的球体",
      options: [{ text: "正确" }, { text: "错误" }] },
    { type: "fill_blank", content: "____是中国的首都", answer: "北京", score: 5,
      explanation: "中国的首都是北京" },
    { type: "fill_blank", content: "一年有____个月", answer: "12", score: 5,
      explanation: "一年有12个月" },
    { type: "short_answer", content: "请简述什么是光合作用？",
      answer: "光合作用是绿色植物利用光能，将二氧化碳和水转化为有机物，并释放氧气的过程",
      score: 10,
      explanation: "光合作用是植物的基本生理过程，对地球生态系统至关重要" },
    { type: "material_analysis", content: "请根据以下材料回答问题", answer: "见子问题", score: 31,
      explanation: "材料分析题可以包含多种题型的小题目，需要结合材料内容进行综合分析",
      material_text: "随着互联网技术的发展，网络已经成为人们日常生活中不可或缺的一部分。人们可以通过网络获取信息、交流沟通、娱乐购物等。但同时，网络也带来了一些问题，如信息过载、隐私泄露、网络成瘾等。如何合理使用网络，成为现代社会需要思考的重要问题。教育部门建议：学生每天上网时间不超过2小时，要合理安排时间，保护个人隐私，辨别信息真伪，避免沉迷网络，充分利用网络资源提升自己。",
      sub_questions: [
        { type: "single_choice", content: "(1) 以下哪项不是网络带来的便利？", answer: "B",
          score: 5, explanation: "网络成瘾是网络带来的问题，不是便利",
          options: [{ text: "获取信息" }, { text: "网络成瘾" }, { text: "交流沟通" }, { text: "娱乐购物" }] },
        { type: "multiple_choice", content: "(2) 以下哪些是网络带来的好处？（多选）", answer: "ACE",
          score: 8, explanation: "获取信息、交流沟通、娱乐购物都是网络的好处",
          options: [{ text: "获取信息" }, { text: "隐私泄露" }, { text: "交流沟通" }, { text: "网络成瘾" }, { text: "娱乐购物" }] },
        { type: "true_false", content: "(3) 教育部门建议学生每天上网时间不超过2小时。",
          answer: "正确", score: 3, explanation: "根据材料，教育部门确实建议学生每天上网时间不超过2小时",
          options: [{ text: "正确" }, { text: "错误" }] },
        { type: "fill_blank", content: "(4) 要保护好个人____，避免在网络上随意泄露。",
          answer: "隐私", score: 5, explanation: "材料中提到要保护个人隐私" },
        { type: "short_answer", content: "(5) 结合材料，你认为应该如何合理使用网络？（至少回答两点）",
          answer: "1.合理安排上网时间，不超过2小时；2.保护个人隐私；3.辨别信息真伪；4.避免沉迷网络；5.充分利用网络资源",
          score: 10, explanation: "开放性答案，言之有理即可" },
      ] },
  ],
};

/** 构建一个完整示例工作簿（Excel 导入模板） */
export function buildTemplateWorkbook() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(examInfoRows(TEMPLATE_DATA.exam)), "试卷信息");
  const grouped = groupByType(TEMPLATE_DATA.questions);
  for (const [type, qs] of Object.entries(grouped)) {
    if (!qs.length) continue;
    const sheetName = TYPE_CHINESE[type] || "题目";
    const sheet = type === "material_analysis" ? createMaterialSheet(qs) : createChoiceSheet(qs, type);
    XLSX.utils.book_append_sheet(wb, sheet, sheetName);
  }
  return wb;
}

/** 工作簿 → base64（供 export_file 写文件） */
export function workbookToBase64(workbook) {
  return XLSX.write(workbook, { bookType: "xlsx", type: "base64" });
}
