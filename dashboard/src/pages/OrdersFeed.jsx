import CategoryNav from '../components/CategoryNav';
import QuickPeriods from '../components/QuickPeriods';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import { getOrderFeed, setSelfBuyout } from '../api';
import DateRangePicker from '../components/DateRangePicker';
import ArtSearch, { artFilter } from '../components/ArtSearch';
import { fmtInt } from './AdsStats2';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «Лента заказов» — все отправления Ozon по мере поступления (их каждые
// 5 минут кладёт во вкладку Orders Google-скрипт, сервис копит их в базе).
// Здесь же отмечаются самовыкупы: такие заказы не считаются в заказах
// («Аналитика продаж», РНП, «Реклама»), а в деньгах за них не вычитается
// себестоимость — товар остаётся у нас.
// ─────────────────────────────────────────────────────────────────────────

const ST = { ordered:'заказан', returned:'возврат',
  awaiting_packaging: 'ожидает сборки', awaiting_deliver: 'ожидает отгрузки', delivering: 'доставляется', driver_pickup: 'у водителя',
  delivered: 'доставлен', cancelled: 'отменён', awaiting_registration: 'регистрация', acceptance_in_progress: 'приёмка', not_accepted: 'не принят',
  arbitration: 'спор', client_arbitration: 'спор', awaiting_approve: 'ожидает подтверждения', sent_by_seller: 'отправлен продавцом',
};
const msk = iso => dayjs(new Date(Date.parse(iso) + 3 * 3600e3).toISOString().slice(0, 19));

export default function OrdersFeed({ cabinet }) {
  const today = dayjs().format('YYYY-MM-DD');
  const [kind, setKind] = useState('orders');
  const [from, setFrom] = useState(dayjs().subtract(29,'day').format('YYYY-MM-DD'));
  const [to, setTo] = useState(today);
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [view, setView] = useState('all'); // all | self | real
  const [hideCancel, setHideCancel] = useState(true);
  const [picked, setPicked] = useState(new Set());
  const [limit, setLimit] = useState(200);
  const [pMin, setPMin] = useState('');
  const [pMax, setPMax] = useState('');
  const [cat, setCat] = useState(''); // путь категории: «Чехлы», «Чехлы / Чехлы на сиденья»…

  const load = useCallback(() => {
    setErr('');
    return getOrderFeed(cabinet, from, to, cabinet === 'defly_wb' ? kind : undefined).then(r => setD(r.data.data)).catch(e => setErr(e.response?.data?.error || e.message));
  }, [cabinet, from, to, kind]);
  useEffect(() => { setD(null); setPicked(new Set()); load(); }, [load]);
  // Свежие заказы — обновление раз в минуту, пока вкладка открыта.
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) load(); }, 60000); return () => clearInterval(t); }, [load]);

  const key = r => `${r.p}|${r.sku}`;
  const inCat = x => !cat || x.cat === cat || String(x.cat || '').startsWith(cat + ' / ');
  const catRows = useMemo(() => (d?.rows || []).filter(inCat), [d, cat]); // eslint-disable-line react-hooks/exhaustive-deps
  // Категории: верхний уровень — вкладками, глубже — списком подкатегорий выбранной.
  const cats = useMemo(() => {
    const top = new Map(), sub = new Map();
    for (const x of d?.rows || []) {
      if (x.st === 'cancelled') continue;
      const parts = String(x.cat || 'Без категории').split(' / ');
      top.set(parts[0], (top.get(parts[0]) || 0) + x.qty);
      for (let i = 2; i <= parts.length; i++) { const k = parts.slice(0, i).join(' / '); sub.set(k, (sub.get(k) || 0) + x.qty); }
    }
    return { top: [...top.entries()].sort((a, b) => (b[0] === 'Чехлы') - (a[0] === 'Чехлы') || b[1] - a[1]), sub }; // «Чехлы» — первыми
  }, [d]);
  const catTop = cat ? cat.split(' / ')[0] : '';
  const subs = useMemo(() => [...cats.sub.entries()].filter(([k]) => catTop && k.startsWith(catTop + ' / ')).sort((a, b) => (a[0] < b[0] ? -1 : 1)), [cats, catTop]);
  const rows = useMemo(() => {
    let r = catRows;
    if (hideCancel) r = r.filter(x => x.st !== 'cancelled');
    if (view === 'self') r = r.filter(x => x.self); else if (view === 'real') r = r.filter(x => !x.self);
    // Цена за штуку «от — до» — например, найти самовыкуп по низкой цене.
    const lo = parseFloat(String(pMin).replace(/\s/g, '').replace(',', '.')), hi = parseFloat(String(pMax).replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(lo)) r = r.filter(x => x.price != null && x.price >= lo);
    if (Number.isFinite(hi)) r = r.filter(x => x.price != null && x.price <= hi);
    return q.trim() ? artFilter(r, q, x => x.o || '', x => `${x.n || ''} ${x.p}`) : r;
  }, [catRows, q, view, hideCancel, pMin, pMax]);
  const sum = useMemo(() => {
    const all = catRows.filter(x => x.st !== 'cancelled');
    const s = { n: 0, q: 0, r: 0, sn: 0, sq: 0, sr: 0, c: catRows.length - all.length };
    for (const x of all) { const v = x.price == null ? NaN : x.price * x.qty; if (x.self) { s.sn++; s.sq += x.qty; s.sr += v; } else { s.n++; s.q += x.qty; s.r += v; } }
    if(d?._wb && !d.available) for(const k of Object.keys(s))s[k]=NaN;
    return s;
  }, [catRows,d]);
  const opts = useMemo(() => { const m = new Map(); for (const x of d?.rows || []) if (x.o && !m.has(x.o)) m.set(x.o, { o: x.o, n: x.n }); return [...m.values()]; }, [d]);

  const mark = async (items, on) => {
    setBusy(true);
    try {
      await setSelfBuyout(cabinet, items.map(x => ({ p: x.p, sku: x.sku })), on);
      setD(cur => cur && ({ ...cur, rows: cur.rows.map(x => (items.some(y => key(y) === key(x)) ? { ...x, self: on } : x)) }));
      setPicked(new Set());
    } catch (e) { setErr(e.response?.data?.error || e.message); } finally { setBusy(false); }
  };
  const pickedRows = rows.filter(x => picked.has(key(x)));
  const toggle = x => setPicked(s => { const n = new Set(s); if (n.has(key(x))) n.delete(key(x)); else n.add(key(x)); return n; });
  const period = n => { const f = dayjs().subtract(n - 1, 'day').format('YYYY-MM-DD'); return <button key={n} type="button" className={from === f && to === today ? 'on' : ''} onClick={() => { setFrom(f); setTo(today); }}>{n === 1 ? 'Сегодня' : `${n} дн`}</button>; };
  const yest = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

  // Разделители по дням.
  let lastDay = '';
  const shown = rows.slice(0, limit);

  return (
    <div className="mpui">
      <div className="page-sticky">
        <div className="a-top">
          <h1>Лента заказов</h1>
          <QuickPeriods from={from} to={to} onChange={(f,t)=>{setFrom(f);setTo(t);}} />
          <DateRangePicker from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
          <ArtSearch value={q} onChange={setQ} options={opts} placeholder="Артикул, название или номер отправления" style={{ minWidth: 260 }} />
        </div>
      </div>
      {err && <div className="c-msg bad" style={{ margin: '10px 0' }}>{err}</div>}
      {!d && !err && <div className="a-empty" style={{ padding: 40, textAlign: 'center' }}>Загрузка…</div>}
      {d && (
        <>
          <CategoryNav tops={cats.top.map(([k])=>k)} value={cat} onChange={setCat} childrenOf={path=>[...new Set([...cats.sub.keys()].filter(k=>k.startsWith(path+' / ')&&k.split(' / ').length===path.split(' / ').length+1).map(k=>k.split(' / ').at(-1)))]} />
          <div className="cl-kpis">
            <div className="a-kpi"><span className="lbl">Заказы</span><span className="val">{fmtInt(sum.n)}</span><span className="sub">{fmtInt(sum.q)} шт · {fmtInt(sum.r)} ₽</span></div>
            <div className="a-kpi"><span className="lbl">Самовыкупы</span><span className="val" style={{ color: sum.sn ? 'var(--a-accent)' : undefined }}>{fmtInt(sum.sn)}</span><span className="sub">{fmtInt(sum.sq)} шт · {fmtInt(sum.sr)} ₽ — не в заказах</span></div>
            <div className="a-kpi"><span className="lbl">Средний чек</span><span className="val">{sum.q ? fmtInt(sum.r / sum.q) : '—'}</span><span className="sub">без самовыкупов, ₽ за шт</span></div>
            <div className="a-kpi"><span className="lbl">Отменено</span><span className="val">{fmtInt(sum.c)}</span><span className="sub">за период</span></div>
          </div>
          <div className="a-bar" style={{ gap: 8, flexWrap: 'wrap', margin: '12px 0 8px' }}>
            <span className="a-seg">{[['all', 'Все'], ['real', 'Заказы'], ['self', `Самовыкупы (${fmtInt(sum.sn)})`]].map(([k, t]) => <button key={k} type="button" className={view === k ? 'on' : ''} onClick={() => setView(k)}>{t}</button>)}</span>
            {cabinet === 'defly_wb' && <div className="a-tabs">{[['orders','Заказы'],['sales','Выкупы'],['returns','Возвраты']].map(([k,t])=><button className={`a-tab ${kind===k?'on':''}`} key={k} onClick={()=>setKind(k)}>{t}</button>)}</div>}
            <button type="button" className="a-toggle" onClick={() => setHideCancel(v => !v)}><span className={`a-sw ${hideCancel ? 'on' : ''}`} />Скрыть отменённые</button>
            <span className="of-price" title="Цена за штуку">
              Цена <input inputMode="numeric" value={pMin} onChange={e => setPMin(e.target.value)} placeholder="от" />
              — <input inputMode="numeric" value={pMax} onChange={e => setPMax(e.target.value)} placeholder="до" /> ₽
              {(pMin || pMax) && <button type="button" className="of-x" onClick={() => { setPMin(''); setPMax(''); }} title="Сбросить">×</button>}
            </span>
            {pickedRows.length > 0 && (
              <span className="of-bulk">
                Выбрано {pickedRows.length}:
                <button type="button" className="a-btn" disabled={busy || kind !== 'orders'} onClick={() => mark(pickedRows, true)}>Отметить самовыкупом</button>
                <button type="button" className="a-btn ghost" disabled={busy || kind !== 'orders'} onClick={() => mark(pickedRows, false)}>снять отметку</button>
                <button type="button" className="a-btn ghost" onClick={() => setPicked(new Set())}>сбросить выбор</button>
              </span>
            )}
            <span className="a-hint" style={{ margin: '0 0 0 auto' }}>
              обновляется раз в минуту{d.since ? ` · лента копится с ${msk(d.since).format('DD.MM.YYYY')}` : ''}
            </span>
          </div>
          <div className="a-card" style={{ padding: 0 }}>
            <div className="a-scroll">
              <table className="a-t of-t">
                <thead><tr>
                  <th style={{ width: 30 }}><input type="checkbox" checked={shown.length > 0 && shown.every(x => picked.has(key(x)))} onChange={e => setPicked(e.target.checked ? new Set(shown.map(key)) : new Set())} title="Выбрать все показанные" /></th>
                  <th className="l">Время</th>
                  <th className="l">Артикул</th>
                  <th className="r">Кол-во</th>
                  <th className="r">Цена</th>
                  <th className="r">Сумма</th>
                  <th className="l">Схема · склад</th>
                  <th className="l">Статус</th>
                  <th className="l" title="Самовыкуп не считается в заказах, а себестоимость за него не вычитается">Самовыкуп</th>
                </tr></thead>
                <tbody>
                  {!shown.length && <tr><td colSpan={9} className="muted" style={{ padding: 16, textAlign: 'center' }}>Заказов нет</td></tr>}
                  {shown.map(x => {
                    const t = x.at ? msk(x.at) : null;
                    const day = t ? t.format('YYYY-MM-DD') : x.date || ''; const dateLabel=t || (x.date ? dayjs(x.date):null);
                    const sep = day !== lastDay ? (lastDay = day, true) : false;
                    return (
                      <React.Fragment key={key(x)}>
                        {sep && rows.length && <tr className="of-day"><td colSpan={9}>{dateLabel ? dateLabel.format('dddd, D MMMM').replace(/^./, c => c.toUpperCase()) : '—'}</td></tr>}
                        <tr className={`${x.self ? 'of-self' : ''} ${x.st === 'cancelled' ? 'of-cancel' : ''} ${picked.has(key(x)) ? 'pr-in-order' : ''}`}>
                          <td><input type="checkbox" checked={picked.has(key(x))} onChange={() => toggle(x)} /></td>
                          <td className="l n">{t ? t.format('HH:mm') : '—'}<small className="of-sub">{x.p}</small></td>
                          <td className="l"><div className="a-art"><div style={{ minWidth: 0 }}><div className="id">{x.o || x.sku}</div><div className="model" title={x.n}>{x.n}</div><div className="of-cat">{String(x.cat || '').split(' / ').slice(-1)[0]}</div></div></div></td>
                          <td className="n r">{x.qty}</td>
                          <td className="n r" title={x.est ? 'Ozon не передал цену в заказе — показана цена продавца на день заказа из истории цен' : undefined}>{x.est ? '≈' : ''}{fmtInt(x.price)}</td>
                          <td className="n r"><b>{x.est ? '≈' : ''}{fmtInt(x.price == null ? null : x.price * x.qty)}</b></td>
                          <td className="l"><span className="of-sch">{String(x.sch || '').toUpperCase()}</span> <span className="muted">{x.wh}</span></td>
                          <td className="l">{ST[x.st] || x.st || '—'}</td>
                          <td className="l">
                            <button type="button" className={`of-self-btn ${x.self ? 'on' : ''}`} disabled={busy || kind !== 'orders'} onClick={() => mark([x], !x.self)}
                              title={x.self ? 'Снять отметку — заказ снова будет считаться обычным' : 'Отметить самовыкупом'}>{x.self ? 'самовыкуп ✓' : 'отметить'}</button>
                          </td>
                        </tr>
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.length > limit && <button type="button" className="s-fold" onClick={() => setLimit(l => l + 300)}>Показать ещё {Math.min(300, rows.length - limit)} из {rows.length - limit} ▼</button>}
          </div>
        </>
      )}
    </div>
  );
}
