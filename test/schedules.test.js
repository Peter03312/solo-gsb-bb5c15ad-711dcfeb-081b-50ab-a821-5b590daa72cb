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
const { runDueSchedules, listSchedules } = require('../src/schedules');

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
    DELETE FROM schedule_relations;
    DELETE FROM schedule_events;
    DELETE FROM scheduled_publishes;
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM sqlite_sequence;
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

async function publish(selection, baseVersionNo, extra = {}) {
  const r = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo, ...extra },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

// 未来时刻的 ISO（默认 1 小时后）
function futureIso(secondsAhead = 3600) {
  return new Date(Date.now() + secondsAhead * 1000).toISOString();
}

async function makeTwoEventDraft() {
  const e1 = await makeEvent('动员会');
  const e2 = await makeEvent('通水会');
  const c1 = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述' });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: '王秀兰口述' });
  await makeRel(e1, e2, '二人口述一致');
  return { e1, e2, c1, c2, selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }] };
}

// ---------- 创建预约：参数校验 ----------

test('预约接口需要编辑口令', async () => {
  const r = await call('GET', '/api/editor/schedules', { token: null });
  assert.strictEqual(r.status, 401);
});

test('预约时间非法 / 只给日期 / 已过期 → 400，不建立预约', async () => {
  const { e1, c1 } = await makeTwoEventDraft();
  const selection = [{ eventId: e1, claimId: c1 }];

  for (const bad of ['not-a-time', '2026-10-05', '2026-13-40T99:00:00Z', '']) {
    const r = await call('POST', '/api/editor/schedules', { body: { selection, scheduledAt: bad } });
    assert.strictEqual(r.status, 400, `${bad} 应 400，实际：${JSON.stringify(r.json)}`);
  }
  const past = new Date(Date.now() - 1000).toISOString();
  const r2 = await call('POST', '/api/editor/schedules', { body: { selection, scheduledAt: past } });
  assert.strictEqual(r2.status, 400);
  // 不允许提交 baseVersionNo（基准由服务器冻结）
  const r3 = await call('POST', '/api/editor/schedules', {
    body: { selection, scheduledAt: futureIso(), baseVersionNo: 0 },
  });
  assert.strictEqual(r3.status, 400);
  assert.strictEqual(listSchedules().length, 0);
});

test('草稿未通过发布校验（成环 / 无解 / 缺主张）→ 422，不建立预约', async () => {
  const a = await makeEvent('A');
  const b = await makeEvent('B');
  const ca = await makeClaim(a, { precision: 'year', year: 1958, source: 's' });
  const cb = await makeClaim(b, { precision: 'year', year: 1958, source: 's' });
  await makeRel(a, b);
  await makeRel(b, a); // 成环

  const r = await call('POST', '/api/editor/schedules', {
    body: { selection: [{ eventId: a, claimId: ca }, { eventId: b, claimId: cb }], scheduledAt: futureIso() },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.errors[0].type, 'cycle');
  assert.strictEqual(listSchedules().length, 0);

  // 时间无解（清掉前面的成环关系，只留冬月→春月；A/B 仍须一并选定）
  mem.exec('DELETE FROM relations;');
  const e1 = await makeEvent('冬月会议');
  const e2 = await makeEvent('春月会议');
  const c1 = await makeClaim(e1, { precision: 'month', year: 1958, month: 12, source: 's1' });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1958, month: 1, source: 's2' });
  await makeRel(e1, e2);
  const r2 = await call('POST', '/api/editor/schedules', {
    body: {
      selection: [
        { eventId: a, claimId: ca },
        { eventId: b, claimId: cb },
        { eventId: e1, claimId: c1 },
        { eventId: e2, claimId: c2 },
      ],
      scheduledAt: futureIso(),
    },
  });
  assert.strictEqual(r2.status, 422);
  assert.ok(r2.json.errors.some((e) => e.type === 'temporal'), JSON.stringify(r2.json.errors));
});

