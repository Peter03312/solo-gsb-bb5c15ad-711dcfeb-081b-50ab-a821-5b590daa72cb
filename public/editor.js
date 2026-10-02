'use strict';

// 编辑台：草稿 CRUD + 逐事件选定主张 + 发布乐观并发控制
const $ = (sel) => document.querySelector(sel);

const PREC_LABEL = { year: '精确到年', month: '精确到月', day: '精确到日' };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const store = {
  get token() { return localStorage.getItem('editorToken') || ''; },
  set token(v) { localStorage.setItem('editorToken', v); },
  get editor() { return localStorage.getItem('editorName') || ''; },
  set editor(v) { localStorage.setItem('editorName', v); },
  get selections() {
    try { return JSON.parse(localStorage.getItem('selections') || '{}'); }
    catch { return {}; }
  },
  setSelection(eventId, claimId) {
    const m = this.selections;
    m[eventId] = claimId;
    localStorage.setItem('selections', JSON.stringify(m));
  },
  clearSelections() { localStorage.removeItem('selections'); },
};

let state = { events: [], relations: [], currentVersionNo: 0, draftRevisionNo: 0 };
let baseVersionNo = 0; // 发起修改时所基于的版本号
let conflictData = null;
let restorePreview = null; // 恢复草稿预览（确认时提交其中的修订号/最新版本号）
let bundleParsed = null;   // 解析后的整理包原包（确认时原样提交）
let bundlePreview = null;  // 导入预览（确认时提交其中的指纹/草稿修订号）
let redactPreview = null;  // 出处遮盖预览（确认时提交其中的最新版本号）
let scheduleDetail = null; // 当前打开的预约详情

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Editor-Token': store.token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 无响应体 */ }
  if (res.status === 401) {
    showGlobal('warn', data?.message || '请先在右上角输入正确的编辑者口令。');
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const err = new Error(data?.message || `请求失败（${res.status}）`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function showGlobal(kind, html) {
  $('#globalMsg').innerHTML = `<div class="alert ${kind}">${html}</div>`;
}

function showPublishResult(kind, html) {
  $('#publishResult').innerHTML = `<div class="alert ${kind}">${html}</div>`;
}

// ---------- 渲染 ----------
function render() {
  $('#versionTag').textContent =
    state.currentVersionNo === 0 ? '尚无已发布版本（草稿未公开）' : `当前已发布：第 ${state.currentVersionNo} 版`;

  const sel = store.selections;
  $('#eventList').innerHTML = state.events.map((ev) => {
    const claims = ev.claims.map((c) => {
      const checked = sel[ev.id] === c.id ? 'checked' : '';
      return `
        <div class="claim ${checked ? 'selected' : ''}" data-claim="${c.id}">
          <div class="row">
            <div style="flex:0 0 auto;padding-top:2px">
              <input type="radio" name="sel-${ev.id}" data-select-claim="${c.id}" ${checked} style="width:auto" />
            </div>
            <div style="flex:1">
              <strong>${esc(c.dateLabel)}</strong>
              <span class="badge prec">${PREC_LABEL[c.precision]}</span>
              <span class="badge">区间 ${c.intervalStart} ~ ${c.intervalEnd}</span>
              <div class="source"><b>出处：</b>${esc(c.source || '（未注明）')}</div>
              ${c.note ? `<div class="muted">${esc(c.note)}</div>` : ''}
            </div>
            <div style="flex:0 0 auto">
              <button class="danger" data-del-claim="${c.id}" type="button">删除主张</button>
            </div>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="card event-card" id="event-card-${ev.id}" data-event="${ev.id}">
        <div class="row">
          <div class="field">
            <label>事件标题</label>
            <input type="text" value="${esc(ev.title)}" data-edit-title="${ev.id}" />
          </div>
          <div style="flex:0 0 auto">
            <button class="secondary" data-save-event="${ev.id}" type="button">保存</button>
            <button class="danger" data-del-event="${ev.id}" type="button">删除事件</button>
          </div>
        </div>
        <label style="margin-top:6px">描述</label>
        <textarea data-edit-desc="${ev.id}">${esc(ev.description)}</textarea>

        <h3 style="margin-top:10px">时间主张${ev.claims.length === 0 ? '（尚无主张，无法发布）' : `（${ev.claims.length} 条，发布时单选）`}</h3>
        ${claims || '<p class="muted">暂无主张</p>'}

        <div class="claim" style="border-style:dashed">
          <h3>新增主张</h3>
          <div class="row">
            <div class="field" style="max-width:130px">
              <label>精度</label>
              <select data-new-precision="${ev.id}">
                <option value="day">精确到日</option>
                <option value="month">精确到月</option>
                <option value="year">精确到年</option>
              </select>
            </div>
            <div class="field" style="max-width:110px"><label>年</label><input type="number" min="1" max="9999" data-new-year="${ev.id}" placeholder="1958" /></div>
            <div class="field js-month" style="max-width:100px"><label>月</label><input type="number" min="1" max="12" data-new-month="${ev.id}" placeholder="3" /></div>
            <div class="field js-day" style="max-width:100px"><label>日</label><input type="number" min="1" max="31" data-new-day="${ev.id}" placeholder="12" /></div>
          </div>
          <label style="margin-top:6px">出处（受访人 / 档案 / 页码）</label>
          <input type="text" data-new-source="${ev.id}" placeholder="如：李宝山口述，2021-07-05 访谈" />
          <label style="margin-top:6px">考异备注（可选，记录矛盾说法）</label>
          <textarea data-new-note="${ev.id}"></textarea>
          <div style="margin-top:8px"><button data-add-claim="${ev.id}" type="button">添加主张</button></div>
        </div>
      </div>`;
  }).join('') || '<p class="muted">草稿中还没有事件。</p>';

  // 精度联动
  document.querySelectorAll('select[data-new-precision]').forEach((selEl) => {
    const card = selEl.closest('.event-card');
    const apply = () => {
      const p = selEl.value;
      card.querySelector('.js-month').style.display = p === 'year' ? 'none' : '';
      card.querySelector('.js-day').style.display = p === 'day' ? '' : 'none';
    };
    selEl.addEventListener('change', apply);
    apply();
  });

  renderRelations();
}

function titleOf(id) {
  const ev = state.events.find((e) => e.id === id);
  return ev ? ev.title : `#${id}`;
}

function renderRelations() {
  const opts = state.events.map((e) => `<option value="${e.id}">${esc(e.title)}</option>`).join('');
  $('#relEarlier').innerHTML = opts;
  $('#relLater').innerHTML = opts;

  $('#relList').innerHTML = state.relations.length
    ? state.relations.map((r) => `
        <div class="rel-line" id="rel-line-${r.id}">
          <strong>${esc(titleOf(r.earlierId))}</strong>
          <span class="badge">先于</span>
          <strong>${esc(titleOf(r.laterId))}</strong>
          <button class="danger" data-del-rel="${r.id}" type="button" style="float:right">删除</button>
          ${r.source ? `<div class="source"><b>出处：</b>${esc(r.source)}</div>` : ''}
          ${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}
        </div>`).join('')
    : '<p class="muted">尚无先后关系。</p>';
}

async function loadState() {
  state = await api('GET', '/api/editor/state');
  baseVersionNo = state.currentVersionNo;
  // 清掉已失效的选择
  const valid = new Map();
  state.events.forEach((e) => e.claims.forEach((c) => valid.set(c.id, e.id)));
  const m = store.selections;
  let changed = false;
  for (const [eid, cid] of Object.entries(m)) {
    if (valid.get(cid) !== Number(eid)) { delete m[eid]; changed = true; }
  }
  if (changed) localStorage.setItem('selections', JSON.stringify(m));
  render();
  loadVersions();
  loadSchedules();
}

async function loadVersions() {
  const data = await api('GET', '/api/editor/versions');
  $('#versionList').innerHTML = data.versions.length
    ? data.versions.map((v) => `
        <div class="rel-line">
          <div class="row" style="align-items:center">
            <strong>第 ${v.versionNo} 版</strong>
            <span class="muted" style="flex:1">${v.publishedAt.replace('T', ' ').slice(0, 16)} UTC · ${esc(v.editor || '匿名')}${v.parentNo ? ` · 基于第 ${v.parentNo} 版` : ''}</span>
            <button class="secondary" type="button" data-restore-version="${v.versionNo}" style="padding:2px 10px;font-size:13px">预览并恢复草稿</button>
          </div>
          ${v.note ? `<div>${esc(v.note)}</div>` : ''}
          <div>
            <button class="linkbtn" type="button" data-raw-version="${v.versionNo}">查看该版快照原文（编辑者，不遮盖）</button>
            · <a href="/api/public/versions/${v.versionNo}" target="_blank">访客视角 JSON（遮盖后）</a>
          </div>
        </div>`).join('')
    : '尚无版本。';
}

// ---------- 发布 ----------
function gatherSelection() {
  const m = store.selections;
  return state.events.map((e) => ({ eventId: e.id, claimId: Number(m[e.id]) }));
}

function clientCheck() {
  const missing = state.events.filter((e) => !store.selections[e.id]);
  if (state.events.length === 0) return '草稿中没有事件，无法发布。';
  if (missing.length) return `还有 ${missing.length} 个事件未选定主张：${missing.map((e) => `「${e.title}」`).join('、')}`;
  return null;
}

async function doValidate() {
  const err = clientCheck();
  if (err) { showPublishResult('error', esc(err)); return; }
  try {
    const data = await api('POST', '/api/editor/validate', { selection: gatherSelection() });
    if (!data.ok) {
      renderSolverErrors(data.errors);
    } else {
      showPublishResult('ok', `
        <b>校验通过，可以发布。</b>系统确定的具体日期：
        <ol style="margin:6px 0">
          ${data.preview.map((p) => `<li>${esc(p.resolvedDate)} — ${esc(p.title)}（主张区间 ${p.intervalStart} ~ ${p.intervalEnd}）</li>`).join('')}
        </ol>`);
    }
  } catch (e) {
    showPublishResult('error', esc(e.message));
  }
}

function renderSolverErrors(errors) {
  const typeName = { missing: '缺少主张', cycle: '关系成环', temporal: '时间无解', bad_selection: '主张选择无效', broken_relation: '关系失效' };
  const items = errors.map((er, i) => {
    const targets = [...new Set(er.eventIds.map((id) => `#event-card-${id}`))].join(',');
    return `<li data-targets="${targets}" title="点击定位事件">
      <b>[${typeName[er.type] || er.type}]</b> ${esc(er.message)}
      ${er.detail ? `<div class="muted">涉事关系：${esc(er.detail)}</div>` : ''}
      ${er.relationIds && er.relationIds.length ? `<div class="muted">涉事关系 id：${er.relationIds.join(', ')}</div>` : ''}
    </li>`;
  }).join('');
  showPublishResult('error', `
    <b>无法发布，上一已发布版本保持不变。</b>
    <ul class="error-list">${items}</ul>`);
  document.querySelectorAll('#publishResult .error-list li').forEach((li) => {
    li.addEventListener('click', () => {
      const targets = (li.dataset.targets || '').split(',').filter(Boolean);
      const first = targets[0] && document.querySelector(targets[0]);
      if (first) {
        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targets.forEach((t) => document.querySelector(t)?.classList.add('has-error', 'highlight-flash'));
        setTimeout(() => targets.forEach((t) => document.querySelector(t)?.classList.remove('highlight-flash')), 1800);
      }
    });
  });
}

async function doPublish() {
  const err = clientCheck();
  if (err) { showPublishResult('error', esc(err)); return; }
  const btn = $('#btnPublish');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/editor/publish', {
      selection: gatherSelection(),
      baseVersionNo,
      editor: store.editor || '匿名编辑',
      note: $('#publishNote').value,
    });
    showPublishResult('ok', `已发布 <b>第 ${data.versionNo} 版</b>（不可变快照）。访客年表已更新。<a href="/" target="_blank">打开访客年表</a>`);
    $('#publishNote').value = '';
    await loadState();
  } catch (e) {
    if (e.status === 422 && e.body?.errors) {
      renderSolverErrors(e.body.errors);
    } else if (e.status === 409) {
      conflictData = e.body;
      showConflictDialog(e.body);
      showPublishResult('error', esc(e.message));
    } else {
      showPublishResult('error', esc(e.message));
    }
  } finally {
    btn.disabled = false;
  }
}

function showConflictDialog(body) {
  const cur = body.currentVersion;
  const list = (evs) => (evs || []).map((e) => `<li>${esc(e.title)}</li>`).join('');
  $('#conflictBody').innerHTML = `
    <p>你发起修改时基于的是<b>第 ${body.baseVersionNo} 版</b>，但另一位编辑者已经在此期间发布了
       <b>第 ${body.currentVersionNo} 版</b>，系统<b>没有</b>覆盖对方的版本。</p>
    ${cur ? `
      <div class="card" style="background:#fff">
        <h3>第 ${cur.versionNo} 版概况</h3>
        <p class="muted">发布于 ${cur.publishedAt.replace('T', ' ').slice(0, 16)} UTC · 编辑者：${esc(cur.editor || '匿名')}${cur.note ? ' · 说明：' + esc(cur.note) : ''}</p>
        <p>事件 ${cur.eventCount} 个，先后关系 ${cur.relationCount} 条。</p>
      </div>` : ''}
    <p class="muted">点击下方按钮后，草稿区将刷新为最新状态，<b>请逐条重新确认每个事件的主张选择</b>，再重新发布；若不重新确认，你的提交不会被接受。</p>`;
  $('#conflictDialog').showModal();
}

// ---------- 从历史版本恢复草稿 ----------
async function openRestorePreview(versionNo) {
  $('#restoreBody').innerHTML = '加载预览中…（只读，不修改草稿）';
  $('#restoreConfirm').disabled = false;
  $('#restoreDialog').showModal();
  restorePreview = null;
  try {
    const data = await api('GET', `/api/editor/restore-preview/${versionNo}`);
    restorePreview = data;
    renderRestorePreview(data);
  } catch (err) {
    if (err.message === 'unauthorized') {
      $('#restoreDialog').close();
      return;
    }
    $('#restoreBody').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
    $('#restoreConfirm').disabled = true;
  }
}

function restoreEventListHtml(events) {
  if (!events.length) return '<p class="muted">（无事件）</p>';
  return events.map((ev) => `
    <div class="rel-line">
      <strong>${esc(ev.title)}</strong>
      <span class="badge prec">${esc(ev.dateLabel)}</span>
      <span class="badge">区间 ${ev.intervalStart} ~ ${ev.intervalEnd}</span>
      <div class="source"><b>出处：</b>${esc(ev.source || '（未注明）')}</div>
      ${ev.claimNote ? `<div class="muted">${esc(ev.claimNote)}</div>` : ''}
      ${ev.description ? `<div class="muted">${esc(ev.description)}</div>` : ''}
    </div>`).join('');
}

function draftEventListHtml(events) {
  if (!events.length) return '<p class="muted">（草稿为空）</p>';
  return events.map((ev) => `
    <div class="rel-line">
      <strong>${esc(ev.title)}</strong>
      <span class="badge">主张 ${ev.claims.length} 条</span>
      ${ev.description ? `<div class="muted">${esc(ev.description)}</div>` : ''}
    </div>`).join('');
}

function restoreRelationListHtml(version) {
  const titleByEvent = new Map(version.events.map((e) => [e.eventId, e.title]));
  if (!version.relations.length) return '<p class="muted">（无先后关系）</p>';
  return version.relations.map((r) => `
    <div class="rel-line">
      <strong>${esc(titleByEvent.get(r.earlierEventId) || '#' + r.earlierEventId)}</strong>
      <span class="badge">先于</span>
      <strong>${esc(titleByEvent.get(r.laterEventId) || '#' + r.laterEventId)}</strong>
      ${r.source ? `<div class="source"><b>出处：</b>${esc(r.source)}</div>` : ''}
    </div>`).join('');
}

function draftRelationListHtml(relations, events) {
  const titleById = new Map(events.map((e) => [e.id, e.title]));
  if (!relations.length) return '<p class="muted">（无先后关系）</p>';
  return relations.map((r) => `
    <div class="rel-line">
      <strong>${esc(titleById.get(r.earlierId) || '#' + r.earlierId)}</strong>
      <span class="badge">先于</span>
      <strong>${esc(titleById.get(r.laterId) || '#' + r.laterId)}</strong>
    </div>`).join('');
}

function renderRestorePreview(data) {
  const v = data.version;
  const d = data.currentDraft;
  $('#restoreBody').innerHTML = `
    <p>将从 <b>第 ${data.versionNo} 版</b>（${v.eventCount} 个事件、${v.relationCount} 条关系）恢复草稿。
       确认后会<b>原子替换整个当前草稿</b>：当前草稿的 ${d.counts.eventCount} 个事件、${d.counts.claimCount} 条主张、
       ${d.counts.relationCount} 条关系将全部移除，按快照重建，且每个事件<b>只恢复该版被选的那一条主张</b>
       （其余未选主张不会回来）。</p>
    <p class="muted">历史快照与访客年表保持不变；恢复仅替换草稿，仍需重新校验、发布才会公开。
       发布时沿用现有口令、校验规则与 baseVersionNo 约定（当前最新仍为第 ${data.currentVersionNo} 版）。</p>
    <div class="grid2">
      <div class="card" style="background:#fff;margin-bottom:0">
        <h3>第 ${data.versionNo} 版将恢复的内容</h3>
        <h3 style="font-size:13px">事件与被选主张</h3>
        ${restoreEventListHtml(v.events)}
        <h3 style="font-size:13px;margin-top:10px">「先于」关系</h3>
        ${restoreRelationListHtml(v)}
      </div>
      <div class="card" style="background:#fff;margin-bottom:0">
        <h3>当前草稿将被替换的内容</h3>
        <h3 style="font-size:13px">事件（全部主张）</h3>
        ${draftEventListHtml(d.events)}
        <h3 style="font-size:13px;margin-top:10px">「先于」关系</h3>
        ${draftRelationListHtml(d.relations, d.events)}
      </div>
    </div>
    <p class="muted" style="margin-top:10px">预览基准：草稿修订号 ${data.draftRevisionNo} · 最新版本号 ${data.currentVersionNo}。
       确认前若草稿或最新版本发生变化，将报冲突且不改动数据。</p>
    <div id="restoreMsg"></div>`;
}

async function confirmRestore() {
  if (!restorePreview) return;
  const btn = $('#restoreConfirm');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/editor/restore', {
      versionNo: restorePreview.versionNo,
      draftRevisionNo: restorePreview.draftRevisionNo,
      currentVersionNo: restorePreview.currentVersionNo,
    });
    $('#restoreDialog').close();
    // 用恢复后的待选主张替换本地单选；旧 id 已失效，不能保留
    const m = {};
    data.pendingSelection.forEach((s) => { m[s.eventId] = s.claimId; });
    localStorage.setItem('selections', JSON.stringify(m));
    await loadState();
    showPublishResult('ok', `
      草稿已从 <b>第 ${data.restoredFromVersionNo} 版</b>恢复（新草稿修订号 ${data.revisionNo}）。
      每个事件仅带回该版被选主张且已替你选中。历史快照与访客年表未变，
      请<b>校验能否发布</b>后再发布新版本；发布仍按 baseVersionNo = 第 ${data.currentVersionNo} 版做冲突检查。`);
  } catch (err) {
    if (err.message === 'unauthorized') { $('#restoreDialog').close(); return; }
    if (err.status === 409) {
      $('#restoreMsg').innerHTML = `<div class="alert error">${esc(err.message)}<br>
        <span class="muted">数据未做任何改动。请关闭本框后重新点击「预览并恢复草稿」。</span></div>`;
      btn.disabled = true;
    } else {
      $('#restoreMsg').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  }
}

