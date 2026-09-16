import React, { useState, useEffect, useCallback, useMemo } from 'react';
import dayjs from 'dayjs';
import {
  ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend,
} from 'recharts';
import { getAdsStats, getAdsCabinets, collectAds, saveManualAdsMetric } from '../api';

const DAY_OPTIONS = [14, 30, 60];

// Блок 1 — сырые показатели воронки (общие для артикула, из общей аналитики
// по товару, как на Дашборде). editable — можно ввести значение вручную,
// если сбор с Ozon по этой метрике/дате ничего не дал (см. AdsStats/backend
// product_analytics_manual) — данные с маркетплейса всегда в приоритете,
// ручное значение только подстраховка.
const FUNNEL_ROWS = [
  { key: 'revenue',   label: 'Заказы, ₽',            fmt: 'money', good: 'up',   editable: true },
  { key: 'orders',    label: 'Заказы, шт',            fmt: 'int',   good: 'up',   editable: true },
  { key: 'position',  label: 'Позиция в поиске',      fmt: 'pos',   good: 'down',  editable: true },
  { key: 'views',     label: 'Показы',                fmt: 'int',   good: 'up',   editable: true },
  { key: 'pdpViews',  label: 'Переходы на карточку',  fmt: 'int',   good: 'up',   editable: true },
  { key: 'cart',      label: 'Корзины',                fmt: 'int',   good: 'up',   editable: true },
];

// Блок 2 — конверсии, отдельным визуальным блоком.
const CONVERSION_ROWS = [
  { key: 'ctr',        label: 'СТР (карточка/показ)', fmt: 'pct', good: 'up' },
  { key: 'crToCart',   label: 'СР в корзину',          fmt: 'pct', good: 'up' },
  { key: 'crToOrder',  label: 'СР в заказ',            fmt: 'pct', good: 'up' },
];

// Блок 3 — расход и ДРР внизу таблицы (просили не мешать со сводкой выше).
const SPEND_ROWS = [
  { key: 'spend', label: 'Расход, ₽', fmt: 'money0', good: 'neutral' },
  { key: 'drr',   label: 'ДРР',       fmt: 'pct',    good: 'down' },
];

// Метрики для графика сравнения — фиксированный порядок цветов (как на
// Дашборде: --series-1..8), максимум 8 штук под 8 доступных цветов.
const METRIC_OPTIONS = [
  { key: 'views',    label: 'Показы',               series: 'series-1' },
  { key: 'pdpViews', label: 'Переходы на карточку', series: 'series-2' },
  { key: 'cart',     label: 'Корзины',               series: 'series-3' },
  { key: 'orders',   label: 'Заказы, шт',            series: 'series-4' },
  { key: 'revenue',  label: 'Заказы, ₽',             series: 'series-5' },
  { key: 'ctr',      label: 'СТР',                   series: 'series-6' },
  { key: 'spend',    label: 'Расход, ₽',             series: 'series-7' },
  { key: 'drr',      label: 'ДРР',                   series: 'series-8' },
];

const PLACEMENT_OPTIONS = [
  { value: '', label: 'Все зоны' },
  { value: 'search', label: 'Поиск' },
  { value: 'search_and_category', label: 'Поиск и рекомендации' },
];

const PAYMENT_OPTIONS = [
  { value: '', label: 'Все типы РК' },
  { value: 'cpc', label: 'Ср. стоимость клика' },
  { value: 'target', label: 'Целевой расход' },
];

