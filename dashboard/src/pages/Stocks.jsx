import React, { useState, useEffect, useMemo } from 'react';
import { getStocksV2, getStocksHistory } from '../api';

const PLATFORMS = [['all','Все'],['wb','WB'],['ozon','Ozon']];
const FULFILLMENTS = [['all','FBO+FBS'],['fbo','FBO'],['fbs','FBS']];
const GENDERS = [['all','Все'],['Мужское','Мужское'],['Женское','Женское']];
const SORTS = [['article','По артикулу'],['qty_desc','Остаток: сначала больше'],['qty_asc','Остаток: сначала меньше']];

// FBS — это один физический остаток на общем фулфилменте, который просто
// выгружается сразу на обе площадки (а не два независимых остатка, как
// FBO). Поэтому при platform === 'all' его нельзя складывать как
// wb_fbs + ozon_fbs — это задвоит цифру. Берём максимум из двух значений
// (площадки синкают выгрузку с небольшой задержкой друг относительно друга).
// При выборе конкретной площадки показываем то, что реально видно на ней.
//
// Эта же функция используется и для истории по дням (см. ниже) — объект
// {wb_fbo, wb_fbs, ozon_fbo, ozon_fbs} на дату имеет ту же форму, что и
// текущий размер, поэтомуqtyOf() переиспользуется без изменений.
function qtyOf(size, platform, fulfillment) {
  const wantFbo = fulfillment === 'all' || fulfillment === 'fbo';
  const wantFbs = fulfillment === 'all' || fulfillment === 'fbs';
  let v = 0;
  if (platform === 'all') {
    if (wantFbo) v += size.wb_fbo + size.ozon_fbo;
    if (wantFbs) v += Math.max(size.wb_fbs, size.ozon_fbs);
  } else if (platform === 'wb') {
    if (wantFbo) v += size.wb_fbo;
    if (wantFbs) v += size.wb_fbs;
  } else if (platform === 'ozon') {
    if (wantFbo) v += size.ozon_fbo;
    if (wantFbs) v += size.ozon_fbs;
  }
  return v;
}

function badge(qty) {
  if (qty === 0) return { label: '🔴 Нет',   color: 'var(--danger)', bg: 'rgba(239,68,68,.12)' };
  if (qty < 10)  return { label: '🟡 Мало',  color: 'var(--warn)',   bg: 'rgba(245,158,11,.12)' };
  return             { label: '🟢 Норма', color: 'var(--ok)',     bg: 'rgba(16,185,129,.12)' };
}

const SIZE_ORDER = ['XXS','XS','S','M','L','XL','XXL','2XL','3XL','4XL','5XL'];
function sizeRank(s) {
  const i = SIZE_ORDER.indexOf(String(s).toUpperCase());
  if (i !== -1) return i;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? 1000 + n : 2000;
}

// ---- экспорт в Excel ----
//
// Выгружаем ровно тот набор товаров, что сейчас виден на экране (с учётом
// поиска/категории/пола), в двух листах: "По товару" — сводка как в
// свёрнутой таблице, и "По размерам" — детализация как в развёрнутой
// строке. Библиотека грузится динамически (import()), чтобы не раздувать
// основной бандл — она нужна только в момент нажатия на кнопку.
function buildSummaryAOA(rows) {
  const header = ['Артикул', 'Категория', 'Пол', 'Название', 'Размеров', 'WB FBO', 'WB FBS', 'Ozon FBO', 'Ozon FBS', 'Итого'];
  const body = rows.map(p => [
    p.baseArticle, p.category || '—', p.gender || '—', p.subject || '—', p.sizes.length,
    p.totals.wb_fbo, p.totals.wb_fbs, p.totals.ozon_fbo, p.totals.ozon_fbs, p.totals.total,
  ]);
  const t = rows.reduce((a, p) => ({
    wb_fbo: a.wb_fbo + p.totals.wb_fbo, wb_fbs: a.wb_fbs + p.totals.wb_fbs,
    ozon_fbo: a.ozon_fbo + p.totals.ozon_fbo, ozon_fbs: a.ozon_fbs + p.totals.ozon_fbs,
    total: a.total + p.totals.total,
  }), { wb_fbo: 0, wb_fbs: 0, ozon_fbo: 0, ozon_fbs: 0, total: 0 });
  const totalsRow = ['ИТОГО', '', '', '', '', t.wb_fbo, t.wb_fbs, t.ozon_fbo, t.ozon_fbs, t.total];
  return [header, ...body, totalsRow];
}

