"use strict";

// 本模块只负责向 DeepSeek 发出一次 chat completions 请求并校验返回 JSON，不接触数据库。
// 导出两件事：
//   1. makeStudyPlan —— AI 规划助手：按用户输入生成日程计划（父任务/子任务/艾宾浩斯/全天任务）。
//   2. parseScheduleFromImage —— 图片课表识别（仍是百炼 qwen3-vl-plus 视觉模型）；
//      server.js 的 /api/ai/parse-schedule 仍在使用该导出，故继续保留。
const OpenAI = require("openai");

// DeepSeek 平台地址、模型与超时：与图片识别模块保持同一套 SDK 参数约定。
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-chat";
// 图片识别用的百炼视觉模型：费用上限也按这个模型结算。
const QWEN_MODEL = "qwen3-vl-plus";
// 禁用 SDK 自动重试；规划属于长输出请求，超时放宽到 90 秒
//（须小于 nginx proxy_read_timeout 与 Cloudflare 100 秒限制）。
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_TOKENS = 8192;

const SYSTEM_PROMPT = `你是学习计划规划助手。请根据用户给出的学习目标、起止日期、基础情况、已有任务、是否需要精确到小时以及偏好时间段，拆分为可执行的阶段与任务，写成一份日程计划。
只输出合法JSON本体，禁止markdown代码块、禁止解释文字、禁止输出JSON以外的任何内容。
固定输出结构（字段名不可更改、不可增删，示例中的空字符串要换成真实内容）：
{"planTitle":"","stages":[{"stageName":"","timeRange":"","tasks":[{"taskName":"","needReview":false,"date":"YYYY-MM-DD","duration":45,"startTime":"09:00"}]}]}
字段含义：planTitle 是整份计划的标题；stages 是阶段数组，每项含 stageName（阶段名称）、timeRange（该阶段的日期范围，简洁文字）、tasks（该阶段的任务数组）。
每个任务必须包含且只包含以下五个字段：
1. taskName：任务名称，具体、简短、可执行，不超过 40 个字；
2. needReview：布尔值。背诵、单词、公式、定理、错题等需要按艾宾浩斯遗忘曲线安排复习的记忆类任务填 true，其余填 false；
3. date：执行日期，格式 YYYY-MM-DD，必须落在用户给定的起止日期之内；
4. duration：单次时长，分钟整数，取值 5 到 240；
5. startTime：精确时间字符串，要么是 HH:mm（24 小时制，例如 09:30），要么是空字符串""，规则见下。
生成规则：
1. 阶段按先后顺序覆盖整个起止范围，阶段名称不要重复；
2. 每个阶段至少安排 1 个任务，全部任务合计不超过 200 条，表述尽量简短；
3. 同一天不要安排过多任务，尽量避开已有任务拥挤的日期和时段，单个任务不要跨越午夜（startTime 换算成分钟后加上 duration 不得超过 1440）；
4. 需要精确到小时时（用户输入 preciseTime=true），每个任务的 startTime 都必须填写 HH:mm，尽量优先安排在用户偏好的高效时间段内，同一天的任务之间不要互相重叠；
5. 用户不需要精确到小时时（preciseTime=false），每个任务的 startTime 一律填空字符串""，这些日程会作为全天任务保存，只保留日期；
6. 只输出上述JSON本体，不要输出空数组阶段，不要输出示例文字。`;

const DENSITY_PROMPTS = {
  light: "任务密度：轻松。整个规划期内每周只安排 1–2 个子任务，相邻子任务间隔约 3–5 天，总量按周数 × 1.5 估算，宁可少不要多。",
  medium: "任务密度：中度。平均每 2 天安排 1 个子任务，总量按规划天数 ÷ 2 估算。",
  busy: "任务密度：忙碌。每天安排 1 个子任务，总量约等于规划天数，仍须遵守 200 条上限。"
};
const CONFLICT_PROMPT = `用户消息会提供已占用时段清单（YYYY-MM-DD HH:mm–HH:mm 任务名，全天任务标注「全天」）。
preciseTime=true 时，新任务时段 [startTime, startTime + duration) 不得与同一天任何已占用时段重叠，逐一比对；首尾相接不算冲突。新任务之间也不得重叠。
严格遵循 preferredWindow，优先在用户填写的高效时间段内安排；若有冲突，在同一天该偏好时段附近寻找最近的空闲时段；当天确实排不下则顺延到规划范围内最近的有空日期。宁可减少任务数量，也不要安排重叠。
全天任务表示该日已很满，不参与精确时段重叠判断。不要重排、不要输出用户已有的任务。
preciseTime=false 时不要编造钟点，startTime 仍为空字符串；在日期上避开全天任务或当天任务总时长接近 16 小时的拥挤日期。
不得改变输出 JSON 结构与字段。`;

