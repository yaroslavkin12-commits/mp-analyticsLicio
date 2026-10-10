import React, { useState, useEffect, useMemo } from 'react';
import { getCalcBase } from '../api';
import { fmtInt, CAT_COLORS } from './AdsStats2';
import { baseOf, compute, priceFor, DEFAULTS } from './Calculator';
import { useCats, useGroups, FinHeader, Kpi, inPath, matchQ, pct1, useTax, OTHER, SEP } from './finShared';
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
  const [withAds, setWithAds] = useState(true);
  const [flt, setFlt] = useState(null);
  const [sortKey, setSortKey] = useState('margin');
  const [tax] = useTax(cabinet);
  const grp = useGroups(cabinet);

  useEffect(() => { setData(null); getCalcBase(cabinet).then(r => setData(r.data.data)).catch(e => setError(e.response?.data?.error || e.message)); }, [cabinet]);
  const cats = useCats(data?.articles, data?.order);

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
        spp: own.spp ?? 0, cost: x[12] || 0, buyout: pick('buyout'), defect: 0, commission: commission ?? DEFAULTS.commission,
        acquiring: pick('acquiring'), direct: pick('direct'), ret: pick('ret'), other: pick('other'), drr: withAds ? Math.min(100, pick('drr', b => b.orders >= 5)) : 0, oper: 0, tax,
      };
      const price = x[1];
      const r = compute(v, price, 'usn_income');
      const be = priceFor(v, 'usn_income', 0), tp = priceFor(v, 'usn_income', target);
      const status = !x[12] ? 'nocost' : r.profit < 0 ? 'loss' : r.margin < target ? 'below' : 'ok';
      out.push({ a, x, scheme, v, r, be, tp, status, orders: x[25], rev: x[24] });
    }
    return out;
  }, [data, cats.arts, target, withAds, tax]);

  const q = search.trim().toLowerCase();
  const base = rows.filter(r => inPath(r.a, sel) && matchQ(r.a, q) && grp.test(r.a));
  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, base.filter(r => r.status === k).length]));
  const sortFn = {
    margin: r => (r.status === 'nocost' ? 1e9 : r.r.margin ?? 1e9), profit: r => r.r.profit, rev: r => -r.rev, gap: r => (r.tp ? r.r.P - r.tp : 1e9),
  }[sortKey];
  const shown = (flt ? base.filter(r => r.status === flt) : base).sort((a, b) => sortFn(a) - sortFn(b)).slice(0, 500);
  const withCost = base.filter(r => r.status !== 'nocost');
  const avgMargin = (() => { let p = 0, rv = 0; for (const r of withCost) { p += r.r.profit * r.orders; rv += r.r.P * r.orders; } return rv ? p / rv * 100 : null; })();
  const lossRev = base.filter(r => r.status === 'loss').reduce((s, r) => s + r.rev, 0);
  const th = (k, l, t) => <th className={`r ${sortKey === k ? 'on' : ''}`} style={{ cursor: 'pointer' }} title={t} onClick={() => setSortKey(k)}>{l}{sortKey === k ? ' ↑' : ''}</th>;

  if (error) return <div className="mpui"><div className="a-empty" style={{ padding: 40 }}>Не удалось загрузить: {error}</div></div>;
  if (!data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Загрузка…</div></div>;

  return (
    <div className="mpui sa-page">
      <FinHeader title="Цены и маржа" cats={cats} sel={sel} setSel={setSel} search={search} setSearch={setSearch} grp={grp}>
        <label className="a-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>целевая маржа
          <input className="a-input" type="number" min="0" max="80" value={target} onChange={e => setTarget(Math.max(0, Number(e.target.value) || 0))} style={{ width: 60, padding: '4px 8px' }} />%
        </label>
        <label className="sw"><input type="checkbox" checked={withAds} onChange={e => setWithAds(e.target.checked)} /><i />с учётом рекламы</label>
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
        <div className="a-scroll">
          <table className="a-t s-slice">
            <thead><tr>
              <th>Товар</th><th>Схема</th><th className="r">Цена</th><th className="r" title="Цена для покупателя со скидкой Ozon (СПП)">Покупатель</th><th className="r">Себест.</th>
              {th('profit', 'Прибыль / шт')}{th('margin', 'Маржа')}<th className="r">ROI</th>
              <th className="r" title="Цена, при которой прибыль = 0">Безубыточность</th><th className="r">Цена для {target}%</th>{th('gap', 'Изменить цену', 'Насколько поднять/можно снизить цену до целевой маржи')}
              {th('rev', 'Заказы 30 дн, ₽')}
            </tr></thead>
            <tbody>
              {shown.map(({ a, scheme, v, r, be, tp, status, rev }) => {
                const gap = tp ? tp - r.P : null;
                return (
                  <tr key={a.i} className={status === 'loss' ? 's-hole' : ''}>
                    <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><i className="s-dot" style={{ background: CAT_COLORS[cats.topSlot(a.parts[0])] || OTHER }} />
                      <span title={`${a.n}\n${a.cat.split(SEP).join(' › ')}`}><b>{a.o}</b> <span className="muted">{a.short}</span></span></span></td>
                    <td className="muted">{scheme.toUpperCase()} · {pct1(v.commission)}</td>
                    <td className="n r">{fmtInt(r.P)}</td>
                    <td className="n r muted">{v.spp ? fmtInt(r.buyerPrice) : '—'}</td>
                    <td className="n r">{v.cost ? fmtInt(v.cost) : <span className="pill m">нет</span>}</td>
                    <td className="n r" title={`Комиссия ${fmtInt(r.commission)}, логистика ${fmtInt(r.logistics)} (×${r.trips.toFixed(2)}), эквайринг ${fmtInt(r.acquiring)}, прочее ${fmtInt(r.other)}, реклама ${fmtInt(r.ads)}, налог ${fmtInt(r.tax)}`}>
                      <b style={{ color: r.profit < 0 ? 'var(--a-bad)' : undefined }}>{fmtInt(r.profit)}</b></td>
                    <td className="r"><span className={`pill ${status === 'nocost' ? 'm' : r.profit < 0 ? 'b' : r.margin < target ? 'w' : 'g'}`}>{pct1(r.margin)}</span></td>
                    <td className="n r muted">{pct1(r.roi)}</td>
                    <td className="n r">{be ? fmtInt(be) : '—'}</td>
                    <td className="n r">{tp ? fmtInt(tp) : '—'}</td>
                    <td className="n r">{gap === null ? '—' : <span className={gap > 0 ? 's-down' : 's-up'}>{gap > 0 ? '+' : ''}{fmtInt(gap)} ({gap > 0 ? '+' : ''}{(gap / r.P * 100).toFixed(0)}%)</span>}</td>
                    <td className="n r">{fmtInt(rev)}</td>
                  </tr>
                );
              })}
              {!shown.length && <tr><td colSpan={12} className="muted" style={{ padding: 16 }}>Нет товаров</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
