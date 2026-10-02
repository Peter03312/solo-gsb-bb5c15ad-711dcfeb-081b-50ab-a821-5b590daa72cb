'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
const { SCHEMA, setDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app } = require('../src/server');
const { REDACTED_SOURCE } = require('../src/redact');

const TOKEN = 'test-token';
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM source_redactions;
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM sqlite_sequence;
    UPDATE draft_meta SET revision = 0;
  `);
});

async function call(method, url, { token = TOKEN, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Editor-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function makeEvent(title) {
  const r = await call('POST', '/api/editor/events', { body: { title } });
  assert.strictEqual(r.status, 201);
  return r.json.event.id;
}

async function makeClaim(eventId, payload) {
  const r = await call('POST', `/api/editor/events/${eventId}/claims`, { body: payload });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.claim.id;
}

async function makeRel(earlierId, laterId, source = '') {
  const r = await call('POST', '/api/editor/relations', { body: { earlierId, laterId, source } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.relation.id;
}

async function publish(selection, baseVersionNo) {
  const r = await call('POST', '/api/editor/publish', { body: { selection, baseVersionNo } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

const SRC = '李宝山口述，2021-07-05 访谈';
const SRC2 = '《县水利志》1994 年版，第 87 页';

// 发两版：v1 两个事件 + 一条带 SRC 的先于关系；v2 再加一个事件
async function setupTwoVersions() {
  const e1 = await makeEvent('动员会');
  const e2 = await makeEvent('通水会');
  const c1 = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: SRC });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: SRC2 });
  await makeRel(e1, e2, SRC);
  await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], 0);

  const e3 = await makeEvent('抽水机到站');
  const c3 = await makeClaim(e3, { precision: 'year', year: 1962, source: SRC }); // 同一出处
  await publish(
    [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }, { eventId: e3, claimId: c3 }],
    1
  );
  return { e1, e2, e3, c1, c2, c3 };
}

test('遮盖接口需要编辑口令；公开接口无需口令', async () => {
  const r1 = await call('POST', '/api/editor/redaction-preview', { token: null, body: { source: 'x' } });
  assert.strictEqual(r1.status, 401);
  const r2 = await call('POST', '/api/editor/redaction', { token: null, body: { source: 'x', currentVersionNo: 0 } });
  assert.strictEqual(r2.status, 401);
});

test('预览：列全全部已发布版本中事件主张与先于关系的命中位置与数量，只读不落库', async () => {
  await setupTwoVersions();
  const r = await call('POST', '/api/editor/redaction-preview', { body: { source: `  ${SRC}  ` } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const p = r.json;
  assert.strictEqual(p.source, SRC); // 返回 trim 后的精确文本
  assert.strictEqual(p.alreadyRedacted, false);
  assert.strictEqual(p.currentVersionNo, 2);
  assert.strictEqual(p.versionCount, 2);
  assert.strictEqual(p.totalEventHitCount, 3); // v1 动员会 1 + v2 动员会、抽水机 2
  assert.strictEqual(p.totalRelationHitCount, 2); // 关系复制进每个版本快照：v1、v2 各 1
  assert.strictEqual(p.totalHitCount, 5);

  const v1 = p.versions.find((v) => v.versionNo === 1);
  assert.strictEqual(v1.eventHitCount, 1);
  assert.strictEqual(v1.eventHits[0].title, '动员会');
  assert.strictEqual(v1.relationHitCount, 1);
  assert.deepStrictEqual(Object.keys(v1.relationHits[0]).sort(),
    ['earlierEventId', 'laterEventId', 'relationId', 'sortOrder'].sort());
  const v2 = p.versions.find((v) => v.versionNo === 2);
  assert.strictEqual(v2.eventHitCount, 2); // 动员会（沿自 v1）与抽水机
  assert.strictEqual(v2.relationHitCount, 1); // 关系在 v2 快照中同样存在
  assert.strictEqual(v2.eventHits.some((h) => h.title === '抽水机到站'), true);

  // 预览只读：尚未遮盖
  const pub = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pub.json.version.events.find((e) => e.title === '抽水机到站').source, SRC);
  assert.strictEqual(pub.json.version.relations[0].source, SRC);

  // 未命中文本合计为 0
  const none = await call('POST', '/api/editor/redaction-preview', { body: { source: '不存在的出处' } });
  assert.strictEqual(none.json.totalHitCount, 0);
});

test('空 / 纯空白 / 非字符串文本拒绝（400）', async () => {
  for (const source of ['', '   ', '\t\n']) {
    const r = await call('POST', '/api/editor/redaction-preview', { body: { source } });
    assert.strictEqual(r.status, 400, JSON.stringify(source));
  }
  const r1 = await call('POST', '/api/editor/redaction-preview', { body: { source: 123 } });
  assert.strictEqual(r1.status, 400);
  const missing = await call('POST', '/api/editor/redaction-preview', { body: {} });
  assert.strictEqual(missing.status, 400);
});

test('空文本确认同样 400；currentVersionNo 非法 400', async () => {
  const r1 = await call('POST', '/api/editor/redaction', { body: { source: '   ', currentVersionNo: 0 } });
  assert.strictEqual(r1.status, 400);
  const r2 = await call('POST', '/api/editor/redaction', { body: { source: 123, currentVersionNo: 0 } });
  assert.strictEqual(r2.status, 400);
  const r3 = await call('POST', '/api/editor/redaction', { body: { source: 'x' } });
  assert.strictEqual(r3.status, 400);
});

test('确认后访客读最新年表与历史版本：命中处显示「出处已遮盖」，其余字段与版本号不变', async () => {
  const ids = await setupTwoVersions();
  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  const confirm = await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: preview.json.currentVersionNo, editor: '志愿者小王' },
  });
  assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.json));
  assert.strictEqual(confirm.json.alreadyRedacted, false);
  assert.strictEqual(confirm.json.redactedLabel, REDACTED_SOURCE);
  assert.strictEqual(confirm.json.totalHitCount, 5);

  // 最新年表（v2）
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.currentVersionNo, 2);
  const v2 = latest.json.version;
  for (const ev of v2.events) {
    if (ev.title === '动员会' || ev.title === '抽水机到站') {
      assert.strictEqual(ev.source, REDACTED_SOURCE);
    } else {
      assert.strictEqual(ev.source, SRC2); // 未命中不变
    }
    // 其余字段不变
    assert.ok(ev.dateLabel && ev.resolvedDate && ev.intervalStart);
  }
  assert.strictEqual(v2.relations[0].source, REDACTED_SOURCE);

  // 指定历史版本 v1
  const old = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(old.status, 200);
  assert.strictEqual(old.json.version.versionNo, 1);
  assert.strictEqual(old.json.version.events[0].source, REDACTED_SOURCE);
  assert.strictEqual(old.json.version.relations[0].source, REDACTED_SOURCE);

  // 快照行在库里未被改写（原文仍在）
  const rawRow = mem.prepare('SELECT source FROM version_events WHERE event_id = ? ORDER BY sort_order').get(ids.e1);
  assert.strictEqual(rawRow.source, SRC);
});

test('持编辑口令查看版本原文仍是原文；草稿状态与恢复预览/恢复草稿均用原文', async () => {
  await setupTwoVersions();
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 2 } });

  const raw = await call('GET', '/api/editor/versions/1/raw');
  assert.strictEqual(raw.status, 200);
  assert.strictEqual(raw.json.version.events[0].source, SRC);
  assert.strictEqual(raw.json.version.relations[0].source, SRC);

  // 草稿状态：原文
  const state = await call('GET', '/api/editor/state');
  assert.ok(state.json.events.some((e) => e.claims.some((c) => c.source === SRC)));
  assert.ok(state.json.relations.some((r) => r.source === SRC));

  // 恢复预览：版本部分为原文
  const rp = await call('GET', '/api/editor/restore-preview/1');
  assert.strictEqual(rp.json.version.events[0].source, SRC);
  assert.strictEqual(rp.json.version.relations[0].source, SRC);

  // 确认恢复：重建的草稿仍是原文
  const restored = await call('POST', '/api/editor/restore', {
    body: {
      versionNo: 1,
      draftRevisionNo: rp.json.draftRevisionNo,
      currentVersionNo: rp.json.currentVersionNo,
    },
  });
  assert.strictEqual(restored.status, 200, JSON.stringify(restored.json));
  const state2 = await call('GET', '/api/editor/state');
  assert.ok(state2.json.events.every((e) => e.claims.length === 1));
  assert.strictEqual(state2.json.events[0].claims[0].source, SRC);
  assert.strictEqual(state2.json.relations[0].source, SRC);
});

test('以后发布含同一文本的新版本自动遮盖；快照本身仍存原文', async () => {
  const ids = await setupTwoVersions();
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 2 } });

  // 草稿里再补一个带 SRC 的主张并发布 v3
  const e4 = await makeEvent('新发现事件');
  const c4 = await makeClaim(e4, { precision: 'year', year: 1963, source: SRC });
  const pub = await publish(
    [
      { eventId: ids.e1, claimId: ids.c1 },
      { eventId: ids.e2, claimId: ids.c2 },
      { eventId: ids.e3, claimId: ids.c3 },
      { eventId: e4, claimId: c4 },
    ],
    2
  );
  assert.strictEqual(pub.versionNo, 3);

  // 发布返回（编辑者视角）是原文
  assert.strictEqual(pub.version.events.find((e) => e.title === '新发现事件').source, SRC);
  // 访客视图自动遮盖
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.currentVersionNo, 3);
  assert.strictEqual(latest.json.version.events.find((e) => e.title === '新发现事件').source, REDACTED_SOURCE);

  // 快照库存原文
  const row = mem.prepare('SELECT source FROM version_events WHERE event_id = ?').get(e4);
  assert.strictEqual(row.source, SRC);
});

test('预览后发布了新版本，确认报 409 VERSION_CONFLICT 且不落库', async () => {
  const ids = await setupTwoVersions(); // 最新 = 2
  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(preview.json.currentVersionNo, 2);

  // 期间发布 v3（把现有选择重发一版）
  await publish(
    [{ eventId: ids.e1, claimId: ids.c1 }, { eventId: ids.e2, claimId: ids.c2 }, { eventId: ids.e3, claimId: ids.c3 }],
    2
  );

  const stale = await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: 2 },
  });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.json.code, 'VERSION_CONFLICT');
  assert.strictEqual(stale.json.currentVersionNo, 3);

  // 未登记：访客仍见原文
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events.find((e) => e.title === '动员会').source, SRC);

  // 重新预览后确认成功
  const preview2 = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  const ok = await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: preview2.json.currentVersionNo },
  });
  assert.strictEqual(ok.status, 200);
  const latest2 = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest2.json.version.events.find((e) => e.title === '动员会').source, REDACTED_SOURCE);
});

test('重复确认幂等：返回已遮盖状态，不重复登记', async () => {
  await setupTwoVersions();
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 2 } });

  // 即便携的是过期版本号，重复确认也返回已遮盖状态（幂等优先于冲突）
  const again = await call('POST', '/api/editor/redaction', {
    body: { source: ` ${SRC} `, currentVersionNo: 1 },
  });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.alreadyRedacted, true);
  assert.strictEqual(again.json.totalHitCount, 5);

  const n = mem.prepare('SELECT COUNT(*) AS n FROM source_redactions WHERE source_text = ?').get(SRC).n;
  assert.strictEqual(n, 1);

  // 清单接口（编辑者，含原文）
  const list = await call('GET', '/api/editor/redactions');
  assert.strictEqual(list.json.redactions.length, 1);
  assert.strictEqual(list.json.redactions[0].source, SRC);
  assert.strictEqual(list.json.redactions[0].editor, '');
});

test('遮盖不推进草稿修订号（不触碰草稿区）', async () => {
  await setupTwoVersions();
  const before = (await call('GET', '/api/editor/state')).json.draftRevisionNo;
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 2 } });
  const after = (await call('GET', '/api/editor/state')).json.draftRevisionNo;
  assert.strictEqual(before, after);
});

test('尚无发布版本也可预览（命中 0）并确认登记；之后发布即自动遮盖', async () => {
  const e1 = await makeEvent('草稿事件');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: SRC });
  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(preview.json.versionCount, 0);
  assert.strictEqual(preview.json.totalHitCount, 0);
  assert.strictEqual(preview.json.draft.claimHitCount, 1); // 草稿命中仅供参考

  const confirm = await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: 0 },
  });
  assert.strictEqual(confirm.status, 200);
  assert.strictEqual(confirm.json.currentVersionNo, 0);

  await publish([{ eventId: e1, claimId: c1 }], 0);
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events[0].source, REDACTED_SOURCE);
});

test('精确匹配：部分包含 / 前后多字的出处不被遮盖', async () => {
  const e1 = await makeEvent('事件');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: `${SRC}；另见档案第 3 页` });
  await publish([{ eventId: e1, claimId: c1 }], 0);
  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(preview.json.totalEventHitCount, 0);
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 1 } });
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events[0].source, `${SRC}；另见档案第 3 页`);
});