const PLAN_KEYS = ["planTitle", "stages"];
const STAGE_KEYS = ["stageName", "tasks", "timeRange"];
const TASK_KEYS = ["date", "duration", "needReview", "startTime", "taskName"];
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function densityTarget(days, density) {
  if (!Object.hasOwn(DENSITY_PROMPTS, density)) throw codedError("PARSE_FAILED", "任务密度取值无效。");
  return Math.min(200, Math.max(1, density === "light" ? Math.round(days / 7 * 1.5) : density === "medium" ? Math.round(days / 2) : days));
}

function enforceDensity(plan, target) {
  const count = plan.stages.reduce((total, stage) => total + stage.tasks.length, 0);
  if (count < target) console.warn(`[ai-plan] 任务不足目标：actual=${count}, target=${target}，保留原计划，不补任务。`);
  const keep = Math.max(target, plan.stages.length);
  if (count <= keep) return plan;
  const stages = plan.stages.map((stage) => ({ ...stage, tasks: [] }));
  let index = 0, previousBucket = -1, selected = 0;
  // 全局等距抽样；再补回被抽空的阶段，从任务最多的阶段扣回名额。
  plan.stages.forEach((stage, stageIndex) => stage.tasks.forEach((task) => {
    const bucket = Math.round(index++ * keep / count);
    if (bucket !== previousBucket && selected < keep) { stages[stageIndex].tasks.push(task); selected++; }
    previousBucket = bucket;
  }));
  stages.forEach((stage, stageIndex) => {
    if (!stage.tasks.length) { stage.tasks.push(plan.stages[stageIndex].tasks[0]); selected++; }
  });
  while (selected > keep) {
    const largest = stages.reduce((a, b) => a.tasks.length >= b.tasks.length ? a : b);
    largest.tasks.pop(); selected--;
  }
  return { ...plan, stages };
}