function buildDetailAOA(rows) {
  const header = ['Артикул', 'Категория', 'Пол', 'Название', 'Размер', 'WB FBO', 'WB FBS', 'Ozon FBO', 'Ozon FBS', 'Итого'];
  const body = [];
  const t = { wb_fbo: 0, wb_fbs: 0, ozon_fbo: 0, ozon_fbs: 0, total: 0 };
  for (const p of rows) {
    for (const sz of p.sizes) {
      const total = qtyOf(sz, 'all', 'all');
      body.push([p.baseArticle, p.category || '—', p.gender || '—', p.subject || '—', sz.size, sz.wb_fbo, sz.wb_fbs, sz.ozon_fbo, sz.ozon_fbs, total]);
      t.wb_fbo += sz.wb_fbo; t.wb_fbs += sz.wb_fbs; t.ozon_fbo += sz.ozon_fbo; t.ozon_fbs += sz.ozon_fbs; t.total += total;
    }
  }
  const totalsRow = ['ИТОГО', '', '', '', '', t.wb_fbo, t.wb_fbs, t.ozon_fbo, t.ozon_fbs, t.total];
  return [header, ...body, totalsRow];
}

const SUMMARY_COLS = [{ wch: 16 }, { wch: 18 }, { wch: 10 }, { wch: 36 }, { wch: 10 }, { wch: 9 }, { wch: 9 }, { wch: 10 }, { wch: 10 }, { wch: 9 }];
const DETAIL_COLS  = [{ wch: 16 }, { wch: 18 }, { wch: 10 }, { wch: 36 }, { wch: 8 },  { wch: 9 }, { wch: 9 }, { wch: 10 }, { wch: 10 }, { wch: 9 }];

async function exportStocksToExcel(rows, category) {
  const XLSX = await import('xlsx');

  const wb = XLSX.utils.book_new();
  const wsSummary = XLSX.utils.aoa_to_sheet(buildSummaryAOA(rows));
  wsSummary['!cols'] = SUMMARY_COLS;
  XLSX.utils.book_append_sheet(wb, wsSummary, 'По товару');

  const wsDetail = XLSX.utils.aoa_to_sheet(buildDetailAOA(rows));
  wsDetail['!cols'] = DETAIL_COLS;
  XLSX.utils.book_append_sheet(wb, wsDetail, 'По размерам');

  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const catPart = category !== 'all' ? `_${category}` : '';
  const filename = `Остатки_${dateStr}${catPart}.xlsx`.replace(/\s+/g, '_');
  XLSX.writeFile(wb, filename);
}

// ---- история остатков (тренд) ----
//
// EMPTY_DAY подставляется, когда для товара нет записи на конкретную дату
// (например его ещё не было в каталоге) — qtyOf() тогда просто вернёт 0.
const EMPTY_DAY = Object.freeze({ wb_fbo: 0, wb_fbs: 0, ozon_fbo: 0, ozon_fbs: 0 });
const HISTORY_WINDOW = 14;

// Простой столбчатый спарклайн — остаток это ступенчатый уровень между
// поставками и распродажами, столбики читаются под него естественнее, чем
// сглаженная линия. Ноль всегда рисуется нулевой высотой (это тоже значимая
// информация — товара нет), а маленькие ненулевые значения слегка
// поднимаются, чтобы не терялись визуально рядом с большими.
function BarSpark({ values, height = 26, width = 104, color = 'var(--series-1)', gap = 2 }) {
  const max = Math.max(1, ...values);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap, height, width }}>
      {values.map((v, i) => (
        <div key={i} title={String(v)} style={{
          flex: 1, minWidth: 1,
          height: v === 0 ? 0 : `${Math.max(6, (v / max) * 100)}%`,
          background: color, borderRadius: '1.5px 1.5px 0 0',
        }} />
      ))}
    </div>
  );
}

