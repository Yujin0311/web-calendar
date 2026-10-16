-- 启动时由 server.js 先检查 PRAGMA table_info(user_settings)，仅在列不存在时执行。
ALTER TABLE user_settings ADD COLUMN timetable_json TEXT NOT NULL DEFAULT '{}';