function resolveConflicts(plan, occupied, { preciseTime, startDate, endDate }) {
  if (preciseTime !== true) return plan;
  const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const clock = (value) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  const addDays = (date, offset) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
  const slots = new Map();
  function reserve(date, start, duration) {
    if (!slots.has(date)) slots.set(date, []);
    slots.get(date).push([start, start + duration]);
  }
  for (const task of occupied) if (task.allDay === false) reserve(task.date, minutes(task.time), task.duration);
  const result = { ...plan, stages: plan.stages.map((stage) => ({ ...stage, tasks: stage.tasks.map((task) => ({ ...task })) })) };
  const tasks = result.stages.flatMap((stage) => stage.tasks).sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  const offsets = [0];
  for (let offset = 15; offset <= 360; offset += 15) offsets.push(offset, -offset);
  for (const task of tasks) {
    const originalStart = minutes(task.startTime);
    const dates = [task.date];
    for (let days = 1; days <= 14; days++) dates.push(addDays(task.date, days));
    for (let days = 1; days <= 14; days++) dates.push(addDays(task.date, -days));
    let found = false;
    for (const date of dates) {
      if (date < startDate || date > endDate) continue;
      for (const offset of offsets) {
        const start = originalStart + offset, end = start + task.duration;
        if (start < 0 || end > 1440 || (slots.get(date) || []).some(([a, b]) => start < b && end > a)) continue;
        task.date = date; task.startTime = clock(start); found = true; break;
      }
      if (found) break;
    }
    if (!found) console.warn(`[ai-plan] 无可用时段，保留原任务：${task.date} ${task.startTime} ${task.taskName}`);
    reserve(task.date, minutes(task.startTime), task.duration);
  }
  return result;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// 当 DEEPSEEK_API_KEY 为空时，前端会显示这句话（server.js 依据 code 映射 503 提示）。
const CONFIG_MISSING_MESSAGE = "AI规划助手暂不可用：服务器未配置DEEPSEEK_API_KEY。";

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

// 与图片识别共用同一套字段白名单校验：字段必须不多不少，类型与取值范围逐项检查。
function sameKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

function validateSchedule(data, startDate, endDate, preciseTime) {
  if (!sameKeys(data, PLAN_KEYS) || typeof data.planTitle !== "string" || !data.planTitle.trim() ||
      data.planTitle.length > 80 || !Array.isArray(data.stages) || !data.stages.length || data.stages.length > 20) {
    throw codedError("PARSE_FAILED", `AI JSON 顶层结构不符合 planTitle/stages 格式（实际字段：${data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data).join(", ").slice(0, 100) : typeof data}）。`);
  }
  let totalTasks = 0;
  const normalizedStages = [];
  for (const [stageIndex, stage] of data.stages.entries()) {
    if (!sameKeys(stage, STAGE_KEYS) || typeof stage.stageName !== "string" || !stage.stageName.trim() ||
        stage.stageName.length > 80 || typeof stage.timeRange !== "string" || stage.timeRange.length > 120 ||
        !Array.isArray(stage.tasks) || !stage.tasks.length) {
      throw codedError("PARSE_FAILED", `AI JSON 第 ${stageIndex + 1} 个阶段的 stageName/timeRange/tasks 字段不符合约定。`);
    }
    totalTasks += stage.tasks.length;
    // 同一天同一开始时间的任务只保留一条，避免模型重复安排导致日历重叠。
    const occupied = new Set();
    const normalizedTasks = [];
    for (const [taskIndex, task] of stage.tasks.entries()) {
      const position = `第 ${stageIndex + 1} 个阶段第 ${taskIndex + 1} 个任务`;
      if (!sameKeys(task, TASK_KEYS)) {
        throw codedError("PARSE_FAILED", `AI JSON ${position}字段不符合约定（实际字段：${task && typeof task === "object" && !Array.isArray(task) ? Object.keys(task).join(", ").slice(0, 100) : typeof task}）。`);
      }
      // 模型偶尔会把示例里的时长或布尔值加上引号；先做一次可安全转换的归一化。
      let duration = task.duration;
      if (typeof duration === "string" && /^\d{1,4}$/.test(duration)) duration = Number(duration);
      let startTime = task.startTime;
      if (typeof startTime !== "string") startTime = "";
      startTime = startTime.trim();
      // 用户不要求精确到小时时，日程按全天保存，强制清空钟点。
      if (!preciseTime) startTime = "";
      if (typeof task.taskName !== "string" || !task.taskName.trim() || task.taskName.length > 80 ||
          typeof task.needReview !== "boolean" || !validDate(task.date) ||
          task.date < startDate || task.date > endDate ||
          !Number.isInteger(duration) || duration < 1 || duration > 1440) {
        throw codedError("PARSE_FAILED", `AI JSON ${position}的 taskName/needReview/date/duration 字段类型或取值范围不正确。`);
      }
      if (preciseTime) {
        const minutes = TIME_PATTERN.test(startTime)
          ? Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3)) : -1;
        if (minutes < 0 || minutes + duration > 1440) {
          throw codedError("PARSE_FAILED", `AI JSON ${position}的 startTime 不是有效钟点或该任务跨越了午夜。`);
        }
        const slot = `${task.date} ${startTime}`;
        if (occupied.has(slot)) continue;
        occupied.add(slot);
      }
      normalizedTasks.push({ taskName: task.taskName.trim(), needReview: task.needReview, date: task.date, duration, startTime });
    }
    if (!normalizedTasks.length) throw codedError("PARSE_FAILED", `AI JSON 第 ${stageIndex + 1} 个阶段没有可用的任务。`);
    normalizedStages.push({ stageName: stage.stageName.trim(), timeRange: stage.timeRange.trim(), tasks: normalizedTasks });
  }
  if (totalTasks > 200) throw codedError("PARSE_FAILED", "AI JSON 的任务数量超过 200 条，请缩小目标范围。");
  // 只返回约定字段，避免模型额外文本混入前端或任务数据。
  return { planTitle: data.planTitle.trim(), stages: normalizedStages };
}

