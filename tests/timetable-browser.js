// 可选浏览器验收：使用已有 Playwright 与本机 Chrome，无新增项目依赖。
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { chromium } = require("playwright");
const { defaultTimetable } = require("../timetable");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = path.resolve(__dirname, "..");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "qingxu-timetable-browser-"));
  const port = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), QINGXU_DATA_DIR: path.join(temp, "data"), QINGXU_EXPORT_HISTORY_FILE: path.join(temp, "history.json"), DASHSCOPE_API_KEY: "", DEEPSEEK_API_KEY: "" };
  const child = spawn(process.execPath, ["server.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", browser;
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      try { if ((await fetch(base)).ok) break; } catch { /* 等待临时服务器。 */ }
      if (child.exitCode !== null) throw Error(output);
      await sleep(100);
    }
    const cli = spawnSync(process.execPath, ["scripts/admin.js", "invite", "generate", "1", "browser-test"], { cwd: root, env, encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    const inviteCode = cli.stdout.match(/QX-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/)[0];
    const credentials = { username: `browser${Date.now()}`, password: "BrowserTest123!" };
    const registration = await fetch(`${base}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...credentials, inviteCode }) });
    assert.equal(registration.status, 201);
    const account = await registration.json();
    const headers = { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" };
    const remote = async () => (await fetch(`${base}/api/sync`, { headers })).json();
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    async function login(target) {
      await target.goto(base);
      await target.locator("#auth-username").fill(credentials.username);
      await target.locator("#auth-password").fill(credentials.password);
      await target.locator("#auth-submit").click();
      await target.waitForFunction(() => !document.body.classList.contains("signed-out"));
      await target.locator('[data-view="ocr"]').click();
      await target.waitForFunction(() => document.querySelectorAll(".timetable-period").length > 0);
    }
    async function saveTimetable() {
      const uploaded = page.waitForResponse((response) => response.url().endsWith("/api/sync") && response.request().method() === "PUT");
      await page.locator('#timetable-body button[type="submit"]').click();
      assert.equal((await uploaded).status(), 200);
    }
    await login(page);
    assert.equal(await page.locator(".timetable-period").count(), 12);
    await page.locator("#timetable-toggle").click();
    assert(await page.locator("#timetable-body").isHidden());
    await page.locator("#timetable-toggle").click();
    await page.locator("#timetable-count").fill("14");
    await page.locator("#timetable-count").press("Tab");
    assert.equal(await page.locator(".timetable-period").count(), 14);
    assert.equal(await page.locator(".timetable-start").nth(12).inputValue(), "20:40");
    await page.locator("#timetable-count").fill("2");
    await page.locator("#timetable-count").press("Tab");
    assert.match(await page.locator("#timetable-status").textContent(), /截断/);
    await page.locator("#timetable-duration").fill("60");
    await page.locator("#timetable-break").fill("10");
    await page.locator("#timetable-reflow").click();
    assert.equal(await page.locator(".timetable-start").nth(1).inputValue(), "09:10");
    await page.locator(".timetable-delete").first().click();
    assert.equal(await page.locator(".timetable-period").count(), 1);
    assert(await page.locator(".timetable-delete").isDisabled());
    await page.locator("#timetable-add").click();
    assert.equal(await page.locator(".timetable-start").nth(1).inputValue(), "10:20");
    await page.locator(".timetable-end").first().fill("09:10");
    await page.locator('#timetable-body button[type="submit"]').click();
    assert(await page.locator("#timetable-error").isVisible());
    assert.equal((await remote()).settings.timetable.periods.length, 12);
    await page.locator("#timetable-default").click();
    await page.locator(".timetable-start").first().fill("07:30");
    await page.locator(".timetable-end").first().fill("08:15");
    await saveTimetable();
    await page.reload();
    await page.locator('[data-view="ocr"]').click();
    assert.equal(await page.locator(".timetable-start").first().inputValue(), "07:30");
    const secondContext = await browser.newContext();
    const second = await secondContext.newPage();
    await login(second);
    assert.equal(await second.locator(".timetable-start").first().inputValue(), "07:30");
    await second.locator("#logout-button").click();
    await login(second);
    assert.equal(await second.locator(".timetable-start").first().inputValue(), "07:30");
    await secondContext.close();

    let choosers = 0;
    page.on("filechooser", () => { choosers++; });
    for (const block of await page.locator(".ocr-source-column > span").all()) {
      const box = await block.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await block.evaluate((element) => element.focus());
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
    }
    assert.equal(choosers, 0, "文字块的点击和键盘均不能打开文件选择");
    for (const [selector, key] of [["#ocr-add-local", "Enter"], ["#ocr-add-camera", "Space"]]) {
      const choosing = page.waitForEvent("filechooser");
      await page.locator(selector).focus();
      await page.keyboard.press(key);
      const chooser = await choosing;
      assert.equal(await chooser.element().getAttribute("id"), selector.endsWith("local") ? "ocr-file" : "ocr-camera");
      await chooser.setFiles([]);
    }
    assert.equal(choosers, 2);
    assert.equal(await page.locator("#ocr-camera").getAttribute("capture"), "environment");
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64");
    await page.locator("#ocr-file").setInputFiles({ name: "schedule.png", mimeType: "image/png", buffer: image });
    await page.waitForFunction(() => document.querySelector("#ocr-status").textContent.includes("图片已就绪"));
    let parseFails = true, parsedTimetable;
    await page.route("**/api/ai/parse-schedule", async (route) => {
      parsedTimetable = route.request().postDataJSON().timetable;
      await sleep(150);
      await route.fulfill({ status: parseFails ? 422 : 200, contentType: "application/json", body: JSON.stringify(parseFails ? { error: "测试解析失败" } : { isValid: true, courses: [{ courseName: "测试课程", weekday: "星期一", sectionStart: 1, sectionEnd: 2, teacher: "老师", location: "教室", weekRange: "1" }] }) });
    });
    await page.locator("#ocr-start").click();
    assert(await page.locator("#ocr-add-local").isDisabled());
    assert(await page.locator("#ocr-add-camera").isDisabled());
    assert(await page.locator("#ocr-file").isDisabled());
    await page.waitForFunction(() => !document.querySelector("#ocr-error").hidden);
    assert.match(await page.locator("#ocr-error").textContent(), /测试解析失败/);
    parseFails = false;
    await page.locator("#ocr-start").click();
    await page.locator("#ai-course-list .ai-course-row").waitFor();
    assert.equal(parsedTimetable.periods[0].start, "07:30");
    assert.equal(await page.locator("#ai-section-times").count(), 0);
    await page.locator("#ai-term-monday").fill("2026-10-12");
    await page.locator(".ai-course-end").fill("15");
    await page.locator("#ai-draft-confirm").click();
    await page.locator("#ai-draft-error").waitFor();
    assert.match(await page.locator("#ai-draft-error").textContent(), /先修改并保存作息表/);
    assert(await page.locator("#ocr-error").isHidden());
    assert(await page.locator("#ai-draft-error").evaluate((element) => element.nextElementSibling.id === "ai-draft-confirm"));
    await page.waitForFunction(() => { const rect = document.querySelector("#ai-draft-error").getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator("#ai-draft-error").scrollIntoViewIfNeeded();
      assert(await page.locator("#ai-draft-confirm").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return element === hit || element.contains(hit);
      }), "确认按钮不能被署名等浮层遮挡");
      if (process.env.QINGXU_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.QINGXU_SCREENSHOT_DIR, `timetable-draft-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator(".ai-course-end").fill("2");
    // 2028 年还没有内置放假安排，仍应提示先补充节假日。
    await page.locator("#ai-term-monday").fill("2028-10-09");
    await page.locator("#ai-draft-confirm").click();
    assert.match(await page.locator("#ai-draft-error").textContent(), /尚未配置.*节假日/);
    await page.locator("#ai-term-monday").fill("2026-10-12");
    await page.locator(".timetable-start").first().fill("07:00");
    await saveTimetable();
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      window.restoreTestStorage = () => { Storage.prototype.setItem = original; };
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("qingxu-cache-v2-")) throw new DOMException("测试存储空间不足", "QuotaExceededError");
        return original.call(this, key, value);
      };
    });
    await page.locator("#ai-draft-confirm").click();
    assert.match(await page.locator("#ai-draft-error").textContent(), /无法写入.*离线缓存/);
    assert.equal((await remote()).tasks.length, 0);
    assert(!(await page.locator("#notice-dialog").evaluate((element) => element.open)), "导入保存失败不能只显示远处的提示或弹窗");
    await page.evaluate(() => { window.restoreTestStorage(); delete window.restoreTestStorage; });
    // 服务端拒绝保存时保留草稿、回滚任务，在确认按钮上方报错。
    let rejectSave = true;
    await page.route("**/api/sync", async (route) => {
      if (rejectSave && route.request().method() === "PUT") {
        rejectSave = false;
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "测试保存失败" }) });
      } else await route.continue();
    });
    await page.locator("#ai-draft-confirm").click();
    await page.waitForFunction(() => document.querySelector("#ai-draft-error").textContent.includes("测试保存失败"));
    assert.equal((await remote()).tasks.length, 0);
    assert(await page.locator("#ai-schedule-draft").isVisible());
    await page.unroute("**/api/sync");
    await page.locator("#ai-draft-confirm").click();
    await page.waitForFunction(() => document.querySelector("#ai-schedule-draft").hidden);
    const imported = (await remote()).tasks;
    assert.equal(imported.length, 1);
    assert.equal(imported[0].time, "07:00", "确认时读取最新作息表，不能使用解析时快照");
    assert.equal(imported[0].duration, 155);
    assert.equal(imported[0].events[0].time, "07:00");
    assert.equal(await page.locator("#ocr-file").inputValue(), "");
    assert(await page.locator("#ocr-add-local").isEnabled());

    // 旧用户缓存、断网待同步恢复并联网回传。
    await page.evaluate((userId) => {
      const key = `qingxu-cache-v2-${userId}`;
      const cached = JSON.parse(localStorage.getItem(key));
      delete cached.settings.timetable;
      localStorage.setItem(key, JSON.stringify(cached));
      localStorage.setItem(`qingxu-pending-v2-${userId}`, "1");
    }, account.user.id);
    // 仅中断账户校验请求，页面资源仍加载，真实走离线缓存恢复分支。
    await page.route("**/api/auth/me", (route) => route.abort("internetdisconnected"));
    await page.reload();
    await page.locator('[data-view="ocr"]').click();
    assert.equal(await page.locator(".timetable-start").first().inputValue(), "08:00");
    assert.equal(await page.evaluate((userId) => localStorage.getItem(`qingxu-pending-v2-${userId}`), account.user.id), "1");
    await page.unroute("**/api/auth/me");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForFunction((userId) => !localStorage.getItem(`qingxu-pending-v2-${userId}`), account.user.id);
    assert.equal((await remote()).tasks.length, 1, "旧待同步快照不能丢失任务");
    assert.deepEqual((await remote()).settings.timetable, defaultTimetable());
    await page.waitForFunction(() => !document.querySelector("#toast").classList.contains("show"));
    const screenshots = process.env.QINGXU_SCREENSHOT_DIR;
    if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px 页面不能横向溢出`);
      assert(await page.locator(".timetable-period").first().isVisible());
      assert(await page.locator("#ocr-add-camera").isVisible());
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `timetable-${width}.png`), fullPage: true });
    }
    // 2027 年已内置元旦节假日：导入课程不再提示「尚未配置」，可以直接生成任务。
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator("#ocr-file").setInputFiles({ name: "schedule.png", mimeType: "image/png", buffer: image });
    await page.waitForFunction(() => document.querySelector("#ocr-status").textContent.includes("图片已就绪"));
    await page.locator("#ocr-start").click();
    await page.locator("#ai-course-list .ai-course-row").waitFor();
    await page.locator("#ai-term-monday").fill("2027-10-11");
    await page.locator("#ai-draft-confirm").click();
    await page.waitForFunction(() => document.querySelector("#ai-schedule-draft").hidden);
    assert.equal((await remote()).tasks.length, 2, "2027 年课程应能正常建立");
    assert.deepEqual(errors, []);
    console.log("通过：浏览器作息表编辑/保存/刷新/重新登录/跨浏览器、加号键盘选择、解析与导入报错位置/滚动、最新作息表换算、保存失败回滚、旧缓存同步、2027 年导入不再提示补充节假日、1440/390/320px 布局");
  } finally {
    if (browser) await browser.close();
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    const resolved = fs.realpathSync(temp);
    if (resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
