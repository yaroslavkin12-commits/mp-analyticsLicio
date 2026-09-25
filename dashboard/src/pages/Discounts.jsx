import React, { useState, useEffect, useCallback } from 'react';
import { getDiscounts } from '../api';

// Соинвест Ozon (аналог СПП на Wildberries) — маркетплейс сам доплачивает
// часть скидки покупателю за счёт своей комиссии. Разница между ценой
// продавца и ценой на витрине — это и есть размер Соинвеста. Сюда попадают
// только реальные ИЗМЕНЕНИЯ этого процента (см. backend
// collectors/ads/ozonDiscounts.js) — история копится с момента первого
// сбора, задача проверяет изменения каждые ~20 минут, а при значимом сдвиге
// уходит уведомление в Telegram.

const DAYS_OPTIONS = [['7', '7 дн'], ['30', '30 дн'], ['90', '90 дн']];

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
              <td style={{ padding: '4px 8px', color: 'var(--text2)' }}>{fmtDateTime(h.at)}{h.source && h.source !== 'seller_cabinet' ? ' *' : ''}</td>
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

export default function Discounts({ cabinet }) {
  const [days, setDays] = useState('30');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [search, setSearch] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    getDiscounts(cabinet, days).then(r => { setData(r.data.data); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [cabinet, days]);

  useEffect(() => { load(); }, [load]);

  const articles = (data?.articles || []).filter(a =>
    !search || a.offerId.toLowerCase().includes(search.toLowerCase()) ||
    (a.productName || '').toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Соинвест Ozon</h2>
        <div style={{ display: 'flex', gap: 3, background: 'var(--surface2)', borderRadius: 8, padding: 3 }}>
          {DAYS_OPTIONS.map(([v, l]) => (
            <button key={v} onClick={() => setDays(v)} style={{
              padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 12.5, fontWeight: 500,
              background: days === v ? 'var(--accent-oz)' : 'transparent', color: days === v ? '#fff' : 'var(--text2)',
            }}>{l}</button>
          ))}
        </div>
        <input
          value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск по артикулу…"
          style={{ marginLeft: 'auto', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)',
            background: 'var(--surface)', color: 'var(--text)', fontSize: 13, minWidth: 200 }}
        />
        <button onClick={load} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)',
          background: 'var(--surface2)', color: 'var(--text2)', fontSize: 12.5 }}>Обновить</button>
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--text3)', marginBottom: 12, lineHeight: 1.5 }}>
        Соинвест — доля скидки, которую Ozon покрывает сам за счёт своей комиссии (аналог СПП на Wildberries).
        Разница между ценой продавца и ценой на витрине для покупателя. Показаны только реальные изменения
        процента — таблица обновляется примерно раз в 20 минут; при резком сдвиге приходит уведомление в Telegram.
        Значок «≈» — сессия кабинета не настроена, показана приблизительная оценка без реальной цены на сайте.
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
                <React.Fragment key={a.offerId}>
                  <tr
                    onClick={() => setExpanded(e => e === a.offerId ? null : a.offerId)}
                    style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}
                  >
                    <td style={{ padding: '9px 14px' }}>
                      <div style={{ fontWeight: 600 }}>{a.offerId}</div>
                      {a.productName && <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>{a.productName.slice(0, 60)}</div>}
                    </td>
                    <td style={{ padding: '9px 14px', fontWeight: 700, fontSize: 14 }}>
                      {a.current ? fmtPct(a.current.pct) : '—'}
                      {a.isEstimate && <span title="Сессия кабинета не настроена — это приблизительная оценка без реальной цены на сайте" style={{ marginLeft: 4, fontSize: 11, fontWeight: 400, color: 'var(--text3)' }}>≈</span>}
                    </td>
                    <td style={{ padding: '9px 14px' }}><ChangeBadge value={a.changes24h} /></td>
                    <td style={{ padding: '9px 14px', color: 'var(--text2)' }}>{fmtPct(a.minPct)} / {fmtPct(a.maxPct)}</td>
                    <td style={{ padding: '9px 14px', color: 'var(--text2)' }}>{a.current ? fmtMoney(a.current.marketingPrice) : '—'}</td>
                    <td style={{ padding: '9px 14px', color: 'var(--text3)' }}>{a.changesCount}</td>
                  </tr>
                  {expanded === a.offerId && (
                    <tr>
                      <td colSpan={6} style={{ padding: '0 14px 12px' }}>
                        <ArticleHistory history={a.history} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
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
    </div>
  );
}
