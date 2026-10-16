# 任务：作息表级联、AI 规划密度与历史冲突规避、计划预览布局重排、导航顺序、侧栏折叠（清序 Planner）

请在 `D:\清序网站\web-calendar` 仓库内直接完成编码、测试与自检。以下 7 项需求逐条实现，不要顺手改动无关功能。

## 0. 现状核对（已确认，直接按此改，不要重新设计）

- 技术栈：Node.js(>=22) + Express + better-sqlite3 + 原生 HTML/CSS/JS，**无框架、无打包、无构建步骤**。改完源码 `npm start` 即生效；测试 `npm test`。
- **只修改仓库根目录文件**；历史副本目录 `web-calendar\web-calendar\` 一律不要动。
- 作息表已实现：`timetable.js`（`DEFAULT_TIMETABLE` / `defaultTimetable` / `validateTimetable` / `normalizeTimetable`，前后端共用）、`index.html` 的 `#view-ocr > .timetable-panel`（`#timetable-count` / `#timetable-duration` / `#timetable-break` / `#timetable-periods` / `#timetable-add` / `#timetable-reflow` / `#timetable-default` / `#timetable-error` / `#timetable-status` / `#timetable-toggle`）、`script.js` 的 `timetableError / timetableParameters / readTimetable / renderTimetable / resizeTimetable / editTimetable`（约 487–569 行）。数据存 `state.settings.timetable`，经 `/api/sync` 落 `user_settings.timetable_json`。
- AI 规划：`index.html` 的 `#view-ai-plan`（表单 `#ai-plan-form`，字段 `#ai-plan-goal / #ai-plan-start / #ai-plan-end / #ai-plan-background / input[name=ai-plan-precise] / #ai-plan-preferred-window / #ai-plan-generate`）、`ai-plan-client.js`（`window.QingxuPlan`，`init({ getCurrentTasks, onImport })`）、`server.js` 的 `POST /api/ai-plan`（约 424–463 行）、`services/deepseekSchedule.js` 的 `SYSTEM_PROMPT / buildUserPrompt / makeStudyPlan / validateSchedule`。
- 计划预览：`index.html` 的 `<section class="hero">` 内含 `#new-task-button`；`#view-plan` 内依次是 `.stats`、`.content-grid`（`.calendar-panel` + `.task-search-panel` + `.day-panel`）、`.export-panel`；`#export-tutorial` 在 `#view-plan` **之后**，由 `showView()` 里的 `$("#export-tutorial").hidden = name !== "plan"` 控制显示。
- 布局 CSS 现状：`style.css` 里 `.content-grid{display:grid;grid-template-columns:minmax(340px,1fr) minmax(360px,1.06fr);gap:18px}`、`.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:15px;margin-bottom:18px}`、`.export-panel{display:grid;grid-template-columns:1fr auto;gap:20px;align-items:center;margin-top:18px}`、`.hero-actions{text-align:right;padding-bottom:6px}`；`upgrade.css` 里 `.task-search-panel / .task-search-toolbar / .task-search-results / .task-search-row`（136–142 行）。
- 现有 z-index：`.notes-sidebar` 5、`.toast` 10、`.petal-layer` 19、`.developer-credit` 20（`<dialog class="modal">` 属浏览器顶层，无需考虑）。搜索浮层取 30 即可。
- 便签：`index.html` 的 `<aside id="notes-left" class="notes-sidebar notes-left">`；`upgrade.css` 里 `.notes-sidebar` 仅 `@media (min-width:1180px)` 显示（1500px 以上宽度 380px），`body.signed-out .notes-sidebar{display:none!important}`，`.app-shell` 在 ≥1180px 时 `margin-left:330px`（≥1500px 时 410px）。
- 署名：`index.html` 的 `<aside class="developer-credit">`（含 `#flower-button` 与 `.casper-link`），`upgrade.css` 149–154 行固定右下，`body.ocr-view .developer-credit{position:static}`。
- 导航：`index.html` `<nav class="nav">` 内顺序目前是 计划预览 / 草稿箱（含 `#draft-count`）/ 设置 / 图片识别导入 / AI 规划助手。
- 改动 `index.html` 引用过的静态资源时，把 `?v=` 版本号 +1（例如 `upgrade.css?v=3` → `?v=4`、`script.js?v=3` → `?v=4`），避免线上用户拿到旧缓存。

