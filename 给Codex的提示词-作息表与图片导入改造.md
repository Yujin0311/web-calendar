# 任务：为「图片识别导入」模块新增作息表，并改造图片选择区（清序 Planner）

请直接在 `D:\清序网站\web-calendar` 仓库内完成编码、测试与自检。下面是完整需求，请逐条实现，不要擅自扩大或缩小范围。

## 0. 项目背景与硬性约束

- 技术栈：Node.js(>=22) + Express + better-sqlite3 + 原生 HTML/CSS/JS。**没有打包器、没有框架、没有构建步骤**，改完源码直接 `npm start` 生效。
- 本地运行：`npm start`（默认 http://127.0.0.1:3000 ）；测试：`npm test`（`tests/smoke.js` + `tests/deepseek-schedule-plan.js`）。
- 关键文件与职责：
  - `index.html`：全部视图。图片识别导入视图为 `#view-ocr`，图片选择区是第 101 行的 `.ocr-source-buttons`，确认按钮是 `#ai-draft-confirm`。
  - `script.js`：主逻辑。`importAiCourses({ courses, termMonday, sectionTimes })`（约 786–847 行）负责批量生成课程日程；`initialState()/loadState()/saveSettings()` 负责设置数据。
  - `ai-schedule-client.js`：图片选择、AI 请求、待确认课程草稿卡片（`window.QingxuAI`）。
  - `auth.js`：登录、`/api/sync` 同步、`parseScheduleFromImage(image, signal)`（约 150 行）。
  - `server.js`：Express 后端与 SQLite schema（`user_settings` 表在 87–92 行）、`loadState()/validateState()/saveState()`（315–381 行）、`POST /api/ai/parse-schedule`（405 行）。
  - `services/deepseekSchedule.js`：AI 提示词与严格 JSON 校验（`OCR_SYSTEM_PROMPT` 在 184 行，`parseScheduleFromImage` 在 260 行，`validateScheduleFromImage` 在 230 行）。
  - `upgrade.css` / `style.css`：样式（`.ocr-source-buttons` 53–57 行、`.ai-section-times` 72 行等）。
- **只修改仓库根目录下的文件。** 仓库内存在一份历史副本目录 `web-calendar\web-calendar\`，**不要修改它，也不要把改动同步过去**。
- 沿用现有代码风格：中文文案与中文报错、`"use strict"`、`const`/函数声明、严格的输入校验（后端必须再校验一次前端数据）、不引入任何新依赖。

---

## 1. 需求一：作息表（上课时间设置）

### 1.1 界面位置与交互

在 `#view-ocr` 内、图片选择区 `.ocr-source-buttons` **上方**新增一块「作息表 / 上课时间设置」面板（用户给的手机截图就是目标效果，但必须是**可自主编辑**的表单，不能是只读截图样式）。

- 折叠面板：标题「作息表」+「展开/收起」切换，首次进入默认展开，折叠状态只在内存里维护即可。
- 顶部参数行：
  - 每天课时数：数字输入，1–20，默认 **12**。
  - 单节课时长（分钟）：数字输入，5–180，默认 **45**。
  - 课间休息（分钟）：数字输入，0–60，默认 **5**。
  - 「按以上参数重排」按钮：以第 1 节默认开始时间（08:00）为基准，按「时长 + 课间」依次重算所有节次的开始/结束时间。
  - 「恢复默认」按钮：恢复 1.2 的默认作息表。
- 节次列表：每行 `第 N 节` + 开始时间 `<input type="time">` + 结束时间 `<input type="time">`（必须 24 小时制，`type="time"` 即可）+ 行内「删除」按钮（至少保留 1 节）。
  - 增加节次按钮「＋ 添加一节」，受「每天课时数」上限约束（最多 20 节）。
  - 用户可任意修改任意一节的上课/下课时间（允许午休、晚自习造成的大间隔），但必须满足 `开始时间 < 结束时间`。
- 底部：「保存作息表」按钮 + 状态文案 `#timetable-status` + 行内错误 `#timetable-error`（`class="form-error" role="alert"`）。
  - 校验失败时就地显示中文错误、不弹窗、不写库；保存成功后 `toast("作息表已保存，AI 解析将按此表换算节次时间。")`。