// ---------- 导入采访整理包（JSON，预览 → 确认） ----------
function showBundleMsg(kind, html) {
  $('#bundleMsg').innerHTML = `<div class="alert ${kind}">${html}</div>`;
}

function bundleProblemsHtml(problems) {
  return `<ul class="error-list">${problems.map((p) => `<li>${esc(p.message)}</li>`).join('')}</ul>`;
}

async function previewBundleImport() {
  const text = $('#bundleText').value.trim();
  if (!text) { showBundleMsg('error', '请先选择 JSON 文件或粘贴整理包 JSON。'); return; }
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    showBundleMsg('error', `JSON 解析失败：${esc(e.message)}`);
    return;
  }
  try {
    const data = await api('POST', '/api/editor/import-preview', parsed);
    bundleParsed = parsed;
    bundlePreview = data;
    renderBundlePreview(data);
    $('#bundleConfirm').disabled = Boolean(data.alreadyImported);
    $('#bundleDialog').showModal();
  } catch (err) {
    if (err.message === 'unauthorized') return;
    if (err.status === 422 && err.body && Array.isArray(err.body.problems)) {
      showBundleMsg('error', `<b>${esc(err.body.message)}</b>${bundleProblemsHtml(err.body.problems)}`);
    } else {
      showBundleMsg('error', esc(err.message));
    }
  }
}