---

## 1. 作息表：修改某一节时间时自动级联后续节次

**目标**：每节课的时长确定后，用户改动某一节的开始或结束时间，后续节次时间随之顺延；**用户没有单独设置过时长的节次，其时长自动与前一节保持一致**。

在 `script.js` 的作息表模块内实现（在 `#timetable-periods` 上做事件委托，监听 `.timetable-start` / `.timetable-end` 的 `change` 事件，不要用 `input` 以免时间控件输入过程中反复跳变）：

1. 运行时维护一个**不入库**的集合 `customDurations`（`Set<number>`，存节次号 1..N），表示「该节时长被用户单独设置过」。理由：`timetable.js` 的 `validateTimetable` 与服务端 `validateState` 都要求每个 period 恰好是 `{ section, start, end }`，**不要修改持久化结构、不要动数据库与同步校验**。
2. 每次级联前先用 `readTimetable()` 快照当前值；级联出错时回滚到快照并用 `timetableError()` 显示中文原因，不能留下半截脏数据。
3. 级联规则（第 `k` 节为用户正在编辑的节，索引从 1 开始；`durations[i]` 为第 i 节时长，分钟）：
   - **用户改的是第 k 节的开始时间**：该节时长保持不变（`durations[k] = 该节原 end - 原 start`；若原值非法则取 `durations[k-1] ?? defaultDuration`）；新 `end = 新 start + durations[k]`。
   - **用户改的是第 k 节的结束时间**：`durations[k] = 新 end - 该节 start`；若 ≤ 0 则报错「第 k 节的结束时间须晚于开始时间。」；同时把 `k` 加入 `customDurations`（视为用户显式设定了这一节的时长）。
   - **从 k+1 到 N 依次顺延**：
     - 第 i 节时长 = `customDurations.has(i) ? 该节当前时长(保持不变) : durations[i-1]`（即沿用前一节时长）；
     - 第 i 节 `start = 第 i-1 节 end + breakMinutes`（`#timetable-break` 的值）；
     - 第 i 节 `end = start + 时长`；随后 `durations[i] = 时长`。
4. 边界处理：
   - 计算出的时间 ≥ 24:00（即 `end >= 1440`）时：**停止继续顺延**，未重排的节次保持编辑前原值，并提示「后续节次已超出当天 24:00，未能继续顺延，请缩短时长、课间或手动调整。」**绝不能写出 `24:00` 或空值**（会被 `validateTimetable` 与服务端拒绝）。
   - 只允许 `HH:mm` 24 小时制；浏览器返回空值时提示「请填写有效的开始/结束时间。」且不级联。
   - 第 1 节的时长取「原时长」或 `defaultDuration`。
5. 与既有操作的配合（必须同步维护 `customDurations`）：
   - 「按以上参数重排」`#timetable-reflow`：**清空** `customDurations`，全部节次按 `defaultDuration + breakMinutes` 重排（沿用现有 `resizeTimetable`）。
   - 「恢复默认」`#timetable-default`、「每天课时数」变动、增加节次、删除节次（节次号前移）：清空或按新编号重建 `customDurations`，避免错位。
   - 级联只改 DOM，**不自动保存**；`#timetable-status` 显示「后续节次已随第 N 节自动顺延，尚未保存。」，用户点「保存作息表」才入库。
   - 级联完成后仍必须能通过 `window.QingxuTimetable.validateTimetable(readTimetable())`（可以用它自检，失败则回滚 + 中文报错）。
