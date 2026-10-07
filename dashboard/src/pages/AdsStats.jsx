import React, { useState, useEffect, useCallback, useMemo } from 'react';
import dayjs from 'dayjs';
import {
  ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend,
} from 'recharts';
import { getAdsStats, getAdsCabinets, getAdsDataStatus, collectAds, saveManualAdsMetric, saveManualStock, getAdsOrder, saveAdsOrder, getAdsGroups, addAdsGroup, removeAdsGroup, assignAdsGroup, getSiblingClusters, addAdsGroupFromCluster, reorderAdsGroups, getAdsCatalog } from '../api';
import DateRangePicker from '../components/DateRangePicker';

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
// Расход подсвечивается по дням тепловой картой (good:'up'), чтобы было
// сразу видно, в какие дни лили больше денег в рекламу. avgCpc и spend —
// editable (см. FUNNEL_ROWS выше): можно ввести вручную, пока не работает
// сбор расхода с Ozon. ДРР остаётся производной (считается от расхода и
// заказов), её вводить вручную нет смысла.
const SPEND_ROWS = [
  { key: 'avgCpc', label: 'Ср. цена клика, ₽', fmt: 'money2', good: 'down', editable: true },
  { key: 'spend',  label: 'Расход, ₽',          fmt: 'money0', good: 'up',   editable: true },
  { key: 'drr',    label: 'ДРР',                fmt: 'pct',    good: 'down' },
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
  { value: 'manual', label: 'Свой порядок' },
];

// Фиксированный набор артикулов для блока "Общая статистика" — не связан
// с фильтрами/сортировкой основного списка ниже, показывает сводку только
// по этим товарам.
const GENERAL_STATS_OFFER_IDS = [
  'Hv4-2KR', 'Hv4-2', 'Hv4-2K', 'V015-5-2KR', 'Hnd1-2K', 'V017-2K', 'V020-2', 'Fr2-2K',
  'Fr1-2KR', 'V024-2K', 'V023-2K', 'Kia3-2K', 'Vw1-2K', 'Rn1-2KR',
  'Rn5-2', 'U2-2K',
];

// Метрики на выбор для таблицы по дням в "Общей статистике" — та же
// палитра показателей, что и в карточке артикула, но выбирается только
// одна за раз (не блоками, как в FUNNEL/CONVERSION/SPEND_ROWS).
const GENERAL_METRIC_OPTIONS = [
  { key: 'revenue',    label: 'Заказы, ₽',            fmt: 'money',  good: 'up' },
  { key: 'orders',     label: 'Заказы, шт',            fmt: 'int',    good: 'up' },
  { key: 'views',      label: 'Показы',                fmt: 'int',    good: 'up' },
  { key: 'pdpViews',   label: 'Переходы на карточку',  fmt: 'int',    good: 'up' },
  { key: 'cart',       label: 'Корзины',                fmt: 'int',    good: 'up' },
  { key: 'ctr',        label: 'СТР (карточка/показ)',  fmt: 'pct',    good: 'up' },
  { key: 'crToCart',   label: 'СР в корзину',          fmt: 'pct',    good: 'up' },
  { key: 'crToOrder',  label: 'СР в заказ',            fmt: 'pct',    good: 'up' },
  { key: 'spend',      label: 'Расход, ₽',             fmt: 'money0', good: 'up' },
  { key: 'drr',        label: 'ДРР',                   fmt: 'pct',    good: 'down' },
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
    case 'money2': return v ? v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
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
        position:'relative',
        padding:'5px 6px', textAlign:'center', background, color:'var(--text)', whiteSpace:'nowrap',
        cursor:'pointer', opacity: saving ? 0.5 : 1,
      }}
    >
      {fmtValue(value, fmt)}
      {manual && (
        <span style={{
          position:'absolute', top:2, right:2, width:4, height:4, borderRadius:'50%',
          background:'var(--accent, #6366f1)', opacity:0.55,
        }} />
      )}
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
              position:'sticky', left:0, zIndex:1, background:'var(--surface)', color:'var(--text2)',
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
        position:'sticky', left:0, zIndex:1, background:'var(--surface2)', color:'var(--text3)',
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

// Редактируемая карточка остатков — та же идея, что у EditableCell в
// таблице по дням, но остаток не привязан к дате (это "текущее" значение,
// см. ad_product_stocks/ad_stock_manual), поэтому отдельный небольшой
// компонент с двумя полями (FBO и FBS) вместо одной ячейки.
function StockCard({ stock, onSaveStock }) {
  const [editing, setEditing] = useState(false);
  const [fbo, setFbo] = useState('');
  const [fbs, setFbs] = useState('');
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setFbo(stock?.fboPresent != null ? String(stock.fboPresent) : '');
    setFbs(stock?.fbsPresent != null ? String(stock.fbsPresent) : '');
    setEditing(true);
  }

  async function commit() {
    setEditing(false);
    setSaving(true);
    try {
      await Promise.all([
        onSaveStock('fboPresent', fbo.trim() === '' ? null : fbo.trim()),
        onSaveStock('fbsPresent', fbs.trim() === '' ? null : fbs.trim()),
      ]);
    } catch (e) {
      console.error(e);
      window.alert('Не удалось сохранить остаток — попробуйте ещё раз.');
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div style={{
        background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:8,
        padding:'10px 14px', minWidth:160, flex:'1 1 160px',
      }}>
        <div style={{ fontSize:11, color:'var(--text3)', marginBottom:4, whiteSpace:'nowrap' }}>Остатки (FBO · FBS)</div>
        <div style={{ display:'flex', gap:6, alignItems:'center' }}>
          <input
            autoFocus type="number" min="0" value={fbo} onChange={e => setFbo(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setEditing(false); }}
            style={{ width:56, textAlign:'center', padding:'2px 4px', borderRadius:4, border:'1px solid var(--border)' }}
          />
          <span style={{ color:'var(--text3)' }}>·</span>
          <input
            type="number" min="0" value={fbs} onChange={e => setFbs(e.target.value)}
            onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setEditing(false); }}
            style={{ width:56, textAlign:'center', padding:'2px 4px', borderRadius:4, border:'1px solid var(--border)' }}
          />
        </div>
      </div>
    );
  }

  const manual = !!(stock?.manual?.fboPresent || stock?.manual?.fbsPresent);
  return (
    <div
      onClick={onSaveStock ? startEdit : undefined}
      title={onSaveStock ? (manual ? 'Введено вручную — заменится данными Ozon, как только они появятся' : 'Нажмите, чтобы ввести остатки вручную') : undefined}
      style={{
        position:'relative',
        background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:8,
        padding:'10px 14px', minWidth:120, flex:'1 1 130px',
        cursor: onSaveStock ? 'pointer' : 'default', opacity: saving ? 0.5 : 1,
      }}
    >
      <div style={{ fontSize:11, color:'var(--text3)', marginBottom:4, whiteSpace:'nowrap' }}>Остатки (FBO · FBS)</div>
      <div style={{ fontSize:19, fontWeight:700 }}>{fmtValue(stock?.fboPresent, 'int')} · {fmtValue(stock?.fbsPresent, 'int')}</div>
      {manual && (
        <span style={{
          position:'absolute', top:8, right:8, width:5, height:5, borderRadius:'50%',
          background:'var(--accent, #6366f1)', opacity:0.55,
        }} />
      )}
    </div>
  );
}

// Сводка по артикулу за весь выбранный период — показывается сразу при
// раскрытии карточки, до списка кампаний и таблицы по дням, чтобы не
// прокручивать/складывать в уме дневные значения ради общей картины.
function ArticleSummary({ totals, stock, onSaveStock }) {
  const cards = [
    { label: 'Заказано, ₽',            value: fmtValue(totals.revenue, 'money') },
    { label: 'Заказано, шт',           value: fmtValue(totals.orders, 'int') },
    { label: 'Показы',                 value: fmtValue(totals.views, 'int') },
    { label: 'Переходы на карточку',   value: fmtValue(totals.pdpViews, 'int') },
    { label: 'Корзины',                value: fmtValue(totals.cart, 'int') },
    { label: 'Расход, ₽',              value: fmtValue(totals.spend, 'money0') },
    { label: 'ДРР',                    value: fmtValue(totals.drr, 'pct') },
  ];
  // Общая конверсия за весь период — сумма/сумма (не среднее по дням),
  // отдельным рядом, чтобы не путать штучные метрики с процентами.
  const convCards = [
    { label: 'СТР (карточка/показ)', value: fmtValue(totals.ctr, 'pct') },
    { label: 'СР в корзину',          value: fmtValue(totals.crToCart, 'pct') },
    { label: 'СР в заказ',            value: fmtValue(totals.crToOrder, 'pct') },
  ];
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8, padding:'12px 16px 4px' }}>
      <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
        {cards.map(c => <StatCard key={c.label} {...c} />)}
        {/* Текущие остатки — FBO и FBS в одной карточке, "на сейчас" (не
            зависят от периода, см. ad_product_stocks). Редактируется вручную,
            когда есть offerId (см. onManualStockSave в AdsStats) — даже если
            сбор ещё ничего не собрал (stock === null), можно ввести значения
            с нуля. */}
        {(stock || onSaveStock) && <StockCard stock={stock} onSaveStock={onSaveStock} />}
      </div>
      <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
        {convCards.map(c => <StatCard key={c.label} {...c} accent="var(--text2)" />)}
      </div>
    </div>
  );
}