// Парный столбчатый график WB/Ozon по дням — для разворота строки.
function DualBarSpark({ dates, wbValues, ozonValues, height = 60 }) {
  const max = Math.max(1, ...wbValues, ...ozonValues);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height, width: '100%' }}>
      {dates.map((d, i) => (
        <div key={d} style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 1, minWidth: 0 }}>
          <div title={`WB: ${wbValues[i]}`} style={{
            flex: 1, height: wbValues[i] === 0 ? 0 : `${Math.max(4, (wbValues[i] / max) * 100)}%`,
            background: 'var(--accent-wb)', borderRadius: '1.5px 1.5px 0 0',
          }} />
          <div title={`Ozon: ${ozonValues[i]}`} style={{
            flex: 1, height: ozonValues[i] === 0 ? 0 : `${Math.max(4, (ozonValues[i] / max) * 100)}%`,
            background: 'var(--accent-oz)', borderRadius: '1.5px 1.5px 0 0',
          }} />
        </div>
      ))}
    </div>
  );
}

const HISTORY_MODES = {
  total: { label: 'Итого (ФБО+ФБС)', color: 'var(--series-1)' },
  fbo:   { label: 'ФБО',             color: 'var(--series-3)' },
  fbs:   { label: 'ФБС',             color: 'var(--series-5)' },
};

function StatTile({ label, value, sparkValues, sparkColor, onClick, active }) {
  const clickable = typeof onClick === 'function';
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--surface)', border: `1px solid ${active ? sparkColor : 'var(--border)'}`, borderRadius: 'var(--radius)',
        padding: '12px 16px', minWidth: 120, cursor: clickable ? 'pointer' : 'default', position: 'relative',
      }}
      title={clickable ? 'Показать тренд за 14 дней по текущему фильтру' : undefined}
    >
      {clickable && <span style={{ position: 'absolute', top: 8, right: 10, fontSize: 11, opacity: 0.55 }}>📈</span>}
      <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, marginBottom: sparkValues ? 6 : 0 }}>{value.toLocaleString('ru')}</div>
      {sparkValues && <BarSpark values={sparkValues} height={16} width="100%" color={sparkColor} gap={1.5} />}
    </div>
  );
}

function Chip({ label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--surface2)', borderRadius: 7, padding: '5px 10px', fontSize: 12 }}>
      <span style={{ color: 'var(--text2)' }}>{label}</span>
      <span style={{ fontWeight: 700 }}>{value.toLocaleString('ru')}</span>
    </div>
  );
}