6. 建议加一段注释说明「时长继承 + 显式设置优先」的规则，方便后续维护。

---

## 2. AI 规划助手：新增「任务密度」滑块（三档内置提示词）

1. 界面：在 `#ai-plan-form` 的「一天中效率最高的时间段」之后、「生成规划」按钮之前新增一组控件：

```html
<div class="field ai-plan-density" role="group" aria-labelledby="ai-plan-density-label">
  <span id="ai-plan-density-label">任务密度</span>
  <input id="ai-plan-density" type="range" min="0" max="2" step="1" value="1"
         aria-describedby="ai-plan-density-value">
  <div class="ai-plan-density-labels" aria-hidden="true"><span>轻松</span><span>中度</span><span>忙碌</span></div>
  <output id="ai-plan-density-value" for="ai-plan-density">中度 · 每 2 天 1 个子任务</output>
</div>
```

   - 滑块 `min=0 max=2 step=1`，**默认 1（中度）**；三档文字与取值一一对应，当前档位在 `#ai-plan-density-value` 中显示「轻松 · 每周 1–2 个子任务」「中度 · 每 2 天 1 个子任务」「忙碌 · 每天 1 个子任务」。
   - 样式写入 `upgrade.css`：滑块横向铺满该 field、`accent-color: #4e86aa`、三个档位标签两端对齐均匀分布（`justify-content: space-between`）、`output` 用 `class="muted"` 风格，桌面与手机宽度都不换行错位。
2. `ai-plan-client.js`：
   - 提交时把滑块值映射为 `density`：`0 → "light"`、`1 → "medium"`、`2 → "busy"`，加入 `input` 一起发送。
   - `setBusy()` 时一并 `disabled` 滑块。
   - 滑块 `change` 时，如果已有生成结果，则清空结果并提示「任务密度已更改，请重新生成规划。」（复用现有 107–109 行对 `preferredWindow` 的处理方式，把 `#ai-plan-density` 一起纳入）。
   - `reset()` 里把滑块恢复为默认档（中度）。注意 `$("#ai-plan-form").reset()` 会把 range 恢复到 HTML 默认值 1，确认无误。
3. `server.js` `POST /api/ai-plan`：
   - 读取 `req.body?.density`；`undefined` 视为 `"medium"`（兼容仍在使用旧缓存前端脚本的用户）；取值不在 `["light","medium","busy"]` 时返回 400「任务密度取值无效。」
   - 透传给 `makeStudyPlan({ ..., density })`。
4. `services/deepseekSchedule.js`：
   - 新增三套内置密度提示词常量（例如 `DENSITY_PROMPTS`），内容要点：
     - `light`（轻松）：整个规划期内**每周只安排 1–2 个子任务**，相邻子任务间隔约 3–5 天，总量按「周数 × 1.5」估算，宁可少不要多；
     - `medium`（中度）：**平均每 2 天安排 1 个子任务**，总量按「规划天数 ÷ 2」估算；
     - `busy`（忙碌）：**每天安排 1 个子任务**，总量约等于规划天数。
   - `makeStudyPlan` 接收 `density`（默认 `"medium"`，非法值抛 `PARSE_FAILED`），把对应密度提示词**追加**到发给模型的 system 内容里（`SYSTEM_PROMPT + "\n" + DENSITY_PROMPTS[density]`），不改变原有 JSON 结构与键名、不改变 `validateSchedule` 的契约（200 条上限保留）。
   - 追加说明：任务数量与日期分布必须符合所选密度；**阶段（stages）数量不得超过任务总数**（现有校验要求每个阶段至少 1 个任务，轻松档下阶段数要相应减少）；仍需覆盖整个起止日期范围。

---

## 3. AI 规划助手：隐藏的冲突规避提示词 + 用户已有任务

