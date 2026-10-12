import React, { useState, useEffect, useMemo } from 'react';
import { getCalcBase } from '../api';
import { fmtInt, CAT_COLORS } from './AdsStats2';
import { baseOf, compute, priceFor, DEFAULTS } from './Calculator';
import { useCats, useGroups, FinHeader, Kpi, inPath, matchQ, pct1, useTax, useBuyerShare, OTHER, SEP } from './finShared';
import { useTableCtl, ThCtl, ResetCtl } from '../components/TableTools';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «Цены и маржа» — по каждому товару при его текущей цене: прибыль на 1
// проданную штуку, маржа, ROI, цена безубыточности и цена под целевую
// маржу. Расчёт — тот же, что в калькуляторе (база за 30 дней: комиссия
// FBO из карточки / FBS по факту, выкуп, логистика на отправку и возврат,
// эквайринг, хранение и прочее, реклама — фактический ДРР товара).
// Схема товара — та, через которую идёт большинство его заказов.
// ─────────────────────────────────────────────────────────────────────────

const FILTERS = [['loss', 'Убыточные', 'b'], ['below', 'Ниже цели', 'w'], ['nocost', 'Нет себестоимости', 'm'], ['ok', 'В норме', 'g']];

export default function Margin({ cabinet }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState('');
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState(20);
  // ДРР: по умолчанию — фактический за 30 дней (реклама / заказы товара);
  // можно задать один для всех или свой по каждому товару — как в калькуляторе.
  const lsKey = `mp-margin-drr:${cabinet}`;
  const [drrAll, setDrrAll] = useState('');
  const [drrOver, setDrrOver] = useState({});
  useEffect(() => { try { const v = JSON.parse(localStorage.getItem(lsKey) || '{}'); setDrrAll(v.all ?? ''); setDrrOver(v.over || {}); } catch (e) { setDrrAll(''); setDrrOver({}); } }, [lsKey]);
  useEffect(() => { try { localStorage.setItem(lsKey, JSON.stringify({ all: drrAll, over: drrOver })); } catch (e) { /* ignore */ } }, [lsKey, drrAll, drrOver]);
  const setOver = (o, val) => setDrrOver(m => { const n = { ...m }; if (val === '' || val === null) delete n[o]; else n[o] = val; return n; });
  const [flt, setFlt] = useState(null);
  const [tax] = useTax(cabinet);
  const grp = useGroups(cabinet);
  const ctl = useTableCtl('margin', { k: 'margin', dir: 1 });

  useEffect(() => { setData(null); getCalcBase(cabinet).then(r => setData(r.data.data)).catch(e => setError(e.response?.data?.error || e.message)); }, [cabinet]);
  const cats = useCats(data?.articles, data?.order);
  const bs = useBuyerShare(cabinet, cats.arts);

  // Входные данные расчёта по каждому товару: свои → категория → кабинет.
  const rows = useMemo(() => {
    if (!data) return [];
    const byArt = new Map(data.a.map(x => [x[0], x]));
    const byCat = new Map();
    for (const x of data.a) { const c = cats.arts[x[0]]?.cat; if (!c) continue; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(x); }
    const cache = new Map();
    const catBase = (c, scheme) => { const k = c + '|' + scheme; if (!cache.has(k)) cache.set(k, baseOf(byCat.get(c) || [], scheme)); return cache.get(k); };
    const allBase = { fbo: baseOf(data.a, 'fbo'), fbs: baseOf(data.a, 'fbs') };
    const out = [];
    for (const a of cats.arts) {
      const x = byArt.get(a.i); if (!x || !x[1]) continue;
      if (!(x[13] > 0 || x[25] > 0 || x[24] > 0)) continue; // только товары с заказами за 30 дней
      const scheme = x[13] > 0 && x[14] / x[13] > 0.5 ? 'fbs' : 'fbo';
      const own = baseOf([x], scheme), cb = catBase(a.cat, scheme), ab = allBase[scheme];
      const pick = (k, minOwn) => { for (const b of [own, cb, ab]) if (b && b[k] !== null && b[k] !== undefined && (b !== own || !minOwn || minOwn(b))) return b[k]; return DEFAULTS[k] ?? 0; };
      const commission = scheme === 'fbs' ? (own.commFact ?? cb?.commFact ?? own.commCard ?? pick('commCard')) : (own.commCard ?? pick('commCard'));
      const v = {
        // Скидка покупателя — текущая с сайта (Соинвест, с Ozon-картой); нет — по отчёту «Начисления».
        spp: x[11] !== null && x[11] !== undefined ? x[11] : bs.shareOf ? (1 - bs.shareOf(a.o, a.parts)) * 100 : 0, cost: x[12] || 0, buyout: pick('buyout'), defect: 0, commission: commission ?? DEFAULTS.commission,
        acquiring: pick('acquiring'), direct: pick('direct'), ret: pick('ret'), other: pick('other'), drr: 0, oper: 0, tax,
      };
      const factDrr = Math.min(100, pick('drr', b => b.orders >= 5));
      const ov = drrOver[a.o];
      v.drr = ov !== undefined && ov !== '' && Number.isFinite(Number(ov)) ? Number(ov) : drrAll !== '' && Number.isFinite(Number(drrAll)) ? Number(drrAll) : factDrr;
      const drrSrc = ov !== undefined && ov !== '' ? 'own' : drrAll !== '' ? 'all' : 'fact';
      const price = x[1];
      const r = compute(v, price, 'usn_income');
      // Предел маржи: при любой цене процентные расходы (комиссия, реклама как % от цены,
      // эквайринг, налог) не дают марже подняться выше этого значения.
      const maxM = compute(v, 1e7, 'usn_income').margin;
      // Цену дальше 3× от текущей не показываем — это «ценой не достичь», а не рекомендация.
      const cap = p => (p && p <= price * 3 ? p : null);
      const beRaw = priceFor(v, 'usn_income', 0), tpRaw = priceFor(v, 'usn_income', target);
      const be = cap(beRaw), tp = cap(tpRaw);
      const tpNo = !tp, beNo = !be;
      const status = !x[12] ? 'nocost' : r.profit < 0 ? 'loss' : r.margin < target ? 'below' : 'ok';
      out.push({ a, x, scheme, v, r, be, tp, beNo, tpNo, maxM, status, orders: x[25], rev: x[24], factDrr, drrSrc });
    }
    return out;
  }, [data, cats.arts, target, drrAll, drrOver, tax, bs.shareOf]);

  const q = search.trim().toLowerCase();
  const base = rows.filter(r => inPath(r.a, sel) && matchQ(r.a, q) && grp.test(r.a));
  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, base.filter(r => r.status === k).length]));
  const GET = {
    o: r => r.a.o, price: r => r.r.P, buyer: r => (r.v.spp ? r.r.buyerPrice : null), cost: r => r.v.cost || null, profit: r => r.r.profit,
    margin: r => (r.status === 'nocost' ? null : r.r.margin), roi: r => r.r.roi, be: r => r.be || null, tp: r => r.tp || null,
    gap: r => (r.tp ? r.tp - r.r.P : null), rev: r => r.rev, drr: r => r.v.drr,
  };
  const shown = ctl.apply(flt ? base.filter(r => r.status === flt) : base, (r, k) => GET[k](r)).slice(0, 500);
  const withCost = base.filter(r => r.status !== 'nocost');
  const avgMargin = (() => { let p = 0, rv = 0; for (const r of withCost) { p += r.r.profit * r.orders; rv += r.r.P * r.orders; } return rv ? p / rv * 100 : null; })();
  const lossRev = base.filter(r => r.status === 'loss').reduce((s, r) => s + r.rev, 0);

  if (error) return <div className="mpui"><div className="a-empty" style={{ padding: 40 }}>Не удалось загрузить: {error}</div></div>;
  if (!data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Загрузка…</div></div>;

  return (
    <div className="mpui sa-page">
      <FinHeader title="Цены и маржа" cats={cats} sel={sel} setSel={setSel} search={search} setSearch={setSearch} grp={grp}>
        <label className="a-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>целевая маржа
          <input className="a-input" type="number" min="0" max="80" value={target} onChange={e => setTarget(Math.max(0, Number(e.target.value) || 0))} style={{ width: 60, padding: '4px 8px' }} />%
        </label>
        <label className="a-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title="Пусто — у каждого товара его фактический ДРР за 30 дней. Число — один ДРР для всех (кроме заданных вручную в таблице)">ДРР для всех
          <input className="a-input" type="number" min="0" max="100" step="0.5" value={drrAll} placeholder="факт" onChange={e => setDrrAll(e.target.value)} style={{ width: 64, padding: '4px 8px' }} />%
        </label>
        {(drrAll !== '' || Object.keys(drrOver).length > 0) && <button type="button" className="tt-reset" onClick={() => { setDrrAll(''); setDrrOver({}); }} title="Вернуть фактический ДРР всем товарам">↺ ДРР как по факту</button>}
      </FinHeader>

      <div className="a-kpis s-kpis">
        <Kpi label="Средняя маржа (по заказам)" value={pct1(avgMargin)} sub={`${withCost.length} товаров с себестоимостью · налог ${tax}%`} />
        <Kpi label="Убыточные при текущей цене" value={fmtInt(counts.loss)} sub={`их заказы за 30 дн: ${fmtInt(lossRev)} ₽`} />
        <Kpi label={`Ниже цели ${target}%`} value={fmtInt(counts.below)} sub="прибыль есть, но маржа ниже цели" />
        <Kpi label="Без себестоимости" value={fmtInt(counts.nocost)} sub="заполните во вкладке «Себестоимость»" />
      </div>

      <div className="a-card s-card">
        <div className="i-sigs" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
          {FILTERS.map(([k, l, tone]) => (
            <button key={k} type="button" className={`i-sig ${tone} ${flt === k ? 'on' : ''} ${counts[k] ? '' : 'zero'}`} onClick={() => setFlt(flt === k ? null : k)}>
              <b className="n">{fmtInt(counts[k])}</b><span>{l}</span>
            </button>
          ))}
        </div>
        <div className="a-hint" style={{ marginTop: 8 }}>Цены — текущие из карточек (ваша цена до скидки Ozon). Подобрать цену вручную можно в «Калькуляторе» — найдите товар по артикулу, все поля заполнятся сами.</div>
      </div>

      <div className="a-card">
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><ResetCtl ctl={ctl} /></div>
        <div className="a-scroll">
          <table className="a-t s-slice m-tbl">
            <thead><tr>
              <ThCtl ctl={ctl} k="o" className="" filter={false}>Товар</ThCtl>
              <ThCtl ctl={ctl} k="price" hint="Ваша цена до скидки Ozon; ниже — цена для покупателя со скидкой Ozon">Цена</ThCtl>
              <ThCtl ctl={ctl} k="cost">Себест.</ThCtl>
              <ThCtl ctl={ctl} k="drr" hint="ДРР — реклама в % от цены. По умолчанию фактический за 30 дней (расход на рекламу / сумма заказов товара). Впишите свой — пересчитаются прибыль, маржа и цены">ДРР</ThCtl>
              <ThCtl ctl={ctl} k="profit" hint="Прибыль с одной проданной (выкупленной) штуки после всех расходов, рекламы и налога">Прибыль / шт</ThCtl>
              <ThCtl ctl={ctl} k="margin" hint="Прибыль / выручка с продажи; ниже — ROI (прибыль / себестоимость)">Маржа</ThCtl>
              <ThCtl ctl={ctl} k="be" hint="Цена, при которой прибыль = 0">Без&shy;убыток</ThCtl>
              <ThCtl ctl={ctl} k="tp" hint={`Какой должна стать цена в кабинете, чтобы маржа была ${target}%; ниже — на сколько это выше (+) или ниже (−) текущей. «ценой не достичь» — комиссия, реклама и налог в % от цены не дают марже дойти до цели`}>Цена для {target}%</ThCtl>
              <ThCtl ctl={ctl} k="gap" hint="Разница между нужной и текущей ценой: + поднять на, − можно снизить на" filter={false}>±</ThCtl>
              <ThCtl ctl={ctl} k="rev" hint="Сумма заказов за 30 дней, ₽">Заказы 30 дн</ThCtl>
            </tr></thead>
            <tbody>
              {shown.map(({ a, scheme, v, r, be, tp, beNo, tpNo, maxM, status, rev, factDrr, drrSrc }) => {
                const gap = tp ? tp - r.P : null;
                const why = `Даже при очень высокой цене маржа не выше ${pct1(maxM)}: комиссия ${pct1(v.commission)}, реклама ${pct1(v.drr)}, эквайринг ${pct1(v.acquiring)}, прочее ${pct1(v.other)}, налог ${pct1(v.tax)} от оплаты покупателя. Поднять маржу можно снижением ДРР или комиссии (другая схема / категория)`;
                return (
                  <tr key={a.i} className={status === 'loss' ? 's-hole' : ''}>
                    <td className="m-prod"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><i className="s-dot" style={{ background: CAT_COLORS[cats.topSlot(a.parts[0])] || OTHER }} />
                      <span title={`${a.n}\n${a.cat.split(SEP).join(' › ')}`}><b>{a.o}</b><small className="m-sub">{a.short} · {scheme.toUpperCase()} {pct1(v.commission)}</small></span></span></td>
                    <td className="n r">{fmtInt(r.P)}{v.spp ? <small className="m-sub" title="Цена для покупателя со скидкой Ozon">{fmtInt(r.buyerPrice)}</small> : null}</td>
                    <td className="n r">{v.cost ? fmtInt(v.cost) : <span className="pill m">нет</span>}</td>
                    <td className="r">
                      <input className={`a-input m-drr ${drrSrc !== 'fact' ? 'ed' : ''}`} type="number" min="0" max="100" step="0.5"
                        value={drrOver[a.o] ?? ''} placeholder={(drrSrc === 'all' ? Number(drrAll) : factDrr).toFixed(1)}
                        onChange={e => setOver(a.o, e.target.value)} title={`Фактический ДРР за 30 дней: ${pct1(factDrr)}`} />
                      {drrSrc !== 'fact' && <small className="m-sub">факт {pct1(factDrr)}</small>}
                    </td>
                    <td className="n r" title={`Комиссия ${fmtInt(r.commission)}, логистика ${fmtInt(r.logistics)} (×${r.trips.toFixed(2)}), эквайринг ${fmtInt(r.acquiring)}, прочее ${fmtInt(r.other)}, реклама ${fmtInt(r.ads)}, налог ${fmtInt(r.tax)}`}>
                      <b style={{ color: r.profit < 0 ? 'var(--a-bad)' : undefined }}>{fmtInt(r.profit)}</b></td>
                    <td className="r"><span className={`pill ${status === 'nocost' ? 'm' : r.profit < 0 ? 'b' : r.margin < target ? 'w' : 'g'}`}>{pct1(r.margin)}</span><small className="m-sub">ROI {pct1(r.roi)}</small></td>
                    <td className="n r">{be ? fmtInt(be) : beNo && v.cost ? (maxM > 0 ? <span className="m-no" title="Нужна цена больше чем в 3 раза выше текущей — пересмотрите себестоимость, рекламу или логистику">&gt; 3× цены</span> : <span className="m-no" title={why}>ценой не достичь</span>) : '—'}</td>
                    <td className="n r">{tp ? fmtInt(tp) : tpNo && v.cost ? (maxM > target ? <span className="m-no" title="Нужна цена больше чем в 3 раза выше текущей — пересмотрите себестоимость, рекламу или логистику">&gt; 3× цены</span> : <span className="m-no" title={why}>ценой не достичь<small className="m-sub">макс. {pct1(maxM)}</small></span>) : '—'}</td>
                    <td className="n r">{gap === null ? '—' : <span className={gap > 0 ? 's-down' : 's-up'} title={gap > 0 ? `Поднять цену на ${fmtInt(gap)} ₽: ${fmtInt(r.P)} → ${fmtInt(tp)}` : `Можно снизить на ${fmtInt(-gap)} ₽: ${fmtInt(r.P)} → ${fmtInt(tp)}`}>{gap > 0 ? '+' : '−'}{fmtInt(Math.abs(gap))}<small className="m-sub">{gap > 0 ? '+' : '−'}{Math.abs(gap / r.P * 100).toFixed(0)}%</small></span>}</td>
                    <td className="n r">{fmtInt(rev)}</td>
                  </tr>
                );
              })}
              {!shown.length && <tr><td colSpan={10} className="muted" style={{ padding: 16 }}>Нет товаров</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