function buildUserPrompt({ goal, startDate, endDate, background, currentTasks, preciseTime, preferredWindow, density }) {
  let payload;
  try { payload = JSON.stringify({ goal, startDate, endDate, background, preciseTime, preferredWindow }); }
  catch { throw codedError("PARSE_FAILED", "规划输入无法序列化，请精简学习目标或基础情况后重试。"); }
  const grouped = new Map();
  for (const task of [...currentTasks].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time))) {
    if (!grouped.has(task.date)) grouped.set(task.date, []);
    grouped.get(task.date).push(task);
  }
  const occupied = [...grouped].map(([date, tasks]) => {
    const timed = tasks.filter((task) => !task.allDay);
    const hours = Math.round(timed.reduce((sum, task) => sum + task.duration, 0) / 60 * 100) / 100;
    const lines = timed.map((task) => {
      const end = Number(task.time.slice(0, 2)) * 60 + Number(task.time.slice(3)) + task.duration;
      const endTime = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
      return `${task.time}-${endTime} ${task.name}`;
    });
    return [`${date}（已占 ${hours} 小时）：${lines.join("；")}`, ...tasks.filter((task) => task.allDay).map((task) => `${date} 全天 ${task.name}`)].join("\n");
  }).join("\n");
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
  const target = densityTarget(days, density);
  return `本次规划输入：\n${payload}\n密度核算：${density}，起止日期含首尾共 ${days} 天，整份计划（全部阶段合计）的目标任务总数为 ${target} 个。任务总数不要超过此目标；有冲突可减少，不要为覆盖日期而加密任务。阶段日期范围覆盖整个规划期即可，不要求每天都有任务。\n已占用时段清单：\n${occupied || "（用户在该时间段内没有已安排的任务）"}\n请只输出约定的 JSON 日程计划。`;
}

// AI 规划助手入口：一次请求返回待确认的计划 JSON，不保存对话上下文。
// 返回结构与前端 /api/ai-plan 的约定一致：
//   { planTitle, stages: [{ stageName, timeRange, tasks: [{ taskName, needReview, date, duration, startTime }] }] }
// 导入后的落库规则（由前端 importAiPlan 执行）：父任务沿用 planTitle/学习目标作为任务名称，
// 每条子任务把自身标题写入自己的备注；needReview 决定是否按艾宾浩斯节点生成复习日程；
// preciseTime=false 时 startTime 为空字符串，任务按全天日程保存（只保留日期）。
async function makeStudyPlan(input = {}) {
  const { goal, startDate, endDate, background = "", currentTasks = [], preciseTime, preferredWindow = "", density = "medium", onUsage } = input;
  if (!Object.hasOwn(DENSITY_PROMPTS, density)) throw codedError("PARSE_FAILED", "任务密度取值无效。");
  if (typeof goal !== "string" || !goal.trim() || goal.trim().length > 500) throw codedError("PARSE_FAILED", "学习目标须为 1–500 个字符。");
  if (!validDate(startDate) || !validDate(endDate) || endDate < startDate) throw codedError("PARSE_FAILED", "请选择有效的起止日期。");
  if (typeof preciseTime !== "boolean") throw codedError("PARSE_FAILED", "请选择是否需要精确安排到几点。");
  const target = densityTarget(Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1, density);
  console.log(currentTasks.length ? `[ai-plan] 占用清单非空：${currentTasks.length}条` : "[ai-plan] 占用清单为空");
  // 密钥为空时直接抛出，绝不发起网络请求；错误码与图片识别模块保持一致。
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw codedError("CONFIG_MISSING", CONFIG_MISSING_MESSAGE);
  const client = new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE_URL, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });
  const response = await client.chat.completions.create({
    model: DEEPSEEK_MODEL,
    response_format: { type: "json_object" },
    // 计划最长 200 条任务，max_tokens 需留足空间，防止 JSON 被中途截断。
    max_tokens: MAX_TOKENS,
    temperature: 0.2,
    messages: [
      { role: "system", content: `${SYSTEM_PROMPT}\n${DENSITY_PROMPTS[density]}\n任务数量与日期分布必须符合所选密度；阶段（stages）数量不得超过任务总数，轻松档相应减少阶段；阶段仍需覆盖整个起止日期范围。\n${CONFLICT_PROMPT}\n时间安排优先级：偏好时段内空闲 → 同日相邻时段 → 顺延日期。总任务数目标 ${target}（±30%），输出前自查数量并逐日核对重叠。` },
      { role: "user", content: buildUserPrompt({ goal: goal.trim(), startDate, endDate, background, currentTasks, preciseTime, preferredWindow, density }) }
    ]
  });
  const rawContent = response.choices?.[0]?.message?.content;
  const finishReason = response.choices?.[0]?.finish_reason ?? "未知";
  const usage = response.usage ?? null;
  // 费用统计由 server.js 注入的回调完成；即使后面解析失败，token 也已经花掉了，
  // 所以必须在校验之前回传用量，且回调异常不能影响规划结果。
  if (typeof onUsage === "function") {
    try { onUsage({ provider: "deepseek", model: DEEPSEEK_MODEL, usage }); }
    catch (error) { console.error("[ai-plan] 用量回调失败：", error); }
  }
  // 调试日志只写在 npm start 的后端控制台，不把原始计划文本回传到错误响应。
  console.log("===== DeepSeek原始返回 =====");
  console.log(rawContent);
  console.log("finish_reason:", finishReason);
  console.log("usage token用量：", usage);
  console.log("============================");
  // 响应已被截断时，任何 JSON 修复尝试都不能可靠恢复缺失的任务。
  if (finishReason === "length") throw codedError("PARSE_FAILED", "输出被token上限截断，请调大max_tokens或缩小目标范围");
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
  const plan = enforceDensity(validateSchedule(parsed, startDate, endDate, preciseTime), target);
  return resolveConflicts(plan, currentTasks, { preciseTime, startDate, endDate });
}