**目标**：每次生成规划时，把「避免与用户已有日程时间冲突」的隐藏系统提示词，连同用户现有任务一起发给 DeepSeek，并严格遵循用户填写的效率时间段偏好。此行为不在界面上暴露（用户说「隐藏的提示词」）。

1. 前端 `script.js` 的 `window.QingxuPlan.init({ getCurrentTasks })`（约 1001–1006 行）改为返回**真正的占用时段**，而不是只有任务级摘要：
   - 遍历 `state.tasks`（不含草稿）在 `startDate..endDate` 区间内的 `events`，**跳过 `event.completed === true` 的事件**；
   - 每条输出：`{ name, date: event.date, time: event.time, duration: event.duration, allDay: Boolean(task.allDay), review: Boolean(task.review) }`；
   - `name` 截断到 40 字；按 `date`、`time` 升序排序；**最多 200 条**（超出时保留日期靠前的，并在返回结果里不强求提示用户）；
   - 全天任务用 `allDay: true` 表示（这类任务不参与精确时段冲突判断，但要提示模型该日已很满）。
2. `server.js` `POST /api/ai-plan` 的 `currentTasks` 校验同步扩展（当前白名单只允许 `name/date/duration/review`，约 447–454 行）：
   - 允许并校验 `time`（匹配 `^([01]\d|2[0-3]):[0-5]\d$`）与 `allDay`（布尔，`undefined` 视为 `false`）；
   - 数量上限 200，`name` ≤ 40 字，`duration` 1–1440 整数，`date` 合法；
   - 组装给模型的数据时**只保留白名单字段**（继续丢弃客户端其它多余字段）；`time + duration` 不得超过 1440。
   - 校验失败仍返回 400「现有任务摘要格式不正确。」。
3. `services/deepseekSchedule.js`：
   - 新增隐藏系统提示词常量（例如 `CONFLICT_PROMPT`），内容要点（中文，写给模型）：
     - 下面会给出用户**已占用的时段清单**（`YYYY-MM-DD HH:mm–HH:mm 任务名`，全天任务标注「全天」）；
     - 当 `preciseTime = true` 时，新任务的时段 `[startTime, startTime + duration)` **不得与任何已占用时段重叠**（同一天内逐一比对；首尾相接不算冲突）；
     - 若用户偏好的高效时间段（`preferredWindow`）内已有冲突，则在同一天该偏好时段附近寻找最近的空闲时段；若当天确实排不下，则顺延到最近的有空日期；**宁可减少任务数量，也不要安排重叠**；
     - 不要重排、不要输出用户已有的任务；
     - `preciseTime = false` 时不要编造钟点（`startTime` 仍为空字符串），但要在日期上避开已占用过多（例如全天任务或当天任务总时长接近 16 小时）的日期；
     - 不得改变输出 JSON 结构与字段。
   - 把该常量拼接进 system 内容（例如 `SYSTEM_PROMPT + "\n" + CONFLICT_PROMPT`），并把「已占用时段清单」以紧凑文本放进 `buildUserPrompt` 的 user 消息里（按日期分组，形如 `2026-03-02 09:00-09:45 高数第三章习题`，全天写 `2026-03-02 全天 复习日`），**不要**塞进 system 以免过长；清单为空时写「（用户在该时间段内没有已安排的任务）」。
   - 保持温度、超时、`max_tokens`、错误码与既有约定不变。
4. 说明：导入时现有的冲突检测弹窗（`findConflicts` / `showConflict`）保持不变，本次只是让 AI 尽量不再产生冲突；不要为了让 AI 不冲突而放宽导入校验。

---

## 4. 计划预览：搜索条移到「新建任务」左侧 + 每日任务并排到日历右侧

