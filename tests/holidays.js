// 内置节假日与年份覆盖规则：2025–2027 年内置，2027 年不再提示「尚未配置」。
"use strict";

const assert = require("node:assert/strict");
const { HOLIDAY_RANGES, COVERED_YEARS, isCoveredYear, defaultHolidays, missingHolidayYears, mergeBuiltinHolidays } = require("../holidays");

const builtin = defaultHolidays();
assert(builtin.includes("2027-01-01"), "2027 年元旦应内置为节假日");
assert(!builtin.includes("2027-01-02") && !builtin.includes("2027-01-03"), "周六、周日不能进入跳过列表");
assert(builtin.every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)), "内置日期格式必须是 YYYY-MM-DD");
assert.deepEqual([...builtin], [...builtin].sort(), "内置日期须按升序排列");
assert.deepEqual([...COVERED_YEARS], ["2025", "2026", "2027"]);
assert(HOLIDAY_RANGES.some(([start, end]) => start === "2027-01-01" && end === "2027-01-03"), "2027 年元旦范围为 1 月 1 日至 3 日");
assert.equal(isCoveredYear("2027"), true);
assert.equal(isCoveredYear(2028), false);

// 内置年份无论用户设置里有没有对应日期，都不再提示「尚未配置节假日」。
assert.deepEqual(missingHolidayYears(["2027"], []), []);
assert.deepEqual(missingHolidayYears(new Set(["2027"]), ["2026-10-01"]), []);
assert.deepEqual(missingHolidayYears(["2025", "2026", "2027"], []), []);
// 内置年份与未内置年份混在一起时，只提示未内置的年份。
assert.deepEqual(missingHolidayYears(["2026", "2027", "2028"], []), ["2028"]);
assert.deepEqual(missingHolidayYears(["2028", "2029"], ["2028-01-01"]), ["2029"]);
// 未内置年份只要用户填过有效日期就视为已配置，无效日期不算。
assert.deepEqual(missingHolidayYears(["2028"], ["2028-01-01"]), []);
assert.deepEqual(missingHolidayYears(["2028"], ["2028-1-1"]), ["2028"]);

// 老账户整年缺失时补齐内置日期；该年已有日期时保留用户内容，不重复、不丢日期。
assert.deepEqual(mergeBuiltinHolidays([]), builtin);
assert.deepEqual(mergeBuiltinHolidays(undefined), builtin);
const withCustom2027 = mergeBuiltinHolidays(["2027-05-01"]);
assert(withCustom2027.includes("2027-05-01"));
assert(!withCustom2027.some((date) => date.startsWith("2027-01")), "该年已有日期时不再补 2027 年元旦");
assert(withCustom2027.includes("2026-10-01"), "缺失的 2026 年应补上内置日期");
assert.equal(new Set(withCustom2027).size, withCustom2027.length, "补齐后不能出现重复日期");
assert.deepEqual(mergeBuiltinHolidays(builtin), builtin, "补齐必须幂等");

console.log("通过：2027 年元旦内置、内置年份不再提示补充、未内置年份仍提示、老账户整年补齐与幂等");
