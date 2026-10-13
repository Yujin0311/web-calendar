"use strict";

// 本模块只负责向 DeepSeek 发出一次视觉请求并校验返回 JSON，不接触数据库。
const OpenAI = require("openai");

const SYSTEM_PROMPT = `你是大学课表提取助手。识别周课表图片，提取全部课程。
只输出合法JSON，禁止任何多余文字、解释、markdown代码块。
输出结构：
{
  "courses": [
    {
      "courseName": "",
      "weekday": "",
      "sectionStart": 0,
      "sectionEnd": 0,
      "teacher": "",
      "location": "",
      "weekRange": ""
    }
  ],
  "isValid": true
}

规则：
1. weekday只能填写：星期一、星期二、星期三、星期四、星期五、星期六、星期日
2. sectionStart、sectionEnd填写数字，跨多节课就填起止节次
3. 识别不到的字段，字符串填空""，数字填0，禁止写null
4. 模糊看不清不要编造，填空即可
5. 图片不是课表，courses为空数组，isValid=false
6. 只输出JSON本体`;

const IMAGE_PATTERN = /^data:image\/(jpeg|png|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const expectedKeys = ["courses", "isValid"];
const courseKeys = ["courseName", "location", "sectionEnd", "sectionStart", "teacher", "weekRange", "weekday"];
const weekdays = new Set(["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateImage(dataUrl) {
  if (typeof dataUrl !== "string") throw codedError("INVALID_IMAGE", "请选择图片后再解析。");
  const match = IMAGE_PATTERN.exec(dataUrl);
  if (!match) throw codedError("INVALID_IMAGE", "仅支持 JPG、PNG、GIF 或 WebP 图片。");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw codedError("INVALID_IMAGE", "图片须小于 6 MB，请压缩后重试。");
  const format = match[1].toLowerCase();
  const valid = (format === "jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (format === "png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (format === "gif" && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) ||
    (format === "webp" && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP");
  if (!valid) throw codedError("INVALID_IMAGE", "图片内容与格式不符，请换一张图片重试。");
}

function validateSchedule(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(expectedKeys) || typeof data.isValid !== "boolean" || !Array.isArray(data.courses) || data.courses.length > 100) {
    throw codedError("PARSE_FAILED", `AI JSON 顶层结构不符合 courses/isValid 格式（实际字段：${data && typeof data === "object" ? Object.keys(data).join(", ").slice(0, 100) : typeof data}）。`);
  }
  if (!data.isValid) {
    if (data.courses.length) throw codedError("PARSE_FAILED", "AI JSON 的 isValid=false，但 courses 并非空数组。");
    return data;
  }
  // 模型偶尔会把示例中的节次数字加上引号；转换为统一的数字结构。
  for (const course of data.courses) {
    if (!course || typeof course !== "object" || Array.isArray(course)) continue;
    for (const key of ["sectionStart", "sectionEnd"]) {
      if (typeof course[key] === "string" && /^\d{1,2}$/.test(course[key])) course[key] = Number(course[key]);
    }
  }
  if (!data.courses.length) throw codedError("PARSE_FAILED", "AI JSON 标记 isValid=true，但 courses 为空数组。");
  for (const [index, course] of data.courses.entries()) {
    if (!course || typeof course !== "object" || Array.isArray(course) || JSON.stringify(Object.keys(course).sort()) !== JSON.stringify(courseKeys)) {
      throw codedError("PARSE_FAILED", `AI JSON 第 ${index + 1} 门课程字段不符合约定。`);
    }
    const invalidText = ["courseName", "weekday", "teacher", "location", "weekRange"].find((key) => typeof course[key] !== "string" || course[key].length > 200);
    if (invalidText) throw codedError("PARSE_FAILED", `AI JSON 第 ${index + 1} 门课程的 ${invalidText} 字段类型或长度不正确。`);
    if (course.weekday && !weekdays.has(course.weekday)) throw codedError("PARSE_FAILED", `AI JSON 第 ${index + 1} 门课程的 weekday 不是星期一至星期日。`);
    // 新 Prompt 约定：数字 0 表示未识别的节次，留给用户在草稿中修正。
    const invalidSection = ["sectionStart", "sectionEnd"].find((key) => course[key] !== "" && (!Number.isInteger(course[key]) || course[key] < 0 || course[key] > 50));
    if (invalidSection) throw codedError("PARSE_FAILED", `AI JSON 第 ${index + 1} 门课程的 ${invalidSection} 不是有效节次。`);
  }
  return data;
}

async function parseScheduleFromImage(base64Image) {
  validateImage(base64Image);
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw codedError("CONFIG_MISSING", "服务器尚未配置 DeepSeek API Key。");
  // 禁用 SDK 自动重试，确保一次解析不会超过约 30 秒的请求超时。
  const client = new OpenAI({ apiKey, baseURL: "https://api.deepseek.com", timeout: 30_000, maxRetries: 0 });
  const response = await client.chat.completions.create({
    model: "deepseek-flash",
    response_format: { type: "json_object" },
    // 整张周课表可能包含很多门课，预留足够的 JSON 输出空间。
    max_tokens: 8192,
    temperature: 0.1,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [
        { type: "text", text: "请阅读整张课表，逐项提取全部课程，只返回指定的 JSON。" },
        { type: "image_url", image_url: { url: base64Image, detail: "low" } }
      ] }
    ]
  });
  const rawContent = response.choices?.[0]?.message?.content;
  const finishReason = response.choices?.[0]?.finish_reason ?? "未知";
  const usage = response.usage ?? null;
  // 调试日志只写在 npm start 的后端控制台，不把原始识别文本或图片回传到错误响应。
  console.log("===== DeepSeek原始返回 =====");
  console.log(rawContent);
  console.log("finish_reason:", finishReason);
  console.log("usage token用量：", usage);
  console.log("============================");
  // 响应已被截断时，任何 JSON 修复尝试都不能可靠恢复缺失的课程。
  if (finishReason === "length") throw codedError("PARSE_FAILED", "输出被token上限截断，请调大max_tokens");
  if (typeof rawContent !== "string" || !rawContent.trim()) {
    throw codedError("PARSE_FAILED", `AI 返回内容为空（finish_reason: ${finishReason}），请查看后端控制台。`);
  }
  let parsed;
  try { parsed = JSON.parse(rawContent); }
  catch (firstError) {
    // 对前后混入说明文字或代码块标记的响应，截取首尾花括号后再解析一次。
    const firstBrace = rawContent.indexOf("{");
    const lastBrace = rawContent.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      throw codedError("PARSE_FAILED", `AI 返回的 JSON 无法解析：${firstError.message}（finish_reason: ${finishReason}；未找到完整对象边界）。`);
    }
    try { parsed = JSON.parse(rawContent.slice(firstBrace, lastBrace + 1)); }
    catch (secondError) {
      throw codedError("PARSE_FAILED", `AI 返回的 JSON 无法解析：${secondError.message}（finish_reason: ${finishReason}；首次解析：${firstError.message}）。`);
    }
  }
  return validateSchedule(parsed);
}

module.exports = { parseScheduleFromImage };