1. `index.html`：把 `#view-plan > .content-grid` 里的整个 `<section class="panel task-search-panel">` 移出，改为 hero 操作区里的一根搜索条：
   - `.hero-actions` 结构改为横向一行：`搜索条` + `#new-task-button` + 原有说明文字 `<p>默认按北京时间导出</p>`；搜索条紧邻「新建任务」按钮（间距 8–10px），二者垂直居中对齐、高度一致（约 44px）。
   - 搜索条保持 `id="task-search"`（`type="search"`、`placeholder="输入任务名称、分类或备注关键词"`、`autocomplete="off"`），配 `aria-label="搜索全部任务"`（label 文案不再单独占一行）。
   - 结果容器仍为 `id="task-search-results"`，内部仍保留 `#task-search-count`（`class="muted" role="status"`）与 `#task-search-delete`（`batch` 删除按钮）以及 `.task-search-row` 结构 —— **保留全部既有 id / class**，`renderSearch()`（`script.js` 约 272–290 行）与 `document` 级事件委托（761–766 行）不需大改。
   - 结果容器改为搜索框**下方的浮层**：`position:absolute; top:calc(100% + 6px); left:0; z-index:30; min-width:min(420px, calc(100vw - 40px)); max-height:360px; overflow:auto;`，白底、圆角 12px、`box-shadow: 0 12px 32px #284b6a1f`、内边距 10–12px；父容器 `.hero-search{position:relative}`。
   - **不搜索时**：`#task-search-results` 保持 `hidden`（现有逻辑已是如此），搜索条就是一个长条输入框（建议宽度 `260–320px`，窄屏 `100%`），**不占额外高度**。
   - 交互增强（建议实现）：`Esc` 或点击浮层外部时清空焦点/收起浮层；不在计划预览视图时搜索条隐藏。
2. 视图可见性：`script.js` 的 `showView()`（约 224–231 行，已有 `document.body.classList.toggle("ocr-view", ...)`）新增 `document.body.classList.toggle("plan-view", name === "plan")`；`upgrade.css` 加 `body:not(.plan-view) .hero-search { display:none }`，避免在图片识别导入 / AI 规划 / 草稿箱 / 设置视图里留下一个孤立搜索条。`#new-task-button` 保持现有「所有视图可见」的行为，不要改。
3. 移动端：`@media (max-width:600px)` 下 hero 已是纵向排列，搜索条取 `width:100%`，浮层 `left:0; right:0; min-width:0`，不与按钮重叠。
4. **每日任务移到日历右侧**：`.content-grid` 里删除 `.task-search-panel` 后只剩 `.calendar-panel` + `.day-panel`，保持现有两列并排的 `grid-template-columns`（`minmax(340px,1fr) minmax(360px,1.06fr)`）即可；860px 以下仍按现有 media query 变单列。如两列宽度比例需要微调（例如 `1fr / .82fr`）以让日历更宽，可以调，但要保证桌面并排、窄屏堆叠。
5. 删除 `.task-search-panel` 相关样式（`upgrade.css` 136–138 行、`style.css` 中相应规则；`style.css` 是被压缩过的长行，改完保持可读性即可），新增 `.hero-search` / `.hero-search-results` 等样式。

---

## 5. 计划预览：统计卡片与导出面板换位

- `#view-plan` 内顺序改为：`.export-panel`（带走你的日程）→ `.content-grid`（日历 + 每日任务）→ `.stats`（任务记录 / 日程总数 / 已完成）。
- `#export-tutorial`（ICS 教程）保持在 `#view-plan` 之后、`<main>` 末尾不动，这样统计卡片自然位于**日历下方、教程上方**。
- `showView()` 里 `$("#export-tutorial").hidden = name !== "plan"` 的逻辑保持不变。
- 样式微调：`.stats` 由 `margin-bottom:18px` 改为合适的上间距（例如 `margin:18px 0 0`），`.export-panel` 去掉多余的 `margin-top` 或改为 0，保证「导出面板—日历—统计」三者间距一致、视觉连贯；导出面板在日历上方时不要显得像页面主标题，保持现有 `.export-panel` 样式即可。

