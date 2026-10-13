// 模拟 SDK 响应，验证视觉请求形状与 JSON 校验；不连接 DeepSeek，也不使用真实密钥。
"use strict";

const assert = require("node:assert/strict");
const openaiPath = require.resolve("openai");
const originalCache = require.cache[openaiPath];
const originalKey = process.env.DEEPSEEK_API_KEY;
let clientOptions, request, modelContent, finishReason = "stop";

class FakeOpenAI {
  constructor(options) {
    clientOptions = options;
    this.chat = { completions: { create: async (input) => {
      request = input;
      return { choices: [{ message: { content: modelContent }, finish_reason: finishReason }], usage: { total_tokens: 123 } };
    } } };
  }
}

require.cache[openaiPath] = { id: openaiPath, filename: openaiPath, loaded: true, exports: FakeOpenAI };
const { parseScheduleFromImage } = require("../services/deepseekSchedule");
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";

async function main() {
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => { logs.push(args); };
  try {
    process.env.DEEPSEEK_API_KEY = "unit-test-key";
    const schedule = { courses: [
      { courseName: "高等数学", weekday: "星期一", sectionStart: 5, sectionEnd: 6, teacher: "陈老师", location: "A101", weekRange: "3-10周" },
      { courseName: "大学英语", weekday: "星期三", sectionStart: 1, sectionEnd: 2, teacher: "", location: "B202", weekRange: "1-16周" }
    ], isValid: true };
    modelContent = JSON.stringify(schedule);
    assert.deepEqual(await parseScheduleFromImage(image), schedule);
    assert.equal(clientOptions.baseURL, "https://api.deepseek.com");
    assert.equal(clientOptions.timeout, 30_000);
    assert.equal(clientOptions.maxRetries, 0);
    assert.equal(request.model, "deepseek-flash");
    assert.deepEqual(request.response_format, { type: "json_object" });
    assert.equal(request.max_tokens, 8192);
    assert.equal(request.temperature, 0.1);
    assert.match(request.messages[0].content, /识别周课表图片，提取全部课程/);
    assert.match(request.messages[0].content, /数字填0/);
    assert.match(request.messages[0].content, /courses为空数组，isValid=false/);
    assert.deepEqual(request.messages[1].content[1], { type: "image_url", image_url: { url: image, detail: "low" } });
    assert.ok(logs.some(([value]) => value === "===== DeepSeek原始返回 ====="));
    assert.ok(logs.some(([value, reason]) => value === "finish_reason:" && reason === "stop"));
    assert.ok(logs.some(([value, usage]) => value === "usage token用量：" && usage.total_tokens === 123));

    modelContent = JSON.stringify({ courses: [], isValid: false });
    assert.deepEqual(await parseScheduleFromImage(image), { courses: [], isValid: false });
    modelContent = JSON.stringify({ courses: [schedule.courses[0]], isValid: true });
    assert.equal((await parseScheduleFromImage(image)).courses.length, 1);
    modelContent = JSON.stringify({ courses: [{ ...schedule.courses[0], sectionStart: "5", sectionEnd: "" }], isValid: true });
    assert.deepEqual((await parseScheduleFromImage(image)).courses[0], { ...schedule.courses[0], sectionEnd: "" });
    modelContent = JSON.stringify({ courses: [{ ...schedule.courses[0], sectionStart: 0, sectionEnd: 0 }], isValid: true });
    assert.equal((await parseScheduleFromImage(image)).courses[0].sectionStart, 0);
    finishReason = "length";
    modelContent = '{"courses":[';
    await assert.rejects(parseScheduleFromImage(image), (error) => error.code === "PARSE_FAILED" && error.message === "输出被token上限截断，请调大max_tokens");
    finishReason = "stop";
    modelContent = JSON.stringify({ courses: [{ ...schedule.courses[0], weekday: "星期八" }], isValid: true });
    await assert.rejects(parseScheduleFromImage(image), (error) => error.code === "PARSE_FAILED" && /weekday/.test(error.message));
    modelContent = `模型返回：\n${JSON.stringify(schedule)}\n完毕`;
    assert.deepEqual(await parseScheduleFromImage(image), schedule);
    modelContent = "```json\n{broken json}\n```";
    await assert.rejects(parseScheduleFromImage(image), (error) => error.code === "PARSE_FAILED" && /首次解析/.test(error.message));
    modelContent = "";
    await assert.rejects(parseScheduleFromImage(image), (error) => error.code === "PARSE_FAILED" && /finish_reason: stop/.test(error.message));
    await assert.rejects(parseScheduleFromImage("data:text/plain;base64,AA=="), { code: "INVALID_IMAGE" });
    delete process.env.DEEPSEEK_API_KEY;
    await assert.rejects(parseScheduleFromImage(image), { code: "CONFIG_MISSING" });
  } finally {
    console.log = originalLog;
    if (originalCache) require.cache[openaiPath] = originalCache;
    else delete require.cache[openaiPath];
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
  console.log("通过：DeepSeek 参数、原始日志、容错 JSON、课程数组与详细错误信息");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
