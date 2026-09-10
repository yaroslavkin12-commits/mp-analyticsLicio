import React, { useState, useEffect, useCallback } from 'react';
import { getAdsStats, getAdsCabinets, collectAds } from '../api';

const DAY_OPTIONS = [14, 30, 60];

// Метрики-строки внутри блока каждой кампании/товара — порядок и подписи как
// в примере пользователя (таблица в Google Sheets), плюс добавленные СТР и
// конверсии в корзину/заказ.
const METRIC_ROWS = [
  { key: 'orders_money', label: 'Заказы, ₽',        fmt: 'money',   good: 'up' },
  { key: 'orders_units', label: 'Заказы, шт',        fmt: 'int',     good: 'up' },
  { key: 'position',     label: 'Позиция в поиске',  fmt: 'pos',     good: 'down' },
  { key: 'views',        label: 'Показы',            fmt: 'int',     good: 'up' },
  { key: 'clicks',       label: 'Клики',             fmt: 'int',     good: 'up' },
  { key: 'ctr',          label: 'СТР',               fmt: 'pct',     good: 'up' },
  { key: 'cart',         label: 'Корзины',           fmt: 'int',     good: 'up' },
  { key: 'cr_to_cart',   label: 'Конв. в корзину',   fmt: 'pct',     good: 'up' },
  { key: 'cr_to_order',  label: 'Конв. в заказ',     fmt: 'pct',     good: 'up' },
  { key: 'bid',          label: 'Ставка, ₽',         fmt: 'money0',  good: 'neutral' },
  { key: 'spend',        label: 'Расход, ₽',         fmt: 'money0',  good: 'neutral' },
  { key: 'drr',          label: 'ДРР',               fmt: 'pct',     good: 'down' },
];

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

// Простая тепловая заливка ячейки: нормализуем значение в строке к [0..1] по
// диапазону min..max этой же строки, затем красим от красного к зелёному
// (или наоборот — для ДРР и позиции, где меньше значит лучше).
function heatColor(v, min, max, direction) {
  if (v === null || v === undefined || max === min) return 'transparent';
  let t = (v - min) / (max - min);
  if (direction === 'down') t = 1 - t;
  if (direction === 'neutral') return 'transparent';
  t = Math.max(0, Math.min(1, t));
  // от красного (0) к зелёному (1) через жёлтый — HSL hue 0..120
  const hue = 120 * t;
  return `hsla(${hue}, 65%, 42%, 0.35)`;
}

export default function AdsStats({ cabinet }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [cabinets, setCabinets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());

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
      setTimeout(load, 15000); // сбор идёт в фоне на бэкенде — даём ему время
    } finally {
      setTimeout(() => setCollecting(false), 15000);
    }
  }

  function toggle(campaignId) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(campaignId)) next.delete(campaignId); else next.add(campaignId);
      return next;
    });
  }

  if (loading && !data) return <div style={{ padding:60, textAlign:'center', color:'var(--text2)' }}>Загрузка...</div>;

  const dates = data?.dates || [];
  const campaigns = data?.campaigns || [];

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

      {notConfigured && (
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:16, color:'var(--text2)', fontSize:13 }}>
          Для кабинета «{cabInfo?.label || cabinet}» ещё не добавлены токены Ozon в настройках сервера — реклама пока не собирается.
          Нужны переменные окружения <code>{cabinet.toUpperCase()}_OZON_CLIENT_ID</code>, <code>{cabinet.toUpperCase()}_OZON_API_KEY</code>,{' '}
          <code>{cabinet.toUpperCase()}_OZON_PERF_CLIENT_ID</code>, <code>{cabinet.toUpperCase()}_OZON_PERF_SECRET</code>.
        </div>
      )}

      {!notConfigured && campaigns.length === 0 && (
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:16, color:'var(--text2)', fontSize:13 }}>
          Данных пока нет. Нажмите «Обновить данные», чтобы собрать статистику по рекламным кампаниям.
        </div>
      )}

      {campaigns.length > 0 && (
        <div style={{ overflowX:'auto', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)' }}>
          <table style={{ borderCollapse:'collapse', fontSize:12, minWidth: 260 + dates.length * 62 }}>
            <thead>
              <tr>
                <th style={{ position:'sticky', left:0, zIndex:2, background:'var(--surface)', borderBottom:'2px solid var(--border)', borderRight:'1px solid var(--border)', padding:'8px 10px', textAlign:'left', minWidth:220 }}>Артикул / метрика</th>
                {dates.map(d => (
                  <th key={d} style={{ borderBottom:'2px solid var(--border)', padding:'8px 6px', fontWeight:600, color:'var(--text2)', whiteSpace:'nowrap' }}>
                    {d.slice(8,10)}.{d.slice(5,7)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {campaigns.map(camp => {
                const isOpen = expanded.has(camp.campaignId) || campaigns.length <= 3;
                return (
                  <React.Fragment key={camp.campaignId}>
                    <tr onClick={() => toggle(camp.campaignId)} style={{ cursor:'pointer' }}>
                      <td colSpan={dates.length + 1} style={{
                        position:'sticky', left:0, background:'var(--surface2)', fontWeight:700,
                        padding:'8px 10px', borderTop:'1px solid var(--border)', borderBottom:'1px solid var(--border)',
                      }}>
                        <span style={{ marginRight:8 }}>{isOpen ? '▾' : '▸'}</span>
                        {camp.title || camp.campaignId}
                        {camp.offerId && <span style={{ color:'var(--text3)', fontWeight:400, marginLeft:8 }}>({camp.offerId})</span>}
                        <span style={{
                          marginLeft:10, fontSize:11, padding:'2px 8px', borderRadius:999,
                          background: camp.state === 'CAMPAIGN_STATE_RUNNING' ? 'rgba(34,197,94,.18)' : 'rgba(148,163,184,.18)',
                          color: camp.state === 'CAMPAIGN_STATE_RUNNING' ? 'var(--ok, #22c55e)' : 'var(--text3)',
                        }}>
                          {camp.state === 'CAMPAIGN_STATE_RUNNING' ? 'ОЗЗ вкл' : 'ОЗЗ выкл'}
                        </span>
                      </td>
                    </tr>
                    {isOpen && METRIC_ROWS.map(row => {
                      const values = dates.map(d => camp.byDate[d]?.[row.key]);
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
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
