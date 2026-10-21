import React, { useState, useEffect, useMemo } from 'react';
import { getClusters, decideCluster } from '../api';
import { artMatch } from '../components/ArtSearch';
import { fmtInt, naturalCompare } from './AdsStats2';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «Товары → Склейки» — какие артикулы объединены в одну карточку Ozon (обычно
// разные материалы одной модели). Склейки — с Ozon (объединённые карточки), а
// сверху то, что стоит проверить: артикул без склейки, похожий на артикулы
// склейки (тот же корень артикула или, у новинки, та же модель в названии), и
// одиночные артикулы одной модели, которые на Ozon так и не склеили.
// ─────────────────────────────────────────────────────────────────────────

const WHY = { root: 'тот же артикул без суффикса материала', name: 'новинка, та же модель в названии' };

function Art({ x, mark, children }) {
  if (!x) return null;
  return (
    <span className={`cl-art ${mark || ''}`} title={`${x.n}${x.created ? `\nсоздан на Ozon ${x.created}` : ''}\nзаказов за 30 дн: ${fmtInt(x.orders30)}`}>
      <b>{x.o}</b>
      {x.isNew && <i className="cl-new">новинка</i>}
      <small>{x.orders30 ? `${fmtInt(x.orders30)} зак.` : 'нет заказов'}</small>
      {children}
    </span>
  );
}

export default function Clusters({ cabinet, nav }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [view, setView] = useState('check');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(false);

  useEffect(() => {
    setD(null); setErr('');
    getClusters(cabinet).then(r => setD(r.data.data)).catch(e => setErr(e.response?.data?.error || e.message));
  }, [cabinet]);
  const act = (action, offers, id) => {
    setBusy(true);
    decideCluster(cabinet, action, offers, id).then(r => setD(r.data.data)).catch(e => setErr(e.response?.data?.error || e.message)).finally(() => setBusy(false));
  };

  const it = useMemo(() => new Map((d?.items || []).map(x => [x.o, x])), [d]);
  const cl = useMemo(() => new Map((d?.clusters || []).map(c => [c.id, c])), [d]);
  const inCl = useMemo(() => { const m = new Map(); for (const c of d?.clusters || []) for (const o of c.members) m.set(o, c.id); return m; }, [d]);
  const sugBy = useMemo(() => { const m = new Map(); for (const s of d?.suggest || []) { const a = m.get(s.to) || []; a.push(s); m.set(s.to, a); } return m; }, [d]);
  const nCheck = (d?.suggest.length || 0) + (d?.newGroups.length || 0);
  useEffect(() => { if (d && !nCheck && view === 'check') setView('all'); }, [d]); // eslint-disable-line react-hooks/exhaustive-deps

  const qq = q.trim().toLowerCase();
  const match = list => !qq || list.some(o => artMatch(o, it.get(o)?.n || '', qq));
  const singles = useMemo(() => (d?.items || []).filter(x => !inCl.has(x.o)), [d, inCl]);
  const news = useMemo(() => (d?.items || []).filter(x => x.isNew), [d]);
  const clusters = useMemo(() => [...(d?.clusters || [])].sort((a, b) => naturalCompare(a.name, b.name)), [d]);
  const sumOrd = list => list.reduce((s, o) => s + (it.get(o)?.orders30 || 0), 0);

  const card = c => {
    const sug = sugBy.get(c.id) || [];
    return (
      <div key={c.id} className="cl-row">
        <div className="cl-head">
          <b>{c.name}</b>
          <span className="muted">{c.members.length} арт. · {fmtInt(sumOrd(c.members))} заказов за 30 дн</span>
          {c.src === 'manual' && <span className="cl-tag">принята на сайте — на Ozon не склеена</span>}
        </div>
        <div className="cl-arts">
          {c.members.map(o => (
            <Art key={o} x={it.get(o)} mark={c.manual.includes(o) ? 'man' : ''}>
              {c.manual.includes(o) && <button type="button" className="cl-x" title="Убрать из склейки (ручное добавление)" disabled={busy} onClick={() => act('reset', [o])}>×</button>}
            </Art>
          ))}
          {sug.map(s => (
            <Art key={s.o} x={it.get(s.o)} mark="sug">
              <span className="cl-q" title={WHY[s.why]}>?</span>
              <button type="button" className="cl-ok" title="Добавить в эту склейку" disabled={busy} onClick={() => act('add', [s.o], c.id)}>✓</button>
              <button type="button" className="cl-x" title="Не относится к этой склейке" disabled={busy} onClick={() => act('ignore', [s.o], c.id)}>×</button>
            </Art>
          ))}
        </div>
      </div>
    );
  };

  let body = null;
  if (d) {
    if (view === 'check') {
      const sc = [...sugBy.keys()].map(id => cl.get(id)).filter(Boolean).filter(c => match([...c.members, ...sugBy.get(c.id).map(s => s.o)]));
      const ng = d.newGroups.filter(g => match(g.members)).sort((a, b) => sumOrd(b.members) - sumOrd(a.members) || naturalCompare(a.name, b.name));
      body = (
        <>
          {!sc.length && !ng.length && <div className="a-empty" style={{ padding: 24 }}>Проверять нечего — все похожие артикулы в своих склейках.</div>}
          {sc.length > 0 && (
            <div className="a-card cl-card">
              <div className="cl-title">Похоже, забыли добавить в склейку <span className="muted">· {d.suggest.length} арт.</span></div>
              <div className="a-hint" style={{ margin: '0 0 8px' }}>Пунктиром — артикул без склейки, похожий на эту склейку. ✓ — добавить (у нас; на Ozon карточку нужно склеить в кабинете), × — не относится.</div>
              {sc.map(card)}
            </div>
          )}
          {ng.length > 0 && (
            <div className="a-card cl-card">
              <div className="cl-title">{d.source === 'ozon' ? 'Похоже на одну карточку, но на Ozon не склеены' : 'Похоже на одну карточку, но нет в списке склеек'} <span className="muted">· {ng.length}</span></div>
              <div className="a-hint" style={{ margin: '0 0 8px' }}>Одиночные артикулы одной модели в разных материалах, сверху — с большим числом заказов. «Это склейка» — считать вместе у нас; «не склейка» — больше не предлагать.</div>
              {(full ? ng : ng.slice(0, 30)).map(g => (
                <div key={g.id} className="cl-row">
                  <div className="cl-head">
                    <b>{g.name}</b><span className="muted">{g.members.length} арт. · {fmtInt(sumOrd(g.members))} заказов за 30 дн</span>
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                      <button type="button" className="a-btn" disabled={busy} onClick={() => act('add', g.members, g.id)}>Это склейка</button>
                      <button type="button" className="a-btn ghost" disabled={busy} onClick={() => act('ignore', g.members, g.id)}>не склейка</button>
                    </span>
                  </div>
                  <div className="cl-arts">{g.members.map(o => <Art key={o} x={it.get(o)} mark="sug" />)}</div>
                </div>
              ))}
              {ng.length > 30 && <button type="button" className="s-fold" onClick={() => setFull(f => !f)}>{full ? 'Свернуть ▲' : `Показать все ${ng.length} ▼`}</button>}
            </div>
          )}
        </>
      );
    } else if (view === 'all') {
      const list = clusters.filter(c => match(c.members));
      body = <div className="a-card cl-card">{list.length ? list.map(card) : <div className="a-empty" style={{ padding: 20 }}>Ничего не найдено</div>}</div>;
    } else {
      const list = (view === 'new' ? news : singles).filter(x => !qq || artMatch(x.o, x.n, qq)).sort((a, b) => (b.created || '').localeCompare(a.created || '') || b.orders30 - a.orders30);
      body = (
        <div className="a-card cl-card">
          <table className="a-t">
            <thead><tr><th className="l">Артикул</th><th className="l">Название</th><th className="l">Категория</th><th className="r">Создан</th><th className="r">Заказы 30 дн</th><th className="l">Склейка</th></tr></thead>
            <tbody>
              {list.slice(0, 500).map(x => {
                const c = cl.get(inCl.get(x.o)), s = (d.suggest || []).find(y => y.o === x.o);
                return (
                  <tr key={x.o}>
                    <td><b>{x.o}</b>{x.isNew && <i className="cl-new">новинка</i>}</td>
                    <td style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={x.n}>{x.n}</td>
                    <td className="a-hint">{x.cat}</td>
                    <td className="n r">{x.created ? x.created.split('-').reverse().join('.') : '—'}</td>
                    <td className="n r">{x.orders30 ? fmtInt(x.orders30) : '—'}</td>
                    <td>{c ? <span>{c.name} <span className="muted">· {c.members.length} арт.</span></span> : s ? <span className="cl-warn">похоже на «{cl.get(s.to)?.name}» — проверить</span> : <span className="muted">одиночный</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {list.length > 500 && <div className="a-hint">Показаны первые 500 из {list.length} — уточните поиск.</div>}
        </div>
      );
    }
  }

  return (
    <div className="mpui">
      <div className="page-sticky">
        <div className="a-top">
          <h1>Товары</h1>
          {nav}
          <span className="a-hint" style={{ margin: 0 }}>{d ? (d.source === 'ozon' ? 'склейки — объединённые карточки Ozon, обновляются раз в сутки' : 'склейки — из ручного списка; обновите скрипт в таблице, чтобы брать их с Ozon') : ''}</span>
        </div>
      </div>
      {err && <div className="c-msg bad" style={{ margin: '10px 0' }}>{err}</div>}
      {!d && !err && <div className="a-empty" style={{ padding: 40, textAlign: 'center' }}>Загрузка…</div>}
      {d && (
        <>
          {d.source !== 'ozon' && (
            <div className="c-msg" style={{ margin: '12px 0 0' }}>
              Склейки пока не с Ozon, а из старого ручного списка (в нём только рекламируемые артикулы), поэтому «Проверить» показывает и то, что на Ozon уже склеено.
              Обновите скрипт в таблице Дефлая и запустите <b>syncDaily</b> — через 10–20 минут склейки придут с Ozon и лишнее отсюда уйдёт.
            </div>
          )}
          <div className="cl-kpis">
            <div className="a-kpi"><span className="lbl">Склеек</span><span className="val">{fmtInt(d.clusters.length)}</span><span className="sub">{fmtInt(d.items.length - singles.length)} арт. в склейках</span></div>
            <div className="a-kpi"><span className="lbl">Без склейки</span><span className="val">{fmtInt(singles.length)}</span><span className="sub">одиночные карточки</span></div>
            <div className={`a-kpi ${nCheck ? 'cl-kwarn' : ''}`}><span className="lbl">Проверить</span><span className="val">{fmtInt(nCheck)}</span><span className="sub">{nCheck ? 'похоже, забыли склеить' : 'всё в порядке'}</span></div>
            <div className="a-kpi"><span className="lbl">Новинки за 30 дней</span><span className="val">{fmtInt(news.length)}</span><span className="sub">{news.length ? `${news.filter(x => inCl.has(x.o)).length} в склейках` : d.source === 'ozon' ? 'новых карточек нет' : 'дата создания — после обновления скрипта'}</span></div>
          </div>
          <div className="a-bar" style={{ gap: 8, flexWrap: 'wrap', margin: '12px 0 10px' }}>
            <span className="a-seg">
              {[['check', `Проверить (${nCheck})`], ['all', `Склейки (${d.clusters.length})`], ['single', `Без склейки (${singles.length})`], ['new', `Новинки (${news.length})`]].map(([k, t]) => (
                <button key={k} type="button" className={view === k ? 'on' : ''} onClick={() => setView(k)}>{t}</button>
              ))}
            </span>
            <input className="a-input" placeholder="Артикул или модель" value={q} onChange={e => setQ(e.target.value)} style={{ minWidth: 220 }} />
          </div>
          {body}
        </>
      )}
    </div>
  );
}
