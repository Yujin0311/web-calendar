# 任务：修复 AI 规划不遵循任务密度与历史任务的问题 + 新建任务支持新增分类与「全天」只排到当天

请在 `D:\清序网站\web-calendar` 仓库内直接编码、自测。两项需求按下面的顺序做，**只改与这两项相关的代码**。

## 0. 现状核对（已确认，直接按此改）

- 无框架、无打包，改完 `npm start` 生效（**`server.js` / `services/*` 是启动时加载的，改完必须重启 Node 进程**）；测试 `npm test`。
- 只修改仓库根目录文件，历史副本 `web-calendar\web-calendar\` 不要动。
- 任务密度已经接好但只是「软提示」：
  - `index.html` 的 `#ai-plan-density`（range 0–2，默认 1）+ `#ai-plan-density-value`；
  - `ai-plan-client.js` 的 `densities = ["light","medium","busy"]`，第 84 行把 `density` 放进请求；
  - `server.js` `POST /api/ai-plan`（约 433–468 行）校验 `density` 并把 `currentTasks`（含 `name/date/time/duration/allDay/review`，上限 200）透传；
  - `services/deepseekSchedule.js` 的 `DENSITY_PROMPTS`（37–41 行）、`CONFLICT_PROMPT`（42–47 行）、`buildUserPrompt`（131–143 行，含 `occupied` 清单与 `target` 计算）、`makeStudyPlan`（151 行起，system 里拼接密度与冲突提示词）。
- 结论：**链路是通的，问题在于约束只在提示词里、且只写了「不要超过目标」**，模型经常给出远超目标的任务数或仍然排重叠；另外若测试时没有重启 Node 进程，跑的还是旧提示词。
- 新建任务弹窗：`index.html` 的 `#task-dialog > form#task-form`，分类下拉是 `#task-category`（`renderCategorySelect()` 在 `script.js` 314–318 行填充）。**注意：`#task-end-date`、`#save-draft`、`#task-repeat`、`#repeat-weekdays`、`#reset-ics-history` 这几个元素不在 `index.html` 里，是 `script.js` 第 34–40 行用 `insertAdjacentHTML` 在运行时插入的**，不要以为它们缺失。
- 设置页新增分类：`#category-form` + `#category-name`(maxlength 24) + `#category-color`(默认 `#6a8faf`)，处理函数在 `script.js` 857–863 行。
- 「全天」分类现有支持：`updateAllDayVisibility()`（366–372 行）、`updateTimeVisibility()`（360–365 行）、`readTaskForm()`（379–397 行）、`saveManualDraft()`（约 407–425 行）、`findConflicts()` 对 `task.allDay` 返回空数组、`icsDate()` 的全天分支（684 行）。**这部分已基本可用，本次要做的是补齐入口、修好切换回普通分类时的状态恢复，并逐项回归。**
- 改动 `index.html` 引用过的静态资源时把 `?v=` +1（现在 `upgrade.css?v=4`、`ai-plan-client.js?v=1`、`script.js?v=4`）。

---

## 需求一：AI 规划必须真正参考「任务密度」和「用户已有任务」

### A1. 先让入参可观测（诊断，必须做）

1. 在 `server.js` 的 `/api/ai-plan` 里加一行服务端日志（用 `console.log`，只在后端控制台可见，不返回给前端）：
   `[ai-plan] density=…, currentTasks=…条, preciseTime=…, preferredWindow=…, target=…`
   其中 `target` 用下面 A2 抽出的 `densityTarget()` 计算，保证日志与兜底算法同源。
2. 在 `services/deepseekSchedule.js` 里区分两种情况再记一条日志：`currentTasks` 为空 → `[ai-plan] 占用清单为空（用户在该区间没有未完成日程）`；非空 → 记录条数与日期跨度。
3. 交付说明里写清：**修改后必须重启 `npm start`**（否则 Node 仍运行旧提示词），并把 `ai-plan-client.js` 的 `?v=` 再 +1。

