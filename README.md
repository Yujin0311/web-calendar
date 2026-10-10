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
| `sessions` | `jti`, `user_id`, `expires_at`, `created_at` | JWT 会话与退出失效 |
| `categories` | `id`, `user_id`, `name`, `color` | 用户独立分类 |
| `user_settings` | `user_id`, `offsets_json`, `default_time`, `holidays_json` | 复习和节假日设置 |
| `tasks` | `id`, `user_id`, `category_id`, `name`, `start_date`, `end_date`, `duration`, `reminder`, `time_mode`, `start_time`, `note`, `review`, `repeat_type`, `repeat_weekdays_json`, `deleted_offsets_json`, `draft_form_json`, `status` | 任务、重复设置、终止日期、单次删除记录与未填完的草稿原始表单 |
| `occurrences` | `id`, `user_id`, `task_id`, `offset_days`, `round_number`, `event_date`, `start_time`, `duration`, `completed` | 每条独立日程，可单独删除 |

所有任务表都带用户归属，API 按当前 JWT 用户查询或修改。前端使用 `localStorage` 中的用户专属缓存支持断网时继续查看和编辑，重新联网后同步。当前版本为单设备优先的最后写入覆盖模型，不提供多设备冲突合并。

## API 清单

除注册、登录外，均需请求头 `Authorization: Bearer <JWT>`。

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/auth/register` | 注册并获得 JWT |
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

## 苹果日历导入说明

本版继续导出一个完整的 ICS 文件，事件标题中的分类标签和 `CATEGORIES` 字段保留。**ICS 导入不会自动创建独立苹果日历**；在 Mac 的日历 App 中导入时，请选择目标日历。如需独立日历，请先在苹果日历手动新建。

同一任务全部艾宾浩斯日程使用相同的 `SUMMARY`。用户填写的备注保持原文，后面附加「初次学习」或「复习第 N 轮」到 `DESCRIPTION`，用于区分轮次。

## 第三次维修功能

- 新建任务可以选择不重复、每天、每周（多选星期）、每月、每年。手动重复和艾宾浩斯复习互斥。手动重复的预览仍逐日展示，ICS 则写成**一个 `VEVENT` + 一个 `RRULE`**；被单独删除或因课程节假日跳过的日期以 `EXDATE` 表达。艾宾浩斯维持原有不规则间隔的逐条事件。
- ICS 下载只包含当前账户尚未导出的任务，包括任务的艾宾浩斯复习日程。导出记录写在项目根目录的 `export_history.json`，包含各账户最近导出时间和已导出的任务 ID。该文件已加入 `.gitignore`。编辑已经导出的任务后，如需重新导出，请点击「清空导出记录」。清空后下一次会导出当前计划的全部日程。
- 新建任务提示文案已更新。页面右下角增加开发者署名与送花按钮，点击后播放约 3 秒花瓣动画。

## 本地验证

在项目目录执行 `npm test`。自动冒烟测试会使用临时数据库和临时导出记录文件，不会修改真实账户；验证服务启动、每日/每周/每月/每年 RRULE、一个重复系列只含一个 VEVENT、艾宾浩斯七个独立节点、第二次导出为空、清空记录后重新完整导出。再执行 `npm start` 并访问 `http://localhost:3000` 检查页面交互。