function renderBundlePreview(data) {
  const evHtml = data.events.map((ev) => `
    <div class="rel-line">
      <strong>${esc(ev.title)}</strong> <span class="badge">键 ${esc(ev.key)}</span>
      ${ev.description ? `<div class="muted">${esc(ev.description)}</div>` : ''}
      ${ev.claims.map((c) => `<div class="source"><b>${esc(c.dateLabel)}</b>（区间 ${c.intervalStart} ~ ${c.intervalEnd}）<br><b>出处：</b>${esc(c.source)}${c.note ? `<br><span class="muted">${esc(c.note)}</span>` : ''}</div>`).join('')}
    </div>`).join('');
  const relHtml = data.relations.length
    ? data.relations.map((r) => `
        <div class="rel-line">
          <strong>${esc(r.earlierTitle)}</strong> <span class="badge">先于</span> <strong>${esc(r.laterTitle)}</strong>
          ${r.source ? `<div class="source"><b>出处：</b>${esc(r.source)}</div>` : ''}
        </div>`).join('')
    : '<p class="muted">（无「先于」关系）</p>';
  $('#bundleBody').innerHTML = `
    ${data.alreadyImported ? `<div class="alert error">批次标识「${esc(data.batchId)}」已于 ${esc(data.alreadyImported.importedAt)} UTC 成功导入过，确认将返回冲突。请更换批次标识后再预览。</div>` : ''}
    <p>批次 <b>${esc(data.batchId)}</b> 校验通过，将<b>追加</b>到当前草稿（既有草稿、历史快照与访客年表不受影响）：</p>
    <p>
      <span class="badge prec">事件 ${data.counts.eventCount} 个</span>
      <span class="badge prec">时间主张 ${data.counts.claimCount} 条</span>
      <span class="badge prec">先于关系 ${data.counts.relationCount} 条</span>
    </p>
    <h3 style="font-size:13px">待写入事件与主张</h3>
    <div style="max-height:220px;overflow:auto">${evHtml}</div>
    <h3 style="font-size:13px;margin-top:10px">待写入「先于」关系</h3>
    ${relHtml}
    <p class="muted" style="margin-top:10px">内容指纹 <code>${esc(data.fingerprint.slice(0, 16))}…</code> · 预览时草稿修订号 ${data.draftRevisionNo}。
      确认时须提交原包与该指纹；内容被替换、草稿已变化或批次已导入都会冲突且不写入。
      导入后仍需为事件选定主张并「校验能否发布」。</p>
    <div id="bundleDialogMsg"></div>`;
}