### A2. 服务端确定性兜底（本次核心，不能只靠提示词）

在 `services/deepseekSchedule.js` 中把约束做成可测试的纯函数，并在 `makeStudyPlan` 里于 `validateSchedule` 成功后依次调用（**保持返回的 JSON 结构、键名与 200 条上限完全不变，不要新增字段**）：

1. `densityTarget(startDate, endDate, density)`：把 `buildUserPrompt` 第 141 行内联的算法抽成唯一来源——
   `days = 含首尾的天数`；`light = max(1, round(days / 7 * 1.5))`、`medium = max(1, round(days / 2))`、`busy = days`；上限 200。`buildUserPrompt` 与日志都改用它。
2. `enforceDensity(plan, target)`：数量兜底（当前只写了「不要超过」，实测无效）——
   - 令 `keep = max(target, plan.stages.length)`（每个阶段至少保留 1 条任务，这是现有校验的硬要求）；
   - 总任务数 `count <= keep` 时原样返回；
   - `count > keep` 时**全局等距抽样**：按阶段顺序把所有任务展开成一维序号 `0..count-1`，保留满足 `round(i * keep / count)` 首次出现的那些序号（即均匀降采样），保持原有阶段顺序与任务日期顺序；
   - 保证每个阶段至少 1 条：若某阶段被抽空，保留该阶段第一条，并从「任务最多的阶段」再删除一条，把总数压回 `<= keep`；
   - `count < target` 时**不补、不报错**，只 `console.warn` 记录实际数量与目标数量（模型无法凭空生成更多任务，不能因此让用户白等一次失败）。
3. `resolveConflicts(plan, occupiedSlots, { preciseTime, startDate, endDate })`：时间冲突兜底（提示词约束同样不可靠）——
   - `preciseTime !== true` 时直接返回（全天任务不排钟点）；
   - 构造占用表：`currentTasks` 中 `allDay === false` 的每条按 `[start, start + duration)`（分钟）挂到它的 `date` 上；再把自己计划里已放置的任务加入同一张表；
   - 按日期升序遍历计划任务：与原时段无重叠则放置；有重叠则按「离原时间最近」的顺序搜索同日空闲时段，候选偏移序列 `0, +15, -15, +30, -30, +45, -45, …`（步长 15 分钟，最多 ±360 分钟），要求 `start >= 0`、`start + duration <= 1440`（不得跨越午夜）、且不与当天任何已占用区间相交；
   - 当天找不到：顺延到 `+1 … +14` 天（不得超过 `endDate`）；仍找不到再往回找 `-1 … -14` 天（不得早于 `startDate`）；
   - 全都无解：**保留原时段**并 `console.warn`（前端导入时仍有冲突弹窗兜底），**绝不静默丢弃用户想要的任务**；
   - 移动后必须满足：`startTime` 仍是 `HH:mm`、`date` 仍在 `[startDate, endDate]` 内、`duration` 不变、计划内部任务之间也不重叠。
4. 在 `module.exports` 里额外导出 `densityTarget`、`enforceDensity`、`resolveConflicts` 供单元测试使用（不影响现有 `makeStudyPlan`、`parseScheduleFromImage` 导出）。

### A3. 提示词硬化（配合 A2，不要只做这一层）

1. 把密度与冲突约束**在 system 末尾再复述一次**（模型对末尾指令更敏感），例如追加：
   「硬性要求：本次计划全部阶段合计的任务总数目标为 N 个（允许上下浮动 30%）；输出前请自行数一遍任务数，并逐日核对自己的任务之间、以及与已占用清单之间没有任何时段重叠。」
2. 把「已占用清单」从纯文本行改成按日期分组的紧凑结构，并附当天已占用总时长，例如：
   `2026-10-12（已占 3.5 小时）：09:00-09:45 高数第三章；14:00-15:00 英语听力`
   全天任务单独一行：`2026-10-14：全天 复习日`。
