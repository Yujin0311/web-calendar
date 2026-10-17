"use strict";

// AI 费用上限模块：分别累计 DeepSeek 与千问（阿里云百炼）的 token 花费，
// 累计金额达到上限后拒绝新的调用。金额只按本服务记录的 token 用量与单价估算，
// 不读取运营商账单；单价单位是「元 / 百万 tokens」，可在 .env 覆盖。
//
// 用法：reserve(provider) → 调用模型 → settle(reservation, { model, usage, userId })；
// 调用失败或提前返回时用 release(reservation) 归还预留额度。
// 三个函数都是同步的，因此在 Node 单线程里不会出现「并发请求同时通过预检查」的竞态。

// 默认单价按官网价目填写；官方调价后请用 .env 覆盖，否则只能得到估算金额。
const PROVIDERS = {
  deepseek: {
    key: "deepseek",
    label: "DeepSeek",
    limitEnv: "AI_LIMIT_DEEPSEEK_CNY",
    limitDefault: 100,
    // 一次调用最多预留的金额：估算的输入费用 + 最大输出费用，用于并发时先占位。
    reserveEnv: "AI_RESERVE_DEEPSEEK_CNY",
    reserveDefault: 0.2,
    inputEnv: "AI_PRICE_DEEPSEEK_INPUT",
    inputDefault: 4,
    cacheHitEnv: "AI_PRICE_DEEPSEEK_CACHE_HIT",
    cacheHitDefault: 0.5,
    outputEnv: "AI_PRICE_DEEPSEEK_OUTPUT",
    outputDefault: 12
  },
  qwen: {
    key: "qwen",
    label: "千问（百炼）",
    limitEnv: "AI_LIMIT_QWEN_CNY",
    limitDefault: 100,
    reserveEnv: "AI_RESERVE_QWEN_CNY",
    reserveDefault: 0.3,
    inputEnv: "AI_PRICE_QWEN_INPUT",
    inputDefault: 2,
    // 百炼默认没有缓存命中折扣，命中价与输入价相同。
    cacheHitEnv: "AI_PRICE_QWEN_CACHE_HIT",
    cacheHitDefault: 2,
    outputEnv: "AI_PRICE_QWEN_OUTPUT",
    outputDefault: 8
  }
};

const round2 = (value) => Math.round(value * 100) / 100;
const round1 = (value) => Math.round(value * 10) / 10;

