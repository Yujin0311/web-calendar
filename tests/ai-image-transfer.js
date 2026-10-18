"use strict";
// Catch truncated UTF-8/chunks, swallowed stream errors and premature EOF in the real auth client.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { ReadableStream } = require("node:stream/web");
const user = { id: "transfer-test", username: "transfer-test" };
const session = JSON.stringify({ token: "test-token", user });
let nextResponse;
const element = () => ({ addEventListener() {}, removeAttribute() {}, setAttribute() {}, classList: { toggle() {}, add() {}, remove() {} } });
const window = { addEventListener() {} };
const context = {
  window, document: { querySelector: element, body: element() },
  location: { pathname: "/login" }, history: { replaceState() {} },
  localStorage: { getItem: key => key === "qingxu-session-v2" ? session : null, setItem() {}, removeItem() {} },
  setInterval, clearInterval, TextDecoder, Error,
  fetch: async (url, options) => {
    if (url === "/api/auth/me") return Response.json({ user });
    if (url === "/api/sync") return Response.json({ categories: [{ id: "existing" }] });
    assert.equal(url, "/api/ai/parse-schedule");
    assert.equal(options.headers.Accept, "application/x-ndjson", "client must negotiate progress responses");
    return nextResponse;
  }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../auth.js"), "utf8"), context);
window.QingxuAuth.boot({ onState() {}, initialState() { return {}; } });
function streamResponse(text) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
}
async function main() {
  const schedule = { isValid: true, courses: [{ courseName: "高等数学" }] };
  nextResponse = streamResponse('{"type":"pending"}\n' + JSON.stringify({ type: "result", data: schedule }) + '\n');
  assert.deepEqual(JSON.parse(JSON.stringify(await window.QingxuAuth.parseScheduleFromImage("image", {}))), schedule);
  nextResponse = streamResponse('{"type":"pending"}\n{"type":"error","status":504,"error":"AI 解析超时（180 秒）"}\n');
  await assert.rejects(window.QingxuAuth.parseScheduleFromImage("image", {}), error => error.status === 504 && error.message.includes("180"));
  nextResponse = streamResponse('{"type":"pending"}\n');
  await assert.rejects(window.QingxuAuth.parseScheduleFromImage("image", {}), /连接.*中断/);
  nextResponse = Response.json(schedule);
  assert.deepEqual(JSON.parse(JSON.stringify(await window.QingxuAuth.parseScheduleFromImage("image", {}))), schedule, "legacy JSON must still work");
  nextResponse = Response.json({ error: "请先登录" }, { status: 401 });
  await assert.rejects(window.QingxuAuth.parseScheduleFromImage("image", {}), error => error.status === 401);
  console.log("AI image transfer client tests passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