async function confirmBundleImport() {
  if (!bundleParsed || !bundlePreview) return;
  const btn = $('#bundleConfirm');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/editor/import', {
      bundle: bundleParsed,
      fingerprint: bundlePreview.fingerprint,
      draftRevisionNo: bundlePreview.draftRevisionNo,
    });
    $('#bundleDialog').close();
    const mapping = data.idMap.events.map((m) => `「${m.key}」→ 事件 #${m.eventId}（主张 ${m.claimIds.length} 条）`).join('、');
    bundleParsed = null;
    bundlePreview = null;
    $('#bundleText').value = '';
    $('#bundleFile').value = '';
    await loadState();
    showBundleMsg('ok', `
      批次 <b>${esc(data.batchId)}</b> 已导入草稿（新草稿修订号 ${data.revisionNo}）：
      ${data.counts.eventCount} 个事件、${data.counts.claimCount} 条主张、${data.counts.relationCount} 条关系。<br>
      <span class="muted">键 → 草稿 ID：${esc(mapping)}。历史快照与访客年表未变；
      请为导入的事件选定主张并「校验能否发布」后再发布。</span>`);
  } catch (err) {
    if (err.message === 'unauthorized') { $('#bundleDialog').close(); return; }
    const box = $('#bundleDialogMsg');
    if (err.status === 409) {
      box.innerHTML = `<div class="alert error">${esc(err.message)}<br>
        <span class="muted">未写入任何数据。请关闭本框后重新「预览导入内容」。</span></div>`;
      btn.disabled = true;
    } else if (err.status === 422 && err.body && Array.isArray(err.body.problems)) {
      box.innerHTML = `<div class="alert error">${esc(err.body.message)}${bundleProblemsHtml(err.body.problems)}</div>`;
      btn.disabled = true;
    } else {
      box.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  }
}

