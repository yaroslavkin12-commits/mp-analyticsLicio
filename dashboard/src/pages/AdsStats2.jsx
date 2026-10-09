import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import dayjs from 'dayjs';
import {
  getAdsStats, getAdsDataStatus, collectAds, saveManualAdsMetric, getAdsOrder, saveAdsOrder,
  getAdsGroups, addAdsGroup, removeAdsGroup, assignAdsGroup, getSiblingClusters, addAdsGroupFromCluster,
  reorderAdsGroups, getAdsCatalog, getAdsEvents, addAdsEvent, deleteAdsEvent,
} from '../api';
import DateRangePicker from '../components/DateRangePicker';
import './ads2.css';

// ─────────────────────────────────────────────────────────────────────────
// Новая страница «Реклама» (Defly, Ozon). Старая (AdsStats.jsx) остаётся
// доступной кнопкой «Старый вид», пока новая не согласована.
//
// Данные — тот же GET /api/ads/stats (?compare=1 — плюс итоги прошлого
// периода той же длины для «лучше/хуже»). Переключатель «Только реклама»
// подменяет показы/переходы/заказы общей аналитики товара на цифры самих
// рекламных кампаний (adViews/clicks/adOrders/adRevenue).
// ─────────────────────────────────────────────────────────────────────────

const fmtInt = v => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Math.round(v).toLocaleString('ru-RU');
const fmtMoney2 = v => v ? v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const fmtPct = v => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : v.toFixed(1).replace('.', ',') + '%';
function fmtBy(v, fmt) {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '—';
  switch (fmt) {
    case 'money': case 'int': return fmtInt(v);
    case 'money0': return v ? fmtInt(v) : '—';
    case 'money2': return fmtMoney2(v);
    case 'pct': return fmtPct(v);
    case 'pos': return v.toFixed(1).replace('.', ',');
    default: return String(v);
  }
}
function heatColor(v, min, max, direction) {
  if (v === null || v === undefined || max === min || direction === 'neutral') return 'transparent';
  let t = (v - min) / (max - min);
  if (direction === 'down') t = 1 - t;
  t = Math.max(0, Math.min(1, t));
  return `hsla(${120 * t}, 62%, 42%, 0.32)`;
}
function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const pa = String(a || '').match(re) || [], pb = String(b || '').match(re) || [];
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
// "Чехлы на сиденья Renault Duster (HS), 2010-2015..." → "Renault Duster (HS)"
function shortModel(name) {
  if (!name) return '';
  const s = String(name);
  // Всё после "для"/"на сиденья": первая часть до запятой — марка и модель;
  // следующие части добавляем, только если это номера моделей (ВАЗ 2109,
  // 21099, 2114, 2115), годы и комплектации отбрасываем.
  const m = s.match(/(?:^|\s)(?:для|на сиденья)\s+(.+)$/i);
  if (m) {
    const parts = m[1].split(',').map(x => x.trim());
    const out = [parts[0]];
    for (const p of parts.slice(1)) { if (/^\d{3,5}$/.test(p)) out.push(p); else break; }
    return out.join(', ');
  }
  return s.replace(/^Утеплитель двигателя,\s*автоодеяло\s*/i, '').slice(0, 40);
}
const isCpoCampaign = c => String(c.paymentType || '').toUpperCase() === 'CPO';
function cpoText(cpo) {
  if (!cpo) return 'нет данных';
  if (!cpo.available) return 'недоступна для товара';
  if (!cpo.enabled) return 'выключена';
  const bid = cpo.bidPct !== null ? `${String(cpo.bidPct).replace('.', ',')}%` : '';
  const rub = cpo.bidRub ? ` (${fmtInt(cpo.bidRub)} ₽)` : '';
  return `включена${bid ? ` · ставка ${bid}${rub}` : ''}`;
}
const drrClass = v => v === null || v === undefined || !Number.isFinite(v) ? 'm' : v < 15 ? 'g' : v <= 30 ? 'w' : 'b';

// ── Модель: сырые суммы по дням для одного артикула или группы ─────────
const RAW_KEYS = ['views', 'pdpViews', 'cart', 'orders', 'revenue', 'spend', 'spendCpc', 'spendCpo', 'clicks', 'adViews', 'adOrders', 'adRevenue',
  'spendSearch', 'clicksSearch', 'spendRec', 'clicksRec'];
const zoneRaw = d => ({ spendSearch: d.spendSearch || 0, clicksSearch: d.clicksSearch || 0, spendRec: d.spendRec || 0, clicksRec: d.clicksRec || 0 });

// Значения дня с учётом режима: "all" — общая аналитика товара, "ads" —
// только то, что Ozon отнёс к рекламе (корзин в рекламной статистике нет).
function dayRaw(day, mode) {
  const d = day || {};
  if (mode === 'ads') {
    return {
      views: d.adViews || 0, pdpViews: d.clicks || 0, cart: d.adToCart ?? null, orders: d.adOrders || 0, revenue: d.adRevenue || 0,
      spend: d.spend || 0, spendCpc: d.spendCpc || 0, spendCpo: d.spendCpo || 0, clicks: d.clicks || 0, ...zoneRaw(d),
    };
  }
  return {
    views: d.views || 0, pdpViews: d.pdpViews || 0, cart: d.cart || 0, orders: d.orders || 0, revenue: d.revenue || 0,
    spend: d.spend || 0, spendCpc: d.spendCpc || 0, spendCpo: d.spendCpo || 0, clicks: d.clicks || 0, ...zoneRaw(d),
  };
}
function derive(r, mode) {
  const out = { ...r };
  out.ctr = r.views > 0 ? r.pdpViews / r.views * 100 : null;
  if (mode === 'ads' && (r.cart === null || r.cart === undefined)) {
    // Корзин из рекламы нет (статистика по товарам ещё не пришла) — считаем клик → заказ.
    out.crToCart = null;
    out.crToOrder = r.pdpViews > 0 ? r.orders / r.pdpViews * 100 : null;
  } else {
    out.crToCart = r.pdpViews > 0 ? r.cart / r.pdpViews * 100 : null;
    out.crToOrder = r.cart > 0 ? r.orders / r.cart * 100 : null;
  }
  out.drr = r.revenue > 0 ? r.spend / r.revenue * 100 : null;
  // Средняя цена клика: общая и отдельно по зонам (в поиске ставка выше,
  // в "поиск + рекомендации" ниже). Расход за заказ в цену клика не входит.
  out.avgCpc = r.clicks > 0 ? (r.spendCpc || r.spend) / r.clicks : null;
  out.avgCpcSearch = r.clicksSearch > 0 ? r.spendSearch / r.clicksSearch : null;
  out.avgCpcRec = r.clicksRec > 0 ? r.spendRec / r.clicksRec : null;
  return out;
}
function sumRaw(list) {
  const t = {};
  for (const k of RAW_KEYS) t[k] = 0;
  let cartKnown = false;
  for (const r of list) {
    for (const k of RAW_KEYS) {
      if (k === 'cart') { if (r.cart !== null && r.cart !== undefined) { t.cart += r.cart; cartKnown = true; } }
      else t[k] += r[k] || 0;
    }
  }
  if (!cartKnown) t.cart = null;
  return t;
}
// Модель по набору артикулов: byDate (с производными), totals, prev.
function buildModel(articles, dates, mode) {
  const byDate = {};
  for (const d of dates) {
    const raw = sumRaw(articles.map(a => dayRaw(a.byDate[d], mode)));
    let stock = 0, stockKnown = false, posSum = 0, posN = 0;
    for (const a of articles) {
      const s = a.byDate[d]?.stock;
      if (s !== null && s !== undefined) { stock += s; stockKnown = true; }
      const p = a.byDate[d]?.position;
      if (articles.length === 1 && p !== null && p !== undefined) { posSum += p; posN++; }
    }
    byDate[d] = { ...derive(raw, mode), stock: stockKnown ? stock : null, position: posN ? posSum / posN : null };
    if (articles.length === 1) {
      const src = articles[0].byDate[d] || {};
      byDate[d].manual = src.manual || {};
      if (mode === 'all') byDate[d].avgCpc = src.avgCpc || (raw.clicks > 0 ? raw.spend / raw.clicks : null);
    }
  }
  const totals = derive(sumRaw(dates.map(d => byDate[d])), mode);
  const prevList = articles.filter(a => a.prevTotals).map(a => {
    const p = a.prevTotals;
    return mode === 'ads'
      ? { views: p.adViews, pdpViews: p.clicks, cart: null, orders: p.adOrders, revenue: p.adRevenue, spend: p.spend, clicks: p.clicks }
      : { views: p.views, pdpViews: p.pdpViews, cart: p.cart, orders: p.orders, revenue: p.revenue, spend: p.spend, clicks: p.clicks };
  });
  const prev = prevList.length ? derive(sumRaw(prevList), mode) : null;
  const stockNow = articles.reduce((s, a) => s + (a.stock ? (a.stock.fboPresent || 0) + (a.stock.fbsPresent || 0) : 0), 0);
  const hasStock = articles.some(a => a.stock);
  return { byDate, totals, prev, stockNow: hasStock ? stockNow : null };
}