3. 在 `CONFLICT_PROMPT` 里明确 `preferredWindow` 的优先级语义：先在偏好时间段内的空闲时段安排，偏好时段排满再考虑同日相邻时段，最后才顺延到其它日期。
4. （可选增强）额外附上一句轻量统计，帮助模型匹配用户真实负担：近 30 天已完成日程的**条数与总时长**（不含任务名，控制 token），说明「用于估计用户每天实际可承担的任务量，不参与冲突判断」。

### A4. 测试与验收（必须逐条验证并写进交付说明）

1. 拓展 `tests/deepseek-schedule-plan.js`：
   - **保留**现有「无冲突、数量不超目标时原样返回」的断言（不允许削弱既有断言）；
   - 新增用例：① 超过目标数量的计划被均匀裁剪且每阶段至少 1 条；② 与已占用时段重叠的任务被移到最近的空闲时段（右移/左移各一例）；③ 当天排满时顺延到次日；④ 跨午夜边界不产生非法时间（`start + duration <= 1440`）；⑤ 完全无解时保留原时段（不丢任务）。
2. `npm test` 必须通过。
3. 手工验收（写清结果）：
   - 同一目标、同一区间分别用轻松/中度/忙碌生成：任务总数依次明显递增，并落在各自目标 ±30% 内（因「每阶段至少 1 条」可能略高于上限）；
   - 先在 10 月 12 日 09:00 建一条 45 分钟任务，再生成规划：新任务与该时段不重叠；
   - 控制台能看到 `[ai-plan] density=…, currentTasks=…条, …` 诊断行，且密度/清单取值与实际选择一致。

---

## 需求二：新建任务弹窗支持新增分类；选择「全天」分类时只排到当天

### B1. 弹窗内新增分类（与设置中的分类一致）

1. 在 `#task-dialog` 内、「任务分类 `#task-category`」下方新增：
   - `＋ 新增分类` 按钮：`<button id="task-add-category" class="text-button" type="button" aria-expanded="false" aria-controls="task-new-category">`；
   - 内联小表单容器 `<div id="task-new-category" class="task-new-category" hidden>`，内含 `#task-new-category-name`（`type="text"`、`maxlength="24"`、placeholder「分类名称」）、`#task-new-category-color`（`type="color"`、`value="#6a8faf"`、`aria-label="分类颜色"`）、`#task-new-category-save`（`type="button"`、「添加」）、`#task-new-category-cancel`（`type="button"`、「取消」）、`#task-new-category-error`（`class="form-error" role="alert" hidden`）。
   - ⚠️ **`#task-form` 本身就是 `<form>`，不能嵌套 `<form>`**：小表单必须用 `<div>` + `type="button"` 按钮实现，否则浏览器会把 DOM 结构拆坏。
2. 抽出一个共享函数（例如 `addCategory(name, color)`）供**设置页 `#category-form`（script.js 857–863 行）与新弹窗共同调用**，校验规则只有一份：
   - 名称 `trim` 后 1–24 字；不能与现有分类重名；颜色匹配 `^#[0-9a-fA-F]{6}$`；`state.categories.length < 200`（超出提示「分类数量已达上限，请先整理现有分类。」——`/api/sync` 的 `validateState` 会拒绝超过 200 个分类，不拦会直接导致保存失败）；
   - 失败时把中文原因写进 `#task-new-category-error`（弹窗内）或沿用设置页现有的 `showNotice`（设置页行为保持不变）。
3. 成功后：`state.categories.push({ id: id(), name, color })` → `save()` → `renderSettings()` → `renderCategorySelect(新分类 id)`（自动选中）→ `updateAllDayVisibility()` → 清空输入、收起小表单、`aria-expanded="false"`、`toast("分类已添加。")`。
   **不要关闭 `#task-dialog`**，也不要丢掉用户已填写的任务名称、日期、备注等输入。