test('创建成功：冻结事件 / 主张 / 关系 / 求解日期 / 当前最新版本号；预约号递增', async () => {
  const d = await makeTwoEventDraft();
  const v1 = await publish(d.selection, 0);
  assert.strictEqual(v1.versionNo, 1);

  const at = futureIso(3600);
  const r = await call('POST', '/api/editor/schedules', {
    body: { selection: d.selection, scheduledAt: at, editor: '预约员', note: '按时公开' },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const s = r.json.schedule;
  assert.strictEqual(s.scheduleNo, 1);
  assert.strictEqual(s.status, 'pending');
  assert.strictEqual(s.baseVersionNo, 1); // 冻结当前最新版本号
  assert.strictEqual(s.scheduledAt, new Date(at).toISOString());
  assert.strictEqual(s.editor, '预约员');
  assert.strictEqual(s.events.length, 2);
  assert.strictEqual(s.events[0].resolvedDate, '1958-09-12');
  assert.strictEqual(s.events[1].resolvedDate, '1959-05-01');
  assert.strictEqual(s.relations[0].source, '二人口述一致');
  assert.strictEqual(s.resultVersionNo, null);

  // state 中暴露待执行预约数
  const st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.pendingScheduleCount, 1);

  // +08:00 偏移也能解析并归一化为 UTC
  const r2 = await call('POST', '/api/editor/schedules', {
    body: { selection: d.selection, scheduledAt: '2999-01-02T16:00:00+08:00' },
  });
  assert.strictEqual(r2.status, 201, JSON.stringify(r2.json));
  assert.strictEqual(r2.json.schedule.scheduledAt, '2999-01-02T08:00:00.000Z');
  assert.strictEqual(r2.json.schedule.scheduleNo, 2);
});

test('到期前访客只见旧版；草稿后续修改 / 恢复不改变预约冻结内容', async () => {
  const d = await makeTwoEventDraft();
  await publish(d.selection, 0, { note: '旧版' });

  await call('POST', '/api/editor/schedules', {
    body: { selection: d.selection, scheduledAt: futureIso(120), editor: '预约员' },
  });

  // 大幅修改草稿：改标题、删主张
  await call('PUT', `/api/editor/events/${d.e1}`, { body: { title: '改了的标题', description: '' } });
  await call('DELETE', `/api/editor/claims/${d.c1}`);

  // 访客仍只见旧版
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);

  // 预约冻结内容不变
  const list = await call('GET', '/api/editor/schedules');
  assert.strictEqual(list.json.schedules.length, 1);
  const s = [...list.json.schedules].find((x) => x.scheduleNo === 1);
  const ev0 = s.events.find((e) => e.eventId === d.e1);
  assert.strictEqual(ev0.title, '动员会');
  assert.strictEqual(ev0.claimId, d.c1);
  assert.strictEqual(ev0.resolvedDate, '1958-09-12');
  assert.strictEqual(s.events.length, 2);
});

// ---------- 到期执行 ----------

test('到期按预约生成不可变新版本（即使草稿已删空）；重复触发 / 重启不重复发布', async () => {
  const d = await makeTwoEventDraft();
  await publish(d.selection, 0);
  const at = futureIso(60);
  const created = await call('POST', '/api/editor/schedules', {
    body: { selection: d.selection, scheduledAt: at, editor: '预约员', note: '预约说明' },
  });
  const scheduleId = created.json.schedule.id;

  // 草稿全部删掉，证明发布只依赖冻结内容
  mem.exec('DELETE FROM relations; DELETE FROM claims; DELETE FROM events;');

  // 未到期：不执行
  let outcomes = runDueSchedules(Date.now());
  assert.strictEqual(outcomes.length, 0);
  assert.strictEqual((await call('GET', '/api/public/chronicle', { token: null })).json.currentVersionNo, 1);

  // 到期：执行
  outcomes = runDueSchedules(new Date(at).getTime());
  assert.strictEqual(outcomes.length, 1);
  assert.strictEqual(outcomes[0].outcome, 'published');
  assert.strictEqual(outcomes[0].versionNo, 2);

  // 再次触发（模拟重启 / 重复 tick）：无新增发布
  const again = runDueSchedules(new Date(at).getTime() + 10000);
  assert.strictEqual(again.length, 0);

  // 新版本公开且内容为冻结快照
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 2);
  assert.strictEqual(view.json.version.parentNo, 1);
  assert.strictEqual(view.json.version.editor, '预约员');
  assert.strictEqual(view.json.version.note, '预约说明');
  assert.deepStrictEqual(
    view.json.version.events.map((e) => [e.title, e.resolvedDate, e.source]),
    [['动员会', '1958-09-12', '李宝山口述'], ['通水会', '1959-05-01', '王秀兰口述']]
  );
  assert.strictEqual(view.json.version.relations[0].source, '二人口述一致');
  // 旧版仍在
  const v1 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v1.status, 200);

  const detail = await call('GET', `/api/editor/schedules/${scheduleId}`);
  assert.strictEqual(detail.json.schedule.status, 'published');
  assert.strictEqual(detail.json.schedule.resultVersionNo, 2);
  assert.ok(detail.json.schedule.executedAt);
});

