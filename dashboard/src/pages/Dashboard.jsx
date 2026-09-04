import React, { useState, useEffect, useMemo, useRef } from 'react';
import dayjs from 'dayjs';
import {
  ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend,
} from 'recharts';
import { getOverview, getChart } from '../api';
import DateRangePicker from '../components/DateRangePicker';

// Блоки KPI сверху — состав, порядок и видимость настраиваются и сохраняются
// в localStorage, чтобы не сбрасывались между визитами. BLOCK_DEFS — это
// "каталог" всех известных блоков; фактический порядок/видимость хранит
// state `blocks` (массив {key, visible}).
const BLOCK_DEFS = [
  { key: 'orders_sum',     label: 'Заказы, ₽',           format: 'money' },
  { key: 'orders_qty',     label: 'Заказы, шт',          format: 'int'   },
  { key: 'sales_sum',      label: 'Продажи, ₽',          format: 'money' },
  { key: 'sales_qty',      label: 'Продажи, шт',         format: 'int'   },
  { key: 'redemption_pct', label: '% выкупа',            format: 'pct'   },
  { key: 'margin_pct',     label: '% маржинальность',    format: 'pct'   },
  { key: 'net_profit',     label: 'Чистая прибыль, ₽',   format: 'money' },
];
const BLOCK_VALUE = {
  orders_sum:     d => d?.orders_sum,
  orders_qty:     d => d?.orders_qty,
  sales_sum:      d => d?.revenue,
  sales_qty:      d => d?.sales_qty,
  redemption_pct: d => d ? Number(d.redemption_rate) : null,
  margin_pct:     d => d ? Number(d.margin_pct) : null,
  net_profit:     d => d?.net_profit,
};
const BLOCKS_KEY = 'mp-dashboard-blocks';

function loadBlocks() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(BLOCKS_KEY)) || []; } catch(e) { /* ignore */ }
  const known = new Set(BLOCK_DEFS.map(d => d.key));
  const kept = saved.filter(b => known.has(b.key));
  const keptKeys = new Set(kept.map(b => b.key));
  const added = BLOCK_DEFS.filter(d => !keptKeys.has(d.key)).map(d => ({ key: d.key, visible: true }));
  return [...kept, ...added];
}

function formatValue(v, format) {
  if (v == null || Number.isNaN(v)) return '—';
  if (format === 'money') return Math.round(v).toLocaleString('ru') + ' ₽';
  if (format === 'pct')   return v.toLocaleString('ru', { maximumFractionDigits: 1 }) + '%';
  return Math.round(v).toLocaleString('ru');
}

// Метрики для графика сгруппированы по единице измерения. График не рисует
// метрики разных единиц на одной оси (₽ и % на одном графике нечитаемы) —
// вместо этого при выборе метрик из разных групп рисуется несколько
// маленьких графиков подряд, каждый со своей осью.
const CHART_GROUPS = [
  { key: 'money', unit: '₽', metrics: [
      { key: 'orders_sum', label: 'Заказы',         series: 'series-1' },
      { key: 'sales_sum',  label: 'Продажи',        series: 'series-3' },
      { key: 'net_profit', label: 'Чистая прибыль', series: 'series-7' },
  ]},
  { key: 'qty', unit: 'шт', metrics: [
      { key: 'orders_qty', label: 'Заказы',  series: 'series-2' },
      { key: 'sales_qty',  label: 'Продажи', series: 'series-4' },
  ]},
  { key: 'pct', unit: '%', metrics: [
      { key: 'redemption_pct', label: '% выкупа',         series: 'series-5' },
      { key: 'margin_pct',     label: '% маржинальность', series: 'series-6' },
  ]},
];
const METRICS_KEY = 'mp-dashboard-metrics';

