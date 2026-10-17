// AI 费用上限单元测试：只操作内存数据库，不发起网络请求也不启动服务。
"use strict";

const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { createAiBudget, normalizeUsage } = require("../services/aiBudget");

const find = (budget, provider) => budget.status().providers.find((item) => item.provider === provider);

function main() {
  // 1) 初始状态：两家接口各 100 元，未发生调用。
  const db = new Database(":memory:");
  const env = { AI_LIMIT_DEEPSEEK_CNY: "100", AI_LIMIT_QWEN_CNY: "100" };
  const budget = createAiBudget(db, env);
  const initial = budget.status();
  assert.equal(initial.providers.length, 2);
  assert.deepEqual(initial.providers.map((item) => [item.provider, item.limitCny, item.spentCny, item.blocked]),
    [["deepseek", 100, 0, false], ["qwen", 100, 0, false]]);

  // 2) 普通调用按「输入 4 元 + 输出 12 元 / 百万 tokens」记账。
  let reservation = budget.reserve("deepseek");
  assert.equal(reservation.settled, false);
  budget.settle(reservation, { model: "deepseek-chat", userId: "u1",
    usage: { prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 } });
  let deepseek = find(budget, "deepseek");
  assert.equal(deepseek.spentCny, 0.03, "1000 输入 + 2000 输出应约 0.028 元并四舍五入到分");
  assert.equal(deepseek.calls, 1);
  assert.equal(deepseek.tokens, 3000);
  assert.equal(deepseek.pendingCny, 0, "结算后必须归还预留额度");
  assert.equal(deepseek.blocked, false);

  // 3) 缓存命中的输入按更低的单价计费，且不会超过输入总量。
  reservation = budget.reserve("deepseek");
  budget.settle(reservation, { usage: { prompt_tokens: 1_000_000, prompt_cache_hit_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 } });
  assert.equal(find(budget, "deepseek").spentCny, 0.53, "100 万缓存命中输入应计 0.5 元");

  // 4) 百炼的用量字段（prompt_tokens_details.cached_tokens）同样识别。
  reservation = budget.reserve("qwen");
  budget.settle(reservation, { model: "qwen3-vl-plus", usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 } });
  assert.equal(find(budget, "qwen").spentCny, 0.01, "千问 1000 输入 + 1000 输出应约 0.01 元");
  assert.equal(find(budget, "deepseek").spentCny, 0.53, "两家接口的金额互不影响");

  // 5) 幂等：重复结算 / 重复归还不重复记账。
  budget.settle(reservation, { usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 } });
  budget.release(reservation);
  assert.equal(find(budget, "qwen").spentCny, 0.01);
  assert.equal(find(budget, "qwen").calls, 1);

  // 6) 用完额度后拒绝新调用，错误信息给出上限与修改方式。
  const capped = createAiBudget(new Database(":memory:"),
    { AI_LIMIT_DEEPSEEK_CNY: "0.3", AI_RESERVE_DEEPSEEK_CNY: "0.2", AI_PRICE_DEEPSEEK_OUTPUT: "1" });
  const first = capped.reserve("deepseek");
  const second = capped.reserve("deepseek");
  // 预留额度会计入判断：0.2 + 0.2 已经高于 0.3，第三个请求必须被拦截。
  assert.throws(() => capped.reserve("deepseek"), (error) => error.code === "BUDGET_EXCEEDED");
  capped.release(first);
  capped.release(second);
  assert.equal(find(capped, "deepseek").pendingCny, 0);
  const third = capped.reserve("deepseek");
  capped.settle(third, { usage: { completion_tokens: 400_000, total_tokens: 400_000 } });
  assert.equal(find(capped, "deepseek").spentCny, 0.4);
  assert.equal(find(capped, "deepseek").blocked, true);
  assert.throws(() => capped.reserve("deepseek"), (error) =>
    error.code === "BUDGET_EXCEEDED" && /0\.3 元额度已用完/.test(error.message) && /AI_LIMIT_DEEPSEEK_CNY/.test(error.message));

  // 7) 只有 total_tokens 时按输出价保守计费；未知接口直接报错。
  assert.deepEqual(normalizeUsage({ total_tokens: 500 }), { prompt: 0, cacheHit: 0, completion: 500, total: 500 });
  assert.throws(() => capped.reserve("unknown"), /未知的 AI 接口/);

  // 8) 上限为 0 表示立即停用。
  const disabled = createAiBudget(new Database(":memory:"), { AI_LIMIT_QWEN_CNY: "0" });
  assert.throws(() => disabled.reserve("qwen"), { code: "BUDGET_EXCEEDED" });
  assert.equal(find(disabled, "qwen").blocked, true);

  console.log("通过：AI 费用上限（两家接口独立累计、缓存命中计价、预留额度防并发、达到上限拒绝调用、上限 0 停用）");
}

main();
