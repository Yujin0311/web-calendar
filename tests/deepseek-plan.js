// 模拟 SDK 验证一次性 AI 规划结构，不使用真实密钥或网络。
"use strict";

const assert = require("node:assert/strict");
const openaiPath = require.resolve("openai");
const originalCache = require.cache[openaiPath];
const originalKey = process.env.DEEPSEEK_API_KEY;
let options, request, content, finishReason = "stop";
class FakeOpenAI {
  constructor(settings) {
    options = settings;
    this.chat = { completions: { create: async (input) => {
      request = input;
      return { choices: [{ finish_reason: finishReason, message: { content } }] };
    } } };
  }
}
require.cache[openaiPath] = { id: openaiPath, filename: openaiPath, loaded: true, exports: FakeOpenAI };
const { makeStudyPlan } = require("../services/deepseekPlan");

async function main() {
  try {
    process.env.DEEPSEEK_API_KEY = "unit-test-key";
    const input = { goal: "复习高数", startDate: "2026-10-12", endDate: "2026-11-12", background: "学过第一章",
      currentTasks: [{ name: "背单词", date: "2026-10-12", duration: 30, review: true }], preciseTime: true, preferredWindow: "上午9-11点" };
    const result = { planTitle: "高数复习", stages: [{ stageName: "第一阶段", timeRange: "10月12日—10月20日",
      tasks: [{ taskName: "复习极限", needReview: true, date: "2026-10-13", duration: 45, startTime: "09:00" }] }] };
    content = JSON.stringify(result);
    assert.deepEqual(await makeStudyPlan(input), result);
    assert.equal(options.baseURL, "https://api.deepseek.com");
    assert.equal(options.timeout, 30_000);
    assert.equal(request.model, "deepseek-flash");
    assert.deepEqual(request.response_format, { type: "json_object" });
    assert.equal(request.messages.length, 2, "每次请求只发送 system 和本次用户输入");
    assert.match(request.messages[1].content, /背单词/);
    assert.match(request.messages[1].content, /上午9-11点/);
    assert.match(request.messages[0].content, /艾宾浩斯/);
    const allDayInput = { ...input, preciseTime: false, preferredWindow: "" };
    content = JSON.stringify({ ...result, stages: [{ ...result.stages[0], tasks: [{ ...result.stages[0].tasks[0], startTime: "" }] }] });
    assert.equal((await makeStudyPlan(allDayInput)).stages[0].tasks[0].startTime, "", "全天规划不应保留钟点");
    content = JSON.stringify({ ...result, stages: [{ ...result.stages[0], tasks: [{ ...result.stages[0].tasks[0], date: "2027-01-01" }] }] });
    await assert.rejects(makeStudyPlan(input), { code: "PLAN_PARSE_FAILED" });
    finishReason = "length";
    await assert.rejects(makeStudyPlan(input), { code: "PLAN_PARSE_FAILED" });
    delete process.env.DEEPSEEK_API_KEY;
    await assert.rejects(makeStudyPlan(input), { code: "CONFIG_MISSING" });
    console.log("通过：AI 规划 JSON、当前任务参考、30 秒超时和无历史上下文");
  } finally {
    if (originalCache) require.cache[openaiPath] = originalCache;
    else delete require.cache[openaiPath];
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