// ---------- 按出处原文撤回公开展示（预览 → 确认） ----------
function showRedactMsg(kind, html) {
  $('#redactMsg').innerHTML = `<div class="alert ${kind}">${html}</div>`;
}

function redactHitsHtml(data) {
  const perVersion = data.versions.length
    ? data.versions.map((v) => {
        const evs = v.eventHits.map((h) => `<li>事件「${esc(h.title)}」（事件主张，eventId ${h.eventId}）</li>`).join('');
        const rels = v.relationHits
          .map((h) => `<li>先于关系 ${h.earlierEventId} → ${h.laterEventId}（relationId ${h.relationId}）</li>`)
          .join('');
        return `
          <div class="rel-line">
            <strong>第 ${v.versionNo} 版</strong>
            <span class="badge prec">事件主张 ${v.eventHitCount} 处</span>
            <span class="badge prec">先于关系 ${v.relationHitCount} 处</span>
            ${v.totalHitCount ? `<ul class="error-list" style="margin:4px 0">${evs}${rels}</ul>` : '<div class="muted">本版无命中</div>'}
          </div>`;
      }).join('')
    : '<p class="muted">尚无已发布版本（没有可遮盖的公开内容）。</p>';

  const d = data.draft;
  const draftHtml = d
    ? `<p class="muted">另：当前草稿中有 ${d.claimHitCount} 条未发布主张、${d.relationHitCount} 条未发布关系使用同一文本；
       它们不在本次公开命中范围内，但<b>以后发布时会自动遮盖</b>（草稿与恢复草稿始终保留原文）。</p>`
    : '';

  return `
    ${data.alreadyRedacted ? '<div class="alert warn">该出处文本此前已确认遮盖，重复确认将直接返回已遮盖状态（不重复落库）。</div>' : ''}
    <p>出处原文：<code>${esc(data.source)}</code></p>
    <p>
      <span class="badge prec">已发布版本 ${data.versionCount} 个</span>
      <span class="badge prec">事件主张命中 ${data.totalEventHitCount} 处</span>
      <span class="badge prec">先于关系命中 ${data.totalRelationHitCount} 处</span>
      <span class="badge">合计 ${data.totalHitCount} 处</span>
    </p>
    ${draftHtml}
    <div style="max-height:240px;overflow:auto">${perVersion}</div>
    <p class="muted" style="margin-top:10px">预览基准：当前最新版本号 <b>${data.currentVersionNo}</b>。
      确认后不改写历史快照或草稿；访客读最新年表或任一历史版本时，命中处出处统一显示<b>「出处已遮盖」</b>，
      其余字段与版本号不变。预览后若已发布新版本，确认将报冲突且不落库。</p>
    <div id="redactDialogMsg"></div>`;
}

async function previewRedaction() {
  const source = $('#redactSource').value;
  if (!source.trim()) { showRedactMsg('error', '出处原文不能为空，请输入要撤回的精确出处文本。'); return; }
  try {
    const data = await api('POST', '/api/editor/redaction-preview', { source });
    redactPreview = data;
    $('#redactBody').innerHTML = redactHitsHtml(data);
    $('#redactConfirm').disabled = false;
    $('#redactDialog').showModal();
  } catch (err) {
    if (err.message === 'unauthorized') return;
    showRedactMsg('error', esc(err.message));
  }
}

async function confirmRedaction() {
  if (!redactPreview) return;
  const btn = $('#redactConfirm');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/editor/redaction', {
      source: redactPreview.source,
      currentVersionNo: redactPreview.currentVersionNo,
      editor: store.editor || '匿名编辑',
    });
    $('#redactDialog').close();
    redactPreview = null;
    showRedactMsg('ok',
      data.alreadyRedacted
        ? `该出处<b>已处于遮盖状态</b>（此前已确认，未重复落库）：当前共遮盖 ${data.totalHitCount} 处公开位置。`
        : `已确认遮盖：访客读取最新年表或任一历史版本时，${data.totalHitCount} 处命中位置的出处统一显示
           <b>「出处已遮盖」</b>（事件主张 ${data.totalEventHitCount} 处、先于关系 ${data.totalRelationHitCount} 处）；
           历史快照、草稿与版本号均未改动，以后发布含同一文本的版本也自动遮盖。
           <a href="/" target="_blank">打开访客年表查看效果</a>`);
  } catch (err) {
    if (err.message === 'unauthorized') { $('#redactDialog').close(); return; }
    const box = $('#redactDialogMsg');
    if (err.status === 409) {
      box.innerHTML = `<div class="alert error">${esc(err.message)}<br>
        <span class="muted">未做任何改动。请关闭本框后重新「预览命中位置」。</span></div>`;
      btn.disabled = true;
    } else {
      box.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  }
}

