import React, { useEffect, useState } from 'react';
import { useTaxSettings, storeTaxSettings, loadTaxSettings } from '../lib/taxSettings';
import { shopOf } from '../lib/cabinets';
import './ads2.css';

export default function Tax({ cabinet, nav }) {
  const settings = useTaxSettings(cabinet);
  const [enabled, setEnabled] = useState(true), [rate, setRate] = useState('6');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => { setEnabled(settings.enabled); setRate(String(settings.rate)); }, [cabinet, settings.enabled, settings.rate]);
  useEffect(() => { setMessage(''); }, [cabinet]);
  async function save() {
    setBusy(true); setMessage('');
    try { await storeTaxSettings(cabinet, { enabled, rate: Number(rate) }); setMessage('Сохранено. Расчёты магазина обновлены во всём сервисе.'); }
    catch (e) { setMessage(`Не удалось сохранить: ${e.response?.data?.error || e.message}`); }
    finally { setBusy(false); }
  }
  return <div className="mpui" style={{ padding: 20 }}>
    <div className="a-bar"><h2 style={{ margin: 0 }}>Товары</h2>{nav}</div>
    <div className="a-card" style={{ padding: 22, maxWidth: 760 }}>
      <h3 style={{ marginTop: 0 }}>Налог · {shopOf(cabinet)?.label || cabinet}</h3>
      <p>Настройка действует во всех расчётах выбранного магазина и сохраняется на сервере для всех компьютеров.</p>
      {settings.loading ? <p>Загрузка настройки…</p> : <>
        {settings.error && <div role="alert">Не удалось загрузить настройку: {settings.error} <button className="a-btn" onClick={() => loadTaxSettings(cabinet).catch(() => {})}>Повторить</button></div>}
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0' }}><input type="checkbox" checked={enabled} disabled={busy || !!settings.error} onChange={e => { setEnabled(e.target.checked); setMessage(''); }} />Учитывать налог в расчётах</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>Ставка налога, %<input className="a-input" type="number" min="0" max="100" step="0.1" value={rate} disabled={busy || !!settings.error} onChange={e => { setRate(e.target.value); setMessage(''); }} style={{ width: 90 }} /></label>
        <p className="a-hint">При отключении налог равен нулю в P&amp;L, аналитике продаж, РНП, юнит-экономике, рекламе, ABC, ценах и марже, сводке магазинов, калькуляторе, выгрузках и Telegram-сводке. Ставка сохраняется для повторного включения.</p>
        <p className="a-hint">Изменение применяется и к расчётам за прошлые периоды. Начисления Ozon, себестоимость и сохранённые планы не изменяются.</p>
        <button className="a-btn" onClick={save} disabled={busy || !!settings.error || rate === '' || !Number.isFinite(Number(rate)) || Number(rate) < 0 || Number(rate) > 100}>{busy ? 'Сохранение…' : 'Сохранить'}</button>
        {message && <p role="status">{message}</p>}
      </>}
    </div>
  </div>;
}
