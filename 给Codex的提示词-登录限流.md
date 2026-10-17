# 任务：登录尝试加同 IP 限流，高频直接 429（不进邀请码校验与 bcrypt）

仓库 `D:\清序网站\web-calendar`（无构建，`npm start` 起在 3000；**后端改动必须重启 Node 进程**）。只改根目录文件，不动 `web-calendar\web-calendar\` 副本。

## 现状
- 注册已有同 IP 滑动窗口限流：`server.js:212-238`（`registerAttempts` / `clientIp` / `allowRegister`），`/api/auth/register` 在邀请码校验与 `bcrypt.hash` 之前调用（`server.js:253-261`）。
- 登录 `/api/auth/login`（`server.js:274-286`）**无任何限制**：每次都查库 + `bcrypt.compare`（cost 12），脚本可高频刷密码并吃满 CPU。
- 前端 `auth.js:148-163` 只在请求期间禁用按钮，无频率反馈。

## 需求一：后端限流前置（`server.js`）
1. **抽公共滑动窗口**：`takeAttempt(store, ip, max, windowMs) → { allowed, retryAfterMs }`，语义与现有 `allowRegister` 完全一致（剔除窗口外时间戳；**超限请求不写入时间戳**，避免自我延长封锁；`store.size > 10000` 时清理过期 key 到 ≤5000）。`allowRegister` 改用它，注册行为、env、文案、状态码都不变；`clientIp` 原样共用。
2. **两套计数**：`registerAttempts` 不变；新增 `loginAttempts`，登录与注册不互相消耗额度。
3. **env**：`LOGIN_WINDOW_MINUTES` 默认 10、`LOGIN_MAX_ATTEMPTS` 默认 10，写在 `server.js:42-43` 旁并沿用 `envNum`。
4. **`/api/auth/login` 顺序（关键）**：校验 password 存在 → `takeAttempt(loginAttempts, clientIp(req), LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MINUTES*60000)`；超限立刻 `res.setHeader("Retry-After", Math.max(1, Math.ceil(retryAfterMs/1000)))` 并 `429 { error: "登录尝试过于频繁，请 N 分钟后再试。", code: "LOGIN_RATE_LIMITED" }`，**不查 users、不做 dummy `bcrypt.compare`**（`server.js:279-281` 是纯 CPU 消耗，正是要跳过的）。未超限才走原逻辑，并保留对不存在账户的 dummy 哈希比较（防账户枚举时间差）。
5. **成功清零**：`user && matches` 时 `loginAttempts.delete(clientIp(req))`，正常用户不被自己先前的错尝试卡住；失败不清零。
6. 注册 429 **不加 `code`**、文案不变（`server.js:255`）。

## 需求二：前端（`auth.js` + `index.html`）
1. `request()`（`auth.js:76-85`）把限流头挂到错误上：`retryAfter: Number(response.headers.get("Retry-After")) || 0`。
2. `submit()` 的 catch 新增 `if (error.status === 429)`：显示服务端文案，按钮按 `retryAfter || 60` 秒倒计时（按钮文案 `请等待 N 秒`，归零后恢复 `登录` / `创建账户`）；**不清空已填用户名与密码、不跳页、不 alert**。
3. ⚠️ 现有 `finally { button.disabled = false }`（`auth.js:162`）会立刻解禁，倒计时分支必须自行管理禁用状态（如 `lockUntil` 时间戳判断），否则限流形同虚设。
4. `index.html` 里 `auth.js?v=3` → `?v=4`。

## 需求三：测试
新建 `tests/auth-limit.js`：自起服务（随机端口 + 临时 `QINGXU_DATA_DIR`，env `REGISTER_MAX_ATTEMPTS=3`、`LOGIN_MAX_ATTEMPTS=3`），邀请码用 `scripts/admin.js invite generate 10` 生成（沿用 `tests/smoke.js` 的 CLI 模式），按序断言：
1. 注册：无效邀请码 → 403；有效邀请码 → 201（用户 A）；同名再注册 → 409；另生成用户 B → 201；再注册 → **429 且文案含「注册尝试过于频繁」**。
2. 登录：用户 A 错密码 3 次 → 各 401；第 4 次**正确密码 → 429**，`code === "LOGIN_RATE_LIMITED"` 且有 `Retry-After`（正确密码被挡，证明限流先于查库与 bcrypt）。
3. 上述登录 429 与注册 429 文案不同（证明两套计数独立）。
4. 结束前 kill 子进程、删临时目录。

`package.json` 的 `test` 链追加 `&& node tests/auth-limit.js`；`tests/smoke.js:41` 的 env 加 `LOGIN_MAX_ATTEMPTS: "1000"`（冒烟会多次登录）。`npm test` 全绿。

## 需求四：文档
- `.env.example`：`REGISTER_*`（`:13-16`）后加 `LOGIN_WINDOW_MINUTES=10` / `LOGIN_MAX_ATTEMPTS=10` 及注释（说明成功登录清零、计数与注册独立）。
- `README.md`：限流段落（`:170-172`）补登录限流规则；配置表（`:220-222`）加两行。

## 约束与交付
不加依赖 / 接口 / 数据表；不改 JWT、会话、邀请码逻辑、注册错误文案，不动 `/api/sync`。限流仍是进程内滑动窗口（重启清零，README 一句话说明）。交付：① 改动文件清单（含行号范围）；② `npm test` 输出；③ 手工验证：默认阈值下连续 10 次登录失败后，第 11 次即使密码正确也返回 429 且带 `Retry-After`，前端按钮进入倒计时；④ 是否重启过 Node、`?v=` 提到多少。
