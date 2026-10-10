/* 清序前端：登录后同步到本机服务，localStorage 保留当前用户的离线缓存。 */
(() => {
  "use strict";

  const STORAGE_KEY = "qingxu-planner-v1";
  const DEFAULT_OFFSETS = [0, 1, 2, 4, 7, 15, 30];
  const DEFAULT_CATEGORIES = [
    { id: "math", name: "高数学习", color: "#6d8fc1" },
    { id: "words", name: "背单词", color: "#8c9bc8" },
    { id: "course", name: "课程", color: "#74a896" },
    { id: "practice", name: "刷题", color: "#d49a70" },
    { id: "reading", name: "阅读", color: "#a48eb8" }
  ];

  // 国务院办公厅 2025、2026 年放假通知中的日期；下面仅保留工作日。
  // 2025：https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm
  // 2026：https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
  const HOLIDAY_RANGES = [
    ["2025-01-01", "2025-01-01"], ["2025-01-28", "2025-02-04"],
    ["2025-04-04", "2025-04-06"], ["2025-05-01", "2025-05-05"],
    ["2025-05-31", "2025-06-02"], ["2025-10-01", "2025-10-08"],
    ["2026-01-01", "2026-01-03"], ["2026-02-15", "2026-02-23"],
    ["2026-04-04", "2026-04-06"], ["2026-05-01", "2026-05-05"],
    ["2026-06-19", "2026-06-21"], ["2026-09-25", "2026-09-27"],
    ["2026-10-01", "2026-10-07"]
  ];

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  // 第二版只增量插入新字段与按钮，保留第一版表单的原有结构。
  $("#task-date").closest("label").insertAdjacentHTML("afterend", '<label class="field"><span>任务终止日期 <b>*</b></span><input id="task-end-date" type="date" required></label>');
  $("#task-note").closest("label").querySelector("span").textContent = "备注";
  $("#task-form .modal-actions button[type='submit']").insertAdjacentHTML("beforebegin", '<button id="save-draft" class="button secondary" type="button">存草稿</button>');
  $("#toggle-password").textContent = "👁";
  // 手动重复单独配置；艾宾浩斯仍由原有复习开关与节点控制。
  $("#task-review").closest("label").insertAdjacentHTML("beforebegin", '<div class="field full repeat-field"><label for="task-repeat">重复设置</label><select id="task-repeat"><option value="none">不重复</option><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option><option value="yearly">每年</option></select><div id="repeat-weekdays" class="repeat-weekdays" hidden><span>选择星期（可多选）</span><div><label><input type="checkbox" value="MO">周一</label><label><input type="checkbox" value="TU">周二</label><label><input type="checkbox" value="WE">周三</label><label><input type="checkbox" value="TH">周四</label><label><input type="checkbox" value="FR">周五</label><label><input type="checkbox" value="SA">周六</label><label><input type="checkbox" value="SU">周日</label></div></div><small>手动重复与艾宾浩斯复习互斥；重复系列导出为一个 VEVENT + RRULE。</small></div>');
  $("#download-ics").insertAdjacentHTML("afterend", '<button id="reset-ics-history" class="button ghost" type="button">清空导出记录</button>');
  $("#export-tutorial").insertAdjacentHTML("afterbegin", '<p class="export-memory-note">增量导出按任务记录：首次导出全部任务，此后只导出新建任务。修改已导出的任务后，如需重新导入，请先点「清空导出记录」。</p>');
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const pad = (number) => String(number).padStart(2, "0");
  const id = () => (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  // 用 UTC 处理纯日期，避免电脑所在时区和夏令时改变复习节点。
  function dateValue(iso) {
    const [year, month, day] = iso.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  }
  function dateFromValue(value) { return new Date(value).toISOString().slice(0, 10); }
  function addDays(iso, days) { return dateFromValue(dateValue(iso) + days * 86400000); }
  function isValidDate(iso) {
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) && dateFromValue(dateValue(iso)) === iso;
  }
  function isWeekend(iso) { return [0, 6].includes(new Date(dateValue(iso)).getUTCDay()); }
  function minutes(time) { const [hour, minute] = time.split(":").map(Number); return hour * 60 + minute; }
  function timeFromMinutes(value) { return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`; }
  function todayShanghai() {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }
  function defaultHolidays() {
    const result = [];
    for (const [start, end] of HOLIDAY_RANGES) {
      for (let day = start; day <= end; day = addDays(day, 1)) if (!isWeekend(day)) result.push(day);
    }
    return result;
  }
  function initialState() {
    return { categories: clone(DEFAULT_CATEGORIES), tasks: [], drafts: [], settings: { offsets: [...DEFAULT_OFFSETS], defaultTime: "09:00", holidays: defaultHolidays() } };
  }
  function loadState() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!stored || !Array.isArray(stored.tasks) || !Array.isArray(stored.drafts) || !Array.isArray(stored.categories)) return initialState();
      const defaults = initialState();
      stored.settings = { ...defaults.settings, ...(stored.settings || {}) };
      return stored;
    } catch { return initialState(); }
  }
  let state = initialState();
  let selectedDate = todayShanghai();
  let displayedMonth = selectedDate.slice(0, 7);
  let editing = null; // { source: "tasks" | "drafts", id }
  let toastTimer;

  function save() {
    try { return window.QingxuAuth.save(state); }
    catch { showNotice("保存失败", "浏览器无法写入当前账户的离线缓存。请检查存储空间或浏览器隐私设置。"); return false; }
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  }
  function categoryFor(task) { return state.categories.find((item) => item.id === task.categoryId) || { name: task.categoryName || "未分类", color: "#8795a1" }; }
  function typeLabel(event) { return event.round === -1 ? "重复日程" : event.round === 0 ? "初次学习" : `复习第${event.round}轮`; }
  // 同一任务全部复习日程使用完全相同的 ICS 标题；轮次只写进 DESCRIPTION。
  function fullTitle(task) { return `【${categoryFor(task).name}】${task.name}`; }
  function eventEnd(event) {
    const end = minutes(event.time) + event.duration;
    return { date: end === 1440 ? addDays(event.date, 1) : event.date, time: timeFromMinutes(end % 1440) };
  }
  function tagHtml(category) {
    return `<span class="tag" style="--tag-bg:${escapeHtml(category.color)}1c;--tag-color:${escapeHtml(category.color)}">${escapeHtml(category.name)}</span>`;
  }
  function allEntries() {
    return state.tasks.flatMap((task) => task.events.map((event) => ({ task, event }))).sort((a, b) =>
      a.event.date.localeCompare(b.event.date) || a.event.time.localeCompare(b.event.time) || a.task.name.localeCompare(b.task.name));
  }

  // 保存的是完整的日程快照。之后调整节点或默认时间不会改写已有任务。
  function generateEvents(task, previousEvents = []) {
    const offsets = task.review ? state.settings.offsets : [0];
    const oldByOffset = new Map(previousEvents.map((event) => [event.offset, event]));
    const events = [];
    const skipped = [];
    for (let index = 0; index < offsets.length; index++) {
      const offset = offsets[index];
      if (task.deletedOffsets?.includes(offset)) continue;
      const date = addDays(task.date, offset);
      if (task.endDate && date > task.endDate) continue;
      if (categoryFor(task).name === "课程" && state.settings.holidays.includes(date) && !isWeekend(date)) {
        skipped.push(date);
        continue;
      }
      const old = oldByOffset.get(offset);
      const time = task.timeMode === "fixed" ? task.time : state.settings.defaultTime;
      events.push({ id: old?.id || id(), offset, round: index, date, time, duration: task.duration, completed: Boolean(old?.completed && old.date === date && old.time === time && old.duration === task.duration) });
    }
    return { events, skipped };
  }

  // 手动重复使用独立路径；只在网页中展开每日预览，ICS 导出时折叠为单个 RRULE 系列。
  function generateRecurringEvents(task, previousEvents = []) {
    const oldByOffset = new Map(previousEvents.map((event) => [event.offset, event]));
    const events = [], skipped = [];
    const baseDay = Number(task.date.slice(8));
    const baseMonthDay = task.date.slice(5);
    const weekdayCodes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    const span = (dateValue(task.endDate) - dateValue(task.date)) / 86400000;
    for (let offset = 0; offset <= span; offset++) {
      const date = addDays(task.date, offset);
      const match = task.recurrence.type === "daily" ||
        (task.recurrence.type === "weekly" && task.recurrence.weekdays.includes(weekdayCodes[new Date(dateValue(date)).getUTCDay()])) ||
        (task.recurrence.type === "monthly" && Number(date.slice(8)) === baseDay) ||
        (task.recurrence.type === "yearly" && date.slice(5) === baseMonthDay);
      if (!match || task.deletedOffsets?.includes(offset)) continue;
      if (categoryFor(task).name === "课程" && state.settings.holidays.includes(date) && !isWeekend(date)) { skipped.push(date); continue; }
      const time = task.timeMode === "fixed" ? task.time : state.settings.defaultTime;
      const old = oldByOffset.get(offset);
      events.push({ id: old?.id || id(), offset, round: -1, date, time, duration: task.duration, completed: Boolean(old?.completed && old.date === date && old.time === time && old.duration === task.duration) });
    }
    return { events, skipped };
  }

  // 半开区间 [开始, 结束)；一个任务刚好在另一个任务结束时开始，不算冲突。
  function findConflicts(candidate, excludedTaskId) {
    // 按日期建立索引，长周期的每天重复任务无需反复扫描全部日程。
    const existingByDate = new Map();
    for (const entry of allEntries()) {
      if (entry.task.id === excludedTaskId) continue;
      const sameDay = existingByDate.get(entry.event.date) || [];
      sameDay.push(entry);
      existingByDate.set(entry.event.date, sameDay);
    }
    const conflicts = [];
    for (const event of candidate.events) {
      const start = minutes(event.time), end = start + event.duration;
      for (const other of existingByDate.get(event.date) || []) {
        const otherStart = minutes(other.event.time), otherEnd = otherStart + other.event.duration;
        if (start < otherEnd && otherStart < end) conflicts.push({ event, other });
      }
    }
    return conflicts;
  }
  function overloadedDays() {
    const totals = new Map();
    for (const { event } of allEntries()) totals.set(event.date, (totals.get(event.date) || 0) + event.duration);
    return [...totals].filter(([, total]) => total > 960).map(([date]) => date);
  }

  function showNotice(title, message) {
    return new Promise((resolve) => {
      const dialog = $("#notice-dialog");
      $("#notice-title").textContent = title;
      $("#notice-message").textContent = message;
      const close = () => { dialog.close(); resolve(); };
      $("#notice-close").onclick = close;
      $("#notice-close-x").onclick = close;
      dialog.oncancel = (event) => { event.preventDefault(); close(); };
      dialog.showModal();
    });
  }
  function showConflict(conflicts, candidate) {
    return new Promise((resolve) => {
      const dialog = $("#conflict-dialog");
      $("#conflict-list").innerHTML = conflicts.slice(0, 50).map(({ event, other }) =>
        `<li><strong>${escapeHtml(event.date)}</strong>：${escapeHtml(candidate.name)}（${escapeHtml(event.time)}–${escapeHtml(eventEnd(event).time)}）与 ${escapeHtml(other.task.name)}（${escapeHtml(other.event.time)}–${escapeHtml(eventEnd(other.event).time)}）</li>`).join("") + (conflicts.length > 50 ? `<li>另有 ${conflicts.length - 50} 处冲突，请调整重复范围或时间。</li>` : "");
      const finish = (choice) => { dialog.close(); resolve(choice); };
      $("#conflict-keep").onclick = () => finish("keep");
      $("#conflict-draft").onclick = () => finish("draft");
      dialog.oncancel = (event) => { event.preventDefault(); finish("keep"); };
      dialog.showModal();
    });
  }
  function toast(message) {
    const element = $("#toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("show"), 3500);
  }

  function showView(name) {
    if (!window.QingxuAuth.isAuthenticated()) return;
    $$(".view").forEach((view) => { view.hidden = view.id !== `view-${name}`; });
    $$(".nav-button").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
    $("#export-tutorial").hidden = name !== "plan";
    if (name === "settings") renderSettings();
    if (name === "drafts") renderDrafts();
  }
  function render() {
    const entries = allEntries();
    $("#stat-tasks").textContent = state.tasks.length;
    $("#stat-events").textContent = entries.length;
    $("#stat-done").textContent = entries.filter(({ event }) => event.completed).length;
    $("#draft-count").textContent = state.drafts.length;
    renderCalendar(entries);
    renderDay(entries);
    // 在原任务卡片上增补“仅删除本次”，保留已有的整条任务删除行为。
    $$(".event-card").forEach((card) => {
      const batchButton = card.querySelector(".delete-task");
      const occurrenceId = card.querySelector(".complete-check")?.dataset.eventId;
      if (batchButton && occurrenceId) {
        batchButton.textContent = "删除整套";
        batchButton.insertAdjacentHTML("beforebegin", `<button class="text-button delete-event" type="button" data-id="${escapeHtml(occurrenceId)}">仅删除本次</button>`);
      }
    });
    renderDrafts();
  }
  function renderCalendar(entries) {
    const [year, month] = displayedMonth.split("-").map(Number);
    $("#month-label").textContent = `${year} 年 ${month} 月`;
    const first = `${year}-${pad(month)}-01`;
    const firstWeekday = (new Date(dateValue(first)).getUTCDay() + 6) % 7;
    const start = addDays(first, -firstWeekday);
    const byDate = new Map();
    for (const entry of entries) {
      if (!byDate.has(entry.event.date)) byDate.set(entry.event.date, []);
      byDate.get(entry.event.date).push(entry.event);
    }
    const today = todayShanghai();
    $("#calendar-grid").innerHTML = Array.from({ length: 42 }, (_, index) => {
      const date = addDays(start, index), dayEvents = byDate.get(date) || [];
      const classes = ["calendar-day", date.slice(0, 7) === displayedMonth ? "" : "outside", date === selectedDate ? "selected" : "", date === today ? "today" : ""].filter(Boolean).join(" ");
      const dots = dayEvents.length ? `<span class="day-dots"><i class="${dayEvents.every((event) => event.completed) ? "done" : ""}"></i>${dayEvents.length > 1 ? `<i class="${dayEvents.every((event) => event.completed) ? "done" : ""}"></i>` : ""}</span>` : "";
      return `<button class="${classes}" type="button" data-date="${date}" aria-label="${date}，${dayEvents.length} 项日程"><span class="day-number">${Number(date.slice(-2))}</span>${dots}</button>`;
    }).join("");
  }
  function renderDay(entries) {
    const dayEntries = entries.filter(({ event }) => event.date === selectedDate);
    const total = dayEntries.reduce((sum, { event }) => sum + event.duration, 0);
    $("#selected-day-label").textContent = `${selectedDate.slice(5, 7)} 月 ${selectedDate.slice(8)} 日任务`;
    $("#day-total").textContent = `${Math.floor(total / 60)} 小时 ${total % 60} 分钟`;
    $("#day-list").innerHTML = dayEntries.length ? dayEntries.map(({ task, event }) => {
      const category = categoryFor(task);
      return `<article class="event-card ${event.completed ? "done" : ""}"><input class="complete-check" type="checkbox" data-task-id="${escapeHtml(task.id)}" data-event-id="${escapeHtml(event.id)}" ${event.completed ? "checked" : ""} aria-label="完成 ${escapeHtml(task.name)} ${escapeHtml(typeLabel(event))}"><div class="event-main"><div class="event-name">${escapeHtml(task.name)}</div><div class="event-meta">${tagHtml(category)}<span>${escapeHtml(typeLabel(event))}</span><span>${escapeHtml(event.time)}–${escapeHtml(eventEnd(event).time)}</span>${task.timeMode === "default" ? "<span>默认时间</span>" : ""}</div>${task.note ? `<p class="event-note">${escapeHtml(task.note)}</p>` : ""}</div><div class="card-actions"><button class="text-button edit-task" type="button" data-id="${escapeHtml(task.id)}">编辑</button><button class="text-button danger delete-task" type="button" data-id="${escapeHtml(task.id)}" title="删除整条任务及全部复习日程">删除</button></div></article>`;
    }).join("") : `<div class="empty-state"><strong>这一天还没有日程</strong>选择其他日期，或新建一条任务。</div>`;
  }
  function renderDrafts() {
    $("#draft-list").innerHTML = state.drafts.length ? state.drafts.map((task) =>
      `<article class="draft-card"><div>${tagHtml(categoryFor(task))}<h3>${escapeHtml(task.name)}</h3><p>起始日期 ${escapeHtml(task.date)} · ${task.duration} 分钟 · ${task.review ? "艾宾浩斯复习" : (task.draftForm?.repeatType || task.recurrence?.type || "none") !== "none" ? "手动重复" : "单次任务"}</p></div><div class="draft-actions"><button class="button secondary edit-draft" type="button" data-id="${escapeHtml(task.id)}">编辑并提交</button><button class="button ghost delete-draft" type="button" data-id="${escapeHtml(task.id)}">删除</button></div></article>`).join("") : `<div class="empty-state"><strong>草稿箱是空的</strong>发生时间冲突并选择修改时，任务会出现在这里。</div>`;
  }
  function renderCategorySelect(selectedId) {
    const select = $("#task-category");
    select.innerHTML = state.categories.map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`).join("");
    if (selectedId && state.categories.some((category) => category.id === selectedId)) select.value = selectedId;
  }
  function renderSettings() {
    $("#review-offsets").value = state.settings.offsets.join(", ");
    $("#default-time").value = state.settings.defaultTime;
    $("#holiday-dates").value = state.settings.holidays.join("\n");
    $("#category-list").innerHTML = state.categories.map((category) =>
      `<div class="category-item">${tagHtml(category)}<button class="text-button edit-category" data-id="${escapeHtml(category.id)}" type="button">编辑</button><button class="text-button danger delete-category" data-id="${escapeHtml(category.id)}" type="button">删除</button></div>`).join("");
  }

  function openTask(source = null, taskId = null) {
    if (!window.QingxuAuth.isAuthenticated()) { showNotice("请先登录", "登录后才能新建或编辑任务。"); return; }
    editing = source && taskId ? { source, id: taskId } : null;
    const task = editing ? state[source].find((item) => item.id === taskId) : null;
    const draftForm = source === "drafts" ? task?.draftForm : null;
    if (editing && !task) return;
    $("#task-dialog-title").textContent = task ? (source === "drafts" ? "编辑草稿并提交" : "编辑任务") : "新建任务";
    $("#task-form").reset();
    $("#form-error").hidden = true;
    renderCategorySelect(task?.categoryId);
    $("#task-name").value = draftForm?.name ?? task?.name ?? "";
    $("#task-date").value = draftForm?.date ?? task?.date ?? todayShanghai();
    $("#task-end-date").value = draftForm?.endDate ?? (task?.endDate || addDays(task?.date || todayShanghai(), task?.review === false ? 0 : Math.max(...state.settings.offsets)));
    $("#task-duration").value = draftForm?.duration ?? task?.duration ?? 45;
    $("#task-reminder").value = String(task?.reminder ?? 15);
    $("#task-time").value = draftForm?.time ?? task?.time ?? state.settings.defaultTime;
    $("#task-note").value = draftForm?.note ?? task?.note ?? "";
    $("#task-review").checked = task?.review ?? true;
    $("#task-repeat").value = draftForm?.repeatType ?? task?.recurrence?.type ?? "none";
    $$("#repeat-weekdays input").forEach((input) => { input.checked = Boolean((draftForm?.weekdays ?? task?.recurrence?.weekdays)?.includes(input.value)); });
    $(`input[name="time-mode"][value="${task?.timeMode || "fixed"}"]`).checked = true;
    updateTimeVisibility();
    updateRepeatVisibility();
    $("#task-dialog").showModal();
    $("#task-name").focus();
  }
  function updateTimeVisibility() {
    const fixed = $("input[name='time-mode']:checked").value === "fixed";
    $("#fixed-time-field").hidden = !fixed;
    $("#task-time").required = fixed;
  }
  function updateRepeatVisibility() {
    const repeated = $("#task-repeat").value !== "none";
    $("#repeat-weekdays").hidden = $("#task-repeat").value !== "weekly";
    if (repeated) $("#task-review").checked = false;
  }
  function formError(message) { $("#form-error").textContent = message; $("#form-error").hidden = false; }
  function readTaskForm() {
    const name = $("#task-name").value.trim(), categoryId = $("#task-category").value;
    const date = $("#task-date").value, endDate = $("#task-end-date").value, duration = Number($("#task-duration").value);
    const reminder = Number($("#task-reminder").value);
    const repeatType = $("#task-repeat").value;
    const weekdays = repeatType === "weekly" ? $$("#repeat-weekdays input:checked").map((input) => input.value) : [];
    const timeMode = $("input[name='time-mode']:checked").value;
    const time = timeMode === "fixed" ? $("#task-time").value : state.settings.defaultTime;
    if (!name) throw Error("请填写任务名称。");
    if (!state.categories.some((item) => item.id === categoryId)) throw Error("请选择任务分类。");
    if (!isValidDate(date)) throw Error("请选择有效的起始日期。");
    if (!isValidDate(endDate) || endDate < date) throw Error("终止日期不能早于起始日期。");
    if (repeatType === "weekly" && !weekdays.length) throw Error("每周重复至少选择一个星期。");
    if (repeatType !== "none" && (dateValue(endDate) - dateValue(date)) / 86400000 > 3650) throw Error("重复任务的日期跨度最多为 10 年。");
    if (!Number.isInteger(duration) || duration < 1 || duration > 1440) throw Error("执行时长须为 1–1440 分钟的整数。");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw Error("请选择有效的开始时间。");
    if (minutes(time) + duration > 1440) throw Error("单次任务不能跨越午夜，请调整开始时间或时长。");
    return { name, categoryId, categoryName: state.categories.find((item) => item.id === categoryId).name, date, endDate, duration, reminder, timeMode, time, note: $("#task-note").value.trim(), review: repeatType === "none" && $("#task-review").checked, recurrence: { type: repeatType, weekdays } };
  }
  function saveManualDraft() {
    if (!window.QingxuAuth.isAuthenticated()) return;
    const old = editing ? state[editing.source].find((task) => task.id === editing.id) : null;
    const draftForm = { name: $("#task-name").value, date: $("#task-date").value, endDate: $("#task-end-date").value, duration: $("#task-duration").value, time: $("#task-time").value, note: $("#task-note").value, repeatType: $("#task-repeat").value, weekdays: $$("#repeat-weekdays input:checked").map((input) => input.value) };
    const categoryId = $("#task-category").value || state.categories[0]?.id;
    const category = state.categories.find((item) => item.id === categoryId);
    const date = isValidDate($("#task-date").value) ? $("#task-date").value : todayShanghai();
    const rawEndDate = $("#task-end-date").value;
    const endDate = isValidDate(rawEndDate) && rawEndDate >= date ? rawEndDate : "";
    const rawDuration = Number($("#task-duration").value);
    const duration = Number.isInteger(rawDuration) && rawDuration >= 1 && rawDuration <= 1440 ? rawDuration : 45;
    const timeMode = $("input[name='time-mode']:checked").value;
    const rawTime = $("#task-time").value;
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(rawTime) ? rawTime : state.settings.defaultTime;
    const validRepeat = endDate && (dateValue(endDate) - dateValue(date)) / 86400000 <= 3650 && (draftForm.repeatType !== "weekly" || draftForm.weekdays.length);
    const recurrence = validRepeat ? { type: draftForm.repeatType, weekdays: draftForm.repeatType === "weekly" ? draftForm.weekdays : [] } : { type: "none", weekdays: [] };
    const task = { id: old?.id || id(), name: $("#task-name").value.trim() || "未命名草稿", categoryId, categoryName: category?.name || "未分类", date, endDate, duration, reminder: Number($("#task-reminder").value), timeMode, time, note: $("#task-note").value.trim(), review: recurrence.type === "none" && $("#task-review").checked, recurrence, deletedOffsets: old?.deletedOffsets || [], draftForm, events: [] };
    if (old) state[editing.source] = state[editing.source].filter((item) => item.id !== old.id);
    state.drafts.push(task);
    save(); render(); $("#task-dialog").close(); showView("drafts");
    toast("已存入草稿箱，之后可继续编辑并提交。");
  }
  async function submitTask(event) {
    event.preventDefault();
    let values;
    try { values = readTaskForm(); } catch (error) { formError(error.message); return; }
    const old = editing ? state[editing.source].find((task) => task.id === editing.id) : null;
    const candidate = { ...values, id: old?.id || id(), deletedOffsets: old?.deletedOffsets || [], events: [] };
    if (categoryFor(candidate).name === "课程") {
      const years = candidate.recurrence.type !== "none"
        ? new Set(Array.from({ length: Number(candidate.endDate.slice(0, 4)) - Number(candidate.date.slice(0, 4)) + 1 }, (_, index) => String(Number(candidate.date.slice(0, 4)) + index)))
        : new Set((candidate.review ? state.settings.offsets : [0]).map((offset) => addDays(candidate.date, offset)).filter((date) => date <= candidate.endDate).map((date) => date.slice(0, 4)));
      const missingYears = [...years].filter((year) => !state.settings.holidays.some((date) => date.startsWith(year)));
      if (missingYears.length) { formError(`课程涉及 ${missingYears.join("、")} 年，但尚未配置这些年份的节假日。请先到设置页填写官方日期。`); return; }
    }
    const generated = candidate.recurrence.type === "none" ? generateEvents(candidate, old?.events || []) : generateRecurringEvents(candidate, old?.events || []);
    candidate.events = generated.events;
    if (!candidate.events.length) { formError("所选日期范围内没有可生成的日程。请检查重复星期、终止日期或课程节假日设置。"); return; }
    const conflicts = findConflicts(candidate, old?.id);
    $("#task-dialog").close();
    let choice = "keep";
    if (conflicts.length) choice = await showConflict(conflicts, candidate);

    // 只有作出冲突选择之后，才一次性提交整条任务。
    if (old) state[editing.source] = state[editing.source].filter((task) => task.id !== old.id);
    if (choice === "draft") {
      candidate.events = []; // 草稿再次提交时重新生成，并使用当时的设置。
      state.drafts.push(candidate);
      save(); render(); showView("drafts");
      toast("任务已移至草稿箱，请修改后重新提交。");
      return;
    }
    state.tasks.push(candidate);
    save();
    selectedDate = candidate.events[0].date;
    displayedMonth = selectedDate.slice(0, 7);
    render(); showView("plan");
    if (generated.skipped.length) await showNotice("已跳过法定节假日", `课程日程已跳过 ${generated.skipped.length} 天：${generated.skipped.slice(0, 20).join("、")}${generated.skipped.length > 20 ? "等" : ""}。复习节点不顺延。`);
    if (candidate.timeMode === "default") toast("已使用系统默认时间；导入苹果日历后可自行修改。");
    const candidateDates = new Set(candidate.events.map((event) => event.date));
    if (overloadedDays().some((date) => candidateDates.has(date))) await showNotice("时长提醒", "今天你的安排总时长已经超过16小时了！休息一下吧！");
  }

  function parseOffsets(text) {
    const parts = text.split(/[,，\s]+/).filter(Boolean);
    const values = parts.map(Number);
    if (!values.length || values[0] !== 0 || values.some((value) => !Number.isInteger(value) || value < 0 || value > 3650) || new Set(values).size !== values.length || values.some((value, index) => index > 0 && value <= values[index - 1])) {
      throw Error("复习节点须从 0 开始，按升序填写不重复的 0–3650 整数。");
    }
    return values;
  }
  function saveSettings() {
    try {
      const offsets = parseOffsets($("#review-offsets").value);
      const defaultTime = $("#default-time").value;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(defaultTime)) throw Error("请选择有效的默认开始时间。");
      state.settings.offsets = offsets;
      state.settings.defaultTime = defaultTime;
      save(); toast("设置已保存，之后生成的日程会使用新设置。");
    } catch (error) { showNotice("设置未保存", error.message); }
  }
  function saveHolidays() {
    const dates = $("#holiday-dates").value.split(/[\s,，]+/).filter(Boolean);
    if (dates.some((date) => !isValidDate(date))) { showNotice("日期格式有误", "请每行填写一个有效的 YYYY-MM-DD 日期。"); return; }
    state.settings.holidays = [...new Set(dates)].filter((date) => !isWeekend(date)).sort();
    $("#holiday-dates").value = state.settings.holidays.join("\n");
    save(); toast("课程节假日日期已保存；周末日期已自动排除。");
  }
  function editCategory(categoryId) {
    const category = state.categories.find((item) => item.id === categoryId);
    if (!category) return;
    const name = prompt("修改分类名称", category.name);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 24 || state.categories.some((item) => item.id !== categoryId && item.name === trimmed)) { showNotice("分类未修改", "名称须为 1–24 个字符，且不能与现有分类重复。"); return; }
    const color = prompt("修改分类颜色（十六进制，例如 #6a8faf）", category.color);
    if (color === null) return;
    if (!/^#[0-9a-fA-F]{6}$/.test(color.trim())) { showNotice("分类未修改", "请输入有效的六位十六进制颜色值。"); return; }
    category.name = trimmed; category.color = color.trim();
    save(); render(); renderSettings(); toast("分类已更新。");
  }
  function deleteCategory(categoryId) {
    const category = state.categories.find((item) => item.id === categoryId);
    if (!category) return;
    if (state.categories.length === 1) { showNotice("无法删除", "请至少保留一个分类。"); return; }
    const used = [...state.tasks, ...state.drafts].some((task) => task.categoryId === categoryId);
    if (!confirm(`删除分类「${category.name}」？${used ? "使用此分类的任务将移至「未分类」。" : ""}`)) return;
    if (used) {
      let fallback = state.categories.find((item) => item.name === "未分类" && item.id !== categoryId);
      if (!fallback) { fallback = { id: id(), name: "未分类", color: "#8795a1" }; state.categories.push(fallback); }
      for (const task of [...state.tasks, ...state.drafts]) if (task.categoryId === categoryId) { task.categoryId = fallback.id; task.categoryName = fallback.name; }
    }
    state.categories = state.categories.filter((item) => item.id !== categoryId);
    save(); render(); renderSettings(); toast("分类已删除。");
  }

  // RFC 5545：文本转义、UTF-8 字节长度折行、CRLF 行尾。
  function icsEscape(value) { return String(value ?? "").replace(/\\/g, "\\\\").replace(/\r\n|\n|\r/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,"); }
  const encoder = new TextEncoder();
  function foldLine(line) {
    const lines = []; let current = ""; let bytes = 0;
    for (const char of line) {
      const size = encoder.encode(char).length;
      if (bytes + size > 75) { lines.push(current); current = " "; bytes = 1; }
      current += char; bytes += size;
    }
    lines.push(current);
    return lines.join("\r\n");
  }
  function icsDate(date, time) { return `${date.replace(/-/g, "")}T${time.replace(":", "")}00`; }
  function timestampUtc() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
  function makeICSLegacy() {
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Qingxu//Study Planner 1.0//ZH", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "BEGIN:VTIMEZONE", "TZID:Asia/Shanghai", "X-LIC-LOCATION:Asia/Shanghai", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0800", "TZOFFSETTO:+0800", "TZNAME:CST", "END:STANDARD", "END:VTIMEZONE"
    ];
    const stamp = timestampUtc();
    for (const { task, event } of allEntries()) {
      const end = eventEnd(event);
      lines.push("BEGIN:VEVENT", `UID:${event.id}@qingxu.local`, `DTSTAMP:${stamp}`,
        `DTSTART;TZID=Asia/Shanghai:${icsDate(event.date, event.time)}`,
        `DTEND;TZID=Asia/Shanghai:${icsDate(end.date, end.time)}`,
        `SUMMARY:${icsEscape(fullTitle(task))}`,
        `CATEGORIES:${icsEscape(categoryFor(task).name)}`,
        `DESCRIPTION:${icsEscape(task.note ? `${task.note}\n\n${typeLabel(event)}` : typeLabel(event))}`);
      if (task.reminder > 0) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(fullTitle(task))}`, `TRIGGER:-PT${task.reminder}M`, "END:VALARM");
      lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    return lines.map(foldLine).join("\r\n") + "\r\n";
  }
  // 复制 ICS 文本仍可离线使用；有手动重复时同样生成标准单事件 RRULE。
  function makeICS() {
    if (!state.tasks.some((task) => task.recurrence?.type && task.recurrence.type !== "none")) return makeICSLegacy();
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Qingxu//Study Planner 3.0//ZH", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "BEGIN:VTIMEZONE", "TZID:Asia/Shanghai", "X-LIC-LOCATION:Asia/Shanghai", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0800", "TZOFFSETTO:+0800", "TZNAME:CST", "END:STANDARD", "END:VTIMEZONE"];
    const stamp = timestampUtc(), weekdayCodes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    for (const task of state.tasks) {
      if (!task.events.length) continue;
      const category = categoryFor(task).name, title = fullTitle(task);
      const repeat = task.recurrence;
      if (repeat?.type && repeat.type !== "none") {
        const included = new Set(task.events.map((event) => event.date));
        const excluded = []; let first = null;
        const span = (dateValue(task.endDate) - dateValue(task.date)) / 86400000;
        for (let offset = 0; offset <= span; offset++) {
          const date = addDays(task.date, offset);
          const match = repeat.type === "daily" ||
            (repeat.type === "weekly" && repeat.weekdays.includes(weekdayCodes[new Date(dateValue(date)).getUTCDay()])) ||
            (repeat.type === "monthly" && date.slice(8) === task.date.slice(8)) ||
            (repeat.type === "yearly" && date.slice(5) === task.date.slice(5));
          if (!match) continue;
          if (!first) first = date;
          if (!included.has(date)) excluded.push(date);
        }
        if (!first) continue;
        const time = task.events[0].time;
        const end = eventEnd({ date: first, time, duration: task.duration });
        const [y, m, d] = task.endDate.split("-").map(Number);
        const until = new Date(Date.UTC(y, m - 1, d, 15, 59, 59)).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
        let rule = `FREQ=${repeat.type.toUpperCase()}`;
        if (repeat.type === "weekly") rule += `;BYDAY=${repeat.weekdays.join(",")}`;
        if (repeat.type === "monthly") rule += `;BYMONTHDAY=${Number(task.date.slice(8))}`;
        if (repeat.type === "yearly") rule += `;BYMONTH=${Number(task.date.slice(5, 7))};BYMONTHDAY=${Number(task.date.slice(8))}`;
        rule += `;UNTIL=${until}`;
        lines.push("BEGIN:VEVENT", `UID:${task.id}@qingxu.local`, `DTSTAMP:${stamp}`, `DTSTART;TZID=Asia/Shanghai:${icsDate(first, time)}`, `DTEND;TZID=Asia/Shanghai:${icsDate(end.date, end.time)}`, `SUMMARY:${icsEscape(title)}`, `CATEGORIES:${icsEscape(category)}`, `RRULE:${rule}`);
        if (excluded.length) lines.push(`EXDATE;TZID=Asia/Shanghai:${excluded.map((date) => icsDate(date, time)).join(",")}`);
        lines.push(`DESCRIPTION:${icsEscape(task.note)}`);
        if (task.reminder > 0) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(title)}`, `TRIGGER:-PT${task.reminder}M`, "END:VALARM");
        lines.push("END:VEVENT");
      } else {
        for (const event of task.events) {
          const end = eventEnd(event);
          lines.push("BEGIN:VEVENT", `UID:${event.id}@qingxu.local`, `DTSTAMP:${stamp}`, `DTSTART;TZID=Asia/Shanghai:${icsDate(event.date, event.time)}`, `DTEND;TZID=Asia/Shanghai:${icsDate(end.date, end.time)}`, `SUMMARY:${icsEscape(title)}`, `CATEGORIES:${icsEscape(category)}`, `DESCRIPTION:${icsEscape(task.note ? `${task.note}\n\n${typeLabel(event)}` : typeLabel(event))}`);
          if (task.reminder > 0) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(title)}`, `TRIGGER:-PT${task.reminder}M`, "END:VALARM");
          lines.push("END:VEVENT");
        }
      }
    }
    lines.push("END:VCALENDAR");
    return lines.map(foldLine).join("\r\n") + "\r\n";
  }
  function csvCell(value) { const text = String(value ?? ""); return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
  function makeCSV() {
    const rows = [["日期", "开始时间", "结束时间", "分类", "任务名称", "任务类型", "备注"]];
    for (const { task, event } of allEntries()) rows.push([event.date, event.time, eventEnd(event).time, categoryFor(task).name, task.name, typeLabel(event), task.note]);
    return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }
  function download(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function copyICS() {
    const content = makeICS();
    try { await navigator.clipboard.writeText(content); toast("完整 ICS 文本已复制。"); }
    catch {
      const field = document.createElement("textarea");
      field.value = content; field.style.position = "fixed"; field.style.opacity = "0";
      document.body.appendChild(field); field.select();
      const copied = document.execCommand("copy"); field.remove();
      if (copied) toast("完整 ICS 文本已复制。");
      else showNotice("复制失败", "浏览器阻止了剪贴板访问，请使用下载 .ics 文件按钮。");
    }
  }

  // 事件委托用于每次重绘后新创建的日历格、任务卡片与分类按钮。
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.matches(".nav-button")) showView(button.dataset.view);
    if (button.matches(".calendar-day")) { selectedDate = button.dataset.date; displayedMonth = selectedDate.slice(0, 7); render(); }
    if (button.matches(".edit-task")) openTask("tasks", button.dataset.id);
    if (button.matches(".edit-draft")) openTask("drafts", button.dataset.id);
    if (button.matches(".delete-event")) {
      const task = state.tasks.find((item) => item.events.some((entry) => entry.id === button.dataset.id));
      if (!task) return;
      const occurrence = task.events.find((entry) => entry.id === button.dataset.id);
      const last = task.events.length === 1;
      if (!confirm(`仅删除「${task.name}」在 ${occurrence.date} 的这一次日程？${last ? "这是最后一条日程，任务记录也会删除。" : `其余 ${task.events.length - 1} 条日程会保留。`}`)) return;
      task.events = task.events.filter((entry) => entry.id !== occurrence.id);
      task.deletedOffsets = [...new Set([...(task.deletedOffsets || []), occurrence.offset])];
      if (!task.events.length) state.tasks = state.tasks.filter((entry) => entry.id !== task.id);
      save(); render(); toast("本次日程已删除。");
    }
    if (button.matches(".delete-task")) {
      const task = state.tasks.find((item) => item.id === button.dataset.id);
      if (task && confirm(`批量删除「${task.name}」整套共 ${task.events.length} 条关联日程？此操作无法撤销。`)) { state.tasks = state.tasks.filter((item) => item.id !== task.id); save(); render(); toast("整套日程已删除。"); }
    }
    if (button.matches(".delete-draft")) {
      const task = state.drafts.find((item) => item.id === button.dataset.id);
      if (task && confirm(`删除草稿「${task.name}」？`)) { state.drafts = state.drafts.filter((item) => item.id !== task.id); save(); render(); toast("草稿已删除。"); }
    }
    if (button.matches(".edit-category")) editCategory(button.dataset.id);
    if (button.matches(".delete-category")) deleteCategory(button.dataset.id);
  });
  document.addEventListener("change", (event) => {
    if (event.target.matches(".complete-check")) {
      const task = state.tasks.find((item) => item.id === event.target.dataset.taskId);
      const occurrence = task?.events.find((item) => item.id === event.target.dataset.eventId);
      if (occurrence) { occurrence.completed = event.target.checked; save(); render(); }
    }
    if (event.target.matches("input[name='time-mode']")) updateTimeVisibility();
  });
  $("#new-task-button").addEventListener("click", () => openTask());
  $("#task-form").addEventListener("submit", submitTask);
  $("#save-draft").addEventListener("click", saveManualDraft);
  $("#task-repeat").addEventListener("change", updateRepeatVisibility);
  $("#task-review").addEventListener("change", () => {
    if ($("#task-review").checked && $("#task-repeat").value !== "none") { $("#task-repeat").value = "none"; updateRepeatVisibility(); }
  });
  $("#task-date").addEventListener("change", () => {
    const start = $("#task-date").value;
    const end = $("#task-end-date").value;
    if (isValidDate(start) && (!isValidDate(end) || end < start)) $("#task-end-date").value = addDays(start, $("#task-review").checked ? Math.max(...state.settings.offsets) : 0);
  });
  $("#close-task").addEventListener("click", () => $("#task-dialog").close());
  $("#cancel-task").addEventListener("click", () => $("#task-dialog").close());
  $("#prev-month").addEventListener("click", () => { const [y, m] = displayedMonth.split("-").map(Number); displayedMonth = addDays(`${y}-${pad(m)}-01`, -1).slice(0, 7); render(); });
  $("#next-month").addEventListener("click", () => { const [y, m] = displayedMonth.split("-").map(Number); displayedMonth = addDays(`${y}-${pad(m)}-28`, 5).slice(0, 7); render(); });
  $("#save-settings").addEventListener("click", saveSettings);
  $("#save-holidays").addEventListener("click", saveHolidays);
  $("#category-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("#category-name").value.trim();
    if (!name || name.length > 24 || state.categories.some((item) => item.name === name)) { showNotice("无法添加分类", "名称须为 1–24 个字符，且不能与现有分类重复。"); return; }
    state.categories.push({ id: id(), name, color: $("#category-color").value });
    save(); renderSettings(); $("#category-name").value = ""; toast("分类已添加。");
  });
  $("#download-ics").addEventListener("click", async () => {
    if (!window.QingxuAuth.isAuthenticated()) return;
    const button = $("#download-ics"); button.disabled = true;
    try {
      const result = await window.QingxuAuth.exportICS();
      if (result.empty) { toast("没有新增日程，本次无需下载 ICS。"); return; }
      download(result.text, `清序新增日程-${todayShanghai()}.ics`, "text/calendar;charset=utf-8");
      toast("新增日程 ICS 已开始下载，导出记录已更新。");
    } catch (error) { showNotice("导出失败", error.message); }
    finally { button.disabled = false; }
  });
  $("#reset-ics-history").addEventListener("click", async () => {
    if (!window.QingxuAuth.isAuthenticated()) return;
    if (!confirm("清空当前账户的 ICS 导出记录？下次将重新导出全部任务日程。")) return;
    try { await window.QingxuAuth.clearExportHistory(); toast("导出记录已清空，下次将导出全部日程。"); }
    catch (error) { showNotice("清空失败", error.message); }
  });
  $("#download-csv").addEventListener("click", () => { if (!window.QingxuAuth.isAuthenticated()) return; download(makeCSV(), `清序日程-${todayShanghai()}.csv`, "text/csv;charset=utf-8"); toast("CSV 文件已开始下载。"); });
  $("#copy-ics").addEventListener("click", () => { if (window.QingxuAuth.isAuthenticated()) copyICS(); });
  $("#flower-button").addEventListener("click", () => {
    const button = $("#flower-button"), layer = $("#petal-layer");
    button.disabled = true;
    layer.replaceChildren();
    const petals = document.createDocumentFragment();
    for (let index = 0; index < 20; index++) {
      const petal = document.createElement("span");
      petal.className = "petal";
      petal.textContent = "✿";
      petal.style.setProperty("--x", `${Math.random() * 100}%`);
      petal.style.setProperty("--size", `${12 + Math.random() * 13}px`);
      petal.style.setProperty("--drift", `${(Math.random() - .5) * 130}px`);
      petal.style.setProperty("--spin", `${(Math.random() - .5) * 600}deg`);
      petal.style.setProperty("--delay", `${Math.random() * .45}s`);
      petal.style.setProperty("--duration", `${2.5 + Math.random() * .45}s`);
      petals.appendChild(petal);
    }
    layer.appendChild(petals);
    setTimeout(() => { layer.replaceChildren(); button.disabled = false; }, 3000);
  });
  window.QingxuAuth.boot({
    initialState,
    legacyLoader: loadState,
    onState(data) { state = data; selectedDate = todayShanghai(); displayedMonth = selectedDate.slice(0, 7); render(); if (window.QingxuAuth.isAuthenticated()) showView("plan"); },
    onOffline(message) { toast(message || "当前离线，改动已保存在此设备，重新联网后会自动同步。"); }
  });
})();
