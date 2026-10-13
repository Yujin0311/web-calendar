-- ============================================================================
-- 清序增量迁移：邀请码注册 + 会话超时清理
-- 生成日期：2026-10-13
--
-- 说明：
-- 1. server.js 启动时会自动做同样的幂等迁移（建表 / 补列），本文件供希望
--    在启动前显式完成变更、或需要在备份库先行迁移的场景手动执行。
-- 2. 执行方式：sqlite3 data/qingxu.sqlite < migrations/001_invite_codes_and_session_cleanup.sql
-- 3. CREATE TABLE / CREATE INDEX / UPDATE 均可重复执行；
--    但 ALTER TABLE ADD COLUMN 不可重复执行——若报 duplicate column name
--    错误，说明已经迁移过，可忽略该错误或跳过后续 ALTER。
-- ============================================================================

-- 1. 邀请码表：一个邀请码可按 max_use_count 供多人使用，可随时停用。
CREATE TABLE IF NOT EXISTS invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  max_use_count INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

-- 2. 会话表新增超时字段（毫秒时间戳）：
--    last_activity_at：最后活跃时间；expire_at：绝对过期时间。
ALTER TABLE sessions ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN expire_at INTEGER NOT NULL DEFAULT 0;

-- 3. 历史会话回填：活跃时间取创建时间，绝对过期沿用原 expires_at
--    （不强制已有用户在迁移后立即下线）。
UPDATE sessions
SET last_activity_at = CAST(strftime('%s', created_at) AS INTEGER) * 1000,
    expire_at = expires_at
WHERE last_activity_at = 0;

-- 4. 会话清理与查询索引：让每条清理条件精准定位过期行，避免全表扫描。
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expire_at ON sessions(expire_at);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity_at);
