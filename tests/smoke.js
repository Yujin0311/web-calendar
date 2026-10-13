// 端到端冒烟测试：使用临时数据库与导出记录，不触碰真实用户计划。
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { makeICS } = require("../ics-export");

const root = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
function addDays(date, days) { return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10); }
async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "qingxu-smoke-"));
  const port = await freePort();
  const historyFile = path.join(temp, "export_history.json");
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    // REGISTER_MAX_ATTEMPTS 临时调高：冒烟测试要连续注册多个账户，不测试限流路径。
    cwd: root, env: { ...process.env, PORT: String(port), DEEPSEEK_API_KEY: "", QINGXU_DATA_DIR: path.join(temp, "data"), QINGXU_EXPORT_HISTORY_FILE: historyFile, REGISTER_MAX_ATTEMPTS: "1000" }, stdio: ["ignore", "pipe", "pipe"]
  });
  let serverOutput = "";
  child.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  let token = null;
  const api = async (url, method = "GET", body) => {
    const response = await fetch(`${base}${url}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return response;
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) throw Error(`服务提前退出：${serverOutput}`);
      try { const response = await api("/"); if (response.ok) { ready = true; break; } } catch { /* 等待服务绑定端口。 */ }
      await sleep(100);
    }
    assert(ready, `服务未能启动：${serverOutput}`);
    // 401 表示路由已注册且需要登录；404 则是本次实际遇到的旧进程问题。
    const unauthenticatedExport = await api("/api/export/ics", "POST");
    assert.equal(unauthenticatedExport.status, 401, "ICS 导出路由未注册或鉴权失效");
    const unauthenticatedAi = await api("/api/ai/parse-schedule", "POST", { image: "无效图片" });
    assert.equal(unauthenticatedAi.status, 401, "AI 图片接口必须校验登录状态");
    assert.equal((await api("/api/notes")).status, 401, "便签接口必须校验登录状态");
    assert.equal((await api("/api/ai-plan", "POST", {})).status, 401, "AI 规划接口必须校验登录状态");
    // 邀请码注册：先通过管理 CLI 在临时库生成邀请码，再验证负路径与正常注册。
    const inviteCode = await new Promise((resolve, reject) => {
      const cli = spawn(process.execPath, [path.join(root, "scripts", "admin.js"), "invite", "generate", "10", "smoke-test"], { cwd: root, env: { ...process.env, QINGXU_DATA_DIR: path.join(temp, "data") }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      cli.stdout.on("data", (chunk) => { output += chunk.toString(); });
      cli.stderr.on("data", (chunk) => { output += chunk.toString(); });
      cli.once("exit", (code) => code === 0 ? resolve((output.match(/QX-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/) || [])[0]) : reject(Error(`邀请码生成失败：${output}`)));
    });
    assert(inviteCode, "应能通过管理 CLI 生成邀请码");
    assert.equal((await api("/api/auth/register", "POST", { username: `noinvite${Date.now()}`, password: "SmokeTest123!" })).status, 400, "无邀请码注册应被拒绝");
    assert.equal((await api("/api/auth/register", "POST", { username: `badinvite${Date.now()}`, password: "SmokeTest123!", inviteCode: "QX-0000-0000-0000" })).status, 403, "无效邀请码注册应被拒绝");
    const registration = await api("/api/auth/register", "POST", { username: `smoke${Date.now()}`, password: "SmokeTest123!", inviteCode });
    const registrationData = await registration.json();
    assert.equal(registration.status, 201, JSON.stringify(registrationData));
    token = registrationData.token;
    assert.deepEqual(await (await api("/api/notes")).json(), [], "新账户的便签应为空");
    const createdNoteResponse = await api("/api/notes", "POST", { content: "记住公式", side: "left" });
    assert.equal(createdNoteResponse.status, 201);
    const createdNote = await createdNoteResponse.json();
    assert.equal(createdNote.content, "记住公式");
    assert.equal((await api("/api/notes", "POST", { content: "空位置", side: "middle" })).status, 400);
    assert.equal((await api("/api/notes", "POST", { content: "太长".repeat(126), side: "left" })).status, 400);
    const updatedNote = await api(`/api/notes/${createdNote.id}`, "PUT", { content: "复习公式" });
    assert.equal((await updatedNote.json()).content, "复习公式");
    const noteOwnerToken = token;
    const noteOtherRegistration = await api("/api/auth/register", "POST", { username: `note${Date.now()}`, password: "SmokeTest123!", inviteCode });
    assert.equal(noteOtherRegistration.status, 201);
    token = (await noteOtherRegistration.json()).token;
    assert.deepEqual(await (await api("/api/notes")).json(), [], "第二个账户不能读取第一个账户的便签");
    assert.equal((await api(`/api/notes/${createdNote.id}`, "PUT", { content: "越权编辑" })).status, 404);
    assert.equal((await api(`/api/notes/${createdNote.id}`, "DELETE")).status, 404);
    token = noteOwnerToken;
    assert.equal((await api(`/api/notes/${createdNote.id}`, "DELETE")).status, 200);
    assert.deepEqual(await (await api("/api/notes")).json(), []);
    const retainedNote = await (await api("/api/notes", "POST", { content: "保留在左侧", side: "left" })).json();
    assert.equal((await api("/api/ai-plan", "POST", { goal: "学高数", startDate: "2026-10-12", endDate: "2026-11-12", background: "基础一般", currentTasks: [], preciseTime: false, preferredWindow: "上午" })).status, 503, "未配置密钥时规划接口应返回明确提示");
    const invalidAiImage = await api("/api/ai/parse-schedule", "POST", { image: "无效图片" });
    assert.equal(invalidAiImage.status, 400, "AI 图片接口应拒绝无效文件");
    const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
    const unconfiguredAi = await api("/api/ai/parse-schedule", "POST", { image: tinyPng });
    assert.equal(unconfiguredAi.status, 503, "未配置 API Key 时应返回可理解的提示，且不调用模型");
    const afterAi = await (await api("/api/sync")).json();
    assert.deepEqual(afterAi.tasks, [], "图片解析接口不能自动保存日程");
    const category = { id: "reading", name: "阅读", color: "#a48eb8" };
    const repeat = { id: "repeat-1", categoryId: category.id, categoryName: category.name, name: "每天读书", date: "2026-10-10", endDate: "2026-10-12", duration: 30, reminder: 15, timeMode: "fixed", time: "09:00", note: "读十页", review: false, recurrence: { type: "daily", weekdays: [] }, deletedOffsets: [], draftForm: null, events: [0, 1, 2].map((offset) => ({ id: `repeat-event-${offset}`, offset, round: -1, date: addDays("2026-10-10", offset), time: "09:00", duration: 30, completed: false })) };
    const settings = { offsets: [0, 1, 2, 4, 7, 15, 30], defaultTime: "09:00", holidays: [] };
    let data = { categories: [category], settings, tasks: [repeat], drafts: [] };
    let response = await api("/api/sync", "PUT", data);
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual((await (await api("/api/notes")).json()).map((note) => note.id), [retainedNote.id], "任务快照同步不能清空独立便签表");
    for (let index = 1; index < 30; index++) assert.equal((await api("/api/notes", "POST", { content: `便签${index}`, side: "left" })).status, 201);
    assert.equal((await api("/api/notes", "POST", { content: "第31条", side: "left" })).status, 400, "单用户最多 30 条便签");
    response = await api("/api/export/ics", "POST");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /^text\/calendar; charset=utf-8/i);
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="qingxu.ics"');
    const firstICS = await response.text();
    assert.equal((firstICS.match(/BEGIN:VEVENT/g) || []).length, 1, "每日重复应是一个 VEVENT");
    assert.match(firstICS, /RRULE:FREQ=DAILY;UNTIL=20261012T155959Z/);
    assert.match(firstICS, /DTSTART;TZID=Asia\/Shanghai:20261010T090000/);
    const weekly = { ...repeat, id: "weekly-check", date: "2026-10-13", endDate: "2026-10-22", recurrence: { type: "weekly", weekdays: ["MO", "WE"] }, events: ["2026-10-14", "2026-10-19", "2026-10-21"].map((date, index) => ({ ...repeat.events[0], id: `weekly-${index}`, date })) };
    const weeklyICS = makeICS({ categories: [category], tasks: [weekly] });
    assert.match(weeklyICS, /DTSTART;TZID=Asia\/Shanghai:20261014T090000/);
    assert.match(weeklyICS, /RRULE:FREQ=WEEKLY;BYDAY=MO,WE;/);
    const monthly = { ...repeat, id: "monthly-check", date: "2026-01-31", endDate: "2026-03-31", recurrence: { type: "monthly", weekdays: [] }, events: [{ ...repeat.events[0], date: "2026-01-31" }, { ...repeat.events[1], date: "2026-03-31" }] };
    assert.match(makeICS({ categories: [category], tasks: [monthly] }), /RRULE:FREQ=MONTHLY;BYMONTHDAY=31;/);
    const yearly = { ...repeat, id: "yearly-check", date: "2024-02-29", endDate: "2028-02-29", recurrence: { type: "yearly", weekdays: [] }, events: [{ ...repeat.events[0], date: "2024-02-29" }, { ...repeat.events[1], date: "2028-02-29" }] };
    assert.match(makeICS({ categories: [category], tasks: [yearly] }), /RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;/);
    const deletedOnce = { ...repeat, events: [repeat.events[0], repeat.events[2]] };
    assert.match(makeICS({ categories: [category], tasks: [deletedOnce] }), /EXDATE;TZID=Asia\/Shanghai:20261011T090000/);
    // 全天日程在 Apple Calendar 中必须使用 DATE 值，结束日期为不包含在内的次日。
    const allDayCategory = { id: "all-day", name: "全天", color: "#85aaa2" };
    const allDay = { ...repeat, id: "all-day-check", categoryId: allDayCategory.id, categoryName: allDayCategory.name,
      name: "整天阅读", date: "2026-10-10", endDate: "2026-10-12", duration: 1, reminder: 0, time: "00:00", allDay: true,
      events: [0, 1, 2].map((offset) => ({ id: `all-day-${offset}`, offset, round: -1, date: addDays("2026-10-10", offset), time: "00:00", duration: 1, completed: false })) };
    const allDayICS = makeICS({ categories: [allDayCategory], tasks: [allDay] });
    assert.match(allDayICS, /DTSTART;VALUE=DATE:20261010\r\nDTEND;VALUE=DATE:20261011/);
    assert.match(allDayICS, /RRULE:FREQ=DAILY;UNTIL=20261012/);
    assert.doesNotMatch(allDayICS, /DTSTART;TZID=Asia\/Shanghai|BEGIN:VALARM/);
    const allDayReview = { ...allDay, id: "all-day-review", review: true, recurrence: { type: "none", weekdays: [] }, events: [
      { ...allDay.events[0], round: 0 }, { ...allDay.events[1], round: 1 }] };
    assert.equal((makeICS({ categories: [allDayCategory], tasks: [allDayReview] }).match(/BEGIN:VEVENT/g) || []).length, 2);
    // AI 父任务与子任务是两条独立记录；子任务名称写在自己的备注里。
    const group = { ...allDayReview, id: "group-check", name: "完成高数上册并掌握常见题型", planGroup: true, note: "学习目标：完成高数上册并掌握常见题型", parentTaskId: null };
    const childTask = { ...allDayReview, id: "child-check", name: "复习极限", planGroup: false, review: false, parentTaskId: group.id,
      note: "子任务：复习极限\n阶段：第一阶段", events: [{ ...allDayReview.events[0], id: "child-event-check" }] };
    response = await api("/api/sync", "PUT", { categories: [category, allDayCategory], settings, tasks: [repeat, group, childTask], drafts: [] });
    assert.equal(response.status, 200, await response.text());
    const savedTasks = (await (await api("/api/sync")).json()).tasks;
    const savedGroup = savedTasks.find((task) => task.id === "group-check");
    const savedChild = savedTasks.find((task) => task.id === "child-check");
    assert.equal(savedGroup.allDay, true);
    assert.equal(savedGroup.planGroup, true);
    assert.doesNotMatch(savedGroup.note, /复习极限/);
    assert.equal(savedChild.parentTaskId, savedGroup.id);
    assert.match(savedChild.note, /复习极限/);
    assert.equal((await api("/api/tasks/group-check", "DELETE")).status, 200);
    const afterParentDelete = (await (await api("/api/sync")).json()).tasks.find((task) => task.id === "child-check");
    assert.equal(afterParentDelete.parentTaskId, null, "删除父任务不应删除独立子任务");
    data = { categories: [category], settings, tasks: [repeat], drafts: [] };
    response = await api("/api/sync", "PUT", data);
    assert.equal(response.status, 200, await response.text());
    for (let attempt = 0; attempt < 20 && !fs.existsSync(historyFile); attempt++) await sleep(50);
    const history = JSON.parse(fs.readFileSync(historyFile, "utf8"));
    assert(Object.values(history.users).some((entry) => entry.exportedTaskIds.includes(repeat.id)));
    // 导出历史属于当前账户，另一个账户不能继承第一位用户的已导出 ID。
    const firstToken = token;
    const secondRegistration = await api("/api/auth/register", "POST", { username: `other${Date.now()}`, password: "SmokeTest123!", inviteCode });
    assert.equal(secondRegistration.status, 201);
    token = (await secondRegistration.json()).token;
    const otherHistory = await (await api("/api/export/history")).json();
    assert.deepEqual(otherHistory.exportedTaskIds, []);
    token = firstToken;
    response = await api("/api/export/ics", "POST");
    assert.equal(response.status, 204, "第二次导出不应包含旧任务");
    const review = { ...repeat, id: "review-1", name: "背单词", date: "2026-10-13", endDate: "2026-11-12", review: true, recurrence: { type: "none", weekdays: [] }, events: settings.offsets.map((offset, round) => ({ id: `review-event-${offset}`, offset, round, date: addDays("2026-10-13", offset), time: "09:00", duration: 30, completed: false })) };
    data = { ...data, tasks: [repeat, review] };
    response = await api("/api/sync", "PUT", data);
    assert.equal(response.status, 200, await response.text());
    response = await api("/api/export/ics", "POST");
    const incrementalICS = await response.text();
    assert.equal((incrementalICS.match(/BEGIN:VEVENT/g) || []).length, 7, "艾宾浩斯新增任务应保留七个不规则事件");
    assert.doesNotMatch(incrementalICS, /RRULE:/);
    response = await api("/api/export/history", "DELETE");
    assert.equal(response.status, 200);
    response = await api("/api/export/ics", "POST");
    const fullICS = await response.text();
    assert.equal((fullICS.match(/BEGIN:VEVENT/g) || []).length, 8, "清空记录后应完整导出");
    assert.match(fullICS, /RRULE:FREQ=DAILY/);
    console.log(`通过：服务启动、RRULE 单事件、艾宾浩斯七节点、增量导出、重置导出记录（端口 ${port}）`);
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    // 只清理本测试在系统临时目录里创建的确定路径。
    const resolved = fs.realpathSync(temp);
    if (resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
