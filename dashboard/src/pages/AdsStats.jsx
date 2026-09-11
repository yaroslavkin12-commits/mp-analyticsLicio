import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getAdsStats, getAdsCabinets, collectAds } from '../api';

const DAY_OPTIONS = [14, 30, 60];

// Блок 1 — сырые показатели воронки (общие для артикула, берутся из общей
// аналитики по товару, как на Дашборде).
const FUNNEL_ROWS = [
  { key: 'revenue',   label: 'Заказы, ₽',            fmt: 'money', good: 'up' },
  { key: 'orders',    label: 'Заказы, шт',            fmt: 'int',   good: 'up' },
  { key: 'position',  label: 'Позиция в поиске',      fmt: 'pos',   good: 'down' },
  { key: 'views',     label: 'Показы',                fmt: 'int',   good: 'up' },
  { key: 'pdpViews',  label: 'Переходы на карточку',  fmt: 'int',   good: 'up' },
  { key: 'cart',      label: 'Корзины',                fmt: 'int',   good: 'up' },
];

// Блок 2 — конверсии, отдельным визуальным блоком (СТР и СР).
const CONVERSION_ROWS = [
  { key: 'ctr',        label: 'СТР (карточка/показ)', fmt: 'pct', good: 'up' },
  { key: 'crToCart',   label: 'СР в корзину',          fmt: 'pct', good: 'up' },
  { key: 'crToOrder',  label: 'СР в заказ',            fmt: 'pct', good: 'up' },
];

const METRIC_OPTIONS = [
  { key: 'views',    label: 'Показы' },
  { key: 'pdpViews', label: 'Переходы на карточку' },
  { key: 'ctr',      label: 'СТР' },
  { key: 'cart',     label: 'Корзины' },
  { key: 'crToCart', label: 'СР в корзину' },
  { key: 'orders',   label: 'Заказы, шт' },
  { key: 'crToOrder',label: 'СР в заказ' },
  { key: 'revenue',  label: 'Заказы, ₽' },
  { key: 'spend',    label: 'Расход, ₽' },
  { key: 'drr',      label: 'ДРР' },
];

const PLACEMENT_OPTIONS = [
  { value: '', label: 'Все зоны' },
  { value: 'search', label: 'Поиск' },
  { value: 'search_and_category', label: 'Поиск и рекомендации' },
];

const PAYMENT_OPTIONS = [
  { value: '', label: 'Все типы РК' },
  { value: 'cpc', label: 'Средняя стоимость клика' },
  { value: 'target', label: 'Целевой расход' },
];

function placementBucket(placement) {
  const p = (placement || '').toUpperCase();
  if (!p) return null;
  if (p.includes('SEARCH_AND_CATEGORY') || (p.includes('SEARCH') && p.includes('CATEGORY'))) return 'search_and_category';
  if (p.includes('SEARCH')) return 'search';
  return 'search_and_category';
}
function paymentBucket(paymentType) {
  const p = (paymentType || '').toUpperCase();
  if (!p) return null;
  if (p === 'CPC') return 'cpc';
  return 'target';
}

function fmtValue(v, fmt) {
  if (v === null || v === undefined) return '—';
  switch (fmt) {
    case 'money':  return Math.round(v).toLocaleString('ru-RU');
    case 'money0': return v ? Math.round(v).toLocaleString('ru-RU') : '—';
    case 'int':    return Math.round(v).toLocaleString('ru-RU');
    case 'pct':    return `${v.toFixed(1)}%`;
    case 'pos':    return v.toFixed(1);
    case 'raw':    return Number.isInteger(v) ? v.toLocaleString('ru-RU') : v.toFixed(2);
    default:       return String(v);
  }
}

// Тепловая заливка ячейки: нормализуем значение в строке к [0..1] по
// диапазону min..max этой же строки.
function heatColor(v, min, max, direction) {
  if (v === null || v === undefined || max === min || direction === 'neutral') return 'transparent';
  let t = (v - min) / (max - min);
  if (direction === 'down') t = 1 - t;
  t = Math.max(0, Math.min(1, t));
  const hue = 120 * t;
  return `hsla(${hue}, 65%, 42%, 0.35)`;
}