// Полный список метрик для таблицы "по артикулам" ниже — та же палитра,
// что и при раскрытии карточки артикула (воронка + конверсии + расход/ДРР/
// цена клика), но выбирается одна за раз, как и в таблице-сводке выше.
const ARTICLE_TABLE_METRIC_OPTIONS = [
  { key: 'orders',     label: 'Заказы, шт',            fmt: 'int',    good: 'up' },
  { key: 'revenue',    label: 'Заказы, ₽',             fmt: 'money',  good: 'up' },
  { key: 'views',      label: 'Показы',                fmt: 'int',    good: 'up' },
  { key: 'pdpViews',   label: 'Переходы на карточку',  fmt: 'int',    good: 'up' },
  { key: 'cart',       label: 'Корзины',                fmt: 'int',    good: 'up' },
  { key: 'clicks',     label: 'Клики',                  fmt: 'int',    good: 'up' },
  { key: 'ctr',        label: 'СТР (карточка/показ)',  fmt: 'pct',    good: 'up' },
  { key: 'crToCart',   label: 'СР в корзину',          fmt: 'pct',    good: 'up' },
  { key: 'crToOrder',  label: 'СР в заказ',            fmt: 'pct',    good: 'up' },
  { key: 'avgCpc',     label: 'Ср. цена клика, ₽',      fmt: 'money2', good: 'down' },
  { key: 'spend',      label: 'Расход, ₽',             fmt: 'money0', good: 'up' },
  { key: 'drr',        label: 'ДРР',                   fmt: 'pct',    good: 'down' },
];

// Производные метрики (СТР/СР в корзину/СР в заказ/ср. цена клика/ДРР) —
// ВСЕГДА считаются как отношение суммы числителя к сумме знаменателя за
// нужный промежуток (день, весь период по артикулу, весь период по всем
// артикулам сразу), а не как сумма или среднее уже готовых дневных
// процентов. Например, ДРР "Итого" за месяц — это (сумма расхода за месяц)
// / (сумма заказов за месяц), а не сумма 30 дневных значений ДРР (что было
// бы бессмысленным числом за сотни процентов).
function deriveRatios(raw) {
  return {
    ctr: raw.views > 0 ? raw.pdpViews / raw.views * 100 : 0,
    crToCart: raw.pdpViews > 0 ? raw.cart / raw.pdpViews * 100 : 0,
    crToOrder: raw.cart > 0 ? raw.orders / raw.cart * 100 : 0,
    avgCpc: raw.clicks > 0 ? raw.spend / raw.clicks : 0,
    drr: raw.revenue > 0 ? raw.spend / raw.revenue * 100 : (raw.spend > 0 ? 100 : 0),
  };
}

// Короткое "название модели" из полного названия товара — для подписи под
// артикулом в таблице ниже. У Defly почти все товары называются по схеме
// "Чехлы на сиденья <Модель>, <год>, <доп. детали>" — модель это то, что
// между типом товара и первой запятой. Известные префиксы отрезаются, а
// дальше берётся кусок строки до первой запятой (напр. из "Чехлы на сиденья
// Haval M6, 2021-н.в., ..." получаем "Haval M6").
const PRODUCT_TYPE_PREFIXES = [
  /^чехлы\s+на\s+сиден[ьи]я?\s+/i,
  /^авточехлы\s+(?:на\s+сиден[ьи]я?\s+|для\s+)?/i,
  /^накидки?\s+на\s+сиден[ьи]я?\s+(?:для\s+)?/i,
  /^коврики?\s+(?:в\s+салон\s+)?для\s+/i,
  /^брызговики\s+(?:defly,?\s*)?для\s+/i,
  /^дефлекторы\s+окон\s+(?:"[^"]*"\s+)?для\s+/i,
  /^утеплитель\s+радиатора\s+для\s+/i,
];

function extractCarModel(productName) {
  if (!productName) return null;
  let s = productName.trim();
  for (const re of PRODUCT_TYPE_PREFIXES) {
    if (re.test(s)) { s = s.replace(re, ''); break; }
  }
  const commaIdx = s.indexOf(',');
  if (commaIdx > 0) s = s.slice(0, commaIdx);
  s = s.trim();
  return s || null;
}

const ARTICLE_TABLE_RAW_KEYS = ['views', 'pdpViews', 'cart', 'orders', 'revenue', 'spend', 'clicks'];

function emptyRawTotals() {
  return { views: 0, pdpViews: 0, cart: 0, orders: 0, revenue: 0, spend: 0, clicks: 0 };
}