// ---------- 版本原文（持口令，不遮盖） ----------
async function openRawVersion(versionNo) {
  $('#rawVersionNo').textContent = versionNo;
  $('#rawVersionBody').textContent = '加载中…';
  $('#rawVersionDialog').showModal();
  try {
    const data = await api('GET', `/api/editor/versions/${versionNo}/raw`);
    const v = data.version;
    const titleById = new Map(v.events.map((e) => [e.eventId, e.title]));
    const evs = v.events.map((e) => `
      <div class="rel-line">
        <strong>${esc(e.title)}</strong> <span class="badge">${esc(e.dateLabel)}</span>
        <div class="source"><b>出处原文：</b>${esc(e.source || '（未注明）')}</div>
        ${e.claimNote ? `<div class="muted">${esc(e.claimNote)}</div>` : ''}
      </div>`).join('');
    const rels = v.relations.length
      ? v.relations.map((r) => `
          <div class="rel-line">
            <strong>${esc(titleById.get(r.earlierEventId) || '#' + r.earlierEventId)}</strong>
            <span class="badge">先于</span>
            <strong>${esc(titleById.get(r.laterEventId) || '#' + r.laterEventId)}</strong>
            ${r.source ? `<div class="source"><b>出处原文：</b>${esc(r.source)}</div>` : ''}
          </div>`).join('')
      : '<p class="muted">（无先于关系）</p>';
    $('#rawVersionBody').innerHTML = `
      <p class="muted">${v.eventCount} 个事件、${v.relationCount} 条关系 · 发布于 ${esc(v.publishedAt)} UTC。
        以下为快照<b>原文</b>；访客公开接口中命中遮盖登记的出处会显示「出处已遮盖」。</p>
      <h3 style="font-size:13px">事件与被选主张</h3>${evs}
      <h3 style="font-size:13px;margin-top:10px">「先于」关系</h3>${rels}`;
  } catch (err) {
    if (err.message === 'unauthorized') { $('#rawVersionDialog').close(); return; }
    $('#rawVersionBody').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
  }
}

// ---------- 预约发布 ----------
function showScheduleResult(kind, html) {
  $('#scheduleResult').innerHTML = `<div class="alert ${kind}">${html}</div>`;
}

function utcIsoFromMs(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const SCHEDULE_STATUS_LABEL = {
  pending: '待执行',
  published: '已发布',
  conflict: '冲突未发布',
  cancelled: '已取消',
};

async function loadSchedules() {
  try {
    const data = await api('GET', '/api/editor/schedules');
    renderScheduleList(data.schedules);
  } catch (err) {
    if (err.message !== 'unauthorized') $('#scheduleList').innerHTML = `<span class="muted">${esc(err.message)}</span>`;
  }
}

function renderScheduleList(schedules) {
  if (!schedules.length) {
    $('#scheduleList').innerHTML = '<p class="muted">尚无预约。</p>';
    return;
  }
  const nowMs = Date.now();
  $('#scheduleList').innerHTML = schedules.map((s) => {
    const dueMs = Date.parse(s.scheduledAt);
    const countdown = s.status === 'pending'
      ? `<span class="muted">（${esc(describeDelta(dueMs - nowMs))}后执行）</span>`
      : '';
    const statusBadge = s.status === 'conflict'
      ? '<span class="badge" style="background:#fbeaea;color:#a33">冲突未发布</span>'
      : `<span class="badge">${esc(SCHEDULE_STATUS_LABEL[s.status] || s.status)}</span>`;
    const action = s.status === 'pending'
      ? `<button class="danger" type="button" data-cancel-schedule="${s.scheduleNo}" style="padding:2px 10px;font-size:13px">取消预约</button>`
      : '';
    return `
      <div class="rel-line">
        <div class="row" style="align-items:center">
          <strong>预约 #${s.scheduleNo}</strong>
          ${statusBadge}
          <span class="muted" style="flex:1">${esc(s.scheduledAt)} ${countdown} · ${esc(s.editor || '匿名')} ·
            冻结于第 ${s.baseVersionNo} 版 · ${s.eventCount} 事件 / ${s.relationCount} 关系</span>
          <button class="secondary" type="button" data-view-schedule="${s.scheduleNo}" style="padding:2px 10px;font-size:13px">查看冻结内容</button>
          ${action}
        </div>
        ${s.note ? `<div class="muted">说明：${esc(s.note)}</div>` : ''}
        ${s.status === 'published'
          ? `<div class="muted">已于 ${esc(s.attemptedAt || '')} UTC 生成 <b>第 ${s.resultVersionNo} 版</b>。</div>` : ''}
        ${s.status === 'conflict'
          ? `<div class="muted" style="color:#a33">${esc(s.resultMessage)}</div>` : ''}
      </div>`;
  }).join('');
}

function describeDelta(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.round(min / 60);
  return `${hr} 小时`;
}

async function doCreateSchedule() {
  const err = clientCheck();
  if (err) { showScheduleResult('error', esc(err)); return; }
  const scheduledAt = $('#scheduleAt').value.trim();
  if (!scheduledAt) { showScheduleResult('error', '请填写预约发布的未来 UTC 时刻（形如 2026-10-02T12:34:00Z）。'); return; }
  const btn = $('#btnSchedule');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/editor/schedules', {
      selection: gatherSelection(),
      scheduledAt,
      baseVersionNo,
      editor: store.editor || '匿名编辑',
      note: $('#publishNote').value,
    });
    showScheduleResult('ok',
      `已建立 <b>预约 #${data.schedule.scheduleNo}</b>：将在 <b>${esc(data.schedule.scheduledAt)}</b> 尝试发布。
       事件、所选主张、关系、求解日期与基准版本号（第 ${data.schedule.baseVersionNo} 版）已冻结；
       到期前访客仍只见当前最新版，之后修改草稿不影响本预约。`);
    $('#scheduleAt').value = '';
    await loadSchedules();
  } catch (e) {
    if (e.status === 422 && e.body?.errors) {
      showScheduleResult('error',
        `<b>草稿未通过发布校验，未建立预约。</b><ul class="error-list">${
          e.body.errors.map((er) => `<li><b>${esc(er.message)}</b></li>`).join('')
        }</ul>`);
    } else if (e.status === 409) {
      showScheduleResult('error', esc(e.message) + ' 未建立任何预约。');
      conflictData = e.body;
      showConflictDialog(e.body);
    } else {
      showScheduleResult('error', esc(e.message));
    }
  } finally {
    btn.disabled = false;
  }
}