function MetricTable({ rows, dates, byDate }) {
  return (
    <>
      {rows.map(row => {
        const values = dates.map(d => byDate[d]?.[row.key]);
        const nums = values.filter(v => v !== null && v !== undefined);
        const min = nums.length ? Math.min(...nums) : 0;
        const max = nums.length ? Math.max(...nums) : 0;
        return (
          <tr key={row.key}>
            <td style={{
              position:'sticky', left:0, background:'var(--surface)', color:'var(--text2)',
              padding:'5px 10px', borderRight:'1px solid var(--border)', whiteSpace:'nowrap',
            }}>{row.label}</td>
            {values.map((v, i) => (
              <td key={dates[i]} style={{
                padding:'5px 6px', textAlign:'center', background: heatColor(v, min, max, row.good),
                color:'var(--text)', whiteSpace:'nowrap',
              }}>
                {fmtValue(v, row.fmt)}
              </td>
            ))}
          </tr>
        );
      })}
    </>
  );
}

function BlockLabel({ children }) {
  return (
    <tr>
      <td colSpan={999} style={{
        position:'sticky', left:0, background:'var(--surface2)', color:'var(--text3)',
        fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:.4,
        padding:'6px 10px', borderTop:'1px solid var(--border)', borderBottom:'1px solid var(--border)',
      }}>{children}</td>
    </tr>
  );
}

// График сравнения двух метрик во времени, индексированных к первому дню =
// 100 (чтобы разномасштабные метрики можно было сравнивать на одной оси).
// Цвета — уже существующая в приложении пара accent-wb/accent-oz.
function CompareChart({ dates, byDate, metricA, metricB, rawA, rawB }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const W = 640, H = 220, padL = 8, padR = 8, padT = 14, padB = 22;

  const seriesA = useMemo(() => indexSeries(dates.map(d => byDate[d]?.[metricA])), [dates, byDate, metricA]);
  const seriesB = useMemo(() => indexSeries(dates.map(d => byDate[d]?.[metricB])), [dates, byDate, metricB]);

  function indexSeries(vals) {
    const base = vals.find(v => v !== null && v !== undefined && v !== 0);
    if (base === undefined || base === null || base === 0) return vals.map(() => null);
    return vals.map(v => (v === null || v === undefined) ? null : (v / base) * 100);
  }

  const all = [...seriesA, ...seriesB].filter(v => v !== null);
  const min = all.length ? Math.min(0, ...all) : 0;
  const max = all.length ? Math.max(100, ...all) : 100;
  const range = (max - min) || 1;

  const x = i => padL + (i / Math.max(1, dates.length - 1)) * (W - padL - padR);
  const y = v => padT + (1 - (v - min) / range) * (H - padT - padB);

  function pathFor(series) {
    let d = '';
    series.forEach((v, i) => {
      if (v === null) return;
      d += (d ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1) + ' ';
    });
    return d.trim();
  }

  function handleMove(e) {
    const rect = ref.current.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width * W;
    let idx = Math.round(((px - padL) / (W - padL - padR)) * (dates.length - 1));
    idx = Math.max(0, Math.min(dates.length - 1, idx));
    setHover(idx);
  }

  const labelA = METRIC_OPTIONS.find(m => m.key === metricA)?.label || metricA;
  const labelB = METRIC_OPTIONS.find(m => m.key === metricB)?.label || metricB;

  return (
    <div style={{ position:'relative' }}>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width:'100%', height:220, display:'block', cursor:'crosshair' }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* сетка */}
        {[0,0.25,0.5,0.75,1].map(f => (
          <line key={f} x1={padL} x2={W-padR} y1={padT+f*(H-padT-padB)} y2={padT+f*(H-padT-padB)}
                stroke="var(--border)" strokeWidth={1} opacity={0.5}/>
        ))}
        <path d={pathFor(seriesA)} fill="none" stroke="var(--accent-wb)" strokeWidth={2}/>
        <path d={pathFor(seriesB)} fill="none" stroke="var(--accent-oz)" strokeWidth={2}/>
        {hover !== null && (
          <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H-padB} stroke="var(--text3)" strokeWidth={1} strokeDasharray="3,3"/>
        )}
        {hover !== null && seriesA[hover] !== null && (
          <circle cx={x(hover)} cy={y(seriesA[hover])} r={3.5} fill="var(--accent-wb)"/>
        )}
        {hover !== null && seriesB[hover] !== null && (
          <circle cx={x(hover)} cy={y(seriesB[hover])} r={3.5} fill="var(--accent-oz)"/>
        )}
      </svg>
      <div style={{ display:'flex', gap:16, fontSize:12, color:'var(--text2)', padding:'2px 8px 0' }}>
        <span><span style={{ display:'inline-block', width:10, height:2, background:'var(--accent-wb)', marginRight:6, verticalAlign:'middle' }}/>{labelA} (индекс, день 1 = 100)</span>
        <span><span style={{ display:'inline-block', width:10, height:2, background:'var(--accent-oz)', marginRight:6, verticalAlign:'middle' }}/>{labelB} (индекс, день 1 = 100)</span>
      </div>
      {hover !== null && (
        <div style={{
          position:'absolute', top:6, right:8, background:'var(--surface)', border:'1px solid var(--border)',
          borderRadius:8, padding:'6px 10px', fontSize:12, boxShadow:'0 4px 12px rgba(0,0,0,.2)',
        }}>
          <div style={{ color:'var(--text3)', marginBottom:3 }}>{dates[hover]}</div>
          <div style={{ color:'var(--accent-wb)' }}>{labelA}: {fmtValue(rawA[hover], 'raw')}</div>
          <div style={{ color:'var(--accent-oz)' }}>{labelB}: {fmtValue(rawB[hover], 'raw')}</div>
        </div>
      )}
    </div>
  );
}

