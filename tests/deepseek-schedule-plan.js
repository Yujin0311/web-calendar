// 模拟 SDK 验证 AI 规划助手（services/deepseekSchedule.js 的 makeStudyPlan）：
// 请求地址、模型、超时、全天任务、艾宾浩斯复习标记与错误路径；不使用真实密钥或网络。
"use strict";

const assert = require("node:assert/strict");
const openaiPath = require.resolve("openai");
const originalCache = require.cache[openaiPath];
const originalKey = process.env.DEEPSEEK_API_KEY;
let options, request, modelContent, finishReason = "stop";

class FakeOpenAI {
  constructor(settings) {
    options = settings;
    this.chat = { completions: { create: async (input) => {
      request = input;
      return { choices: [{ message: { content: modelContent }, finish_reason: finishReason }], usage: { total_tokens: 123 } };
    } } };
  }
}
require.cache[openaiPath] = { id: openaiPath, filename: openaiPath, loaded: true, exports: FakeOpenAI };
const { makeStudyPlan, parseScheduleFromImage } = require("../services/deepseekSchedule");

const input = { goal: "两个月内完成高数上册", startDate: "2026-10-12", endDate: "2026-11-12", background: "已学完第一章",
  currentTasks: [{ name: "背单词", date: "2026-10-12", duration: 30, review: true }], preciseTime: true, preferredWindow: "上午 9:00–11:00" };
const plan = { planTitle: "高数上册冲刺", stages: [{ stageName: "第一阶段", timeRange: "10月12日—10月25日",
  tasks: [{ taskName: "复习极限", needReview: true, date: "2026-10-13", duration: 45, startTime: "09:00" }] }] };