function envNumber(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  // 负数或非数字视为未配置；0 是合法值（例如把上限设为 0 表示立即停用）。
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

// 兼容两家返回的字段：DeepSeek 有 prompt_cache_hit_tokens，百炼用 prompt_tokens_details.cached_tokens。
function normalizeUsage(usage) {
  const prompt = toCount(usage?.prompt_tokens);
  const completion = toCount(usage?.completion_tokens);
  const total = toCount(usage?.total_tokens) || prompt + completion;
  const cacheHit = Math.min(prompt, toCount(usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens));
  // 只有 total_tokens 时按输出价计费：宁可估高，也不要漏算花费。
  if (!prompt && !completion && total) return { prompt: 0, cacheHit: 0, completion: total, total };
  return { prompt, cacheHit, completion, total };
}

function costOf(cfg, tokens) {
  const missed = Math.max(0, tokens.prompt - tokens.cacheHit);
  const cost = (missed * cfg.prices.input + tokens.cacheHit * cfg.prices.cacheHit + tokens.completion * cfg.prices.output) / 1e6;
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

function budgetError(cfg, spent) {
  const limit = round2(cfg.limitCny);
  const used = round2(spent);
  const head = spent >= cfg.limitCny
    ? `${cfg.label} API 的 ${limit} 元额度已用完（累计 ${used} 元），已停止调用。`
    : `${cfg.label} API 剩余额度不足本次调用（已用 ${used} 元，上限 ${limit} 元），已停止调用。`;
  const error = new Error(`${head}如需继续使用，请在服务器 .env 中调整 ${cfg.limitEnv} 后重启服务。`);
  error.code = "BUDGET_EXCEEDED";
  error.provider = cfg.key;
  error.spentCny = used;
  error.limitCny = limit;
  return error;
}

// db 由 server.js 传入（同一个 better-sqlite3 连接），表在本模块内创建，便于测试独立建库。
function createAiBudget(db, env = process.env) {
  db.exec(`
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_cny REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_provider ON ai_usage(provider, created_at);
`);
  const spentStmt = db.prepare("SELECT COALESCE(SUM(cost_cny), 0) AS spent, COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens FROM ai_usage WHERE provider = ?");
  const insertStmt = db.prepare(`INSERT INTO ai_usage (user_id, provider, model, prompt_tokens, cache_hit_tokens, completion_tokens, total_tokens, cost_cny, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  // 已预留但尚未结算的金额：并发请求时先占位，避免同时越过上限。
  const pending = new Map();

  function spec(provider) {
    const base = PROVIDERS[provider];
    if (!base) throw Error(`未知的 AI 接口：${provider}`);
    return {
      ...base,
      limitCny: envNumber(env, base.limitEnv, base.limitDefault),
      reserveCny: envNumber(env, base.reserveEnv, base.reserveDefault),
      prices: {
        input: envNumber(env, base.inputEnv, base.inputDefault),
        cacheHit: envNumber(env, base.cacheHitEnv, base.cacheHitDefault),
        output: envNumber(env, base.outputEnv, base.outputDefault)
      }
    };
  }
  const spentOf = (provider) => spentStmt.get(provider).spent || 0;
  const pendingOf = (provider) => pending.get(provider) || 0;

  function reserve(provider) {
    const cfg = spec(provider);
    const spent = spentOf(provider);
    if (spent + pendingOf(provider) >= cfg.limitCny) throw budgetError(cfg, spent);
    const amount = Math.max(0, cfg.reserveCny);
    pending.set(provider, pendingOf(provider) + amount);
    return { provider, amount, settled: false };
  }

  function release(reservation) {
    if (!reservation || reservation.settled) return;
    reservation.settled = true;
    pending.set(reservation.provider, Math.max(0, pendingOf(reservation.provider) - reservation.amount));
  }

  // 记录一次真实花费；金额写入失败只打日志，不能影响已经拿到的模型结果。
  function settle(reservation, { model = "", usage = null, userId = null } = {}) {
    if (!reservation || reservation.settled) return null;
    try {
      const cfg = spec(reservation.provider);
      const tokens = normalizeUsage(usage);
      const cost = costOf(cfg, tokens);
      if (!tokens.total) console.warn(`[ai-budget] ${cfg.label} 返回的用量为空，本次按 0 元记账。`);
      insertStmt.run(userId, reservation.provider, String(model || ""), tokens.prompt, tokens.cacheHit,
        tokens.completion, tokens.total, cost, new Date().toISOString());
      return { ...tokens, costCny: cost };
    } catch (error) {
      console.error(`[ai-budget] 记录 ${reservation.provider} 用量失败：`, error);
      return null;
    } finally {
      release(reservation);
    }
  }

  function status() {
    const providers = Object.keys(PROVIDERS).map((provider) => {
      const cfg = spec(provider);
      const row = spentStmt.get(provider);
      const spent = row.spent || 0;
      return {
        provider,
        label: cfg.label,
        limitCny: round2(cfg.limitCny),
        spentCny: round2(spent),
        remainingCny: round2(Math.max(0, cfg.limitCny - spent)),
        usedPercent: cfg.limitCny > 0 ? round1(Math.min(100, spent / cfg.limitCny * 100)) : 100,
        calls: row.calls || 0,
        tokens: row.tokens || 0,
        pendingCny: round2(pendingOf(provider)),
        blocked: spent + pendingOf(provider) >= cfg.limitCny,
        price: { input: cfg.prices.input, cacheHit: cfg.prices.cacheHit, output: cfg.prices.output }
      };
    });
    return { updatedAt: new Date().toISOString(), providers };
  }

  return { reserve, settle, release, status };
}

module.exports = { createAiBudget, PROVIDERS, normalizeUsage, costOf };
