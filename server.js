// 清序后端：Express 提供静态页面和 API；SQLite 保存每个账户的独立数据。
// 启动：npm install && npm start，然后访问 http://localhost:3000。
"use strict";

const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { makeICS } = require("./ics-export");
const { cleanExpiredSessions } = require("./session-cleanup");
const { defaultTimetable, validateTimetable, normalizeTimetable } = require("./timetable");
// AI 规划助手与图片课表识别都在 deepseekSchedule 中：规划走 DeepSeek chat completions，
// 图片识别走百炼 qwen3-vl-plus 视觉模型。
const { makeStudyPlan, parseScheduleFromImage, densityTarget } = require("./services/deepseekSchedule");

// 本地开发读取 .env；Render 等部署环境直接提供同名环境变量。
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.QINGXU_DATA_DIR ? path.resolve(process.env.QINGXU_DATA_DIR) : path.join(__dirname, "data");
const EXPORT_HISTORY_FILE = process.env.QINGXU_EXPORT_HISTORY_FILE ? path.resolve(process.env.QINGXU_EXPORT_HISTORY_FILE) : path.join(__dirname, "export_history.json");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "qingxu.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// 首次运行生成随机密钥并保存在本机。生产部署建议改用 JWT_SECRET 环境变量。
const secretFile = path.join(DATA_DIR, "jwt-secret");
if (!process.env.JWT_SECRET && !fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(48).toString("hex"), { mode: 0o600 });
const JWT_SECRET = process.env.JWT_SECRET || fs.readFileSync(secretFile, "utf8").trim();