function changePct(cur, prev) {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return null;
  if (prev === 0) return cur === 0 ? 0 : null;
  return (cur - prev) / prev * 100;
}
function Delta({ value, unit = '%', goodWhen = 'up', title }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const flat = Math.abs(value) < 0.5;
  const cls = goodWhen === 'neutral' || flat ? 'flat' : (value > 0) === (goodWhen === 'up') ? 'good' : 'bad';
  // Рост больше чем в 4 раза (новый товар, сезон) — "в N раз" читается лучше, чем "+5004%".
  const txt = unit === 'pp' ? `${Math.abs(value).toFixed(1).replace('.', ',')} п.п.`
    : value > 300 ? `в ${Math.round(1 + value / 100)} раз` : `${Math.abs(value).toFixed(0)}%`;
  return <span className={`delta ${cls}`} title={title}>{flat ? '•' : value > 0 ? '▲' : '▼'} {txt}</span>;
}

// ── Мелкие графики ────────────────────────────────────────────────────────
function AreaSpark({ values, color }) {
  const w = 240, h = 34;
  const vals = values.map(v => (v === null || !Number.isFinite(v)) ? 0 : v);
  const max = Math.max(...vals) || 1;
  const pts = vals.map((v, i) => [vals.length > 1 ? i / (vals.length - 1) * w : 0, h - 2 - (v / max) * (h - 6)]);
  if (!pts.length) return null;
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${line}L${w},${h}L0,${h}Z`} fill={color} opacity=".12" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="2.5" fill={color} />
    </svg>
  );
}
function SparkBars({ values, w = 96, h = 24 }) {
  const n = values.length || 1, max = Math.max(1, ...values), bw = w / n;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" style={{ display: 'block', marginLeft: 'auto' }}>
      {values.map((v, i) => {
        const bh = v ? Math.max(2, v / max * (h - 2)) : 1;
        return <rect key={i} x={(i * bw + 0.4).toFixed(1)} y={(h - bh).toFixed(1)} width={Math.max(1, bw - 1.4).toFixed(1)}
          height={bh.toFixed(1)} rx="1" fill={v ? 'var(--a-accent)' : 'var(--a-line2)'} opacity={i >= n - 7 ? 1 : 0.55} />;
      })}
    </svg>
  );
}

// ── Общая всплывашка ──────────────────────────────────────────────────────
function useTip() {
  const [tip, setTip] = useState(null);
  const show = useCallback((e, content) => setTip({ x: e.clientX + 14, y: e.clientY + 14, content }), []);
  const hide = useCallback(() => setTip(null), []);
  const node = tip ? <div className="a-tip" style={{ left: tip.x, top: tip.y }}>{tip.content}</div> : null;
  return { show, hide, node };
}

// ── График по дням: два показателя на выбор, у каждого своя шкала ────────
// Левая шкала — первый показатель, правая — второй (цвет подписей шкалы =
// цвет линии). Три вида на выбор: «столбцы + линия», «две линии» и «два
// графика друг под другом». Подписи значений — только у максимума,
// минимума и последнего дня (при коротком периоде — у всех точек), чтобы
// график не превращался в кашу; остальное — во всплывашке.
const CHART_METRICS = [
  { key: 'revenue', label: 'Заказано, ₽', fmt: 'int' },
  { key: 'orders', label: 'Заказы, шт', fmt: 'int' },
  { key: 'stock', label: 'Остаток, шт', fmt: 'int' },
  { key: 'position', label: 'Позиция в поиске', fmt: 'pos', free: true },
  { key: 'views', label: 'Показы', fmt: 'int' },
  { key: 'pdpViews', label: 'Переходы / клики', fmt: 'int' },
  { key: 'cart', label: 'Корзины', fmt: 'int' },
  { key: 'ctr', label: 'CTR', fmt: 'pct' },
  { key: 'crToCart', label: 'CR в корзину', fmt: 'pct' },
  { key: 'crToOrder', label: 'CR в заказ', fmt: 'pct' },
  { key: 'avgCpc', label: 'Ср. цена клика, ₽', fmt: 'money2', free: true },
  { key: 'avgCpcSearch', label: 'Цена клика: поиск, ₽', fmt: 'money2', free: true },
  { key: 'avgCpcRec', label: 'Цена клика: поиск+рек., ₽', fmt: 'money2', free: true },
  { key: 'spend', label: 'Расход, ₽', fmt: 'int' },
  { key: 'spendCpc', label: 'Расход за клик, ₽', fmt: 'int' },
  { key: 'spendCpo', label: 'Расход за заказ, ₽', fmt: 'int' },
  { key: 'drr', label: 'ДРР', fmt: 'pct', free: true },
];
const CHART_STORE = 'mp-ads2-chart';
function shortNum(v, fmt) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  if (fmt === 'pct') return `${v.toFixed(v < 10 ? 1 : 0).replace('.', ',')}%`;
  if (fmt === 'money2' || fmt === 'pos') return v.toFixed(v < 100 ? 1 : 0).replace('.', ',');
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1).replace('.', ',')}м`;
  if (a >= 1e4) return `${Math.round(v / 1000)}к`;
  if (a >= 1000) return `${(v / 1000).toFixed(1).replace('.', ',')}к`;
  return String(Math.round(v));
}
function niceScale(min, max, free) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
  if (!free) min = Math.min(0, min);
  if (max === min) max = min + 1;
  const pad = (max - min) * (free ? 0.12 : 0.1);
  const lo = free ? Math.max(0, min - pad) : min, hi = max + pad;
  const raw = (hi - lo) / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(s => s >= raw) || raw;
  const start = Math.floor(lo / step) * step;
  const ticks = [start];
  while (ticks[ticks.length - 1] < hi - step * 0.001) ticks.push(+(ticks[ticks.length - 1] + step).toFixed(6));
  return { lo: ticks[0], hi: ticks[ticks.length - 1], ticks };
}
// Индексы точек, которые подписываем: max, min, последний; все — если точек мало.
function labelIdx(vals) {
  // Нули не подписываем — это шум (дни без заказов/расхода).
  const idx = vals.map((v, i) => [v, i]).filter(([v]) => v !== null && v !== undefined && Number.isFinite(v) && v !== 0);
  if (!idx.length) return new Set();
  if (vals.length <= 10) return new Set(idx.map(([, i]) => i));
  let mx = idx[0], mn = idx[0];
  for (const p of idx) { if (p[0] > mx[0]) mx = p; if (p[0] < mn[0]) mn = p; }
  return new Set([mx[1], mn[1], idx[idx.length - 1][1]]);
}