async function openScheduleDetail(no) {
  $('#scheduleDetailNo').textContent = '#' + no;
  $('#scheduleBody').textContent = '加载中…';
  $('#scheduleCancelDlg').disabled = false;
  $('#scheduleDialog').showModal();
  scheduleDetail = null;
  try {
    const data = await api('GET', `/api/editor/schedules/${no}`);
    scheduleDetail = data.schedule;
    renderScheduleDetail(data.schedule);
  } catch (err) {
    if (err.message === 'unauthorized') { $('#scheduleDialog').close(); return; }
    $('#scheduleBody').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
    $('#scheduleCancelDlg').disabled = true;
  }
}

function renderScheduleDetail(s) {
  const evs = s.frozen.events.map((e) => `
    <div class="rel-line">
      <strong>${esc(e.title)}</strong>
      <span class="badge prec">${esc(e.dateLabel)}</span>
      <span class="badge">求解日期 ${esc(e.resolvedDate)}</span>
      <span class="muted">区间 ${esc(e.intervalStart)} ~ ${esc(e.intervalEnd)}</span>
      <div class="source"><b>出处：</b>${esc(e.source || '（未注明）')}</div>
      ${e.claimNote ? `<div class="muted">${esc(e.claimNote)}</div>` : ''}
    </div>`).join('');
  const titleById = new Map(s.frozen.events.map((e) => [e.eventId, e.title]));
  const rels = s.frozen.relations.length
    ? s.frozen.relations.map((r) => `
      <div class="rel-line">
        <strong>${esc(titleById.get(r.earlierEventId) || '#' + r.earlierEventId)}</strong>
        <span class="badge">先于</span>
        <strong>${esc(titleById.get(r.laterEventId) || '#' + r.laterEventId)}</strong>
        ${r.source ? `<div class="source"><b>出处：</b>${esc(r.source)}</div>` : ''}
      </div>`).join('')
    : '<p class="muted">（无先于关系）</p>';

  const statusLine = {
    pending: `<p>状态：<b>待执行</b>，将于 <b>${esc(s.scheduledAt)}</b> 尝试发布。到期前可取消。</p>`,
    published: `<p>状态：<b>已发布</b>，${esc(s.attemptedAt || '')} UTC 生成 <b>第 ${s.resultVersionNo} 版</b>，不可取消。</p>`,
    conflict: `<p>状态：<b style="color:#a33">冲突未发布</b>。${esc(s.resultMessage)}<br>
      <span class="muted">冻结内容完整保留如下，可重新核对草稿后即时发布或另建预约。</span></p>`,
    cancelled: '<p>状态：<b>已取消</b>，不会发布。</p>',
  }[s.status];

  $('#scheduleBody').innerHTML = `
    ${statusLine}
    <p class="muted">冻结时基准版本号：第 ${s.baseVersionNo} 版 · 草稿修订号 ${s.draftRevisionNo} ·
      建立于 ${esc(s.createdAt)} UTC · 编辑者：${esc(s.editor || '匿名')}${s.note ? ' · 说明：' + esc(s.note) : ''}</p>
    <h3 style="font-size:13px">冻结的事件与被选主张（${s.eventCount}）</h3>
    ${evs}
    <h3 style="font-size:13px;margin-top:10px">冻结的「先于」关系（${s.relationCount}）</h3>
    ${rels}
    <div id="scheduleDlgMsg"></div>`;
  $('#scheduleCancelDlg').style.display = s.status === 'pending' ? '' : 'none';
}

async function cancelScheduleFromDialog() {
  if (!scheduleDetail) return;
  const btn = $('#scheduleCancelDlg');
  btn.disabled = true;
  try {
    await api('DELETE', `/api/editor/schedules/${scheduleDetail.scheduleNo}`);
    $('#scheduleDialog').close();
    showScheduleResult('ok', `预约 #${scheduleDetail.scheduleNo} 已取消，不会发布。`);
    await loadSchedules();
  } catch (err) {
    if (err.message === 'unauthorized') { $('#scheduleDialog').close(); return; }
    $('#scheduleDlgMsg').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
    btn.disabled = false;
  }
}

async function cancelScheduleInline(no) {
  if (!confirm(`确定取消预约 #${no}？取消后该预约不会发布。`)) return;
  try {
    await api('DELETE', `/api/editor/schedules/${no}`);
    await loadSchedules();
    showScheduleResult('ok', `预约 #${no} 已取消。`);
  } catch (err) {
    if (err.message !== 'unauthorized') showScheduleResult('error', esc(err.message));
  }
}

