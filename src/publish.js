'use strict';

const { getDb } = require('./db');
const { solve, claimToInterval } = require('./solver');
const { isoFromOrdinal } = require('./dates');

// 组装草稿现状并求解；不写库。
function evaluateDraft(selectionList) {
  const db = getDb();
  const events = db.prepare('SELECT id, title, description FROM events ORDER BY id').all();
  const claims = db.prepare('SELECT * FROM claims').all();
  const relations = db
    .prepare('SELECT id, earlier_id AS earlierId, later_id AS laterId, source, note FROM relations ORDER BY id')
    .all();

  const claimsById = new Map(claims.map((c) => [c.id, c]));
  const selected = new Map();
  const badSelection = [];

  for (const item of selectionList) {
    const claim = claimsById.get(item.claimId);
    if (!claim || claim.event_id !== item.eventId) {
      badSelection.push(item.eventId);
      continue;
    }
    selected.set(item.eventId, claimToInterval(claim));
  }

  if (badSelection.length) {
    const titles = new Map(events.map((e) => [e.id, e.title]));
    return {
      ok: false,
      errors: badSelection.map((eid) => ({
        type: 'bad_selection',
        eventIds: [eid],
        relationIds: [],
        message: `事件「${titles.get(eid) || eid}」选定的主张不存在或不属于该事件`,
      })),
      events,
      claims,
      relations,
    };
  }

  const result = solve(events, selected, relations);
  return { ...result, events, claims, relations, selected };
}

// 发布一个新版本。selectionList: [{eventId, claimId}]
// baseVersionNo: 编辑者发起修改时所基于的版本号；null/0 表示尚无版本。
// 抛 { status, ...body } 表示 HTTP 错误。
function publishVersion({ selectionList, baseVersionNo, editor, note }) {
  const db = getDb();

  if (!Array.isArray(selectionList) || selectionList.length === 0) {
    throw { status: 400, message: '请为每个事件选择一条主张后再发布' };
  }

  const currentRow = db.prepare('SELECT MAX(version_no) AS no FROM versions').get();
  const currentNo = currentRow.no || 0;
  const base = Number(baseVersionNo || 0);

  const evalResult = evaluateDraft(selectionList);
  if (!evalResult.ok) {
    throw {
      status: 422,
      message: '年表无法发布，请先修正下列问题（上一已发布版本保持不变）',
      errors: evalResult.errors,
    };
  }

  // 在事务内再次确认基准版本，避免并发下的静默覆盖
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT MAX(version_no) AS no FROM versions').get();
    const latest = row.no || 0;
    if (base !== latest) {
      throw {
        status: 409,
        code: 'VERSION_CONFLICT',
        message: `版本冲突：你基于第 ${base} 版修改，但当前最新已是第 ${latest} 版。请重新查看最新版本并确认你的选择后再发布。`,
        currentVersionNo: latest,
        baseVersionNo: base,
        currentVersion: getVersionSummary(latest),
      };
    }

    const newNo = latest + 1;
    const verInfo = db
      .prepare('INSERT INTO versions (version_no, parent_no, editor, note) VALUES (?, ?, ?, ?)')
      .run(newNo, base, String(editor || ''), String(note || ''));
    const versionId = verInfo.lastInsertRowid;

    const { dates, events, selected, relations } = evalResult;

    const insEvent = db.prepare(`
      INSERT INTO version_events
        (version_id, event_id, title, description, claim_id, precision, date_label,
         interval_start, interval_end, resolved_date, source, claim_note, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // 年表按求解出的具体日排序；同日按标题，保持稳定
    const sorted = [...events].sort((a, b) => {
      const da = dates.get(a.id);
      const db2 = dates.get(b.id);
      if (da !== db2) return da - db2;
      return a.title.localeCompare(b.title, 'zh-Hans-CN');
    });

    const eventOrder = new Map();
    sorted.forEach((ev, i) => {
      eventOrder.set(ev.id, i);
      const sel = selected.get(ev.id);
      const claimRow = evalResult.claims.find((c) => c.id === sel.claimId);
      insEvent.run(
        versionId,
        ev.id,
        ev.title,
        ev.description,
        claimRow.id,
        claimRow.precision,
        claimRow.date_label,
        claimRow.interval_start,
        claimRow.interval_end,
        isoFromOrdinal(dates.get(ev.id)),
        claimRow.source,
        claimRow.note,
        i
      );
    });

    const insRel = db.prepare(`
      INSERT INTO version_relations
        (version_id, relation_id, earlier_event_id, later_event_id, source, note, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const sortedRels = [...relations].sort(
      (a, b) =>
        eventOrder.get(a.earlierId) - eventOrder.get(b.earlierId) ||
        eventOrder.get(a.laterId) - eventOrder.get(b.laterId)
    );
    sortedRels.forEach((r, i) => {
      insRel.run(versionId, r.id, r.earlierId, r.laterId, r.source || '', r.note || '', i);
    });

    return newNo;
  });

  const newNo = tx();
  return { versionNo: newNo, version: getVersionDetail(newNo) };
}

function latestVersionNo() {
  const row = getDb().prepare('SELECT MAX(version_no) AS no FROM versions').get();
  return row.no || 0;
}

function getVersionSummary(no) {
  const db = getDb();
  const v = db
    .prepare(
      `SELECT v.version_no AS versionNo, v.parent_no AS parentNo, v.editor, v.note, v.published_at AS publishedAt,
              (SELECT COUNT(*) FROM version_events WHERE version_id = v.id) AS eventCount,
              (SELECT COUNT(*) FROM version_relations WHERE version_id = v.id) AS relationCount
         FROM versions v WHERE v.version_no = ?`
    )
    .get(no);
  return v || null;
}

function getVersionDetail(no) {
  const db = getDb();
  const summary = getVersionSummary(no);
  if (!summary) return null;
  const listEvents = db
    .prepare(
      `SELECT event_id AS eventId, title, description, claim_id AS claimId, precision,
              date_label AS dateLabel, interval_start AS intervalStart,
              interval_end AS intervalEnd, resolved_date AS resolvedDate,
              source, claim_note AS claimNote
         FROM version_events WHERE version_id = (SELECT id FROM versions WHERE version_no = ?)
        ORDER BY sort_order`
    )
    .all(no);
  const listRels = db
    .prepare(
      `SELECT relation_id AS relationId, earlier_event_id AS earlierEventId,
              later_event_id AS laterEventId, source, note
         FROM version_relations WHERE version_id = (SELECT id FROM versions WHERE version_no = ?)
        ORDER BY sort_order`
    )
    .all(no);
  return { ...summary, events: listEvents, relations: listRels };
}

module.exports = { publishVersion, evaluateDraft, latestVersionNo, getVersionDetail, getVersionSummary };
