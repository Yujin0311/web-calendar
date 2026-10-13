// 会话过期清理模块：供 server.js 内置定时任务与 scripts/admin.js 手动清理共用。
// 设计要点：条件拆分成多条单列语句 + 分批 LIMIT 删除，每条都命中自己的索引，
// 避免一次性全表扫描拖垮低配 VPS；不引入 Redis 等额外组件。
"use strict";

// 清理条件（任一命中即删除）：
// 1. expires_at：原有 JWT 会话过期时间；
// 2. expire_at：绝对超时，无论是否活跃，到期强制失效；
// 3. last_activity_at：空闲超时，deadline = 当前时间 - 空闲超时配置。
// 用 jti IN (SELECT ... LIMIT ?) 子查询形式分批删除，SQLite 全版本支持。
function cleanExpiredSessions(db, batchSize, idleDeadline) {
  const nowMs = Date.now();
  const conditions = [
    { where: "expires_at <= ?", bound: nowMs },
    { where: "expire_at <= ?", bound: nowMs },
    { where: "last_activity_at <= ?", bound: idleDeadline }
  ];
  let deleted = 0;
  for (const { where, bound } of conditions) {
    const deleteBatch = db.prepare(`DELETE FROM sessions WHERE jti IN (SELECT jti FROM sessions WHERE ${where} LIMIT ?)`);
    let batch;
    // 循环删除直到某一批不足 batchSize，说明该条件下已无过期会话。
    do { batch = deleteBatch.run(bound, batchSize); deleted += batch.changes; }
    while (batch.changes >= batchSize);
  }
  return deleted;
}

module.exports = { cleanExpiredSessions };