test('期间出现新版本 → 到期标冲突、保留内容、不发布也不自动改基准', async () => {
  const d = await makeTwoEventDraft();
  await publish(d.selection, 0);

  const at = futureIso(90);
  const created = await call('POST', '/api/editor/schedules', {
    body: { selection: d.selection, scheduledAt: at },
  });
  const sid = created.json.schedule.id;

  // 到期前即时发布了第 2 版
  await publish(d.selection, 1, { note: '别人抢先发布', editor: '编辑乙' });
  const before = (await call('GET', '/api/public/versions', { token: null })).json.versions.length;
  assert.strictEqual(before, 2);

  const outcomes = runDueSchedules(new Date(at).getTime());
  assert.strictEqual(outcomes[0].outcome, 'conflict');
  assert.strictEqual(outcomes[0].baseVersionNo, 1);
  assert.strictEqual(outcomes[0].currentVersionNo, 2);

  // 未产生新版本
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 2);
  assert.strictEqual(view.json.version.note, '别人抢先发布');

  // 预约保留冻结内容供查看
  const detail = await call('GET', `/api/editor/schedules/${sid}`);
  assert.strictEqual(detail.json.schedule.status, 'conflict');
  assert.strictEqual(detail.json.schedule.baseVersionNo, 1);
  assert.strictEqual(detail.json.schedule.conflictVersionNo, 2);
  assert.strictEqual(detail.json.schedule.events.length, 2);
  // 冲突后重复触发不再动作
  assert.strictEqual(runDueSchedules(new Date(at).getTime() + 9999).length, 0);
});

test('多条预约同一到期时刻：按预约号顺序，首条生效、基于同一基准的后续标冲突', async () => {
  const d = await makeTwoEventDraft();
  await publish(d.selection, 0);

  const at = futureIso(120);
  const s1 = await call('POST', '/api/editor/schedules', {
    body: { selection: d.selection, scheduledAt: at, note: '第一号' },
  });
  const s2 = await call('POST', '/api/editor/schedules', {
    body: { selection: d.selection, scheduledAt: at, note: '第二号' },
  });
  assert.strictEqual(s1.json.schedule.scheduleNo, 1);
  assert.strictEqual(s2.json.schedule.scheduleNo, 2);

  const outcomes = runDueSchedules(new Date(at).getTime());
  assert.deepStrictEqual(outcomes.map((o) => [o.scheduleNo, o.outcome]), [[1, 'published'], [2, 'conflict']]);
  assert.strictEqual((await call('GET', '/api/public/chronicle', { token: null })).json.currentVersionNo, 2);
});

test('不同到期时刻：更早到期（后创建）的先发布，较晚的预约变冲突', async () => {
  const d = await makeTwoEventDraft();
  await publish(d.selection, 0);

  const late = futureIso(300);
  const early = futureIso(100);
  const a = await call('POST', '/api/editor/schedules', { body: { selection: d.selection, scheduledAt: late, note: '晚' } });
  const b = await call('POST', '/api/editor/schedules', { body: { selection: d.selection, scheduledAt: early, note: '早' } });

  // 只让早的到期
  let outcomes = runDueSchedules(new Date(early).getTime());
  assert.deepStrictEqual(outcomes.map((o) => o.scheduleNo), [b.json.schedule.scheduleNo]);
  assert.strictEqual(outcomes[0].outcome, 'published');

  // 晚的再到期 → 基准 0 已落后于 2 → 冲突
  outcomes = runDueSchedules(new Date(late).getTime());
  assert.strictEqual(outcomes[0].scheduleNo, a.json.schedule.scheduleNo);
  assert.strictEqual(outcomes[0].outcome, 'conflict');
});

