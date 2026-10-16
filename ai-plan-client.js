"use strict";

// AI 规划面板只在内存中保留待确认结果；放弃或退出登录立即清空。
window.QingxuPlan = (() => {
  const $ = (selector) => document.querySelector(selector);
  let result = null, busy = false, requestVersion = 0;
  let resultPrecise = false, resultGoal = "";
  const densities = ["light", "medium", "busy"];
  const densityLabels = ["轻松 · 每周 1–2 个子任务", "中度 · 每 2 天 1 个子任务", "忙碌 · 每天 1 个子任务"];
  function updateDensity() { $("#ai-plan-density-value").textContent = densityLabels[Number($("#ai-plan-density").value)]; }

  function error(message) { $("#ai-plan-error").textContent = message; $("#ai-plan-error").hidden = !message; }
  function setBusy(value) {
    busy = value;
    for (const id of ["ai-plan-generate", "ai-plan-import-selected", "ai-plan-import-all"]) $("#" + id).disabled = value;
    for (const control of [...document.querySelectorAll('input[name="ai-plan-precise"]'), $("#ai-plan-preferred-window"), $("#ai-plan-density")]) control.disabled = value;
  }
  function reset() {
    requestVersion++;
    result = null;
    resultPrecise = false;
    resultGoal = "";
    $("#ai-plan-result").hidden = true;
    $("#ai-plan-stages").replaceChildren();
    $("#ai-plan-form").reset();
    updateDensity();
    $("#ai-plan-status").textContent = "";
    error(""); setBusy(false);
  }
  function field(label, type, value, className) {
    const wrapper = document.createElement("label"); wrapper.className = "field";
    const caption = document.createElement("span"); caption.textContent = label;
    const input = document.createElement("input"); input.type = type; input.value = String(value); input.className = className;
    if (type === "number") { input.min = "1"; input.max = "1440"; input.step = "1"; }
    wrapper.append(caption, input);
    return wrapper;
  }
  function render(plan) {
    result = plan;
    const precise = $("input[name='ai-plan-precise']:checked")?.value === "yes";
    resultPrecise = precise;
    $("#ai-plan-review-whole").checked = false; // 整条计划的复习开关只由用户决定。
    $("#ai-plan-result-title").textContent = plan.planTitle;
    const container = $("#ai-plan-stages"); container.replaceChildren();
    plan.stages.forEach((stage) => {
      const section = document.createElement("section"); section.className = "ai-plan-stage";
      const heading = document.createElement("h4"); heading.textContent = stage.stageName;
      const range = document.createElement("p"); range.className = "muted"; range.textContent = stage.timeRange;
      section.append(heading, range);
      stage.tasks.forEach((task) => {
        const row = document.createElement("div"); row.className = "ai-plan-task";
        const selected = document.createElement("label"); selected.className = "ai-plan-task-title";
        const select = document.createElement("input"); select.type = "checkbox"; select.checked = true; select.className = "ai-plan-select";
        const name = document.createElement("strong"); name.textContent = task.taskName;
        selected.append(select, name);
        const controls = document.createElement("div"); controls.className = "ai-plan-task-controls";
        controls.append(field("执行日期", "date", task.date, "ai-plan-task-date"));
        if (precise) controls.append(field("开始时间", "time", task.startTime, "ai-plan-task-time"), field("时长（分钟）", "number", task.duration, "ai-plan-task-duration"));
        const hint = document.createElement("span"); hint.className = "muted"; hint.textContent = task.needReview ? "AI 建议复习" : "普通任务";
        controls.append(hint);
        row.append(selected, controls); section.append(row);
      });
      container.append(section);
    });
    $("#ai-plan-result").hidden = false;
  }
  function selectedTasks(all) {
    const rows = [...document.querySelectorAll(".ai-plan-task")];
    const tasks = result.stages.flatMap((stage) => stage.tasks.map((task) => ({ ...task, stageName: stage.stageName, timeRange: stage.timeRange })));
    return rows.flatMap((row, index) => {
      if (!all && !row.querySelector(".ai-plan-select").checked) return [];
      return [{ ...tasks[index], date: row.querySelector(".ai-plan-task-date").value,
        startTime: row.querySelector(".ai-plan-task-time")?.value || "",
        duration: Number(row.querySelector(".ai-plan-task-duration")?.value ?? tasks[index].duration) }];
    });
  }
  function init({ getCurrentTasks, onImport }) {
    $("#ai-plan-form").addEventListener("submit", async (event) => {
      event.preventDefault(); if (busy) return;
      error("");
      const input = { goal: $("#ai-plan-goal").value.trim(), startDate: $("#ai-plan-start").value,
        endDate: $("#ai-plan-end").value, background: $("#ai-plan-background").value.trim(),
        preciseTime: $("input[name='ai-plan-precise']:checked")?.value === "yes", preferredWindow: $("#ai-plan-preferred-window").value.trim(),
        density: densities[Number($("#ai-plan-density").value)] };
      if (!input.goal || !input.startDate || !input.endDate || input.endDate < input.startDate) { error("请填写学习目标和有效的起止日期。"); return; }
      input.currentTasks = getCurrentTasks(input);
      result = null; $("#ai-plan-result").hidden = true; setBusy(true);
      $("#ai-plan-status").textContent = "正在生成学习规划...";
      const version = ++requestVersion;
      try {
        const plan = await window.QingxuAuth.requestAiPlan(input);
        if (version !== requestVersion) return;
        resultGoal = input.goal;
        render(plan); $("#ai-plan-status").textContent = "规划已生成，请核对后导入。";
      } catch (cause) { if (version === requestVersion) { error(cause.message || "AI 规划失败，请重试。"); $("#ai-plan-status").textContent = ""; } }
      finally { if (version === requestVersion) setBusy(false); }
    });
    for (const [id, all] of [["ai-plan-import-selected", false], ["ai-plan-import-all", true]]) {
      $("#" + id).addEventListener("click", async () => {
        if (!result || busy) return;
        error("");
        const tasks = selectedTasks(all);
        if (!tasks.length) { error("请至少勾选一项任务。"); return; }
        setBusy(true);
        try { await onImport({ tasks, startDate: $("#ai-plan-start").value, endDate: $("#ai-plan-end").value, goal: resultGoal,
          preciseTime: resultPrecise, reviewWholePlan: $("#ai-plan-review-whole").checked }); reset(); }
        catch (cause) { error(cause.message || "导入失败，请核对任务日期和时长。"); setBusy(false); }
      });
    }
    $("#ai-plan-discard").addEventListener("click", reset);
    $("#ai-plan-density").addEventListener("input", updateDensity);
    // 时间偏好或密度变化后，旧规划须重新生成。
    for (const control of [...document.querySelectorAll('input[name="ai-plan-precise"]'), $("#ai-plan-preferred-window"), $("#ai-plan-density")]) {
      control.addEventListener("change", () => { updateDensity(); if (result) { result = null; $("#ai-plan-result").hidden = true; $("#ai-plan-stages").replaceChildren(); $("#ai-plan-status").textContent = control.id === "ai-plan-density" ? "任务密度已更改，请重新生成规划。" : "时间偏好已更改，请重新生成规划。"; } });
    }
  }
  return { init, reset };
})();