function ArticleCompareChart({ dates, byDate }) {
  const [metricA, setMetricA] = useState('views');
  const [metricB, setMetricB] = useState('orders');
  const rawA = dates.map(d => byDate[d]?.[metricA] ?? null);
  const rawB = dates.map(d => byDate[d]?.[metricB] ?? null);
  const selectStyle = { padding:'5px 8px', borderRadius:6, border:'1px solid var(--border)', background:'var(--surface2)', color:'var(--text)', fontSize:12 };
  return (
    <div style={{ padding:14, background:'var(--surface)', borderTop:'1px solid var(--border)' }}>
      <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:8, flexWrap:'wrap' }}>
        <span style={{ fontSize:12, color:'var(--text3)', fontWeight:600 }}>Сравнить:</span>
        <select value={metricA} onChange={e => setMetricA(e.target.value)} style={selectStyle}>
          {METRIC_OPTIONS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
        <span style={{ color:'var(--text3)' }}>vs</span>
        <select value={metricB} onChange={e => setMetricB(e.target.value)} style={selectStyle}>
          {METRIC_OPTIONS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      </div>
      <CompareChart dates={dates} byDate={byDate} metricA={metricA} metricB={metricB} rawA={rawA} rawB={rawB}/>
    </div>
  );
}

function CampaignBlock({ camp, article, dates }) {
  const [open, setOpen] = useState(false);
  const spendValues = dates.map(d => camp.byDate[d]?.spend ?? 0);
  const min = 0, max = Math.max(...spendValues, 0);
  return (
    <div style={{ border:'1px solid var(--border)', borderRadius:8, margin:'8px 10px', overflow:'hidden' }}>
      <div onClick={() => setOpen(o => !o)} style={{
        display:'flex', alignItems:'center', gap:8, padding:'8px 10px', cursor:'pointer',
        background:'var(--surface2)', flexWrap:'wrap',
      }}>
        <span>{open ? '▾' : '▸'}</span>
        <span style={{ fontWeight:600, fontSize:13 }}>{camp.title || camp.campaignId}</span>
        <span style={{
          fontSize:11, padding:'2px 8px', borderRadius:999,
          background: camp.state === 'CAMPAIGN_STATE_RUNNING' ? 'rgba(34,197,94,.18)' : 'rgba(148,163,184,.18)',
          color: camp.state === 'CAMPAIGN_STATE_RUNNING' ? 'var(--ok, #22c55e)' : 'var(--text3)',
        }}>{camp.state === 'CAMPAIGN_STATE_RUNNING' ? 'активна' : 'выключена'}</span>
        {camp.paymentType && <span style={{ fontSize:11, color:'var(--text3)' }}>{paymentBucket(camp.paymentType) === 'cpc' ? 'CPC' : 'Целевой расход'}</span>}
        <span style={{ marginLeft:'auto', fontSize:12, color:'var(--text2)' }}>
          Расход: {fmtValue(camp.totalSpend, 'money0')} ₽ · ДРР: {fmtValue(camp.drr, 'pct')}
        </span>
      </div>
      {open && (
        <div style={{ padding:'10px' }}>
          {article.offerId && (
            <div style={{ fontSize:15, fontWeight:700, marginBottom:8 }}>
              Артикул: <span style={{ color:'var(--accent-oz)' }}>{article.offerId}</span>
            </div>
          )}
          <div style={{ overflowX:'auto' }}>
            <table style={{ borderCollapse:'collapse', fontSize:12, minWidth: 160 + dates.length * 62 }}>
              <tbody>
                <tr>
                  <td style={{ position:'sticky', left:0, background:'var(--surface)', color:'var(--text2)', padding:'5px 10px', borderRight:'1px solid var(--border)', whiteSpace:'nowrap' }}>Расход, ₽</td>
                  {dates.map(d => (
                    <td key={d} style={{ padding:'5px 6px', textAlign:'center', background: heatColor(camp.byDate[d]?.spend, min, max, 'neutral'), whiteSpace:'nowrap' }}>
                      {fmtValue(camp.byDate[d]?.spend, 'money0')}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdsStats({ cabinet }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [cabinets, setCabinets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [expandedArticles, setExpandedArticles] = useState(() => new Set());

  const [onlyActive, setOnlyActive] = useState(false);
  const [search, setSearch] = useState('');
  const [paymentFilter, setPaymentFilter] = useState('');
  const [placementFilter, setPlacementFilter] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([getAdsStats(cabinet, days), getAdsCabinets()])
      .then(([statsRes, cabRes]) => {
        setData(statsRes.data.data);
        setCabinets(cabRes.data.data);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [cabinet, days]);

  useEffect(() => { load(); }, [load]);

  const cabInfo = cabinets.find(c => c.id === cabinet);
  const notConfigured = cabInfo && !cabInfo.ozonSellerConfigured && !cabInfo.ozonPerfConfigured;

  async function handleCollect() {
    setCollecting(true);
    try {
      await collectAds(cabinet, days);
      setTimeout(load, 15000);
    } finally {
      setTimeout(() => setCollecting(false), 15000);
    }
  }

  function toggleArticle(key) {
    setExpandedArticles(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const dates = data?.dates || [];
  const articlesRaw = data?.articles || [];

  // Все фильтры применяются к кампаниям (AND), артикул скрывается только
  // если после фильтрации у него не осталось ни одной кампании.
  const articles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return articlesRaw
      .map(article => {
        const campaigns = article.campaigns.filter(c => {
          if (onlyActive && c.state !== 'CAMPAIGN_STATE_RUNNING') return false;
          if (q && !(c.title || '').toLowerCase().includes(q) && !(c.campaignId || '').includes(q)) return false;
          if (paymentFilter && paymentBucket(c.paymentType) !== paymentFilter) return false;
          if (placementFilter && placementBucket(c.placement) !== placementFilter) return false;
          return true;
        });
        return { ...article, campaigns };
      })
      .filter(a => a.campaigns.length > 0);
  }, [articlesRaw, onlyActive, search, paymentFilter, placementFilter]);

  if (loading && !data) return <div style={{ padding:60, textAlign:'center', color:'var(--text2)' }}>Загрузка...</div>;

  const selectStyle = { padding:'6px 10px', borderRadius:8, border:'1px solid var(--border)', background:'var(--surface2)', color:'var(--text)', fontSize:13 };

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
        <h1 style={{ fontSize:17, fontWeight:700, margin:0 }}>Реклама</h1>
        <div style={{ display:'flex', gap:3, background:'var(--surface2)', borderRadius:8, padding:3 }}>
          {DAY_OPTIONS.map(d => (
            <button key={d} onClick={() => setDays(d)} style={{
              padding:'5px 14px', borderRadius:6, border:'none', fontSize:13, fontWeight:500,
              background: days===d ? '#334155' : 'transparent',
              color: days===d ? '#fff' : 'var(--text2)',
            }}>{d} дн.</button>
          ))}
        </div>
        <button onClick={handleCollect} disabled={collecting} style={{
          marginLeft:'auto', padding:'7px 14px', borderRadius:8, border:'1px solid var(--border)',
          background:'var(--surface2)', color:'var(--text)', fontSize:13, fontWeight:500,
          cursor: collecting ? 'default' : 'pointer', opacity: collecting ? 0.6 : 1,
        }}>
          {collecting ? 'Собираем...' : '↻ Обновить данные'}
        </button>
      </div>

      {/* Фильтры — все работают параллельно (AND) */}
      <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:10 }}>
        <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:13, color:'var(--text2)', cursor:'pointer' }}>
          <input type="checkbox" checked={onlyActive} onChange={e => setOnlyActive(e.target.checked)} />
          Только активные РК
        </label>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Поиск по названию РК…"
          style={{ ...selectStyle, minWidth:180 }}
        />
        <select value={paymentFilter} onChange={e => setPaymentFilter(e.target.value)} style={selectStyle}>
          {PAYMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={placementFilter} onChange={e => setPlacementFilter(e.target.value)} style={selectStyle}>
          {PLACEMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {notConfigured && (
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:16, color:'var(--text2)', fontSize:13 }}>
          Для кабинета «{cabInfo?.label || cabinet}» ещё не добавлены токены Ozon в настройках сервера — реклама пока не собирается.
          Нужны переменные окружения <code>{cabinet.toUpperCase()}_OZON_CLIENT_ID</code>, <code>{cabinet.toUpperCase()}_OZON_API_KEY</code>,{' '}
          <code>{cabinet.toUpperCase()}_OZON_PERF_CLIENT_ID</code>, <code>{cabinet.toUpperCase()}_OZON_PERF_SECRET</code>.
        </div>
      )}

      {!notConfigured && articlesRaw.length === 0 && (
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:16, color:'var(--text2)', fontSize:13 }}>
          Данных пока нет. Нажмите «Обновить данные», чтобы собрать статистику по рекламным кампаниям.
        </div>
      )}

      {!notConfigured && articlesRaw.length > 0 && articles.length === 0 && (
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:16, color:'var(--text2)', fontSize:13 }}>
          Под текущие фильтры ничего не подошло.
        </div>
      )}

      {articles.map(article => {
        const key = article.offerId || '__unmatched__';
        const isOpen = expandedArticles.has(key) || articles.length <= 2;
        return (
          <div key={key} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
            <div onClick={() => toggleArticle(key)} style={{
              display:'flex', alignItems:'center', gap:10, padding:'12px 16px', cursor:'pointer',
              background:'var(--surface2)', flexWrap:'wrap',
            }}>
              <span>{isOpen ? '▾' : '▸'}</span>
              <span style={{ fontSize:15, fontWeight:700 }}>{article.offerId || 'Без привязки к артикулу'}</span>
              {article.productName && <span style={{ color:'var(--text3)', fontSize:12 }}>{article.productName}</span>}
              <span style={{ marginLeft:'auto', fontSize:12, color:'var(--text2)', display:'flex', gap:14 }}>
                <span>РК: {article.campaigns.length}</span>
                <span>Расход: {fmtValue(article.totals.spend, 'money0')} ₽</span>
                <span style={{ fontWeight:700 }}>Общий ДРР: {fmtValue(article.totals.drr, 'pct')}</span>
              </span>
            </div>

            {isOpen && (
              <>
                <div style={{ overflowX:'auto' }}>
                  <table style={{ borderCollapse:'collapse', fontSize:12, minWidth: 260 + dates.length * 62, width:'100%' }}>
                    <thead>
                      <tr>
                        <th style={{ position:'sticky', left:0, zIndex:2, background:'var(--surface)', borderBottom:'2px solid var(--border)', borderRight:'1px solid var(--border)', padding:'8px 10px', textAlign:'left', minWidth:220 }}>Метрика</th>
                        {dates.map(d => (
                          <th key={d} style={{ borderBottom:'2px solid var(--border)', padding:'8px 6px', fontWeight:600, color:'var(--text2)', whiteSpace:'nowrap' }}>
                            {d.slice(8,10)}.{d.slice(5,7)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <BlockLabel>Показатели</BlockLabel>
                      <MetricTable rows={FUNNEL_ROWS} dates={dates} byDate={article.byDate} />
                      <BlockLabel>Конверсии</BlockLabel>
                      <MetricTable rows={CONVERSION_ROWS} dates={dates} byDate={article.byDate} />
                    </tbody>
                  </table>
                </div>

                <ArticleCompareChart dates={dates} byDate={{
                  ...Object.fromEntries(dates.map(d => [d, {
                    ...article.byDate[d],
                    spend: dates.includes(d) ? article.campaigns.reduce((s,c) => s + (c.byDate[d]?.spend || 0), 0) : 0,
                    drr: article.byDate[d]?.revenue > 0
                      ? (article.campaigns.reduce((s,c) => s + (c.byDate[d]?.spend || 0), 0) / article.byDate[d].revenue * 100)
                      : 0,
                  }]))
                }} />

                <div style={{ padding:'4px 0 12px' }}>
                  <div style={{ padding:'8px 16px 0', fontSize:11, color:'var(--text3)', fontWeight:700, textTransform:'uppercase', letterSpacing:.4 }}>
                    Рекламные кампании
                  </div>
                  {article.campaigns.map(camp => (
                    <CampaignBlock key={camp.campaignId} camp={camp} article={article} dates={dates} />
                  ))}
                  <div style={{ display:'flex', justifyContent:'space-between', padding:'10px 20px 0', fontSize:13, fontWeight:700, color:'var(--text)' }}>
                    <span>Общий ДРР по артикулу ({article.campaigns.length} РК)</span>
                    <span>{fmtValue(article.totals.drr, 'pct')}</span>
                  </div>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
