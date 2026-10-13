# 清序 · 第三次维修迭代

在第一版原生前端基础上增加 Node.js、Express、SQLite 和 JWT 登录。日历预览、草稿箱、复习节点、冲突提示、课程节假日、CSV/ICS 导出均保留。

## Windows 本地启动

1. 从 [Node.js 官网](https://nodejs.org/en/download)安装当前受支持的 LTS 版本（建议 Node.js 24），并确认 PowerShell 中 `node -v`、`npm -v` 可运行。
2. 在本项目文件夹打开 PowerShell，运行 `npm install`。
3. 运行 `npm start`，看到 `清序已启动：http://localhost:3000` 后，在浏览器打开该地址。
4. 首次使用先注册账户，再登录使用。以后启动只需运行 `npm start`。本版需要后端，不能直接双击 `index.html` 运行。

数据库和本机 JWT 密钥保存在 `data/` 文件夹，已被 `.gitignore` 排除。备份账户数据时，请在停止服务后备份整个 `data/` 文件夹。请勿把它公开上传。

## SQLite 表

| 表 | 主要字段 | 用途 |
|---|---|---|
| `users` | `id`, `username`（唯一）, `password_hash`, `created_at` | 账户和 bcrypt 加盐哈希密码 |
| `sessions` | `jti`, `user_id`, `expires_at`, `created_at`, `last_activity_at`, `expire_at` | JWT 会话与退出失效；最后活跃时间与绝对过期时间（毫秒时间戳）用于空闲/绝对双重超时 |
| `invite_codes` | `id`, `code`（唯一）, `max_use_count`, `used_count`, `is_active`, `created_at`, `note` | 注册邀请码：可限制使用次数、随时停用，备注方便管理 |
| `categories` | `id`, `user_id`, `name`, `color` | 用户独立分类 |
| `user_settings` | `user_id`, `offsets_json`, `default_time`, `holidays_json` | 复习和节假日设置 |
| `tasks` | `id`, `user_id`, `category_id`, `name`, `start_date`, `end_date`, `duration`, `reminder`, `time_mode`, `start_time`, `note`, `review`, `all_day`, `plan_group`, `parent_task_id`, `repeat_type`, `repeat_weekdays_json`, `deleted_offsets_json`, `draft_form_json`, `status` | 任务、全天标记、AI 父子关联、重复设置和草稿 |
| `occurrences` | `id`, `user_id`, `task_id`, `offset_days`, `round_number`, `event_date`, `start_time`, `duration`, `completed` | 每条独立日程，可单独删除 |

所有任务表都带用户归属，API 按当前 JWT 用户查询或修改。前端使用 `localStorage` 中的用户专属缓存支持断网时继续查看和编辑，重新联网后同步。当前版本为单设备优先的最后写入覆盖模型，不提供多设备冲突合并。

## API 清单

除注册、登录外，均需请求头 `Authorization: Bearer <JWT>`。

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/auth/register` | 凭有效邀请码注册并获得 JWT；同 IP 高频尝试返回 429 |
| POST | `/api/auth/login` | 登录并获得 JWT |
| POST | `/api/auth/logout` | 注销当前 JWT 会话 |
| GET | `/api/auth/me` | 查询当前账户 |
| GET、PUT | `/api/sync` | 读取或整体同步用户计划；前端离线缓存使用 |
| GET、PUT | `/api/settings` | 读取、更新设置 |
| GET、POST | `/api/categories` | 列出、新增分类 |
| PUT、DELETE | `/api/categories/:id` | 修改、删除分类 |
| GET、POST | `/api/tasks` | 列出、新增任务 |
| PUT、DELETE | `/api/tasks/:id` | 修改、批量删除任务及其全部日程 |
| POST | `/api/tasks/:id/draft` | 将任务移到草稿箱 |
| PATCH、DELETE | `/api/occurrences/:id` | 修改完成状态、仅删除本次日程 |
| GET | `/api/export/history` | 查看当前账户的 ICS 导出记录 |
| POST | `/api/export/ics` | 仅导出未记录过的任务，成功响应后记入历史 |
| DELETE | `/api/export/history` | 清空当前账户的 ICS 导出记录 |
| POST | `/api/ai/parse-schedule` | 登录后提交课表图片 data URL，返回 `{ courses: [...], isValid }`；不写数据库 |
| GET、POST | `/api/notes` | 列出、新增当前用户便签（最多 30 条） |
| PUT、DELETE | `/api/notes/:id` | 编辑、删除当前用户便签（单条最多 250 字） |
| POST | `/api/ai-plan` | 接收目标、日期、基础情况、是否精确到钟点及可选高效时间段；返回待确认规划 JSON |

## 苹果日历导入说明

本版继续导出一个完整的 ICS 文件，事件标题中的分类标签和 `CATEGORIES` 字段保留。**ICS 导入不会自动创建独立苹果日历**；在 Mac 的日历 App 中导入时，请选择目标日历。如需独立日历，请先在苹果日历手动新建。

同一任务全部艾宾浩斯日程使用相同的 `SUMMARY`。用户填写的备注保持原文，后面附加「初次学习」或「复习第 N 轮」到 `DESCRIPTION`，用于区分轮次。

## 第三次维修功能

- 新建任务可以选择不重复、每天、每周（多选星期）、每月、每年。手动重复和艾宾浩斯复习互斥。手动重复的预览仍逐日展示，ICS 则写成**一个 `VEVENT` + 一个 `RRULE`**；被单独删除或因课程节假日跳过的日期以 `EXDATE` 表达。艾宾浩斯维持原有不规则间隔的逐条事件。
- ICS 下载只包含当前账户尚未导出的任务，包括任务的艾宾浩斯复习日程。导出记录写在项目根目录的 `export_history.json`，包含各账户最近导出时间和已导出的任务 ID。该文件已加入 `.gitignore`。编辑已经导出的任务后，如需重新导出，请点击「清空导出记录」。清空后下一次会导出当前计划的全部日程。
- 新建任务提示文案已更新。页面右下角增加开发者署名与送花按钮，点击后播放约 3 秒花瓣动画。

## 本地验证

在项目目录执行 `npm test`。自动冒烟测试会使用临时数据库和临时导出记录文件，不会修改真实账户；验证服务启动、每日/每周/每月/每年 RRULE、一个重复系列只含一个 VEVENT、艾宾浩斯七个独立节点、第二次导出为空、清空记录后重新完整导出。再执行 `npm start` 并访问 `http://localhost:3000` 检查页面交互。

## 图片 AI 日程解析

登录后打开「图片识别导入」，上传一张大学周课表 JPG、PNG、GIF 或 WebP 图片（不超过 6 MB），点击「AI 解析日程」。后端通过 OpenAI Node.js SDK 调用 DeepSeek `deepseek-flash` 视觉模型，30 秒超时，一次返回整张课表的课程数组。用户可逐项核对、修正、勾选课程，填写学期第 1 周的周一日期，以及相关节次的开始和结束时间，点击「确认并批量生成日程」后才写入数据库。课程按识别到的周次生成每周日程；缺失或无法辨认的日期、节次和周次需要人工补齐。图片会发送给 DeepSeek API，不会保存在本项目数据库中。

1. 在 [DeepSeek 开放平台](https://platform.deepseek.com/)注册或登录，在平台的 API Keys 页面创建密钥。
2. 本地开发：复制 `.env.example` 为项目根目录的 `.env`，把 `DEEPSEEK_API_KEY=` 后的占位文字替换成真实密钥。运行 `npm install`、`npm start`。`.env` 已在 `.gitignore` 中，请勿提交密钥。也可以直接在系统环境变量中设置 `DEEPSEEK_API_KEY`。
3. Render 部署：打开对应 Web Service 的 **Environment → Environment Variables → Add Environment Variable**，键填 `DEEPSEEK_API_KEY`，值填真实密钥；另设 `HOST=0.0.0.0` 以允许 Render 代理访问，`PORT` 使用 Render 自动提供的值。保存并重新部署。不要把密钥写进代码或提交到 Git。

原先的本地纯文本识别流程已移除。AI 解析结果可能有遗漏或误读，保存前请人工核对。未配置密钥时，其他手动日程功能仍可使用，图片解析会显示中文配置提示。

## 随手便签与 AI 规划助手

登录后，PC 页面左侧有随手便签栏，可新增、编辑和删除。每个账户最多 30 条，单条最多 250 字，前端和后端均校验。便签保存在 SQLite 的 `notes` 表，接口只使用 JWT 所属用户的 `user_id` 查询；旧数据中的右侧便签也统一显示在左侧。移动端暂不展示侧栏。便签不进入任务快照 `/api/sync`。

「AI 规划助手」会将学习目标、起止日期、基础情况、当前任务摘要、是否需要精确到钟点和可选高效时间段发送给 DeepSeek。后端仅返回阶段和任务 JSON，不保存提问、回答或聊天历史。确认页可勾选部分或全部细分任务；导入后创建一条**父任务**，名称直接使用学习目标。每项勾选的子任务单独保存为任务记录，并把自身名称、阶段和 AI 复习建议写入自己的备注。父任务备注不堆放子任务列表，复习开关默认关闭，由用户在导入前手动勾选。删除父任务只解除子任务关联，不删除子任务。选择不精确到钟点时，日程使用「全天」分类，ICS 使用 `DTSTART;VALUE=DATE` 和次日 `DTEND;VALUE=DATE`；数据库内部用 `00:00` 占位，页面不显示钟点。放弃或退出时丢弃 AI 结果。

主计划的每日任务区上方可搜索当前账户全部任务的名称、分类和备注。每条搜索结果对应一条任务记录，可多选后一次删除；删除前会显示影响的任务与日程数量。草稿不包含在主计划搜索结果中。

旧数据库启动时自动执行下列幂等检查与迁移；新数据库的 `CREATE TABLE tasks` 已含对应字段：

```sql
ALTER TABLE tasks ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN plan_group INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
```

新增数据库初始化语句位于 `server.js` 的 `db.exec` 建表区：

```sql
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('left','right')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_user_side ON notes(user_id, side, created_at);
```

路由挂在 `server.js` 已有鉴权中间件之后：`GET/POST /api/notes`、`PUT/DELETE /api/notes/:id` 位于 `/api/auth/me` 后；`POST /api/ai-plan` 位于图片解析路由后。所有新接口均使用现有 `auth` 中间件。

## 邀请码注册与会话过期清理

为防止低配 VPS 被脚本恶意批量注册撑爆数据库、以及僵尸会话堆积耗尽内存，注册与会话增加了两层保护。全部为增量实现，不影响既有账户与数据，也不引入 Redis 等新组件。

### 邀请码注册

注册接口必须携带有效邀请码，否则直接拒绝。校验顺序：邀请码存在且启用 → 使用次数未达上限 → 事务内创建用户并消耗次数（`used_count < max_use_count` 条件更新兜底，并发不会超用；任一步失败整体回滚）。错误提示按「需要邀请码（400）/ 邀请码无效（403）/ 邀请码已用完（403）/ 请求过于频繁（429）」区分。

同一 IP 在 10 分钟内最多尝试注册 3 次（成功与失败都计入），超过返回 429。限流为进程内滑动窗口，服务重启后计数清零。

邀请码通过命令行维护，无需后台页面：

```powershell
npm run invite -- generate 5 "给朋友A"      # 生成邀请码，数字为最大可用次数（默认 1），后面可写备注
npm run invite -- list                      # 列出全部邀请码（已用/上限、状态、备注）
npm run invite -- disable QX-XXXX-XXXX-XXXX # 停用指定邀请码
```

### 会话双重超时与定期清理

`sessions` 表新增 `last_activity_at`（最后活跃时间）与 `expire_at`（绝对过期时间）两个毫秒时间戳字段。每次带 JWT 请求时服务端校验三重过期（原 JWT 过期、绝对超时、空闲超时），全部在服务端判断，不信任前端；通过校验后按节流间隔（默认 5 分钟）刷新 `last_activity_at`，避免高频请求写放大。

- 空闲超时：默认 24 小时无任何请求即失效；
- 绝对超时：默认 7 天，无论是否活跃强制失效；
- 定时清理：服务进程内置定时器，启动 30 秒后补跑一次，之后默认每 2 小时执行一轮。清理拆成 3 条单条件删除（分别命中 `expires_at`、`expire_at`、`last_activity_at` 三个索引），每批 100 条循环删完，避免全表扫描拖垮低配机器。

手动清理一次：

```powershell
npm run clean-sessions
```

### 配置项与迁移

以下均为可选项，写在 `.env` 中（参见 `.env.example`），未设置时使用默认值：

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `TRUST_PROXY` | `false` | 部署在 Nginx/Caddy 等反代后改为 `true`，否则限流会把所有请求算到代理 IP；直连时保持 `false` 防止伪造 `X-Forwarded-For` 绕过限流 |
| `REGISTER_WINDOW_MINUTES` | `10` | 注册限流窗口（分钟） |
| `REGISTER_MAX_ATTEMPTS` | `3` | 窗口内同 IP 最多注册尝试次数 |
| `SESSION_IDLE_TIMEOUT_HOURS` | `24` | 会话空闲超时（小时） |
| `SESSION_ABSOLUTE_TIMEOUT_DAYS` | `7` | 会话绝对超时（天） |
| `SESSION_CLEANUP_INTERVAL_MINUTES` | `120` | 清理定时任务间隔（分钟） |
| `SESSION_CLEANUP_BATCH_SIZE` | `100` | 每批删除会话条数 |
| `SESSION_ACTIVITY_REFRESH_SECONDS` | `300` | 活跃时间刷新节流（秒） |

数据库变更为 `migrations/001_invite_codes_and_session_cleanup.sql`，可手动执行：

```powershell
sqlite3 data/qingxu.sqlite < migrations/001_invite_codes_and_session_cleanup.sql
```

不手动执行也可以：`server.js` 启动时会幂等完成同样的建表与补列，并把历史会话的活跃时间回填为创建时间、绝对过期沿用原 `expires_at`，已有用户不会被强制下线。升级前建议先备份整个 `data/` 目录。

冒烟测试已覆盖无邀请码（400）与无效邀请码（403）路径，`npm test` 会一并验证。
