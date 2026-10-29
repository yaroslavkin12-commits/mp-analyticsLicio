import React, { useState, useMemo } from 'react';
import { isDeflyLike } from '../lib/cabinets';
import { fmtInt, fmtPct } from './AdsStats2';
import { StackChart, bucketsOf } from './SalesAnalytics';

// ─────────────────────────────────────────────────────────────────────────
// «Расход на рекламу по категориям» — блок внизу вкладки «Реклама».
// Категории Defly — учётные (как в отчётах компании), каждая собирается из
// категорий вкладки «Аналитика продаж» (там же артикул можно перенести
// вручную — перенос сразу действует и здесь).
// «Оплата за заказ» здесь — по ДНЮ СПИСАНИЯ (когда Ozon реально списал
// деньги), а не по дню заказа, как в таблице выше.
// ─────────────────────────────────────────────────────────────────────────

const ACC = [
  { id: '1', name: 'Автоодеяла' },
  { id: '2', name: 'Дефлекторы капота' },
  { id: '3', name: 'Дефлекторы окон' },
  { id: '3.1', parent: '3', name: '2D Дефлекторы окон' },
  { id: '4', name: 'Прочая покупная продукция' },
  { id: '4.1', parent: '4', name: 'ДО PSA' },
  { id: '4.2', parent: '4', name: 'Брызговики PSA' },
  { id: '4.3', parent: '4', name: 'Рамки' },
  { id: '4.4', parent: '4', name: 'Брызговики модельные (CHN)' },
  { id: '5', name: 'Прочая унив.шв.цех' },
  { id: '5.1', parent: '5', name: 'Подлокотники чехлы' },
  { id: '5.2', parent: '5', name: 'Утеплители радиатора' },
  { id: '6', name: 'Чехлы' },
  { id: '7', name: 'Крепления' },
  { id: '0', name: 'Без категории / без привязки к товару' },
];
// Licio — шесть категорий одежды, цвет закреплён за каждой.
const LICIO = ['Футболки', 'Лонгсливы', 'Худи', 'Свитшоты', 'Брюки', 'Шорты'];
// Цвет закреплён за категорией (не за местом в рейтинге).
const COLOR = { 1: 'var(--s-c4)', 2: 'var(--s-c2)', 3: 'var(--s-c1)', 4: 'var(--s-c6)', 5: 'var(--s-c5)', 6: 'var(--s-c3)', 7: 'var(--a-ink3)', 0: 'var(--a-ink3)' };

// Категория вкладки «Аналитика продаж» → учётная категория.
function accOf(cat, name) {
  const p = String(cat || '').split(' / ');
  const n = String(name || '');
  if (p[0] === 'Утеплители') return p[1] === 'Утеплитель радиатора' ? '5.2' : '1';
  if (p[0] === 'Дефлекторы') {
    if (p[1] === 'Капот') return '2';
    if (p[2] === '2D') return '3.1';
    if (p[2] === 'PSA') return '4.1';
    return '3'; // окна 3D и дефлекторы люка
  }
  if (p[0] === 'Чехлы') return p[1] === 'Чехлы на подлокотник' ? '5.1' : '6';
  if (p[0] === 'Аксессуары') {
    if (p[1] === 'Рамки') return '4.3';
    if (p[1] === 'Брызговики') return /psa/i.test(n) ? '4.2' : '4.4';
    if (p[1] === 'Крепёж') return '7';
    return '4';
  }
  return '0';
}

