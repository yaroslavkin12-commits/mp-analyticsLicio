import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import dayjs from 'dayjs';
import { getSalesData, setSalesCategory } from '../api';
import DateRangePicker from '../components/DateRangePicker';
import {
  fmtInt, fmtPct, fmtBy, heatColor, naturalCompare, shortModel, derive, changePct, Delta,
  AreaSpark, SparkBars, useTip, DualChart, Funnel, DaysTable, drrClass, CHART_METRICS,
} from './AdsStats2';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «Аналитика продаж» — весь кабинет и категории товаров.
// Данные: GET /api/sales/data (все артикулы по дням, компактно). Всё
// суммирование — здесь, поэтому фильтры (категория, марка авто, поиск)
// и срезы считаются мгновенно.
// ─────────────────────────────────────────────────────────────────────────

const K = ['views', 'pdpViews', 'cart', 'orders', 'revenue', 'spendCpc', 'spendCpo', 'clicks', 'adOrders', 'adRevenue'];
const SEP = ' / ';
// Цвета категорий (проверены на различимость, в т.ч. при дальтонизме).
// Цвет закреплён за категорией по её месту в справочнике, а не по рангу.
const CAT_COLORS = ['var(--s-c1)', 'var(--s-c2)', 'var(--s-c3)', 'var(--s-c4)', 'var(--s-c5)', 'var(--s-c6)'];
const OTHER_COLOR = 'var(--a-ink3)';
const HIDE_DAY_ROWS = ['avgCpcSearch', 'avgCpcRec'];
const SALES_CHART_METRICS = CHART_METRICS.filter(m => !['avgCpcSearch', 'avgCpcRec'].includes(m.key));