const SORT_OPTIONS = [
  { value: 'spend', label: 'По расходу' },
  { value: 'drr', label: 'По ДРР' },
  { value: 'name', label: 'По названию' },
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

// "Естественная" сортировка строк с числами — чтобы "2.Тест..." шёл перед
// "10.Тест...", как в самом Ozon, а не по алфавиту.
function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const pa = String(a || '').match(re) || [];
  const pb = String(b || '').match(re) || [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || '', y = pb[i] || '';
    if (x !== y) {
      const nx = parseInt(x, 10), ny = parseInt(y, 10);
      if (!isNaN(nx) && !isNaN(ny)) return nx - ny;
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function fmtValue(v, fmt) {
  if (v === null || v === undefined) return '—';
  switch (fmt) {
    case 'money':  return Math.round(v).toLocaleString('ru-RU');
    case 'money0': return v ? Math.round(v).toLocaleString('ru-RU') : '—';
    case 'int':    return Math.round(v).toLocaleString('ru-RU');
    case 'pct':    return `${v.toFixed(1)}%`;
    case 'pos':    return v.toFixed(1);
    default:       return String(v);
  }
}

function heatColor(v, min, max, direction) {
  if (v === null || v === undefined || max === min || direction === 'neutral') return 'transparent';
  let t = (v - min) / (max - min);
  if (direction === 'down') t = 1 - t;
  t = Math.max(0, Math.min(1, t));
  const hue = 120 * t;
  return `hsla(${hue}, 65%, 42%, 0.35)`;
}

// Редактируемая ячейка — клик превращает значение в поле ввода; Enter или
// потеря фокуса сохраняет (POST /api/ads/manual), Escape отменяет. Пока
// сохраняется — значение приглушено, чтобы был виден отклик на клик.
function EditableCell({ value, fmt, background, manual, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setDraft(value !== null && value !== undefined ? String(value) : '');
    setEditing(true);
  }

  async function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === (value !== null && value !== undefined ? String(value) : '')) return;
    setSaving(true);
    try { await onSave(trimmed === '' ? null : trimmed); }
    finally { setSaving(false); }
  }

  if (editing) {
    return (
      <td style={{ padding:'2px 4px', textAlign:'center', background }}>
        <input
          autoFocus
          type="number"
          min="0"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') e.target.blur();
            if (e.key === 'Escape') setEditing(false);
          }}
          style={{ width:56, textAlign:'center', padding:'2px 4px', borderRadius:4, border:'1px solid var(--border)' }}
        />
      </td>
    );
  }

  return (
    <td
      onClick={startEdit}
      title={manual ? 'Введено вручную — заменится данными Ozon, как только они появятся' : 'Нажмите, чтобы ввести значение вручную'}
      style={{
        padding:'5px 6px', textAlign:'center', background, color:'var(--text)', whiteSpace:'nowrap',
        cursor:'pointer', opacity: saving ? 0.5 : 1,
        boxShadow: manual ? 'inset 0 0 0 1px var(--accent, #6366f1)' : 'none',
      }}
    >
      {fmtValue(value, fmt)}{manual && <span style={{ fontSize:9, verticalAlign:'super', color:'var(--accent, #6366f1)', marginLeft:2 }}>✎</span>}
    </td>
  );
}

function MetricTable({ rows, dates, byDate, onManualSave }) {
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
            {values.map((v, i) => {
              const d = dates[i];
              const background = heatColor(v, min, max, row.good);
              if (row.editable && onManualSave) {
                return (
                  <EditableCell
                    key={d}
                    value={v}
                    fmt={row.fmt}
                    background={background}
                    manual={!!byDate[d]?.manual?.[row.key]}
                    onSave={val => onManualSave(d, row.key, val)}
                  />
                );
              }
              return (
                <td key={d} style={{
                  padding:'5px 6px', textAlign:'center', background,
                  color:'var(--text)', whiteSpace:'nowrap',
                }}>
                  {fmtValue(v, row.fmt)}
                </td>
              );
            })}
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

// Сегментированный переключатель — тот же стиль, что у переключателя
// площадок (Все/WB/Ozon) в шапке приложения, вместо нативных <select>.
function Segmented({ options, value, onChange, getKey, getLabel, getActive }) {
  return (
    <div style={{ display:'flex', gap:3, background:'var(--surface2)', borderRadius:8, padding:3, flexWrap:'wrap' }}>
      {options.map(opt => {
        const key = getKey ? getKey(opt) : opt.value;
        const active = getActive ? getActive(opt) : value === opt.value;
        return (
          <button key={key} onClick={() => onChange(opt.value)} style={{
            padding:'5px 12px', borderRadius:6, border:'none', fontSize:12.5, fontWeight:500,
            background: active ? '#334155' : 'transparent',
            color: active ? '#fff' : 'var(--text2)', whiteSpace:'nowrap',
          }}>{getLabel ? getLabel(opt) : opt.label}</button>
        );
      })}
    </div>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:'8px 10px', fontSize:12 }}>
      <div style={{ color:'var(--text2)', marginBottom:4 }}>{dayjs(label).format('DD.MM.YYYY')}</div>
      {payload.map(p => {
        const opt = METRIC_OPTIONS.find(m => m.key === p.dataKey.replace('_idx', ''));
        const raw = p.payload[`${p.dataKey.replace('_idx', '')}_raw`];
        return (
          <div key={p.dataKey} style={{ display:'flex', gap:6, alignItems:'center' }}>
            <span style={{ width:8, height:8, borderRadius:4, background:p.stroke, flexShrink:0 }} />
            <span style={{ color:'var(--text2)' }}>{opt?.label || p.dataKey}:</span>
            <span style={{ fontWeight:600 }}>{fmtValue(raw, opt?.key === 'ctr' || opt?.key === 'drr' ? 'pct' : 'int')}</span>
          </div>
        );
      })}
    </div>
  );
}

