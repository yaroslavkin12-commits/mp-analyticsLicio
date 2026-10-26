import React, { useState, useEffect, useMemo } from 'react';
import dayjs from 'dayjs';
import { getFinancePnl, getBuyerShare, getSalesSummary } from '../api';
import DateRangePicker from '../components/DateRangePicker';
import { pnlTotals } from '../lib/pnlCalc';
import { makeShareAt } from './buyerShare';
import { SHOPS } from '../lib/cabinets';
import { fmtInt, fmtPct } from './AdsStats2';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «Сводка по магазинам» — все магазины Ozon в одной таблице: заказы (без
// самовыкупов), выручка с выкупов, услуги Ozon, реклама, к перечислению,
// себестоимость, налог, прибыль и рентабельность. Деньги — по начислениям
// Ozon тем же расчётом, что «P&L» каждого магазина (налог — ставка из «P&L»
// магазина). Магазин раскрывается до категорий; клик по названию — открыть его.
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_OZON = SHOPS.filter(s => s.platform === 'ozon');
const LICIO = SHOPS.filter(s => s.id === 'licio');
const taxOf = cab => { try { const v = parseFloat(localStorage.getItem(`mp-tax-${cab}`)); return Number.isFinite(v) ? v : 6; } catch (e) { return 6; } };
const SEP = ' / ';
const top = a => String(a.cat || 'Без категории').split(SEP)[0];
const pre = d => a => String(a.cat || 'Без категории').split(SEP).slice(0, d).join(SEP);
// Начисления по всем уровням категорий (1–3): путь → итоги.
const byPathOf = (data, opts) => Object.assign({}, ...[1, 2, 3].map(d => pnlTotals(data, { ...opts, groupOf: pre(d) }).byGroup));
const FK = ['revenue', 'ozonX', 'ads', 'payout', 'cost', 'tax', 'profit', 'qty'];
const addF = (list) => { const ok = list.filter(Boolean); if (!ok.length) return null; const o = {}; for (const k of FK) o[k] = ok.reduce((x, f) => x + (f[k] || 0), 0); return o; };

function Delta({ cur, prev, pp }) {
  if (cur === null || prev === null || cur === undefined || prev === undefined || !Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  if (pp) { const d = cur - prev; if (Math.abs(d) < 0.05) return null; return <small className={`ss-d ${d > 0 ? 's-up' : 's-down'}`}>{d > 0 ? '+' : '−'}{Math.abs(d).toFixed(1).replace('.', ',')} п.п.</small>; }
  if (!prev) return null;
  const d = (cur / Math.abs(prev) - 1) * 100 * Math.sign(prev);
  if (Math.abs(d) < 0.5) return null;
  return <small className={`ss-d ${d > 0 ? 's-up' : 's-down'}`}>{d > 0 ? '+' : '−'}{Math.abs(d) >= 100 ? Math.round(Math.abs(d)) : Math.abs(d).toFixed(0)}%</small>;
}

export default function ShopsSummary({ active, cabinet }) {
  const OZON = cabinet === 'licio' ? LICIO : DEFAULT_OZON;
  const catKey = cabinet === 'licio' ? 'mp-ss-licio-cat' : 'mp-ss-cat';
  const today = dayjs().format('YYYY-MM-DD');
  const [from, setFrom] = useState(dayjs().subtract(29, 'day').format('YYYY-MM-DD'));
  const [to, setTo] = useState(today);
  const [pct, setPct] = useState(() => { try { return localStorage.getItem('mp-ss-pct') !== '0'; } catch (e) { return true; } });
  useEffect(() => { try { localStorage.setItem('mp-ss-pct', pct ? '1' : '0'); } catch (e) { /* ignore */ } }, [pct]);
  const [orders, setOrders] = useState(null);
  const [fin, setFin] = useState({}); // cab → { cur, prev } (итоги и по категориям)
  const [open, setOpen] = useState(new Set());
  const [err, setErr] = useState('');
  // Тяжёлая страница (начисления всех магазинов) — грузим только когда её открыли, не в фоне.
  const [armed, setArmed] = useState(!!active);
  useEffect(() => { if (active) setArmed(true); }, [active]);

  useEffect(() => {
    if (!armed) return undefined;
    let off = false;
    setOrders(null); setFin({}); setErr('');
    const len = dayjs(to).diff(dayjs(from), 'day') + 1;
    const pTo = dayjs(from).subtract(1, 'day').format('YYYY-MM-DD'), pFrom = dayjs(from).subtract(len, 'day').format('YYYY-MM-DD');
    getSalesSummary(from, to, cabinet === 'licio' ? 'licio' : undefined).then(r => { if (!off) setOrders(r.data.data); }).catch(e => { if (!off) setErr(e.response?.data?.error || e.message); });
    (async () => {
      for (const s of OZON) {
        try {
          const [cur, prev, bs] = await Promise.all([
            getFinancePnl(s.id, { dateFrom: from, dateTo: to }).then(r => r.data.data),
            getFinancePnl(s.id, { dateFrom: pFrom, dateTo: pTo }).then(r => r.data.data).catch(() => null),
            getBuyerShare(s.id).then(r => r.data.data).catch(() => null),
          ]);
          if (off) return;
          const arts = cur.articles.map(a => ({ o: a.o, parts: String(a.cat || 'Без категории').split(SEP) }));
          const shareAt = makeShareAt(bs, arts);
          const tax = taxOf(s.id);
          const c = pnlTotals(cur, { tax, shareAt, groupOf: top });
          c.byPath = byPathOf(cur, { tax, shareAt });
          // Прошлый период — только если начисления за него есть целиком.
          const pOk = prev && prev.available?.mn && prev.available.mn <= pFrom;
          const p = pOk ? pnlTotals(prev, { tax, shareAt, groupOf: top }) : null;
          if (p) p.byPath = byPathOf(prev, { tax, shareAt });
          setFin(f => ({ ...f, [s.id]: { cur: c, prev: p, tax } }));
        } catch (e) { if (!off) setFin(f => ({ ...f, [s.id]: { error: e.message } })); }
      }
    })();
    return () => { off = true; };
  }, [from, to, armed]);

  const shops = useMemo(() => (orders?.shops || []).map(o => ({ ...o, shop: OZON.find(s => s.id === o.id) || { id: o.id, label: o.label, color: '#888' }, fin: fin[o.id] })), [orders, fin]);
  // Категория сверху: «Все» — магазины целиком, иначе — только эта категория.
  const [cat, setCat] = useState(() => { try { return localStorage.getItem(catKey) || ''; } catch (e) { return ''; } });
  useEffect(() => { try { localStorage.setItem(catKey, cat); } catch (e) { /* ignore */ } }, [cat]);
  const catList = useMemo(() => {
    const m = new Map();
    for (const s of orders?.shops || []) for (const [k, v] of Object.entries(s.cur.byCat)) m.set(k, (m.get(k) || 0) + v[1]);
    return [...m.entries()].sort((a, b) => (b[0] === 'Чехлы') - (a[0] === 'Чехлы') || b[1] - a[1]); // «Чехлы» — всегда первыми
  }, [orders]);
  // Срез магазина под выбранную категорию: заказы, начисления, подгруппы для раскрытия.
  const viewOf = s => {
    const o0 = [0, 0];
    const depth = cat ? cat.split(SEP).length : 0;
    const kidsOf = keys => keys.filter(k => k.split(SEP).length === depth + 1 && (!cat || k.startsWith(cat + SEP))).map(k => ({
      k, name: k.split(SEP).pop(), oq: (s.cur.byPath[k] || o0)[0], or: (s.cur.byPath[k] || o0)[1], poq: (s.prev.byPath?.[k] || o0)[0], por: (s.prev.byPath?.[k] || o0)[1],
      F: s.fin?.cur?.byPath?.[k] || null, PF: s.fin?.prev?.byPath?.[k] || null }));
    const keys = [...new Set([...Object.keys(s.cur.byPath || {}), ...Object.keys(s.fin?.cur?.byPath || {})])];
    if (!cat) return { oq: s.cur.q, or: s.cur.r, poq: s.prev.q, por: s.prev.r, F: s.fin?.cur?.total || null, PF: s.fin?.prev?.total || null, kids: kidsOf(keys) };
    return { oq: (s.cur.byPath[cat] || o0)[0], or: (s.cur.byPath[cat] || o0)[1], poq: (s.prev.byPath?.[cat] || o0)[0], por: (s.prev.byPath?.[cat] || o0)[1],
      F: s.fin?.cur?.byPath?.[cat] || null, PF: s.fin?.prev?.byPath?.[cat] || null, kids: kidsOf(keys) };
  };
  // Подкатегории выбранной верхней категории — для выпадающего списка.
  const catTop = cat ? cat.split(SEP)[0] : '';
  const subList = useMemo(() => {
    const m = new Map();
    for (const s of orders?.shops || []) for (const [k, v] of Object.entries(s.cur.byPath || {})) if (catTop && k.startsWith(catTop + SEP)) m.set(k, (m.get(k) || 0) + v[1]);
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [orders, catTop]);
  const sum = (list, f) => list.reduce((s, x) => s + (f(x) || 0), 0);
  const total = useMemo(() => {
    const v = shops.map(s => ({ s, v: viewOf(s) }));
    const ok = v.filter(x => x.s.fin?.cur);
    return {
      oq: sum(v, x => x.v.oq), or: sum(v, x => x.v.or), por: sum(v, x => x.v.por), poq: sum(v, x => x.v.poq),
      fin: ok.length ? addF(ok.map(x => x.v.F)) : null,
      pfin: ok.length && ok.every(x => x.s.fin.prev) ? addF(ok.map(x => x.v.PF)) : null,
      loading: shops.some(s => !s.fin),
    };
  }, [shops, cat]); // eslint-disable-line react-hooks/exhaustive-deps

  const money = (v, rev) => (pct ? (rev > 0 && Number.isFinite(v) ? fmtPct((-v / rev) * 100) : '—') : `${fmtInt(-v)} ₽`);
  const row = ({ key, name, sub, color, oq, or, por, poq, F, PF, depth, onToggle, isOpen, onOpenShop, loading }) => {
    const rev = F?.revenue;
    const chk = oq > 0 ? or / oq : null, pchk = poq > 0 ? por / poq : null;
    const bchk = F && F.qty > 0 ? rev / F.qty : null, pbchk = PF && PF.qty > 0 ? PF.revenue / PF.qty : null;
    const pay1 = F && F.qty > 0 ? F.payout / F.qty : null, ppay1 = PF && PF.qty > 0 ? PF.payout / PF.qty : null;
    const margin = F && rev > 0 ? (F.profit / rev) * 100 : null;
    const pMargin = PF && PF.revenue > 0 ? (PF.profit / PF.revenue) * 100 : null;
    return (
      <tr key={key} className={`${depth === 0 ? 'ss-total' : depth === 1 ? 'ss-shop' : 'ss-cat'}`}>
        <td className="l">
          <div className="ss-name" style={{ paddingLeft: depth === 2 ? 34 : 0 }}>
            {onToggle ? <button type="button" className={`rnp-chev ${isOpen ? 'on' : ''}`} onClick={onToggle} title={isOpen ? 'Свернуть' : 'Раскрыть по категориям'}>▶</button> : depth === 1 ? <span style={{ width: 20 }} /> : null}
            {color && <i className="ss-dot" style={{ background: color }} />}
            <div style={{ minWidth: 0 }}>
              {onOpenShop ? <button type="button" className="ss-link" onClick={onOpenShop} title="Открыть аналитику магазина">{name}</button> : <b>{name}</b>}
              {sub && <small className="ss-sub">{sub}</small>}
            </div>
          </div>
        </td>
        <td className="n r">{fmtInt(or)} ₽<small className="ss-sub">{fmtInt(oq)} шт <Delta cur={or} prev={por} /></small></td>
        <td className="n r">{chk !== null ? <>{fmtInt(chk)} ₽<Delta cur={chk} prev={pchk} /></> : '—'}</td>
        <td className="n r">{F ? <>{fmtInt(rev)} ₽<small className="ss-sub">{fmtInt(F.qty)} шт</small><Delta cur={rev} prev={PF?.revenue} /></> : loading ? '…' : '—'}</td>
        <td className="n r">{bchk !== null ? <>{fmtInt(bchk)} ₽<Delta cur={bchk} prev={pbchk} /></> : ''}</td>
        <td className="n r ss-pay">{pay1 !== null ? <><b>{fmtInt(pay1)} ₽</b><Delta cur={pay1} prev={ppay1} /></> : ''}</td>
        <td className="n r">{F ? money(F.ozonX, rev) : ''}</td>
        <td className="n r">{F ? money(F.ads, rev) : ''}</td>
        <td className="n r">{F ? `${fmtInt(F.payout)} ₽` : ''}</td>
        <td className="n r">{F ? money(F.cost, rev) : ''}</td>
        <td className="n r">{F ? money(F.tax, rev) : ''}</td>
        <td className="n r ss-profit">{F ? <><b className={F.profit < 0 ? 's-down' : ''}>{fmtInt(F.profit)} ₽</b><Delta cur={F.profit} prev={PF?.profit} /></> : ''}</td>
        <td className="n r">{margin !== null ? <><b className={margin < 0 ? 's-down' : ''}>{fmtPct(margin)}</b><Delta cur={margin} prev={pMargin} pp /></> : ''}</td>
      </tr>
    );
  };
  const openShop = id => window.dispatchEvent(new CustomEvent('mp-open', { detail: { cabinet: id, page: 'pnl' } }));
  const periodBtn = n => { const f = dayjs().subtract(n - 1, 'day').format('YYYY-MM-DD'); return <button key={n} type="button" className={from === f && to === today ? 'on' : ''} onClick={() => { setFrom(f); setTo(today); }}>{n} дн</button>; };

  return (
    <div className="mpui">
      <div className="page-sticky">
        <div className="a-top">
          <h1>Сводка по магазинам</h1>
          <span className="a-seg">{[7, 14, 30, 90].map(periodBtn)}</span>
          <DateRangePicker from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
          <span className="a-seg" style={{ marginLeft: 'auto' }}>
            <button type="button" className={pct ? 'on' : ''} onClick={() => setPct(true)}>% от выручки</button>
            <button type="button" className={!pct ? 'on' : ''} onClick={() => setPct(false)}>в рублях</button>
          </span>
        </div>
      </div>
      {err && <div className="c-msg bad" style={{ margin: '10px 0' }}>{err}</div>}
      {!orders && !err && <div className="a-empty" style={{ padding: 40, textAlign: 'center' }}>Загрузка…</div>}
      {orders && (
        <div className="a-bar" style={{ gap: 8, flexWrap: 'wrap', margin: '12px 0 0' }}>
          <div className="a-tabs">
            <button type="button" className={`a-tab ${!cat ? 'on' : ''}`} onClick={() => setCat('')}>Все</button>
            {catList.map(([k, r]) => <button key={k} type="button" className={`a-tab ${catTop === k ? 'on' : ''}`} onClick={() => setCat(cat === k ? '' : k)} title={`Заказы: ${fmtInt(r)} ₽`}>{k}</button>)}
          </div>
          {subList.length > 0 && (
            <select className="a-sel" value={cat !== catTop ? cat : ''} onChange={e => setCat(e.target.value || catTop)} title="Подкатегория">
              <option value="">все в «{catTop}»</option>
              {subList.map(([k]) => <option key={k} value={k}>{'\u00a0\u00a0'.repeat(k.split(SEP).length - 2)}{k.split(SEP).pop()}</option>)}
            </select>
          )}
        </div>
      )}
      {orders && (
        <div className="a-card" style={{ padding: 0, marginTop: 12 }}>
          <div className="a-scroll">
            <table className="a-t ss-t">
              <thead><tr>
                <th className="l">Магазин</th>
                <th className="r" title="Заказы по дню заказа, без самовыкупов">Заказы</th>
                <th className="r" title="Заказы ₽ / заказы шт">Ср. чек заказа</th>
                <th className="r" title="Выкупы минус возвраты по начислениям Ozon">Выручка (выкупы)</th>
                <th className="r" title="Выручка / выкупленные штуки">Ср. чек выкупа</th>
                <th className="r" title="К перечислению / выкупленные штуки: сколько в среднем приходит на счёт за 1 выкуп (до себестоимости и налога)">Поступление на 1 выкуп</th>
                <th className="r" title="Комиссия, логистика, эквайринг, хранение и прочие удержания Ozon (без рекламы)">Услуги Ozon</th>
                <th className="r">Реклама</th>
                <th className="r" title="Выручка минус услуги Ozon и реклама">К перечислению</th>
                <th className="r" title="Себестоимость выкупленного (без самовыкупов)">Себестоимость</th>
                <th className="r" title="Ставка — из «P&L» каждого магазина, от оплаты покупателя">Налог</th>
                <th className="r">Прибыль</th>
                <th className="r" title="Прибыль / выручка">Рентаб.</th>
              </tr></thead>
              <tbody>
                {row({ key: 'total', name: cat ? `Итого · ${cat.split(SEP).join(' › ')}` : 'Итого', sub: `${dayjs(from).format('DD.MM')} — ${dayjs(to).format('DD.MM.YYYY')} · ${shops.length} маг.`, oq: total.oq, or: total.or, por: total.por, poq: total.poq, F: total.fin, PF: total.pfin, depth: 0, loading: total.loading })}
                {shops.map(s => {
                  const V = viewOf(s);
                  const isOpen = open.has(s.id);
                  const toggle = () => setOpen(o => { const n = new Set(o); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; });
                  const kids = [...V.kids].sort((a, b) => b.or - a.or);
                  return (
                    <React.Fragment key={s.id}>
                      {row({ key: s.id, name: s.shop.label, sub: s.fin?.error ? 'начисления не загрузились' : s.fin ? `налог ${String(s.fin.tax).replace('.', ',')}%` : '', color: s.shop.color, oq: V.oq, or: V.or, por: V.por, poq: V.poq, F: V.F, PF: V.PF, depth: 1, onToggle: kids.length ? toggle : null, isOpen, onOpenShop: () => openShop(s.id), loading: !s.fin })}
                      {isOpen && kids.map(x => row({ key: s.id + x.k, name: x.name, oq: x.oq, or: x.or, por: x.por, poq: x.poq, F: x.F, PF: x.PF, depth: 2, loading: !s.fin }))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="a-hint" style={{ padding: '8px 14px 12px' }}>
            Деньги — по начислениям Ozon, как в «P&L» каждого магазина; за последние 1–2 дня Ozon начисления ещё не провёл — там реклама из кабинета, а выручка может быть неполной.
            Расходы {pct ? 'в % от выручки своей строки — магазины сравниваются напрямую' : 'в рублях'}. Сравнение с прошлым периодом той же длины.
          </div>
        </div>
      )}
    </div>
  );
}
