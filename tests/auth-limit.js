// 登录 / 注册限流端到端测试：临时库、随机端口，不触碰真实账户。
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const port = await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "qingxu-auth-limit-"));
  const env = { ...process.env, HOST: "127.0.0.1", PORT: String(port), QINGXU_DATA_DIR: temp,
    QINGXU_EXPORT_HISTORY_FILE: path.join(temp, "export_history.json"), TRUST_PROXY: "true",
    REGISTER_MAX_ATTEMPTS: "3", REGISTER_WINDOW_MINUTES: "10", LOGIN_MAX_ATTEMPTS: "3", LOGIN_WINDOW_MINUTES: "10" };
  const child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const api = (route, body, ip = "192.0.2.1") => fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: JSON.stringify(body)
  });
  const password = "AuthLimitTest123!";
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw Error(`服务提前退出：${output}`);
      try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) { ready = true; break; } } catch { /* 等待启动。 */ }
      await sleep(100);
    }
    assert(ready, `服务未能启动：${output}`);
    const inviteCode = await new Promise((resolve, reject) => {
      const cli = spawn(process.execPath, [path.join(root, "scripts", "admin.js"), "invite", "generate", "10", "auth-limit-test"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      cli.stdout.on("data", (chunk) => { output += chunk; });
      cli.stderr.on("data", (chunk) => { output += chunk; });
      cli.once("error", reject);
      cli.once("close", (code) => code === 0 ? resolve((output.match(/QX-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/) || [])[0]) : reject(Error(output)));
    });
    assert(inviteCode, "管理 CLI 应生成邀请码");
    const register = (username, code = inviteCode, ip) => api("/api/auth/register", { username, password, inviteCode: code }, ip);
    // 无效邀请码也占注册额度，用另一 IP 验证，主 IP 留三次给 A / 重名 / B。
    assert.equal((await register("invalid_invite", "QX-0000-0000-0000", "192.0.2.2")).status, 403);
    assert.equal((await register("user_A")).status, 201);
    assert.equal((await register("user_A")).status, 409);
    assert.equal((await register("user_B")).status, 201);
    const registerLimit = await register("user_C");
    assert.equal(registerLimit.status, 429);
    const registerData = await registerLimit.json();
    assert.match(registerData.error, /注册尝试过于频繁/);
    assert.equal(registerData.code, undefined, "注册 429 不增加 code");

    const login = (secret, ip) => api("/api/auth/login", { username: "user_A", password: secret }, ip);
    assert.equal((await api("/api/auth/login", { username: "user_A" })).status, 400, "未填写密码不占额度");
    for (let i = 0; i < 3; i++) assert.equal((await login("WrongPassword123!")).status, 401, "注册限流不消耗登录额度");
    const loginLimit = await login(password);
    assert.equal(loginLimit.status, 429, "即使密码正确也应在登录验证前被限流");
    assert(Number(loginLimit.headers.get("Retry-After")) > 0, "应有 Retry-After");
    const loginData = await loginLimit.json();
    assert.equal(loginData.code, "LOGIN_RATE_LIMITED");
    assert.match(loginData.error, /登录尝试过于频繁/);
    assert.notEqual(loginData.error, registerData.error);
    // 另一 IP：成功登录应清零，否则第二轮的第三次请求会被挡。
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 2; i++) assert.equal((await login("WrongPassword123!", "192.0.2.3")).status, 401);
      assert.equal((await login(password, "192.0.2.3")).status, 200, "成功登录应清零");
    }
    console.log("通过：注册 403/201/409/201/429、登录三次 401 后正确密码 429、Retry-After、独立 IP 计数、成功登录清零");
  } finally {
    const closed = new Promise((resolve) => child.once("close", resolve));
    if (child.exitCode === null) { child.kill(); await closed; }
    // 仅递归删除本测试在系统临时目录中创建且核对过的绝对路径。
    const resolved = fs.realpathSync(temp);
    if (resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
