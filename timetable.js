// 前后端共用作息表默认值与校验，避免同步和 AI 请求采用不同规则。
"use strict";

((root) => {
  const times = ["08:00-08:45", "08:50-09:35", "09:50-10:35", "10:40-11:25", "11:30-12:15", "14:00-14:45", "14:50-15:35", "15:50-16:35", "16:40-17:25", "17:30-18:15", "19:00-19:45", "19:50-20:35"];
  const DEFAULT_TIMETABLE = Object.freeze({
    periodsPerDay: 12, defaultDuration: 45, breakMinutes: 5,
    periods: Object.freeze(times.map((time, index) => {
      const [start, end] = time.split("-");
      return Object.freeze({ section: index + 1, start, end });
    }))
  });
  function defaultTimetable() { return JSON.parse(JSON.stringify(DEFAULT_TIMETABLE)); }
  function validateTimetable(value) {
    const integer = (number, min, max) => Number.isInteger(number) && number >= min && number <= max;
    const time = (text) => typeof text === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(text);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !integer(value.periodsPerDay, 1, 20) || !integer(value.defaultDuration, 5, 180) || !integer(value.breakMinutes, 0, 60) ||
        !Array.isArray(value.periods) || value.periods.length !== value.periodsPerDay || value.periods.length > 20 ||
        value.periods.some((period, index) => !period || period.section !== index + 1 || !time(period.start) || !time(period.end) || period.start >= period.end)) {
      throw Object.assign(Error("作息表数据无效。请核对课时数（1–20）、时长（5–180 分钟）、课间（0–60 分钟），每节开始时间须早于结束时间。"), { code: "INVALID_TIMETABLE" });
    }
    return value;
  }
  function normalizeTimetable(value) {
    try { return JSON.parse(JSON.stringify(validateTimetable(value))); }
    catch { return defaultTimetable(); }
  }
  const api = { DEFAULT_TIMETABLE, defaultTimetable, validateTimetable, normalizeTimetable };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.QingxuTimetable = api;
})(globalThis);
