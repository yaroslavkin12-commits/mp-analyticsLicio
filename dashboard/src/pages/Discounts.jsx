import React, { useState, useEffect, useCallback } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts';
import {
  getDiscounts, getDiscountsSummary, getDiscountsFeed, getDiscountSettings, saveDiscountSettings,
} from '../api';

// Соинвест Ozon (аналог СПП на Wildberries) — маркетплейс сам доплачивает
// часть скидки покупателю за счёт своей комиссии. Разница между ценой
// продавца и ценой на витрине — это и есть размер Соинвеста. Сюда попадают
// только реальные ИЗМЕНЕНИЯ этого процента (см. backend
// collectors/ads/ozonDiscounts.js) — история копится с момента первого
// сбора, задача проверяет изменения каждые ~20 минут, а при значимом сдвиге
// уходит уведомление в Telegram.
//
// Вкладки "Уведомления" и "Настройки" — по образцу СПП-монитора TrueStats:
// общая лента изменений по всем артикулам, ежедневный дайджест, порог
// срабатывания и тихие часы (backend: routes/ads.js /discounts/feed и
// /discounts/settings, collectors/ads/discountSettings.js).

const DAYS_OPTIONS = [['1', '1 д'], ['7', '7 д'], ['30', '30 д'], ['90', '90 д']];
const TABS = [['articles', 'Мои артикулы'], ['feed', 'Уведомления'], ['settings', 'Настройки']];
const SORT_OPTIONS = [
  ['pct_desc', 'Соинвест ↓'],
  ['pct_asc', 'Соинвест ↑'],
  ['change_desc', 'Изменение за 24ч'],
  ['name_asc', 'По алфавиту'],
];

function fmtPct(v) { return `${v > 0 ? v.toFixed(1) : '0.0'}%`; }
function fmtMoney(v) { return `${Math.round(v).toLocaleString('ru-RU')} ₽`; }
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function ChangeBadge({ value }) {
  if (!value) return <span style={{ color: 'var(--text3)' }}>—</span>;
  const up = value > 0;
  return (
    <span style={{ color: up ? 'var(--ok, #10b981)' : 'var(--danger, #ef4444)', fontWeight: 600 }}>
      {up ? '▲' : '▼'} {Math.abs(value).toFixed(1)} п.п.
    </span>
  );
}

function SummaryTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 12 }}>
      <div style={{ color: 'var(--text2)', marginBottom: 4 }}>{new Date(label).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}</div>
      <div style={{ fontWeight: 600 }}>{p.avgPct.toFixed(1)}% средняя скидка</div>
      <div style={{ color: 'var(--text3)' }}>{p.articles} артикулов</div>
    </div>
  );
}

function DaysSwitch({ days, setDays }) {
  return (
    <div style={{ display: 'flex', gap: 3, background: 'var(--surface2)', borderRadius: 8, padding: 3 }}>
      {DAYS_OPTIONS.map(([v, l]) => (
        <button key={v} onClick={() => setDays(v)} style={{
          padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 12.5, fontWeight: 500,
          background: days === v ? 'var(--accent-oz)' : 'transparent', color: days === v ? '#fff' : 'var(--text2)',
        }}>{l}</button>
      ))}
    </div>
  );
}

// Небольшая цветная точка-легенда под графиком с двумя линиями — как
// подписи серий в СПП-мониторе TrueStats, без встроенной легенды recharts,
// чтобы не расходиться со стилем остальной страницы.
function LegendDot({ color, dashed, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text3)' }}>
      <span style={{
        width: 14, height: dashed ? 0 : 8, borderRadius: dashed ? 0 : '50%',
        borderTop: dashed ? `2px dashed ${color}` : 'none', background: dashed ? 'transparent' : color,
      }} />
      {label}
    </div>
  );
}

function PctTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 12 }}>
      <div style={{ color: 'var(--text2)', marginBottom: 4 }}>{fmtDateTime(label)}</div>
      <div style={{ fontWeight: 600 }}>{fmtPct(payload[0].value)}</div>
    </div>
  );
}

function PriceTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 12 }}>
      <div style={{ color: 'var(--text2)', marginBottom: 4 }}>{fmtDateTime(label)}</div>
      {payload.map(p => (
        <div key={p.dataKey} style={{ color: p.color }}>{p.name}: {fmtMoney(p.value)}</div>
      ))}
    </div>
  );
}

// Полная карточка артикула — открывается кликом по строке в таблице, как
// провал внутрь товара в СПП-мониторе TrueStats: два графика (динамика
// Соинвеста и динамика цен) плюс та же табличная история под ними.
function ArticleDetailModal({ article, onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const chartData = article.history.map(h => ({
    at: h.at, pct: h.pct, price: h.price, marketingPrice: h.marketingPrice, ozonCardPrice: h.ozonCardPrice || null,
  }));

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', overflowY: 'auto',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14,
          width: '100%', maxWidth: 760, padding: 22,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{article.offerId}</div>
            {article.productName && <div style={{ fontSize: 13, color: 'var(--text3)', marginTop: 2 }}>{article.productName}</div>}
          </div>
          <button onClick={onClose} style={{
            border: 'none', background: 'var(--surface2)', color: 'var(--text2)', borderRadius: 8,
            width: 28, height: 28, fontSize: 14, cursor: 'pointer', flexShrink: 0,
          }}>✕</button>
        </div>

        <div style={{ display: 'flex', gap: 18, margin: '14px 0', flexWrap: 'wrap' }}>
          {[
            ['Текущий Соинвест', article.current ? fmtPct(article.current.pct) : '—'],
            ['Мин / Макс за период', `${fmtPct(article.minPct)} / ${fmtPct(article.maxPct)}`],
            ['Цена покупателя', article.current ? fmtMoney(article.current.marketingPrice) : '—'],
            ['Изменений за период', article.changesCount],
          ].map(([l, v]) => (
            <div key={l}>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>{l}</div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{v}</div>
            </div>
          ))}
        </div>

        {chartData.length > 1 && (
          <>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', margin: '16px 0 6px' }}>Динамика Соинвеста</div>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="at" tickFormatter={d => new Date(d).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}
                  stroke="var(--text3)" fontSize={11} tickLine={false} axisLine={{ stroke: 'var(--border)' }} minTickGap={30} />
                <YAxis stroke="var(--text3)" fontSize={11} tickLine={false} axisLine={false} width={40}
                  tickFormatter={v => `${v}%`} domain={['dataMin - 2', 'dataMax + 2']} />
                <Tooltip content={<PctTooltip />} />
                <Line type="stepAfter" dataKey="pct" stroke="var(--accent-oz)" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>

            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', margin: '18px 0 6px' }}>Динамика цен</div>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="at" tickFormatter={d => new Date(d).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}
                  stroke="var(--text3)" fontSize={11} tickLine={false} axisLine={{ stroke: 'var(--border)' }} minTickGap={30} />
                <YAxis stroke="var(--text3)" fontSize={11} tickLine={false} axisLine={false} width={56}
                  tickFormatter={v => `${Math.round(v / 1000)}k`} domain={['dataMin - 100', 'dataMax + 100']} />
                <Tooltip content={<PriceTooltip />} />
                <Line type="stepAfter" dataKey="price" name="Цена продавца" stroke="var(--text3)" strokeWidth={2} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                <Line type="stepAfter" dataKey="marketingPrice" name="Цена на витрине" stroke="var(--accent-oz)" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
              <LegendDot color="var(--text3)" dashed label="Цена продавца" />
              <LegendDot color="var(--accent-oz)" label="Цена на витрине" />
            </div>
          </>
        )}

        <ArticleHistory history={article.history} />
      </div>
    </div>
  );
}

