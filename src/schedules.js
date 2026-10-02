'use strict';

// 预约发布（定时发布）。
//
// 创建（createSchedule）：草稿必须先通过与即时发布完全相同的选择 / 求解校验
// （复用 publish.evaluateDraft + buildSnapshotRows），且预约时间是严格晚于现在的
// 合法 UTC 时刻。创建在一个事务内冻结：
//   - 每个事件及其被选主张（精度、区间、出处、考异）
//   - 全部「先于」关系（含出处）
//   - 求解出的具体日期
//   - 当时的最新版本号 base_version_no
// 草稿此后的任何修改 / 恢复都不影响已冻结内容；时间非法或校验不通过则不建立预约。
//
// 到期（runDueSchedules，由 startScheduler 的定时器驱动，启动时立即追赶一次）：
//   按 (scheduled_at, schedule_no) 顺序逐条处理到期 pending 预约，每条一个事务：
//     - 冻结基准号仍等于当前最新版本号 → 把冻结内容原样复制为一个不可变新版本，
//       预约置 published；
//     - 不等（期间有即时发布或更早的预约先生效）→ 置 conflict 并保留冻结内容，
//       不自动改基准，需编辑者处理后重新预约；
//   - 事务内以 status='pending' 为守卫条件，重启 / 重复触发不会重复发布；
//     事务整体回滚保证失败不留下半版（该预约下一轮继续重试）。
//
// 取消（cancelSchedule）：仅 pending 可取消；published / conflict / cancelled
// 均为终态。所有预约行与冻结内容保留，供编辑者工作台查看。

const { getDb } = require('./db');
const {
  evaluateDraft,
  buildSnapshotRows,
  insertVersionSnapshot,
  latestVersionNo,
} = require('./publish');

const SCHEDULE_TICK_MS = Number(process.env.SCHEDULE_TICK_MS || 1000);

// ---------- 预约时间 ----------
// 必须显式给出 UTC（或带时区偏移）的完整日期时间，禁止只给日期（语义歧义）。
// 接受 2026-10-05T08:00:00Z / 2026-10-05T08:00:00.000Z / 2026-10-05T16:00:00+08:00。
const SCHEDULED_AT_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$/;

function parseScheduleAt(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw { status: 400, message: 'scheduledAt 必须是非空字符串（带时区的 UTC 日期时间，如 2026-10-05T08:00:00Z）' };
  }
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw { status: 400, message: 'scheduledAt 必须包含具体时刻与时区，例如 2026-10-05T08:00:00Z（不能只给日期）' };
  }
  if (!SCHEDULED_AT_RE.test(text)) {
    throw { status: 400, message: 'scheduledAt 不是合法的 ISO 8601 日期时间：需要形如 2026-10-05T08:00:00Z（或 +08:00 偏移）' };
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) {
    throw { status: 400, message: 'scheduledAt 不是合法的日期时间' };
  }
  return new Date(ms);
}