// ===== 安全增量配置：全部可用 .env / 环境变量覆盖，未设置时使用下列默认值 =====
const envNum = (key, fallback) => { const value = Number(process.env[key]); return Number.isFinite(value) && value > 0 ? value : fallback; };
// 注册限流：同一 IP 在窗口期内最多尝试注册的次数（成功与失败都计入）。
const REGISTER_WINDOW_MINUTES = envNum("REGISTER_WINDOW_MINUTES", 10);
const REGISTER_MAX_ATTEMPTS = envNum("REGISTER_MAX_ATTEMPTS", 3);
// 会话空闲超时（小时）与绝对超时（天）。
const SESSION_IDLE_TIMEOUT_HOURS = envNum("SESSION_IDLE_TIMEOUT_HOURS", 24);
const SESSION_ABSOLUTE_TIMEOUT_DAYS = envNum("SESSION_ABSOLUTE_TIMEOUT_DAYS", 7);
// 会话清理定时任务：运行间隔（分钟）与每批删除条数（分批避免大批量删除拖垮 CPU）。
const SESSION_CLEANUP_INTERVAL_MINUTES = envNum("SESSION_CLEANUP_INTERVAL_MINUTES", 120);
const SESSION_CLEANUP_BATCH_SIZE = envNum("SESSION_CLEANUP_BATCH_SIZE", 100);
// 活跃时间刷新节流（秒）：间隔内的重复请求不写库，降低低配 VPS 磁盘写入。
const SESSION_ACTIVITY_REFRESH_SECONDS = envNum("SESSION_ACTIVITY_REFRESH_SECONDS", 300);
const SESSION_IDLE_MS = SESSION_IDLE_TIMEOUT_HOURS * 3600000;
const SESSION_ABSOLUTE_MS = SESSION_ABSOLUTE_TIMEOUT_DAYS * 86400000;
const SESSION_REFRESH_MS = SESSION_ACTIVITY_REFRESH_SECONDS * 1000;

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  -- 增量会话保护字段（毫秒时间戳）：last_activity_at 最后活跃时间，expire_at 绝对过期时间。
  last_activity_at INTEGER NOT NULL,
  expire_at INTEGER NOT NULL
);
-- 邀请码注册：一个邀请码可按 max_use_count 供多人使用，可随时停用。
CREATE TABLE IF NOT EXISTS invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  max_use_count INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  PRIMARY KEY(user_id, id),
  UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  offsets_json TEXT NOT NULL,
  default_time TEXT NOT NULL,
  holidays_json TEXT NOT NULL,
  timetable_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id TEXT,
  category_name TEXT NOT NULL,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  duration INTEGER NOT NULL,
  reminder INTEGER NOT NULL,
  time_mode TEXT NOT NULL,
  start_time TEXT NOT NULL,
  note TEXT NOT NULL,
  review INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  plan_group INTEGER NOT NULL DEFAULT 0,
  parent_task_id TEXT,
  deleted_offsets_json TEXT NOT NULL DEFAULT '[]',
  draft_form_json TEXT,
  repeat_type TEXT NOT NULL DEFAULT 'none',
  repeat_weekdays_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('plan','draft')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, id),
  FOREIGN KEY(user_id, category_id) REFERENCES categories(user_id, id)
);
CREATE TABLE IF NOT EXISTS occurrences (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  offset_days INTEGER NOT NULL,
  round_number INTEGER NOT NULL,
  event_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  duration INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, id),
  FOREIGN KEY(user_id, task_id) REFERENCES tasks(user_id, id) ON DELETE CASCADE
);
-- 随手便签独立于任务快照，同一账户只能访问自己的便签。
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('left','right')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_occurrences_user_date ON occurrences(user_id, event_date);
CREATE INDEX IF NOT EXISTS idx_notes_user_side ON notes(user_id, side, created_at);
-- 会话清理索引：让每条清理条件都能精准定位过期行，避免全表扫描。
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expire_at ON sessions(expire_at);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity_at);
`);
// 已启动过早期第二版的本机数据库也补上“单条删除”的持久记录。
if (!db.prepare("PRAGMA table_info(user_settings)").all().some((column) => column.name === "timetable_json")) db.exec("ALTER TABLE user_settings ADD COLUMN timetable_json TEXT NOT NULL DEFAULT '{}'");
if (!db.prepare("PRAGMA table_info(tasks)").all().some((column) => column.name === "deleted_offsets_json")) db.exec("ALTER TABLE tasks ADD COLUMN deleted_offsets_json TEXT NOT NULL DEFAULT '[]'");
if (!db.prepare("PRAGMA table_info(tasks)").all().some((column) => column.name === "draft_form_json")) db.exec("ALTER TABLE tasks ADD COLUMN draft_form_json TEXT");
if (!db.prepare("PRAGMA table_info(tasks)").all().some((column) => column.name === "repeat_type")) db.exec("ALTER TABLE tasks ADD COLUMN repeat_type TEXT NOT NULL DEFAULT 'none'");
if (!db.prepare("PRAGMA table_info(tasks)").all().some((column) => column.name === "repeat_weekdays_json")) db.exec("ALTER TABLE tasks ADD COLUMN repeat_weekdays_json TEXT NOT NULL DEFAULT '[]'");
// 兼容已有数据库；全天与 AI 整套计划仅增加标记，不改旧字段与复习数据。
if (!db.prepare("PRAGMA table_info(tasks)").all().some((column) => column.name === "all_day")) db.exec("ALTER TABLE tasks ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0");
if (!db.prepare("PRAGMA table_info(tasks)").all().some((column) => column.name === "plan_group")) db.exec("ALTER TABLE tasks ADD COLUMN plan_group INTEGER NOT NULL DEFAULT 0");
if (!db.prepare("PRAGMA table_info(tasks)").all().some((column) => column.name === "parent_task_id")) db.exec("ALTER TABLE tasks ADD COLUMN parent_task_id TEXT");
// 旧数据库增量补齐会话超时字段：历史会话的活跃时间回填为创建时间、绝对过期沿用原 expires_at，不强制已有用户下线。
if (!db.prepare("PRAGMA table_info(sessions)").all().some((column) => column.name === "expire_at")) {
  db.exec("ALTER TABLE sessions ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0; ALTER TABLE sessions ADD COLUMN expire_at INTEGER NOT NULL DEFAULT 0;");
  db.exec("UPDATE sessions SET last_activity_at = CAST(strftime('%s', created_at) AS INTEGER) * 1000, expire_at = expires_at WHERE last_activity_at = 0");
}

app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && (() => { const time = Date.parse(`${value}T00:00:00Z`); return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value; })();
const validTime = (value) => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const fail = (res, status, message) => res.status(status).json({ error: message });

function readBearer(req) {
  const match = /^Bearer (.+)$/.exec(req.get("Authorization") || "");
  return match?.[1] || null;
}
function auth(req, res, next) {
  try {
    const token = readBearer(req);
    if (!token) return fail(res, 401, "请先登录。");
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    const nowMs = Date.now();
    const session = db.prepare("SELECT user_id, expires_at, expire_at, last_activity_at FROM sessions WHERE jti = ?").get(payload.jti);
    // 服务端三重校验：原 JWT 过期、绝对超时、空闲超时。过期判断只查数据库，不信任前端。
    if (!session || session.user_id !== payload.sub || session.expires_at <= nowMs || session.expire_at <= nowMs || nowMs - session.last_activity_at > SESSION_IDLE_MS) return fail(res, 401, "登录已失效，请重新登录。");
    // 每次请求刷新最后活跃时间；按节流间隔写库，避免高频请求造成写放大。
    if (nowMs - session.last_activity_at >= SESSION_REFRESH_MS) db.prepare("UPDATE sessions SET last_activity_at = ? WHERE jti = ?").run(nowMs, payload.jti);
    req.userId = payload.sub;
    req.jti = payload.jti;
    next();
  } catch { return fail(res, 401, "登录已失效，请重新登录。"); }
}
function issueToken(userId) {
  const jti = newId();
  const nowMs = Date.now();
  const expiresAt = nowMs + 30 * 24 * 60 * 60 * 1000; // 原有 30 天 JWT 有效期保持不变
  // 绝对超时可配置：与原 expires_at 取更早者写入 expire_at，作为强制失效时间。
  const expireAt = Math.min(expiresAt, nowMs + SESSION_ABSOLUTE_MS);
  db.prepare("INSERT INTO sessions(jti,user_id,expires_at,created_at,last_activity_at,expire_at) VALUES(?,?,?,?,?,?)").run(jti, userId, expiresAt, now(), nowMs, expireAt);
  return jwt.sign({ sub: userId, jti }, JWT_SECRET, { algorithm: "HS256", expiresIn: Math.floor((expireAt - nowMs) / 1000) });
}

// ===== 功能1：邀请码注册 + 注册 IP 限流（阻止脚本恶意批量注册） =====
// 限流为进程内滑动窗口（轻量方案，不引入 Redis）；服务重启后计数清零，属可接受折衷。
const registerAttempts = new Map(); // ip -> 窗口期内的尝试时间戳数组
function clientIp(req) {
  // 仅当部署在 Nginx/Caddy 等反代后并设置 TRUST_PROXY=true 时才信任转发头，防止伪造绕过限流。
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || "unknown";
}
function allowRegister(ip) {
  const nowMs = Date.now();
  const windowMs = REGISTER_WINDOW_MINUTES * 60000;
  const recent = (registerAttempts.get(ip) || []).filter((attempt) => nowMs - attempt < windowMs);
  if (recent.length >= REGISTER_MAX_ATTEMPTS) { registerAttempts.set(ip, recent); return false; }
  recent.push(nowMs);
  registerAttempts.set(ip, recent);
  // 防止攻击者用海量假 IP 撑爆内存：超过上限时清理窗口期外的记录。
  if (registerAttempts.size > 10000) {
    for (const [key, attempts] of registerAttempts) {
      if (!attempts.some((attempt) => nowMs - attempt < windowMs)) registerAttempts.delete(key);
      if (registerAttempts.size <= 5000) break;
    }
  }
  return true;
}
// 创建用户与消耗邀请码次数放在同一事务：better-sqlite3 同步执行天然串行，
// 叠加 used_count < max_use_count 条件更新，双重防止并发超用。
const registerWithInvite = db.transaction((userId, username, hash, inviteCode) => {
  db.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)").run(userId, username, hash, now());
  const consumed = db.prepare("UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ? AND is_active = 1 AND used_count < max_use_count").run(inviteCode);
  if (!consumed.changes) throw Error("INVITE_EXHAUSTED");
});

app.post("/api/auth/register", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = req.body?.password;
  const inviteCode = String(req.body?.inviteCode || "").trim().toUpperCase();
  if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(username)) return fail(res, 400, "账户名须为 3–32 位字母、数字、下划线或短横线。");
  if (typeof password !== "string" || password.length < 8 || password.length > 128) return fail(res, 400, "密码须为 8–128 个字符。");
  // ① 没有邀请码禁止注册；② 同一 IP 高频尝试直接限流，不再进入邀请码校验和 bcrypt 计算。
  if (!inviteCode) return fail(res, 400, "注册需要邀请码，请向管理员索取。");
  if (!allowRegister(clientIp(req))) return fail(res, 429, `注册尝试过于频繁，请 ${REGISTER_WINDOW_MINUTES} 分钟后再试。`);
  // 邀请码预检：无效 / 已用完分别给出可区分的错误；真正扣次在下方事务中条件更新兜底。
  const invite = db.prepare("SELECT max_use_count, used_count FROM invite_codes WHERE code = ? AND is_active = 1").get(inviteCode);
  if (!invite) return fail(res, 403, "邀请码无效，请核对后重试。");
  if (invite.used_count >= invite.max_use_count) return fail(res, 403, "邀请码已被用完，请联系管理员。");
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) return fail(res, 409, "账户名已被使用。");
  const hash = await bcrypt.hash(password, 12);
  const userId = newId();
  try {
    registerWithInvite(userId, username, hash, inviteCode);
  } catch (error) {
    // 事务内任一步失败都会整体回滚：邀请码次数不扣、用户不创建。
    if (error.message === "INVITE_EXHAUSTED") return fail(res, 403, "邀请码已被用完，请联系管理员。");
    if (error.code?.startsWith("SQLITE_CONSTRAINT")) return fail(res, 409, "账户名已被使用。");
    throw error;
  }
  return res.status(201).json({ token: issueToken(userId), user: { id: userId, username } });
});

app.post("/api/auth/login", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = req.body?.password;
  if (typeof password !== "string") return fail(res, 400, "请填写密码。");
  const user = db.prepare("SELECT id,username,password_hash FROM users WHERE username = ?").get(username);
  // 未找到用户时仍执行一次哈希比较，减少账户枚举的时间差。
  const dummyHash = "$2a$12$C6UzMDM.H6dfI/f/IKcEe.O4B.cYp5uMHI9G5/NYTeFh5b7UZ5.bO";
  const matches = await bcrypt.compare(password, user?.password_hash || dummyHash);
  if (!user || !matches) return fail(res, 401, "账户名或密码错误。");
  return res.json({ token: issueToken(user.id), user: { id: user.id, username: user.username } });
});
app.post("/api/auth/logout", auth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE jti = ? AND user_id = ?").run(req.jti, req.userId);
  res.json({ ok: true });
});
app.get("/api/auth/me", auth, (req, res) => {
  const user = db.prepare("SELECT id,username FROM users WHERE id = ?").get(req.userId);
  res.json({ user });
});

// 便签不进入 /api/sync 的任务快照；每条查询都带 JWT 解析出的 user_id。
app.get("/api/notes", auth, (req, res) => {
  res.json(db.prepare("SELECT id,content,side,created_at,updated_at FROM notes WHERE user_id = ? ORDER BY created_at, rowid").all(req.userId));
});
app.post("/api/notes", auth, (req, res) => {
  const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
  const side = req.body?.side;
  if (!content || [...content].length > 250) return fail(res, 400, "便签内容须为 1–250 个字符。");
  if (side !== "left") return fail(res, 400, "便签只支持左侧栏。");
  if (db.prepare("SELECT COUNT(*) AS total FROM notes WHERE user_id = ?").get(req.userId).total >= 30) return fail(res, 400, "每个账户最多保存 30 条便签。");
  const note = { id: newId(), content, side, created_at: now(), updated_at: now() };
  db.prepare("INSERT INTO notes(id,user_id,content,side,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(note.id, req.userId, note.content, note.side, note.created_at, note.updated_at);
  res.status(201).json(note);
});
app.put("/api/notes/:id", auth, (req, res) => {
  const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
  if (!content || [...content].length > 250) return fail(res, 400, "便签内容须为 1–250 个字符。");
  const updatedAt = now();
  const result = db.prepare("UPDATE notes SET content = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(content, updatedAt, req.params.id, req.userId);
  if (!result.changes) return fail(res, 404, "便签不存在。");
  res.json(db.prepare("SELECT id,content,side,created_at,updated_at FROM notes WHERE id = ? AND user_id = ?").get(req.params.id, req.userId));
});
app.delete("/api/notes/:id", auth, (req, res) => {
  const result = db.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  if (!result.changes) return fail(res, 404, "便签不存在。");
  res.json({ ok: true });
});

function loadState(userId) {
  const categories = db.prepare("SELECT id,name,color FROM categories WHERE user_id = ? ORDER BY rowid").all(userId);
  const settingsRow = db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(userId);
  const settings = settingsRow ? { offsets: JSON.parse(settingsRow.offsets_json), defaultTime: settingsRow.default_time, holidays: JSON.parse(settingsRow.holidays_json) } : { offsets: [0, 1, 2, 4, 7, 15, 30], defaultTime: "09:00", holidays: [] };
  try { settings.timetable = normalizeTimetable(JSON.parse(settingsRow?.timetable_json || "{}")); }
  catch { settings.timetable = defaultTimetable(); }
  const rows = db.prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at, rowid").all(userId);
  const occurrences = db.prepare("SELECT * FROM occurrences WHERE user_id = ? ORDER BY event_date,start_time").all(userId);
  const byTask = new Map();
  for (const row of occurrences) {
    if (!byTask.has(row.task_id)) byTask.set(row.task_id, []);
    byTask.get(row.task_id).push({ id: row.id, offset: row.offset_days, round: row.round_number, date: row.event_date, time: row.start_time, duration: row.duration, completed: Boolean(row.completed) });
  }
  const tasks = [], drafts = [];
  for (const row of rows) {
    const task = { id: row.id, categoryId: row.category_id, categoryName: row.category_name, name: row.name, date: row.start_date, endDate: row.end_date || "", duration: row.duration, reminder: row.reminder, timeMode: row.time_mode, time: row.start_time, note: row.note, review: Boolean(row.review), allDay: Boolean(row.all_day), planGroup: Boolean(row.plan_group), parentTaskId: row.parent_task_id || null, recurrence: { type: row.repeat_type || "none", weekdays: JSON.parse(row.repeat_weekdays_json || "[]") }, deletedOffsets: JSON.parse(row.deleted_offsets_json || "[]"), draftForm: row.draft_form_json ? JSON.parse(row.draft_form_json) : null, events: byTask.get(row.id) || [] };
    (row.status === "draft" ? drafts : tasks).push(task);
  }
  return { categories, tasks, drafts, settings };
}

// 统一校验同步数据。所有 ID 都会在服务器再次按当前用户写入，前端不能指定所有者。
function validateState(data) {
  if (!data || !Array.isArray(data.categories) || !Array.isArray(data.tasks) || !Array.isArray(data.drafts) || !data.settings) throw Error("同步数据格式错误。");
  if (data.categories.length > 200 || data.tasks.length + data.drafts.length > 10000) throw Error("数据量超过当前版本上限。");
  const catIds = new Set(), catNames = new Set(), taskIds = new Set(), occurrenceIds = new Set();
  for (const cat of data.categories) {
    if (typeof cat.id !== "string" || cat.id.length > 100 || !cat.id || typeof cat.name !== "string" || !cat.name.trim() || cat.name.length > 24 || !/^#[0-9a-fA-F]{6}$/.test(cat.color)) throw Error("分类数据无效。");
    if (catIds.has(cat.id) || catNames.has(cat.name)) throw Error("分类重复。");
    catIds.add(cat.id); catNames.add(cat.name);
  }
  const offsets = data.settings.offsets, holidays = data.settings.holidays;
  // 老客户端和离线待同步快照缺字段时保留账户已有设置；显式非法值仍拒绝。
  if (data.settings.timetable === undefined) data.settings.timetable = defaultTimetable();
  validateTimetable(data.settings.timetable);
  if (!Array.isArray(offsets) || !offsets.length || offsets[0] !== 0 || offsets.length > 100 || offsets.some((n, i) => !Number.isInteger(n) || n < 0 || n > 3650 || (i && n <= offsets[i - 1])) || !validTime(data.settings.defaultTime) || !Array.isArray(holidays) || holidays.length > 1000 || holidays.some((d) => !validDate(d))) throw Error("设置数据无效。");
  for (const task of [...data.tasks, ...data.drafts]) {
    if (typeof task.id !== "string" || !task.id || task.id.length > 100 || taskIds.has(task.id)) throw Error("任务 ID 无效或重复。");
    taskIds.add(task.id);
    const repeat = task.recurrence || { type: "none", weekdays: [] };
    if (!["none", "daily", "weekly", "monthly", "yearly"].includes(repeat.type) || !Array.isArray(repeat.weekdays) || repeat.weekdays.some((day) => !["MO", "TU", "WE", "TH", "FR", "SA", "SU"].includes(day)) || new Set(repeat.weekdays).size !== repeat.weekdays.length || (repeat.type === "weekly" && !repeat.weekdays.length) || (repeat.type !== "weekly" && repeat.weekdays.length) || (repeat.type !== "none" && task.review)) throw Error("重复设置无效。");
    if (!catIds.has(task.categoryId) || typeof task.name !== "string" || !task.name.trim() || task.name.length > (task.planGroup ? 500 : 80) || !validDate(task.date) || (task.endDate && (!validDate(task.endDate) || task.endDate < task.date)) || !Number.isInteger(task.duration) || task.duration < 1 || task.duration > 1440 || ![0, 10, 15, 30].includes(task.reminder) || !["fixed", "default"].includes(task.timeMode) || !validTime(task.time) || typeof task.note !== "string" || task.note.length > (task.planGroup ? 100000 : 1000) || typeof task.review !== "boolean" || (task.allDay !== undefined && typeof task.allDay !== "boolean") || (task.planGroup !== undefined && typeof task.planGroup !== "boolean") || (task.parentTaskId != null && (typeof task.parentTaskId !== "string" || !task.parentTaskId || task.parentTaskId.length > 100 || task.parentTaskId === task.id)) || !Array.isArray(task.events) || task.events.length > 3700 || (task.deletedOffsets !== undefined && (!Array.isArray(task.deletedOffsets) || task.deletedOffsets.some((n) => !Number.isInteger(n) || n < 0 || n > 3650))) || (task.draftForm != null && (typeof task.draftForm !== "object" || JSON.stringify(task.draftForm).length > 3000))) throw Error("任务数据无效。");
    if (repeat.type !== "none" && (!task.endDate || (Date.parse(`${task.endDate}T00:00:00Z`) - Date.parse(`${task.date}T00:00:00Z`)) / 86400000 > 3650)) throw Error("重复任务必须设置 10 年内的终止日期。");
    for (const event of task.events) {
      if (typeof event.id !== "string" || !event.id || event.id.length > 100 || occurrenceIds.has(event.id) || !Number.isInteger(event.offset) || event.offset < 0 || event.offset > 3650 || !Number.isInteger(event.round) || event.round < -1 || !validDate(event.date) || !validTime(event.time) || !Number.isInteger(event.duration) || event.duration < 1 || event.duration > 1440 || Number(event.time.slice(0, 2)) * 60 + Number(event.time.slice(3, 5)) + event.duration > 1440 || typeof event.completed !== "boolean") throw Error("日程数据无效。");
      occurrenceIds.add(event.id);
    }
  }
  // 父子关联只允许指向本次同步数据内的同账户 AI 父任务。
  const parents = new Set([...data.tasks, ...data.drafts].filter((task) => task.planGroup).map((task) => task.id));
  if ([...data.tasks, ...data.drafts].some((task) => task.parentTaskId && !parents.has(task.parentTaskId))) throw Error("子任务的父任务不存在。");
}

const saveState = db.transaction((userId, data) => {
  if (data?.settings && data.settings.timetable === undefined) data.settings.timetable = loadState(userId).settings.timetable;
  validateState(data);
  // 按 user_id 删除与重建，禁止影响其他账户；在一个 SQLite 事务中提交。
  db.prepare("DELETE FROM occurrences WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM tasks WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM categories WHERE user_id = ?").run(userId);
  const insertCat = db.prepare("INSERT INTO categories(id,user_id,name,color) VALUES(?,?,?,?)");
  for (const cat of data.categories) insertCat.run(cat.id, userId, cat.name, cat.color);
  db.prepare("INSERT INTO user_settings(user_id,offsets_json,default_time,holidays_json,timetable_json) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET offsets_json=excluded.offsets_json,default_time=excluded.default_time,holidays_json=excluded.holidays_json,timetable_json=excluded.timetable_json").run(userId, JSON.stringify(data.settings.offsets), data.settings.defaultTime, JSON.stringify(data.settings.holidays), JSON.stringify(data.settings.timetable));
  const insertTask = db.prepare("INSERT INTO tasks(id,user_id,category_id,category_name,name,start_date,end_date,duration,reminder,time_mode,start_time,note,review,all_day,plan_group,parent_task_id,deleted_offsets_json,draft_form_json,repeat_type,repeat_weekdays_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const insertEvent = db.prepare("INSERT INTO occurrences(id,user_id,task_id,offset_days,round_number,event_date,start_time,duration,completed) VALUES(?,?,?,?,?,?,?,?,?)");
  const writtenAt = now();
  for (const [status, collection] of [["plan", data.tasks], ["draft", data.drafts]]) {
    for (const task of collection) {
      insertTask.run(task.id, userId, task.categoryId, task.categoryName || "未分类", task.name, task.date, task.endDate || null, task.duration, task.reminder, task.timeMode, task.time, task.note, task.review ? 1 : 0, task.allDay ? 1 : 0, task.planGroup ? 1 : 0, task.parentTaskId || null, JSON.stringify(task.deletedOffsets || []), task.draftForm ? JSON.stringify(task.draftForm) : null, task.recurrence?.type || "none", JSON.stringify(task.recurrence?.weekdays || []), status, writtenAt, writtenAt);
      for (const event of task.events) insertEvent.run(event.id, userId, task.id, event.offset, event.round, event.date, event.time, event.duration, event.completed ? 1 : 0);
    }
  }
});

function withStateMutation(handler) {
  return (req, res) => {
    try {
      const data = loadState(req.userId);
      const result = handler(data, req);
      saveState(req.userId, data);
      res.json(result ?? { ok: true });
    } catch (error) { res.status(400).json({ error: error.message || "请求无效。" }); }
  };
}
function requireTask(data, id) {
  const task = [...data.tasks, ...data.drafts].find((item) => item.id === id);
  if (!task) throw Error("任务不存在。");
  return task;
}

app.get("/api/sync", auth, (req, res) => res.json(loadState(req.userId)));
app.put("/api/sync", auth, (req, res) => {
  try { saveState(req.userId, req.body); res.json({ ok: true }); }
  catch (error) { res.status(400).json({ error: error.message || "同步失败。" }); }
});
  // AI 只返回完整课表课程数组；接口不读写任务表，前端确认后才批量保存。
app.post("/api/ai/parse-schedule", auth, async (req, res) => {
  try {
    const timetable = req.body?.timetable === undefined ? defaultTimetable() : validateTimetable(req.body.timetable);
    res.json(await parseScheduleFromImage(req.body?.image, timetable));
  } catch (error) {
    // 给前端有限长度的底层原因，完整原始内容只留在服务端控制台。
    const detail = String(error.message || error.code || error.name || "未知错误").replace(/\s+/g, " ").slice(0, 200);
    if (error.code === "INVALID_IMAGE" || error.code === "INVALID_TIMETABLE") return fail(res, 400, error.message);
    if (error.code === "CONFIG_MISSING") return fail(res, 503, "AI 图片解析暂不可用：服务器未配置 DASHSCOPE_API_KEY。");
    if (error.code === "PARSE_FAILED") return fail(res, 422, detail);
    console.error("DeepSeek 图片解析失败：", error.name, error.status || "", error.code || "", detail);
    if (error.name === "APIConnectionTimeoutError" || error.message === "Request timed out." || error.code === "ETIMEDOUT") return fail(res, 504, `AI 解析超时（90 秒）：${detail}`);
    if (error.status === 401 || error.status === 403) return fail(res, 502, `DeepSeek 授权失败：${detail}`);
    if (error.status === 402) return fail(res, 503, `DeepSeek 账户余额不足：${detail}`);
    if (error.status === 429) return fail(res, 503, `AI 服务请求过于频繁：${detail}`);
    return fail(res, 502, `AI 服务暂时不可用（DeepSeek 状态码 ${error.status ?? "未知"}）：${detail}`);
  }
});
// AI 规划接口只接收一次性输入并返回结构化 JSON，不保存对话或结果。
app.post("/api/ai-plan", auth, async (req, res) => {
  const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
  const background = typeof req.body?.background === "string" ? req.body.background.trim() : "";
  const startDate = req.body?.startDate, endDate = req.body?.endDate;
  const preciseTime = req.body?.preciseTime;
  const density = req.body?.density === undefined ? "medium" : req.body.density;
  if (!["light", "medium", "busy"].includes(density)) return fail(res, 400, "任务密度取值无效。");
  const preferredWindow = typeof req.body?.preferredWindow === "string" ? req.body.preferredWindow.trim() : "";
  if (typeof preciseTime !== "boolean") return fail(res, 400, "请选择是否需要精确安排到几点。");
  if (preferredWindow.length > 120) return fail(res, 400, "高效时间段最多填写 120 个字符。");
  if (!goal || goal.length > 500) return fail(res, 400, "学习目标须为 1–500 个字符。");
  if (background.length > 2000) return fail(res, 400, "基础情况最多填写 2000 个字符。");
  if (!validDate(startDate) || !validDate(endDate) || endDate < startDate ||
      (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000 > 3650) {
    return fail(res, 400, "请选择有效的起止日期，范围最多 10 年。");
  }
  const inputTasks = req.body?.currentTasks ?? [];
  if (!Array.isArray(inputTasks) || inputTasks.length > 200 || inputTasks.some((task) => !task ||
      typeof task.name !== "string" || task.name.length > 40 || !validDate(task.date) ||
      typeof task.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(task.time) ||
      (task.allDay !== undefined && typeof task.allDay !== "boolean") ||
      !Number.isInteger(task.duration) || task.duration < 1 || task.duration > 1440 ||
      Number(task.time.slice(0, 2)) * 60 + Number(task.time.slice(3)) + task.duration > 1440 || typeof task.review !== "boolean")) {
    return fail(res, 400, "现有任务摘要格式不正确。");
  }
  // 仅把完成规划所需的摘要发送给模型；忽略客户端传来的其他字段。
  const currentTasks = inputTasks.map((task) => ({ name: task.name, date: task.date, time: task.time, duration: task.duration, allDay: task.allDay ?? false, review: task.review }));
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
  console.log(`[ai-plan] density=${density}, currentTasks=${currentTasks.length}条, target=${densityTarget(days, density)}`);
  try { res.json(await makeStudyPlan({ goal, startDate, endDate, background, currentTasks, preciseTime, preferredWindow, density })); }
  catch (error) {
    if (error.code === "CONFIG_MISSING") return fail(res, 503, "AI 规划暂不可用：服务器未配置 DEEPSEEK_API_KEY。");
    if (error.code === "PLAN_PARSE_FAILED" || error.code === "PARSE_FAILED") return fail(res, 422, error.message);
    if (error.name === "APIConnectionTimeoutError" || error.code === "ETIMEDOUT") return fail(res, 504, "AI 规划超时，请稍后重试。");
    console.error("DeepSeek AI 规划失败：", error.name, error.status || "", error.code || "");
    return fail(res, 502, "AI 规划服务暂时不可用，请稍后重试。");
  }
});
app.get("/api/settings", auth, (req, res) => res.json(loadState(req.userId).settings));
app.put("/api/settings", auth, withStateMutation((data, req) => { data.settings = req.body; return data.settings; }));
app.get("/api/categories", auth, (req, res) => res.json(loadState(req.userId).categories));
app.post("/api/categories", auth, withStateMutation((data, req) => { const category = { ...req.body, id: req.body.id || newId() }; data.categories.push(category); return category; }));
app.put("/api/categories/:id", auth, withStateMutation((data, req) => { const cat = data.categories.find((item) => item.id === req.params.id); if (!cat) throw Error("分类不存在。"); Object.assign(cat, req.body, { id: req.params.id }); return cat; }));
app.delete("/api/categories/:id", auth, withStateMutation((data, req) => { if ([...data.tasks, ...data.drafts].some((task) => task.categoryId === req.params.id)) throw Error("请先调整使用该分类的任务。"); data.categories = data.categories.filter((item) => item.id !== req.params.id); }));
app.get("/api/tasks", auth, (req, res) => { const data = loadState(req.userId); res.json({ tasks: data.tasks, drafts: data.drafts }); });
app.post("/api/tasks", auth, withStateMutation((data, req) => { const task = { ...req.body, id: req.body.id || newId() }; (req.body.status === "draft" ? data.drafts : data.tasks).push(task); return task; }));
app.put("/api/tasks/:id", auth, withStateMutation((data, req) => { const old = requireTask(data, req.params.id); data.tasks = data.tasks.filter((item) => item.id !== old.id); data.drafts = data.drafts.filter((item) => item.id !== old.id); const updated = { ...req.body, id: old.id }; (req.body.status === "draft" ? data.drafts : data.tasks).push(updated); return updated; }));
app.post("/api/tasks/:id/draft", auth, withStateMutation((data, req) => { const task = requireTask(data, req.params.id); data.tasks = data.tasks.filter((item) => item.id !== task.id); task.events = []; data.drafts.push(task); return task; }));
app.delete("/api/tasks/:id", auth, withStateMutation((data, req) => { requireTask(data, req.params.id); data.tasks = data.tasks.filter((item) => item.id !== req.params.id); data.drafts = data.drafts.filter((item) => item.id !== req.params.id); for (const child of [...data.tasks, ...data.drafts]) if (child.parentTaskId === req.params.id) child.parentTaskId = null; }));
app.patch("/api/occurrences/:id", auth, withStateMutation((data, req) => { const event = [...data.tasks, ...data.drafts].flatMap((task) => task.events).find((item) => item.id === req.params.id); if (!event) throw Error("日程不存在。"); if (typeof req.body.completed !== "boolean") throw Error("完成状态无效。"); event.completed = req.body.completed; return event; }));
app.delete("/api/occurrences/:id", auth, withStateMutation((data, req) => { for (const task of [...data.tasks, ...data.drafts]) { const target = task.events.find((event) => event.id === req.params.id); if (target) { task.events = task.events.filter((event) => event.id !== req.params.id); task.deletedOffsets = [...new Set([...(task.deletedOffsets || []), target.offset])]; if (!task.events.length) { data.tasks = data.tasks.filter((item) => item.id !== task.id); data.drafts = data.drafts.filter((item) => item.id !== task.id); for (const child of [...data.tasks, ...data.drafts]) if (child.parentTaskId === task.id) child.parentTaskId = null; } return; } } throw Error("日程不存在。"); }));

// 增量导出历史统一保存在项目根目录，按用户 ID 分区，避免不同账户互相影响。
function readExportHistory() {
  if (!fs.existsSync(EXPORT_HISTORY_FILE)) return { users: {} };
  const data = JSON.parse(fs.readFileSync(EXPORT_HISTORY_FILE, "utf8"));
  if (!data || typeof data.users !== "object" || Array.isArray(data.users)) throw Error("导出记录文件格式错误，请先备份并重置。");
  return data;
}
function writeExportHistory(data) {
  const temp = `${EXPORT_HISTORY_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(temp, EXPORT_HISTORY_FILE);
}
const exportInFlight = new Set();
app.get("/api/export/history", auth, (req, res) => {
  try { res.json(readExportHistory().users[req.userId] || { lastExportAt: null, exportedTaskIds: [] }); }
  catch (error) { fail(res, 500, error.message); }
});
app.post("/api/export/ics", auth, (req, res) => {
  if (exportInFlight.has(req.userId)) return fail(res, 409, "当前账户正在导出，请稍后再试。");
  try {
    const history = readExportHistory();
    const exported = new Set(history.users[req.userId]?.exportedTaskIds || []);
    const data = loadState(req.userId);
    const freshTasks = data.tasks.filter((task) => task.events.length && !exported.has(task.id));
    if (!freshTasks.length) return res.status(204).end();
    const ics = makeICS(data, freshTasks);
    const exportedIds = freshTasks.map((task) => task.id);
    exportInFlight.add(req.userId);
    res.once("finish", () => {
      try {
        // 发送完成后重新读取最新文件，再合并本次任务 ID。
        const latest = readExportHistory();
        const prior = latest.users[req.userId]?.exportedTaskIds || [];
        latest.users[req.userId] = { lastExportAt: now(), exportedTaskIds: [...new Set([...prior, ...exportedIds])] };
        writeExportHistory(latest);
      } catch (error) { console.error("写入导出记录失败：", error); }
      finally { exportInFlight.delete(req.userId); }
    });
    res.once("close", () => { if (!res.writableFinished) exportInFlight.delete(req.userId); });
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    // 固定文件名便于浏览器直接保存，也便于核对响应是否来自新版接口。
    res.setHeader("Content-Disposition", 'attachment; filename="qingxu.ics"');
    res.send(ics);
  } catch (error) { exportInFlight.delete(req.userId); fail(res, 500, error.message || "导出失败。"); }
});
app.delete("/api/export/history", auth, (req, res) => {
  if (exportInFlight.has(req.userId)) return fail(res, 409, "导出进行中，请稍后清空记录。");
  try {
    let history;
    try { history = readExportHistory(); } catch { history = { users: {} }; }
    delete history.users[req.userId];
    writeExportHistory(history);
    res.json({ ok: true });
  } catch (error) { fail(res, 500, error.message || "清空导出记录失败。"); }
});

