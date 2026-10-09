import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import { getDiscountOverview } from '../api';
import { fmtInt, Delta, naturalCompare, shortModel, CAT_COLORS } from './AdsStats2';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// Соинвест Ozon по категориям: категория → подкатегория → артикул.
// Средний Соинвест считается с весом по выручке за 30 дней (так он
// показывает, сколько реально даёт Ozon на продажах), рядом — простое
// среднее, изменение за сутки и неделю, разброс и цены по артикулу.
// Цены собирает расширение браузера «Соинвест Ozon» (см. browser-extension/).
// ─────────────────────────────────────────────────────────────────────────

const SEP = ' / ';
const OTHER = 'var(--a-ink3)';
const pct = v => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : `${v.toFixed(1).replace('.', ',')}%`;
const BUCKETS = [[0, 0.05, '0%'], [0.05, 5, 'до 5%'], [5, 10, '5–10%'], [10, 20, '10–20%'], [20, 30, '20–30%'], [30, 101, '30%+']];

function stats(list) {
  let w = 0, ws = 0, s = 0, n = 0, d1w = 0, d1n = 0, d7w = 0, d7n = 0, min = Infinity, max = -Infinity, rev = 0, up = 0, down = 0;
  for (const a of list) {
    const weight = a.revenue30 || 0;
    w += weight; ws += weight * a.pct; s += a.pct; n++; rev += weight;
    if (a.pct < min) min = a.pct; if (a.pct > max) max = a.pct;
    if (a.d1 !== null) { d1w += a.d1; d1n++; if (a.d1 >= 0.5) up++; if (a.d1 <= -0.5) down++; }
    if (a.d7 !== null) { d7w += a.d7; d7n++; }
  }
  return {
    n, rev, avgW: w ? ws / w : (n ? s / n : null), avg: n ? s / n : null,
    d1: d1n ? d1w / d1n : null, d7: d7n ? d7w / d7n : null, min: n ? min : null, max: n ? max : null, up, down,
  };
}