// ---------- 冻结快照读写 ----------
function insertScheduleSnapshot(db, scheduleId, rows) {
  const insEvent = db.prepare(`
    INSERT INTO schedule_events
      (schedule_id, event_id, title, description, claim_id, precision, date_label,
       interval_start, interval_end, resolved_date, source, claim_note, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const ev of rows.eventRows) {
    insEvent.run(
      scheduleId,
      ev.eventId,
      ev.title,
      ev.description,
      ev.claimId,
      ev.precision,
      ev.dateLabel,
      ev.intervalStart,
      ev.intervalEnd,
      ev.resolvedDate,
      ev.source,
      ev.claimNote,
      ev.sortOrder
    );
  }
  const insRel = db.prepare(`
    INSERT INTO schedule_relations
      (schedule_id, relation_id, earlier_event_id, later_event_id, source, note, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const rel of rows.relationRows) {
    insRel.run(
      scheduleId,
      rel.relationId,
      rel.earlierEventId,
      rel.laterEventId,
      rel.source,
      rel.note,
      rel.sortOrder
    );
  }
}

// 读回冻结快照并整理成与版本快照一致的行结构，供到期时原样复制。
function getScheduleRows(db, scheduleId) {
  const eventRows = db
    .prepare(
      `SELECT event_id AS eventId, title, description, claim_id AS claimId, precision,
              date_label AS dateLabel, interval_start AS intervalStart,
              interval_end AS intervalEnd, resolved_date AS resolvedDate,
              source, claim_note AS claimNote, sort_order AS sortOrder
         FROM schedule_events WHERE schedule_id = ? ORDER BY sort_order`
    )
    .all(scheduleId);
  const relationRows = db
    .prepare(
      `SELECT relation_id AS relationId, earlier_event_id AS earlierEventId,
              later_event_id AS laterEventId, source, note, sort_order AS sortOrder
         FROM schedule_relations WHERE schedule_id = ? ORDER BY sort_order`
    )
    .all(scheduleId);
  return { eventRows, relationRows };
}

function scheduleRowToApi(r) {
  const db = getDb();
  const { eventRows, relationRows } = getScheduleRows(db, r.id);
  return {
    id: r.id,
    scheduleNo: r.schedule_no,
    scheduledAt: r.scheduled_at,
    status: r.status,
    baseVersionNo: r.base_version_no,
    editor: r.editor,
    note: r.note,
    createdAt: r.created_at,
    executedAt: r.executed_at,
    resultVersionNo: r.result_version_no,
    conflictVersionNo: r.conflict_version_no,
    // 冻结内容（与版本快照同构）；pending/conflict 时供编辑者查看
    events: eventRows,
    relations: relationRows,
  };
}

function getScheduleById(id) {
  const row = getDb().prepare('SELECT * FROM scheduled_publishes WHERE id = ?').get(id);
  return row ? scheduleRowToApi(row) : null;
}

function getScheduleByNo(no) {
  const row = getDb().prepare('SELECT * FROM scheduled_publishes WHERE schedule_no = ?').get(no);
  return row ? scheduleRowToApi(row) : null;
}

function listSchedules() {
  const rows = getDb()
    .prepare('SELECT * FROM scheduled_publishes ORDER BY schedule_no DESC')
    .all();
  return rows.map(scheduleRowToApi);
}

function pendingScheduleCount() {
  return getDb()
    .prepare("SELECT COUNT(*) AS n FROM scheduled_publishes WHERE status = 'pending'")
    .get().n;
}

// ---------- 创建预约：校验 + 冻结（一个事务） ----------
// 抛 { status, ...body } 表示 HTTP 错误；成功返回预约详情。
function createSchedule({ selectionList, scheduledAt, editor, note }) {
  const when = parseScheduleAt(scheduledAt);
  if (when.getTime() <= Date.now()) {
    throw { status: 400, message: '预约发布时间必须是未来的 UTC 时间（当前时刻已过该时间，不能预约）' };
  }
  if (!Array.isArray(selectionList) || selectionList.length === 0) {
    throw { status: 400, message: '请为每个事件选择一条主张后再预约发布' };
  }

  // 与即时发布同一条校验路径：缺主张 / bad_selection / 成环 / 时间无解
  const evalResult = evaluateDraft(selectionList);
  if (!evalResult.ok) {
    throw {
      status: 422,
      message: '草稿当前未通过发布校验，不能建立预约（请先修正下列问题）',
      errors: evalResult.errors,
    };
  }
  const rows = buildSnapshotRows(evalResult);
  const scheduledAtIso = when.toISOString();
  const db = getDb();

  const id = db.transaction(() => {
    const base = latestVersionNo(); // 冻结当前最新版本号
    const maxRow = db.prepare('SELECT MAX(schedule_no) AS n FROM scheduled_publishes').get();
    const scheduleNo = (maxRow.n || 0) + 1;
    const info = db
      .prepare(
        `INSERT INTO scheduled_publishes
           (schedule_no, scheduled_at, status, base_version_no, editor, note)
         VALUES (?, ?, 'pending', ?, ?, ?)`
      )
      .run(scheduleNo, scheduledAtIso, base, String(editor || ''), String(note || ''));
    insertScheduleSnapshot(db, info.lastInsertRowid, rows);
    return info.lastInsertRowid;
  })();

  return getScheduleById(id);
}

// ---------- 取消尚未执行的预约 ----------
function cancelSchedule(id) {
  const db = getDb();
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM scheduled_publishes WHERE id = ?').get(id);
    if (!row) {
      throw { status: 404, message: `预约 ${id} 不存在` };
    }
    if (row.status !== 'pending') {
      const label = STATUS_LABEL[row.status] || row.status;
      throw {
        status: 409,
        code: 'SCHEDULE_NOT_PENDING',
        message: `预约 #${row.schedule_no} 已${label}，不能取消（仅尚未执行的预约可取消）`,
        scheduleId: row.id,
        scheduleNo: row.schedule_no,
        scheduleStatus: row.status,
      };
    }
    db.prepare("UPDATE scheduled_publishes SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id);
  });
  tx.immediate();
  return getScheduleById(id);
}