// 只公开三个前端文件；数据库和密钥所在的 data 目录不会被静态服务访问。
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/index.html", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get(["/login", "/register"], (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/style.css", (req, res) => res.sendFile(path.join(__dirname, "style.css")));
app.get("/script.js", (req, res) => res.sendFile(path.join(__dirname, "script.js")));
app.get("/auth.js", (req, res) => res.sendFile(path.join(__dirname, "auth.js")));
app.get("/timetable.js", (req, res) => res.sendFile(path.join(__dirname, "timetable.js")));
app.get("/ai-schedule-client.js", (req, res) => res.sendFile(path.join(__dirname, "ai-schedule-client.js")));
app.get("/notes-client.js", (req, res) => res.sendFile(path.join(__dirname, "notes-client.js")));
app.get("/ai-plan-client.js", (req, res) => res.sendFile(path.join(__dirname, "ai-plan-client.js")));
app.get("/upgrade.css", (req, res) => res.sendFile(path.join(__dirname, "upgrade.css")));
app.use("/api", (req, res) => fail(res, 404, "接口不存在。"));
app.use((error, req, res, next) => {
  if (error.type === "entity.too.large") return fail(res, 413, "图片过大，请选择小于 6 MB 的图片。");
  console.error(error);
  fail(res, 500, "服务器内部错误。");
});
// ===== 功能2：过期会话定期清理（进程内定时器，防止僵尸会话堆积耗尽 CPU/内存） =====
function runSessionCleanup(reason) {
  try {
    const deleted = cleanExpiredSessions(db, SESSION_CLEANUP_BATCH_SIZE, Date.now() - SESSION_IDLE_MS);
    if (deleted) console.log(`会话清理（${reason}）：已删除 ${deleted} 条过期会话。`);
  } catch (error) { console.error("会话清理失败：", error); }
}
// 启动 30 秒后补跑一次，清掉停机期间积累的过期会话；随后按固定间隔执行。
// 定时器均 unref()，不阻止进程正常退出，也不影响测试。
setTimeout(() => runSessionCleanup("启动补跑"), 30 * 1000).unref();
setInterval(() => runSessionCleanup("定时任务"), SESSION_CLEANUP_INTERVAL_MINUTES * 60000).unref();

app.listen(PORT, HOST, () => console.log(`清序已启动：http://localhost:${PORT}`));