- 交互细节：修改课时数时，多出的节次按「上一节结束 + 课间」自动补全时间；减少课时数时删除末尾节次（如果被删除的节次已有自定义时间，直接删除即可，不需要二次确认弹窗，但要在状态栏提示已截断）。

### 1.2 默认作息表（与截图一致）

```
第1节 08:00-08:45   第2节 08:50-09:35   第3节 09:50-10:35   第4节 10:40-11:25
第5节 11:30-12:15   第6节 14:00-14:45   第7节 14:50-15:35   第8节 15:50-16:35
第9节 16:40-17:25   第10节 17:30-18:15  第11节 19:00-19:45  第12节 19:50-20:35
```

### 1.3 数据结构与持久化（必须与账号关联，设置一次长期保存）

前端数据放在 `state.settings.timetable`：

```js
{
  periodsPerDay: 12,        // 每天总课时数
  defaultDuration: 45,      // 单节课时长（分钟）
  breakMinutes: 5,          // 课间休息（分钟）
  periods: [ { section: 1, start: "08:00", end: "08:45" }, /* ... section 升序、连续、不重复 ... */ ]
}
```

要求：

1. `script.js` 新增 `DEFAULT_TIMETABLE` 常量与 `defaultTimetable()`（**返回深拷贝**），在 `initialState()` 的 `settings` 中加入 `timetable`。
2. `loadState()` 里现有的 `stored.settings = { ...defaults.settings, ...(stored.settings || {}) }` 要保证老账户/老本地缓存自动补齐作息表，且补出来的对象与 `DEFAULT_TIMETABLE` **不共享引用**（改一处不会污染默认值）。
3. 保存走现有链路：`state.settings.timetable = ...; save();`（`save()` → `window.QingxuAuth.save(state)` → 本地缓存 + `PUT /api/sync`），**不要新增独立表或独立接口**；`GET/PUT /api/settings` 也应自动带上该字段。
4. 服务端持久化：
   - `user_settings` 表新增列 `timetable_json TEXT NOT NULL DEFAULT '{}'`；用 `PRAGMA table_info(user_settings)` 检测列是否存在，不存在时 `ALTER TABLE user_settings ADD COLUMN`，保证**老数据库无损升级**；同时在 `migrations/` 下新增 `002_user_settings_timetable.sql` 记录变更。
   - `loadState()` 返回 `settings.timetable`：列缺失/为空/JSON 解析失败时回退到服务端内置默认作息表。
   - `validateState()` 增加与服务端同一套严格校验，非法时抛中文错误（例如「作息表数据无效。」）：`periodsPerDay` 1–20 整数；`periods` 为长度等于 `periodsPerDay` 的数组；每项 `section` 为 1..N 的升序连续整数且不重复；`start`/`end` 匹配 `^([01]\d|2[0-3]):[0-5]\d$` 且 `start < end`；`defaultDuration` 5–180 整数；`breakMinutes` 0–60 整数；`periods` 总长度上限 20。
   - `saveState()` 的 `INSERT ... user_settings ... ON CONFLICT` 语句同步写入 `timetable_json`。
5. 兼容性：老账号、老 `localStorage` 缓存（`qingxu-cache-v2-<userId>`）、离线待同步状态都必须能正常升级，不出现报错或数据丢失。

### 1.4 与 AI 解析的联动（核心）

1. `auth.js`：`parseScheduleFromImage(image, signal)` → `parseScheduleFromImage(image, timetable, signal)`，请求体改为 `{ image, timetable }`。
2. `server.js` `POST /api/ai/parse-schedule`：读取 `req.body.timetable`，在服务端用 1.3 的同一套校验函数校验（非法时 `400` + 中文提示），并传给 `parseScheduleFromImage(image, timetable)`。
3. `services/deepseekSchedule.js`：
   - `parseScheduleFromImage(base64Image, timetable)` 在 `OCR_SYSTEM_PROMPT` 之后再追加一段系统提示（**不要修改现有 `courses` / `isValid` 的 JSON 结构与键名，`validateScheduleFromImage` 保持不变**），内容形如：

     ```
     本校作息表（24 小时制，节次与时间一一对应，每天共 12 节）：
     第1节 08:00-08:45
     第2节 08:50-09:35
     ...
     规则：sectionStart/sectionEnd 必须依据这张作息表判断；节次不得超出作息表范围；不要把作息表时间写进 JSON 的其它字段；识别不到节次时按原规则填空。
     ```

   - `timetable` 缺失或非法时回退到模块内置的默认作息表，保证接口永远可用。
