// 课程节假日与年份覆盖规则前后端共用；内置年份（2025–2027）不再要求用户补充。
"use strict";

((root) => {
  // 国务院办公厅 2025、2026 年放假通知中的日期，2027 年为元旦 1 月 1 日至 3 日。
  // 下面只记录日期范围，展开时排除周六、周日，与原有「周末不跳过」规则一致。
  // 2025：https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm
  // 2026：https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
  const HOLIDAY_RANGES = Object.freeze([
    ["2025-01-01", "2025-01-01"], ["2025-01-28", "2025-02-04"],
    ["2025-04-04", "2025-04-06"], ["2025-05-01", "2025-05-05"],
    ["2025-05-31", "2025-06-02"], ["2025-10-01", "2025-10-08"],
    ["2026-01-01", "2026-01-03"], ["2026-02-15", "2026-02-23"],
    ["2026-04-04", "2026-04-06"], ["2026-05-01", "2026-05-05"],
    ["2026-06-19", "2026-06-21"], ["2026-09-25", "2026-09-27"],
    ["2026-10-01", "2026-10-07"],
    ["2027-01-01", "2027-01-03"]
  ]);
  // 已内置放假安排的年份。这些年份不再提示「尚未配置节假日」，任务可以照常导入。
  const COVERED_YEARS = Object.freeze([...new Set(HOLIDAY_RANGES.map(([start]) => start.slice(0, 4)))]);
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  function dateValue(iso) {
    const [year, month, day] = iso.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  }
  function dateFromValue(value) { return new Date(value).toISOString().slice(0, 10); }
  function addDays(iso, days) { return dateFromValue(dateValue(iso) + days * 86400000); }
  function isWeekend(iso) { return [0, 6].includes(new Date(dateValue(iso)).getUTCDay()); }
  function isCoveredYear(year) { return COVERED_YEARS.includes(String(year)); }

  function defaultHolidays() {
    const result = [];
    for (const [start, end] of HOLIDAY_RANGES) {
      for (let day = start; day <= end; day = addDays(day, 1)) if (!isWeekend(day)) result.push(day);
    }
    return [...new Set(result)].sort();
  }

  // 需要提示「尚未配置节假日」的年份：内置年份始终视为已配置，其他年份只有一条日期都没有时才提示。
  function missingHolidayYears(years, holidays) {
    const configured = (Array.isArray(holidays) ? holidays : []).filter((date) => typeof date === "string" && ISO_DATE.test(date));
    return [...new Set([...years].map(String))]
      .filter((year) => !isCoveredYear(year) && !configured.some((date) => date.startsWith(year)))
      .sort();
  }

  // 老账户的设置里可能还没有新内置年份：整年缺失时补上内置日期，该年已有任何日期时保持用户内容不变。
  function mergeBuiltinHolidays(holidays) {
    const list = (Array.isArray(holidays) ? holidays : []).filter((date) => typeof date === "string" && ISO_DATE.test(date));
    const years = new Set(list.map((date) => date.slice(0, 4)));
    const added = defaultHolidays().filter((date) => !years.has(date.slice(0, 4)));
    return [...new Set([...list, ...added])].sort();
  }

  const api = { HOLIDAY_RANGES, COVERED_YEARS, isCoveredYear, defaultHolidays, missingHolidayYears, mergeBuiltinHolidays };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.QingxuHolidays = api;
})(globalThis);
