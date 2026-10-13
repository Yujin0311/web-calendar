// 极简管理 CLI：邀请码维护 + 手动会话清理，供服务器命令行直接执行。
// 用法（在项目根目录）：
//   node scripts/admin.js invite generate [最大可用次数] [备注...]
//   node scripts/admin.js invite list
//   node scripts/admin.js invite disable <邀请码>
//   node scripts/admin.js session clean
// 数据库位置与 server.js 一致：QINGXU_DATA_DIR 环境变量，缺省为项目 data/ 目录。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { cleanExpiredSessions } = require("../session-cleanup");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const DATA_DIR = process.env.QINGXU_DATA_DIR ? path.resolve(process.env.QINGXU_DATA_DIR) : path.join(__dirname, "..", "data");
if (!fs.existsSync(path.join(DATA_DIR, "qingxu.sqlite"))) {
  console.error(`未找到数据库：${path.join(DATA_DIR, "qingxu.sqlite")}。请先运行一次 npm start 完成初始化。`);
  process.exit(1);
}
const db = new Database(path.join(DATA_DIR, "qingxu.sqlite"));
db.pragma("journal_mode = WAL");

// 与 server.js 一致的配置读取：仅取正数，否则使用默认值。
const envNum = (key, fallback) => { const value = Number(process.env[key]); return Number.isFinite(value) && value > 0 ? value : fallback; };

// 邀请码字符集去掉 0/O/1/I 等易混淆字符，形如 QX-7K2M-9F4Q-PX8T。
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
function generateInviteCode() {
  const bytes = crypto.randomBytes(12);
  const body = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
  return `QX-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

function inviteGenerate(args) {
  const maxUseCount = Number(args[0] || 1);
  if (!Number.isInteger(maxUseCount) || maxUseCount < 1 || maxUseCount > 10000) return console.error("最大可用次数须为 1–10000 的整数。");
  const note = args.slice(1).join(" ").trim();
  // code 有唯一索引；随机撞码时换码重试（12 位随机字符，实际几乎不会发生）。
  const insert = db.prepare("INSERT INTO invite_codes(id,code,max_use_count,used_count,is_active,created_at,note) VALUES(?,?,?,0,1,?,?)");
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    try {
      insert.run(crypto.randomUUID(), code, maxUseCount, new Date().toISOString(), note);
      console.log(`邀请码已生成：${code}`);
      console.log(`最多可用次数：${maxUseCount}${note ? `；备注：${note}` : ""}`);
      return;
    } catch (error) {
      if (!error.code?.startsWith("SQLITE_CONSTRAINT")) throw error;
    }
  }
  console.error("邀请码生成失败：连续撞码，请重试。");
  process.exitCode = 1;
}

function inviteList() {
  const rows = db.prepare("SELECT code, max_use_count, used_count, is_active, created_at, note FROM invite_codes ORDER BY created_at DESC, rowid DESC").all();
  if (!rows.length) return console.log("当前没有任何邀请码，先用 invite generate 生成一个。");
  console.log("邀请码                已用/上限   状态    创建时间              备注");
  for (const row of rows) {
    const used = `${row.used_count}/${row.max_use_count}`.padEnd(10);
    console.log(`${row.code}  ${used} ${row.is_active ? "启用" : "停用"}    ${row.created_at.slice(0, 19).replace("T", " ")}  ${row.note}`);
  }
}

function inviteDisable(args) {
  const code = String(args[0] || "").trim().toUpperCase();
  if (!code) return console.error("请提供要停用的邀请码。");
  const result = db.prepare("UPDATE invite_codes SET is_active = 0 WHERE code = ?").run(code);
  console.log(result.changes ? `邀请码 ${code} 已停用。` : `未找到邀请码 ${code}。`);
  if (!result.changes) process.exitCode = 1;
}

function sessionClean() {
  const idleHours = envNum("SESSION_IDLE_TIMEOUT_HOURS", 24);
  const batchSize = envNum("SESSION_CLEANUP_BATCH_SIZE", 100);
  const deleted = cleanExpiredSessions(db, batchSize, Date.now() - idleHours * 3600000);
  console.log(`会话清理完成：删除 ${deleted} 条过期会话（空闲超时 ${idleHours} 小时，每批 ${batchSize} 条）。`);
}

function usage() {
  console.log("用法：node scripts/admin.js <子命令>");
  console.log("  invite generate [最大可用次数] [备注...]   生成邀请码，次数默认 1");
  console.log("  invite list                                列出全部邀请码");
  console.log("  invite disable <邀请码>                    停用指定邀请码");
  console.log("  session clean                              立即清理一次过期会话");
}

const [command, subcommand, ...args] = process.argv.slice(2);
if (command === "invite" && subcommand === "generate") inviteGenerate(args);
else if (command === "invite" && subcommand === "list") inviteList();
else if (command === "invite" && subcommand === "disable") inviteDisable(args);
else if (command === "session" && subcommand === "clean") sessionClean();
else { usage(); process.exitCode = 1; }
