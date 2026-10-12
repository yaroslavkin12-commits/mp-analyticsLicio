import React, { useState, useEffect, useMemo } from 'react';
import { getRestock, saveRestockSettings, getAdsGroups, getCostList } from '../api';
import ArtSearch, { artFilter } from '../components/ArtSearch';

// ─────────────────────────────────────────────────────────────────────────
// «Пополнения остатков» (вкладка «Уведомления»). Сервер после каждого
// обновления остатков (раз в час из Google-таблицы) сравнивает остаток с
// прошлым снимком; рост на N шт и больше — пополнение.
//   • артикулы и группы из списка наблюдения — сразу в Telegram;
//   • остальные — одним сообщением после утреннего дайджеста.
// ─────────────────────────────────────────────────────────────────────────

const box = { display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5, color: 'var(--text2)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', marginBottom: 12 };
const inp = { padding: '4px 8px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)', fontSize: 12.5 };
const chip = on => ({ padding: '4px 10px', borderRadius: 999, border: `1px solid ${on ? 'var(--accent-wb)' : 'var(--border)'}`, background: on ? 'var(--accent-wb)' : 'transparent', color: on ? '#fff' : 'var(--text2)', fontSize: 12.5, cursor: 'pointer' });
const fmt = v => Math.round(v).toLocaleString('ru-RU');
const when = iso => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export default function RestockTab({ cabinet }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [groups, setGroups] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [add, setAdd] = useState('');
  const [q, setQ] = useState('');
  const [onlyWatched, setOnlyWatched] = useState(false);
  const [days, setDays] = useState(14);

  useEffect(() => { getRestock(cabinet, days).then(r => setData(r.data.data)).catch(e => setErr(e.response?.data?.error || e.message)); }, [cabinet, days]);
  useEffect(() => {
    getAdsGroups(cabinet).then(r => setGroups(r.data.data?.groups || [])).catch(() => {});
    getCostList(cabinet).then(r => setCatalog((r.data.data.items || []).map(it => ({ o: it.offerId, n: it.name })))).catch(() => {});
  }, [cabinet]);

  const s = data?.settings;
  const save = patch => {
    setData(d => ({ ...d, settings: { ...d.settings, ...patch } }));
    saveRestockSettings(cabinet, patch).then(r => setData(d => ({ ...d, settings: r.data.data }))).catch(e => setErr(e.message));
  };
  const nameOf = useMemo(() => new Map(catalog.map(a => [a.o, a.n])), [catalog]);
  const events = useMemo(() => {
    const list = (data?.events || []).filter(e => !onlyWatched || e.watched);
    return artFilter(list, q, e => e.offer_id, e => e.product_name);
  }, [data, q, onlyWatched]);

  if (err && !data) return <div style={box}>Не удалось загрузить: {err}</div>;
  if (!s) return <div style={box}>Загрузка…</div>;

  const addArt = v => {
    const a = String(v || '').trim(); if (!a) return;
    const exact = catalog.find(x => String(x.o).toLowerCase() === a.toLowerCase());
    save({ arts: [...s.arts, exact ? exact.o : a] }); setAdd('');
  };
  const toggleGroup = id => save({ groups: s.groups.includes(id) ? s.groups.filter(g => g !== id) : [...s.groups, id] });

  return (
    <div>
      <div style={box}>
        <b style={{ color: 'var(--text)' }}>📦 Пополнения остатков</b>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={!!s.enabled} onChange={e => save({ enabled: e.target.checked })} />включены</label>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }} title="Сообщение приходит в течение часа после того, как остаток вырос">
          <input type="checkbox" checked={!!s.instant} onChange={e => save({ instant: e.target.checked })} />по списку ниже — сразу</label>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={!!s.daily} onChange={e => save({ daily: e.target.checked })} />остальные — сводкой после утреннего дайджеста</label>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }} title="Меньший рост — обычно возвраты, а не поставка">
          считать пополнением рост от <input type="number" min="1" value={s.minInc} onChange={e => save({ minInc: Number(e.target.value) || 1 })} style={{ ...inp, width: 56 }} /> шт</label>
      </div>

      <div style={{ ...box, alignItems: 'flex-start', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <b style={{ color: 'var(--text)' }}>Сразу сообщать по группам:</b>
          {groups.length ? groups.map(g => <button key={g.id} type="button" style={chip(s.groups.includes(g.id))} onClick={() => toggleGroup(g.id)}>{g.name}</button>)
            : <span style={{ color: 'var(--text3)' }}>групп пока нет — их создают во вкладке «Реклама»</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <b style={{ color: 'var(--text)' }}>и по артикулам:</b>
          {s.arts.map(a => (
            <span key={a} style={{ ...chip(true), display: 'inline-flex', gap: 6, alignItems: 'center' }} title={nameOf.get(a) || ''}>
              {a}<span style={{ cursor: 'pointer', opacity: 0.8 }} onClick={() => save({ arts: s.arts.filter(x => x !== a) })}>×</span>
            </span>
          ))}
          <form onSubmit={e => { e.preventDefault(); addArt(add); }} style={{ display: 'inline-flex', gap: 6 }}>
            <ArtSearch value={add} onChange={setAdd} options={catalog} placeholder="+ артикул" className="" style={{ minWidth: 200 }} inputStyle={inp} />
            <button type="submit" style={{ ...chip(false) }}>добавить</button>
          </form>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0 10px' }}>
        <ArtSearch value={q} onChange={setQ} options={catalog} placeholder="Поиск по артикулу" className="" inputStyle={{ ...inp, padding: '6px 10px' }} style={{ minWidth: 220 }} />
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12.5, color: 'var(--text2)' }}><input type="checkbox" checked={onlyWatched} onChange={e => setOnlyWatched(e.target.checked)} />только из списка</label>
        <span style={{ display: 'inline-flex', gap: 4 }}>{[7, 14, 30].map(d => <button key={d} type="button" style={chip(days === d)} onClick={() => setDays(d)}>{d} дн</button>)}</span>
        <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 'auto' }}>{events.length} пополнений</span>
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ color: 'var(--text3)', fontSize: 11.5, textAlign: 'left' }}>
            {['Когда', 'Артикул', 'Было → стало', 'FBO', 'FBS', 'Уведомление'].map((h, i) => <th key={h} style={{ padding: '9px 12px', borderBottom: '1px solid var(--border)', textAlign: i >= 2 && i <= 4 ? 'right' : 'left', fontWeight: 600 }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {events.map((e, i) => {
              const b = e.fbo_before + e.fbs_before, a = e.fbo_after + e.fbs_after;
              const td = { padding: '8px 12px', borderBottom: '1px solid var(--border)' };
              const pair = (x, y) => (x === y ? <span style={{ color: 'var(--text3)' }}>{fmt(y)}</span> : <span>{fmt(x)} → <b>{fmt(y)}</b></span>);
              return (
                <tr key={i}>
                  <td style={{ ...td, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{when(e.at)}</td>
                  <td style={td}><b>{e.offer_id}</b> <span style={{ color: 'var(--text3)', fontSize: 12 }}>{(e.product_name || '').slice(0, 50)}</span></td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>{fmt(b)} → <b>{fmt(a)}</b> <span style={{ color: 'var(--ok)' }}>+{fmt(a - b)}</span></td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>{pair(e.fbo_before, e.fbo_after)}</td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>{pair(e.fbs_before, e.fbs_after)}</td>
                  <td style={{ ...td, color: 'var(--text2)', fontSize: 12 }}>{e.sent_instant ? '⚡ сразу' : e.sent_daily ? 'в утренней сводке' : e.watched ? 'из списка' : 'будет в сводке'}</td>
                </tr>
              );
            })}
            {!events.length && <tr><td colSpan={6} style={{ padding: 16, color: 'var(--text3)' }}>
              Пополнений пока нет. Первое обновление остатков после выкладки запоминает текущий остаток — дальше сервис ловит каждый рост.
            </td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