const fmtShort = v => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',')} млн`;
  if (a >= 1e3) return `${Math.round(v / 1e3)} тыс`;
  return String(Math.round(v));
};
const perDayTxt = v => v === null ? '—' : v.toFixed(v < 10 ? 1 : 0).replace('.', ',');

// ── Подготовка данных ────────────────────────────────────────────────────
function prepare(data) {
  const n = data.dates.length;
  const arts = data.articles.map((a, i) => {
    const o = { ...a, i, parts: a.cat.split(SEP), stockArr: new Array(n).fill(null), pos: new Array(n).fill(null), prev: null };
    for (const k of K) o[k] = new Float64Array(n);
    return o;
  });
  for (const r of data.rows) {
    const a = arts[r[0]], d = r[1];
    a.views[d] = r[2]; a.pdpViews[d] = r[3]; a.cart[d] = r[4]; a.orders[d] = r[5]; a.revenue[d] = r[6];
    a.spendCpc[d] = r[7]; a.spendCpo[d] = r[8]; a.clicks[d] = r[9]; a.adOrders[d] = r[10]; a.adRevenue[d] = r[11];
    if (r[12] !== null) a.pos[d] = r[12];
  }
  // Остаток: в данных только дни, когда он менялся — переносим вперёд.
  const byArt = new Map();
  for (const [ai, d, v] of data.stock) { if (!byArt.has(ai)) byArt.set(ai, []); byArt.get(ai).push([d, v]); }
  for (const [ai, pts] of byArt) {
    const arr = arts[ai].stockArr;
    for (let p = 0; p < pts.length; p++) {
      const end = p + 1 < pts.length ? pts[p + 1][0] : n;
      for (let d = pts[p][0]; d < end; d++) arr[d] = pts[p][1];
    }
  }
  for (const p of data.prev || []) {
    arts[p[0]].prev = { views: p[1], pdpViews: p[2], cart: p[3], orders: p[4], revenue: p[5], spend: p[6], adOrders: p[7] };
  }
  for (const a of arts) {
    let rev = 0, ord = 0, sp = 0;
    for (let d = 0; d < n; d++) { rev += a.revenue[d]; ord += a.orders[d]; sp += a.spendCpc[d] + a.spendCpo[d]; }
    a.tRevenue = rev; a.tOrders = ord; a.tSpend = sp;
    a.short = shortModel(a.n) || a.n;
  }
  return arts;
}

// Сумма по набору артикулов: массивы по дням + итоги + прошлый период.
function aggregate(list, n) {
  const s = {};
  for (const k of K) s[k] = new Float64Array(n);
  const stock = new Array(n).fill(null);
  let stockNow = null, prev = null, active = 0;
  for (const a of list) {
    for (const k of K) { const src = a[k], dst = s[k]; for (let d = 0; d < n; d++) dst[d] += src[d]; }
    for (let d = 0; d < n; d++) if (a.stockArr[d] !== null) stock[d] = (stock[d] || 0) + a.stockArr[d];
    if (a.st !== null && a.st !== undefined) stockNow = (stockNow || 0) + a.st;
    if (a.prev) {
      prev = prev || { views: 0, pdpViews: 0, cart: 0, orders: 0, revenue: 0, spend: 0, adOrders: 0 };
      for (const k of Object.keys(prev)) prev[k] += a.prev[k] || 0;
    }
    if (a.tOrders > 0) active++;
  }
  return { s, stock, stockNow, prev, count: list.length, active, single: list.length === 1 ? list[0] : null };
}

// Модель в формате компонентов «Рекламы» (byDate, totals, prev), с
// разбивкой по дням, неделям или месяцам.
function bucketsOf(dates, gran) {
  if (gran === 'day') return dates.map((d, i) => ({ key: d, idx: [i] }));
  const map = new Map();
  dates.forEach((d, i) => {
    const key = gran === 'week' ? dayjs(d).subtract((dayjs(d).day() + 6) % 7, 'day').format('YYYY-MM-DD') : d.slice(0, 8) + '01';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(i);
  });
  return [...map.entries()].map(([key, idx]) => ({ key, idx }));
}
function toModel(ag, buckets) {
  const byDate = {};
  const tot = {};
  for (const k of K) tot[k] = 0;
  for (const b of buckets) {
    const raw = {};
    for (const k of K) { let v = 0; for (const i of b.idx) v += ag.s[k][i]; raw[k] = v; tot[k] += v; }
    raw.spend = raw.spendCpc + raw.spendCpo;
    let st = null;
    for (const i of b.idx) if (ag.stock[i] !== null) st = ag.stock[i];
    let pos = null;
    if (ag.single) { const ps = b.idx.map(i => ag.single.pos[i]).filter(v => v !== null); pos = ps.length ? ps.reduce((x, y) => x + y, 0) / ps.length : null; }
    byDate[b.key] = { ...derive(raw, 'all'), stock: st, position: pos, avgCpc: raw.clicks > 0 ? raw.spendCpc / raw.clicks : null };
  }
  tot.spend = tot.spendCpc + tot.spendCpo;
  const totals = derive(tot, 'all');
  totals.avgCpc = tot.clicks > 0 ? tot.spendCpc / tot.clicks : null;
  const prev = ag.prev ? derive({ ...ag.prev, spendCpc: 0, spendCpo: 0, clicks: 0 }, 'all') : null;
  if (prev) { prev.spend = ag.prev.spend; prev.drr = ag.prev.revenue > 0 ? ag.prev.spend / ag.prev.revenue * 100 : null; prev.adOrders = ag.prev.adOrders; }
  return { byDate, totals, prev, stockNow: ag.stockNow };
}

// Дерево категорий из путей артикулов.
function buildTree(arts, order) {
  const rank = new Map(order.map((x, i) => [x, i]));
  const root = { path: '', name: 'Все', depth: 0, children: new Map(), arts: [] };
  for (const a of arts) {
    let node = root;
    node.arts.push(a);
    a.parts.forEach((name, i) => {
      const path = a.parts.slice(0, i + 1).join(SEP);
      if (!node.children.has(name)) node.children.set(name, { path, name, depth: i + 1, children: new Map(), arts: [], parent: node });
      node = node.children.get(name);
      node.arts.push(a);
    });
  }
  const finish = node => {
    node.kids = [...node.children.values()].sort((x, y) => {
      const rx = rank.has(x.name) ? rank.get(x.name) : 1e6, ry = rank.has(y.name) ? rank.get(y.name) : 1e6;
      return rx !== ry ? rx - ry : naturalCompare(x.name, y.name);
    });
    node.kids.forEach((k, i) => { k.slot = i; finish(k); });
  };
  finish(root);
  const byPath = new Map();
  const walk = nd => { byPath.set(nd.path, nd); nd.kids.forEach(walk); };
  walk(root);
  return { root, byPath };
}

// Сколько дней хватит остатка при темпе последних 7 полных дней.
function stockDaysOf(ag, dates) {
  if (ag.stockNow === null) return null;
  const today = dayjs().format('YYYY-MM-DD');
  const idx = dates.map((d, i) => [d, i]).filter(([d]) => d < today).slice(-7).map(([, i]) => i);
  if (!idx.length) return null;
  const perDay = idx.reduce((s, i) => s + ag.s.orders[i], 0) / idx.length;
  return perDay > 0 ? ag.stockNow / perDay : null;
}

// ── График «по категориям»: столбцы с разбивкой по подкатегориям ─────────
const STACK_METRICS = [
  { key: 'revenue', label: 'Заказано, ₽' }, { key: 'orders', label: 'Заказы, шт' },
  { key: 'views', label: 'Показы' }, { key: 'spend', label: 'Расход на рекламу, ₽' },
];
function StackChart({ buckets, groups, metric, tip, gran }) {
  const boxRef = useRef(null);
  const [w, setW] = useState(680);
  useEffect(() => {
    if (!boxRef.current) return undefined;
    const ro = new ResizeObserver(e => { const cw = e[0]?.contentRect?.width; if (cw) setW(Math.round(cw)); });
    ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, []);
  const [hover, setHover] = useState(null);
  const h = 250, pl = 52, pr = 12, pt = 14, pb = 22;
  const iw = w - pl - pr, ih = h - pt - pb, n = buckets.length || 1, bw = iw / n;
  const val = (g, b) => {
    let v = 0;
    for (const i of b.idx) v += metric === 'spend' ? g.ag.s.spendCpc[i] + g.ag.s.spendCpo[i] : g.ag.s[metric][i];
    return v;
  };
  const cols = buckets.map(b => groups.map(g => val(g, b)));
  const max = Math.max(1, ...cols.map(c => c.reduce((s, v) => s + v, 0)));
  const step = (() => { const raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw))); return [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw); })();
  const ticks = []; for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  const top = ticks[ticks.length - 1] || 1;
  const y = v => pt + ih - v / top * ih;
  const xStep = Math.ceil(n / Math.max(2, Math.floor(iw / 64)));
  const label = k => gran === 'month' ? dayjs(k).format('MM.YYYY') : `${k.slice(8)}.${k.slice(5, 7)}`;
  return (
    <div ref={boxRef} style={{ width: '100%' }}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" style={{ display: 'block' }} onMouseLeave={() => { tip.hide(); setHover(null); }}>
        {ticks.map(v => (
          <g key={v}>
            <line x1={pl} x2={w - pr} y1={y(v)} y2={y(v)} stroke="var(--a-grid)" />
            <text x={pl - 6} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill="var(--a-ink3)" fontFamily="JetBrains Mono, monospace">{fmtShort(v)}</text>
          </g>
        ))}
        {buckets.map((b, i) => {
          let acc = 0;
          const x0 = pl + i * bw + Math.min(3, bw * 0.12), width = Math.max(1, bw - Math.min(6, bw * 0.24));
          return (
            <g key={b.key} opacity={hover === null || hover === i ? 1 : 0.55}>
              {groups.map((g, gi) => {
                const v = cols[i][gi];
                if (!v) return null;
                const y1 = y(acc + v), y0 = y(acc);
                acc += v;
                // 2px зазор между сегментами — цветом фона.
                return <rect key={g.key} x={x0} y={y1} width={width} height={Math.max(0.5, y0 - y1 - 1)} fill={g.color} rx={gi === groups.length - 1 ? 2 : 0} />;
              })}
            </g>
          );
        })}
        {buckets.map((b, i) => ((i % xStep === 0 && n - 1 - i >= xStep / 2) || i === n - 1) ? (
          <text key={'x' + b.key} x={pl + i * bw + bw / 2} y={h - 6} textAnchor="middle" fontSize="10" fill="var(--a-ink3)" fontFamily="JetBrains Mono, monospace">{label(b.key)}</text>
        ) : null)}
        {buckets.map((b, i) => (
          <rect key={'h' + b.key} x={pl + i * bw} y={0} width={bw} height={h} fill="transparent"
            onMouseMove={e => {
              setHover(i);
              const total = cols[i].reduce((s, v) => s + v, 0);
              tip.show(e, (
                <div>
                  <div style={{ color: 'var(--a-ink3)', marginBottom: 3 }}>{gran === 'day' ? dayjs(b.key).format('DD.MM.YYYY') : gran === 'week' ? `неделя с ${dayjs(b.key).format('DD.MM')}` : dayjs(b.key).format('MM.YYYY')}</div>
                  {groups.map((g, gi) => cols[i][gi] ? (
                    <div key={g.key}><span style={{ color: g.color }}>■</span> {g.name}: <b>{fmtInt(cols[i][gi])}</b> <span style={{ color: 'var(--a-ink3)' }}>{total ? Math.round(cols[i][gi] / total * 100) : 0}%</span></div>
                  ) : null)}
                  <div style={{ marginTop: 3 }}>Всего: <b>{fmtInt(total)}</b></div>
                </div>
              ));
            }} />
        ))}
      </svg>
      <div className="s-legend">
        {groups.map(g => <span key={g.key}><i style={{ background: g.color }} />{g.name}</span>)}
      </div>
    </div>
  );
}

// ── Карточка артикула ────────────────────────────────────────────────────
function ArticleDetail({ a, dates, buckets, gran, tip, leafPaths, onMoveCategory }) {
  const model = useMemo(() => toModel(aggregate([a], dates.length), buckets), [a, dates.length, buckets]);
  const [custom, setCustom] = useState('');
  const sd = stockDaysOf(aggregate([a], dates.length), dates);
  return (
    <div className="a-dwrap">
      <div className="a-box wide">
        <h4>Динамика {gran !== 'day' && <span className="a-hint">по {gran === 'week' ? 'неделям' : 'месяцам'}</span>}</h4>
        <DualChart dates={buckets.map(b => b.key)} byDate={model.byDate} events={[]} tip={tip} mode="all"
          metricsList={SALES_CHART_METRICS} storeKey="mp-sales-art-chart" defaults={{ left: 'revenue', right: 'stock' }} />
      </div>
      <div className="a-box">
        <h4>Воронка за период</h4>
        <Funnel totals={model.totals} prev={model.prev} mode="all" />
      </div>
      <div className="a-box">
        <h4>О товаре</h4>
        <div className="a-kv">
          <span>Название</span><span style={{ textAlign: 'right' }}>{a.n || '—'}</span>
          <span>Марка авто</span><b>{a.brand || '—'}</b>
          <span>Остаток сейчас</span><b className="n">{fmtInt(a.st)} шт{sd !== null ? ` · ≈ ${Math.round(sd)} дн` : ''}</b>
          <span>Средний чек</span><b className="n">{model.totals.orders ? fmtInt(model.totals.revenue / model.totals.orders) : '—'} ₽</b>
          <span>Расход: клик / заказ</span><b className="n">{fmtInt(model.totals.spendCpc)} / {fmtInt(model.totals.spendCpo)} ₽</b>
          <span>Категория</span>
          <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="a-sel" value={a.cat} onChange={e => { if (e.target.value === '__custom') return; onMoveCategory(a, e.target.value); }} style={{ padding: '3px 6px', fontSize: 12, maxWidth: 300 }}>
              {!leafPaths.includes(a.cat) && <option value={a.cat}>{a.cat}</option>}
              {leafPaths.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            {a.manual && <button type="button" className="a-btn" style={{ padding: '3px 9px', fontSize: 12 }} title={`Автоматически: ${a.auto}`} onClick={() => onMoveCategory(a, null)}>↺ авто</button>}
          </span>
          <span>Новая категория</span>
          <form style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }} onSubmit={e => { e.preventDefault(); if (custom.trim()) { onMoveCategory(a, custom.trim()); setCustom(''); } }}>
            <input className="a-input" value={custom} onChange={e => setCustom(e.target.value)} placeholder="Аксессуары / Органайзеры" style={{ padding: '3px 8px', fontSize: 12, width: 190 }} />
            <button type="submit" className="a-btn" style={{ padding: '3px 9px', fontSize: 12 }} disabled={!custom.trim()}>Перенести</button>
          </form>
        </div>
      </div>
      <div className="a-box wide">
        <h4>По {gran === 'day' ? 'дням' : gran === 'week' ? 'неделям' : 'месяцам'} <span className="a-hint">свежие справа</span></h4>
        <DaysTable dates={buckets.map(b => b.key)} model={model} mode="all" hideKeys={HIDE_DAY_ROWS} />
      </div>
    </div>
  );
}

// ── Срезы ────────────────────────────────────────────────────────────────
function SliceTable({ rows, cols, onOpen, empty }) {
  if (!rows.length) return <div className="a-empty" style={{ padding: 18 }}>{empty}</div>;
  return (
    <div className="a-scroll">
      <table className="a-t s-slice">
        <thead><tr>{cols.map(c => <th key={c.t} className={c.num ? 'r' : ''}>{c.t}</th>)}</tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key} className="row" onClick={onOpen ? () => onOpen(r) : undefined}>
              {cols.map(c => <td key={c.t} className={c.num ? 'n r' : ''}>{c.v(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
const artCell = a => (
  <div className="a-art"><div style={{ minWidth: 0 }}><div className="id">{a.o}</div><div className="model" title={a.n}>{a.short}</div></div></div>
);

// ═════════════════════════════════════════════════════════════════════════
export default function SalesAnalytics({ cabinet }) {
  const today = dayjs().format('YYYY-MM-DD');
  const [dateFrom, setDateFrom] = useState(dayjs().subtract(29, 'day').format('YYYY-MM-DD'));
  const [dateTo, setDateTo] = useState(today);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState('');
  const [brand, setBrand] = useState('');
  const [search, setSearch] = useState('');
  const [gran, setGran] = useState('day');
  const [chartMode, setChartMode] = useState('cats');
  const [stackMetric, setStackMetric] = useState('revenue');
  const [sort, setSort] = useState({ key: 'revenue', dir: -1 });
  const [open, setOpen] = useState(() => new Set());
  const [openArt, setOpenArt] = useState(null);
  const [showAll, setShowAll] = useState(() => new Set());
  const [slice, setSlice] = useState('movers');
  const [matrixMetric, setMatrixMetric] = useState('revenue');
  const tip = useTip();
  // Ширина видимой части таблицы: карточка артикула внутри широкой таблицы
  // прилипает к левому краю и не уезжает вправо при прокрутке.
  const treeRef = useRef(null);
  const [treeW, setTreeW] = useState(1100);
  useEffect(() => {
    if (!treeRef.current) return undefined;
    const ro = new ResizeObserver(e => { const cw = e[0]?.contentRect?.width; if (cw) setTreeW(Math.round(cw)); });
    ro.observe(treeRef.current);
    return () => ro.disconnect();
  }, [data]);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    getSalesData(cabinet, { dateFrom, dateTo, compare: 1 })
      .then(r => setData(r.data.data))
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [cabinet, dateFrom, dateTo]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setSel(''); setBrand(''); setOpenArt(null); }, [cabinet]);

  const dates = data?.dates || [];
  const N = dates.length;
  const all = useMemo(() => (data ? prepare(data) : []), [data]);
  const brands = useMemo(() => {
    const m = new Map();
    for (const a of all) if (a.brand) m.set(a.brand, (m.get(a.brand) || 0) + a.tRevenue);
    return [...m.entries()].sort((x, y) => y[1] - x[1]).map(([b]) => b);
  }, [all]);

  // Фильтры (марка, поиск) действуют на всё — дерево строится уже по ним.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter(a => (!brand || a.brand === brand) && (!q || a.o.toLowerCase().includes(q) || a.n.toLowerCase().includes(q)));
  }, [all, brand, search]);
  const tree = useMemo(() => buildTree(filtered, data?.order || []), [filtered, data]);
  // Цвета — по полному дереву (без фильтров), чтобы не перекрашивались.
  const fullTree = useMemo(() => buildTree(all, data?.order || []), [all, data]);
  const leafPaths = useMemo(() => {
    const out = [];
    const walk = nd => { if (!nd.kids.length && nd.path) out.push(nd.path); nd.kids.forEach(walk); };
    walk(fullTree.root);
    return out;
  }, [fullTree]);

  const node = tree.byPath.get(sel) || tree.root;
  const buckets = useMemo(() => bucketsOf(dates, gran), [dates, gran]);
  const agOf = useCallback(list => aggregate(list, N), [N]);
  const ag = useMemo(() => agOf(node.arts), [node, agOf]);
  const model = useMemo(() => toModel(ag, buckets), [ag, buckets]);
  const dayModel = useMemo(() => (gran === 'day' ? model : toModel(ag, bucketsOf(dates, 'day'))), [ag, model, gran, dates]);
  // Кэш тяжёлых сумм: всплывашки на графиках перерисовывают страницу на
  // каждое движение мыши — пересчитывать 1800 артикулов каждый раз нельзя.
  const cache = useMemo(() => new Map(), [filtered, buckets]); // eslint-disable-line react-hooks/exhaustive-deps
  const cached = (k, fn) => { if (!cache.has(k)) cache.set(k, fn()); return cache.get(k); };

  async function moveCategory(a, path) {
    try {
      const r = await setSalesCategory(cabinet, [a.o], path);
      const newPath = r.data.path || a.auto;
      setData(prev => prev && ({ ...prev, articles: prev.articles.map(x => x.o === a.o ? { ...x, cat: newPath, manual: !!r.data.path } : x) }));
    } catch (e) { window.alert('Не удалось сохранить категорию.'); }
  }

  if (loading && !data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Загрузка…</div></div>;
  if (error && !data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Не удалось загрузить данные: {error} <button className="a-btn" onClick={load}>Повторить</button></div></div>;

  if (!all.length) {
    return (
      <div className="mpui sa-page">
        <div className="a-top"><h1>Аналитика продаж</h1></div>
        <div className="a-card" style={{ padding: 24, lineHeight: 1.6 }}>
          <b>По этому кабинету в базе пока нет данных о товарах.</b><br />
          Каталог, заказы по товарам и остатки собирает Google-скрипт в таблицу. Чтобы он начал собирать их и по этому кабинету,
          в «Свойствах скрипта» нужны ключи Seller API Ozon этого кабинета (<code>{String(cabinet).toUpperCase()}_SELLER_CLIENT_ID</code> и <code>{String(cabinet).toUpperCase()}_SELLER_API_KEY</code>).
          После следующего запуска <code>syncDaily</code> вкладка заполнится сама.
        </div>
      </div>
    );
  }

  // ── KPI ──
  const T = model.totals, P = model.prev;
  const dayT = dayModel.totals;
  const sDays = stockDaysOf(ag, dates);
  const avgCheck = T.orders > 0 ? T.revenue / T.orders : null;
  const pAvgCheck = P && P.orders > 0 ? P.revenue / P.orders : null;
  const adShare = T.orders > 0 ? T.adOrders / T.orders * 100 : null;
  const pAdShare = P && P.orders > 0 ? P.adOrders / P.orders * 100 : null;
  const series = key => dates.map(d => dayModel.byDate[d]?.[key] || 0);
  const unalloc = !sel && !brand && !search.trim() ? (data.unallocated?.cur || 0) : 0;

  // Путь выбранной категории (хлебные крошки) и её подкатегории.
  const crumbs = [];
  for (let x = node; x; x = x.parent) crumbs.unshift(x);
  const kids = node.kids;

  // Группы для графика «по категориям» (не больше 6 цветов, остальное — «Прочее»).
  const colorNode = tree.byPath.get(sel) ? fullTree.byPath.get(sel) : fullTree.root;
  const slotOf = name => colorNode?.children?.get(name)?.slot ?? 99;
  const stackGroups = cached(`stack|${sel}`, () => {
    const list = kids.length
      ? kids.map(k => ({ key: k.path, name: k.name, arts: k.arts, slot: slotOf(k.name) }))
      : [{ key: node.path || 'all', name: node.name, arts: node.arts, slot: 0 }];
    const main = list.filter(g => g.slot < CAT_COLORS.length).map(g => ({ ...g, ag: agOf(g.arts), color: CAT_COLORS[g.slot] }));
    const rest = list.filter(g => g.slot >= CAT_COLORS.length);
    if (rest.length) main.push({ key: '__other', name: `Прочее (${rest.length})`, ag: agOf(rest.flatMap(g => g.arts)), color: OTHER_COLOR });
    return main;
  });

  // ── Таблица категорий (дерево) ──
  const totalRev = ag ? T.revenue : 0;
  const statsOf = (arts, key) => cached(`st|${key}`, () => {
    const g = agOf(arts);
    const m = toModel(g, [{ key: 'all', idx: dates.map((_, i) => i) }]);
    return { g, t: m.totals, p: m.prev, sd: stockDaysOf(g, dates), spark: dates.map((_, i) => g.s.orders[i]) };
  });
  const sortVal = (st) => {
    const t = st.t;
    switch (sort.key) {
      case 'revenue': return t.revenue; case 'orders': return t.orders; case 'delta': return changePct(t.revenue, st.p?.revenue) ?? -1e9;
      case 'check': return t.orders ? t.revenue / t.orders : 0; case 'views': return t.views; case 'ctr': return t.ctr ?? -1;
      case 'crc': return t.crToCart ?? -1; case 'cro': return t.crToOrder ?? -1; case 'stock': return st.g.stockNow ?? -1;
      case 'days': return st.sd ?? 1e9; case 'spend': return t.spend; case 'drr': return t.drr ?? -1;
      default: return t.revenue;
    }
  };
  const COLS = [
    ['name', 'Категория / артикул'], [null, 'Заказы по дням'], ['revenue', 'Заказано, ₽'], ['delta', 'Δ'], [null, 'Доля'],
    ['orders', 'Заказы, шт'], ['check', 'Ср. чек'], ['views', 'Показы'], ['ctr', 'CTR'], ['crc', 'CR корз.'], ['cro', 'CR заказ'],
    ['stock', 'Остаток'], ['days', 'Запас'], ['spend', 'Расход'], ['drr', 'ДРР'],
  ];
  const clickSort = k => k && setSort(p => p.key === k ? { key: k, dir: -p.dir } : { key: k, dir: k === 'days' ? 1 : -1 });
  const toggle = path => setOpen(prev => { const n = new Set(prev); n.has(path) ? n.delete(path) : n.add(path); return n; });
  const metricCells = (st) => {
    const t = st.t;
    const share = totalRev > 0 ? t.revenue / totalRev * 100 : null;
    const daysCls = st.g.stockNow === null ? '' : st.sd !== null && st.sd < 7 ? 'b' : st.sd !== null && st.sd < 14 ? 'w' : '';
    return (
      <>
        <td><SparkBars values={st.spark} /></td>
        <td className="n r">{fmtInt(t.revenue)}</td>
        <td className="r"><Delta value={st.p ? changePct(t.revenue, st.p.revenue) : null} /></td>
        <td className="r"><span className="s-part"><i style={{ width: `${Math.min(100, share || 0)}%` }} /><b className="n">{share === null ? '—' : fmtPct(share)}</b></span></td>
        <td className="n r">{fmtInt(t.orders)}</td>
        <td className="n r">{t.orders ? fmtInt(t.revenue / t.orders) : '—'}</td>
        <td className="n r">{fmtInt(t.views)}</td>
        <td className="n r">{fmtPct(t.ctr)}</td>
        <td className="n r">{fmtPct(t.crToCart)}</td>
        <td className="n r">{fmtPct(t.crToOrder)}</td>
        <td className="n r">{fmtInt(st.g.stockNow)}</td>
        <td className="r"><span className={`s-days ${daysCls}`}>{st.g.stockNow === null ? '—' : st.g.stockNow === 0 ? 'нет' : st.sd === null ? '∞' : `${Math.round(st.sd)} дн`}</span></td>
        <td className="n r">{t.spend ? fmtInt(t.spend) : '—'}</td>
        <td className="r">{t.spend ? <span className={`pill ${drrClass(t.drr)}`}>{t.drr === null ? '×' : fmtPct(t.drr)}</span> : <span className="muted">—</span>}</td>
      </>
    );
  };
  const treeRows = [];
  const pushNode = (nd, depth, forceOpen) => {
    const st = statsOf(nd.arts, 'c' + nd.path);
    const isOpen = forceOpen || open.has(nd.path);
    treeRows.push(
      <tr key={'c' + nd.path} className={`row s-cat d${depth} ${isOpen ? 'open' : ''}`} onClick={() => toggle(nd.path)}>
        <td>
          <div className="a-art" style={{ paddingLeft: depth * 16 }}>
            <span className="a-chev">▶</span>
            <span className="s-cname">{nd.name}</span>
            <span className="a-hint">{nd.arts.length}</span>
            <button type="button" className="s-focus" title="Показать только эту категорию" onClick={e => { e.stopPropagation(); setSel(nd.path); }}>⌕</button>
          </div>
        </td>
        {metricCells(st)}
      </tr>
    );
    if (!isOpen) return;
    if (nd.kids.length) {
      const ks = nd.kids.map(k => ({ k, v: sortVal(statsOf(k.arts, 'c' + k.path)) })).sort((x, y) => (x.v - y.v) * sort.dir);
      ks.forEach(({ k }) => pushNode(k, depth + 1));
      return;
    }
    const arts = nd.arts.map(a => ({ a, st: statsOf([a], 'a' + a.o) })).sort((x, y) => (sortVal(x.st) - sortVal(y.st)) * sort.dir);
    const limit = showAll.has(nd.path) ? arts.length : 30;
    arts.slice(0, limit).forEach(({ a, st }) => {
      const isArt = openArt === a.o;
      treeRows.push(
        <tr key={'a' + a.o} className={`row s-art ${isArt ? 'open' : ''}`} onClick={() => setOpenArt(isArt ? null : a.o)}>
          <td>
            <div className="a-art" style={{ paddingLeft: (depth + 1) * 16 }}>
              <span className="a-chev">▶</span>
              <div style={{ minWidth: 0 }}>
                <div className="id">{a.o}{a.manual && <span className="tag off" style={{ marginLeft: 6 }} title={`Перенесён вручную; автоматически: ${a.auto}`}>вручную</span>}</div>
                <div className="model" title={a.n}>{a.short}</div>
              </div>
            </div>
          </td>
          {metricCells(st)}
        </tr>
      );
      if (isArt) treeRows.push(
        <tr key={'d' + a.o} className="a-detail"><td colSpan={COLS.length}>
          <div style={{ position: 'sticky', left: 0, width: treeW }}>
            <ArticleDetail a={a} dates={dates} buckets={buckets} gran={gran} tip={tip} leafPaths={leafPaths} onMoveCategory={moveCategory} />
          </div>
        </td></tr>
      );
    });
    if (arts.length > limit) treeRows.push(
      <tr key={'m' + nd.path}><td colSpan={COLS.length} style={{ paddingLeft: (depth + 1) * 16 + 14 }}>
        <button type="button" className="a-btn ghost" onClick={() => setShowAll(p => new Set(p).add(nd.path))}>Показать все {arts.length} артикулов</button>
      </td></tr>
    );
  };
  if (kids.length) {
    kids.map(k => ({ k, v: sortVal(statsOf(k.arts, 'c' + k.path)) })).sort((x, y) => (x.v - y.v) * sort.dir).forEach(({ k }) => pushNode(k, 0));
  } else {
    // Выбрана конечная категория — сразу её артикулы.
    pushNode(node, 0, true);
  }

  // ── Матрица: подкатегории (или артикулы) × дни ──
  const MM = [['revenue', 'Заказано, ₽', 'int'], ['orders', 'Заказы, шт', 'int'], ['views', 'Показы', 'int'], ['crToOrder', 'CR в заказ', 'pct'], ['spend', 'Расход', 'int'], ['drr', 'ДРР', 'pct'], ['stock', 'Остаток', 'int']];
  const mCfg = MM.find(m => m[0] === matrixMetric);
  const matrixRows = cached(`mx|${sel}`, () => (kids.length
    ? kids.map(k => ({ key: k.path, label: k.name, sub: `${k.arts.length} арт.`, arts: k.arts }))
    : [...node.arts].sort((x, y) => y.tRevenue - x.tRevenue).slice(0, 40).map(a => ({ key: a.o, label: a.o, sub: a.short, title: a.n, arts: [a] })))
    .map(r => ({ ...r, m: toModel(agOf(r.arts), buckets) })));
  const mVals = [];
  for (const r of matrixRows) for (const b of buckets) { const v = r.m.byDate[b.key]?.[matrixMetric]; if (v !== null && v !== undefined && Number.isFinite(v)) mVals.push(v); }
  const mMin = mVals.length ? Math.min(...mVals) : 0, mMax = mVals.length ? Math.max(...mVals) : 0;
  const mGood = matrixMetric === 'drr' ? 'down' : 'up';
  const mTotal = r => matrixMetric === 'stock' ? r.m.stockNow : r.m.totals[matrixMetric];

  // ── Срезы ──
  const artStats = node.arts.map(a => {
    const prevRev = a.prev ? a.prev.revenue : 0;
    const g = { s: { orders: a.orders }, stockNow: a.st };
    return { key: a.o, a, rev: a.tRevenue, prevRev, diff: a.tRevenue - prevRev, orders: a.tOrders, sd: stockDaysOf(g, dates) };
  });
  const movers = {
    up: artStats.filter(x => x.diff > 0).sort((x, y) => y.diff - x.diff).slice(0, 15),
    down: artStats.filter(x => x.diff < 0).sort((x, y) => x.diff - y.diff).slice(0, 15),
  };
  const sleeping = artStats.filter(x => (x.a.st || 0) > 0 && x.orders === 0).sort((x, y) => (y.a.st || 0) - (x.a.st || 0));
  const deficit = artStats.filter(x => x.orders > 0 && (x.a.st === 0 || (x.sd !== null && x.sd < 7))).sort((x, y) => (x.sd ?? 0) - (y.sd ?? 0));
  const abc = (() => {
    const list = artStats.filter(x => x.rev > 0).sort((x, y) => y.rev - x.rev);
    const tot = list.reduce((s, x) => s + x.rev, 0);
    let acc = 0;
    const out = list.map(x => { acc += x.rev; const cls = acc / tot <= 0.8 || acc === x.rev ? 'A' : acc / tot <= 0.95 ? 'B' : 'C'; return { ...x, cls, cum: acc / tot * 100 }; });
    const sum = cls => { const l = out.filter(x => x.cls === cls); return { n: l.length, rev: l.reduce((s, x) => s + x.rev, 0) }; };
    return { list: out, A: sum('A'), B: sum('B'), C: sum('C'), zero: artStats.length - list.length, tot };
  })();
  const brandTable = (() => {
    if (cabinet !== 'defly') return null;
    const tops = fullTree.root.kids.map(k => k.name);
    const m = new Map();
    for (const a of node.arts) {
      const b = a.brand || 'Не определена';
      if (!m.has(b)) m.set(b, { key: b, total: 0, orders: 0, by: {} });
      const x = m.get(b);
      x.total += a.tRevenue; x.orders += a.tOrders;
      x.by[a.parts[0]] = (x.by[a.parts[0]] || 0) + a.tRevenue;
    }
    return { tops, rows: [...m.values()].filter(x => x.total > 0).sort((x, y) => y.total - x.total) };
  })();
  const openArticle = a => {
    // Раскрыть категорию артикула в таблице и сам артикул.
    const p = a.parts;
    setOpen(prev => { const n = new Set(prev); for (let i = 1; i <= p.length; i++) n.add(p.slice(0, i).join(SEP)); return n; });
    setOpenArt(a.o);
    setTimeout(() => document.getElementById('s-tree')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };
  const SLICES = [
    ['movers', `Растут / падают`], ['sleep', `Спящие · ${sleeping.length}`], ['deficit', `Дефицит · ${deficit.length}`],
    ['abc', 'ABC'], ...(brandTable ? [['brands', 'Марки авто']] : []), ['funnel', 'Воронка'],
  ];
  const periodBtn = n => {
    const f = dayjs().subtract(n - 1, 'day').format('YYYY-MM-DD');
    return <button key={n} type="button" className={dateFrom === f && dateTo === today ? 'on' : ''} onClick={() => { setDateFrom(f); setDateTo(today); }}>{n} дн</button>;
  };

  return (
    <div className="mpui sa-page">
      <div className="a-top">
        <h1>Аналитика продаж</h1>
        <span className="a-seg">{[7, 14, 30, 90].map(periodBtn)}</span>
        <DateRangePicker from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t); }} />
        {brands.length > 0 && (
          <select className="a-sel" value={brand} onChange={e => setBrand(e.target.value)} title="Марка автомобиля">
            <option value="">Все марки авто</option>
            {brands.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        )}
        <input className="a-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Артикул или название" style={{ minWidth: 200 }} />
        {loading && <span className="a-hint">обновляем…</span>}
      </div>

      {/* Категории верхнего уровня + путь */}
      <div className="a-bar">
        <div className="a-tabs">
          <button type="button" className={`a-tab ${!sel ? 'on' : ''}`} onClick={() => setSel('')}>Все<span className="c">{filtered.length}</span></button>
          {tree.root.kids.map(k => (
            <button key={k.path} type="button" className={`a-tab ${sel === k.path || sel.startsWith(k.path + SEP) ? 'on' : ''}`} onClick={() => setSel(k.path)}>
              <i className="s-dot" style={{ background: CAT_COLORS[fullTree.root.children.get(k.name)?.slot] || OTHER_COLOR }} />{k.name}<span className="c">{k.arts.length}</span>
            </button>
          ))}
        </div>
      </div>
      {sel && (
        <div className="a-bar s-crumbs">
          {crumbs.map((c, i) => (
            <React.Fragment key={c.path || 'root'}>
              {i > 0 && <span className="a-hint">›</span>}
              <button type="button" className={`s-crumb ${c === node ? 'on' : ''}`} onClick={() => setSel(c.path)}>{c.name}</button>
            </React.Fragment>
          ))}
          {kids.length > 0 && <span className="a-hint" style={{ marginLeft: 8 }}>подкатегории:</span>}
          {kids.map(k => <button key={k.path} type="button" className="s-chip" onClick={() => setSel(k.path)}>{k.name} <span className="a-hint">{k.arts.length}</span></button>)}
        </div>
      )}

      <div className={`a-kpis s-kpis ${loading ? 'a-loading' : ''}`}>
        <div className="a-kpi">
          <span className="lbl">Заказано, ₽</span>
          <span className="val n">{fmtInt(T.revenue)}</span>
          <span className="sub"><Delta value={P && changePct(T.revenue, P.revenue)} /> к прошлому периоду</span>
          <AreaSpark values={series('revenue')} color="var(--a-rev)" />
        </div>
        <div className="a-kpi">
          <span className="lbl">Заказы, шт</span>
          <span className="val n">{fmtInt(T.orders)}</span>
          <span className="sub"><Delta value={P && changePct(T.orders, P.orders)} /> · ≈ {N ? perDayTxt(dayT.orders / N) : '—'} в день</span>
          <AreaSpark values={series('orders')} color="var(--a-good)" />
        </div>
        <div className="a-kpi">
          <span className="lbl">Средний чек, ₽</span>
          <span className="val n">{fmtInt(avgCheck)}</span>
          <span className="sub"><Delta value={avgCheck !== null && pAvgCheck !== null ? changePct(avgCheck, pAvgCheck) : null} goodWhen="neutral" /> к прошлому периоду</span>
        </div>
        <div className="a-kpi">
          <span className="lbl">Остаток сейчас, шт</span>
          <span className="val n">{fmtInt(ag.stockNow)}</span>
          <span className="sub">{sDays === null ? 'нет продаж за 7 дней' : `хватит ≈ на ${Math.round(sDays)} дн`}</span>
          <AreaSpark values={series('stock')} color="var(--a-ink3)" />
        </div>
        <div className="a-kpi">
          <span className="lbl">Артикулы с заказами</span>
          <span className="val n">{fmtInt(ag.active)} <small className="s-of">из {fmtInt(ag.count)}</small></span>
          <span className="sub">{ag.count ? fmtPct(ag.active / ag.count * 100) : '—'} ассортимента продавалось</span>
        </div>
        <div className="a-kpi">
          <span className="lbl">Расход на рекламу, ₽</span>
          <span className="val n">{fmtInt(T.spend)}</span>
          <div className="split">
            <span>За клик <b className="n">{fmtInt(T.spendCpc)}</b></span>
            <span>За заказ <b className="n">{T.spendCpo ? fmtInt(T.spendCpo) : '—'}</b></span>
          </div>
          {unalloc > 0 && <span className="sub" title="Расход кампаний, которые не удалось привязать ни к одному артикулу. В сумме выше не учтён.">+{fmtInt(unalloc)} ₽ без привязки к артикулам</span>}
        </div>
        <div className="a-kpi">
          <span className="lbl">ДРР</span>
          <span className="val n">{fmtPct(T.drr)}</span>
          <span className="sub"><Delta value={P && T.drr !== null && P.drr !== null ? T.drr - P.drr : null} unit="pp" goodWhen="down" /> к прошлому периоду</span>
        </div>
        <div className="a-kpi">
          <span className="lbl">Заказы с рекламы</span>
          <span className="val n">{fmtPct(adShare)}</span>
          <span className="sub"><Delta value={adShare !== null && pAdShare !== null ? adShare - pAdShare : null} unit="pp" goodWhen="neutral" /> · {fmtInt(T.adOrders)} шт</span>
        </div>
      </div>

      <div className={`a-card s-card ${loading ? 'a-loading' : ''}`}>
        <div className="a-bar" style={{ marginBottom: 10 }}>
          <b style={{ fontSize: 14 }}>Динамика{sel ? ` · ${node.name}` : ''}</b>
          <span className="a-seg">
            {[['cats', kids.length ? 'По категориям' : 'Столбцы'], ['dual', 'Две метрики']].map(([v, l]) => (
              <button key={v} type="button" className={chartMode === v ? 'on' : ''} onClick={() => setChartMode(v)}>{l}</button>
            ))}
          </span>
          {chartMode === 'cats' && (
            <select className="a-sel" value={stackMetric} onChange={e => setStackMetric(e.target.value)} style={{ padding: '4px 8px', fontSize: 12.5 }}>
              {STACK_METRICS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          )}
          <span className="a-seg" style={{ marginLeft: 'auto' }}>
            {[['day', 'Дни'], ['week', 'Недели'], ['month', 'Месяцы']].map(([v, l]) => (
              <button key={v} type="button" className={gran === v ? 'on' : ''} onClick={() => setGran(v)}>{l}</button>
            ))}
          </span>
        </div>
        {chartMode === 'cats'
          ? <StackChart buckets={buckets} groups={stackGroups} metric={stackMetric} tip={tip} gran={gran} />
          : <DualChart dates={buckets.map(b => b.key)} byDate={model.byDate} events={[]} tip={tip} mode="all"
              metricsList={SALES_CHART_METRICS} storeKey="mp-sales-chart" defaults={{ left: 'revenue', right: 'orders' }} />}
      </div>

      <div className={`a-card ${loading ? 'a-loading' : ''}`} id="s-tree">
        <div className="a-bar" style={{ padding: '12px 14px 0' }}>
          <b style={{ fontSize: 14 }}>Категории и артикулы</b>
          <span className="a-hint">▶ — раскрыть · ⌕ — показать только категорию · клик по артикулу — подробно</span>
          <button type="button" className="a-btn ghost" style={{ marginLeft: 'auto' }} onClick={() => setOpen(new Set())}>Свернуть всё</button>
        </div>
        <div className="a-scroll" ref={treeRef}>
          <table className="a-t s-tree">
            <thead>
              <tr>{COLS.map(([k, t], i) => (
                <th key={i} className={`${k && k !== 'name' ? 'sortable' : ''} ${sort.key === k ? 'sorted' : ''} ${i > 1 ? 'r' : ''}`} onClick={() => k !== 'name' && clickSort(k)}>
                  {t}{sort.key === k ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}
                </th>
              ))}</tr>
            </thead>
            <tbody>
              {treeRows}
              {!node.arts.length && <tr><td colSpan={COLS.length} className="a-empty">Под фильтры ничего не подошло.</td></tr>}
            </tbody>
            {node.arts.length > 0 && (
              <tfoot>
                <tr className="row s-total">
                  <td><div className="a-art"><b>Итого · {node.arts.length} арт.</b></div></td>
                  {metricCells({ g: ag, t: dayT, p: dayModel.prev, sd: sDays, spark: series('orders') })}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div className="a-card" style={{ padding: 14 }}>
        <div className="a-bar" style={{ marginBottom: 10 }}>
          <b style={{ fontSize: 14 }}>{kids.length ? 'Подкатегории' : 'Артикулы'} по {gran === 'day' ? 'дням' : gran === 'week' ? 'неделям' : 'месяцам'}</b>
          <span className="a-seg">{MM.map(m => <button key={m[0]} type="button" className={matrixMetric === m[0] ? 'on' : ''} onClick={() => setMatrixMetric(m[0])}>{m[1]}</button>)}</span>
          {!kids.length && node.arts.length > 40 && <span className="a-hint">топ-40 по выручке</span>}
        </div>
        <div className="a-days">
          <table className="a-dt a-matrix">
            <thead><tr><th className="lbl">{kids.length ? 'Категория' : 'Артикул'}</th><th className="tot">Итого</th>{buckets.map(b => <th key={b.key}>{gran === 'month' ? dayjs(b.key).format('MM.YY') : `${b.key.slice(8)}.${b.key.slice(5, 7)}`}</th>)}</tr></thead>
            <tbody>
              {matrixRows.map(r => (
                <tr key={r.key}>
                  <td className="lbl" title={r.title || ''} style={{ cursor: kids.length ? 'pointer' : 'default' }} onClick={() => kids.length && setSel(r.key)}>
                    {r.label} <span style={{ color: 'var(--a-ink3)', fontSize: 11 }}>{r.sub}</span>
                  </td>
                  <td className="tot">{fmtBy(mTotal(r), mCfg[2])}</td>
                  {buckets.map(b => { const v = r.m.byDate[b.key]?.[matrixMetric]; return <td key={b.key} style={{ background: heatColor(v, mMin, mMax, mGood) }}>{fmtBy(v, mCfg[2])}</td>; })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="a-card" style={{ padding: 14 }}>
        <div className="a-bar" style={{ marginBottom: 10 }}>
          <b style={{ fontSize: 14 }}>Срезы{sel ? ` · ${node.name}` : ''}</b>
          <span className="a-seg">{SLICES.map(([k, l]) => <button key={k} type="button" className={slice === k ? 'on' : ''} onClick={() => setSlice(k)}>{l}</button>)}</span>
        </div>
        {slice === 'movers' && (
          <div className="s-two">
            {[['up', 'Растут сильнее всего', 'good'], ['down', 'Падают сильнее всего', 'bad']].map(([k, title]) => (
              <div key={k}>
                <div className="a-hint" style={{ marginBottom: 6 }}>{title} — изменение выручки к прошлому периоду той же длины</div>
                <SliceTable rows={movers[k]} onOpen={r => openArticle(r.a)} empty="Нет таких артикулов"
                  cols={[{ t: 'Артикул', v: r => artCell(r.a) }, { t: 'Было, ₽', num: 1, v: r => fmtInt(r.prevRev) }, { t: 'Стало, ₽', num: 1, v: r => fmtInt(r.rev) },
                    { t: 'Разница', num: 1, v: r => <span className={r.diff > 0 ? 's-up' : 's-down'}>{r.diff > 0 ? '+' : ''}{fmtInt(r.diff)}</span> }]} />
              </div>
            ))}
          </div>
        )}
        {slice === 'sleep' && (
          <>
            <div className="a-hint" style={{ marginBottom: 6 }}>Есть остаток, но за весь период ни одного заказа — деньги лежат на складе. Сначала самые большие остатки.</div>
            <SliceTable rows={sleeping.slice(0, 100)} onOpen={r => openArticle(r.a)} empty="Спящих артикулов нет"
              cols={[{ t: 'Артикул', v: r => artCell(r.a) }, { t: 'Категория', v: r => r.a.cat }, { t: 'Остаток', num: 1, v: r => fmtInt(r.a.st) },
                { t: 'Показы', num: 1, v: r => fmtInt(r.a.views.reduce((s, v) => s + v, 0)) }, { t: 'Заказы в прошлом периоде', num: 1, v: r => fmtInt(r.a.prev?.orders || 0) }]} />
            {sleeping.length > 100 && <div className="a-hint" style={{ marginTop: 6 }}>Показаны первые 100 из {sleeping.length}.</div>}
          </>
        )}
        {slice === 'deficit' && (
          <>
            <div className="a-hint" style={{ marginBottom: 6 }}>Продаются, но остатка меньше чем на 7 дней при темпе последней недели (или уже нет в наличии).</div>
            <SliceTable rows={deficit} onOpen={r => openArticle(r.a)} empty="Дефицита нет"
              cols={[{ t: 'Артикул', v: r => artCell(r.a) }, { t: 'Категория', v: r => r.a.cat }, { t: 'Остаток', num: 1, v: r => fmtInt(r.a.st) },
                { t: 'Хватит на', num: 1, v: r => <span className="s-days b">{r.a.st === 0 ? 'нет в наличии' : r.sd === null ? '—' : `${Math.round(r.sd)} дн`}</span> },
                { t: 'Заказы за период', num: 1, v: r => fmtInt(r.orders) }, { t: 'Заказано, ₽', num: 1, v: r => fmtInt(r.rev) }]} />
          </>
        )}
        {slice === 'abc' && (
          <>
            <div className="s-abc">
              {[['A', 'дают 80% выручки'], ['B', 'следующие 15%'], ['C', 'последние 5%']].map(([c, t]) => (
                <div key={c} className="s-abc-i"><b className={`s-cls ${c}`}>{c}</b><span><b className="n">{abc[c].n}</b> арт. · {t}</span><span className="a-hint n">{fmtInt(abc[c].rev)} ₽</span></div>
              ))}
              <div className="s-abc-i"><b className="s-cls Z">—</b><span><b className="n">{abc.zero}</b> арт. без заказов</span></div>
            </div>
            <SliceTable rows={abc.list.slice(0, 150)} onOpen={r => openArticle(r.a)} empty="Нет заказов за период"
              cols={[{ t: 'Класс', v: r => <b className={`s-cls ${r.cls}`}>{r.cls}</b> }, { t: 'Артикул', v: r => artCell(r.a) }, { t: 'Категория', v: r => r.a.cat },
                { t: 'Заказано, ₽', num: 1, v: r => fmtInt(r.rev) }, { t: 'Доля', num: 1, v: r => fmtPct(r.rev / abc.tot * 100) }, { t: 'Накопленно', num: 1, v: r => fmtPct(r.cum) }]} />
          </>
        )}
        {slice === 'brands' && brandTable && (
          <>
            <div className="a-hint" style={{ marginBottom: 6 }}>Выручка по маркам авто в каждой категории. Пустые клетки — по марке продаётся одно, а другого нет. Клик по строке — фильтр по марке.</div>
            <SliceTable rows={brandTable.rows.slice(0, 60)} onOpen={r => setBrand(r.key === 'Не определена' ? '' : r.key)} empty="Нет продаж"
              cols={[{ t: 'Марка', v: r => <b>{r.key}</b> }, { t: 'Заказано, ₽', num: 1, v: r => fmtInt(r.total) }, { t: 'Заказы', num: 1, v: r => fmtInt(r.orders) },
                ...brandTable.tops.map(tp => ({ t: tp, num: 1, v: r => r.by[tp] ? fmtInt(r.by[tp]) : <span className="muted">—</span> }))]} />
          </>
        )}
        {slice === 'funnel' && (
          <div className="s-two">
            <div><Funnel totals={dayT} prev={dayModel.prev} mode="all" /></div>
            <div>
              <div className="a-hint" style={{ marginBottom: 6 }}>Конверсии по {kids.length ? 'подкатегориям' : 'артикулам (топ-20)'}</div>
              <SliceTable
                rows={(kids.length ? kids.map(k => ({ key: k.path, name: k.name, t: toModel(agOf(k.arts), [{ key: 'a', idx: dates.map((_, i) => i) }]).totals }))
                  : [...node.arts].sort((x, y) => y.tRevenue - x.tRevenue).slice(0, 20).map(a => ({ key: a.o, name: a.o, t: toModel(agOf([a]), [{ key: 'a', idx: dates.map((_, i) => i) }]).totals })))}
                onOpen={kids.length ? r => setSel(r.key) : null} empty="Нет данных"
                cols={[{ t: kids.length ? 'Категория' : 'Артикул', v: r => r.name }, { t: 'Показы', num: 1, v: r => fmtInt(r.t.views) }, { t: 'CTR', num: 1, v: r => fmtPct(r.t.ctr) },
                  { t: 'CR в корзину', num: 1, v: r => fmtPct(r.t.crToCart) }, { t: 'CR в заказ', num: 1, v: r => fmtPct(r.t.crToOrder) }, { t: 'Заказы', num: 1, v: r => fmtInt(r.t.orders) }]} />
            </div>
          </div>
        )}
      </div>

      {tip.node}
    </div>
  );
}
