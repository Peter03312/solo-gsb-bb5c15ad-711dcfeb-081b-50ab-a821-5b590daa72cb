'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { solve } = require('../src/solver');
const { ordinalFromIso, isoFromOrdinal } = require('../src/dates');

function events(...titles) {
  return titles.map((title, i) => ({ id: i + 1, title }));
}
function sel(claimId, start, end) {
  return {
    claimId,
    startOrd: ordinalFromIso(start),
    endOrd: ordinalFromIso(end),
    source: '',
    label: `${start}~${end}`,
  };
}
function selectedMap(arr) {
  const m = new Map();
  arr.forEach((s, i) => m.set(i + 1, s));
  return m;
}

test('日精度严格先后：同日无解，次日可行', () => {
  const evs = events('A', 'B');
  const rels = [{ id: 1, earlierId: 1, laterId: 2 }];

  let r = solve(evs, selectedMap([sel(1, '1958-03-01', '1958-03-01'), sel(2, '1958-03-01', '1958-03-01')]), rels);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'temporal');
  assert.deepStrictEqual(r.errors[0].eventIds, [1, 2]);
  assert.deepStrictEqual(r.errors[0].relationIds, [1]);

  r = solve(evs, selectedMap([sel(1, '1958-03-01', '1958-03-01'), sel(2, '1958-03-02', '1958-03-02')]), rels);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(isoFromOrdinal(r.dates.get(1)), '1958-03-01');
  assert.strictEqual(isoFromOrdinal(r.dates.get(2)), '1958-03-02');
});

test('粗粒度跨区间传播：12月 → 次年1月 可行，→ 同年1月 无解', () => {
  const evs = events('动员会', '通水');
  const rels = [{ id: 1, earlierId: 1, laterId: 2 }];

  const ok = solve(
    evs,
    selectedMap([sel(10, '1958-12-01', '1958-12-31'), sel(20, '1959-01-01', '1959-01-31')]),
    rels
  );
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(isoFromOrdinal(ok.dates.get(2)), '1959-01-01');

  const bad = solve(
    evs,
    selectedMap([sel(10, '1958-12-01', '1958-12-31'), sel(20, '1958-01-01', '1958-01-31')]),
    rels
  );
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.errors[0].type, 'temporal');
});

test('长链传播把后期事件推出区间', () => {
  const evs = events('A', 'B', 'C');
  const rels = [
    { id: 1, earlierId: 1, laterId: 2 },
    { id: 2, earlierId: 2, laterId: 3 },
  ];
  const r = solve(
    evs,
    selectedMap([
      sel(1, '1958-01-01', '1958-12-31'),
      sel(2, '1958-01-01', '1958-12-31'),
      sel(3, '1958-01-05', '1958-01-10'), // 最早被迫到 1958-01-03，仍可行
    ]),
    rels
  );
  assert.strictEqual(r.ok, true);

  const r2 = solve(
    evs,
    selectedMap([
      sel(1, '1958-12-01', '1958-12-31'),
      sel(2, '1958-12-01', '1958-12-31'),
      sel(3, '1958-01-01', '1958-01-10'),
    ]),
    rels
  );
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.errors[0].type, 'temporal');
  assert.deepStrictEqual(r2.errors[0].eventIds, [1, 2, 3]);
  assert.deepStrictEqual(r2.errors[0].relationIds, [1, 2]);
});

test('关系成环：报 cycle 且列出涉事事件与关系', () => {
  const evs = events('A', 'B', 'C');
  const rels = [
    { id: 1, earlierId: 1, laterId: 2 },
    { id: 2, earlierId: 2, laterId: 3 },
    { id: 3, earlierId: 3, laterId: 1 },
  ];
  const r = solve(
    evs,
    selectedMap([
      sel(1, '1958-01-01', '1958-12-31'),
      sel(2, '1958-01-01', '1958-12-31'),
      sel(3, '1958-01-01', '1958-12-31'),
    ]),
    rels
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'cycle');
  assert.deepStrictEqual(new Set(r.errors[0].eventIds), new Set([1, 2, 3]));
  assert.deepStrictEqual(new Set(r.errors[0].relationIds), new Set([1, 2, 3]));
});

test('自环也是环', () => {
  const evs = events('A');
  const r = solve(evs, selectedMap([sel(1, '1958-01-01', '1958-12-31')]), [
    { id: 9, earlierId: 1, laterId: 1 },
  ]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'cycle');
});

test('缺少被选主张报 missing 并指出事件', () => {
  const evs = events('A', 'B');
  const r = solve(evs, new Map([[1, sel(1, '1958-01-01', '1958-01-01')]]), []);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'missing');
  assert.deepStrictEqual(r.errors[0].eventIds, [2]);
});

test('无边时各事件取区间起点', () => {
  const evs = events('A', 'B');
  const r = solve(
    evs,
    selectedMap([sel(1, '1962-01-01', '1962-12-31'), sel(2, '1962-10-01', '1962-10-31')]),
    []
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(isoFromOrdinal(r.dates.get(1)), '1962-01-01');
  assert.strictEqual(isoFromOrdinal(r.dates.get(2)), '1962-10-01');
});