// График сравнения — метрики включаются/выключаются кликом по кнопке (как
// на Дашборде), значения индексируются к первому дню = 100, чтобы разные по
// масштабу метрики (показы vs ДРР) можно было сравнивать на одной оси.
function ArticleCompareChart({ dates, byDate, storageKey }) {
  const [selected, setSelected] = useState(() => {
    try { return JSON.parse(localStorage.getItem(storageKey)) || ['views', 'orders']; }
    catch(e) { return ['views', 'orders']; }
  });
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(selected)); } catch(e) {} }, [selected, storageKey]);

  function toggle(key) {
    setSelected(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  }

  const chartData = useMemo(() => {
    const bases = {};
    for (const m of selected) {
      const firstNonZero = dates.map(d => byDate[d]?.[m]).find(v => v !== null && v !== undefined && v !== 0);
      bases[m] = firstNonZero || null;
    }
    return dates.map(d => {
      const row = { date: d };
      for (const m of selected) {
        const raw = byDate[d]?.[m] ?? null;
        row[`${m}_raw`] = raw;
        row[`${m}_idx`] = (raw !== null && bases[m]) ? (raw / bases[m]) * 100 : null;
      }
      return row;
    });
  }, [dates, byDate, selected]);

  return (
    <div style={{ padding:14, background:'var(--surface)', borderTop:'1px solid var(--border)' }}>
      <div style={{ fontSize:12, fontWeight:600, color:'var(--text2)', marginBottom:8 }}>Сравнение метрик во времени (индекс, день 1 = 100)</div>
      <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:12 }}>
        {METRIC_OPTIONS.map(m => {
          const active = selected.includes(m.key);
          return (
            <button key={m.key} onClick={() => toggle(m.key)} style={{
              padding:'4px 10px', borderRadius:6, border:'1px solid var(--border)',
              background: active ? `var(--${m.series})` : 'var(--surface2)',
              color: active ? '#fff' : 'var(--text2)', fontSize:12, fontWeight:500,
            }}>{m.label}</button>
          );
        })}
      </div>
      {!selected.length ? (
        <div style={{ padding:32, textAlign:'center', color:'var(--text2)' }}>Выберите хотя бы одну метрику</div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={chartData} margin={{ top:4, right:8, left:0, bottom:0 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="date" tickFormatter={d => dayjs(d).format('DD.MM')}
              stroke="var(--text3)" fontSize={11} tickLine={false} axisLine={{ stroke:'var(--border)' }} />
            <YAxis stroke="var(--text3)" fontSize={11} tickLine={false} axisLine={false} width={40} />
            <Tooltip content={<ChartTooltip />} />
            {selected.length > 1 && <Legend wrapperStyle={{ fontSize:12 }}
              formatter={(value) => METRIC_OPTIONS.find(m => `${m.key}_idx` === value)?.label || value} />}
            {selected.map(key => {
              const opt = METRIC_OPTIONS.find(m => m.key === key);
              return (
                <Line key={key} type="monotone" dataKey={`${key}_idx`} name={`${key}_idx`}
                  stroke={`var(--${opt.series})`} strokeWidth={2} dot={{ r:3 }} activeDot={{ r:4 }} connectNulls />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// Компактный, НЕ раскрывающийся список кампаний артикула — раньше каждую РК
// нужно было ещё раз раскрывать отдельно, что было запутанно. Теперь всё
// видно сразу одним списком: полное название (как в самом Ozon), статус,
// тип, зона показа, расход и ДРР по каждой конкретной РК.
// Один блок сводки — крупное число + подпись, в общем стиле карточек
// приложения (var(--surface2) фон, тонкая рамка).
function StatCard({ label, value, accent }) {
  return (
    <div style={{
      background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:8,
      padding:'10px 14px', minWidth:120, flex:'1 1 130px',
    }}>
      <div style={{ fontSize:11, color:'var(--text3)', marginBottom:4, whiteSpace:'nowrap' }}>{label}</div>
      <div style={{ fontSize:19, fontWeight:700, color: accent || 'var(--text)' }}>{value}</div>
    </div>
  );
}

// Сводка по артикулу за весь выбранный период — показывается сразу при
// раскрытии карточки, до списка кампаний и таблицы по дням, чтобы не
// прокручивать/складывать в уме дневные значения ради общей картины.
function ArticleSummary({ totals }) {
  const cards = [
    { label: 'Заказано, ₽',            value: fmtValue(totals.revenue, 'money') },
    { label: 'Заказано, шт',           value: fmtValue(totals.orders, 'int') },
    { label: 'Показы',                 value: fmtValue(totals.views, 'int') },
    { label: 'Переходы на карточку',   value: fmtValue(totals.pdpViews, 'int') },
    { label: 'Корзины',                value: fmtValue(totals.cart, 'int') },
    { label: 'Расход, ₽',              value: fmtValue(totals.spend, 'money0') },
    { label: 'ДРР',                    value: fmtValue(totals.drr, 'pct') },
  ];
  return (
    <div style={{ display:'flex', gap:8, flexWrap:'wrap', padding:'12px 16px 4px' }}>
      {cards.map(c => <StatCard key={c.label} {...c} />)}
    </div>
  );
}

function CampaignsList({ campaigns }) {
  return (
    <div style={{ maxHeight: 420, overflowY:'auto', border:'1px solid var(--border)', borderRadius:8, margin:'0 10px 10px' }}>
      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12.5 }}>
        <thead>
          <tr style={{ position:'sticky', top:0, background:'var(--surface2)', zIndex:1 }}>
            <th style={{ textAlign:'left', padding:'7px 10px', fontWeight:600, color:'var(--text3)' }}>Название</th>
            <th style={{ textAlign:'left', padding:'7px 8px', fontWeight:600, color:'var(--text3)' }}>Статус</th>
            <th style={{ textAlign:'left', padding:'7px 8px', fontWeight:600, color:'var(--text3)' }}>Тип</th>
            <th style={{ textAlign:'left', padding:'7px 8px', fontWeight:600, color:'var(--text3)' }}>Зона</th>
            <th style={{ textAlign:'right', padding:'7px 10px', fontWeight:600, color:'var(--text3)' }}>Расход, ₽</th>
            <th style={{ textAlign:'right', padding:'7px 10px', fontWeight:600, color:'var(--text3)' }}>ДРР</th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map(camp => (
            <tr key={camp.campaignId} style={{ borderTop:'1px solid var(--border)' }}>
              <td style={{ padding:'7px 10px', color:'var(--text)', whiteSpace:'normal', wordBreak:'break-word' }}>{camp.title || camp.campaignId}</td>
              <td style={{ padding:'7px 8px' }}>
                <span style={{
                  fontSize:11, padding:'2px 8px', borderRadius:999, whiteSpace:'nowrap',
                  background: camp.state === 'CAMPAIGN_STATE_RUNNING' ? 'rgba(34,197,94,.18)' : 'rgba(148,163,184,.18)',
                  color: camp.state === 'CAMPAIGN_STATE_RUNNING' ? 'var(--ok, #22c55e)' : 'var(--text3)',
                }}>{camp.state === 'CAMPAIGN_STATE_RUNNING' ? 'активна' : 'выключена'}</span>
              </td>
              <td style={{ padding:'7px 8px', color:'var(--text2)', whiteSpace:'nowrap' }}>
                {camp.paymentType ? (paymentBucket(camp.paymentType) === 'cpc' ? 'CPC' : 'Цел. расход') : '—'}
              </td>
              <td style={{ padding:'7px 8px', color:'var(--text2)', whiteSpace:'nowrap' }}>
                {placementBucket(camp.placement) === 'search' ? 'Поиск' : placementBucket(camp.placement) ? 'Поиск+рек.' : '—'}
              </td>
              <td style={{ padding:'7px 10px', textAlign:'right', whiteSpace:'nowrap' }}>{fmtValue(camp.totalSpend, 'money0')}</td>
              <td style={{ padding:'7px 10px', textAlign:'right', whiteSpace:'nowrap', fontWeight:600 }}>{fmtValue(camp.drr, 'pct')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Карточка одного артикула — вынесена отдельным компонентом, чтобы хук
// useMemo (расход/ДРР по дням) вызывался безусловно на верхнем уровне
// компонента, а не внутри .map() у родителя (это нарушало Rules of Hooks).
function ArticleCard({ article, dates, cabinet, isOpen, onToggle, onManualSave }) {
  const mergedByDate = useMemo(() => {
    const out = {};
    for (const d of dates) {
      const spend = article.campaigns.reduce((s, c) => s + (c.byDate[d]?.spend || 0), 0);
      const revenue = article.byDate[d]?.revenue || 0;
      out[d] = { ...article.byDate[d], spend, drr: revenue > 0 ? spend / revenue * 100 : (spend > 0 ? 100 : 0) };
    }
    return out;
  }, [article, dates]);

  return (
    <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
      <div onClick={onToggle} style={{
        display:'flex', alignItems:'center', gap:10, padding:'12px 16px', cursor:'pointer',
        background:'var(--surface2)', flexWrap:'wrap',
      }}>
        <span>{isOpen ? '▾' : '▸'}</span>
        <span style={{ fontSize:15, fontWeight:700 }}>{article.offerId || 'Без привязки к артикулу'}</span>
        {article.productName && <span style={{ color:'var(--text3)', fontSize:12 }}>{article.productName}</span>}
        <span style={{ marginLeft:'auto', fontSize:12, color:'var(--text2)', display:'flex', gap:14 }}>
          <span>РК: {article.campaigns.length}</span>
          <span>Расход: {fmtValue(article.totals.spend, 'money0')} ₽</span>
          <span style={{ fontWeight:700 }}>ДРР: {fmtValue(article.totals.drr, 'pct')}</span>
        </span>
      </div>

      {isOpen && (
        <>
          <ArticleSummary totals={article.totals} />

          <div style={{ padding:'10px 0 0' }}>
            <div style={{ padding:'0 16px 8px', fontSize:11, color:'var(--text3)', fontWeight:700, textTransform:'uppercase', letterSpacing:.4 }}>
              Кампании ({article.campaigns.length})
            </div>
            <CampaignsList campaigns={article.campaigns} />
          </div>

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
                <MetricTable
                  rows={FUNNEL_ROWS}
                  dates={dates}
                  byDate={mergedByDate}
                  onManualSave={article.offerId && onManualSave
                    ? (date, metric, value) => onManualSave(article.offerId, date, metric, value)
                    : null}
                />
                <BlockLabel>Конверсии</BlockLabel>
                <MetricTable rows={CONVERSION_ROWS} dates={dates} byDate={mergedByDate} />
                <BlockLabel>Расход и ДРР</BlockLabel>
                <MetricTable rows={SPEND_ROWS} dates={dates} byDate={mergedByDate} />
              </tbody>
            </table>
          </div>

          <ArticleCompareChart dates={dates} byDate={mergedByDate} storageKey={`mp-ads-chart-${cabinet}`} />
        </>
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
  const [sortBy, setSortBy] = useState('spend');

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

  // Сохраняет ручное значение и сразу обновляет локальное состояние (не
  // дожидаясь перезагрузки), чтобы ввод ощущался мгновенным. Пересчитывать
  // totals/конверсии здесь не пытаемся — они подтянутся точным значением
  // при следующей загрузке (load()), а до этого приблизительны.
  function handleManualSave(offerId, date, metric, value) {
    return saveManualAdsMetric(cabinet, offerId, date, metric, value)
      .then(() => {
        setData(prev => {
          if (!prev) return prev;
          const articles = prev.articles.map(a => {
            if (a.offerId !== offerId) return a;
            const day = a.byDate[date] || {};
            const cleared = value === null || value === '';
            // У позиции в поиске "пусто" — это null ("нет данных"), а не 0
            // (0 была бы отличной позицией), поэтому сброс ведёт себя иначе,
            // чем у остальных метрик.
            const numValue = cleared ? (metric === 'position' ? null : 0) : Number(value);
            return {
              ...a,
              byDate: {
                ...a.byDate,
                [date]: {
                  ...day,
                  [metric]: numValue,
                  manual: { ...day.manual, [metric]: !cleared },
                },
              },
            };
          });
          return { ...prev, articles };
        });
      })
      .catch(e => {
        console.error(e);
        window.alert('Не удалось сохранить значение — попробуйте ещё раз.');
      });
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

  // Фильтры применяются к кампаниям (все параллельно, через И), артикул
  // скрывается только если после фильтрации у него не осталось РК.
  // Кампании внутри артикула сортируются "естественно" по названию — так
  // же, как их нумерует сам Ozon (1., 2., ... 10., а не 1,10,2 по алфавиту).
  const articles = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = articlesRaw
      .map(article => {
        const campaigns = article.campaigns
          .filter(c => {
            if (onlyActive && c.state !== 'CAMPAIGN_STATE_RUNNING') return false;
            if (q && !(c.title || '').toLowerCase().includes(q) && !(c.campaignId || '').includes(q)) return false;
            if (paymentFilter && paymentBucket(c.paymentType) !== paymentFilter) return false;
            if (placementFilter && placementBucket(c.placement) !== placementFilter) return false;
            return true;
          })
          .sort((a, b) => naturalCompare(a.title, b.title));
        return { ...article, campaigns };
      })
      .filter(a => a.campaigns.length > 0);

    const matched = filtered.filter(a => a.offerId);
    const unmatched = filtered.filter(a => !a.offerId);

    const cmp = sortBy === 'name'
      ? (a, b) => naturalCompare(a.campaigns[0]?.title, b.campaigns[0]?.title)
      : sortBy === 'drr'
      ? (a, b) => (b.totals.drr || 0) - (a.totals.drr || 0)
      : (a, b) => (b.totals.spend || 0) - (a.totals.spend || 0);

    matched.sort(cmp);
    unmatched.sort(cmp);
    return [...matched, ...unmatched];
  }, [articlesRaw, onlyActive, search, paymentFilter, placementFilter, sortBy]);

  if (loading && !data) return <div style={{ padding:60, textAlign:'center', color:'var(--text2)' }}>Загрузка...</div>;

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
        <h1 style={{ fontSize:17, fontWeight:700, margin:0 }}>Реклама</h1>
        <Segmented options={DAY_OPTIONS.map(d => ({ value:d, label:`${d} дн.` }))} value={days} onChange={setDays} getKey={o=>o.value} />
        <button onClick={handleCollect} disabled={collecting} style={{
          marginLeft:'auto', padding:'7px 14px', borderRadius:8, border:'1px solid var(--border)',
          background:'var(--surface2)', color:'var(--text)', fontSize:13, fontWeight:500,
          cursor: collecting ? 'default' : 'pointer', opacity: collecting ? 0.6 : 1,
        }}>
          {collecting ? 'Собираем...' : '↻ Обновить данные'}
        </button>
      </div>

      {/* Фильтры и сортировка — всё работает параллельно (И) */}
      <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:10 }}>
        <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:13, color:'var(--text2)', cursor:'pointer' }}>
          <input type="checkbox" checked={onlyActive} onChange={e => setOnlyActive(e.target.checked)} />
          Только активные РК
        </label>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Поиск по названию РК…"
          style={{ padding:'6px 10px', borderRadius:8, minWidth:180 }}
        />
        <Segmented options={PAYMENT_OPTIONS} value={paymentFilter} onChange={setPaymentFilter} />
        <Segmented options={PLACEMENT_OPTIONS} value={placementFilter} onChange={setPlacementFilter} />
        <span style={{ marginLeft:'auto', fontSize:12, color:'var(--text3)' }}>Сортировка:</span>
        <Segmented options={SORT_OPTIONS} value={sortBy} onChange={setSortBy} />
      </div>

      {notConfigured && (
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:16, color:'var(--text2)', fontSize:13 }}>
          Для кабинета «{cabInfo?.label || cabinet}» ещё не добавлены токены Ozon в настройках сервера — реклама пока не собирается.
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
        return (
          <ArticleCard
            key={key}
            article={article}
            dates={dates}
            cabinet={cabinet}
            isOpen={expandedArticles.has(key)}
            onToggle={() => toggleArticle(key)}
            onManualSave={handleManualSave}
          />
        );
      })}
    </div>
  );
}