// ===== 图片课表识别（沿用阿里云百炼 qwen3-vl-plus，接口行为保持不变） =====
const OCR_SYSTEM_PROMPT = `你是大学课表提取助手。识别周课表图片，提取全部课程。
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

function validateScheduleFromImage(data) {
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

async function parseScheduleFromImage(base64Image, timetable, onUsage) {
  validateImage(base64Image);
  const schoolTimetable = require("../timetable").normalizeTimetable(timetable);
  const timetablePrompt = `本校作息表（24 小时制，节次与时间一一对应，每天共 ${schoolTimetable.periodsPerDay} 节）：\n${schoolTimetable.periods.map((period) => `第${period.section}节 ${period.start}-${period.end}`).join("\n")}\n规则：sectionStart/sectionEnd 必须依据这张作息表判断；节次不得超出作息表范围；不要把作息表时间写进 JSON 的其它字段；识别不到节次时按原规则填空。`;
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) throw codedError("CONFIG_MISSING", "服务器尚未配置百炼 API Key。");
  // 禁用 SDK 自动重试。高密度课表图片的 OCR + 推理 + 长 JSON 输出可能超过 60 秒，
  // 超时设为 90 秒（须小于 nginx proxy_read_timeout 与 Cloudflare 100 秒限制）。
  const client = new OpenAI({ apiKey, baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });
  const response = await client.chat.completions.create({
    model: QWEN_MODEL,
    response_format: { type: "json_object" },
    // qwen3-vl-plus 的思考 token 也计入 max_tokens；密集课表的推理 + 完整课程 JSON
    // 可能超过 8192 导致 finish_reason=length，因此放宽到 32768（API 实测接受）。
    max_tokens: 32768,
    temperature: 0.1,
    messages: [
      { role: "system", content: `${OCR_SYSTEM_PROMPT}\n\n${timetablePrompt}` },
      { role: "user", content: [
        { type: "text", text: "请阅读整张课表，逐项提取全部课程，只返回指定的 JSON。" },
        { type: "image_url", image_url: { url: base64Image, detail: "low" } }
      ] }
    ]
  });
  const rawContent = response.choices?.[0]?.message?.content;
  const finishReason = response.choices?.[0]?.finish_reason ?? "未知";
  const usage = response.usage ?? null;
  // 与规划接口一致：先回传用量再校验内容，截断或格式错误也已经产生费用。
  if (typeof onUsage === "function") {
    try { onUsage({ provider: "qwen", model: QWEN_MODEL, usage }); }
    catch (error) { console.error("[ocr] 用量回调失败：", error); }
  }
  // 调试日志只写在 npm start 的后端控制台，不把原始识别文本或图片回传到错误响应。
  console.log("===== qwen3-vl-plus原始返回 =====");
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
  return validateScheduleFromImage(parsed);
}

module.exports = { makeStudyPlan, parseScheduleFromImage, validateImage, densityTarget, enforceDensity, resolveConflicts };
