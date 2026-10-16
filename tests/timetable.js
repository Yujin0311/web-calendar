"use strict";

const assert = require("node:assert/strict");
const { DEFAULT_TIMETABLE, defaultTimetable, validateTimetable, normalizeTimetable } = require("../timetable");
const original = defaultTimetable();
assert.equal(original.periods.length, 12);
assert.equal(original.periods[5].start, "14:00");
assert.equal(original.periods[11].end, "20:35");
const changed = defaultTimetable();
changed.periods[0].start = "07:30";
assert.equal(DEFAULT_TIMETABLE.periods[0].start, "08:00");
assert.equal(defaultTimetable().periods[0].start, "08:00");
assert.deepEqual(normalizeTimetable(undefined), original);
assert.deepEqual(normalizeTimetable({}), original);
assert.deepEqual(validateTimetable(changed), changed);
for (const update of [
  { periodsPerDay: 0 }, { periodsPerDay: 21 }, { periodsPerDay: "12" }, { periodsPerDay: 1.5 },
  { defaultDuration: 4 }, { defaultDuration: 181 }, { breakMinutes: -1 }, { breakMinutes: 61 },
  { periods: [] }, { periods: [...original.periods, original.periods[0]] },
  ...[{ section: 2 }, { section: "1" }, { start: "8:00" }, { start: "24:00" }, { start: "08:60" }, { start: "08:45" }, { end: "07:00" }, { start: null }].map((period) => ({ periods: [{ ...original.periods[0], ...period }, ...original.periods.slice(1)] }))
]) {
  assert.throws(() => validateTimetable({ ...original, ...update }), { code: "INVALID_TIMETABLE" });
}
assert.equal(validateTimetable({ periodsPerDay: 1, defaultDuration: 5, breakMinutes: 0, periods: [{ section: 1, start: "00:00", end: "23:59" }] }).periodsPerDay, 1);
console.log("通过：作息表默认值深拷贝、旧缓存补齐、节次连续性、时间格式与参数边界校验");