export default function AdSpendCats({ data, cabinet, tip }) {
  const [gran, setGran] = useState('day');
  const [open, setOpen] = useState(() => new Set());
  const dates = data?.dates || [];

  // Расход по каждому товару и дню: клик — из кампаний; заказ — из кампаний
  // (дни без отчёта по заказам, Ozon и так отдаёт их по дню списания) плюс
  // отчёт по заказам по дню списания.
  const model = useMemo(() => {
    if (!data) return null;
    const N = dates.length, di = new Map(dates.map((d, i) => [d, i]));
    const items = new Map();
    const itemOf = (key, o, name, cat) => {
      if (!items.has(key)) items.set(key, { key, o, name, cat, cpc: new Array(N).fill(0), cpo: new Array(N).fill(0) });
      return items.get(key);
    };
    for (const a of data.articles || []) {
      const it = itemOf(a.offerId || '__none__', a.offerId, a.productName, a.cat);
      if(data._wb){for(let i=0;i<N;i++){const d=a.byDate?.[dates[i]];it.cpc[i]=d?.spendCpc ?? NaN;it.cpo[i]=d?.spendOther ?? NaN;}continue;}
      for (const c of a.campaigns || []) {
        const fromReport = String(c.campaignId).startsWith('cpo:');
        for (let i = 0; i < N; i++) {
          const v = c.byDate?.[dates[i]];
          if (!v) continue;
          it.cpc[i] += v.spendCpc || 0;
          if (!fromReport) it.cpo[i] += v.spendCpo || 0;
        }
      }
    }
    for (const [o, d, v] of data.cpoCharge || []) {
      const i = di.get(d); if (i === undefined) continue;
      const extra = o ? data.catOfOffer?.[o] : null;
      const it = items.get(o || '__none__') || itemOf(o || '__none__', o, extra?.name, extra?.cat);
      it.cpo[i] += v;
    }
    const isDefly = isDeflyLike(cabinet);
    const rows = new Map();
    const rowOf = (id, name, parent) => {
      if (!rows.has(id)) rows.set(id, { id, name, parent, cpc: new Array(N).fill(0), cpo: new Array(N).fill(0), items: [] });
      return rows.get(id);
    };
    if (isDefly) ACC.forEach(c => rowOf(c.id, c.name, c.parent));
    else if (cabinet === 'licio') LICIO.forEach(c => rowOf(c, c));
    for (const it of items.values()) {
      it.tCpc = it.cpc.reduce((s, v) => s + v, 0); it.tCpo = it.cpo.reduce((s, v) => s + v, 0); it.total = it.tCpc + it.tCpo;
      if (!(it.total > 0)) continue;
      const id = !it.o ? '0' : isDefly ? accOf(it.cat, it.name) : (String(it.cat || '').split(' / ')[0] || '0');
      const r = rowOf(id, isDefly ? null : (id === '0' ? 'Без категории / без привязки к товару' : id));
      r.items.push(it);
      // В подкатегорию и в её родителя (родитель — итог «в т.ч.»).
      for (const target of [r, r.parent ? rows.get(r.parent) : null]) {
        if (!target) continue;
        for (let i = 0; i < N; i++) { target.cpc[i] += it.cpc[i]; target.cpo[i] += it.cpo[i]; }
      }
    }
    for (const r of rows.values()) {
      r.tCpc = r.cpc.reduce((s, v) => s + v, 0); r.tCpo = r.cpo.reduce((s, v) => s + v, 0); r.total = r.tCpc + r.tCpo;
      r.items.sort((x, y) => y.total - x.total);
    }
    let list = [...rows.values()];
    const rank = id => { const i = LICIO.indexOf(id); return i >= 0 ? i : id === '0' ? 1e6 : 1e5; };
    if (!isDefly) list.sort((x, y) => rank(x.id) - rank(y.id) || y.total - x.total);
    const top = list.filter(r => !r.parent);
    const known=!data._wb||data.availability?.ads; const grand = known?top.reduce((s, r) => s + r.total, 0):NaN;
    const gCpc = top.reduce((s, r) => s + r.tCpc, 0), gCpo = top.reduce((s, r) => s + r.tCpo, 0);
    return { list, top, grand, gCpc:known?gCpc:NaN, gCpo:known?gCpo:NaN, isDefly };
  }, [data, dates, cabinet]);

  if (!model) return null;
  const buckets = bucketsOf(dates, gran);
  // График — по верхним категориям; «Крепления» и «без категории» — одной серой полосой.
  const chartGroups = (() => {
    if (!model.isDefly) {
      const shown = model.top.filter(r => r.total > 0 && LICIO.includes(r.id));
      const rest = model.top.filter(r => !shown.includes(r));
      const g = shown.map(r => ({ key: r.id, name: r.name, color: `var(--s-c${LICIO.indexOf(r.id) + 1})`, ag: { s: { spendCpc: r.cpc, spendCpo: r.cpo } } }));
      if (rest.some(r => r.total > 0)) {
        const N = dates.length, cpc = new Array(N).fill(0), cpo = new Array(N).fill(0);
        rest.forEach(r => { for (let i = 0; i < N; i++) { cpc[i] += r.cpc[i]; cpo[i] += r.cpo[i]; } });
        g.push({ key: 'rest', name: 'Остальное', color: 'var(--a-ink3)', ag: { s: { spendCpc: cpc, spendCpo: cpo } } });
      }
      return g;
    }
    const byId = new Map(model.top.map(r => [r.id, r]));
    const g = ['1', '2', '3', '4', '5', '6'].map(id => byId.get(id)).filter(r => r && r.total > 0)
      .map(r => ({ key: r.id, name: `${r.id}. ${r.name}`, color: COLOR[r.id], ag: { s: { spendCpc: r.cpc, spendCpo: r.cpo } } }));
    const r7 = byId.get('7'), r0 = byId.get('0'), N = dates.length;
    if ((r7?.total || 0) + (r0?.total || 0) > 0) {
      const cpc = new Array(N).fill(0), cpo = new Array(N).fill(0);
      for (const r of [r7, r0]) if (r) for (let i = 0; i < N; i++) { cpc[i] += r.cpc[i]; cpo[i] += r.cpo[i]; }
      g.push({ key: 'rest', name: '7. Крепления и без категории', color: 'var(--a-ink3)', ag: { s: { spendCpc: cpc, spendCpo: cpo } } });
    }
    return g;
  })();

  const toggle = id => setOpen(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const share = v => model.grand > 0 ? v / model.grand * 100 : null;

  const catRow = r => {
    const child = !!r.parent;
    const isOpen = open.has(r.id);
    const label = model.isDefly ? (r.id === '0' ? r.name : `${r.id}. ${r.name}`) : r.name;
    return (
      <React.Fragment key={r.id}>
        <tr className={`row ${isOpen ? 'open' : ''}`} onClick={() => r.items.length && toggle(r.id)} style={{ cursor: r.items.length ? 'pointer' : 'default' }}>
          <td>
            <div className="a-art" style={{ paddingLeft: child ? 22 : 0 }}>
              <span className="a-chev" style={{ visibility: r.items.length ? 'visible' : 'hidden' }}>▶</span>
              {!child && <i className="s-dot" style={{ background: model.isDefly ? COLOR[r.id] : LICIO.includes(r.id) ? `var(--s-c${LICIO.indexOf(r.id) + 1})` : 'var(--a-ink3)', marginRight: 6 }} />}
              {child ? <span className="muted">в т.ч. </span> : null}
              {child ? label : <b>{label}</b>}
            </div>
          </td>
          <td className="n r">{r.tCpc ? fmtInt(r.tCpc) : '—'}</td>
          <td className="n r">{r.tCpo ? fmtInt(r.tCpo) : '—'}</td>
          <td className="n r">{!r.total ? <span className="muted">—</span> : child ? fmtInt(r.total) : <b>{fmtInt(r.total)}</b>}</td>
          <td className="n r muted">{r.total ? fmtPct(share(r.total)) : '—'}</td>
        </tr>
        {isOpen && r.items.slice(0, 40).map(it => (
          <tr key={r.id + '|' + it.key} className="a-sub">
            <td><div className="a-art" style={{ paddingLeft: child ? 44 : 22 }} title={it.name || ''}>
              <b>{it.o || '—'}</b>&nbsp;<span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 }}>{it.o ? (it.name || '') : 'кампании без привязки к товару'}</span>
            </div></td>
            <td className="n r">{it.tCpc ? fmtInt(it.tCpc) : '—'}</td>
            <td className="n r">{it.tCpo ? fmtInt(it.tCpo) : '—'}</td>
            <td className="n r">{fmtInt(it.total)}</td>
            <td className="n r muted">{fmtPct(share(it.total))}</td>
          </tr>
        ))}
        {isOpen && r.items.length > 40 && (
          <tr className="a-sub"><td colSpan={5} className="muted" style={{ paddingLeft: child ? 66 : 44 }}>…и ещё {r.items.length - 40} арт.</td></tr>
        )}
      </React.Fragment>
    );
  };

  return (
    <div className="a-card" style={{ marginTop: 16 }}>
      <div className="a-bar" style={{ marginBottom: 6 }}>
        <b style={{ fontSize: 14 }}>Расход на рекламу по категориям</b>
        <span className="a-hint" style={{ margin: 0 }}>за период: <b>{fmtInt(model.grand)} ₽</b> · клик {fmtInt(model.gCpc)} · {data._wb ? 'показы / прочее' : 'заказ'} {fmtInt(model.gCpo)}</span>
        <span className="a-seg" style={{ marginLeft: 'auto' }}>
          {[['day', 'Дни'], ['week', 'Недели'], ['month', 'Месяцы']].map(([v, l]) => (
            <button key={v} type="button" className={gran === v ? 'on' : ''} onClick={() => setGran(v)}>{l}</button>
          ))}
        </span>
      </div>
      <div className="a-hint" style={{ marginBottom: 10, padding: '6px 10px', borderLeft: '3px solid var(--s-c4)', background: 'var(--a-panel2, transparent)' }}>
        {data._wb ? <>Расходы WB по дням рекламы. Оплата за показы и кампании с неизвестным типом оплаты показаны отдельно от оплаты за клик.</> : <>⚠ «Оплата за заказ» в этом блоке начислена <b>в день списания</b> — когда Ozon фактически списал деньги (после выкупа заказа).
        В таблице выше она отнесена ко дню заказа, поэтому суммы за один и тот же период могут отличаться.
        «Оплата за клик» — в день показа, одинаково в обоих местах.</>}
      </div>
      {chartGroups.length > 0
        ? <StackChart buckets={buckets} groups={chartGroups} metric="spend" tip={tip} gran={gran} labels />
        : <div className="a-empty" style={{ padding: 24 }}>{data._wb && !data.availability?.ads ? 'Данные о расходах за весь период пока не получены.' : 'За период расходов на рекламу нет.'}</div>}
      <div className="a-scroll" style={{ marginTop: 12 }}>
        <table className="a-t s-slice">
          <thead><tr>
            <th>Категория</th><th className="r">Оплата за клик, ₽</th>
            <th className="r" title="По дню списания">{data._wb ? 'За показы / прочее, ₽' : <>Оплата за заказ, ₽ <span className="muted">(по дню списания)</span></>}</th>
            <th className="r">Всего, ₽</th><th className="r">Доля</th>
          </tr></thead>
          <tbody>{model.list.filter(r => r.total > 0 || (model.isDefly && r.id !== '0') || LICIO.includes(r.id)).map(catRow)}</tbody>
          <tfoot><tr>
            <td><b>Итого</b></td><td className="n r"><b>{fmtInt(model.gCpc)}</b></td><td className="n r"><b>{fmtInt(model.gCpo)}</b></td>
            <td className="n r"><b>{fmtInt(model.grand)}</b></td><td className="n r muted">100%</td>
          </tr></tfoot>
        </table>
      </div>
      <div className="a-hint" style={{ marginTop: 8 }}>
        {data._wb ? <>Расходы без подтверждённой привязки к товару показаны отдельно вверху страницы.</> : <>«Без категории / без привязки к товару» — расход кампаний, которые Ozon не разносит по товарам (например, «Оплата за заказ — все товары»,
        пока за эти дни нет отчёта по её заказам). Как только отчёт подгрузится, расход разойдётся по товарам и категориям.</>}
      </div>
      {model.isDefly && (
        <div className="a-hint" style={{ marginTop: 8 }}>
          Категории собираются из категорий вкладки «Аналитика продаж»: окна 2D → 3.1, окна PSA → 4.1, брызговики с «PSA» в названии → 4.2, остальные брызговики → 4.4,
          щётки/коврики/прочие аксессуары → 4, утеплитель двигателя (автоодеяло) → 1, дефлекторы люка → 3. Если артикул попал не туда — перенесите его в «Аналитике продаж»,
          здесь он переедет автоматически. Строки «в т.ч.» уже входят в итог своей категории.
        </div>
      )}
    </div>
  );
}