export default function Stocks({ platform: platformProp }) {
  const [raw, setRaw] = useState({ products: [], categories: [] });
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState({ dates: [], products: {} });
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [platform, setPlatform] = useState(platformProp || 'all');
  const [fulfillment, setFulfillment] = useState('all');
  const [gender, setGender] = useState('all');
  const [sort, setSort] = useState('article');
  const [expanded, setExpanded] = useState(() => new Set());
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [historyMode, setHistoryMode] = useState(null); // null | 'total' | 'fbo' | 'fbs'

  // Общий переключатель площадки в шапке дашборда тоже должен управлять этой
  // страницей — но локальные кнопки ниже позволяют переопределить его здесь же.
  useEffect(() => { if (platformProp) setPlatform(platformProp); }, [platformProp]);

  useEffect(() => {
    setLoading(true);
    getStocksV2().then(r => setRaw(r.data.data || { products: [], categories: [] }))
      .catch(console.error).finally(() => setLoading(false));
    getStocksHistory(30).then(r => setHistory(r.data.data || { dates: [], products: {} }))
      .catch(console.error);
  }, []);

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    const filtered = raw.products
      .filter(p => category === 'all' || p.category === category)
      .filter(p => gender === 'all' || p.gender === gender)
      .filter(p => !s || p.baseArticle.toLowerCase().includes(s) || (p.subject || '').toLowerCase().includes(s))
      .map(p => {
        const sizes = [...p.sizes].sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
        const total = sizes.reduce((sum, sz) => sum + qtyOf(sz, platform, fulfillment), 0);
        return { ...p, sizes, total };
      });
    if (sort === 'qty_desc') filtered.sort((a, b) => b.total - a.total);
    else if (sort === 'qty_asc') filtered.sort((a, b) => a.total - b.total);
    else filtered.sort((a, b) => a.baseArticle.localeCompare(b.baseArticle));
    return filtered;
  }, [raw, search, category, gender, platform, fulfillment, sort]);

  // Сводка по текущему набору строк (учитывает поиск/категорию/пол/площадку,
  // но ФБО и ФБС считаются независимо от переключателя ФБО/ФБС — чтобы всегда
  // было видно соотношение, а не только то, что выбрано в фильтре).
  const stats = useMemo(() => {
    let fbo = 0, fbs = 0;
    const byCategory = new Map();
    const byWarehouse = new Map();
    for (const p of rows) {
      let pFbo = 0, pFbs = 0;
      for (const sz of p.sizes) {
        pFbo += qtyOf(sz, platform, 'fbo');
        pFbs += qtyOf(sz, platform, 'fbs');
      }
      fbo += pFbo; fbs += pFbs;
      byCategory.set(p.category, (byCategory.get(p.category) || 0) + pFbo + pFbs);
      for (const w of p.wbFbsWarehouses) {
        byWarehouse.set(w.warehouse, (byWarehouse.get(w.warehouse) || 0) + w.qty);
      }
    }
    return {
      fbo, fbs, total: fbo + fbs, count: rows.length,
      categories: [...byCategory.entries()].sort((a, b) => b[1] - a[1]),
      warehouses: [...byWarehouse.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [rows, platform]);

  const footerTotal = useMemo(() => rows.reduce((sum, p) => sum + p.total, 0), [rows]);

  // Последние HISTORY_WINDOW дат, за которые реально есть снимки остатков.
  const historyDates = useMemo(() => history.dates.slice(-HISTORY_WINDOW), [history]);

  // Тренд по сумме ТЕКУЩЕГО набора строк (тот же фильтр, что и в таблице и
  // в Excel-экспорте) — отдельно fbo/fbs по дням, чтобы плитки могли
  // показывать любой из трёх режимов без пересчёта.
  const aggHistory = useMemo(() => {
    if (!historyDates.length) return [];
    return historyDates.map(date => {
      let fbo = 0, fbs = 0;
      for (const p of rows) {
        const day = history.products[p.baseArticle]?.byDate?.[date] || EMPTY_DAY;
        fbo += qtyOf(day, platform, 'fbo');
        fbs += qtyOf(day, platform, 'fbs');
      }
      return { date, fbo, fbs, total: fbo + fbs };
    });
  }, [rows, history, historyDates, platform]);

  const toggle = article => setExpanded(prev => {
    const next = new Set(prev);
    next.has(article) ? next.delete(article) : next.add(article);
    return next;
  });

  async function handleExport() {
    if (exporting || rows.length === 0) return;
    setExporting(true);
    try {
      await exportStocksToExcel(rows, category);
    } catch (e) {
      console.error(e);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 17, fontWeight: 700 }}>Остатки</h1>
        <input placeholder="Поиск по артикулу или названию..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: 260 }} />
        <select value={category} onChange={e => setCategory(e.target.value)} style={{ padding: '5px 8px', borderRadius: 6 }}>
          <option value="all">Все категории</option>
          {raw.categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={sort} onChange={e => setSort(e.target.value)} style={{ padding: '5px 8px', borderRadius: 6 }}>
          {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button
          onClick={handleExport}
          disabled={exporting || loading || rows.length === 0}
          title="Скачать текущий список остатков в Excel (сводка по товару и разбивка по размерам)"
          style={{
            marginLeft: 'auto', padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)',
            background: 'var(--surface2)', color: 'var(--text)', fontSize: 13, fontWeight: 500,
            cursor: exporting || loading || rows.length === 0 ? 'default' : 'pointer',
            opacity: exporting || loading || rows.length === 0 ? 0.6 : 1,
          }}
        >
          {exporting ? 'Готовим файл...' : '⬇ Скачать в Excel'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 3, background: 'var(--surface2)', borderRadius: 8, padding: 3 }}>
          {PLATFORMS.map(([v, l]) => (
            <button key={v} onClick={() => setPlatform(v)} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: 500, background: platform === v ? 'var(--accent-wb)' : 'transparent', color: platform === v ? '#fff' : 'var(--text2)' }}>{l}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 3, background: 'var(--surface2)', borderRadius: 8, padding: 3 }}>
          {FULFILLMENTS.map(([v, l]) => (
            <button key={v} onClick={() => setFulfillment(v)} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: 500, background: fulfillment === v ? 'var(--accent-wb)' : 'transparent', color: fulfillment === v ? '#fff' : 'var(--text2)' }}>{l}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 3, background: 'var(--surface2)', borderRadius: 8, padding: 3 }}>
          {GENDERS.map(([v, l]) => (
            <button key={v} onClick={() => setGender(v)} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: 500, background: gender === v ? 'var(--accent-wb)' : 'transparent', color: gender === v ? '#fff' : 'var(--text2)' }}>{l}</button>
          ))}
        </div>
      </div>

      {!loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <StatTile label="Товаров" value={stats.count} />
            <StatTile
              label="Итого (ФБО+ФБС)" value={stats.total}
              sparkValues={aggHistory.length ? aggHistory.map(d => d.total) : null}
              sparkColor={HISTORY_MODES.total.color}
              active={historyMode === 'total'}
              onClick={aggHistory.length ? () => setHistoryMode(m => m === 'total' ? null : 'total') : undefined}
            />
            <StatTile
              label="ФБО" value={stats.fbo}
              sparkValues={aggHistory.length ? aggHistory.map(d => d.fbo) : null}
              sparkColor={HISTORY_MODES.fbo.color}
              active={historyMode === 'fbo'}
              onClick={aggHistory.length ? () => setHistoryMode(m => m === 'fbo' ? null : 'fbo') : undefined}
            />
            <StatTile
              label="ФБС" value={stats.fbs}
              sparkValues={aggHistory.length ? aggHistory.map(d => d.fbs) : null}
              sparkColor={HISTORY_MODES.fbs.color}
              active={historyMode === 'fbs'}
              onClick={aggHistory.length ? () => setHistoryMode(m => m === 'fbs' ? null : 'fbs') : undefined}
            />
          </div>

          {historyMode && aggHistory.length > 0 && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, fontSize: 12, color: 'var(--text2)' }}>
                <span>Тренд «{HISTORY_MODES[historyMode].label}» по текущему фильтру — {historyDates[0]} — {historyDates[historyDates.length - 1]}</span>
                <button onClick={() => setHistoryMode(null)} style={{ border: 'none', background: 'transparent', color: 'var(--text3)', fontSize: 13 }}>✕</button>
              </div>
              <BarSpark
                values={aggHistory.map(d => d[historyMode])}
                height={90} width="100%" gap={3}
                color={HISTORY_MODES[historyMode].color}
              />
            </div>
          )}

          <button
            onClick={() => setShowBreakdown(v => !v)}
            style={{ alignSelf: 'flex-start', border: 'none', background: 'transparent', color: 'var(--text2)', fontSize: 12, padding: '2px 0' }}
          >
            {showBreakdown ? '▾' : '▸'} Разбивка по категориям и складам ФБС
          </button>

          {showBreakdown && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {stats.categories.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {stats.categories.map(([cat, qty]) => <Chip key={cat} label={cat} value={qty} />)}
                </div>
              )}
              {stats.warehouses.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--text3)' }}>ФБС по складам:</span>
                  {stats.warehouses.map(([wh, qty]) => <Chip key={wh} label={wh} value={qty} />)}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
        {loading ? <div style={{ padding: 32, textAlign: 'center', color: 'var(--text2)' }}>Загрузка...</div>
          : rows.length === 0 ? <div style={{ padding: 40, textAlign: 'center', color: 'var(--text2)' }}>Ничего не найдено</div>
          : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {['', 'Фото', 'Артикул', 'Категория', 'Размеры', `Тренд, ${HISTORY_WINDOW} дн.`, 'Итого', ''].map(h =>
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text2)', fontWeight: 500, fontSize: 12, borderBottom: '1px solid var(--border)' }}>{h}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                const b = badge(p.total);
                const isOpen = expanded.has(p.baseArticle);
                const hist = history.products[p.baseArticle];
                const trendValues = historyDates.map(d => qtyOf(hist?.byDate?.[d] || EMPTY_DAY, platform, fulfillment));
                const wbSeries = historyDates.map(d => {
                  const day = hist?.byDate?.[d] || EMPTY_DAY;
                  return day.wb_fbo + day.wb_fbs;
                });
                const ozonSeries = historyDates.map(d => {
                  const day = hist?.byDate?.[d] || EMPTY_DAY;
                  return day.ozon_fbo + day.ozon_fbs;
                });
                return (
                  <React.Fragment key={p.baseArticle}>
                    <tr style={{ borderBottom: isOpen ? 'none' : '1px solid var(--border)', cursor: 'pointer' }} onClick={() => toggle(p.baseArticle)}>
                      <td style={{ padding: '8px 12px', width: 20, color: 'var(--text2)' }}>{isOpen ? '▾' : '▸'}</td>
                      <td style={{ padding: '8px 12px' }}>
                        {p.photoUrl
                          ? <img
                              src={p.photoUrl}
                              alt=""
                              style={{ width: 40, height: 52, objectFit: 'cover', borderRadius: 6, background: 'var(--surface2)' }}
                              onError={e => {
                                if (p.photoUrlAlt && e.target.src !== p.photoUrlAlt) {
                                  e.target.src = p.photoUrlAlt;
                                } else {
                                  e.target.style.visibility = 'hidden';
                                }
                              }}
                            />
                          : <div style={{ width: 40, height: 52, borderRadius: 6, background: 'var(--surface2)' }} />}
                      </td>
                      <td style={{ padding: '8px 12px', fontWeight: 600 }}>
                        {p.baseArticle}
                        <div style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 400, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.subject || '—'}{p.gender ? ` · ${p.gender}` : ''}</div>
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--text2)' }}>{p.category || '—'}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--text2)' }}>{p.sizes.length} размер(ов)</td>
                      <td style={{ padding: '8px 12px' }}>
                        {historyDates.length > 0 && <BarSpark values={trendValues} color={b.color} />}
                      </td>
                      <td style={{ padding: '8px 12px', fontWeight: 700 }}>{p.total}</td>
                      <td style={{ padding: '8px 12px' }}><span style={{ padding: '2px 8px', borderRadius: 5, fontSize: 11, fontWeight: 600, background: b.bg, color: b.color }}>{b.label}</span></td>
                    </tr>
                    {isOpen && (
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <td></td>
                        <td colSpan={7} style={{ padding: '4px 12px 14px' }}>
                          {historyDates.length > 0 && (
                            <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--text2)', marginBottom: 6 }}>
                                <span>шт., последние {HISTORY_WINDOW} дней</span>
                                <span style={{ display: 'flex', gap: 12 }}>
                                  <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--accent-wb)', marginRight: 5 }} />WB</span>
                                  <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--accent-oz)', marginRight: 5 }} />Ozon</span>
                                </span>
                              </div>
                              <DualBarSpark dates={historyDates} wbValues={wbSeries} ozonValues={ozonSeries} />
                            </div>
                          )}
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                            <thead>
                              <tr style={{ color: 'var(--text2)' }}>
                                <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>Размер</th>
                                <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>WB FBO</th>
                                <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>WB FBS</th>
                                <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Ozon FBO</th>
                                <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Ozon FBS</th>
                                <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Итого</th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.sizes.map(sz => (
                                <tr key={sz.size}>
                                  <td style={{ padding: '3px 8px', fontWeight: 600 }}>{sz.size}</td>
                                  <td style={{ padding: '3px 8px', textAlign: 'right' }}>{sz.wb_fbo}</td>
                                  <td style={{ padding: '3px 8px', textAlign: 'right' }}>
                                    {sz.wb_fbs}
                                    {sz.fbs_mismatch && <span title={`Расхождение с Ozon FBS: ${sz.ozon_fbs}`} style={{ color: 'var(--warn)' }}> ⚠</span>}
                                  </td>
                                  <td style={{ padding: '3px 8px', textAlign: 'right' }}>{sz.ozon_fbo}</td>
                                  <td style={{ padding: '3px 8px', textAlign: 'right' }}>
                                    {sz.ozon_fbs}
                                    {sz.fbs_mismatch && <span title={`Расхождение с WB FBS: ${sz.wb_fbs}`} style={{ color: 'var(--warn)' }}> ⚠</span>}
                                  </td>
                                  <td style={{ padding: '3px 8px', textAlign: 'right', fontWeight: 700 }}>{qtyOf(sz, 'all', 'all')}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {p.wbFbsWarehouses.length > 0 && (
                            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text2)' }}>
                              FBS (общий остаток на фулфилменте) по складам: {p.wbFbsWarehouses.map(w => `${w.warehouse} — ${w.qty}`).join(', ')}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6} style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--text2)', borderTop: '1px solid var(--border)' }}>Итого по фильтру:</td>
                <td style={{ padding: '10px 12px', fontWeight: 700, borderTop: '1px solid var(--border)' }}>{footerTotal.toLocaleString('ru')}</td>
                <td style={{ borderTop: '1px solid var(--border)' }}></td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