// Таблица под общей сводкой блока "Общая статистика" — ПО КАЖДОМУ артикулу
// отдельной строкой (а не суммой по всем сразу, как в таблице выше), с
// датами в шапке. Слева, сразу после названия артикула, зафиксированная
// колонка "Итого" — сумма/корректно посчитанное значение метрики за весь
// выбранный период по этой строке (просили: "зафиксированную колонку...
// сколько за этот период по этому артикулу"). Метрика выбирается одна за
// раз, по умолчанию — заказы в штуках.
function ArticlesMetricTable({ articles, dates, metric, onMetricChange }) {
  const config = ARTICLE_TABLE_METRIC_OPTIONS.find(m => m.key === metric) || ARTICLE_TABLE_METRIC_OPTIONS[0];

  // Сырые метрики по дням на артикул (расход/клики лежат не в article.byDate,
  // а собираются из article.campaigns — как и в карточке артикула выше) +
  // агрегат за весь период сразу, с которого пересчитываются производные
  // метрики (см. deriveRatios).
  const perArticle = useMemo(() => articles.map(a => {
    const byDate = {};
    const totalsRaw = emptyRawTotals();
    for (const d of dates) {
      const day = a.byDate[d] || {};
      const spend = a.campaigns.reduce((s, c) => s + (c.byDate[d]?.spend || 0), 0);
      const clicks = a.campaigns.reduce((s, c) => s + (c.byDate[d]?.clicks || 0), 0);
      const raw = {
        views: day.views || 0, pdpViews: day.pdpViews || 0, cart: day.cart || 0,
        orders: day.orders || 0, revenue: day.revenue || 0, spend, clicks,
      };
      byDate[d] = { ...raw, ...deriveRatios(raw) };
      for (const k of ARTICLE_TABLE_RAW_KEYS) totalsRaw[k] += raw[k];
    }
    return { article: a, byDate, total: { ...totalsRaw, ...deriveRatios(totalsRaw) } };
  }), [articles, dates]);

  const grandTotalsRaw = useMemo(() => {
    const t = emptyRawTotals();
    for (const pa of perArticle) for (const k of ARTICLE_TABLE_RAW_KEYS) t[k] += pa.total[k];
    return t;
  }, [perArticle]);
  const grandTotal = { ...grandTotalsRaw, ...deriveRatios(grandTotalsRaw) };

  const totalsByDate = useMemo(() => dates.map(d => {
    const t = emptyRawTotals();
    for (const pa of perArticle) for (const k of ARTICLE_TABLE_RAW_KEYS) t[k] += pa.byDate[d][k];
    return { ...t, ...deriveRatios(t) };
  }), [perArticle, dates]);

  // Тепловая заливка — по всем ДНЕВНЫМ ячейкам сразу (across артикулов и
  // дат), а не по строке отдельно (иначе слабый артикул выглядел бы так же
  // "жарко", как лидер) и не включая колонку "Итого" (она не из того же
  // распределения, что дневные значения, — своя заливка там только мешала бы).
  const allValues = [];
  for (const pa of perArticle) for (const d of dates) {
    const v = pa.byDate[d][metric];
    if (v !== null && v !== undefined) allValues.push(v);
  }
  const min = allValues.length ? Math.min(...allValues) : 0;
  const max = allValues.length ? Math.max(...allValues) : 0;

  // Текущий остаток (FBO+FBS прямо сейчас, не зависит от периода — см.
  // article.stock / ad_product_stocks) — отдельная колонка справа от
  // "Итого", чтобы сразу было видно, сколько товара ещё есть на складах.
  const stockOf = (a) => {
    const s = a.stock;
    if (!s) return null;
    const fbo = s.fboPresent || 0, fbs = s.fbsPresent || 0;
    return fbo + fbs;
  };
  const totalStock = perArticle.reduce((sum, pa) => {
    const v = stockOf(pa.article);
    return v === null ? sum : sum + v;
  }, 0);

  const COL1 = 240, COL2 = 96, COL3 = 86; // ширины зафиксированных колонок (артикул / итого / остаток)

  return (
    <div style={{ padding:'4px 16px 16px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8, flexWrap:'wrap' }}>
        <span style={{ fontSize:13, fontWeight:700 }}>Метрики по артикулам</span>
      </div>
      <div style={{ marginBottom:8 }}>
        <Segmented
          options={ARTICLE_TABLE_METRIC_OPTIONS.map(m => ({ value: m.key, label: m.label }))}
          value={metric}
          onChange={onMetricChange}
        />
      </div>
      <div style={{ overflowX:'auto', border:'1px solid var(--border)', borderRadius:8 }}>
        <table style={{ borderCollapse:'collapse', fontSize:12, minWidth: COL1 + COL2 + COL3 + 40 + dates.length * 62, width:'100%' }}>
          <thead>
            <tr>
              <th style={{ position:'sticky', left:0, zIndex:2, background:'var(--surface)', borderBottom:'2px solid var(--border)', borderRight:'1px solid var(--border)', padding:'8px 10px', textAlign:'left', width:COL1, minWidth:COL1 }}>Артикул</th>
              <th style={{ position:'sticky', left:COL1, zIndex:2, background:'var(--surface2)', borderBottom:'2px solid var(--border)', borderRight:'1px solid var(--border)', padding:'8px 10px', textAlign:'center', width:COL2, minWidth:COL2 }}>Итого</th>
              <th title="Текущий остаток, FBO+FBS" style={{ position:'sticky', left:COL1+COL2, zIndex:2, background:'var(--surface2)', borderBottom:'2px solid var(--border)', borderRight:'2px solid var(--border)', padding:'8px 10px', textAlign:'center', width:COL3, minWidth:COL3 }}>Остаток</th>
              {dates.map(d => (
                <th key={d} style={{ borderBottom:'2px solid var(--border)', padding:'8px 6px', fontWeight:600, color:'var(--text2)', whiteSpace:'nowrap' }}>
                  {d.slice(8,10)}.{d.slice(5,7)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {perArticle.map(({ article: a, byDate, total }) => (
              <tr key={a.offerId}>
                <td
                  title={a.productName || a.offerId}
                  style={{
                    position:'sticky', left:0, zIndex:1, background:'var(--surface)', color:'var(--text2)',
                    padding:'5px 10px', borderRight:'1px solid var(--border)',
                    maxWidth:COL1, overflow:'hidden',
                  }}
                >
                  <div style={{ display:'flex', alignItems:'baseline', gap:7, overflow:'hidden' }}>
                    <span style={{ flexShrink:0 }}>{a.offerId}</span>
                    {extractCarModel(a.productName) && (
                      <span style={{
                        fontSize:10.5, color:'var(--text3)', whiteSpace:'nowrap',
                        overflow:'hidden', textOverflow:'ellipsis',
                      }}>
                        {extractCarModel(a.productName)}
                      </span>
                    )}
                  </div>
                </td>
                <td style={{
                  position:'sticky', left:COL1, zIndex:1, background:'var(--surface2)', fontWeight:700,
                  padding:'5px 10px', borderRight:'1px solid var(--border)', textAlign:'center', whiteSpace:'nowrap',
                }}>{fmtValue(total[metric], config.fmt)}</td>
                <td style={{
                  position:'sticky', left:COL1+COL2, zIndex:1, background:'var(--surface2)', color:'var(--text2)',
                  padding:'5px 10px', borderRight:'2px solid var(--border)', textAlign:'center', whiteSpace:'nowrap',
                }}>{fmtValue(stockOf(a), 'int')}</td>
                {dates.map(d => {
                  const v = byDate[d][metric];
                  return (
                    <td key={d} style={{
                      padding:'5px 6px', textAlign:'center', background: heatColor(v, min, max, config.good),
                      color:'var(--text)', whiteSpace:'nowrap',
                    }}>{fmtValue(v, config.fmt)}</td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <td style={{
                position:'sticky', left:0, zIndex:1, background:'var(--surface2)', fontWeight:700,
                padding:'6px 10px', borderRight:'1px solid var(--border)', borderTop:'2px solid var(--border)', whiteSpace:'nowrap',
              }}>Итого</td>
              <td style={{
                position:'sticky', left:COL1, zIndex:1, background:'var(--surface2)', fontWeight:700,
                padding:'6px 10px', borderRight:'1px solid var(--border)', borderTop:'2px solid var(--border)', textAlign:'center', whiteSpace:'nowrap',
              }}>{fmtValue(grandTotal[metric], config.fmt)}</td>
              <td style={{
                position:'sticky', left:COL1+COL2, zIndex:1, background:'var(--surface2)', fontWeight:700,
                padding:'6px 10px', borderRight:'2px solid var(--border)', borderTop:'2px solid var(--border)', textAlign:'center', whiteSpace:'nowrap',
              }}>{fmtValue(totalStock, 'int')}</td>
              {totalsByDate.map((t, i) => (
                <td key={dates[i]} style={{
                  padding:'6px 6px', textAlign:'center', fontWeight:700, background:'var(--surface2)',
                  borderTop:'2px solid var(--border)',
                }}>{fmtValue(t[metric], config.fmt)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Скрытый по умолчанию блок сверху списка — сводка по дням для фиксированного
// набора артикулов (GENERAL_STATS_OFFER_IDS), не зависящая от фильтров и
// сортировки основного списка ниже. Метрика выбирается одна за раз (как и
// просили — "можно выбрать метрику... но мы одну выбираем").
function GeneralStatsCard({ articlesRaw, dates }) {
  const [open, setOpen] = useState(false);
  const [metric, setMetric] = useState('revenue');
  // По умолчанию заказы в штуках — как и просили; переключается на любую
  // другую метрику из ARTICLE_TABLE_METRIC_OPTIONS (см. ArticlesMetricTable).
  const [articleMetric, setArticleMetric] = useState('orders');

  const targetArticles = useMemo(
    () => articlesRaw
      .filter(a => a.offerId && GENERAL_STATS_OFFER_IDS.includes(a.offerId))
      // Порядок — как в самом списке GENERAL_STATS_OFFER_IDS (как их
      // перечислили), а не как они пришли с сервера.
      .sort((a, b) => GENERAL_STATS_OFFER_IDS.indexOf(a.offerId) - GENERAL_STATS_OFFER_IDS.indexOf(b.offerId)),
    [articlesRaw]
  );

  const byDate = useMemo(() => {
    const out = {};
    for (const d of dates) {
      let views = 0, pdpViews = 0, cart = 0, orders = 0, revenue = 0, spend = 0;
      for (const a of targetArticles) {
        const day = a.byDate[d] || {};
        views += day.views || 0; pdpViews += day.pdpViews || 0; cart += day.cart || 0;
        orders += day.orders || 0; revenue += day.revenue || 0;
        spend += a.campaigns.reduce((s, c) => s + (c.byDate[d]?.spend || 0), 0);
      }
      out[d] = {
        views, pdpViews, cart, orders, revenue, spend,
        ctr: views > 0 ? pdpViews / views * 100 : 0,
        crToCart: pdpViews > 0 ? cart / pdpViews * 100 : 0,
        crToOrder: cart > 0 ? orders / cart * 100 : 0,
        drr: revenue > 0 ? spend / revenue * 100 : (spend > 0 ? 100 : 0),
      };
    }
    return out;
  }, [targetArticles, dates]);

  const totals = useMemo(() => {
    let revenue = 0, orders = 0, views = 0, pdpViews = 0, cart = 0, spend = 0;
    for (const d of dates) {
      const day = byDate[d] || {};
      revenue += day.revenue || 0; orders += day.orders || 0; views += day.views || 0;
      pdpViews += day.pdpViews || 0; cart += day.cart || 0; spend += day.spend || 0;
    }
    const drr = revenue > 0 ? spend / revenue * 100 : (spend > 0 ? 100 : 0);
    return { revenue, orders, views, pdpViews, cart, spend, drr };
  }, [byDate, dates]);

  const activeRow = GENERAL_METRIC_OPTIONS.find(m => m.key === metric) || GENERAL_METRIC_OPTIONS[0];

  return (
    <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
      <div onClick={() => setOpen(o => !o)} style={{
        display:'flex', alignItems:'center', gap:10, padding:'12px 16px', cursor:'pointer',
        background:'var(--surface2)', flexWrap:'wrap',
      }}>
        <span>{open ? '▾' : '▸'}</span>
        <span style={{ fontSize:15, fontWeight:700 }}>Общая статистика</span>
        <span style={{ color:'var(--text3)', fontSize:12 }}>{targetArticles.length} из {GENERAL_STATS_OFFER_IDS.length} артикулов найдено</span>
        <span style={{ marginLeft:'auto', fontSize:12, color:'var(--text2)', display:'flex', gap:14 }}>
          <span>Расход: {fmtValue(totals.spend, 'money0')} ₽</span>
          <span style={{ fontWeight:700 }}>ДРР: {fmtValue(totals.drr, 'pct')}</span>
        </span>
      </div>

      {open && (
        <>
          <div style={{ padding:'12px 16px 4px', display:'flex', gap:8, flexWrap:'wrap' }}>
            {[
              { label: 'Заказано, ₽',            value: fmtValue(totals.revenue, 'money') },
              { label: 'Заказано, шт',           value: fmtValue(totals.orders, 'int') },
              { label: 'Показы',                 value: fmtValue(totals.views, 'int') },
              { label: 'Переходы на карточку',   value: fmtValue(totals.pdpViews, 'int') },
              { label: 'Корзины',                value: fmtValue(totals.cart, 'int') },
              { label: 'Расход, ₽',              value: fmtValue(totals.spend, 'money0') },
              { label: 'ДРР',                    value: fmtValue(totals.drr, 'pct') },
            ].map(c => <StatCard key={c.label} {...c} />)}
          </div>

          <div style={{ padding:'8px 16px 12px', display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
            <span style={{ fontSize:12, color:'var(--text3)' }}>Метрика по дням:</span>
            <Segmented
              options={GENERAL_METRIC_OPTIONS.map(m => ({ value: m.key, label: m.label }))}
              value={metric}
              onChange={setMetric}
            />
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
                <MetricTable rows={[activeRow]} dates={dates} byDate={byDate} />
              </tbody>
            </table>
          </div>

          <ArticlesMetricTable articles={targetArticles} dates={dates} metric={articleMetric} onMetricChange={setArticleMetric} />
        </>
      )}
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
            <th style={{ textAlign:'right', padding:'7px 10px', fontWeight:600, color:'var(--text3)' }}>Ср. цена клика, ₽</th>
            <th style={{ textAlign:'right', padding:'7px 10px', fontWeight:600, color:'var(--text3)' }}>Расход, ₽</th>
            <th style={{ textAlign:'right', padding:'7px 10px', fontWeight:600, color:'var(--text3)' }}>ДРР</th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map(camp => (
            <tr key={camp.campaignId} style={{ borderTop:'1px solid var(--border)' }}>
              <td style={{ padding:'7px 10px', color:'var(--text)', whiteSpace:'normal', wordBreak:'break-word' }}>
                {camp.title || camp.campaignId}
                {camp.splitAcross > 1 && (
                  <span
                    title={`Мультитоварная РК — расход и клики поделены поровну между ${camp.splitAcross} артикулами, которые она продвигает (Ozon не разбивает их по товарам отдельно)`}
                    style={{ marginLeft:6, fontSize:10.5, padding:'1px 6px', borderRadius:999, background:'rgba(234,179,8,.18)', color:'var(--warn, #ca8a04)', whiteSpace:'nowrap' }}
                  >
                    ÷{camp.splitAcross}
                  </span>
                )}
              </td>
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
              <td style={{ padding:'7px 10px', textAlign:'right', whiteSpace:'nowrap' }}>{fmtValue(camp.avgCpc, 'money2')}</td>
              <td style={{ padding:'7px 10px', textAlign:'right', whiteSpace:'nowrap' }}>{fmtValue(camp.totalSpend, 'money0')}</td>
              <td style={{ padding:'7px 10px', textAlign:'right', whiteSpace:'nowrap', fontWeight:600 }}>{fmtValue(camp.drr, 'pct')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Таблица "Ассоциированные конверсии" — в самом низу карточки артикула.
// Реклама крутится на одном артикуле склейки (напр. Hv4-2KR), но заказы
// приходят по ВСЕЙ склейке — покупатель видит на карточке все варианты
// (материал/комплектацию) и может заказать любой. Список склеек задаётся
// вручную в backend/src/config/associatedArticles.js, сюда приходит уже
// готовым в article.associated. Переключатель "Шт / ₽" — как и просили,
// без реклама-метрик (расхода/ДРР) у этих артикулов нет, только заказы.
function AssociatedConversionsTable({ associated, dates, unit, onUnitChange }) {
  if (!associated || !associated.length) return null;
  const key = unit === 'rub' ? 'revenue' : 'orders';
  const fmt = unit === 'rub' ? 'money0' : 'int';

  const grandTotal = associated.reduce((s, a) => s + (a.totals[key] || 0), 0);
  const totalsByDate = dates.map(d => associated.reduce((s, a) => s + (a.byDate[d]?.[key] || 0), 0));

  return (
    <div style={{ padding:'4px 16px 16px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8, flexWrap:'wrap' }}>
        <span style={{ fontSize:12, fontWeight:700, color:'var(--text3)', textTransform:'uppercase', letterSpacing:.4 }}>
          Ассоциированные конверсии (остальные артикулы склейки)
        </span>
        <Segmented
          options={[{ value:'units', label:'Шт' }, { value:'rub', label:'₽' }]}
          value={unit}
          onChange={onUnitChange}
        />
      </div>
      <div style={{ overflowX:'auto', border:'1px solid var(--border)', borderRadius:8 }}>
        <table style={{ borderCollapse:'collapse', fontSize:12, minWidth: 240 + 96 + dates.length * 62, width:'100%' }}>
          <thead>
            <tr>
              <th style={{ position:'sticky', left:0, zIndex:2, background:'var(--surface)', borderBottom:'2px solid var(--border)', borderRight:'1px solid var(--border)', padding:'8px 10px', textAlign:'left', width:240, minWidth:240 }}>Артикул</th>
              <th style={{ position:'sticky', left:240, zIndex:2, background:'var(--surface2)', borderBottom:'2px solid var(--border)', borderRight:'2px solid var(--border)', padding:'8px 10px', textAlign:'center', width:96, minWidth:96 }}>Итого</th>
              {dates.map(d => (
                <th key={d} style={{ borderBottom:'2px solid var(--border)', padding:'8px 6px', fontWeight:600, color:'var(--text2)', whiteSpace:'nowrap' }}>
                  {d.slice(8,10)}.{d.slice(5,7)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {associated.map(a => (
              <tr key={a.offerId}>
                <td title={a.productName || a.offerId} style={{
                  position:'sticky', left:0, zIndex:1, background:'var(--surface)', color:'var(--text2)',
                  padding:'5px 10px', borderRight:'1px solid var(--border)', maxWidth:240, overflow:'hidden',
                }}>
                  <div style={{ display:'flex', alignItems:'baseline', gap:7, overflow:'hidden' }}>
                    <span style={{ flexShrink:0 }}>{a.offerId}</span>
                    {extractCarModel(a.productName) && (
                      <span style={{ fontSize:10.5, color:'var(--text3)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                        {extractCarModel(a.productName)}
                      </span>
                    )}
                  </div>
                </td>
                <td style={{
                  position:'sticky', left:240, zIndex:1, background:'var(--surface2)', fontWeight:700,
                  padding:'5px 10px', borderRight:'2px solid var(--border)', textAlign:'center', whiteSpace:'nowrap',
                }}>{fmtValue(a.totals[key], fmt)}</td>
                {dates.map(d => (
                  <td key={d} style={{ padding:'5px 6px', textAlign:'center', color:'var(--text)', whiteSpace:'nowrap' }}>
                    {fmtValue(a.byDate[d]?.[key], fmt)}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td style={{ position:'sticky', left:0, zIndex:1, background:'var(--surface2)', fontWeight:700, padding:'6px 10px', borderRight:'1px solid var(--border)', borderTop:'2px solid var(--border)', whiteSpace:'nowrap' }}>Итого</td>
              <td style={{ position:'sticky', left:240, zIndex:1, background:'var(--surface2)', fontWeight:700, padding:'6px 10px', borderRight:'2px solid var(--border)', borderTop:'2px solid var(--border)', textAlign:'center', whiteSpace:'nowrap' }}>{fmtValue(grandTotal, fmt)}</td>
              {totalsByDate.map((t, i) => (
                <td key={dates[i]} style={{ padding:'6px 6px', textAlign:'center', fontWeight:700, background:'var(--surface2)', borderTop:'2px solid var(--border)' }}>{fmtValue(t, fmt)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Поиск + добавление артикула в группу — по ВСЕМУ каталогу кабинета (см.
// GET /api/ads/catalog), а не только по articlesRaw (там только то, что
// хоть раз рекламировалось). Так в группу можно добавить и артикул без
// единой РК — у него просто не будет расхода/ДРР в карточке, зато будут
// показы/корзина/заказы из общей аналитики по товару (см. forced-include
// в /stats на бэкенде).
function AddArticleToGroup({ catalog, excludeOfferIds, onPick }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const excluded = new Set(excludeOfferIds);
  const q = query.trim().toLowerCase();
  const results = q
    ? catalog
        .filter(a => !excluded.has(a.offerId) &&
          (a.offerId.toLowerCase().includes(q) || (a.productName || '').toLowerCase().includes(q)))
        .slice(0, 30)
    : [];
  return (
    <div style={{ position:'relative' }}>
      <input
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="+ Добавить артикул (поиск по коду/названию)…"
        style={{ padding:'5px 10px', borderRadius:8, fontSize:12, border:'1px solid var(--border)', background:'var(--surface2)', color:'var(--text)', minWidth:240 }}
      />
      {open && q && (
        <div style={{
          position:'absolute', top:'calc(100% + 4px)', right:0, minWidth:280, maxWidth:420, maxHeight:280, overflowY:'auto',
          background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, boxShadow:'0 4px 16px rgba(0,0,0,0.2)', zIndex:20,
        }}>
          {results.length === 0 && (
            <div style={{ padding:'8px 12px', fontSize:12, color:'var(--text3)' }}>Ничего не найдено</div>
          )}
          {results.map(a => (
            <div
              key={a.offerId}
              onMouseDown={() => { onPick(a.offerId); setQuery(''); setOpen(false); }}
              style={{ padding:'7px 12px', fontSize:12.5, cursor:'pointer', borderBottom:'1px solid var(--border)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ fontWeight:600 }}>{a.offerId}</span>
              {a.productName ? <span style={{ color:'var(--text2)' }}> — {a.productName.slice(0, 50)}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Карточка одного артикула — вынесена отдельным компонентом, чтобы хук
// useMemo (расход/ДРР по дням) вызывался безусловно на верхнем уровне
// компонента, а не внутри .map() у родителя (это нарушало Rules of Hooks).
function ArticleCard({
  article, dates, cabinet, isOpen, onToggle, onManualSave, onManualStockSave,
  draggable, isDragging, isDragOver, onDragStart, onDragOverCard, onDropCard, onDragEndCard,
  groups, currentGroupId, onAssignGroup, titleOverride,
}) {
  // Конверсии (ctr/crToCart/crToOrder) и ДРР пересчитываются здесь из сырых
  // метрик, а не берутся готовыми из article.byDate — так правка ячейки
  // вручную (см. handleManualSave в AdsStats) сразу отражается и в таблице
  // конверсий, и в сводке ниже, без ожидания следующей загрузки с сервера.
  // spend/avgCpc теперь приходят уже смерженными с сервера (byDate) — там же
  // учтён ручной ввод (см. backend/src/routes/ads.js), поэтому здесь их
  // достаточно взять как есть через ...day, а не пересчитывать заново из
  // article.campaigns (иначе ручная правка сразу же перезаписывалась бы
  // суммой по кампаниям).
  const mergedByDate = useMemo(() => {
    const out = {};
    for (const d of dates) {
      const day = article.byDate[d] || {};
      const views = day.views || 0, pdpViews = day.pdpViews || 0, cart = day.cart || 0, orders = day.orders || 0;
      const revenue = day.revenue || 0;
      const spend = day.spend || 0;
      out[d] = {
        ...day,
        ctr: views > 0 ? pdpViews / views * 100 : 0,
        crToCart: pdpViews > 0 ? cart / pdpViews * 100 : 0,
        crToOrder: cart > 0 ? orders / cart * 100 : 0,
        drr: revenue > 0 ? spend / revenue * 100 : (spend > 0 ? 100 : 0),
      };
    }
    return out;
  }, [article, dates]);

  // Сводка за период — сумма по дням из mergedByDate (а не готовый
  // article.totals с сервера), по той же причине: правка любой ячейки
  // видна в сводке сразу же, а не после перезагрузки страницы.
  const computedTotals = useMemo(() => {
    let revenue = 0, orders = 0, views = 0, pdpViews = 0, cart = 0, spend = 0;
    for (const d of dates) {
      const day = mergedByDate[d] || {};
      revenue += day.revenue || 0; orders += day.orders || 0; views += day.views || 0;
      pdpViews += day.pdpViews || 0; cart += day.cart || 0; spend += day.spend || 0;
    }
    const drr = revenue > 0 ? spend / revenue * 100 : (spend > 0 ? 100 : 0);
    const ctr = views > 0 ? pdpViews / views * 100 : 0;
    const crToCart = pdpViews > 0 ? cart / pdpViews * 100 : 0;
    const crToOrder = cart > 0 ? orders / cart * 100 : 0;
    return { revenue, orders, views, pdpViews, cart, spend, drr, ctr, crToCart, crToOrder };
  }, [mergedByDate, dates]);

  const [assocUnit, setAssocUnit] = useState('units');

  return (
    <div
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragOver={draggable ? e => { e.preventDefault(); onDragOverCard(); } : undefined}
      onDrop={draggable ? e => { e.preventDefault(); onDropCard(); } : undefined}
      onDragEnd={draggable ? onDragEndCard : undefined}
      style={{
        background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden',
        opacity: isDragging ? 0.4 : 1,
        outline: isDragOver ? '2px dashed var(--accent, #6366f1)' : 'none',
        outlineOffset: -2,
      }}
    >
      <div onClick={onToggle} style={{
        display:'flex', alignItems:'center', gap:10, padding:'12px 16px', cursor:'pointer',
        background:'var(--surface2)', flexWrap:'wrap',
      }}>
        <span>{isOpen ? '▾' : '▸'}</span>
        {draggable && <span title="Перетащите, чтобы изменить порядок" style={{ cursor:'grab', color:'var(--text3)' }}>⠿</span>}
        <span style={{ fontSize:15, fontWeight:700 }}>{titleOverride || article.offerId || 'Без привязки к артикулу'}</span>
        {!titleOverride && article.productName && <span style={{ color:'var(--text3)', fontSize:12 }}>{article.productName}</span>}
        {article.offerId && groups && onAssignGroup && (
          <select
            value={currentGroupId || ''}
            onClick={e => e.stopPropagation()}
            onChange={e => onAssignGroup(article.offerId, e.target.value || null)}
            title="Тестируемая группа артикулов"
            style={{ padding:'3px 6px', borderRadius:6, fontSize:11, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text2)' }}
          >
            <option value="">Без группы</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        )}
        <span style={{ marginLeft:'auto', fontSize:12, color:'var(--text2)', display:'flex', gap:14 }}>
          <span>РК: {article.campaigns.length}</span>
          <span>Расход: {fmtValue(computedTotals.spend, 'money0')} ₽</span>
          <span style={{ fontWeight:700 }}>ДРР: {fmtValue(computedTotals.drr, 'pct')}</span>
        </span>
      </div>

      {isOpen && (
        <>
          <ArticleSummary
            totals={computedTotals}
            stock={article.stock}
            onSaveStock={article.offerId && onManualStockSave
              ? (metric, value) => onManualStockSave(article.offerId, metric, value)
              : null}
          />

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
                <MetricTable
                  rows={SPEND_ROWS}
                  dates={dates}
                  byDate={mergedByDate}
                  onManualSave={article.offerId && onManualSave
                    ? (date, metric, value) => onManualSave(article.offerId, date, metric, value)
                    : null}
                />
              </tbody>
            </table>
          </div>

          <ArticleCompareChart dates={dates} byDate={mergedByDate} storageKey={`mp-ads-chart-${cabinet}`} />

          <AssociatedConversionsTable
            associated={article.associated}
            dates={dates}
            unit={assocUnit}
            onUnitChange={setAssocUnit}
          />
        </>
      )}
    </div>
  );
}

// Строка "когда обновлялись данные" — по отметкам задач сбора на сервере
// (collectors/ads/jobs.js). Сразу видно, свежие ли цифры и не сломалось ли
// что-то, без захода в логи.
const DATA_STATUS_PARTS = [
  { job: 'perf', label: 'Расход' },
  { job: 'clicks', label: 'Клики' },
  { job: 'analytics', label: 'Заказы и воронка' },
  { job: 'stocks', label: 'Остатки' },
];

function agoText(iso) {
  if (!iso) return 'ещё не было';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.floor(h / 24)} дн назад`;
}

function DataStatusLine({ status }) {
  if (!status) return null;
  const byJob = new Map(status.jobs.map(j => [j.job, j]));
  return (
    <div style={{ display:'flex', gap:14, flexWrap:'wrap', fontSize:11.5, color:'var(--text3)', marginTop:-6 }}>
      {DATA_STATUS_PARTS.map(p => {
        const j = byJob.get(p.job) || {};
        const failed = j.lastErrorAt && (!j.lastSuccessAt || new Date(j.lastErrorAt) > new Date(j.lastSuccessAt));
        const stale = !j.lastSuccessAt || (Date.now() - new Date(j.lastSuccessAt).getTime()) > Math.max(3 * (j.everyMin || 30), 90) * 60000;
        const color = failed ? 'var(--danger, #ef4444)' : stale ? 'var(--warn, #f59e0b)' : 'var(--text3)';
        return (
          <span key={p.job} title={failed ? `Ошибка: ${j.lastError}` : (j.lastWarning || '')} style={{ color }}>
            {p.label}: {agoText(j.lastSuccessAt)}{failed ? ' · ошибка' : ''}
          </span>
        );
      })}
      {status.running && <span>· идёт сбор…</span>}
    </div>
  );
}

export default function AdsStats({ cabinet }) {
  const [dateFrom, setDateFrom] = useState(dayjs().subtract(29, 'day').format('YYYY-MM-DD'));
  const [dateTo, setDateTo] = useState(dayjs().format('YYYY-MM-DD'));
  const [data, setData] = useState(null);
  const [cabinets, setCabinets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [dataStatus, setDataStatus] = useState(null);
  const [expandedArticles, setExpandedArticles] = useState(() => new Set());

  const [onlyActive, setOnlyActive] = useState(false);
  const [search, setSearch] = useState('');
  const [paymentFilter, setPaymentFilter] = useState('');
  const [placementFilter, setPlacementFilter] = useState('');
  const [sortBy, setSortBy] = useState('spend');
  const [manualOrder, setManualOrder] = useState([]);
  const [dragKey, setDragKey] = useState(null);
  const [dragOverKey, setDragOverKey] = useState(null);

  // Тестируемые группы артикулов (например "Чехлы") — см. backend/src/routes/ads.js.
  // Группировка всегда по offerId (артикул продавца), не по SKU.
  const [groupsData, setGroupsData] = useState({ groups: [], members: {} });
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupSaving, setGroupSaving] = useState(false);

  // Готовые "склейки" из config/associatedArticles.js (одна модель — разные
  // материалы/строчка, см. комментарий там) — чтобы предлагать готовый
  // состав группы одной кнопкой, а не собирать его руками каждый раз.
  const [siblingClusters, setSiblingClusters] = useState([]);
  const [clusterSaving, setClusterSaving] = useState(null); // primary артикула, который сейчас создаётся

  // Перетаскивание самих групп (их порядок в списке), не артикулов внутри
  // группы — отдельные drag-состояния, чтобы не путать с dragKey/dragOverKey
  // у карточек артикулов.
  const [dragGroupId, setDragGroupId] = useState(null);
  const [dragOverGroupId, setDragOverGroupId] = useState(null);

  // Весь каталог кабинета (включая артикулы без единой РК) — источник для
  // поиска при добавлении артикула в группу, не только articlesRaw.
  const [catalog, setCatalog] = useState([]);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([getAdsStats(cabinet, { dateFrom, dateTo }), getAdsCabinets()])
      .then(([statsRes, cabRes]) => {
        setData(statsRes.data.data);
        setCabinets(cabRes.data.data);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [cabinet, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  const loadStatus = useCallback(() => getAdsDataStatus(cabinet)
    .then(r => { setDataStatus(r.data.data); return r.data.data; })
    .catch(() => null), [cabinet]);
  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 60000);
    return () => clearInterval(t);
  }, [loadStatus]);

  // Сохранённый порядок артикулов для этого кабинета — подгружается отдельно,
  // не зависит от периода/фильтров.
  useEffect(() => {
    getAdsOrder(cabinet).then(r => setManualOrder(r.data.data || [])).catch(() => setManualOrder([]));
  }, [cabinet]);

  // Группы — подгружаются так же отдельно, не зависят от периода/фильтров.
  const loadGroups = useCallback(() => {
    getAdsGroups(cabinet).then(r => setGroupsData(r.data.data || { groups: [], members: {} }))
      .catch(() => setGroupsData({ groups: [], members: {} }));
  }, [cabinet]);
  useEffect(() => { loadGroups(); }, [loadGroups]);

  useEffect(() => {
    getSiblingClusters(cabinet).then(r => setSiblingClusters(r.data.data || [])).catch(() => setSiblingClusters([]));
  }, [cabinet]);

  useEffect(() => {
    getAdsCatalog(cabinet).then(r => setCatalog(r.data.data || [])).catch(() => setCatalog([]));
  }, [cabinet]);

  function onRemoveGroup(id) {
    if (!window.confirm('Удалить группу? Артикулы останутся, просто станут "без группы".')) return;
    removeAdsGroup(cabinet, id).then(r => { setGroupsData(r.data.data); if (sortBy === `group:${id}`) setSortBy('spend'); }).catch(console.error);
  }

  function handleGroupReorder(draggedId, targetId) {
    if (!draggedId || draggedId === targetId) return;
    const ids = groupsData.groups.map(g => g.id);
    const fromIdx = ids.indexOf(draggedId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const nextIds = [...ids];
    nextIds.splice(fromIdx, 1);
    nextIds.splice(toIdx, 0, draggedId);
    const byId = new Map(groupsData.groups.map(g => [g.id, g]));
    setGroupsData(prev => ({ ...prev, groups: nextIds.map(id => byId.get(id)) }));
    reorderAdsGroups(cabinet, nextIds).catch(console.error);
  }

  // Кластер считаем "уже собранным", если все его артикулы уже в одной и
  // той же существующей группе — тогда прятать кнопку, предлагать только
  // то, что реально ещё не сгруппировано (целиком или частично).
  const ungroupedClusters = siblingClusters.filter(c => {
    const groupIds = c.members.map(id => groupsData.members[id]).filter(Boolean);
    if (!groupIds.length) return true;
    return !groupIds.every(g => g === groupIds[0]) || groupIds.length < c.members.length;
  });

  function onCreateFromCluster(cluster) {
    setClusterSaving(cluster.primary);
    const name = cluster.productName ? cluster.productName.slice(0, 40) : cluster.primary;
    addAdsGroupFromCluster(cabinet, name, cluster.members)
      .then(r => setGroupsData(r.data.data))
      .catch(e => window.alert(e.response?.data?.error || 'Не удалось создать группу'))
      .finally(() => setClusterSaving(null));
  }

  function onAddGroup(e) {
    e.preventDefault();
    if (!groupName.trim()) return;
    setGroupSaving(true);
    addAdsGroup(cabinet, groupName.trim())
      .then(r => { setGroupsData(r.data.data); setGroupName(''); setShowGroupForm(false); })
      .catch(e => window.alert(e.response?.data?.error || 'Не удалось создать группу'))
      .finally(() => setGroupSaving(false));
  }

  function onAssignGroup(offerId, groupId) {
    setGroupsData(prev => {
      const members = { ...prev.members };
      if (groupId) members[offerId] = groupId; else delete members[offerId];
      return { ...prev, members };
    });
    assignAdsGroup(cabinet, offerId, groupId).catch(console.error);
  }

  const cabInfo = cabinets.find(c => c.id === cabinet);
  const notConfigured = cabInfo && !cabInfo.ozonSellerConfigured && !cabInfo.ozonPerfConfigured;

  async function handleCollect() {
    setCollecting(true);
    // Сбор с Ozon всегда идёт вглубь от сегодняшнего дня (а не строго
    // выбранного диапазона) — collectDays считается от начала выбранного
    // периода до сегодня, чтобы выбор старого диапазона в календаре тоже
    // подтягивал свежие данные, а не только те даты, что видны в таблице.
    const collectDays = Math.min(90, Math.max(7, dayjs().diff(dayjs(dateFrom), 'day') + 1));
    try {
      await collectAds(cabinet, collectDays);
      // Ждём, пока сервер закончит (обычно 1-2 минуты), и перезагружаем.
      const started = Date.now();
      await new Promise(r => setTimeout(r, 4000));
      while (Date.now() - started < 6 * 60000) {
        const st = await loadStatus();
        if (st && !st.running) break;
        await new Promise(r => setTimeout(r, 5000));
      }
      load();
    } finally {
      setCollecting(false);
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

  // Сохраняет ручной остаток (FBO или FBS отдельно) и сразу патчит локальное
  // состояние — та же идея, что и у handleManualSave выше, но без даты:
  // остаток хранится как "текущее" значение (см. backend/ad_stock_manual).
  function handleManualStockSave(offerId, metric, value) {
    return saveManualStock(cabinet, offerId, metric, value)
      .then(() => {
        setData(prev => {
          if (!prev) return prev;
          const articles = prev.articles.map(a => {
            if (a.offerId !== offerId) return a;
            const stock = a.stock || { fboPresent: 0, fbsPresent: 0, fboReserved: 0, fbsReserved: 0, manual: {} };
            const cleared = value === null || value === '';
            const numValue = cleared ? 0 : Number(value);
            return {
              ...a,
              stock: {
                ...stock,
                [metric]: numValue,
                manual: { ...stock.manual, [metric]: !cleared },
              },
            };
          });
          return { ...prev, articles };
        });
      })
      .catch(e => {
        console.error(e);
        window.alert('Не удалось сохранить остаток — попробуйте ещё раз.');
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
  //
  // Исключение: артикул без единой РК (campaigns.length уже 0 ДО фильтров
  // выше — т.е. это не "отфильтровали всё активными/поиском", а искренне
  // нет рекламы), но добавленный вручную в ТЕКУЩУЮ активную вкладку-группу,
  // не скрывается — иначе добавление артикула без рекламы в склейку
  // (см. AddArticleToGroup) не давало бы увидеть его в самой группе, хотя
  // по нему всё равно есть аналитика (показы/корзина/заказы без расходов).
  const activeGroupId = sortBy.startsWith('group:') ? sortBy.slice('group:'.length) : null;
  const articles = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = articlesRaw
      .map(article => {
        const hadNoCampaignsAtAll = article.campaigns.length === 0;
        const campaigns = article.campaigns
          .filter(c => {
            if (onlyActive && c.state !== 'CAMPAIGN_STATE_RUNNING') return false;
            if (q && !(c.title || '').toLowerCase().includes(q) && !(c.campaignId || '').includes(q)) return false;
            if (paymentFilter && paymentBucket(c.paymentType) !== paymentFilter) return false;
            if (placementFilter && placementBucket(c.placement) !== placementFilter) return false;
            return true;
          })
          .sort((a, b) => naturalCompare(a.title, b.title));
        return { ...article, campaigns, hadNoCampaignsAtAll };
      })
      .filter(a => a.campaigns.length > 0
        || (a.hadNoCampaignsAtAll && activeGroupId && a.offerId && groupsData.members[a.offerId] === activeGroupId));

    let matched = filtered.filter(a => a.offerId);
    const unmatched = filtered.filter(a => !a.offerId);

    const spendCmp = (a, b) => (b.totals.spend || 0) - (a.totals.spend || 0);
    unmatched.sort(spendCmp);

    // Вкладка-группа (sortBy === 'group:<id>') — отдельная "своя группа" со
    // своим названием, которую можно продолжать добавлять рядом с По
    // расходу/ДРР/названию/Свой порядок. При переключении на неё список
    // схлопывается до только тех артикулов, что отнесены к этой группе
    // (см. onAssignGroup — выпадающий список на карточке), несматченные
    // кампании сюда не попадают, т.к. у них нет offerId.
    // Общий компаратор "Свой порядок" — используется и во вкладке "Свой
    // порядок", и внутри вкладки-группы (там тоже можно перетаскиванием
    // менять местами артикулы одной модели — см. handleReorder ниже).
    const orderIndex = new Map(manualOrder.map((id, i) => [id, i]));
    const manualCmp = (a, b) => {
      const ia = orderIndex.has(a.offerId) ? orderIndex.get(a.offerId) : Infinity;
      const ib = orderIndex.has(b.offerId) ? orderIndex.get(b.offerId) : Infinity;
      return ia !== ib ? ia - ib : spendCmp(a, b);
    };

    if (sortBy.startsWith('group:')) {
      const groupId = sortBy.slice('group:'.length);
      matched = matched.filter(a => groupsData.members[a.offerId] === groupId);
      matched.sort(manualCmp);
      return matched;
    }

    if (sortBy === 'manual') {
      // Свой порядок — по сохранённому manualOrder (массив offerId). Артикулы,
      // которых ещё нет в сохранённом порядке (новые), уходят в конец списка
      // по расходу — так они не перемешивают то, что пользователь уже расставил.
      matched.sort(manualCmp);
    } else {
      const cmp = sortBy === 'name'
        ? (a, b) => naturalCompare(a.campaigns[0]?.title, b.campaigns[0]?.title)
        : sortBy === 'drr'
        ? (a, b) => (b.totals.drr || 0) - (a.totals.drr || 0)
        : spendCmp;
      matched.sort(cmp);
    }
    return [...matched, ...unmatched];
  }, [articlesRaw, onlyActive, search, paymentFilter, placementFilter, sortBy, manualOrder, groupsData]);

  // Перетаскивание карточек — переставляет draggedKey перед/на место
  // targetKey и сохраняет на сервер. Работает и во вкладке "Свой порядок",
  // и внутри вкладки-группы (там удобно менять местами, например, материалы
  // одной модели). Важно: строим полный порядок по ВСЕМ артикулам кабинета
  // (а не только по видимому в группе подсписку articles) — иначе
  // перетаскивание внутри группы стёрло бы сохранённый порядок всех
  // остальных артикулов, которых сейчас не видно.
  function handleReorder(draggedKey, targetKey) {
    if (!draggedKey || draggedKey === targetKey) return;
    const orderIndex = new Map(manualOrder.map((id, i) => [id, i]));
    const allKeys = [...new Set(articlesRaw.filter(a => a.offerId).map(a => a.offerId))]
      .sort((a, b) => {
        const ia = orderIndex.has(a) ? orderIndex.get(a) : Infinity;
        const ib = orderIndex.has(b) ? orderIndex.get(b) : Infinity;
        return ia - ib;
      });
    const fromIdx = allKeys.indexOf(draggedKey);
    const toIdx = allKeys.indexOf(targetKey);
    if (fromIdx === -1 || toIdx === -1) return;
    const next = [...allKeys];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, draggedKey);
    setManualOrder(next);
    saveAdsOrder(cabinet, next).catch(console.error);
  }

  if (loading && !data) return <div style={{ padding:60, textAlign:'center', color:'var(--text2)' }}>Загрузка...</div>;

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
        <h1 style={{ fontSize:17, fontWeight:700, margin:0 }}>Реклама</h1>
        <DateRangePicker from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t); }} />
        <button onClick={handleCollect} disabled={collecting} style={{
          marginLeft:'auto', padding:'7px 14px', borderRadius:8, border:'1px solid var(--border)',
          background:'var(--surface2)', color:'var(--text)', fontSize:13, fontWeight:500,
          cursor: collecting ? 'default' : 'pointer', opacity: collecting ? 0.6 : 1,
        }}>
          {collecting ? 'Собираем...' : '↻ Обновить данные'}
        </button>
      </div>
      <DataStatusLine status={dataStatus} />

      <GeneralStatsCard articlesRaw={articlesRaw} dates={dates} />

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

      {/* Свои группы ("Чехлы" и т.п., модели со складками) — отдельная
          строка под основной сортировкой, не смешана с
          расход/ДРР/название/свой порядок. Каждая группа — перетаскиваемый
          чип: клик выбирает её как текущий вид, "×" удаляет, перетаскивание
          меняет порядок в списке (сохраняется на сервере). */}
      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
        <span style={{ fontSize:12, color:'var(--text3)' }}>Мои группы:</span>
        {groupsData.groups.map(g => {
          const active = sortBy === `group:${g.id}`;
          return (
            <div
              key={g.id}
              draggable
              onDragStart={() => setDragGroupId(g.id)}
              onDragOver={e => { e.preventDefault(); setDragOverGroupId(g.id); }}
              onDrop={e => { e.preventDefault(); handleGroupReorder(dragGroupId, g.id); setDragGroupId(null); setDragOverGroupId(null); }}
              onDragEnd={() => { setDragGroupId(null); setDragOverGroupId(null); }}
              onClick={() => setSortBy(active ? 'spend' : `group:${g.id}`)}
              style={{
                display:'flex', alignItems:'center', gap:6, padding:'5px 6px 5px 10px', borderRadius:8,
                border: active ? '1px solid #334155' : '1px solid var(--border)',
                background: active ? '#334155' : 'var(--surface2)',
                color: active ? '#fff' : 'var(--text)',
                fontSize:12.5, fontWeight:500, cursor:'grab',
                opacity: dragOverGroupId === g.id && dragGroupId && dragGroupId !== g.id ? 0.6 : 1,
              }}
            >
              <span title="Перетащите, чтобы изменить порядок" style={{ cursor:'grab' }}>⠿</span>
              📦 {g.name}
              <button
                onClick={e => { e.stopPropagation(); onRemoveGroup(g.id); }}
                title="Удалить группу"
                style={{
                  border:'none', background:'transparent', cursor:'pointer', fontSize:13, lineHeight:1,
                  color: active ? 'rgba(255,255,255,0.7)' : 'var(--text3)', padding:'2px 4px',
                }}
              >×</button>
            </div>
          );
        })}
        {!showGroupForm ? (
          <button onClick={() => setShowGroupForm(true)} title="Добавить свою группу" style={{
            padding:'5px 10px', borderRadius:8, border:'1px dashed var(--border)',
            background:'transparent', color:'var(--text2)', fontSize:12.5, fontWeight:500, cursor:'pointer',
          }}>+ Группа</button>
        ) : (
          <form onSubmit={onAddGroup} style={{ display:'flex', gap:6 }}>
            <input
              autoFocus value={groupName} onChange={e => setGroupName(e.target.value)}
              placeholder="Название группы, напр. Чехлы"
              style={{ padding:'5px 10px', borderRadius:8, fontSize:12, minWidth:180 }}
            />
            <button type="submit" disabled={groupSaving || !groupName.trim()} style={{
              padding:'5px 10px', borderRadius:8, border:'1px solid var(--border)',
              background:'var(--surface2)', color:'var(--text)', fontSize:12, cursor:'pointer',
            }}>Создать</button>
            <button type="button" onClick={() => { setShowGroupForm(false); setGroupName(''); }} style={{
              padding:'5px 10px', borderRadius:8, border:'none', background:'transparent', color:'var(--text3)', fontSize:12, cursor:'pointer',
            }}>Отмена</button>
          </form>
        )}
        {ungroupedClusters.length > 0 && (
          <select
            value=""
            onChange={e => {
              const cluster = ungroupedClusters.find(c => c.primary === e.target.value);
              if (cluster) onCreateFromCluster(cluster);
            }}
            disabled={!!clusterSaving}
            title="Готовые склейки по артикулам (config/associatedArticles.js) — создать группу со всем составом одной кнопкой"
            style={{ padding:'5px 10px', borderRadius:8, fontSize:12, border:'1px dashed var(--border)', background:'transparent', color:'var(--text2)' }}
          >
            <option value="">{clusterSaving ? 'Создаю…' : '+ Группа по склейке…'}</option>
            {ungroupedClusters.map(c => (
              <option key={c.primary} value={c.primary}>
                {c.primary} ({c.members.length} арт.){c.productName ? ` — ${c.productName.slice(0, 30)}` : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Когда активна вкладка-группа — сводная шапка по её артикулам
          (сумма заказов/расхода/ДРР за выбранный период) + возможность
          удалить саму группу (её артикулы при этом останутся, просто
          станут "без группы"). */}
      {sortBy.startsWith('group:') && (() => {
        const groupId = sortBy.slice('group:'.length);
        const group = groupsData.groups.find(g => g.id === groupId);
        if (!group) return null;
        const agg = articles.reduce((acc, a) => ({
          orders: acc.orders + (a.totals.orders || 0),
          revenue: acc.revenue + (a.totals.revenue || 0),
          spend: acc.spend + (a.totals.spend || 0),
        }), { orders: 0, revenue: 0, spend: 0 });
        const drr = agg.revenue > 0 ? agg.spend / agg.revenue * 100 : (agg.spend > 0 ? 100 : 0);

        // "Эффект склейки" — заказы по артикулам той же склейки (см.
        // config/associatedArticles.js), которые НЕ являются членами этой
        // группы сами по себе (т.е. у них нет собственной РК и карточки
        // здесь — иначе их заказы уже посчитаны выше, в agg, и повторный
        // учёт задвоил бы цифры). Собираем по offerId в Map, чтобы один и
        // тот же артикул, упомянутый у нескольких членов группы, не
        // посчитался дважды.
        const extraByOfferId = new Map();
        for (const a of articles) {
          for (const assoc of (a.associated || [])) {
            if (groupsData.members[assoc.offerId] === groupId) continue; // уже свой член группы
            extraByOfferId.set(assoc.offerId, assoc);
          }
        }
        const extra = [...extraByOfferId.values()].reduce((acc, a) => ({
          orders: acc.orders + (a.totals.orders || 0),
          revenue: acc.revenue + (a.totals.revenue || 0),
        }), { orders: 0, revenue: 0 });

        // Артикулы, уже состоящие в этой группе — чтобы не предлагать их
        // повторно в поиске добавления (см. AddArticleToGroup, источник —
        // весь каталог кабинета, а не только articlesRaw).
        const memberOfferIds = Object.entries(groupsData.members)
          .filter(([, gid]) => gid === groupId)
          .map(([offerId]) => offerId);
        return (
          <div style={{ display:'flex', alignItems:'center', gap:14, flexWrap:'wrap', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'10px 16px' }}>
            <span style={{ fontWeight:700, fontSize:14 }}>📦 {group.name}</span>
            <span style={{ fontSize:12, color:'var(--text3)' }}>{articles.length} арт.</span>
            <span style={{ fontSize:12, color:'var(--text2)', display:'flex', gap:14 }}>
              <span>Заказано: {fmtValue(agg.orders, 'int')} шт / {fmtValue(agg.revenue, 'money0')} ₽</span>
              <span>Расход: {fmtValue(agg.spend, 'money0')} ₽</span>
              <span>ДРР: {fmtValue(drr, 'pct')}</span>
            </span>
            {extra.orders > 0 && (
              <span
                title="Заказы по артикулам той же склейки, которых пока нет в этой группе — учтены отдельно, чтобы не задваивать сумму выше"
                style={{ fontSize:12, color:'var(--text3)', borderLeft:'1px solid var(--border)', paddingLeft:14 }}
              >
                + эффект склейки: {fmtValue(extra.orders, 'int')} шт / {fmtValue(extra.revenue, 'money0')} ₽
              </span>
            )}
            <div style={{ marginLeft:'auto' }}>
              <AddArticleToGroup
                catalog={catalog}
                excludeOfferIds={memberOfferIds}
                onPick={offerId => onAssignGroup(offerId, groupId)}
              />
            </div>
          </div>
        );
      })()}

      {sortBy.startsWith('group:') && articles.length > 0 && (() => {
        const groupId = sortBy.slice('group:'.length);
        const group = groupsData.groups.find(g => g.id === groupId);
        if (!group) return null;

        // Синтетический "артикул" — сумма по дням всех реальных членов
        // группы (views/pdpViews/cart/orders/revenue/spend), плюс кампании
        // и остатки всех членов вместе. offerId у него нет — поэтому ручная
        // правка ячеек (onManualSave/onManualStockSave) для него сама
        // отключается там же, где и для несматченных кампаний.
        const byDate = {};
        for (const d of dates) {
          let views = 0, pdpViews = 0, cart = 0, orders = 0, revenue = 0, spend = 0;
          for (const a of articles) {
            const day = a.byDate[d] || {};
            views += day.views || 0; pdpViews += day.pdpViews || 0; cart += day.cart || 0;
            orders += day.orders || 0; revenue += day.revenue || 0; spend += day.spend || 0;
          }
          byDate[d] = { views, pdpViews, cart, orders, revenue, spend };
        }

        const campaigns = articles.flatMap(a => a.campaigns);

        const stockMembers = articles.filter(a => a.stock);
        const stock = stockMembers.length > 0
          ? stockMembers.reduce((acc, a) => ({
              fboPresent: (acc.fboPresent || 0) + (a.stock.fboPresent || 0),
              fbsPresent: (acc.fbsPresent || 0) + (a.stock.fbsPresent || 0),
            }), { fboPresent: 0, fbsPresent: 0 })
          : null;

        // Та же дедупликация "эффекта склейки", что и в сводной шапке выше —
        // показываем в таблице связанных конверсий только те артикулы той
        // же склейки, что НЕ являются членами этой группы (иначе задвоим).
        const extraByOfferId = new Map();
        for (const a of articles) {
          for (const assoc of (a.associated || [])) {
            if (groupsData.members[assoc.offerId] === groupId) continue;
            extraByOfferId.set(assoc.offerId, assoc);
          }
        }

        const aggregateArticle = {
          offerId: null,
          productName: null,
          byDate,
          campaigns,
          stock,
          associated: [...extraByOfferId.values()],
        };

        // В отличие от обычных карточек (закрыты по умолчанию), общая
        // аналитика группы раскрыта по умолчанию — поэтому здесь множество
        // expandedArticles используется "наоборот": присутствие ключа
        // означает "свёрнуто вручную", а не "раскрыто".
        const key = `__group_agg_${groupId}`;
        return (
          <ArticleCard
            key={key}
            article={aggregateArticle}
            dates={dates}
            cabinet={cabinet}
            isOpen={!expandedArticles.has(key)}
            onToggle={() => toggleArticle(key)}
            titleOverride={`📦 ${group.name} — общая аналитика (${articles.length} арт.)`}
          />
        );
      })()}

      {sortBy.startsWith('group:') && articles.length === 0 && (
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:16, color:'var(--text2)', fontSize:13 }}>
          В этой группе пока нет артикулов — найдите нужный через поиск справа сверху ("+ Добавить артикул").
        </div>
      )}

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

      {!notConfigured && articlesRaw.length > 0 && articles.length === 0 && !sortBy.startsWith('group:') && (
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:16, color:'var(--text2)', fontSize:13 }}>
          Под текущие фильтры ничего не подошло.
        </div>
      )}

      {articles.map(article => {
        const key = article.offerId || '__unmatched__';
        const draggable = (sortBy === 'manual' || sortBy.startsWith('group:')) && !!article.offerId;
        return (
          <ArticleCard
            key={key}
            article={article}
            dates={dates}
            cabinet={cabinet}
            isOpen={expandedArticles.has(key)}
            onToggle={() => toggleArticle(key)}
            onManualSave={handleManualSave}
            onManualStockSave={handleManualStockSave}
            draggable={draggable}
            isDragging={dragKey === key}
            isDragOver={draggable && dragOverKey === key && dragKey && dragKey !== key}
            onDragStart={() => setDragKey(key)}
            onDragOverCard={() => draggable && setDragOverKey(key)}
            onDropCard={() => { handleReorder(dragKey, key); setDragKey(null); setDragOverKey(null); }}
            onDragEndCard={() => { setDragKey(null); setDragOverKey(null); }}
            groups={groupsData.groups}
            currentGroupId={article.offerId ? groupsData.members[article.offerId] : null}
            onAssignGroup={onAssignGroup}
          />
        );
      })}
    </div>
  );
}
