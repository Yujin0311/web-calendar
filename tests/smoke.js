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
    cwd: root, env: { ...process.env, PORT: String(port), QINGXU_DATA_DIR: path.join(temp, "data"), QINGXU_EXPORT_HISTORY_FILE: historyFile }, stdio: ["ignore", "pipe", "pipe"]
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
    const registration = await api("/api/auth/register", "POST", { username: `smoke${Date.now()}`, password: "SmokeTest123!" });
    const registrationData = await registration.json();
    assert.equal(registration.status, 201, JSON.stringify(registrationData));
    token = registrationData.token;
    const category = { id: "reading", name: "阅读", color: "#a48eb8" };
    const repeat = { id: "repeat-1", categoryId: category.id, categoryName: category.name, name: "每天读书", date: "2026-10-10", endDate: "2026-10-12", duration: 30, reminder: 15, timeMode: "fixed", time: "09:00", note: "读十页", review: false, recurrence: { type: "daily", weekdays: [] }, deletedOffsets: [], draftForm: null, events: [0, 1, 2].map((offset) => ({ id: `repeat-event-${offset}`, offset, round: -1, date: addDays("2026-10-10", offset), time: "09:00", duration: 30, completed: false })) };
    const settings = { offsets: [0, 1, 2, 4, 7, 15, 30], defaultTime: "09:00", holidays: [] };
    let data = { categories: [category], settings, tasks: [repeat], drafts: [] };
    let response = await api("/api/sync", "PUT", data);
    assert.equal(response.status, 200, await response.text());
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
    for (let attempt = 0; attempt < 20 && !fs.existsSync(historyFile); attempt++) await sleep(50);
    const history = JSON.parse(fs.readFileSync(historyFile, "utf8"));
    assert(Object.values(history.users).some((entry) => entry.exportedTaskIds.includes(repeat.id)));
    // 导出历史属于当前账户，另一个账户不能继承第一位用户的已导出 ID。
    const firstToken = token;
    const secondRegistration = await api("/api/auth/register", "POST", { username: `other${Date.now()}`, password: "SmokeTest123!" });
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