---

## 6. 主导航顺序调整

`index.html` 的 `<nav class="nav">`（约 33–39 行）顺序改为从左到右：

1. 计划预览（`data-view="plan"`，保持 `class="nav-button active"`）
2. 图片识别导入（`data-view="ocr"`）
3. AI 规划助手（`data-view="ai-plan"`）
4. 草稿箱（`data-view="drafts"`，`#draft-count` 徽标随之移动，保持 `<span id="draft-count" class="count">0</span>`）
5. 设置（`data-view="settings"`）

按钮文案沿用现有文案（不改成「AI 助手」等新名字）；只调顺序，其余属性、`#draft-count`、`showView()` 的 `dataset.view` 分发逻辑（约 227、734 行）都不动。

---

## 7. 便签与署名支持折叠隐藏（默认展开）

1. 新增两个**独立于被折叠元素之外**的固定切换按钮（放在 `index.html` 的 `.app-shell` 之后、`<dialog>` 之前）：
   - `<button id="notes-toggle" class="panel-toggle notes-toggle" type="button" aria-controls="notes-left" aria-expanded="true" title="收起随手便签">›</button>` —— 位于页面左侧。
   - `<button id="credit-toggle" class="panel-toggle credit-toggle" type="button" aria-controls="developer-credit" aria-expanded="true" title="收起署名卡片">‹</button>` —— 位于页面右侧；同时给 `<aside class="developer-credit">` 加上 `id="developer-credit"`。
   - 图标语义：**折叠后**便签按钮显示 `›`（指向页面内，点开）、署名按钮显示 `‹`；**展开时**显示相反方向（便签 `‹` 收起、署名 `›` 收起）。用文字箭头或内联 SVG 都可，但必须随状态真实切换。
2. 交互与样式（写入 `upgrade.css`）：
   - `body.notes-hidden .notes-sidebar { display:none }`；`body.credit-hidden .developer-credit { display:none }`（OCR 视图下署名是 `position:static`，同样要生效）。
   - 便签隐藏后回收左侧留白：`body.notes-hidden .app-shell { margin-left:auto; margin-right:auto; max-width:min(1220px, calc(100vw - 60px)) }`，并给 `.app-shell` 加 `transition: margin-left .25s ease, max-width .25s ease`。特异性要高于 `style.css` 里 `@media (min-width:1180px)` 与 `(min-width:1500px)` 的 `.app-shell` 规则。
   - 按钮为圆形约 34–38px，样式与站点一致（浅底、`#e6edf2` 边框、`#6a8faf` 文字、hover 加深），`:focus-visible` 有 3px 焦点环；`z-index: 22`（高于 `.notes-sidebar`(5) 与 `.developer-credit`(20)，低于搜索浮层(30)与 toast 之上无冲突）。
   - 位置建议：便签按钮展开时贴在便签面板右缘（`left: 318px`，`min-width:1500px` 时 `left: 398px`），折叠时 `left: 12px`；垂直 `top: 50%`（`transform: translateY(-50%)`）。署名按钮展开时在卡片上方（`right: 14px; bottom: 78px`），折叠时 `right: 14px; bottom: 13px`。不得遮挡便签内容、署名文字、底部 toast 与花瓣动画（`.petal-layer` 是 `pointer-events:none`，无需处理）。窄屏微调避免遮挡操作。
   - 便签按钮仅在 `@media (min-width:1180px)`（便签真正显示）且登录后可见：`body.signed-out .panel-toggle { display:none }`，并让 `#notes-toggle` 在窄屏 `display:none`；`#credit-toggle` 所有宽度都可用。