4. 前端时间换算（**关键**）：`script.js` 的 `importAiCourses` 不再使用用户填写的 `sectionTimes`，改为在确认时实时读取 `state.settings.timetable`：
   - `startTime = timetable.periods[firstSection - 1].start`，`endTime = timetable.periods[lastSection - 1].end`，`duration = minutes(endTime) - minutes(startTime)`，保留原有「时长 1–1440、不能跨越午夜」的校验与报错。
   - 若某门课识别出的节次超出作息表范围（例如第 15 节而作息表只有 12 节），抛中文错误提示用户先去修改作息表（见 1.5 的报错位置），**不要静默裁剪或自动补节次**。
   - 时间在确认时才计算，不要把时间快照写进草稿对象。
5. **删除草稿卡片里的「节次时间表」界面**（用户明确要求解析后不再出现让用户改课程时间的界面）：
   - `index.html`：删除 `<h4>节次时间表</h4>`、其说明文字与 `<div id="ai-section-times">`。
   - `ai-schedule-client.js`：删除 `renderSectionTimes()`、只服务于它的 `field()` 用法/change 监听、`onConfirm` 中组装 `sectionTimes` 的代码；`renderDraft()` 不再调用它。
   - `script.js`：`importAiCourses` 去掉 `sectionTimes` 形参与相关校验，改为按 1.4.4 从作息表换算。
   - `upgrade.css` / `style.css`：清理只服务于 `.ai-section-times` 的样式规则（先确认没有别的视图在用）。
   - 课程草稿里仍然保留可编辑的「开始节次 / 结束节次」，用户改节次后时间随作息表自动变化。

### 1.5 报错显示位置（必须精确）

- 现状问题：所有错误都写进 `#ocr-error`，它位于草稿卡片**上方**，导入阶段的报错看起来离按钮很远。
- 目标：
  - 在 `#ai-schedule-draft` 内部、`#ai-draft-confirm`（「确认并批量生成日程」）的**紧上方**新增 `<p id="ai-draft-error" class="form-error" role="alert" hidden></p>`，位置在所有课程草稿（`#ai-course-list` 与学期周一日期）**之后**。
  - **解析阶段**错误（未选图、非登录、图片格式/体积、网络失败、超时、AI 返回不合法）继续使用 `#ocr-error`（草稿上方），保持现状。
  - **导入/生成阶段**错误（点确认后的校验失败、节次越界、涉及年份未配置节假日、保存失败等）统一显示在 `#ai-draft-error`，并在显示后 `scrollIntoView({ block: "center", behavior: "smooth" })`，不要再显示到 `#ocr-error`，也不要只用 `#ocr-status` 一句文案代替。
  - `ai-schedule-client.js` 新增 `showDraftError(message)` / `clearDraftError()`；`#ai-draft-confirm` 的 `catch` 分支与 `onConfirm` 抛出的所有错误都走这里；`renderDraft()`/`reset()`/`setBusy(true)` 时清空。
  - 冲突弹窗（`showConflict`）与节假日、时长提醒（`showNotice`）保持现有 Modal 行为不变。
  - 成功生成后沿用现有 `window.QingxuAI.consume()` 清空草稿。

---

## 2. 需求二：图片选择区的两个加号按钮

现状（`index.html` 第 101 行）：两个 `<label class="button secondary|ghost">` 包裹隐藏的 `<input type="file" class="ocr-file-input">`，点击 label 本体即触发选图。

改造目标（参考用户给的截图）：

1. 「选择本地图片」「手机拍照上传」改为**纯展示块、完全不可点击**：
   - 由 `<label>` 改为 `<span>`（或 `<div>`），保留原有外观类名（`button secondary` / `button ghost`）。
   - 移除 `cursor: pointer`、hover/active 反馈与任何点击、键盘激活行为；`aria-hidden="true"` 或使用非交互语义，确保点击、回车、空格都不触发文件选择（`<button disabled>` 不作为首选，因为会变灰）。