4. 交互与无障碍：展开后焦点自动落在 `#task-new-category-name`；「取消」与在名称输入框按 `Esc` 都只收起小表单、不提交、不关闭任务弹窗；`#task-add-category` 再次点击可切换展开/收起；小表单样式写入 `upgrade.css`，与设置页 `.category-add` 视觉一致（浅色底、圆角、紧凑内边距），窄屏不溢出。
5. 分类删除/重命名仍然只在设置页进行，弹窗内不提供删除入口。

### B2. 选择「全天」分类 = 只排到当天、不排钟点

在校验现有实现的基础上补齐这些点（任何入口都不能给全天任务带上钟点）：

1. 分类切到「全天」时：隐藏「单次执行时长」「提醒设置」「时间设置方式」「开始时间」四个字段（现有 `updateAllDayVisibility()`/`updateTimeVisibility()` 已做），并保证 `#task-time` 的 `required` 被清掉（否则表单校验会拦住提交）。
2. 从「全天」切回普通分类时：上述字段恢复可见，`required` 恢复，`#task-time`、`#task-duration`（默认 45）、`#task-reminder`（默认 15）回到可用状态；确认 `#task-category` 的 `change` 监听在**新增分类**后依然生效（新分类是动态重建 `<option>`，不要把监听绑到 option 上）。
3. 编辑已有全天任务（`openTask`）时同样不显示任何钟点字段；`#task-end-date`、重复设置、备注、复习开关等其它字段照常可用。
4. 保存与展示：`allDay = true`、`duration = 1`、`reminder = 0`、`time = "00:00"`、`timeMode = "fixed"`（现有 `readTaskForm()`/`saveManualDraft()` 已如此，回归确认）；日历卡片、每日任务、搜索结果都显示「全天」而不是 `00:00–00:01`；ICS 使用 `DTSTART;VALUE=DATE` + 次日 `DTEND;VALUE=DATE`。
5. 全天任务不参与时间冲突判断（`findConflicts` 对 `task.allDay` 直接返回空数组），也不参与 16 小时时长超限提醒（`overloadedDays()` 已跳过全天）——回归确认没有被其它改动破坏。
6. 全天任务仍可开启艾宾浩斯复习与手动重复（保持现状），只是不带钟点。
7. 导入 AI 规划时 `preciseTime = false` 的路径（父任务与子任务都使用「全天」分类）也要符合以上行为，不要出现「全天分类但带钟点」的记录。

### B3. 验收（写进交付说明）

1. 新建任务弹窗点「＋ 新增分类」→ 输入名称与颜色 → 添加后新分类立刻出现在下拉框且被自动选中；设置页分类列表同步可见；保存后刷新、退出重登仍然存在。
2. 重名 / 超过 24 字 / 分类已达 200 个：给出中文提示、不添加、不关闭弹窗。
3. 选择「全天」：钟点相关字段全部隐藏，保存后日历与每日任务显示「全天」，导出的 ICS 为全天事件，不触发冲突弹窗与时长超限提醒；切回普通分类后钟点字段恢复正常并保留已填数值。
4. `npm test` 通过；桌面与手机宽度下新增分类小表单与任务弹窗布局正常、无溢出。

---

## 全局约束

- 不要改动作息表、图片识别导入、搜索/布局/导航/折叠、导出、便签、登录注册等模块的行为。
- 不要引入新依赖、新接口或新数据表；不要修改 `/api/sync` 的字段契约。
- 不要为了「让测试通过」而删除或放宽 `tests/` 中已有的断言。
- 改过的静态资源记得提升 `index.html` 里的 `?v=`。

## 交付说明

输出：① 改动文件清单与要点；② 需求一 A4 的手工验收结果（含控制台诊断行样例）；③ 需求二 B3 的验收结果；④ `npm test` 实际输出；⑤ 是否重启过 Node 进程、`?v=` 提升到了多少。
