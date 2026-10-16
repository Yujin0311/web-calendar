# 任务：AI 规划密度/历史任务修复 + 新建任务新增分类与「全天」语义

仓库 `D:\清序网站\web-calendar`（无构建，改完 `npm start`；**后端改动必须重启 Node 进程**）。只改根目录文件，不动 `web-calendar\web-calendar\` 副本。改过 `index.html` 引用的资源就把 `?v=` +1。

## 需求一：AI 规划必须真正按密度和历史任务

现状：密度与占用清单已接通（`#ai-plan-density` → `ai-plan-client.js:84` → `server.js /api/ai-plan` → `services/deepseekSchedule.js` 的 `DENSITY_PROMPTS`/`CONFLICT_PROMPT`/`buildUserPrompt`），但只是提示词软约束、且只写了「不要超过」，模型照样超量与排重叠。

1. **可观测**：`/api/ai-plan` 加日志 `[ai-plan] density=…, currentTasks=…条, target=…`（target 用下面同一函数算）；服务层再区分「占用清单为空」与非空条数。
2. **服务层确定性兜底**（`services/deepseekSchedule.js`，在 `validateSchedule` 之后依次执行；**返回结构与键名不变、不加字段**）：
   - `densityTarget(days, density)`：light=`max(1,round(days/7*1.5))`、medium=`max(1,round(days/2))`、busy=`days`，≤200；`buildUserPrompt:141` 的内联算法改用它，保持单一来源。
   - `enforceDensity(plan, target)`：`keep=max(target, 阶段数)`；超量时全局等距抽样（按阶段展开成一维序号，保留 `round(i*keep/count)` 首次命中项），每阶段至少留 1 条（被抽空则留首条，并从任务最多的阶段再删一条压回上限）；不足 target 时不补不报错，仅 `console.warn`。
   - `resolveConflicts(plan, occupied, {preciseTime,startDate,endDate})`：`preciseTime!==true` 原样返回；占用表取自 `currentTasks` 中 `allDay===false` 的 `[start,start+duration)`，按日期升序逐条检查；冲突时找离原时间最近的同日空闲时段（偏移 `0,+15,-15,+30,-30,…`，≤±360 分钟，须 `start≥0`、`start+duration≤1440`）；当天无解顺延 `+1…+14` 天、再回找 `-1…-14` 天（不越 `[startDate,endDate]`）；仍无解保留原时段并 `console.warn`，**绝不丢任务**。
   - 额外导出 `densityTarget`/`enforceDensity`/`resolveConflicts` 供单测。
3. **提示词硬化**：system 末尾复述「总任务数目标 N（±30%），输出前自查数量并逐日核对重叠」；占用清单改为按日期分组并附当天已占时长（`2026-10-12（已占 3.5 小时）：09:00-09:45 高数…`），全天任务单独一行；`preferredWindow` 优先级＝偏好时段内空闲 → 同日相邻时段 → 顺延日期。
4. **测试**：`tests/deepseek-schedule-plan.js` **保留**现有「原样返回」断言，新增 5 例——超量裁剪且每阶段≥1、冲突左右移、当天满顺延次日、跨午夜不越界、无解保留原时段；`npm test` 通过。手工验证：三档任务数明显递增且落在目标 ±30%，已有 09:00 任务不再被重叠。

## 需求二：新建任务弹窗

1. **新增分类**：「任务分类」下方加 `#task-add-category`（`type=button`、`aria-expanded`）+ 内联 `<div id="task-new-category" hidden>`（`#task-new-category-name` maxlength 24、`#task-new-category-color` 默认 `#6a8faf`、`#task-new-category-save`、`#task-new-category-cancel`、`#task-new-category-error`）。⚠️ `#task-form` 本身是 `<form>`，**不能嵌套 form**，用 div + button。校验抽成共享 `addCategory()`，设置页 `#category-form`（`script.js:857-863`）同步复用：名称 1–24 字、不重名、颜色 `^#[0-9a-fA-F]{6}$`、分类数 <200（超出提示「分类数量已达上限…」，否则 `/api/sync` 的 `validateState` 会拒）。成功后 `save()` + `renderSettings()` + `renderCategorySelect(新id)` 自动选中 + `updateAllDayVisibility()` + toast，**不关闭弹窗、不丢已填字段**；展开后聚焦名称框，Esc/取消只收起。
2. **「全天」分类**：切到全天时隐藏时长/提醒/时间方式/开始时间并清掉 `#task-time` 的 `required`；切回普通分类时字段与 required 恢复、默认 45/15 可用（新增分类后 `#task-category` 的 change 仍要生效，不要把监听绑到 option）；编辑已有全天任务同样无钟点字段；保存为 `allDay=true, duration=1, reminder=0, time="00:00", timeMode="fixed"`；日历/每日任务/搜索显示「全天」；ICS 用 `DTSTART;VALUE=DATE` + 次日 `DTEND`；不参与冲突判断与 16 小时提醒；仍可开复习与重复；AI 规划 `preciseTime=false` 路径一致。
3. **验收**：添加分类后下拉即时可用、设置页可见、重登仍在；重名/超长/满 200 有中文提示且不关弹窗；全天任务无钟点、ICS 为全天事件、切回普通分类字段恢复。

## 约束与交付

不改作息表、图片识别导入、搜索/布局/导航/折叠、导出、便签、登录注册模块；不加依赖/接口/数据表，不动 `/api/sync` 字段契约；不为过测而放宽已有断言。交付：① 改动文件清单；② 两条手工验收结果（含日志样例）；③ `npm test` 输出；④ 是否重启过 Node、`?v=` 提到多少。