2. 在每个展示块**正下方**各新增一个加号按钮：
   - 「选择本地图片」下方：`<button type="button" id="ocr-add-local" class="ocr-add-button" aria-label="添加本地图片">＋</button>`（加号可用 SVG 或文字 `＋`）。
   - 「手机拍照上传」下方：`<button type="button" id="ocr-add-camera" class="ocr-add-button" aria-label="手机拍照上传">＋</button>`。
   - 点击加号分别触发对应隐藏 `<input type="file">` 的 `.click()`：`#ocr-add-local` → `#ocr-file`（`accept="image/*"`）；`#ocr-add-camera` → `#ocr-camera`（`accept="image/*" capture="environment"`）。
   - 两个 file input 的 `change` 事件继续复用现有 `chooseImage(event.target.files?.[0])` 流程，图片格式/大小/预览校验逻辑一律不改。
3. 无障碍与状态：
   - 加号是真 `<button>`，支持 Tab 聚焦与 Enter/Space 触发，`:focus-visible` 焦点样式与现有 `.button:focus-visible` 一致。
   - `setBusy(true)` 时两个加号按钮与两个 file input 一并 `disabled`，样式与现有 `label:has(.ocr-file-input:disabled){opacity:.45}` 的效果保持一致（可改为针对 `.ocr-add-button:disabled`）；`reset()` 恢复可用并清空。
4. 布局与样式（写入 `upgrade.css`）：
   - `.ocr-source-buttons` 内改为两个纵向小列（展示块在上、加号在下、水平居中），列间距与现有 `gap` 协调；窄屏（手机宽度）不能错位或换行成奇怪形状。
   - 加号按钮视觉上明确可点击（圆形/方形、边框或浅色底、尺寸约 32–40px），与站点现有配色（`#6a8faf` / `#9bc4df` 系）一致。

---

## 3. 验收清单（请逐条自检并在总结里说明结果）

1. 「图片识别导入」页面在图片选择区上方能看到作息表面板；可改课时数、单节时长、课间休息、每一节的开始/结束时间，并支持添加/删除节次。
2. 保存后刷新页面、退出重新登录、换浏览器登录同一账号，作息表数据都还在（`settings.timetable` 已通过 `/api/sync` 落到 SQLite `user_settings.timetable_json`）。
3. 用旧数据库/旧 localStorage 缓存启动不会报错（列自动迁移、默认作息表自动补齐）。
4. 点击两个加号分别能打开本地文件选择与手机拍照；点击「选择本地图片」「手机拍照上传」文字块**没有任何反应**（鼠标、Enter、Space 都不触发）。
5. AI 解析完成后，草稿卡片里**不再出现**「节次时间表」，也不再要求用户填课程时间；确认生成出的日程时间与作息表完全一致。
6. 故意制造导入阶段错误（如让某门课节次超出作息表范围、或涉及年份未配置节假日），报错必须显示在「确认并批量生成日程」**正上方**、课程草稿**下方**，并自动滚动到可见位置；解析阶段的错误仍在草稿上方显示。
7. 修改作息表后重新确认导入，生成的时间随新作息表变化。
8. `npm test` 通过（若冒烟测试断言了 `settings` 结构或 `/api/ai/parse-schedule` 的请求体，请同步更新测试，不要删除或跳过测试）。
9. 桌面宽度与手机宽度下，作息表面板、加号按钮、报错位置布局均正常，无横向滚动条、无遮挡。

---

## 4. 不要做的事

- 不要改动艾宾浩斯复习逻辑、复习节点设置、节假日跳过规则、重复日程生成器、ICS/CSV 导出逻辑。
- 不要改动时间冲突弹窗（`showConflict`）与 `showNotice` 模态框的既有行为。
- 不要改动 `courses` / `isValid` 的 AI JSON 契约与 `validateScheduleFromImage` 的严格校验（除提示词与函数签名外）。
- 不要引入新依赖、不要引入构建工具、不要新增外部接口或数据库表；不要修改用户密码、登录、注册、便签逻辑。
- 不要修改 `web-calendar\web-calendar\` 副本目录。
- 不要用 `prompt()`/`confirm()` 之类的原生弹窗做作息表编辑（现有代码只在分类编辑里用过 `prompt`，新功能请用表单内联编辑）。

## 5. 交付说明

完成后请输出：

1. 改动文件清单与每个文件的改动要点；
2. 老数据库/老缓存的迁移方式说明（新增列、默认值补齐）；
3. `npm test` 的实际输出结果；
4. 手工验证步骤与结果（对应第 3 节验收清单，尤其是第 4、5、6、7 条）。