function ArticleHistory({ history }) {
  const last20 = [...history].reverse().slice(0, 20);
  return (
    <div style={{ marginTop: 8, padding: '10px 14px', background: 'var(--surface2)', borderRadius: 8 }}>
      <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 6 }}>История изменений (последние {last20.length})</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <thead>
          <tr style={{ color: 'var(--text3)', textAlign: 'left' }}>
            <th style={{ padding: '3px 8px', fontWeight: 500 }}>Когда</th>
            <th style={{ padding: '3px 8px', fontWeight: 500 }}>Соинвест</th>
            <th style={{ padding: '3px 8px', fontWeight: 500 }}>Цена продавца</th>
            <th style={{ padding: '3px 8px', fontWeight: 500 }}>Цена на сайте</th>
            <th style={{ padding: '3px 8px', fontWeight: 500 }}>С Ozon Картой</th>
          </tr>
        </thead>
        <tbody>
          {last20.map((h, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ padding: '4px 8px', color: 'var(--text2)' }}>{fmtDateTime(h.at)}{h.source && h.source !== 'public_page' ? ' *' : ''}</td>
              <td style={{ padding: '4px 8px', fontWeight: 600 }}>{fmtPct(h.pct)}</td>
              <td style={{ padding: '4px 8px', color: 'var(--text2)' }}>{fmtMoney(h.price)}</td>
              <td style={{ padding: '4px 8px', color: 'var(--text2)' }}>{fmtMoney(h.marketingPrice)}</td>
              <td style={{ padding: '4px 8px', color: 'var(--text2)' }}>{h.ozonCardPrice ? fmtMoney(h.ozonCardPrice) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryChart({ summary, loading }) {
  if (loading) return <div style={{ padding: 32, textAlign: 'center', color: 'var(--text2)' }}>Загрузка…</div>;
  const series = summary?.series || [];
  if (!series.length) return <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>Нет данных за выбранный период</div>;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis dataKey="day" tickFormatter={d => new Date(d).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}
          stroke="var(--text3)" fontSize={11} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
        <YAxis stroke="var(--text3)" fontSize={11} tickLine={false} axisLine={false} width={40}
          tickFormatter={v => `${v}%`} domain={['dataMin - 2', 'dataMax + 2']} />
        <Tooltip content={<SummaryTooltip />} cursor={{ fill: 'var(--surface2)' }} />
        <Bar dataKey="avgPct" radius={[4, 4, 0, 0]}>
          {series.map((s, i) => <Cell key={i} fill={s.day === today ? 'var(--accent-oz-light, #93c5fd)' : 'var(--accent-oz)'} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function ArticlesTab({ cabinet, days, setDays }) {
  const [data, setData] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('pct_desc');
  const [minPct, setMinPct] = useState('');
  const [maxPct, setMaxPct] = useState('');
  const [hideEstimates, setHideEstimates] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(false);

  const load = useCallback(() => {
    setLoading(true); setSummaryLoading(true);
    getDiscounts(cabinet, days).then(r => { setData(r.data.data); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
    getDiscountsSummary(cabinet, days).then(r => setSummary(r.data.data))
      .catch(() => setSummary(null))
      .finally(() => setSummaryLoading(false));
  }, [cabinet, days]);

  useEffect(() => { load(); }, [load]);

  const min = minPct !== '' ? Number(minPct) : null;
  const max = maxPct !== '' ? Number(maxPct) : null;

  const articles = (data?.articles || [])
    .filter(a => !search || a.offerId.toLowerCase().includes(search.toLowerCase()) ||
      (a.productName || '').toLowerCase().includes(search.toLowerCase()))
    .filter(a => min === null || (a.current && a.current.pct >= min))
    .filter(a => max === null || (a.current && a.current.pct <= max))
    .filter(a => !hideEstimates || !a.isEstimate)
    .filter(a => !onlyChanged || a.changes24h !== 0)
    .sort((a, b) => {
      if (sortBy === 'pct_asc') return (a.current?.pct || 0) - (b.current?.pct || 0);
      if (sortBy === 'change_desc') return Math.abs(b.changes24h || 0) - Math.abs(a.changes24h || 0);
      if (sortBy === 'name_asc') return a.offerId.localeCompare(b.offerId);
      return (b.current?.pct || 0) - (a.current?.pct || 0); // pct_desc (по умолчанию)
    });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
        <DaysSwitch days={days} setDays={setDays} />
        <input
          value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск по артикулу…"
          style={{ marginLeft: 'auto', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)',
            background: 'var(--surface)', color: 'var(--text)', fontSize: 13, minWidth: 200 }}
        />
        <button onClick={load} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)',
          background: 'var(--surface2)', color: 'var(--text2)', fontSize: 12.5 }}>Обновить</button>
      </div>

      {/* Фильтры по образцу СПП-монитора TrueStats: диапазон Соинвеста,
          сортировка, скрыть оценки без реальной цены, только с изменениями. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap', fontSize: 12.5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text2)' }}>
          <span>Соинвест от</span>
          <input type="number" min={0} max={100} value={minPct} onChange={e => setMinPct(e.target.value)} placeholder="0"
            style={{ width: 56, padding: '5px 8px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12.5 }} />
          <span>до</span>
          <input type="number" min={0} max={100} value={maxPct} onChange={e => setMaxPct(e.target.value)} placeholder="100"
            style={{ width: 56, padding: '5px 8px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12.5 }} />
          <span>%</span>
        </div>

        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{
          padding: '5px 8px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12.5,
        }}>
          {SORT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={hideEstimates} onChange={e => setHideEstimates(e.target.checked)} />
          Только с реальной ценой сайта
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyChanged} onChange={e => setOnlyChanged(e.target.checked)} />
          Только с изменениями за 24ч
        </label>

        {(minPct !== '' || maxPct !== '' || hideEstimates || onlyChanged || search) && (
          <button onClick={() => { setMinPct(''); setMaxPct(''); setHideEstimates(false); setOnlyChanged(false); setSearch(''); }}
            style={{ border: 'none', background: 'transparent', color: 'var(--text3)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}>
            Сбросить фильтры
          </button>
        )}
      </div>

      {/* Сводные метрики + график средней скидки по дням — как в СПП-мониторе TrueStats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
        {[
          ['На мониторинге', summary ? summary.totalArticles : '—'],
          ['Средняя скидка', summary ? fmtPct(summary.currentAvgPct) : '—'],
          ['Изменений за 24ч', summary ? summary.changes24h : '—'],
          ['Артикулов с данными', data ? data.articles.length : '—'],
        ].map(([label, value]) => (
          <div key={label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', marginBottom: 10 }}>Средняя скидка покупателя</div>
        <SummaryChart summary={summary} loading={summaryLoading} />
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--text3)', marginBottom: 12, lineHeight: 1.5 }}>
        Соинвест — доля скидки, которую Ozon покрывает сам за счёт своей комиссии (аналог СПП на Wildberries).
        Разница между ценой продавца и ценой на витрине для покупателя. Показаны только реальные изменения
        процента — таблица обновляется примерно раз в 20 минут; при резком сдвиге приходит уведомление в Telegram.
        Значок «≈» — не удалось получить цену с публичной страницы товара, показана приблизительная оценка без реальной цены на сайте.
      </div>

      {loading && !data && <div style={{ color: 'var(--text3)' }}>Загрузка…</div>}
      {error && <div style={{ color: 'var(--danger, #ef4444)' }}>Ошибка: {error}</div>}

      {data && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--surface2)', textAlign: 'left', color: 'var(--text3)', fontSize: 11.5 }}>
                <th style={{ padding: '8px 14px', fontWeight: 500 }}>Артикул</th>
                <th style={{ padding: '8px 14px', fontWeight: 500 }}>Текущий Соинвест</th>
                <th style={{ padding: '8px 14px', fontWeight: 500 }}>За 24ч</th>
                <th style={{ padding: '8px 14px', fontWeight: 500 }}>Мин / Макс за период</th>
                <th style={{ padding: '8px 14px', fontWeight: 500 }}>Цена покупателя</th>
                <th style={{ padding: '8px 14px', fontWeight: 500 }}>Изменений</th>
              </tr>
            </thead>
            <tbody>
              {articles.map(a => (
                <tr
                  key={a.offerId}
                  onClick={() => setDetail(a)}
                  style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}
                >
                  <td style={{ padding: '9px 14px' }}>
                    <div style={{ fontWeight: 600 }}>{a.offerId}</div>
                    {a.productName && <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>{a.productName.slice(0, 60)}</div>}
                  </td>
                  <td style={{ padding: '9px 14px', fontWeight: 700, fontSize: 14 }}>
                    {a.current ? fmtPct(a.current.pct) : '—'}
                    {a.isEstimate && <span title="Не удалось получить цену с публичной страницы товара — это приблизительная оценка без реальной цены на сайте" style={{ marginLeft: 4, fontSize: 11, fontWeight: 400, color: 'var(--text3)' }}>≈</span>}
                  </td>
                  <td style={{ padding: '9px 14px' }}><ChangeBadge value={a.changes24h} /></td>
                  <td style={{ padding: '9px 14px', color: 'var(--text2)' }}>{fmtPct(a.minPct)} / {fmtPct(a.maxPct)}</td>
                  <td style={{ padding: '9px 14px', color: 'var(--text2)' }}>{a.current ? fmtMoney(a.current.marketingPrice) : '—'}</td>
                  <td style={{ padding: '9px 14px', color: 'var(--text3)' }}>{a.changesCount}</td>
                </tr>
              ))}
              {!articles.length && (
                <tr><td colSpan={6} style={{ padding: 20, textAlign: 'center', color: 'var(--text3)' }}>
                  Пока нет данных — сборщик Соинвеста ещё не успел собрать первую историю (или ничего не изменилось за выбранный период).
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {detail && <ArticleDetailModal article={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function FeedTab({ cabinet, days, setDays }) {
  const [feed, setFeed] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    getDiscountsFeed(cabinet, days).then(r => { setFeed(r.data.data.feed); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [cabinet, days]);

  // Группируем по дате для читаемости, как в ленте TrueStats.
  const groups = [];
  for (const item of feed || []) {
    const day = new Date(item.at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    let g = groups.find(g => g.day === day);
    if (!g) { g = { day, items: [] }; groups.push(g); }
    g.items.push(item);
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <DaysSwitch days={days} setDays={setDays} />
      </div>

      {loading && <div style={{ color: 'var(--text3)' }}>Загрузка…</div>}
      {error && <div style={{ color: 'var(--danger, #ef4444)' }}>Ошибка: {error}</div>}

      {!loading && !groups.length && (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12 }}>
          Пока нет изменений за выбранный период.
        </div>
      )}

      {groups.map(g => (
        <div key={g.day} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', marginBottom: 8, letterSpacing: 0.4 }}>{g.day}</div>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            {g.items.map((it, i) => {
              const up = it.pct > it.prevPct;
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', fontSize: 13,
                  borderTop: i ? '1px solid var(--border)' : 'none',
                }}>
                  <div style={{ color: 'var(--text3)', fontSize: 12, width: 44, flexShrink: 0 }}>
                    {new Date(it.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {it.productName ? `${it.offerId} · ${it.productName}` : it.offerId}
                    </div>
                  </div>
                  <div style={{ color: up ? 'var(--ok, #10b981)' : 'var(--danger, #ef4444)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {fmtPct(it.prevPct)} → {fmtPct(it.pct)} {up ? '▲' : '▼'}
                  </div>
                  <div style={{ color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                    витрина {fmtMoney(it.marketingPrice)}{it.ozonCardPrice ? `, с картой ${fmtMoney(it.ozonCardPrice)}` : ''}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function Toggle({ value, onChange }) {
  return (
    <button onClick={() => onChange(!value)} style={{
      width: 40, height: 22, borderRadius: 11, border: 'none', position: 'relative', flexShrink: 0,
      background: value ? 'var(--accent-oz)' : 'var(--surface2)', transition: 'background .15s',
    }}>
      <span style={{
        position: 'absolute', top: 2, left: value ? 20 : 2, width: 18, height: 18, borderRadius: '50%',
        background: '#fff', transition: 'left .15s',
      }} />
    </button>
  );
}

function SettingsTab({ cabinet }) {
  const [settings, setSettingsState] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getDiscountSettings(cabinet).then(r => setSettingsState(r.data.data)).catch(() => {});
  }, [cabinet]);

  function patch(p) { setSettingsState(s => ({ ...s, ...p })); setSaved(false); }

  function save() {
    setSaving(true);
    saveDiscountSettings(cabinet, settings)
      .then(r => { setSettingsState(r.data.data); setSaved(true); })
      .finally(() => setSaving(false));
  }

  if (!settings) return <div style={{ color: 'var(--text3)' }}>Загрузка…</div>;

  const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 18, marginBottom: 14, maxWidth: 520 };
  const label = { fontSize: 13, fontWeight: 600, marginBottom: 6 };
  const hint = { fontSize: 11.5, color: 'var(--text3)', marginTop: 6, lineHeight: 1.4 };

  return (
    <div>
      <div style={card}>
        <div style={label}>Порог изменения Соинвеста</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="range" min={0.5} max={10} step={0.5} value={settings.thresholdPct}
            onChange={e => patch({ thresholdPct: Number(e.target.value) })} style={{ flex: 1 }} />
          <div style={{ fontWeight: 700, width: 56, textAlign: 'right' }}>{settings.thresholdPct.toFixed(1)} п.п.</div>
        </div>
        <div style={hint}>Уведомление придёт, если Соинвест изменится на этот порог и больше.</div>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Toggle value={settings.quietEnabled} onChange={v => patch({ quietEnabled: v })} />
          <div style={label}>Тихий режим</div>
        </div>
        <div style={hint}>Ночью уведомления по конкретным изменениям не приходят — их подберёт утренний дайджест (если включён).</div>
        {settings.quietEnabled && (
          <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
            <div>
              <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 4 }}>С</div>
              <input type="time" value={settings.quietStart} onChange={e => patch({ quietStart: e.target.value })}
                style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)' }} />
            </div>
            <div>
              <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 4 }}>До</div>
              <input type="time" value={settings.quietEnd} onChange={e => patch({ quietEnd: e.target.value })}
                style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)' }} />
            </div>
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Toggle value={settings.digestEnabled} onChange={v => patch({ digestEnabled: v })} />
          <div style={label}>Ежедневный дайджест</div>
        </div>
        <div style={hint}>Топ-3 изменения за сутки одним сообщением в Telegram, во сколько удобно.</div>
        {settings.digestEnabled && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 4 }}>Время</div>
            <input type="time" value={settings.digestTime} onChange={e => patch({ digestTime: e.target.value })}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)' }} />
          </div>
        )}
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 4 }}>Таймзона</div>
          <select value={settings.timezone} onChange={e => patch({ timezone: e.target.value })}
            style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)' }}>
            <option value="Europe/Moscow">Europe/Moscow</option>
            <option value="Europe/Kaliningrad">Europe/Kaliningrad</option>
            <option value="Asia/Yekaterinburg">Asia/Yekaterinburg</option>
            <option value="Asia/Novosibirsk">Asia/Novosibirsk</option>
            <option value="Asia/Vladivostok">Asia/Vladivostok</option>
          </select>
          <div style={hint}>Влияет на тихий режим и время дайджеста.</div>
        </div>
      </div>

      <button onClick={save} disabled={saving} style={{
        padding: '9px 18px', borderRadius: 8, border: 'none', background: 'var(--accent-oz)', color: '#fff',
        fontSize: 13.5, fontWeight: 600, opacity: saving ? 0.6 : 1,
      }}>{saving ? 'Сохранение…' : 'Сохранить'}</button>
      {saved && <span style={{ marginLeft: 10, color: 'var(--ok, #10b981)', fontSize: 13 }}>Сохранено ✓</span>}
    </div>
  );
}

export default function Discounts({ cabinet }) {
  const [tab, setTab] = useState('articles');
  const [days, setDays] = useState('30');

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Соинвест Ozon</h2>
        <div style={{ display: 'flex', gap: 4 }}>
          {TABS.map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{
              padding: '6px 4px', border: 'none', background: 'transparent', fontSize: 13.5,
              fontWeight: tab === id ? 600 : 400, color: tab === id ? 'var(--text)' : 'var(--text2)',
              borderBottom: tab === id ? '2px solid var(--accent-oz)' : '2px solid transparent',
            }}>{label}</button>
          ))}
        </div>
      </div>

      {tab === 'articles' && <ArticlesTab cabinet={cabinet} days={days} setDays={setDays} />}
      {tab === 'feed' && <FeedTab cabinet={cabinet} days={days} setDays={setDays} />}
      {tab === 'settings' && <SettingsTab cabinet={cabinet} />}
    </div>
  );
}