3. 状态：`script.js` 中维护两个普通变量（例如 `notesHidden` / `creditHidden`），点击时切换 body 类名、同步 `aria-expanded` 与 `title`、切换箭头图标。**不要写入 localStorage、不要进 settings、不要同步到服务器**：用户明确要求「刚进入网站时保持开启」，因此刷新/重新登录后都应是展开状态。`onState()`（登录/切换账户回调）里把两者重置为展开。
4. 与现有 `body.signed-out` 规则配合：未登录时既不显示便签也不显示这两个切换按钮。

---

## 8. 验收清单（逐条自检并在总结中说明结果）

1. 作息表：把第 3 节开始时间从 09:50 改到 10:00 → 第 3 节结束、第 4 节及其后所有节次整体顺延，且顺延后的节次时长与前一节一致；只改第 5 节结束时间 → 第 5 节时长变化并记为「单独设置」，第 6 节起按第 5 节新时长顺延，而第 5 节自身时长在后续级联中保持不变。
2. 级联后仍能通过 `validateTimetable` 并成功保存（含重新登录后数据一致）；制造一个会越过 24:00 的场景，确认停止顺延 + 中文提示 + 不写入 `24:00`。
3. 「按以上参数重排」「恢复默认」「增删节次」「改课时数」后级联不再沿用旧的单独设置值。
4. 任务密度滑块显示三档并默认「中度」；三档分别生成的规划任务数量明显不同（轻松≪中度<忙碌），且阶段数量不超过任务总数；改动密度后旧结果被清空并提示重新生成。
5. `preciseTime=true` 时，生成的任务与已占用时段清单不重叠（用同一时段多次生成验证），且优先落在填写的高效时间段内；`preciseTime=false` 时 `startTime` 仍为空字符串。
6. 计划预览：搜索条紧邻「新建任务」左侧，无输入时只是一根长条、不占额外高度；输入关键词后结果浮层出现在搜索框下方，可勾选并批量删除；结果区外点击/Esc 可收起；非计划预览视图看不到搜索条。
7. 每日任务位于日历右侧并排显示；窄屏（<860px）自动堆叠。
8. 「带走你的日程」在日历上方，「任务记录 / 日程总数 / 已完成」在日历下方、ICS 教程上方，间距协调。
9. 顶部导航顺序为 计划预览 / 图片识别导入 / AI 规划助手 / 草稿箱 / 设置，草稿数徽标仍在草稿箱按钮上，且各视图切换正常。
10. 便签与署名可分别折叠/展开，箭头方向与状态一致；刷新页面后两者默认展开；未登录时看不到这两个按钮；折叠便签后页面内容左移、没有大片空白。
11. `npm test` 通过（若冒烟测试覆盖 `/api/ai-plan` 入参或 `currentTasks` 结构，请同步更新测试，不要删除或跳过）；桌面与手机宽度下无横向滚动条、无遮挡。
12. 修改过的 `index.html` 引用资源已把 `?v=` 提升一位。

## 9. 不要做的事

- 不要修改 `timetable.js` 的持久化数据结构、`user_settings` 表结构、`/api/sync` 校验规则与迁移文件（除非确实必须，且要说明理由）。
- 不要改动作息表与 AI 解析的既有联动（节次→时间换算、`#ai-draft-error` 报错位置、加号上传图片的行为）。
- 不要改动艾宾浩斯复习逻辑、节假日跳过规则、ICS/CSV 导出、冲突弹窗与 `showNotice` 行为。
- 不要引入新依赖、构建工具或新的后端接口/数据表；不要改登录、注册、邀请码、便签数据逻辑。
- 不要修改 `web-calendar\web-calendar\` 副本目录。
- 不要把折叠状态、搜索关键词、密度选择写进 `localStorage` 或用户设置（密度只随本次表单提交发送）。

## 10. 交付说明

完成后输出：① 改动文件清单与每处要点；② 第 8 节验收清单的逐条结果（含第 1、2、4、5、6、10 条的实际验证方式）；③ `npm test` 的实际输出；④ 若对上述任何判断做了不同取舍，说明理由。
