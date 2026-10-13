"use strict";

// AI 规划只使用本次请求的输入和返回值；不存聊天上下文，也不访问数据库。
const OpenAI = require("openai");

const SYSTEM_PROMPT = `你是学习计划规划助手。根据用户的学习目标、起止日期、基础情况和当前任务，拆分为简洁可执行的阶段与任务，尽量避开已有任务过于拥挤的日期。
只输出合法JSON本体，禁止markdown、代码块和任何解释文字。尽量简短，节省token。
固定结构：
{"planTitle":"","stages":[{"stageName":"","timeRange":"","tasks":[{"taskName":"","needReview":true,"date":"YYYY-MM-DD","duration":45,"startTime":""}]}]}
规则：timeRange简洁描述该阶段在用户起止日期内的时间范围；任务名称具体、简短。为每项任务判断一个用户起止日期范围内的日期和单次时长（分钟整数）。用户要求精确时间时，每项任务的startTime填写HH:mm，尽量优先安排在用户偏好的高效时间段，并避开已有任务；不要求精确时间时startTime填空字符串，这些日程会作为全天事件保存。
需要按艾宾浩斯节点复习的记忆类任务填needReview=true，其他任务填false。
每项任务都必须包含taskName、布尔值needReview、date、duration和startTime；只输出上述JSON，不增加字段。`;

function planError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function validatePlan(data, startDate, endDate, preciseTime) {
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      typeof data.planTitle !== "string" || !data.planTitle.trim() || data.planTitle.length > 80 ||
      !Array.isArray(data.stages) || !data.stages.length || data.stages.length > 20) {
    throw planError("PLAN_PARSE_FAILED", "AI 返回的计划标题或阶段结构不正确。");
  }
  let totalTasks = 0;
  for (const [index, stage] of data.stages.entries()) {
    if (!stage || typeof stage.stageName !== "string" || !stage.stageName.trim() || stage.stageName.length > 80 ||
        typeof stage.timeRange !== "string" || stage.timeRange.length > 120 ||
        !Array.isArray(stage.tasks) || !stage.tasks.length) {
      throw planError("PLAN_PARSE_FAILED", `AI 返回的第 ${index + 1} 阶段格式不正确。`);
    }
    totalTasks += stage.tasks.length;
    for (const task of stage.tasks) {
      if (!task || typeof task.taskName !== "string" || !task.taskName.trim() || task.taskName.length > 80 || typeof task.needReview !== "boolean" ||
          !validDate(task.date) || task.date < startDate || task.date > endDate || !Number.isInteger(task.duration) || task.duration < 1 || task.duration > 1440 ||
          typeof task.startTime !== "string" || (preciseTime && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(task.startTime) ||
          Number(task.startTime.slice(0, 2)) * 60 + Number(task.startTime.slice(3)) + task.duration > 1440))) {
        throw planError("PLAN_PARSE_FAILED", `AI 返回的第 ${index + 1} 阶段任务格式不正确。`);
      }
    }
  }
  if (totalTasks > 200) throw planError("PLAN_PARSE_FAILED", "AI 返回的任务数量超过 200 条，请缩小目标范围。");
  // 只返回约定字段，避免模型额外文本混入前端或任务数据。
  return { planTitle: data.planTitle.trim(), stages: data.stages.map((stage) => ({
    stageName: stage.stageName.trim(), timeRange: stage.timeRange.trim(),
    tasks: stage.tasks.map((task) => ({ taskName: task.taskName.trim(), needReview: task.needReview, date: task.date, duration: task.duration, startTime: preciseTime ? task.startTime : "" }))
  })) };
}

async function makeStudyPlan({ goal, startDate, endDate, background, currentTasks, preciseTime, preferredWindow }) {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw planError("CONFIG_MISSING", "服务器尚未配置 DEEPSEEK_API_KEY。");
  const client = new OpenAI({ apiKey, baseURL: "https://api.deepseek.com", timeout: 30_000, maxRetries: 0 });
  const response = await client.chat.completions.create({
    model: "deepseek-flash",
    response_format: { type: "json_object" },
    temperature: 0.2,
    max_tokens: 4096,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ goal, startDate, endDate, background, currentTasks, preciseTime, preferredWindow }) }
    ]
  });
  if (response.choices?.[0]?.finish_reason === "length") throw planError("PLAN_PARSE_FAILED", "AI 输出被截断，请缩小目标范围后重试。");
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw planError("PLAN_PARSE_FAILED", "AI 未返回可用计划，请重试。");
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw planError("PLAN_PARSE_FAILED", "AI 返回的计划不是合法 JSON，请重试。"); }
  return validatePlan(parsed, startDate, endDate, preciseTime);
}

module.exports = { makeStudyPlan };
