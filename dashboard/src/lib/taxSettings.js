import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getTaxSettings, saveTaxSettings } from '../api';

const entries = new Map();
function entry(cabinet) {
  if (!entries.has(cabinet)) {
    let cached;
    try { cached = JSON.parse(localStorage.getItem(`mp-tax-server:${cabinet}`)); } catch { /* ignore */ }
    entries.set(cabinet, { value: { enabled: true, rate: 6, ...cached, cabinet, loading: true, error: '' }, listeners: new Set(), pending: null, version: 0 });
  }
  return entries.get(cabinet);
}
function publish(cabinet, value) {
  const e = entry(cabinet);
  const changed = e.value.enabled !== value.enabled || e.value.rate !== value.rate;
  e.value = { ...value, loading: false, error: '' };
  try { localStorage.setItem(`mp-tax-server:${cabinet}`, JSON.stringify(value)); } catch { /* ignore */ }
  e.listeners.forEach(fn => fn());
  if (changed) window.dispatchEvent(new CustomEvent('mp-tax-changed', { detail: { cabinet } }));
}
export async function loadTaxSettings(cabinet) {
  const e = entry(cabinet);
  if (e.pending) return e.pending;
  const version = e.version;
  e.pending = getTaxSettings(cabinet).then(r => {
    let v = r.data?.data;
    if (!r.data?.success || v?.cabinet !== cabinet || typeof v.enabled !== 'boolean' || !Number.isFinite(v.rate)) throw new Error('Не удалось прочитать настройку налога');
    // До первого явного сохранения сохраняем прежнюю ставку этого браузера.
    // После сохранения единственный источник настройки — сервер.
    if (v.configured === false) {
      try { const old = localStorage.getItem(`mp-tax-${cabinet}`), rate = Number(old); if (old !== null && Number.isFinite(rate) && rate >= 0 && rate <= 100) v = { ...v, rate, effectiveRate: v.enabled ? rate : 0 }; } catch { /* ignore */ }
    }
    if (e.version === version) publish(cabinet, v);
    return v;
  }).catch(err => {
    if (e.version === version) { e.value = { ...e.value, loading: false, error: err.response?.data?.error || err.message }; e.listeners.forEach(fn => fn()); }
    throw err;
  }).finally(() => { e.pending = null; });
  return e.pending;
}
export async function storeTaxSettings(cabinet, settings) {
  const e = entry(cabinet);
  e.version++;
  const r = await saveTaxSettings(cabinet, settings);
  if (!r.data?.success) throw new Error(r.data?.error || 'Не удалось сохранить налог');
  publish(cabinet, r.data.data);
  return r.data.data;
}
export function useTaxSettings(cabinet) {
  const subscribe = useCallback(fn => { const e = entry(cabinet); e.listeners.add(fn); return () => e.listeners.delete(fn); }, [cabinet]);
  const snapshot = useCallback(() => entry(cabinet).value, [cabinet]);
  const settings = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => { loadTaxSettings(cabinet).catch(() => {}); }, [cabinet]);
  return settings;
}
export function useTax(cabinet) {
  const settings = useTaxSettings(cabinet);
  return [settings.enabled ? settings.rate : 0];
}
export function watchTaxCabinets(cabinets) {
  for (const cabinet of cabinets) { const e = entry(cabinet); e.watchers = (e.watchers || 0) + 1; loadTaxSettings(cabinet).catch(() => {}); }
  return () => { for (const cabinet of cabinets) entry(cabinet).watchers--; };
}
function refresh() {
  if (document.visibilityState === 'hidden') return;
  for (const [cabinet, e] of entries) if (e.listeners.size || e.watchers) loadTaxSettings(cabinet).catch(() => {});
}
window.addEventListener('focus', refresh);
document.addEventListener('visibilitychange', refresh);
setInterval(refresh, 60000);