function Tile({ def, value, dragging, onDragStart, onDragOver, onDrop, onDragEnd }) {
  const negative = typeof value === 'number' && value < 0;
  return (
    <div
      draggable
      onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragEnd={onDragEnd}
      title="Перетащите, чтобы изменить порядок"
      style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        padding: '12px 16px', minWidth: 150, flex: '0 0 auto', cursor: 'grab', userSelect: 'none',
        opacity: dragging ? 0.35 : 1, scrollSnapAlign: 'start',
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4, whiteSpace: 'nowrap' }}>{def.label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: negative ? 'var(--danger)' : 'var(--text)' }}>
        {formatValue(value, def.format)}
      </div>
    </div>
  );
}

function ChartTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 12 }}>
      <div style={{ color: 'var(--text2)', marginBottom: 4 }}>{dayjs(label).format('DD.MM.YYYY')}</div>
      {payload.map(p => (
        <div key={p.dataKey} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: p.stroke, flexShrink: 0 }} />
          <span style={{ color: 'var(--text2)' }}>{p.name}:</span>
          <span style={{ fontWeight: 600 }}>
            {Number(p.value).toLocaleString('ru')}{unit === '%' ? '%' : unit === '₽' ? ' ₽' : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard({ platform }) {
  const today = dayjs().format('YYYY-MM-DD');
  const [dateFrom, setDateFrom] = useState(dayjs().subtract(29, 'day').format('YYYY-MM-DD'));
  const [dateTo, setDateTo]     = useState(today);

  const [overview, setOverview] = useState({});
  const [chart, setChart]       = useState({});
  const [loading, setLoading]   = useState(true);

  const [blocks, setBlocks]     = useState(loadBlocks);
  const [showConfig, setShowConfig] = useState(false);
  const [draggingKey, setDraggingKey] = useState(null);

  const [selectedMetrics, setSelectedMetrics] = useState(() => {
    try { return JSON.parse(localStorage.getItem(METRICS_KEY)) || ['orders_qty']; }
    catch(e) { return ['orders_qty']; }
  });

  const scrollerRef = useRef(null);
  const [canLeft, setCanLeft]   = useState(false);
  const [canRight, setCanRight] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getOverview({ platform, dateFrom, dateTo }),
      getChart({ platform, dateFrom, dateTo }),
    ]).then(([ov, ch]) => {
      setOverview(ov.data.data || {});
      setChart(ch.data.data || {});
    }).catch(console.error).finally(() => setLoading(false));
  }, [platform, dateFrom, dateTo]);

  useEffect(() => { try { localStorage.setItem(BLOCKS_KEY, JSON.stringify(blocks)); } catch(e) {} }, [blocks]);
  useEffect(() => { try { localStorage.setItem(METRICS_KEY, JSON.stringify(selectedMetrics)); } catch(e) {} }, [selectedMetrics]);

  const statsSource = overview[platform] || overview.all || null;
  const chartData    = chart[platform] || chart.all || [];

  const visibleBlocks = useMemo(() => blocks.filter(b => b.visible), [blocks]);

  function toggleVisible(key) {
    setBlocks(prev => prev.map(b => b.key === key ? { ...b, visible: !b.visible } : b));
  }
  function moveBlock(fromKey, toKey) {
    if (fromKey === toKey) return;
    setBlocks(prev => {
      const arr = [...prev];
      const fromIdx = arr.findIndex(b => b.key === fromKey);
      const toIdx   = arr.findIndex(b => b.key === toKey);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      return arr;
    });
  }
  function toggleMetric(key) {
    setSelectedMetrics(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  }

  function updateScrollState() {
    const el = scrollerRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }
  useEffect(() => { updateScrollState(); }, [visibleBlocks.length]);
  function scrollTiles(delta) { scrollerRef.current?.scrollBy({ left: delta, behavior: 'smooth' }); }

  const chartGroups = CHART_GROUPS
    .map(g => ({ ...g, metrics: g.metrics.filter(m => selectedMetrics.includes(m.key)) }))
    .filter(g => g.metrics.length > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 17, fontWeight: 700 }}>Дашборд</h1>
        <div style={{ marginLeft: 'auto' }}>
          <DateRangePicker from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t); }} />
        </div>
      </div>

      {/* Блоки KPI */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          onClick={() => setShowConfig(v => !v)}
          style={{ alignSelf: 'flex-end', border: 'none', background: 'transparent', color: 'var(--text2)', fontSize: 12, padding: '2px 0' }}
        >
          ⚙ Настроить блоки
        </button>

        {showConfig && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {blocks.map(b => {
              const def = BLOCK_DEFS.find(d => d.key === b.key);
              if (!def) return null;
              return (
                <label key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={b.visible} onChange={() => toggleVisible(b.key)} />
                  {def.label}
                </label>
              );
            })}
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>Карточки ниже можно перетаскивать мышью, чтобы поменять порядок</div>
          </div>
        )}

        <div style={{ position: 'relative' }}>
          {canLeft && (
            <button onClick={() => scrollTiles(-260)} style={{
              position: 'absolute', left: -6, top: '50%', transform: 'translateY(-50%)', zIndex: 2,
              width: 28, height: 28, borderRadius: 14, border: '1px solid var(--border)', background: 'var(--surface)',
              color: 'var(--text2)', boxShadow: '0 2px 6px rgba(0,0,0,.15)',
            }}>‹</button>
          )}
          <div
            ref={scrollerRef}
            onScroll={updateScrollState}
            style={{ display: 'flex', gap: 10, overflowX: 'auto', scrollSnapType: 'x proximity', paddingBottom: 2 }}
          >
            {loading && visibleBlocks.length === 0 ? null : visibleBlocks.map(b => {
              const def = BLOCK_DEFS.find(d => d.key === b.key);
              if (!def) return null;
              const value = BLOCK_VALUE[b.key]?.(statsSource);
              return (
                <Tile
                  key={b.key} def={def} value={loading ? null : value}
                  dragging={draggingKey === b.key}
                  onDragStart={() => setDraggingKey(b.key)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={() => { if (draggingKey) moveBlock(draggingKey, b.key); setDraggingKey(null); }}
                  onDragEnd={() => setDraggingKey(null)}
                />
              );
            })}
          </div>
          {canRight && (
            <button onClick={() => scrollTiles(260)} style={{
              position: 'absolute', right: -6, top: '50%', transform: 'translateY(-50%)', zIndex: 2,
              width: 28, height: 28, borderRadius: 14, border: '1px solid var(--border)', background: 'var(--surface)',
              color: 'var(--text2)', boxShadow: '0 2px 6px rgba(0,0,0,.15)',
            }}>›</button>
          )}
        </div>
      </div>

      {/* График */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16 }}>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: chartGroups.length ? 14 : 0 }}>
          {CHART_GROUPS.map(g => (
            <div key={g.key} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>{g.unit}:</span>
              {g.metrics.map(m => {
                const active = selectedMetrics.includes(m.key);
                return (
                  <button key={m.key} onClick={() => toggleMetric(m.key)} style={{
                    padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)',
                    background: active ? `var(--${m.series})` : 'var(--surface2)',
                    color: active ? '#fff' : 'var(--text2)', fontSize: 12, fontWeight: 500,
                  }}>{m.label}</button>
                );
              })}
            </div>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text2)' }}>Загрузка...</div>
        ) : !chartGroups.length ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text2)' }}>Выберите хотя бы одну метрику</div>
        ) : chartData.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text2)' }}>Нет данных за выбранный период</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {chartGroups.map(g => (
              <div key={g.key}>
                {chartGroups.length > 1 && <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>{g.unit}</div>}
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={d => dayjs(d).format('DD.MM')}
                      stroke="var(--text3)" fontSize={11} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
                    <YAxis stroke="var(--text3)" fontSize={11} tickLine={false} axisLine={false} width={46}
                      tickFormatter={v => g.key === 'money' && Math.abs(v) >= 1000 ? Math.round(v / 1000) + 'k' : v} />
                    <Tooltip content={<ChartTooltip unit={g.unit} />} />
                    {g.metrics.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
                    {g.metrics.map(m => (
                      <Line key={m.key} type="monotone" dataKey={m.key} name={m.label}
                        stroke={`var(--${m.series})`} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