const STATUS_LABEL = {
  pending: '处于待执行状态',
  published: '生效发布',
  conflict: '因版本冲突未发布',
  cancelled: '被取消',
};

// ---------- 到期执行 ----------
// 处理一条 pending 预约（独立 immediate 事务，先抢写锁以兼容多进程）。
// 返回 { outcome: 'published'|'conflict'|'skipped', ... }。
function executeSchedule(row, nowIso) {
  const db = getDb();
  const tx = db.transaction(() => {
    // 事务内重读并以 status 守卫：重启 / 重复触发 / 其他进程已处理时直接跳过
    const cur = db.prepare('SELECT * FROM scheduled_publishes WHERE id = ?').get(row.id);
    if (!cur || cur.status !== 'pending') return { outcome: 'skipped' };

    const latest = latestVersionNo();
    if (latest !== cur.base_version_no) {
      const r = db
        .prepare(
          `UPDATE scheduled_publishes
              SET status = 'conflict', executed_at = ?, conflict_version_no = ?
            WHERE id = ? AND status = 'pending'`
        )
        .run(nowIso, latest, cur.id);
      if (r.changes !== 1) return { outcome: 'skipped' };
      return { outcome: 'conflict', baseVersionNo: cur.base_version_no, currentVersionNo: latest };
    }

    // 基准未变：把冻结内容复制为不可变新版本（与即时发布同一写入函数）
    const newNo = latest + 1;
    const verInfo = db
      .prepare('INSERT INTO versions (version_no, parent_no, editor, note) VALUES (?, ?, ?, ?)')
      .run(newNo, cur.base_version_no, cur.editor, cur.note);
    insertVersionSnapshot(db, verInfo.lastInsertRowid, getScheduleRows(db, cur.id));

    const r = db
      .prepare(
        `UPDATE scheduled_publishes
            SET status = 'published', executed_at = ?, result_version_no = ?
          WHERE id = ? AND status = 'pending'`
      )
      .run(nowIso, newNo, cur.id);
    if (r.changes !== 1) {
      // 极端并发下状态被别处先改：回滚整个事务，连新版本一起撤销，绝不重复 / 不留半版
      throw new Error(`schedule ${cur.schedule_no} status guard failed`);
    }
    return { outcome: 'published', versionNo: newNo };
  });
  return tx.immediate();
}

// 处理所有到期 pending 预约；按预约时间、预约号顺序。
// nowMs 可注入（测试用）。单条失败不影响其余预约；失败预约保留下轮重试。
function runDueSchedules(nowMs = Date.now()) {
  const db = getDb();
  const nowIso = new Date(nowMs).toISOString();
  const due = db
    .prepare(
      `SELECT * FROM scheduled_publishes
        WHERE status = 'pending' AND scheduled_at <= ?
        ORDER BY scheduled_at ASC, schedule_no ASC`
    )
    .all(nowIso);

  const outcomes = [];
  for (const row of due) {
    try {
      const result = executeSchedule(row, nowIso);
      outcomes.push({ scheduleId: row.id, scheduleNo: row.schedule_no, ...result });
    } catch (err) {
      console.error(`预约 #${row.schedule_no} 到期执行失败（保留待执行，下轮重试）：`, err && err.message ? err.message : err);
      outcomes.push({ scheduleId: row.id, scheduleNo: row.schedule_no, outcome: 'error', message: String(err && err.message || err) });
    }
  }
  return outcomes;
}

// ---------- 定时器 ----------
let timer = null;
let ticking = false;

function startScheduler({ intervalMs = SCHEDULE_TICK_MS } = {}) {
  if (timer) return stopScheduler;
  const tick = () => {
    // 防御性重入（正常路径全部为同步调用，不会重叠）
    if (ticking) return;
    ticking = true;
    try {
      runDueSchedules();
    } catch (err) {
      console.error('预约发布轮询失败：', err);
    } finally {
      ticking = false;
    }
  };
  // 启动立即追赶一次：发布停机期间到期的预约在重启后立刻按序尝试
  tick();
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return stopScheduler;
}

function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  parseScheduleAt,
  createSchedule,
  cancelSchedule,
  listSchedules,
  getScheduleById,
  getScheduleByNo,
  pendingScheduleCount,
  runDueSchedules,
  executeSchedule,
  startScheduler,
  stopScheduler,
};