// ---------- 取消 ----------

test('取消尚未执行的预约；已生效 / 冲突 / 不存在的处理', async () => {
  const d = await makeTwoEventDraft();
  await publish(d.selection, 0);
  const at = futureIso(120);
  const created = await call('POST', '/api/editor/schedules', {
    body: { selection: d.selection, scheduledAt: at },
  });
  const sid = created.json.schedule.id;

  const cancel = await call('DELETE', `/api/editor/schedules/${sid}`);
  assert.strictEqual(cancel.status, 200);
  assert.strictEqual(cancel.json.schedule.status, 'cancelled');

  // 到期不再执行
  assert.strictEqual(runDueSchedules(new Date(at).getTime()).length, 0);
  assert.strictEqual((await call('GET', '/api/public/chronicle', { token: null })).json.currentVersionNo, 1);

  // 已取消不能再取消
  const again = await call('DELETE', `/api/editor/schedules/${sid}`);
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.json.code, 'SCHEDULE_NOT_PENDING');

  // 不存在 → 404
  const missing = await call('DELETE', '/api/editor/schedules/9999');
  assert.strictEqual(missing.status, 404);
  const getMissing = await call('GET', '/api/editor/schedules/9999');
  assert.strictEqual(getMissing.status, 404);
});

test('已生效预约不能取消（409 SCHEDULE_NOT_PENDING）', async () => {
  const d = await makeTwoEventDraft();
  await publish(d.selection, 0);
  const at = futureIso(60);
  const created = await call('POST', '/api/editor/schedules', {
    body: { selection: d.selection, scheduledAt: at },
  });
  const sid = created.json.schedule.id;
  runDueSchedules(new Date(at).getTime());

  const r = await call('DELETE', `/api/editor/schedules/${sid}`);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'SCHEDULE_NOT_PENDING');
  assert.strictEqual(r.json.scheduleStatus, 'published');
});

// ---------- 与既有功能兼容 ----------

test('尚无任何版本（基准 0）时也可预约；到期前若已发布首版则预约冲突', async () => {
  const d = await makeTwoEventDraft();
  const at = futureIso(90);
  const created = await call('POST', '/api/editor/schedules', {
    body: { selection: d.selection, scheduledAt: at },
  });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.json.schedule.baseVersionNo, 0);

  // 别人在到期前发布了首版
  await publish(d.selection, 0);
  const outcomes = runDueSchedules(new Date(at).getTime());
  assert.strictEqual(outcomes[0].outcome, 'conflict');
  assert.strictEqual(outcomes[0].baseVersionNo, 0);
  assert.strictEqual(outcomes[0].currentVersionNo, 1);
});

test('预约到期产生的新版本，公开读取继续应用出处遮盖', async () => {
  const d = await makeTwoEventDraft();
  await publish(d.selection, 0);

  // 到期前先登记遮盖预约版本中将出现的出处（草稿中仍有该原文，故可先登记）
  const reg = await call('POST', '/api/editor/redaction', {
    body: { source: '李宝山口述', currentVersionNo: 1, editor: '遮盖员' },
  });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));

  const at = futureIso(60);
  await call('POST', '/api/editor/schedules', { body: { selection: d.selection, scheduledAt: at } });
  runDueSchedules(new Date(at).getTime());

  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 2);
  const mobilization = view.json.version.events.find((e) => e.title === '动员会');
  assert.strictEqual(mobilization.source, '出处已遮盖');
  // 持编辑口令的快照原文仍是原文
  const raw = await call('GET', '/api/editor/versions/2/raw');
  assert.strictEqual(raw.json.version.events[0].source, '李宝山口述');
  // 即时发布与历史版本接口保持兼容
  const list = await call('GET', '/api/public/versions', { token: null });
  assert.strictEqual(list.json.versions.length, 2);
});
