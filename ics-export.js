// 服务器端 ICS 生成器。手动重复写入一个 VEVENT + RRULE；艾宾浩斯仍逐条写入 VEVENT。
"use strict";

const WEEKDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const pad = (value) => String(value).padStart(2, "0");
const dateValue = (date) => { const [y, m, d] = date.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const addDays = (date, days) => new Date(dateValue(date) + days * 86400000).toISOString().slice(0, 10);
const compact = (date, time) => `${date.replace(/-/g, "")}T${time.replace(":", "")}00`;
const utcStamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const escapeText = (value) => String(value ?? "").replace(/\\/g, "\\\\").replace(/\r\n|\n|\r/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");

// RFC 5545 规定内容行最多 75 个 UTF-8 字节，后续折行以空格开头。
function fold(line) {
  const lines = []; let current = "", bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > 75) { lines.push(current); current = " "; bytes = 1; }
    current += char; bytes += size;
  }
  lines.push(current);
  return lines.join("\r\n");
}
function endTime(date, time, duration) {
  const [hour, minute] = time.split(":").map(Number);
  const total = hour * 60 + minute + duration;
  return { date: total === 1440 ? addDays(date, 1) : date, time: `${pad(Math.floor((total % 1440) / 60))}:${pad(total % 60)}` };
}
function untilUtc(date) {
  const [year, month, day] = date.split("-").map(Number);
  // 截止日北京时间 23:59:59 转成 UTC，确保这一天的日程也在系列内。
  return new Date(Date.UTC(year, month - 1, day, 15, 59, 59)).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
function patternMatches(task, date) {
  const repeat = task.recurrence;
  if (repeat.type === "daily") return true;
  if (repeat.type === "weekly") return repeat.weekdays.includes(WEEKDAY[new Date(dateValue(date)).getUTCDay()]);
  if (repeat.type === "monthly") return date.slice(8) === task.date.slice(8);
  if (repeat.type === "yearly") return date.slice(5) === task.date.slice(5);
  return false;
}
function typeLabel(event) { return event.round === 0 ? "初次学习" : `复习第${event.round}轮`; }
function categoryName(task, categories) { return categories.find((cat) => cat.id === task.categoryId)?.name || task.categoryName || "未分类"; }
function commonEventLines(task, category, stamp, uid, date, time) {
  const end = endTime(date, time, task.duration);
  return ["BEGIN:VEVENT", `UID:${uid}@qingxu.local`, `DTSTAMP:${stamp}`,
    `DTSTART;TZID=Asia/Shanghai:${compact(date, time)}`,
    `DTEND;TZID=Asia/Shanghai:${compact(end.date, end.time)}`,
    `SUMMARY:${escapeText(`【${category}】${task.name}`)}`,
    `CATEGORIES:${escapeText(category)}`];
}
function appendAlarm(lines, task, title) {
  if (task.reminder > 0) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(title)}`, `TRIGGER:-PT${task.reminder}M`, "END:VALARM");
}
function repeatedEvent(task, category, stamp) {
  // DTSTART 选规则内首日，即使该日被 EXDATE 排除，系列模式仍然保持定义明确。
  let first = null;
  const span = (dateValue(task.endDate) - dateValue(task.date)) / 86400000;
  const included = new Set(task.events.map((event) => event.date));
  const excluded = [];
  for (let offset = 0; offset <= span; offset++) {
    const date = addDays(task.date, offset);
    if (!patternMatches(task, date)) continue;
    if (!first) first = date;
    if (!included.has(date)) excluded.push(date);
  }
  if (!first) return [];
  const time = task.events[0]?.time || task.time;
  const lines = commonEventLines(task, category, stamp, task.id, first, time);
  const repeat = task.recurrence;
  let rule = `FREQ=${repeat.type.toUpperCase()}`;
  if (repeat.type === "weekly") rule += `;BYDAY=${repeat.weekdays.join(",")}`;
  if (repeat.type === "monthly") rule += `;BYMONTHDAY=${Number(task.date.slice(8))}`;
  if (repeat.type === "yearly") rule += `;BYMONTH=${Number(task.date.slice(5, 7))};BYMONTHDAY=${Number(task.date.slice(8))}`;
  rule += `;UNTIL=${untilUtc(task.endDate)}`;
  lines.push(`RRULE:${rule}`);
  if (excluded.length) lines.push(`EXDATE;TZID=Asia/Shanghai:${excluded.map((date) => compact(date, time)).join(",")}`);
  lines.push(`DESCRIPTION:${escapeText(task.note)}`);
  appendAlarm(lines, task, `【${category}】${task.name}`);
  lines.push("END:VEVENT");
  return lines;
}

function makeICS(state, selectedTasks = state.tasks) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Qingxu//Study Planner 3.0//ZH", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VTIMEZONE", "TZID:Asia/Shanghai", "X-LIC-LOCATION:Asia/Shanghai", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0800", "TZOFFSETTO:+0800", "TZNAME:CST", "END:STANDARD", "END:VTIMEZONE"];
  const stamp = utcStamp();
  for (const task of selectedTasks) {
    if (!task.events?.length) continue;
    const category = categoryName(task, state.categories);
    if (task.recurrence?.type && task.recurrence.type !== "none") {
      lines.push(...repeatedEvent(task, category, stamp));
      continue;
    }
    for (const event of task.events) {
      const part = commonEventLines(task, category, stamp, event.id, event.date, event.time);
      part.push(`DESCRIPTION:${escapeText(task.note ? `${task.note}\n\n${typeLabel(event)}` : typeLabel(event))}`);
      appendAlarm(part, task, `【${category}】${task.name}`);
      part.push("END:VEVENT");
      lines.push(...part);
    }
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

module.exports = { makeICS, repeatedEvent };