async function main() {
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => { logs.push(args); };
  try {
    process.env.DEEPSEEK_API_KEY = "unit-test-key";

    // 1) 精确到小时的请求形状与返回值。
    modelContent = JSON.stringify(plan);
    assert.deepEqual(await makeStudyPlan(input), plan, "精确到小时的计划应原样返回");
    assert.equal(options.baseURL, "https://api.deepseek.com");
    assert.equal(options.timeout, 90_000, "超时须与图片识别模块一致（90 秒）");
    assert.equal(options.maxRetries, 0, "必须禁用 SDK 自动重试");
    assert.equal(request.model, "deepseek-chat");
    assert.deepEqual(request.response_format, { type: "json_object" });
    assert.equal(request.max_tokens, 8192);
    assert.equal(request.temperature, 0.2);
    assert.equal(request.messages.length, 2, "只发送 system 与本次用户输入，不带历史上下文");
    assert.match(request.messages[0].content, /只输出合法JSON本体/, "系统提示词须内置输出结构约束");
    assert.match(request.messages[0].content, /艾宾浩斯/, "系统提示词须说明复习任务标记");
    assert.match(request.messages[0].content, /preciseTime=false/, "系统提示词须说明全天任务规则");
    assert.match(request.messages[1].content, /高数上册/);
    assert.match(request.messages[1].content, /上午 9:00–11:00/, "偏好时间段须传给模型");
    assert.match(request.messages[1].content, /背单词/, "已有任务摘要须传给模型");
    assert.ok(logs.some(([value]) => value === "===== DeepSeek原始返回 ====="), "原始返回须留在后端控制台");
    assert.ok(logs.some(([value, reason]) => value === "finish_reason:" && reason === "stop"));
    assert.ok(logs.some(([value, usage]) => value === "usage token用量：" && usage.total_tokens === 123));

    // 2) 全天任务：模型即使给出钟点也必须清空，复习标记保留。
    modelContent = JSON.stringify(plan);
    const allDay = await makeStudyPlan({ ...input, preciseTime: false, preferredWindow: "" });
    assert.equal(allDay.stages[0].tasks[0].startTime, "", "不精确到小时时不应保留钟点（全天任务只保留日期）");
    assert.equal(allDay.stages[0].tasks[0].needReview, true, "艾宾浩斯复习标记须保留");
    assert.match(request.messages[1].content, /"preciseTime":false/);

    // 3) 容错归一化：字符串时长、同日同时刻去重、前后混入说明文字。
    modelContent = JSON.stringify({ ...plan, stages: [{ ...plan.stages[0], tasks: [{ ...plan.stages[0].tasks[0], duration: "60" }] }] });
    assert.equal((await makeStudyPlan(input)).stages[0].tasks[0].duration, 60);
    modelContent = JSON.stringify({ ...plan, stages: [{ ...plan.stages[0], tasks: [plan.stages[0].tasks[0], { ...plan.stages[0].tasks[0], taskName: "极限习题" }] }] });
    assert.equal((await makeStudyPlan(input)).stages[0].tasks.length, 1, "同一天同一开始时间的重复任务应去重");
    modelContent = `好的，这是计划：\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``;
    assert.deepEqual(await makeStudyPlan(input), plan, "前后混入说明文字仍应解析成功");

    // 4) 校验失败路径：日期越界、跨午夜、多余字段、结构不符。
    modelContent = JSON.stringify({ ...plan, stages: [{ ...plan.stages[0], tasks: [{ ...plan.stages[0].tasks[0], date: "2027-01-01" }] }] });
    await assert.rejects(makeStudyPlan(input), (error) => error.code === "PARSE_FAILED" && /duration/.test(error.message));
    modelContent = JSON.stringify({ ...plan, stages: [{ ...plan.stages[0], tasks: [{ ...plan.stages[0].tasks[0], startTime: "23:30", duration: 120 }] }] });
    await assert.rejects(makeStudyPlan(input), (error) => error.code === "PARSE_FAILED" && /午夜/.test(error.message));
    modelContent = JSON.stringify({ ...plan, stages: [{ ...plan.stages[0], tasks: [{ ...plan.stages[0].tasks[0], extra: 1 }] }] });
    await assert.rejects(makeStudyPlan(input), { code: "PARSE_FAILED" });
    modelContent = JSON.stringify({ courses: [], isValid: false });
    await assert.rejects(makeStudyPlan(input), (error) => error.code === "PARSE_FAILED" && /planTitle\/stages/.test(error.message));

    // 5) 截断与空响应。
    finishReason = "length";
    modelContent = '{"planTitle":"高';
    await assert.rejects(makeStudyPlan(input), (error) => error.code === "PARSE_FAILED" && /截断/.test(error.message));
    finishReason = "stop";
    modelContent = "";
    await assert.rejects(makeStudyPlan(input), (error) => error.code === "PARSE_FAILED" && /finish_reason: stop/.test(error.message));

    // 6) 非法输入不发起请求。
    await assert.rejects(makeStudyPlan({ ...input, goal: "   " }), { code: "PARSE_FAILED" });
    await assert.rejects(makeStudyPlan({ ...input, endDate: "2026-10-01" }), { code: "PARSE_FAILED" });
    await assert.rejects(makeStudyPlan({ ...input, preciseTime: "yes" }), { code: "PARSE_FAILED" });

    // 7) 未配置密钥：不调用模型，错误码与前端提示语固定。
    delete process.env.DEEPSEEK_API_KEY;
    request = null;
    await assert.rejects(makeStudyPlan(input), (error) => error.code === "CONFIG_MISSING" &&
      error.message === "AI规划助手暂不可用：服务器未配置DEEPSEEK_API_KEY。");
    assert.equal(request, null, "密钥为空时不应调用模型");

    // 8) 兼容导出：图片课表识别仍使用百炼视觉模型，行为不变。
    process.env.DASHSCOPE_API_KEY = "unit-test-dashscope-key";
    modelContent = JSON.stringify({ courses: [], isValid: false });
    assert.deepEqual(await parseScheduleFromImage("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=="), { courses: [], isValid: false });
    assert.equal(options.baseURL, "https://dashscope.aliyuncs.com/compatible-mode/v1");
    assert.equal(request.model, "qwen3-vl-plus");
    assert.match(request.messages[0].content, /每天共 12 节/);
    assert.match(request.messages[0].content, /第6节 14:00-14:45/);
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI\/ScL\/nwAAAABJRU5ErkJggg==";
    await parseScheduleFromImage(image, { periodsPerDay: 1, defaultDuration: 45, breakMinutes: 5, periods: [{ section: 1, start: "07:30", end: "08:15" }] });
    assert.match(request.messages[0].content, /每天共 1 节/);
    assert.match(request.messages[0].content, /第1节 07:30-08:15/);
    await parseScheduleFromImage(image, { periods: [] });
    assert.match(request.messages[0].content, /每天共 12 节/);
  } finally {
    console.log = originalLog;
    if (originalCache) require.cache[openaiPath] = originalCache;
    else delete require.cache[openaiPath];
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
    delete process.env.DASHSCOPE_API_KEY;
  }
  console.log("通过：DeepSeek 规划参数、全天/复习归一化、去重、截断、密钥缺失与图片识别兼容导出");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
