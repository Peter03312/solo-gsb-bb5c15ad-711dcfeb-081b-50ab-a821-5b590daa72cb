'use strict';

// 访客页：只读最新已发布版本（不可变快照）
const $ = (sel) => document.querySelector(sel);

const PREC_LABEL = { year: '年精度', month: '月精度', day: '日精度' };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${y} 年 ${m} 月 ${d} 日`;
}

async function main() {
  const msg = $('#message');
  try {
    const res = await fetch('/api/public/chronicle');
    const data = await res.json();
    if (!data.published) {
      msg.innerHTML = '<div class="alert warn">年表尚未发布任何版本，敬请期待。<br><span class="muted">（草稿中的未发布内容对外不可见）</span></div>';
      $('#versionTag').textContent = '未发布';
      return;
    }
    const v = data.version;
    $('#versionTag').textContent = `第 ${v.versionNo} 版 · 发布于 ${v.publishedAt.replace('T', ' ').slice(0, 16)} UTC · 编辑：${esc(v.editor || '匿名')}`;
    $('#chronicle').style.display = 'grid';
    $('#caveat').textContent = `本页为第 ${v.versionNo} 版不可变快照，共 ${v.eventCount} 个事件、${v.relationCount} 条先后关系。`;

    const titleById = new Map(v.events.map((e) => [e.eventId, e.title]));

    $('#timeline').innerHTML = v.events.map((e) => `
      <div class="item">
        <div class="date">${esc(fmtDate(e.resolvedDate))}</div>
        <div><strong>${esc(e.title)}</strong>
          <span class="badge prec">${PREC_LABEL[e.precision] || e.precision}</span>
        </div>
        ${e.description ? `<div class="muted">${esc(e.description)}</div>` : ''}
        <div class="source">
          <b>所选出处：</b>${esc(e.source || '（未注明出处）')}
          <br><span class="muted">原始主张：${esc(e.dateLabel)}
          （覆盖区间 ${e.intervalStart} ~ ${e.intervalEnd}）${e.claimNote ? '；' + esc(e.claimNote) : ''}</span>
        </div>
      </div>
    `).join('');

    $('#relations').innerHTML = v.relations.length
      ? v.relations.map((r) => `
          <div class="rel-line">
            <strong>${esc(titleById.get(r.earlierEventId) || '#' + r.earlierEventId)}</strong>
            <span class="badge">先于</span>
            <strong>${esc(titleById.get(r.laterEventId) || '#' + r.laterEventId)}</strong>
            ${r.source ? `<div class="source"><b>出处：</b>${esc(r.source)}</div>` : ''}
          </div>`).join('')
      : '<p class="muted">本版未记录先于关系。</p>';
  } catch (err) {
    msg.innerHTML = `<div class="alert error">加载失败：${esc(err.message)}</div>`;
  }
}

main();