// Ширина контейнера — чтобы рисовать в реальных пикселях: иначе SVG
// растягивается и подписи становятся огромными.
function useWidth(ref, fallback) {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(entries => { const cw = entries[0]?.contentRect?.width; if (cw) setW(Math.round(cw)); });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function ChartPane({ dates, series, events, tip, height, showX, onHover, hoverIdx }) {
  // series: [{ key, label, fmt, color, kind: 'bar'|'line', side: 'left'|'right', values, scale }]
  const boxRef = useRef(null);
  const w = useWidth(boxRef, 680), h = height, pl = 48, pr = series.some(s => s.side === 'right') ? 48 : 12, pt = 26, pb = showX ? 22 : 8;
  const iw = w - pl - pr, ih = h - pt - pb, n = dates.length || 1, bw = iw / n;
  const x = i => pl + i * bw + bw / 2;
  const evByDate = {};
  for (const e of events) (evByDate[e.date] = evByDate[e.date] || []).push(e);
  const left = series.find(s => s.side === 'left'), right = series.find(s => s.side === 'right');
  const yOf = (s, v) => pt + ih - (v - s.scale.lo) / (s.scale.hi - s.scale.lo) * ih;
  const bars = series.filter(s => s.kind === 'bar');
  const xStep = Math.ceil(n / Math.max(2, Math.floor(iw / 70)));
  return (
    <div ref={boxRef} style={{ width: '100%' }}>
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" style={{ display: 'block' }} onMouseLeave={() => { tip.hide(); onHover(null); }}>
      {left && left.scale.ticks.map(v => (
        <g key={'l' + v}>
          <line x1={pl} x2={w - pr} y1={yOf(left, v)} y2={yOf(left, v)} stroke="var(--a-grid)" />
          <text x={pl - 6} y={yOf(left, v) + 3.5} textAnchor="end" fontSize="10" fill={left.color} fontFamily="JetBrains Mono, monospace">{shortNum(v, left.fmt)}</text>
        </g>
      ))}
      {right && right.scale.ticks.map(v => (
        <text key={'r' + v} x={w - pr + 6} y={yOf(right, v) + 3.5} fontSize="10" fill={right.color} fontFamily="JetBrains Mono, monospace">{shortNum(v, right.fmt)}</text>
      ))}
      {hoverIdx !== null && hoverIdx !== undefined && <rect x={pl + hoverIdx * bw} y={pt} width={bw} height={ih} fill="var(--a-accent-soft)" />}
      {bars.map((s, bi) => s.values.map((v, i) => {
        if (v === null || v === undefined || !v) return null;
        const y0 = yOf(s, Math.max(0, s.scale.lo)), y1 = yOf(s, v);
        const width = Math.max(1, (bw - 4) / bars.length);
        return <rect key={s.key + i} x={pl + i * bw + 2 + bi * width} y={Math.min(y0, y1)} width={width} height={Math.abs(y0 - y1)} rx="3" fill={s.color} opacity=".8" />;
      }))}
      {series.filter(s => s.kind === 'line').map(s => {
        let d = '', pen = false;
        s.values.forEach((v, i) => {
          if (v === null || v === undefined || !Number.isFinite(v)) { pen = false; return; }
          d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${yOf(s, v).toFixed(1)}`; pen = true;
        });
        return (
          <g key={s.key}>
            <path d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" />
            {s.values.map((v, i) => (v === null || v === undefined || !Number.isFinite(v)) ? null
              : <circle key={i} cx={x(i)} cy={yOf(s, v)} r={hoverIdx === i ? 4 : 2.4} fill={s.color} stroke="var(--a-panel)" strokeWidth="1.5" />)}
          </g>
        );
      })}
      {/* Подписи значений: max / min / последний */}
      {series.map((s, si) => {
        const keep = labelIdx(s.values);
        return s.values.map((v, i) => {
          if (!keep.has(i)) return null;
          const y = yOf(s, v);
          const above = s.kind === 'bar' || si === 0;
          return (
            <text key={'t' + s.key + i} x={x(i)} y={above ? y - 7 : y + 14} textAnchor="middle" fontSize="10" fontWeight="600"
              fill={s.color} fontFamily="JetBrains Mono, monospace" paintOrder="stroke" stroke="var(--a-panel)" strokeWidth="3">
              {shortNum(v, s.fmt)}
            </text>
          );
        });
      })}
      {dates.map((d, i) => evByDate[d] ? (
        <g key={'e' + d}>
          <line x1={x(i)} x2={x(i)} y1={pt - 8} y2={pt + ih} stroke="var(--a-accent)" strokeDasharray="3 3" opacity=".6" />
          <circle cx={x(i)} cy={pt - 8} r="4" fill="var(--a-accent)" stroke="var(--a-panel)" strokeWidth="1.5" />
        </g>
      ) : null)}
      {showX && dates.map((d, i) => ((i % xStep === 0 && n - 1 - i >= xStep / 2) || i === n - 1) ? (
        <text key={'x' + d} x={x(i)} y={h - 6} textAnchor="middle" fontSize="10" fill="var(--a-ink3)" fontFamily="JetBrains Mono, monospace">{d.slice(8)}.{d.slice(5, 7)}</text>
      ) : null)}
      {dates.map((d, i) => (
        <rect key={'h' + d} x={pl + i * bw} y={0} width={bw} height={h} fill="transparent"
          onMouseMove={e => {
            onHover(i);
            tip.show(e, (
              <div>
                <div style={{ color: 'var(--a-ink3)', marginBottom: 3 }}>{dayjs(d).format('DD.MM.YYYY')}</div>
                {series.map(s => <div key={s.key}><span style={{ color: s.color }}>●</span> {s.label}: <b>{fmtBy(s.values[i], s.fmt)}</b></div>)}
                {(evByDate[d] || []).map(e => <div key={e.id} style={{ marginTop: 4, color: 'var(--a-accent)' }}>● {e.text}</div>)}
              </div>
            ));
          }} />
      ))}
    </svg>
    </div>
  );
}

function DualChart({ dates, byDate, events, tip, mode }) {
  const [cfg, setCfg] = useState(() => {
    try { return { left: 'revenue', right: 'spend', type: 'combo', ...JSON.parse(localStorage.getItem(CHART_STORE) || '{}') }; }
    catch (e) { return { left: 'revenue', right: 'spend', type: 'combo' }; }
  });
  const [hover, setHover] = useState(null);
  useEffect(() => { try { localStorage.setItem(CHART_STORE, JSON.stringify(cfg)); } catch (e) { /* ignore */ } }, [cfg]);
  const metrics = CHART_METRICS.filter(m => !(mode === 'ads' && (m.key === 'position')));
  const mk = (key, side) => {
    const m = metrics.find(x => x.key === key) || metrics[0];
    const values = dates.map(d => { const v = byDate[d]?.[m.key]; return v === undefined ? null : v; });
    const nums = values.filter(v => v !== null && Number.isFinite(v));
    return {
      ...m, side, values,
      color: side === 'left' ? 'var(--a-rev)' : 'var(--a-spend)',
      kind: cfg.type === 'combo' && side === 'left' ? 'bar' : 'line',
      scale: niceScale(nums.length ? Math.min(...nums) : 0, nums.length ? Math.max(...nums) : 1, m.free),
    };
  };
  const L = mk(cfg.left, 'left');
  const R = cfg.right ? mk(cfg.right, 'right') : null;
  const pick = (side) => (
    <select className="a-sel" value={cfg[side] || ''} onChange={e => setCfg(c => ({ ...c, [side]: e.target.value || null }))}
      style={{ borderColor: side === 'left' ? 'var(--a-rev)' : 'var(--a-spend)', padding: '4px 8px', fontSize: 12.5 }}>
      {side === 'right' && <option value="">— без второго —</option>}
      {metrics.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
    </select>
  );
  return (
    <div>
      <div className="a-bar" style={{ marginBottom: 8, gap: 8 }}>
        <span className="a-hint">Слева</span>{pick('left')}
        <span className="a-hint">справа</span>{pick('right')}
        <span className="a-seg" style={{ marginLeft: 'auto' }}>
          {[['combo', 'Столбцы + линия'], ['lines', 'Две линии'], ['split', 'Два графика']].map(([v, l]) => (
            <button key={v} type="button" className={cfg.type === v ? 'on' : ''} onClick={() => setCfg(c => ({ ...c, type: v }))}>{l}</button>
          ))}
        </span>
      </div>
      {cfg.type === 'split' && R ? (
        <>
          <ChartPane dates={dates} series={[{ ...L, kind: 'bar' }]} events={events} tip={tip} height={130} showX={false} onHover={setHover} hoverIdx={hover} />
          <ChartPane dates={dates} series={[{ ...R, side: 'left', kind: 'line' }]} events={[]} tip={tip} height={140} showX onHover={setHover} hoverIdx={hover} />
        </>
      ) : (
        <ChartPane dates={dates} series={R ? [L, R] : [L]} events={events} tip={tip} height={230} showX onHover={setHover} hoverIdx={hover} />
      )}
    </div>
  );
}

// ── Воронка с динамикой к прошлому периоду ───────────────────────────────
function Funnel({ totals, prev, mode }) {
  const steps = mode === 'ads'
    ? (totals.cart !== null && totals.cart !== undefined
      ? [['Показы рекламы', 'views'], ['Клики', 'pdpViews'], ['Корзины с рекламы', 'cart'], ['Заказы с рекламы', 'orders']]
      : [['Показы рекламы', 'views'], ['Клики', 'pdpViews'], ['Заказы с рекламы', 'orders']])
    : [['Показы', 'views'], ['Переходы', 'pdpViews'], ['Корзины', 'cart'], ['Заказы', 'orders']];
  const first = totals[steps[0][1]] || 1;
  return (
    <div className="a-funnel">
      {steps.map(([label, k], i) => {
        const v = totals[k];
        const pk = i ? steps[i - 1][1] : null;
        const conv = i && totals[pk] > 0 && v !== null ? v / totals[pk] * 100 : null;
        const pconv = i && prev && prev[pk] > 0 && prev[k] !== null ? prev[k] / prev[pk] * 100 : null;
        return (
          <div key={k} className="a-fstep">
            <div>
              <div className="lab">{label}<b>{fmtInt(v)}</b></div>
              <div className="a-fbar"><div style={{ width: `${Math.max(2, Math.sqrt((v || 0) / first) * 100)}%` }} /></div>
            </div>
            <span><Delta value={prev ? changePct(v, prev[k]) : null} title="Изменение количества к прошлому периоду той же длины" /></span>
            <span className="a-fconv">{conv !== null ? fmtPct(conv) : ''}</span>
            <span>{conv !== null && pconv !== null ? <Delta value={conv - pconv} unit="pp" title={`Конверсия в прошлом периоде: ${fmtPct(pconv)}`} /> : null}</span>
          </div>
        );
      })}
      <div className="a-hint">Рядом с количеством — его изменение к прошлому периоду той же длины; справа — конверсия из предыдущего шага и её изменение.</div>
    </div>
  );
}

// ── Таблица по дням: все метрики, цвета по строкам (как раньше) ──────────
const DAY_ROWS = [
  { block: 'Заказы и остаток', tone: 'rev' },
  { key: 'revenue', label: 'Заказы, ₽', fmt: 'money', good: 'up', editable: true },
  { key: 'orders', label: 'Заказы, шт', fmt: 'int', good: 'up', editable: true },
  { key: 'stock', label: 'Остаток, шт', fmt: 'int', good: 'up', total: 'last' },
  { block: 'Трафик и позиции', tone: 'traffic' },
  { key: 'position', label: 'Позиция в поиске', fmt: 'pos', good: 'down', editable: true, total: 'avg', onlyAll: true },
  { key: 'views', label: 'Показы', fmt: 'int', good: 'up', editable: true },
  { key: 'pdpViews', label: 'Клики (переходы на карточку)', adsLabel: 'Клики', fmt: 'int', good: 'up', editable: true },
  { key: 'cart', label: 'Корзины', fmt: 'int', good: 'up', editable: true },
  { block: 'Конверсии', tone: 'conv' },
  { key: 'ctr', label: 'CTR (клик / показ)', fmt: 'pct', good: 'up' },
  { key: 'crToCart', label: 'CR в корзину', fmt: 'pct', good: 'up' },
  { key: 'crToOrder', label: 'CR в заказ', fmt: 'pct', good: 'up' },
  { block: 'Расход и ДРР', tone: 'spend' },
  { key: 'avgCpc', label: 'Ср. цена клика, ₽', fmt: 'money2', good: 'down', editable: true },
  { key: 'avgCpcSearch', label: 'поиск', fmt: 'money2', good: 'down', sub: true, ratio: ['spendSearch', 'clicksSearch'] },
  { key: 'avgCpcRec', label: 'поиск + рекомендации', fmt: 'money2', good: 'down', sub: true, ratio: ['spendRec', 'clicksRec'] },
  { key: 'spend', label: 'Расход общий, ₽', fmt: 'money0', good: 'up', editable: true },
  { key: 'spendCpc', label: 'оплата за клик', fmt: 'money0', good: 'up', sub: true },
  { key: 'spendCpo', label: 'оплата за заказ', fmt: 'money0', good: 'up', sub: true },
  { key: 'drr', label: 'ДРР', fmt: 'pct', good: 'down' },
];

function rowTotal(row, byDate, dates, totals) {
  if (row.ratio) {
    const [num, den] = row.ratio;
    const n = dates.reduce((acc, d) => acc + (byDate[d]?.[num] || 0), 0);
    const dd = dates.reduce((acc, d) => acc + (byDate[d]?.[den] || 0), 0);
    return dd > 0 ? n / dd : null;
  }
  if (row.total === 'last') {
    for (let i = dates.length - 1; i >= 0; i--) { const v = byDate[dates[i]]?.[row.key]; if (v !== null && v !== undefined) return v; }
    return null;
  }
  if (row.total === 'avg') {
    const vs = dates.map(d => byDate[d]?.[row.key]).filter(v => v !== null && v !== undefined);
    return vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : null;
  }
  return totals[row.key];
}

function EditCell({ value, fmt, bg, manual, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  if (editing) {
    return (
      <td style={{ background: bg }}>
        <input autoFocus type="number" min="0" value={draft} onChange={e => setDraft(e.target.value)}
          onBlur={() => { setEditing(false); if (draft !== String(value ?? '')) onSave(draft.trim() === '' ? null : draft.trim()); }}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setEditing(false); }} />
      </td>
    );
  }
  return (
    <td className="edit" style={{ background: bg }} title={manual ? 'Введено вручную — заменится данными Ozon, когда они появятся' : 'Нажмите, чтобы ввести вручную'}
      onClick={() => { setDraft(value !== null && value !== undefined ? String(value) : ''); setEditing(true); }}>
      {fmtBy(value, fmt)}{manual && <span className="mdot" />}
    </td>
  );
}

function DaysTable({ dates, model, mode, editable, onManualSave }) {
  const ref = useRef(null);
  const today = dayjs().format('YYYY-MM-DD');
  useEffect(() => { if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth; }, [dates.length]);
  const rows = DAY_ROWS.filter(r => r.block || !(mode === 'ads' && r.onlyAll));
  return (
    <div className="a-days" ref={ref}>
      <table className="a-dt">
        <thead>
          <tr>
            <th className="lbl">Метрика</th>
            <th className="tot">Итого</th>
            {dates.map(d => <th key={d} className={d === today ? 'today' : ''}>{d.slice(8)}.{d.slice(5, 7)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => {
            if (row.block) return <tr key={'b' + ri} className={`blk tone-${row.tone}`}><td colSpan={dates.length + 2}><span className="blk-l">{row.block}</span></td></tr>;
            const vals = dates.map(d => model.byDate[d]?.[row.key]);
            const nums = vals.filter(v => v !== null && v !== undefined && Number.isFinite(v));
            const min = nums.length ? Math.min(...nums) : 0, max = nums.length ? Math.max(...nums) : 0;
            const label = mode === 'ads' && row.adsLabel ? row.adsLabel : row.label;
            return (
              <tr key={row.key} className={row.sub ? 'sub' : ''}>
                <td className="lbl">{row.sub ? '— ' : ''}{label}</td>
                <td className="tot">{fmtBy(rowTotal(row, model.byDate, dates, model.totals), row.fmt)}</td>
                {vals.map((v, i) => {
                  const d = dates[i];
                  const bg = heatColor(v, min, max, row.good);
                  if (row.key === 'drr' && (v === null || v === undefined)) {
                    const spent = model.byDate[d]?.spend > 0;
                    return <td key={d} style={{ color: 'var(--a-ink3)' }} title={spent ? 'Был расход, заказов не было' : ''}>{spent ? '×' : '—'}</td>;
                  }
                  if (editable && row.editable && onManualSave) {
                    return <EditCell key={d} value={v} fmt={row.fmt} bg={bg} manual={!!model.byDate[d]?.manual?.[row.key]}
                      onSave={val => onManualSave(d, row.key, val)} />;
                  }
                  return <td key={d} style={{ background: bg }}>{fmtBy(v, row.fmt)}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Журнал изменений ──────────────────────────────────────────────────────
function Journal({ events, offerId, onAdd, onDelete }) {
  const [text, setText] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [saving, setSaving] = useState(false);
  async function submit(e) {
    e.preventDefault();
    if (!text.trim()) return;
    setSaving(true);
    try { await onAdd(offerId, date, text.trim()); setText(''); } finally { setSaving(false); }
  }
  return (
    <div>
      <div className="a-journal">
        {events.length === 0 && <div className="a-hint">Пока нет записей. Добавьте заметку: «снизил ставку до 20 ₽», «сменил главное фото»…</div>}
        {events.map(e => (
          <div key={e.id} className="a-ev">
            <span className="dt">{e.date.slice(8)}.{e.date.slice(5, 7)}</span>
            <span>{e.auto && <span className="auto">авто</span>}{e.text}</span>
            {!e.auto && <button type="button" className="a-rm" title="Удалить заметку" onClick={() => onDelete(e.id)}>×</button>}
          </div>
        ))}
      </div>
      <form className="a-addnote" onSubmit={submit}>
        <input className="a-input n" type="date" value={date} onChange={e => setDate(e.target.value)} style={{ flex: '0 0 auto', minWidth: 0 }} />
        <input className="a-input" value={text} onChange={e => setText(e.target.value)} placeholder="Что сделали: снизил ставку, сменил фото…" />
        <button type="submit" className="a-btn" disabled={saving || !text.trim()}>Добавить</button>
      </form>
      <div className="a-hint" style={{ marginTop: 8 }}>Изменения ставок (за клик и за заказ) и включение/выключение оплаты за заказ появляются здесь сами с пометкой «авто» — кто бы их ни менял: вы в кабинете Ozon или автостратегия.</div>
    </div>
  );
}

function CampaignsTable({ campaigns }) {
  const sorted = [...campaigns].sort((a, b) => b.totalSpend - a.totalSpend);
  return (
    <div style={{ maxHeight: 260, overflowY: 'auto' }}>
      <table className="a-campaigns">
        <thead><tr><th>Кампания</th><th>Статус</th><th>Оплата</th><th>Цена клика</th><th>Расход, ₽</th></tr></thead>
        <tbody>
          {sorted.map(c => (
            <tr key={c.campaignId}>
              <td>{c.title || c.campaignId}{c.splitAcross > 1 && <span className="a-approx" title={`Расход поделён поровну на ${c.splitAcross} артикула`}>÷{c.splitAcross}</span>}</td>
              <td><span className={`tag ${c.state === 'CAMPAIGN_STATE_RUNNING' ? 'on' : 'off'}`}>{c.state === 'CAMPAIGN_STATE_RUNNING' ? 'активна' : 'выкл.'}</span></td>
              <td>{isCpoCampaign(c) ? 'за заказ' : 'за клик'}</td>
              <td className="n">{fmtMoney2(c.avgCpc)}</td>
              <td className="n">{fmtInt(c.totalSpend)}</td>
            </tr>
          ))}
          {!sorted.length && <tr><td colSpan={5} style={{ color: 'var(--a-ink3)' }}>Своих рекламных кампаний нет</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function AssociatedTable({ associated, dates }) {
  const [unit, setUnit] = useState('orders');
  if (!associated?.length) return null;
  const fmt = unit === 'revenue' ? 'money0' : 'int';
  return (
    <div className="a-box wide">
      <h4>Остальные артикулы склейки
        <span className="a-seg" style={{ fontWeight: 400 }}>
          <button type="button" className={unit === 'orders' ? 'on' : ''} onClick={() => setUnit('orders')}>Шт</button>
          <button type="button" className={unit === 'revenue' ? 'on' : ''} onClick={() => setUnit('revenue')}>₽</button>
        </span>
      </h4>
      <div className="a-days">
        <table className="a-dt">
          <thead><tr><th className="lbl">Артикул</th><th className="tot">Итого</th>{dates.map(d => <th key={d}>{d.slice(8)}.{d.slice(5, 7)}</th>)}</tr></thead>
          <tbody>
            {associated.map(a => (
              <tr key={a.offerId}>
                <td className="lbl">{a.offerId} <span style={{ color: 'var(--a-ink3)', fontSize: 11 }}>{shortModel(a.productName)}</span></td>
                <td className="tot">{fmtBy(a.totals[unit], fmt)}</td>
                {dates.map(d => <td key={d}>{fmtBy(a.byDate[d]?.[unit], fmt)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Раскрытая строка артикула (или группы целиком) ───────────────────────
function Detail({ articles, dates, mode, events, isAggregate, onManualSave, onAddNote, onDeleteNote, groups, currentGroupId, onAssignGroup, tip, showAssoc, associated, activeGroupId }) {
  const [editMode, setEditMode] = useState(false);
  const [showCampaigns, setShowCampaigns] = useState(false);
  const model = useMemo(() => buildModel(articles, dates, mode), [articles, dates, mode]);
  const a = articles[0];
  const offerId = isAggregate ? null : a?.offerId;
  const campaigns = useMemo(() => articles.flatMap(x => x.campaigns), [articles]);
  const offerSet = new Set(articles.map(x => x.offerId));
  const myEvents = events.filter(e => isAggregate ? (!e.offerId || offerSet.has(e.offerId)) : e.offerId === offerId);
  const t = model.totals;
  const sumT = k => articles.reduce((s, x) => s + (x.totals[k] || 0), 0);
  const adDrr = sumT('adRevenue') > 0 ? sumT('spend') / sumT('adRevenue') * 100 : null;
  const adCtr = sumT('adViews') > 0 ? sumT('clicks') / sumT('adViews') * 100 : null;
  const assocList = associated || [];
  const assocOrders = assocList.reduce((s, x) => s + (x.totals.orders || 0), 0);
  const assocRevenue = assocList.reduce((s, x) => s + (x.totals.revenue || 0), 0);
  const perDay = dates.length ? t.orders / dates.length : null;
  return (
    <div className="a-dwrap">
      <div className="a-box wide">
        <h4>Динамика по дням
          <span className="a-legend"><span><i style={{ background: 'var(--a-accent)', borderRadius: '50%' }} />запись журнала</span></span>
        </h4>
        <DualChart dates={dates} byDate={model.byDate} events={myEvents} tip={tip} mode={mode} />
      </div>
      <div className="a-box">
        <h4>Воронка за период {mode === 'ads' && <span className="tag off">только реклама</span>}</h4>
        <Funnel totals={t} prev={model.prev} mode={mode} />
        <div className="a-kv">
          <span>Заказов в день (в среднем)</span><b className="n">{perDay === null ? '—' : perDay.toFixed(perDay < 10 ? 1 : 0).replace('.', ',')}</b>
          {showAssoc && <><span>+ по склейке</span><b className="n">{fmtInt(assocOrders)} шт · {fmtInt(assocRevenue)} ₽</b></>}
          {showAssoc && <><span>Итого со склейкой</span><b className="n">{fmtInt(t.orders + assocOrders)} шт · {fmtInt(t.revenue + assocRevenue)} ₽</b></>}
          <span>Расход за клик</span><b className="n">{fmtInt(t.spendCpc)} ₽</b>
          <span>Расход за заказ</span><b className="n">{t.spendCpo ? `${fmtInt(t.spendCpo)} ₽` : '—'}</b>
          <span>Ср. цена клика: поиск / поиск+рек.</span>
          <b className="n">{fmtMoney2(t.avgCpcSearch)} / {fmtMoney2(t.avgCpcRec)}</b>
          <span>Рекламный ДРР</span><b className="n">{fmtPct(adDrr)}</b>
          <span>CTR рекламы</span><b className="n">{fmtPct(adCtr)}</b>
          <span>Оплата за заказ (ОЗЗ)</span><span>{cpoText(isAggregate ? null : a?.cpo)}</span>
          {!isAggregate && offerId && groups && (
            <>
              <span>Группа</span>
              <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <select className="a-sel" value={currentGroupId || ''} onChange={e => onAssignGroup(offerId, e.target.value || null)} style={{ padding: '3px 6px', fontSize: 12 }}>
                  <option value="">Без группы</option>
                  {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                {activeGroupId && currentGroupId === activeGroupId && (
                  <button type="button" className="a-btn" style={{ padding: '3px 9px', fontSize: 12 }} onClick={() => onAssignGroup(offerId, null)}>Убрать из группы</button>
                )}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="a-box">
        <h4>Журнал изменений</h4>
        <Journal events={myEvents} offerId={offerId} onAdd={onAddNote} onDelete={onDeleteNote} />
      </div>
      <div className="a-box wide">
        <h4>По дням
          <span className="a-hint">свежие дни справа · «×» — был расход, заказов не было</span>
          {!isAggregate && mode === 'all' && (
            <button type="button" className="a-toggle" style={{ marginLeft: 'auto' }} onClick={() => setEditMode(v => !v)}>
              <span className={`a-sw ${editMode ? 'on' : ''}`} />Режим правки
            </button>
          )}
        </h4>
        <DaysTable dates={dates} model={model} mode={mode} editable={editMode && !isAggregate && mode === 'all'}
          onManualSave={offerId ? (d, k, v) => onManualSave(offerId, d, k, v) : null} />
      </div>
      <div className="a-box wide">
        <h4 style={{ cursor: 'pointer', marginBottom: showCampaigns ? 10 : 0 }} onClick={() => setShowCampaigns(v => !v)}>
          <span className="a-chev" style={{ transform: showCampaigns ? 'rotate(90deg)' : 'none' }}>▶</span>Кампании ({campaigns.length})
        </h4>
        {showCampaigns && <CampaignsTable campaigns={campaigns} />}
      </div>
      {showAssoc && <AssociatedTable associated={assocList} dates={dates} />}
    </div>
  );
}

// ── Матрица «артикулы × дни» с выбором метрики ───────────────────────────
const MATRIX_METRICS = [
  { key: 'orders', label: 'Заказы, шт', fmt: 'int', good: 'up' },
  { key: 'revenue', label: 'Заказано, ₽', fmt: 'money', good: 'up' },
  { key: 'spend', label: 'Расход, ₽', fmt: 'money0', good: 'up' },
  { key: 'drr', label: 'ДРР', fmt: 'pct', good: 'down' },
  { key: 'views', label: 'Показы', fmt: 'int', good: 'up' },
  { key: 'pdpViews', label: 'Переходы', fmt: 'int', good: 'up' },
  { key: 'cart', label: 'Корзины', fmt: 'int', good: 'up' },
  { key: 'ctr', label: 'CTR', fmt: 'pct', good: 'up' },
  { key: 'crToOrder', label: 'CR в заказ', fmt: 'pct', good: 'up' },
  { key: 'stock', label: 'Остаток', fmt: 'int', good: 'up' },
];
function Matrix({ rows, dates, mode }) {
  const [metric, setMetric] = useState('orders');
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth; }, [dates.length, rows.length]);
  const cfg = MATRIX_METRICS.find(m => m.key === metric);
  const models = useMemo(() => rows.map(a => ({ a, m: buildModel([a], dates, mode) })), [rows, dates, mode]);
  const all = useMemo(() => buildModel(rows, dates, mode), [rows, dates, mode]);
  const vals = [];
  for (const { m } of models) for (const d of dates) { const v = m.byDate[d]?.[metric]; if (v !== null && v !== undefined && Number.isFinite(v)) vals.push(v); }
  const min = vals.length ? Math.min(...vals) : 0, max = vals.length ? Math.max(...vals) : 0;
  const totalOf = m => metric === 'stock' ? m.stockNow : m.totals[metric];
  if (!rows.length) return null;
  return (
    <div className="a-card" style={{ padding: 14 }}>
      <div className="a-bar" style={{ marginBottom: 10 }}>
        <b style={{ fontSize: 14 }}>Артикулы по дням</b>
        <span className="a-seg">
          {MATRIX_METRICS.filter(m => !(mode === 'ads' && m.key === 'cart')).map(m => (
            <button key={m.key} type="button" className={metric === m.key ? 'on' : ''} onClick={() => setMetric(m.key)}>{m.label}</button>
          ))}
        </span>
      </div>
      <div className="a-days" ref={ref}>
        <table className="a-dt a-matrix">
          <thead><tr><th className="lbl">Артикул</th><th className="tot">Итого</th><th className="stk">Остаток</th>{dates.map(d => <th key={d}>{d.slice(8)}.{d.slice(5, 7)}</th>)}</tr></thead>
          <tbody>
            {models.map(({ a, m }) => (
              <tr key={a.offerId}>
                <td className="lbl">{a.offerId} <span style={{ color: 'var(--a-ink3)', fontSize: 11 }}>{shortModel(a.productName)}</span></td>
                <td className="tot">{fmtBy(totalOf(m), cfg.fmt)}</td>
                <td className="stk">{fmtInt(m.stockNow)}</td>
                {dates.map(d => {
                  const v = m.byDate[d]?.[metric];
                  return <td key={d} style={{ background: heatColor(v, min, max, cfg.good) }}>{fmtBy(v, cfg.fmt)}</td>;
                })}
              </tr>
            ))}
            <tr>
              <td className="lbl" style={{ fontWeight: 600, color: 'var(--a-ink)' }}>Итого</td>
              <td className="tot">{fmtBy(totalOf(all), cfg.fmt)}</td>
              <td className="stk" style={{ fontWeight: 600 }}>{fmtInt(all.stockNow)}</td>
              {dates.map(d => <td key={d} style={{ fontWeight: 600, background: 'var(--a-panel2)' }}>{fmtBy(all.byDate[d]?.[metric], cfg.fmt)}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Строка статуса данных ────────────────────────────────────────────────
const STATUS_PARTS = [['perf', 'Расход'], ['clicks', 'Клики'], ['analytics', 'Заказы и воронка'], ['stocks', 'Остатки']];
function agoText(iso) {
  if (!iso) return 'ещё не было';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} ч назад` : `${Math.floor(h / 24)} дн назад`;
}
function Freshness({ status }) {
  if (!status) return null;
  const byJob = new Map(status.jobs.map(j => [j.job, j]));
  let worst = 'ok', oldest = null;
  const lines = STATUS_PARTS.map(([job, label]) => {
    const j = byJob.get(job) || {};
    // Красный — только если УСПЕШНОГО сбора давно нет (3 интервала). Разовые
    // таймауты между успешными запусками — норма, они видны в подсказке.
    const age = j.lastSuccessAt ? Date.now() - new Date(j.lastSuccessAt).getTime() : Infinity;
    const limit = Math.max(3 * (j.everyMin || 30), 90) * 60000;
    const st = age > limit * 2 ? 'bad' : age > limit ? 'warn' : 'ok';
    if (st === 'bad' || (st === 'warn' && worst === 'ok')) worst = st;
    if (j.lastSuccessAt && (!oldest || new Date(j.lastSuccessAt) < new Date(oldest))) oldest = j.lastSuccessAt;
    return `${label}: ${agoText(j.lastSuccessAt)}${j.lastError && j.lastErrorAt && j.lastErrorAt > (j.lastSuccessAt || '') ? ' (последняя попытка — ошибка, повторится сама)' : ''}`;
  });
  return (
    <span className="a-fresh" title={lines.join('\n')}>
      <span className={`a-dot ${worst === 'ok' ? '' : worst}`} />
      {status.running ? 'Идёт сбор…' : worst === 'bad' ? 'Данные давно не обновлялись' : `Данные обновлены ${agoText(oldest)}`}
    </span>
  );
}

// ── Поиск артикула для добавления в группу ───────────────────────────────
function AddToGroup({ catalog, exclude, onPick }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const ex = new Set(exclude);
  const s = q.trim().toLowerCase();
  const res = s ? catalog.filter(a => !ex.has(a.offerId) && (a.offerId.toLowerCase().includes(s) || (a.productName || '').toLowerCase().includes(s))).slice(0, 30) : [];
  return (
    <div className="a-ac" style={{ marginLeft: 'auto' }}>
      <input className="a-input" value={q} placeholder="+ Добавить артикул в группу…" style={{ minWidth: 260 }}
        onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && s && (
        <div className="a-ac-list">
          {!res.length && <div className="a-ac-item" style={{ cursor: 'default' }}><span>Ничего не найдено</span></div>}
          {res.map(a => (
            <div key={a.offerId} className="a-ac-item" onMouseDown={() => { onPick(a.offerId); setQ(''); setOpen(false); }}>
              <b>{a.offerId}</b> <span>{(a.productName || '').slice(0, 60)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════
export default function AdsStats2({ cabinet }) {
  const [dateFrom, setDateFrom] = useState(dayjs().subtract(29, 'day').format('YYYY-MM-DD'));
  const [dateTo, setDateTo] = useState(dayjs().format('YYYY-MM-DD'));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [status, setStatus] = useState(null);
  const [mode, setMode] = useState('all');
  const [groupsData, setGroupsData] = useState({ groups: [], members: {} });
  const [manualOrder, setManualOrder] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [clusters, setClusters] = useState([]);
  const [events, setEvents] = useState([]);
  const [tab, setTab] = useState('all');
  const [sort, setSort] = useState({ key: 'spend', dir: -1 });
  const [search, setSearch] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const [payFilter, setPayFilter] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [dragKey, setDragKey] = useState(null);
  const [overKey, setOverKey] = useState(null);
  const [dragTab, setDragTab] = useState(null);
  const [overTab, setOverTab] = useState(null);
  const [newGroup, setNewGroup] = useState(null);
  // Склейка (ассоциированные заказы по остальным артикулам склейки) —
  // нужна редко, поэтому включается переключателем и не грузит страницу.
  const [showAssoc, setShowAssoc] = useState(false);
  const tip = useTip();

  const load = useCallback(() => {
    setLoading(true);
    getAdsStats(cabinet, { dateFrom, dateTo, compare: 1 })
      .then(r => setData(r.data.data))
      .catch(console.error)
      .finally(() => setLoading(false));
    getAdsEvents(cabinet, dayjs(dateFrom).subtract(1, 'day').format('YYYY-MM-DD'), dateTo)
      .then(r => setEvents(r.data.data || [])).catch(() => setEvents([]));
  }, [cabinet, dateFrom, dateTo]);
  useEffect(() => { load(); }, [load]);

  const loadStatus = useCallback(() => getAdsDataStatus(cabinet).then(r => { setStatus(r.data.data); return r.data.data; }).catch(() => null), [cabinet]);
  useEffect(() => { loadStatus(); const t = setInterval(loadStatus, 60000); return () => clearInterval(t); }, [loadStatus]);
  useEffect(() => {
    getAdsGroups(cabinet).then(r => setGroupsData(r.data.data || { groups: [], members: {} })).catch(() => {});
    getAdsOrder(cabinet).then(r => setManualOrder(r.data.data || [])).catch(() => {});
    getAdsCatalog(cabinet).then(r => setCatalog(r.data.data || [])).catch(() => {});
    getSiblingClusters(cabinet).then(r => setClusters(r.data.data || [])).catch(() => {});
  }, [cabinet]);

  const dates = data?.dates || [];
  const articlesRaw = useMemo(() => (data?.articles || []).filter(a => a.offerId), [data]);
  const groups = groupsData.groups;
  const members = groupsData.members;
  const activeGroup = tab !== 'all' ? groups.find(g => g.id === tab) : null;
  useEffect(() => { if (tab !== 'all' && !groups.find(g => g.id === tab)) setTab('all'); }, [groups, tab]);

  function selectTab(id) {
    setTab(id);
    setSort(id === 'all' ? { key: 'spend', dir: -1 } : { key: 'manual', dir: 1 });
  }

  // Видимые артикулы: вкладка-группа → фильтры → сортировка.
  const { rows, hiddenByFilter } = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = articlesRaw.filter(a => tab === 'all' ? a.campaigns.length > 0 : members[a.offerId] === tab);
    const before = list.length;
    list = list.filter(a => {
      if (q && !(a.offerId.toLowerCase().includes(q) || (a.productName || '').toLowerCase().includes(q)
        || a.campaigns.some(c => (c.title || '').toLowerCase().includes(q)))) return false;
      if (!onlyActive && !payFilter) return true;
      if (a.campaigns.length === 0) return tab !== 'all';
      return a.campaigns.some(c => (!onlyActive || c.state === 'CAMPAIGN_STATE_RUNNING')
        && (!payFilter || (payFilter === 'cpo') === isCpoCampaign(c)));
    });
    const orderIndex = new Map(manualOrder.map((id, i) => [id, i]));
    const val = (a) => {
      const t = a.totals;
      switch (sort.key) {
        case 'id': return a.offerId;
        case 'revenue': return mode === 'ads' ? t.adRevenue : t.revenue;
        case 'orders': return mode === 'ads' ? t.adOrders : t.orders;
        case 'stock': return a.stock ? a.stock.fboPresent + a.stock.fbsPresent : -1;
        case 'spend': return t.spend;
        case 'drr': { const r = mode === 'ads' ? t.adRevenue : t.revenue; return r > 0 ? t.spend / r * 100 : (t.spend > 0 ? 1e9 : -1); }
        default: return 0;
      }
    };
    if (sort.key === 'manual') {
      list.sort((x, y) => {
        const ix = orderIndex.has(x.offerId) ? orderIndex.get(x.offerId) : Infinity;
        const iy = orderIndex.has(y.offerId) ? orderIndex.get(y.offerId) : Infinity;
        return ix !== iy ? ix - iy : y.totals.spend - x.totals.spend;
      });
    } else {
      list.sort((x, y) => {
        const a = val(x), b = val(y);
        return typeof a === 'string' ? naturalCompare(a, b) * sort.dir : (a - b) * sort.dir;
      });
    }
    return { rows: list, hiddenByFilter: before - list.length };
  }, [articlesRaw, tab, members, search, onlyActive, payFilter, sort, manualOrder, mode]);

  const total = useMemo(() => buildModel(rows, dates, mode), [rows, dates, mode]);

  // ── действия ──
  async function handleCollect() {
    setCollecting(true);
    try {
      await collectAds(cabinet, Math.min(90, Math.max(7, dayjs().diff(dayjs(dateFrom), 'day') + 1)));
      const started = Date.now();
      await new Promise(r => setTimeout(r, 4000));
      while (Date.now() - started < 6 * 60000) {
        const st = await loadStatus();
        if (st && !st.running) break;
        await new Promise(r => setTimeout(r, 5000));
      }
      load();
    } finally { setCollecting(false); }
  }
  function toggleOpen(key) {
    setOpen(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function assignGroup(offerId, groupId) {
    setGroupsData(prev => {
      const m = { ...prev.members };
      if (groupId) m[offerId] = groupId; else delete m[offerId];
      return { ...prev, members: m };
    });
    assignAdsGroup(cabinet, offerId, groupId).catch(console.error);
  }
  function reorderRows(dragged, target) {
    if (!dragged || dragged === target) return;
    const orderIndex = new Map(manualOrder.map((id, i) => [id, i]));
    const all = [...new Set(articlesRaw.map(a => a.offerId))].sort((a, b) =>
      (orderIndex.has(a) ? orderIndex.get(a) : Infinity) - (orderIndex.has(b) ? orderIndex.get(b) : Infinity));
    // Порядок видимых строк задаёт относительный порядок; остальные артикулы
    // кабинета сохраняют свои места (как в старом виде).
    const visible = rows.map(r => r.offerId);
    const from = visible.indexOf(dragged), to = visible.indexOf(target);
    if (from === -1 || to === -1) return;
    const nextVisible = [...visible]; nextVisible.splice(from, 1); nextVisible.splice(to, 0, dragged);
    const slots = all.map((id, i) => visible.includes(id) ? i : -1).filter(i => i >= 0);
    const next = [...all];
    slots.forEach((slot, k) => { next[slot] = nextVisible[k]; });
    for (const id of nextVisible) if (!next.includes(id)) next.push(id);
    setManualOrder(next);
    saveAdsOrder(cabinet, next).catch(console.error);
  }
  function reorderTabs(dragged, target) {
    if (!dragged || dragged === target) return;
    const ids = groups.map(g => g.id);
    const from = ids.indexOf(dragged), to = ids.indexOf(target);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1); ids.splice(to, 0, dragged);
    const byId = new Map(groups.map(g => [g.id, g]));
    setGroupsData(prev => ({ ...prev, groups: ids.map(id => byId.get(id)) }));
    reorderAdsGroups(cabinet, ids).catch(console.error);
  }
  function removeGroup(id) {
    if (!window.confirm('Удалить группу? Артикулы останутся, просто станут «без группы».')) return;
    removeAdsGroup(cabinet, id).then(r => setGroupsData(r.data.data)).catch(console.error);
  }
  function createGroup(e) {
    e.preventDefault();
    const name = (newGroup || '').trim();
    if (!name) return;
    addAdsGroup(cabinet, name).then(r => { setGroupsData(r.data.data); setNewGroup(null); }).catch(err => window.alert(err.response?.data?.error || 'Не удалось создать группу'));
  }
  function createFromCluster(primary) {
    const c = clusters.find(x => x.primary === primary);
    if (!c) return;
    addAdsGroupFromCluster(cabinet, c.productName ? c.productName.slice(0, 40) : c.primary, c.members)
      .then(r => setGroupsData(r.data.data)).catch(err => window.alert(err.response?.data?.error || 'Не удалось создать группу'));
  }
  function manualSave(offerId, date, metric, value) {
    return saveManualAdsMetric(cabinet, offerId, date, metric, value).then(() => {
      setData(prev => prev && ({
        ...prev,
        articles: prev.articles.map(a => {
          if (a.offerId !== offerId) return a;
          const day = a.byDate[date] || {};
          const cleared = value === null || value === '';
          return { ...a, byDate: { ...a.byDate, [date]: { ...day, [metric]: cleared ? (metric === 'position' ? null : 0) : Number(value), manual: { ...day.manual, [metric]: !cleared } } } };
        }),
      }));
    }).catch(() => window.alert('Не удалось сохранить значение — попробуйте ещё раз.'));
  }
  async function addNote(offerId, date, text) {
    try {
      const r = await addAdsEvent(cabinet, offerId, date, text);
      setEvents(prev => [{ id: r.data.data.id, offerId, date, kind: 'note', text, auto: false }, ...prev].sort((x, y) => y.date.localeCompare(x.date)));
    } catch { window.alert('Не удалось сохранить заметку.'); }
  }
  function deleteNote(id) {
    setEvents(prev => prev.filter(e => e.id !== id));
    deleteAdsEvent(cabinet, id).catch(console.error);
  }

  if (loading && !data) return <div className="ads2"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Загрузка…</div></div>;

  // ── KPI ──
  const T = total.totals, P = total.prev;
  const lowStock = rows.filter(a => a.stock && ((a.stock.fboPresent + a.stock.fbsPresent) < 5 || (a.stockDays !== null && a.stockDays < 7))).length;
  const series = key => dates.map(d => total.byDate[d]?.[key] || 0);
  const drrSeries = dates.map((_, i) => {
    const from = Math.max(0, i - 6);
    let r = 0, s = 0;
    for (let k = from; k <= i; k++) { r += total.byDate[dates[k]]?.revenue || 0; s += total.byDate[dates[k]]?.spend || 0; }
    return r ? s / r * 100 : 0;
  });
  const isGroup = !!activeGroup;
  const dragEnabled = sort.key === 'manual';
  const memberIds = isGroup ? Object.entries(members).filter(([, g]) => g === tab).map(([id]) => id) : [];
  const ungroupedClusters = clusters.filter(c => {
    const gs = c.members.map(id => members[id]).filter(Boolean);
    return !gs.length || !gs.every(g => g === gs[0]) || gs.length < c.members.length;
  });
  const COLS = [
    { k: 'id', t: 'Артикул' }, { k: null, t: 'Заказы по дням' }, { k: 'revenue', t: 'Заказано, ₽' }, { k: 'orders', t: 'Заказы, шт' },
    { k: 'stock', t: 'Остаток, шт' }, { k: 'spend', t: 'Расход, ₽' }, { k: 'drr', t: 'ДРР' }, { k: null, t: 'ОЗЗ' }, { k: null, t: 'РК' },
  ];
  const clickSort = k => {
    if (!k) return;
    setSort(prev => prev.key === k ? { key: k, dir: -prev.dir } : { key: k, dir: k === 'id' ? 1 : -1 });
  };
  const aggKey = `__total_${tab}`;

  // "+N склейка · итого M" под числом заказов/выручки (при включённой склейке).
  function assocLine(list, key, own) {
    const extra = (list || []).reduce((acc, x) => acc + (x.totals[key] || 0), 0);
    if (!extra) return <span className="a-spendsub">склейка —</span>;
    return <span className="a-spendsub">+{fmtInt(extra)} склейка · итого {fmtInt(own + extra)}</span>;
  }
  // Склейка для всего списка: артикулы склеек, которых нет среди строк
  // (иначе их заказы посчитались бы дважды), каждый один раз.
  const assocForRows = (() => {
    const own = new Set(rows.map(r => r.offerId));
    const byId = new Map();
    for (const r of rows) for (const x of (r.associated || [])) if (!own.has(x.offerId)) byId.set(x.offerId, x);
    return [...byId.values()];
  })();

  function articleRow(a) {
    const key = a.offerId;
    const isOpen = open.has(key);
    const m = buildModel([a], dates, mode);
    const st = a.stock ? a.stock.fboPresent + a.stock.fbsPresent : null;
    const daysCls = st === null ? '' : (st < 5 || (a.stockDays !== null && a.stockDays < 7)) ? 'b' : (a.stockDays !== null && a.stockDays < 14) ? 'w' : '';
    const hasCpo = a.campaigns.some(isCpoCampaign);
    const split = a.campaigns.some(c => c.splitAcross > 1 && c.totalSpend > 0);
    return (
      <React.Fragment key={key}>
        <tr className={`row ${isOpen ? 'open' : ''} ${dragKey === key ? 'dragging' : ''} ${overKey === key && dragKey && dragKey !== key ? 'dropover' : ''}`}
          onClick={() => toggleOpen(key)}
          draggable={dragEnabled}
          onDragStart={dragEnabled ? () => setDragKey(key) : undefined}
          onDragOver={dragEnabled ? e => { e.preventDefault(); setOverKey(key); } : undefined}
          onDrop={dragEnabled ? e => { e.preventDefault(); reorderRows(dragKey, key); setDragKey(null); setOverKey(null); } : undefined}
          onDragEnd={dragEnabled ? () => { setDragKey(null); setOverKey(null); } : undefined}>
          <td>
            <div className="a-art">
              {dragEnabled && <span className="a-handle" title="Перетащите, чтобы поменять порядок">⠿</span>}
              <span className="a-chev">▶</span>
              <div style={{ minWidth: 0 }}>
                <div className="id">{a.offerId}</div>
                <div className="model" title={a.productName || ''}>{shortModel(a.productName)}</div>
              </div>
            </div>
          </td>
          <td><SparkBars values={dates.map(d => m.byDate[d]?.orders || 0)} /></td>
          <td className="n">{fmtInt(m.totals.revenue)}{showAssoc && assocLine(a.associated, 'revenue', m.totals.revenue)}</td>
          <td className="n">{fmtInt(m.totals.orders)}{showAssoc && assocLine(a.associated, 'orders', m.totals.orders)}</td>
          <td>
            <div className="a-stock">
              <span className="n">{fmtInt(st)}</span>
              <span className={`d ${daysCls}`}>{st === null ? 'нет данных' : st === 0 ? 'нет в наличии' : a.stockDays === null ? 'нет продаж' : `≈ ${Math.round(a.stockDays)} дн`}</span>
            </div>
          </td>
          <td className="n">
            {fmtInt(m.totals.spend)}{split && <span className="a-approx" title="Часть расхода — мультитоварная РК, поделена поровну между её артикулами">≈</span>}
            <span className="a-spendsub">клик {fmtInt(m.totals.spendCpc)} · заказ {m.totals.spendCpo ? fmtInt(m.totals.spendCpo) : '—'}</span>
          </td>
          <td><span className={`pill ${drrClass(m.totals.drr)}`}>{m.totals.drr === null ? (m.totals.spend > 0 ? '×' : '—') : fmtPct(m.totals.drr)}</span></td>
          <td>{a.cpo
            ? (a.cpo.enabled
              ? <span className="tag on" title={cpoText(a.cpo)}>вкл{a.cpo.bidPct !== null ? ` · ${String(a.cpo.bidPct).replace('.', ',')}%` : ''}</span>
              : <span className="tag off" title={cpoText(a.cpo)}>выкл</span>)
            : (hasCpo ? <span className="tag on">вкл</span> : <span className="tag off" title="Нет данных по оплате за заказ">—</span>)}</td>
          <td className="n muted">{a.campaigns.filter(c => c.state === 'CAMPAIGN_STATE_RUNNING').length}/{a.campaigns.length}</td>
        </tr>
        {isOpen && (
          <tr className="a-detail"><td colSpan={COLS.length}>
            <Detail articles={[a]} dates={dates} mode={mode} events={events} onManualSave={manualSave} onAddNote={addNote} onDeleteNote={deleteNote}
              groups={groups} currentGroupId={members[a.offerId]} onAssignGroup={assignGroup} tip={tip}
              showAssoc={showAssoc} associated={a.associated || []} activeGroupId={isGroup ? tab : null} />
          </td></tr>
        )}
      </React.Fragment>
    );
  }

  return (
    <div className="ads2">
      <div className="a-top">
        <h1>Реклама</h1>
        <span className="a-seg">
          {[7, 14, 30].map(n => {
            const f = dayjs().subtract(n - 1, 'day').format('YYYY-MM-DD');
            const on = dateFrom === f && dateTo === dayjs().format('YYYY-MM-DD');
            return <button key={n} type="button" className={on ? 'on' : ''} onClick={() => { setDateFrom(f); setDateTo(dayjs().format('YYYY-MM-DD')); }}>{n} дн</button>;
          })}
        </span>
        <DateRangePicker from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t); }} />
        <span className="a-seg" title="Откуда брать показы, переходы и заказы">
          <button type="button" className={mode === 'all' ? 'on' : ''} onClick={() => setMode('all')}>Вся аналитика</button>
          <button type="button" className={mode === 'ads' ? 'on' : ''} onClick={() => setMode('ads')}>Только реклама</button>
        </span>
        <Freshness status={status} />
        <button type="button" className="a-btn" onClick={handleCollect} disabled={collecting}>{collecting ? 'Собираем…' : 'Обновить'}</button>
      </div>

      <div className={`a-kpis ${loading ? 'a-loading' : ''}`}>
        <div className="a-kpi">
          <span className="lbl">{mode === 'ads' ? 'Заказано с рекламы, ₽' : 'Заказано, ₽'}</span>
          <span className="val n">{fmtInt(T.revenue)}</span>
          <span className="sub"><Delta value={P && changePct(T.revenue, P.revenue)} /> к прошлому периоду</span>
          {showAssoc && <span className="sub">+{fmtInt(assocForRows.reduce((acc, x) => acc + (x.totals.revenue || 0), 0))} ₽ по склейке</span>}
          <AreaSpark values={series('revenue')} color="var(--a-rev)" />
        </div>
        <div className="a-kpi">
          <span className="lbl">{mode === 'ads' ? 'Заказы с рекламы, шт' : 'Заказы, шт'}</span>
          <span className="val n">{fmtInt(T.orders)}</span>
          <span className="sub"><Delta value={P && changePct(T.orders, P.orders)} /> · ≈ {dates.length ? (T.orders / dates.length).toFixed(T.orders / dates.length < 10 ? 1 : 0).replace('.', ',') : '—'} в день</span>
          {showAssoc && <span className="sub">+{fmtInt(assocForRows.reduce((acc, x) => acc + (x.totals.orders || 0), 0))} по склейке</span>}
          <AreaSpark values={series('orders')} color="var(--a-good)" />
        </div>
        <div className="a-kpi">
          <span className="lbl">Остаток сейчас, шт</span>
          <span className="val n">{fmtInt(total.stockNow)}</span>
          <span className="sub" style={{ color: lowStock ? 'var(--a-bad)' : undefined }}>{lowStock ? `${lowStock} арт. заканчиваются (< 7 дн)` : 'Запаса хватает'}</span>
          <AreaSpark values={series('stock')} color="var(--a-ink3)" />
        </div>
        <div className="a-kpi">
          <span className="lbl">Расход на рекламу, ₽</span>
          <span className="val n">{fmtInt(T.spend)}</span>
          <div className="split">
            <span>За клик <b className="n">{fmtInt(T.spendCpc)}</b></span>
            <span>За заказ <b className="n">{T.spendCpo ? fmtInt(T.spendCpo) : '—'}</b></span>
          </div>
          <span className="sub"><Delta value={P && changePct(T.spend, P.spend)} goodWhen="neutral" /> к прошлому периоду</span>
        </div>
        <div className="a-kpi">
          <span className="lbl">{mode === 'ads' ? 'ДРР рекламный' : 'ДРР'}</span>
          <span className="val n">{fmtPct(T.drr)}</span>
          <span className="sub"><Delta value={P && T.drr !== null && P.drr !== null ? T.drr - P.drr : null} unit="pp" goodWhen="down" /> к прошлому периоду</span>
          <AreaSpark values={drrSeries} color="var(--a-spend)" />
        </div>
      </div>

      <div className="a-bar">
        <div className="a-tabs">
          <button type="button" className={`a-tab ${tab === 'all' ? 'on' : ''}`} onClick={() => selectTab('all')}>
            Все<span className="c">{articlesRaw.filter(a => a.campaigns.length > 0).length}</span>
          </button>
          {groups.map(g => {
            const cnt = Object.values(members).filter(x => x === g.id).length;
            return (
              <span key={g.id} role="button" tabIndex={0}
                className={`a-tab ${tab === g.id ? 'on' : ''} ${overTab === g.id && dragTab && dragTab !== g.id ? 'drop' : ''}`}
                onClick={() => selectTab(g.id)} onKeyDown={e => { if (e.key === 'Enter') selectTab(g.id); }}
                draggable onDragStart={() => setDragTab(g.id)} onDragOver={e => { e.preventDefault(); setOverTab(g.id); }}
                onDrop={e => { e.preventDefault(); reorderTabs(dragTab, g.id); setDragTab(null); setOverTab(null); }}
                onDragEnd={() => { setDragTab(null); setOverTab(null); }}
                title={g.name}>
                {g.name.length > 28 ? g.name.slice(0, 27) + '…' : g.name}<span className="c">{cnt}</span>
                <button type="button" className="x" title="Удалить группу" onClick={e => { e.stopPropagation(); removeGroup(g.id); }}>×</button>
              </span>
            );
          })}
          {newGroup === null ? (
            <button type="button" className="a-tab add" onClick={() => setNewGroup('')}>+ Группа</button>
          ) : (
            <form onSubmit={createGroup} style={{ display: 'flex', gap: 6 }}>
              <input className="a-input" autoFocus value={newGroup} onChange={e => setNewGroup(e.target.value)} placeholder="Название, напр. Haval M6"
                onKeyDown={e => { if (e.key === 'Escape') setNewGroup(null); }} style={{ padding: '5px 10px' }} />
              <button type="submit" className="a-btn" disabled={!newGroup.trim()}>Создать</button>
            </form>
          )}
          {ungroupedClusters.length > 0 && (
            <select className="a-sel" value="" onChange={e => createFromCluster(e.target.value)} title="Создать группу из готовой склейки одним действием">
              <option value="">+ по склейке…</option>
              {ungroupedClusters.map(c => <option key={c.primary} value={c.primary}>{c.primary} ({c.members.length} арт.)</option>)}
            </select>
          )}
        </div>
      </div>

      <div className="a-bar">
        <input className="a-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Артикул, модель или название РК" style={{ minWidth: 260 }} />
        <button type="button" className="a-toggle" onClick={() => setOnlyActive(v => !v)}><span className={`a-sw ${onlyActive ? 'on' : ''}`} />Только с активными РК</button>
        <select className="a-sel" value={payFilter} onChange={e => setPayFilter(e.target.value)}>
          <option value="">Все типы оплаты</option>
          <option value="cpc">Оплата за клик</option>
          <option value="cpo">Оплата за заказ</option>
        </select>
        <button type="button" className="a-toggle" onClick={() => setShowAssoc(v => !v)} title="Добавить заказы по остальным артикулам склейки: отдельно и итогом">
          <span className={`a-sw ${showAssoc ? 'on' : ''}`} />Показать склейку
        </button>
        {hiddenByFilter > 0 && <span className="a-hint">скрыто фильтром: {hiddenByFilter}</span>}
        {isGroup && sort.key !== 'manual' && (
          <button type="button" className="a-btn ghost" onClick={() => setSort({ key: 'manual', dir: 1 })}>↺ Свой порядок</button>
        )}
        {isGroup && <AddToGroup catalog={catalog} exclude={memberIds} onPick={id => assignGroup(id, tab)} />}
      </div>

      <Matrix rows={rows} dates={dates} mode={mode} />

      <div className={`a-card ${loading ? 'a-loading' : ''}`}>
        <div className="a-scroll">
          <table className="a-t">
            <thead>
              <tr>
                {COLS.map((c, i) => (
                  <th key={i} className={`${c.k ? 'sortable' : ''} ${sort.key === c.k ? 'sorted' : ''}`} onClick={() => clickSort(c.k)}>
                    {c.t}{sort.key === c.k ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(articleRow)}
              {!rows.length && (
                <tr><td colSpan={COLS.length} className="a-empty">
                  {isGroup ? 'В группе пока нет артикулов — добавьте через поиск справа.' : 'Под текущие фильтры ничего не подошло.'}
                </td></tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className={`row ${open.has(aggKey) ? 'open' : ''}`} onClick={() => toggleOpen(aggKey)} title="Нажмите, чтобы открыть общую аналитику по всем строкам">
                  <td><div className="a-art"><span className="a-chev">▶</span>Итого · {rows.length} арт.{isGroup ? ` · ${activeGroup.name}` : ''}</div></td>
                  <td />
                  <td className="n">{fmtInt(T.revenue)}{showAssoc && assocLine(assocForRows, 'revenue', T.revenue)}</td>
                  <td className="n">{fmtInt(T.orders)}{showAssoc && assocLine(assocForRows, 'orders', T.orders)}</td>
                  <td className="n">{fmtInt(total.stockNow)}</td>
                  <td className="n">{fmtInt(T.spend)}<span className="a-spendsub">клик {fmtInt(T.spendCpc)} · заказ {T.spendCpo ? fmtInt(T.spendCpo) : '—'}</span></td>
                  <td><span className={`pill ${drrClass(T.drr)}`}>{fmtPct(T.drr)}</span></td>
                  <td /><td />
                </tr>
                {open.has(aggKey) && (
                  <tr className="a-detail"><td colSpan={COLS.length}>
                    <Detail articles={rows} dates={dates} mode={mode} events={events} isAggregate onAddNote={addNote} onDeleteNote={deleteNote} tip={tip}
                      showAssoc={showAssoc} associated={assocForRows} />
                  </td></tr>
                )}
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {tip.node}
    </div>
  );
}