export default function SoinvestCats({ cabinet }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [sort, setSort] = useState({ key: 'rev', dir: -1 });

  const load = useCallback(() => {
    setLoading(true);
    getDiscountOverview(cabinet).then(r => setData(r.data.data)).catch(() => setData({ items: [] })).finally(() => setLoading(false));
  }, [cabinet]);
  useEffect(() => { load(); }, [load]);

  const items = useMemo(() => (data?.items || []).map(a => ({ ...a, parts: a.cat.split(SEP), short: shortModel(a.n) || a.n })), [data]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(a => (!sel || a.cat === sel || a.cat.startsWith(sel + SEP)) && (!q || a.o.toLowerCase().includes(q) || a.n.toLowerCase().includes(q)));
  }, [items, sel, search]);
  const tops = useMemo(() => {
    // Тот же порядок (и цвета), что в «Аналитике продаж».
    const rank = new Map(['Чехлы', 'Дефлекторы', 'Утеплители', 'Аксессуары'].map((x, i) => [x, i]));
    return [...new Set(items.map(a => a.parts[0]))].sort((x, y) => ((rank.has(x) ? rank.get(x) : 99) - (rank.has(y) ? rank.get(y) : 99)) || naturalCompare(x, y));
  }, [items]);

  if (loading && !data) return <div className="mpui"><div className="a-empty" style={{ padding: 40, textAlign: 'center' }}>Загрузка…</div></div>;

  const last = data?.lastCheckedAt ? dayjs(data.lastCheckedAt) : null;
  const ageH = last ? dayjs().diff(last, 'minute') / 60 : null;
  if (!items.length) {
    return (
      <div className="mpui">
        <div className="a-card" style={{ padding: 22, lineHeight: 1.6 }}>
          <b>Данных о Соинвесте по этому кабинету пока нет.</b><br />
          Цену на витрине с учётом Соинвеста Ozon отдаёт только кабинет продавца, а запросы с серверов Ozon блокирует.
          Поэтому цены собирает маленькое расширение браузера «Соинвест Ozon» — в том браузере, где вы вошли в seller.ozon.ru.
          Оно раз в час берёт цены по всем товарам Licio и Defly и присылает сюда. Как поставить — в файле README рядом с расширением.
        </div>
      </div>
    );
  }

  const depth = sel ? sel.split(SEP).length : 0;
  const all = stats(filtered);
  const groupBy = (list, d) => {
    const m = new Map();
    for (const a of list) { const k = a.parts[d]; if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(a); }
    return m;
  };
  const sortVal = (st, a) => {
    switch (sort.key) {
      case 'avg': return st.avgW ?? -1; case 'd1': return st.d1 ?? -999; case 'd7': return st.d7 ?? -999; case 'n': return st.n;
      default: return st.rev + (a ? 0 : 0);
    }
  };
  const rows = [];
  const pushLevel = (list, d, prefix) => {
    const m = groupBy(list, d);
    const groups = [...m.entries()].map(([k, l]) => ({ k, l, st: stats(l) })).sort((x, y) => (sortVal(x.st) - sortVal(y.st)) * sort.dir);
    groups.forEach(({ k, l, st }, gi) => {
      const path = prefix ? prefix + SEP + k : k;
      const isOpen = open.has(path);
      const color = d === 0 ? (CAT_COLORS[tops.indexOf(k)] || OTHER) : null;
      rows.push(
        <tr key={'c' + path} className={`row s-cat d${d - depth} ${isOpen ? 'open' : ''}`} onClick={() => setOpen(p => { const n = new Set(p); n.has(path) ? n.delete(path) : n.add(path); return n; })}>
          <td><div className="a-art" style={{ paddingLeft: (d - depth) * 16 }}><span className="a-chev">▶</span>{color && <i className="s-dot" style={{ background: color }} />}<span className="s-cname">{k}</span><span className="a-hint">{l.length}</span>
            <button type="button" className="s-focus" title="Показать только эту категорию" onClick={e => { e.stopPropagation(); setSel(path); }}>⌕</button></div></td>
          <td className="r"><b className="n">{pct(st.avgW)}</b></td>
          <td className="n r muted">{pct(st.avg)}</td>
          <td className="r"><Delta value={st.d1} unit="pp" goodWhen="up" /></td>
          <td className="r"><Delta value={st.d7} unit="pp" goodWhen="up" /></td>
          <td className="n r muted">{pct(st.min)} – {pct(st.max)}</td>
          <td className="n r">{fmtInt(st.rev)}</td>
          <td colSpan={3} />
        </tr>
      );
      if (!isOpen) return;
      const deeper = l.some(a => a.parts.length > d + 1);
      if (deeper) pushLevel(l, d + 1, path);
      else [...l].sort((x, y) => (sort.key === 'avg' ? y.pct - x.pct : sort.key === 'd1' ? (y.d1 ?? -999) - (x.d1 ?? -999) : y.revenue30 - x.revenue30)).slice(0, 200).forEach(a => {
        rows.push(
          <tr key={'a' + a.o} className="s-art">
            <td><div className="a-art" style={{ paddingLeft: (d - depth + 1) * 16 + 14 }}><div style={{ minWidth: 0 }}><div className="id">{a.o}</div><div className="model" title={a.n}>{a.short}</div></div></div></td>
            <td className="r"><b className="n">{pct(a.pct)}</b></td>
            <td />
            <td className="r"><Delta value={a.d1} unit="pp" goodWhen="up" /></td>
            <td className="r"><Delta value={a.d7} unit="pp" goodWhen="up" /></td>
            <td />
            <td className="n r">{fmtInt(a.revenue30)}</td>
            <td className="n r">{fmtInt(a.seller)}</td>
            <td className="n r">{fmtInt(a.site)}</td>
            <td className="n r">{a.card ? fmtInt(a.card) : '—'}</td>
          </tr>
        );
      });
    });
  };
  pushLevel(filtered, depth, sel);

  const dist = BUCKETS.map(([lo, hi, label]) => ({ label, n: filtered.filter(a => a.pct >= lo && a.pct < hi).length }));
  const distMax = Math.max(1, ...dist.map(x => x.n));
  const crumbs = sel ? sel.split(SEP) : [];
  const TH = (k, t) => <th className={`r ${k ? 'sortable' : ''} ${sort.key === k ? 'sorted' : ''}`} onClick={() => k && setSort(p => p.key === k ? { key: k, dir: -p.dir } : { key: k, dir: -1 })}>{t}{sort.key === k ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>;

  return (
    <div className="mpui">
      <div className="a-bar">
        <span className="a-fresh" style={{ marginLeft: 0 }}>
          <span className={`a-dot ${ageH === null ? 'bad' : ageH > 6 ? 'bad' : ageH > 2 ? 'warn' : ''}`} />
          {last ? `Цены обновлены ${last.format('DD.MM HH:mm')}` : 'Цены ещё не собирались'}
          {ageH !== null && ageH > 2 && ' — проверьте, что браузер с расширением открыт и вы вошли в seller.ozon.ru'}
        </span>
        <input className="a-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Артикул или название" style={{ marginLeft: 'auto', minWidth: 220 }} />
      </div>
      <div className="a-bar">
        <div className="a-tabs">
          <button type="button" className={`a-tab ${!sel ? 'on' : ''}`} onClick={() => setSel('')}>Все<span className="c">{items.length}</span></button>
          {tops.map((c, i) => (
            <button key={c} type="button" className={`a-tab ${sel === c || sel.startsWith(c + SEP) ? 'on' : ''}`} onClick={() => setSel(c)}>
              <i className="s-dot" style={{ background: CAT_COLORS[i] || OTHER }} />{c}<span className="c">{items.filter(a => a.parts[0] === c).length}</span>
            </button>
          ))}
        </div>
      </div>
      {sel && (
        <div className="a-bar s-crumbs">
          <button type="button" className="s-crumb" onClick={() => setSel('')}>Все</button>
          {crumbs.map((c, i) => (
            <React.Fragment key={i}><span className="a-hint">›</span>
              <button type="button" className={`s-crumb ${i === crumbs.length - 1 ? 'on' : ''}`} onClick={() => setSel(crumbs.slice(0, i + 1).join(SEP))}>{c}</button>
            </React.Fragment>
          ))}
        </div>
      )}

      <div className="a-kpis s-kpis">
        <div className="a-kpi"><span className="lbl">Средний Соинвест (по выручке)</span><span className="val n">{pct(all.avgW)}</span>
          <span className="sub"><Delta value={all.d1} unit="pp" goodWhen="up" /> за сутки · <Delta value={all.d7} unit="pp" goodWhen="up" /> за неделю</span></div>
        <div className="a-kpi"><span className="lbl">Простое среднее по товарам</span><span className="val n">{pct(all.avg)}</span>
          <span className="sub">разброс {pct(all.min)} – {pct(all.max)}</span></div>
        <div className="a-kpi"><span className="lbl">Товаров с Соинвестом</span><span className="val n">{fmtInt(filtered.filter(a => a.pct >= 0.05).length)} <small className="s-of">из {fmtInt(filtered.length)}</small></span>
          <span className="sub">у остальных Ozon не доплачивает</span></div>
        <div className="a-kpi"><span className="lbl">Изменилось за сутки</span><span className="val n">{fmtInt(all.up + all.down)}</span>
          <span className="sub"><span style={{ color: 'var(--a-good)' }}>▲ {all.up}</span> · <span style={{ color: 'var(--a-bad)' }}>▼ {all.down}</span> (на 0,5 п.п. и больше)</span></div>
      </div>

      <div className="a-card" style={{ padding: 14 }}>
        <div className="a-bar" style={{ marginBottom: 8 }}><b style={{ fontSize: 14 }}>Распределение товаров по Соинвесту</b></div>
        <div className="sv-dist">
          {dist.map(b => (
            <div key={b.label} className="sv-col" title={`${b.label}: ${b.n} товаров`}>
              <span className="n">{b.n}</span>
              <div className="sv-bar"><i style={{ height: `${b.n / distMax * 100}%` }} /></div>
              <span className="a-hint">{b.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className={`a-card ${loading ? 'a-loading' : ''}`}>
        <div className="a-scroll">
          <table className="a-t s-tree">
            <thead><tr>
              <th>Категория / артикул</th>{TH('avg', 'Соинвест')}{TH(null, 'Среднее')}{TH('d1', 'За сутки')}{TH('d7', 'За неделю')}{TH(null, 'Разброс')}
              {TH('rev', 'Выручка 30 дн, ₽')}{TH(null, 'Цена продавца')}{TH(null, 'На сайте')}{TH(null, 'С Ozon Картой')}
            </tr></thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
      </div>
      <div className="a-hint">Соинвест = (цена продавца − цена на сайте) / цена продавца. «Соинвест» в строках категорий — среднее с весом по выручке за 30 дней.</div>
    </div>
  );
}
