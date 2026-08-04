import React, { useState, useEffect } from 'react';
import { getCosts, saveCosts, deleteCost, collect, getStatus, getLog } from '../api';
import dayjs from 'dayjs';

export default function Settings() {
  const [costs, setCosts] = useState([]);
  const [status, setStatus] = useState(null);
  const [log, setLog] = useState([]);
  const [tab, setTab] = useState('costs');
  const [form, setForm] = useState({ platform: 'wb', article: '', product_name: '', cost_price: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    const [c, s, l] = await Promise.all([
      getCosts().catch(() => ({ data: { data: [] } })),
      getStatus().catch(() => ({ data: { data: {} } })),
      getLog().catch(() => ({ data: { data: [] } })),
    ]);
    setCosts(c.data.data||[]);
    setStatus(s.data.data||{});
    setLog(l.data.data||[]);
  }

  const notify = (text, ms = 4000) => { setMsg(text); setTimeout(() => setMsg(''), ms); };

  async function addCost(e) {
    e.preventDefault();
    if (!form.article || !form.cost_price) return;
    try {
      await saveCosts([{ ...form, cost_price: parseFloat(form.cost_price) }]);
      setForm({ platform: 'wb', article: '', product_name: '', cost_price: '' });
      notify('✅ Сохранено');
      load();
    } catch (e) { notify('❌ Ошибка: ' + e.message); }
  }

  async function startCollect(platform) {
    setBusy(true);
    notify('🔄 Запущен сбор данных...');
    try {
      await collect({ platform, dateFrom: dayjs().subtract(7, 'day').format('YYYY-MM-DD') });
      notify('✅ Сбор запущен в фоне. Данные появятся через ~5 минут.');
      setTimeout(load, 12000);
    } catch (e) { notify('❌ Ошибка: ' + e.message); }
    finally { setBusy(false); }
  }

  const Btn = ({ children, onClick, color, disabled }) => (
    <button onClick={onClick} disabled={disabled} style={{ padding: '7px 14px', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer', background: color||'var(--surface2)', color: color ? '#fff' : 'var(--text2)', opacity: disabled ? .6 : 1, transition: 'opacity .15s' }}>{children}</button>
  );

  const TabBtn = ({ id, label }) => (
    <button onClick={() => setTab(id)} style={{ padding: '7px 16px', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 500, background: tab===id ? 'var(--surface2)' : 'transparent', color: tab===id ? 'var(--text)' : 'var(--text2)' }}>{label}</button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 860 }}>
      <h1 style={{ fontSize: 17, fontWeight: 700 }}>Настройки</h1>

      {msg && <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 16px', fontSize: 13 }}>{msg}</div>}

      {/* Статус площадок */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 18 }}>
        <div style={{ fontWeight: 600, marginBottom: 14 }}>Площадки</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
          {['wb','ozon'].map(p => {
            const s = status?.[p]||{};
            const last = s.lastSync?.finished_at ? dayjs(s.lastSync.finished_at).format('DD.MM HH:mm') : 'никогда';
            const c = p === 'wb' ? 'var(--accent-wb)' : 'var(--accent-oz)';
            return (
              <div key={p} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--surface2)', borderRadius: 8, padding: '12px 14px' }}>
                <div>
                  <div style={{ fontWeight: 600, color: c }}>{p === 'wb' ? 'Wildberries' : 'Ozon'}</div>
                  <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>Последний сбор: {last}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ padding: '3px 8px', borderRadius: 5, fontSize: 11, fontWeight: 600, background: s.enabled ? 'rgba(16,185,129,.15)' : 'rgba(239,68,68,.15)', color: s.enabled ? 'var(--ok)' : 'var(--danger)' }}>
                    {s.enabled ? '● Активен' : '○ Выкл'}
                  </span>
                  <Btn onClick={() => startCollect(p)} disabled={busy || !s.enabled}>Обновить</Btn>
                </div>
              </div>
            );
          })}
        </div>
        <Btn onClick={() => startCollect('all')} disabled={busy} color="var(--accent-wb)">🚀 Обновить все площадки</Btn>
        <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--text3)' }}>данные за последние 7 дней</span>
      </div>

      {/* Табы */}
      <div style={{ display: 'flex', gap: 3, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 9, padding: 3, width: 'fit-content' }}>
        <TabBtn id="costs" label="💰 Себестоимость" />
        <TabBtn id="log" label="📋 Лог сборов" />
      </div>

      {tab === 'costs' && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 18 }}>
          <div style={{ fontWeight: 600, marginBottom: 14 }}>Себестоимость товаров</div>
          <form onSubmit={addCost} style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
            <select value={form.platform} onChange={e => setForm(p => ({...p, platform: e.target.value}))} style={{ width: 90 }}>
              <option value="wb">WB</option>
              <option value="ozon">Ozon</option>
            </select>
            <input placeholder="Артикул *" value={form.article} onChange={e => setForm(p => ({...p, article: e.target.value}))} style={{ width: 150 }} required />
            <input placeholder="Название товара" value={form.product_name} onChange={e => setForm(p => ({...p, product_name: e.target.value}))} style={{ width: 220 }} />
            <input type="number" placeholder="Себестоимость ₽ *" value={form.cost_price} onChange={e => setForm(p => ({...p, cost_price: e.target.value}))} style={{ width: 160 }} min="0" step="0.01" required />
            <Btn color="var(--accent-wb)">+ Добавить</Btn>
          </form>
          {costs.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text2)' }}>Нет записей. Добавь себестоимость — появится расчёт маржи в разделе Товары.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr>
                {['Площадка','Артикул','Название','Себестоимость',''].map(h => <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text2)', fontWeight: 500, fontSize: 12, borderBottom: '1px solid var(--border)' }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {costs.map(c => (
                  <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '9px 12px' }}><span style={{ color: c.platform==='wb' ? 'var(--accent-wb)' : 'var(--accent-oz)', fontWeight: 700, fontSize: 12 }}>{c.platform.toUpperCase()}</span></td>
                    <td style={{ padding: '9px 12px', fontWeight: 600 }}>{c.article}</td>
                    <td style={{ padding: '9px 12px', color: 'var(--text2)' }}>{c.product_name||'—'}</td>
                    <td style={{ padding: '9px 12px', fontWeight: 600 }}>{Number(c.cost_price).toLocaleString('ru')} ₽</td>
                    <td style={{ padding: '9px 12px' }}>
                      <button onClick={async () => { await deleteCost(c.id); setCosts(costs.filter(x => x.id!==c.id)); }} style={{ border: 'none', background: 'transparent', color: 'var(--danger)', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'log' && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', fontWeight: 600 }}>Лог сборов данных</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr>
              {['Время','Площадка','Тип','Статус','Записей','Ошибка'].map(h => <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text2)', fontWeight: 500, borderBottom: '1px solid var(--border)' }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {log.length === 0 && <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--text2)' }}>Нет записей</td></tr>}
              {log.map(l => (
                <tr key={l.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px', color: 'var(--text2)' }}>{dayjs(l.started_at).format('DD.MM HH:mm')}</td>
                  <td style={{ padding: '8px 12px', color: l.platform==='wb' ? 'var(--accent-wb)' : 'var(--accent-oz)', fontWeight: 700 }}>{l.platform.toUpperCase()}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text2)' }}>{l.collector_type}</td>
                  <td style={{ padding: '8px 12px', color: l.status==='success' ? 'var(--ok)' : l.status==='error' ? 'var(--danger)' : 'var(--warn)' }}>
                    {l.status==='success' ? '✅' : l.status==='error' ? '❌' : '🔄'} {l.status}
                  </td>
                  <td style={{ padding: '8px 12px' }}>{l.records_collected||0}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--danger)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.error_message||'—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
