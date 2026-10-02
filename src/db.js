'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============ 草稿区（编辑者可随时修改） ============
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 同一事件可保留多条互相矛盾的时间主张；发布时只选一条
CREATE TABLE IF NOT EXISTS claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  precision   TEXT NOT NULL CHECK (precision IN ('year','month','day')),
  year        INTEGER NOT NULL,
  month       INTEGER,
  day         INTEGER,
  date_label  TEXT NOT NULL,                 -- 供展示：如「1958 年 03 月」
  interval_start TEXT NOT NULL,             -- ISO，覆盖区间起点
  interval_end   TEXT NOT NULL,             -- ISO，覆盖区间终点
  source      TEXT NOT NULL DEFAULT '',     -- 出处（受访人/档案/页码）
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_claims_event ON claims(event_id);

-- earlier 必须严格先于 later
CREATE TABLE IF NOT EXISTS relations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  earlier_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  later_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source     TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (earlier_id <> later_id)
);
CREATE INDEX IF NOT EXISTS idx_rel_earlier ON relations(earlier_id);
CREATE INDEX IF NOT EXISTS idx_rel_later ON relations(later_id);

-- ============ 草稿修订号（恢复草稿时的乐观并发控制） ============
-- 草稿区 events/claims/relations 的任何增删改都由触发器推进 revision；
-- 「预览恢复」与「确认恢复」之间草稿若被改过，确认即报冲突、不改数据。
CREATE TABLE IF NOT EXISTS draft_meta (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO draft_meta (id, revision) VALUES (1, 0);

CREATE TRIGGER IF NOT EXISTS trg_events_rev_ai AFTER INSERT ON events
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_events_rev_au AFTER UPDATE ON events
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_events_rev_ad AFTER DELETE ON events
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_claims_rev_ai AFTER INSERT ON claims
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_claims_rev_au AFTER UPDATE ON claims
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_claims_rev_ad AFTER DELETE ON claims
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_relations_rev_ai AFTER INSERT ON relations
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_relations_rev_au AFTER UPDATE ON relations
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_relations_rev_ad AFTER DELETE ON relations
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;

-- ============ 采访整理包导入批次 ============
-- 记录每一次成功导入的批次标识与内容指纹；同一 batch_id 只允许成功导入一次，
-- 失败的确认（冲突回滚）不留记录，可修正后重试。
CREATE TABLE IF NOT EXISTS import_batches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id       TEXT NOT NULL UNIQUE,
  fingerprint    TEXT NOT NULL,
  event_count    INTEGER NOT NULL,
  claim_count    INTEGER NOT NULL,
  relation_count INTEGER NOT NULL,
  imported_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ 发布区（不可变版本快照） ============
CREATE TABLE IF NOT EXISTS versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  version_no   INTEGER NOT NULL UNIQUE,
  parent_no    INTEGER,                      -- 从哪个版本发起（0 表示首次）
  editor       TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS version_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id        INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  event_id          INTEGER NOT NULL,       -- 草稿事件 id（版本内不可变，仅作溯源）
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  claim_id          INTEGER NOT NULL,
  precision         TEXT NOT NULL,
  date_label        TEXT NOT NULL,
  interval_start    TEXT NOT NULL,
  interval_end      TEXT NOT NULL,
  resolved_date     TEXT NOT NULL,          -- 求解出的具体日 ISO
  source            TEXT NOT NULL DEFAULT '',
  claim_note        TEXT NOT NULL DEFAULT '',
  sort_order        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ve_version ON version_events(version_id);

CREATE TABLE IF NOT EXISTS version_relations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id   INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  relation_id  INTEGER NOT NULL,
  earlier_event_id INTEGER NOT NULL,
  later_event_id   INTEGER NOT NULL,
  source       TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  sort_order   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vr_version ON version_relations(version_id);

-- ============ 出处遮盖（编辑者按出处原文撤回公开展示） ============
-- 只追加登记「被遮盖的精确出处文本」：确认后不改写任何历史快照或草稿，
-- 公开接口读出时动态把命中位置的 source 显示为统一的「出处已遮盖」。
-- 持编辑口令的版本详情、从版本恢复草稿仍使用快照原文；
-- 以后新发布的快照只要 source 精确等于登记文本，公开读出同样自动遮盖。
-- 同一文本只登记一次（重复确认幂等返回已遮盖状态）；该表与草稿修订号无关。
CREATE TABLE IF NOT EXISTS source_redactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_text TEXT NOT NULL UNIQUE,             -- 精确出处原文（精确相等才命中）
  editor      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ 预约发布（定时发布） ============
-- 预约创建时把事件、所选主张、先于关系、求解日期与当时最新版本号整体冻结进
-- schedule_events / schedule_relations（结构与版本快照一致）。到期时只比较
-- base_version_no 与当前最新版本号：相等则把冻结内容复制成不可变新版本，
-- 不等则标记 conflict 保留内容供编辑者查看，绝不自动改基准。
-- pending → published | conflict | cancelled 为终态迁移（仅允许一次），
-- 行本身不删除，重启 / 重复触发靠 status 判定保证不重复发布。
CREATE TABLE IF NOT EXISTS scheduled_publishes (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_no         INTEGER NOT NULL UNIQUE,   -- 预约号（只增，不复用）
  scheduled_at        TEXT NOT NULL,             -- 预约发布时刻，UTC ISO（如 2026-10-05T08:00:00.000Z）
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','published','conflict','cancelled')),
  base_version_no     INTEGER NOT NULL,          -- 创建时冻结的基准（当前最新）版本号
  editor              TEXT NOT NULL DEFAULT '',
  note                TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  executed_at         TEXT,                      -- 实际尝试时刻 UTC
  result_version_no   INTEGER,                   -- status=published 时生成的新版本号
  conflict_version_no INTEGER                    -- status=conflict 时的当前最新版本号
);
CREATE INDEX IF NOT EXISTS idx_sched_due
  ON scheduled_publishes(status, scheduled_at, schedule_no);

CREATE TABLE IF NOT EXISTS schedule_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id       INTEGER NOT NULL REFERENCES scheduled_publishes(id) ON DELETE CASCADE,
  event_id          INTEGER NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  claim_id          INTEGER NOT NULL,
  precision         TEXT NOT NULL,
  date_label        TEXT NOT NULL,
  interval_start    TEXT NOT NULL,
  interval_end      TEXT NOT NULL,
  resolved_date     TEXT NOT NULL,               -- 冻结的求解具体日 ISO
  source            TEXT NOT NULL DEFAULT '',
  claim_note        TEXT NOT NULL DEFAULT '',
  sort_order        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_se_schedule ON schedule_events(schedule_id);

CREATE TABLE IF NOT EXISTS schedule_relations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id      INTEGER NOT NULL REFERENCES scheduled_publishes(id) ON DELETE CASCADE,
  relation_id      INTEGER NOT NULL,
  earlier_event_id INTEGER NOT NULL,
  later_event_id   INTEGER NOT NULL,
  source           TEXT NOT NULL DEFAULT '',
  note             TEXT NOT NULL DEFAULT '',
  sort_order       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sr_schedule ON schedule_relations(schedule_id);
`;

let db;

function getDb() {
  if (db) return db;
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'chronicle.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // 多进程（如多实例 / 到期事务撞车）时短暂等待写锁，而非立即抛 SQLITE_BUSY
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

// 测试时可注入独立数据库
function setDb(instance) {
  db = instance;
}

module.exports = { getDb, setDb, SCHEMA };