// ---------- 事件委托：增删改 ----------
async function onClick(e) {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;

  if (t.id === 'tokenSave') {
    store.token = $('#tokenInput').value.trim();
    showGlobal('ok', '口令已保存到本浏览器。');
    await loadState();
    return;
  }
  if (t.id === 'btnValidate') return doValidate();
  if (t.id === 'btnPublish') return doPublish();
  if (t.id === 'btnSchedule') return doCreateSchedule();
  if (t.id === 'btnScheduleNow1m') {
    $('#scheduleAt').value = utcIsoFromMs(Date.now() + 60 * 1000);
    return;
  }
  const viewSchedule = t.dataset && t.dataset.viewSchedule;
  if (viewSchedule !== undefined) return openScheduleDetail(Number(viewSchedule));
  const cancelSch = t.dataset && t.dataset.cancelSchedule;
  if (cancelSch !== undefined) return cancelScheduleInline(Number(cancelSch));
  if (t.id === 'scheduleCancelDlg') return cancelScheduleFromDialog();
  if (t.id === 'scheduleClose') { $('#scheduleDialog').close(); scheduleDetail = null; return; }

  if (t.id === 'conflictCancel') { $('#conflictDialog').close(); return; }
  if (t.id === 'conflictReload') {
    $('#conflictDialog').close();
    await loadState();
    showGlobal('warn', `已刷新到第 ${baseVersionNo} 版后的最新草稿。请重新确认各事件的主张选择，再点击发布。`);
    return;
  }

  if (t.id === 'restoreCancel') { $('#restoreDialog').close(); restorePreview = null; return; }
  if (t.id === 'restoreConfirm') return confirmRestore();
  const restoreVersion = t.dataset && t.dataset.restoreVersion;
  if (restoreVersion !== undefined) return openRestorePreview(Number(restoreVersion));

  if (t.id === 'btnBundlePreview') return previewBundleImport();
  if (t.id === 'bundleCancel') { $('#bundleDialog').close(); bundleParsed = null; bundlePreview = null; return; }
  if (t.id === 'bundleConfirm') return confirmBundleImport();

  if (t.id === 'btnRedactPreview') return previewRedaction();
  if (t.id === 'redactCancel') { $('#redactDialog').close(); redactPreview = null; return; }
  if (t.id === 'redactConfirm') return confirmRedaction();
  if (t.id === 'rawVersionClose') { $('#rawVersionDialog').close(); return; }
  const rawVersion = t.dataset && t.dataset.rawVersion;
  if (rawVersion !== undefined) return openRawVersion(Number(rawVersion));

  const addEvent = t.dataset && t.dataset.addEvent !== undefined;
  if (t.id === 'btnAddEvent') {
    const title = $('#newEventTitle').value.trim();
    if (!title) { showGlobal('error', '事件标题不能为空。'); return; }
    await api('POST', '/api/editor/events', { title, description: $('#newEventDesc').value });
    $('#newEventTitle').value = ''; $('#newEventDesc').value = '';
    await loadState();
    return;
  }

  const saveEvent = t.dataset && t.dataset.saveEvent;
  if (saveEvent) {
    const id = Number(saveEvent);
    const title = document.querySelector(`[data-edit-title="${id}"]`).value.trim();
    const description = document.querySelector(`[data-edit-desc="${id}"]`).value;
    if (!title) { showGlobal('error', '事件标题不能为空。'); return; }
    await api('PUT', `/api/editor/events/${id}`, { title, description });
    await loadState();
    return;
  }

  const delEvent = t.dataset && t.dataset.delEvent;
  if (delEvent) {
    if (!confirm(`删除事件「${titleOf(Number(delEvent))}」将同时删除其全部主张与相关先后关系，确定？`)) return;
    await api('DELETE', `/api/editor/events/${delEvent}`);
    await loadState();
    return;
  }

  const addClaim = t.dataset && t.dataset.addClaim;
  if (addClaim) {
    const id = Number(addClaim);
    const precision = document.querySelector(`[data-new-precision="${id}"]`).value;
    const year = Number(document.querySelector(`[data-new-year="${id}"]`).value);
    const monthEl = document.querySelector(`[data-new-month="${id}"]`);
    const dayEl = document.querySelector(`[data-new-day="${id}"]`);
    const payload = {
      precision,
      year,
      month: precision === 'year' ? undefined : Number(monthEl.value),
      day: precision === 'day' ? Number(dayEl.value) : undefined,
      source: document.querySelector(`[data-new-source="${id}"]`).value,
      note: document.querySelector(`[data-new-note="${id}"]`).value,
    };
    try {
      const data = await api('POST', `/api/editor/events/${id}/claims`, payload);
      store.setSelection(id, data.claim.id); // 新增主张默认选中，可改
      await loadState();
    } catch (err) { showGlobal('error', esc(err.message)); }
    return;
  }

  const delClaim = t.dataset && t.dataset.delClaim;
  if (delClaim) {
    if (!confirm('删除这条时间主张？')) return;
    await api('DELETE', `/api/editor/claims/${delClaim}`);
    await loadState();
    return;
  }

  if (t.id === 'btnAddRel') {
    const earlierId = Number($('#relEarlier').value);
    const laterId = Number($('#relLater').value);
    if (earlierId === laterId) { showGlobal('error', '一个事件不能先于自身。'); return; }
    try {
      await api('POST', '/api/editor/relations', {
        earlierId, laterId, source: $('#relSource').value,
      });
      $('#relSource').value = '';
      await loadState();
    } catch (err) { showGlobal('error', esc(err.message)); }
    return;
  }

  const delRel = t.dataset && t.dataset.delRel;
  if (delRel) {
    await api('DELETE', `/api/editor/relations/${delRel}`);
    await loadState();
  }
}

function onChange(e) {
  const claimId = e.target.dataset && e.target.dataset.selectClaim;
  if (claimId !== undefined) {
    const card = e.target.closest('.event-card');
    store.setSelection(Number(card.dataset.event), Number(claimId));
    render();
  }
}

// ---------- 启动 ----------
document.addEventListener('click', (e) => {
  onClick(e).catch((err) => {
    if (err.message !== 'unauthorized') showGlobal('error', esc(err.message));
  });
});
document.addEventListener('change', onChange);

$('#tokenInput').value = store.token;
$('#editorName').value = store.editor;
$('#editorName').addEventListener('input', (e) => { store.editor = e.target.value; });
$('#bundleFile').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    $('#bundleText').value = await f.text();
  } catch {
    showBundleMsg('error', '读取文件失败，请重试或直接粘贴 JSON。');
  }
});

(async function init() {
  if (!store.token) {
    showGlobal('warn', '请先在右上角输入编辑者口令（默认 <code>editor</code>，可用环境变量 EDITOR_TOKEN 修改），然后点“保存口令”。');
    return;
  }
  try {
    await loadState();
  } catch (err) {
    if (err.message !== 'unauthorized') showGlobal('error', esc(err.message));
  }
  // 预约列表每 5 秒轻量刷新一次（状态/倒计时；不打扰草稿编辑）
  setInterval(() => {
    if (store.token && !document.hidden) loadSchedules();
  }, 5000);
})();
