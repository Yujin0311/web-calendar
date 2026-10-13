"use strict";

// 图片选择、AI 请求和待确认卡片单独维护；这里不调用任何日程写入接口。
window.QingxuAI = (() => {
  const $ = (selector) => document.querySelector(selector);
  const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
  const MAX_FILE_BYTES = 6 * 1024 * 1024;
  let selectedFile = null, previewUrl = null, selectionToken = 0, requestToken = 0, busy = false, draft = null, activeController = null;
  const WEEKDAYS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];

  function clearError() { $("#ocr-error").textContent = ""; $("#ocr-error").hidden = true; }
  function showError(message) {
    $("#ocr-error").textContent = message;
    $("#ocr-error").hidden = false;
    $("#ocr-status").textContent = "解析未完成";
  }
  function setBusy(value) {
    busy = value;
    $("#ocr-start").disabled = value;
    $("#ocr-file").disabled = value;
    $("#ocr-camera").disabled = value;
    $("#ai-draft-confirm").disabled = value;
  }
  function clearDraft() {
    draft = null;
    $("#ai-schedule-draft").hidden = true;
  }
  function reset() {
    selectionToken++;
    requestToken++;
    if (activeController) activeController.abort();
    activeController = null;
    setBusy(false);
    selectedFile = null;
    clearDraft();
    clearError();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    $("#ocr-preview").hidden = true;
    $("#ocr-preview").removeAttribute("src");
    $("#ocr-file").value = "";
    $("#ocr-camera").value = "";
    $("#ocr-file-name").textContent = "尚未选择图片";
    $("#ocr-status").textContent = "等待选择图片";
  }

  function chooseImage(file) {
    if (busy || !file) return;
    const token = ++selectionToken;
    selectedFile = null;
    clearDraft();
    clearError();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    const preview = $("#ocr-preview");
    preview.hidden = true;
    preview.removeAttribute("src");
    if (!ALLOWED_TYPES.has(file.type)) { showError("仅支持 JPG、PNG、GIF 或 WebP 图片；手机 HEIC 照片请先转换为 JPG。"); return; }
    if (!file.size || file.size > MAX_FILE_BYTES) { showError("请选择小于 6 MB 的有效图片。"); return; }
    $("#ocr-file-name").textContent = file.name || "手机拍摄的图片";
    $("#ocr-status").textContent = "正在读取图片…";
    let url;
    try { url = URL.createObjectURL(file); }
    catch { showError("图片加载失败，请更换图片重试。"); return; }
    const image = new Image();
    image.onload = () => {
      if (token !== selectionToken) { URL.revokeObjectURL(url); return; }
      if (!image.naturalWidth || !image.naturalHeight) { URL.revokeObjectURL(url); showError("图片加载失败，请更换图片重试。"); return; }
      previewUrl = url;
      preview.src = url;
      preview.hidden = false;
      selectedFile = file;
      $("#ocr-status").textContent = "图片已就绪，点击 AI 解析日程";
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      if (token === selectionToken) showError("图片加载失败，文件可能损坏或浏览器不支持该格式。");
    };
    image.src = url;
  }

  function readDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(Error("图片读取失败，请重试。"));
      reader.onerror = () => reject(Error("图片读取失败，请更换图片重试。"));
      reader.readAsDataURL(file);
    });
  }

  // 课程草稿在浏览器内核对，只有勾选并确认后才交给原有状态保存流程。
  function field(label, value, className, type = "text") {
    const wrapper = document.createElement("label");
    wrapper.className = "field";
    const caption = document.createElement("span");
    caption.textContent = label;
    const input = document.createElement("input");
    input.className = className;
    input.type = type;
    input.value = value === "" ? "" : String(value);
    if (type === "number") { input.min = "1"; input.max = "50"; input.step = "1"; }
    wrapper.append(caption, input);
    return wrapper;
  }
  function courseFromRow(row) {
    const value = (selector) => row.querySelector(selector).value.trim();
    return {
      courseName: value(".ai-course-name"), weekday: value(".ai-course-weekday"),
      sectionStart: value(".ai-course-start") ? Number(value(".ai-course-start")) : "",
      sectionEnd: value(".ai-course-end") ? Number(value(".ai-course-end")) : "",
      teacher: value(".ai-course-teacher"), location: value(".ai-course-location"), weekRange: value(".ai-course-weeks")
    };
  }
  function renderSectionTimes() {
    const container = $("#ai-section-times");
    const previous = new Map([...container.querySelectorAll(".ai-section-row")].map((row) =>
      [Number(row.dataset.section), { start: row.querySelector(".ai-time-start").value, end: row.querySelector(".ai-time-end").value }]));
    const starts = new Set(), ends = new Set();
    document.querySelectorAll(".ai-course-row").forEach((row) => {
      if (!row.querySelector(".ai-course-check").checked) return;
      const course = courseFromRow(row);
      if (Number.isInteger(course.sectionStart) && course.sectionStart > 0 && course.sectionStart <= 50) starts.add(course.sectionStart);
      if (Number.isInteger(course.sectionEnd) && course.sectionEnd > 0 && course.sectionEnd <= 50) ends.add(course.sectionEnd);
    });
    container.replaceChildren();
    const sections = [...new Set([...starts, ...ends])].sort((a, b) => a - b);
    if (!sections.length) { container.textContent = "请选择课程并核对节次。"; return; }
    sections.forEach((section) => {
      const row = document.createElement("div");
      row.className = "ai-section-row";
      row.dataset.section = String(section);
      const title = document.createElement("strong");
      title.textContent = `第 ${section} 节`;
      row.append(title);
      if (starts.has(section)) row.append(field("开始时间", previous.get(section)?.start || "", "ai-time-start", "time"));
      else { const hidden = document.createElement("input"); hidden.type = "hidden"; hidden.className = "ai-time-start"; row.append(hidden); }
      if (ends.has(section)) row.append(field("结束时间", previous.get(section)?.end || "", "ai-time-end", "time"));
      else { const hidden = document.createElement("input"); hidden.type = "hidden"; hidden.className = "ai-time-end"; row.append(hidden); }
      container.append(row);
    });
  }
  function renderDraft(schedule) {
    draft = schedule;
    const list = $("#ai-course-list");
    list.replaceChildren();
    schedule.courses.forEach((course, index) => {
      const row = document.createElement("div");
      row.className = "ai-course-row";
      const heading = document.createElement("label");
      heading.className = "ai-course-heading";
      const check = document.createElement("input");
      check.type = "checkbox"; check.checked = true; check.className = "ai-course-check";
      const number = document.createElement("strong");
      number.textContent = `课程 ${index + 1}`;
      heading.append(check, number);
      const grid = document.createElement("div");
      grid.className = "ai-course-fields";
      grid.append(field("课程名称", course.courseName, "ai-course-name"));
      const weekdayLabel = document.createElement("label");
      weekdayLabel.className = "field";
      const caption = document.createElement("span"); caption.textContent = "星期";
      const weekday = document.createElement("select"); weekday.className = "ai-course-weekday";
      for (const value of ["", ...WEEKDAYS]) {
        const option = document.createElement("option"); option.value = value; option.textContent = value || "请选择"; weekday.append(option);
      }
      weekday.value = course.weekday;
      weekdayLabel.append(caption, weekday);
      grid.append(weekdayLabel, field("开始节次", course.sectionStart, "ai-course-start", "number"), field("结束节次", course.sectionEnd, "ai-course-end", "number"), field("上课周次", course.weekRange, "ai-course-weeks"), field("老师", course.teacher, "ai-course-teacher"), field("教室", course.location, "ai-course-location"));
      row.append(heading, grid);
      list.append(row);
    });
    $("#ai-select-all").checked = true;
    $("#ai-term-monday").value = "";
    $("#ai-section-times").replaceChildren();
    renderSectionTimes();
    $("#ai-schedule-draft").hidden = false;
  }

  function init({ onConfirm }) {
    $("#ocr-file").addEventListener("change", (event) => chooseImage(event.target.files?.[0]));
    $("#ocr-camera").addEventListener("change", (event) => chooseImage(event.target.files?.[0]));
    $("#ocr-start").addEventListener("click", async () => {
      if (busy) return;
      clearError();
      if (!selectedFile) { showError("请先选择图片或使用手机拍照。"); return; }
      if (!window.QingxuAuth.isAuthenticated()) { showError("请先登录，再使用 AI 图片解析。"); return; }
      clearDraft();
      setBusy(true);
      $("#ocr-status").textContent = "正在AI解析日程...";
      const currentRequest = ++requestToken;
      const controller = new AbortController();
      activeController = controller;
      const timer = setTimeout(() => controller.abort(), 35_000);
      try {
        const image = await readDataUrl(selectedFile);
        if (currentRequest !== requestToken) return;
        const schedule = await window.QingxuAuth.parseScheduleFromImage(image, controller.signal);
        if (currentRequest !== requestToken) return;
        if (!schedule || schedule.isValid === false) { showError("图片中没有识别到学习日程，请换一张清晰的照片。"); return; }
        if (schedule.isValid !== true) throw Error("AI 返回的日程格式不正确，请重试。");
        renderDraft(schedule);
        $("#ocr-status").textContent = `解析完成，识别到 ${schedule.courses.length} 门课程，请核对草稿`;
      } catch (error) {
        if (currentRequest !== requestToken) return;
        if (error.name === "AbortError") showError("AI 解析超时，请检查网络后重试。");
        else if (error instanceof TypeError || error.message === "Failed to fetch") showError("网络连接失败，请检查服务器和网络后重试。");
        else showError(error.message || "AI 解析失败，请更换图片后重试。");
      } finally {
        clearTimeout(timer);
        if (activeController === controller) activeController = null;
        if (currentRequest === requestToken) setBusy(false);
      }
    });
    $("#ai-course-list").addEventListener("change", (event) => {
      if (event.target.matches(".ai-course-check")) $("#ai-select-all").checked = [...document.querySelectorAll(".ai-course-check")].every((check) => check.checked);
      if (event.target.matches(".ai-course-start, .ai-course-end, .ai-course-check")) renderSectionTimes();
    });
    $("#ai-select-all").addEventListener("change", (event) => {
      document.querySelectorAll(".ai-course-check").forEach((check) => { check.checked = event.target.checked; });
      renderSectionTimes();
    });
    $("#ai-draft-confirm").addEventListener("click", async () => {
      if (!draft || busy) return;
      clearError();
      const courses = [...document.querySelectorAll(".ai-course-row")].filter((row) => row.querySelector(".ai-course-check").checked).map(courseFromRow);
      const sectionTimes = Object.fromEntries([...document.querySelectorAll(".ai-section-row")].map((row) => [row.dataset.section, {
        start: row.querySelector(".ai-time-start").value, end: row.querySelector(".ai-time-end").value
      }]));
      setBusy(true);
      try { await onConfirm({ courses, termMonday: $("#ai-term-monday").value, sectionTimes }); }
      catch (error) { showError(error.message || "日程生成失败，请检查填写内容后重试。"); }
      finally { setBusy(false); }
    });
  }

  return { init, reset, consume: reset };
})();
