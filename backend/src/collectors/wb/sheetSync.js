const axios = require('axios');
const bridge = require('../../lib/wbBridge');
const { parseCsv } = require('../ads/sheetSync');
const ENV = 'ADS_SHEET_ID_DEFLY_WB';
let pending, lastCheck = 0, state = { lastSuccessAt: null, error: null, errors: [], busy: false };
const configured = () => !!process.env[ENV];
async function csv(tab) {
  const id = process.env[ENV];
  if (!/^[\w-]{20,100}$/.test(id || '')) throw new Error('В ADS_SHEET_ID_DEFLY_WB укажите только ID таблицы между /d/ и /edit');
  const response = await axios.get(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(tab)}`, { timeout: 30000, responseType: 'text', maxContentLength: 100 * 1024 * 1024 });
  const text = String(response.data);
  if (/^\s*</.test(text)) throw new Error('Google не отдал CSV: проверьте доступ к таблице WB по ссылке');
  const raw = parseCsv(text), headers = raw.shift() || [];
  return { headers, rows: raw.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))) };
}
async function collect() {
  const manifest = await csv('WB_status');
  if (!['cabinet', 'kind', 'run_id', 'collected_at', 'from', 'to', 'total'].every(k => manifest.headers.includes(k))) throw new Error('В таблице пока нет WB_status. Вставьте обновлённый скрипт WB и запустите сбор.');
  const metaRows = manifest.rows.filter(r => r.cabinet === bridge.CABINET);
  if (!metaRows.length) throw new Error('В WB_status ещё нет данных Defly WB. Запустите сбор в Apps Script.');
  if (metaRows.some(r => !bridge.KINDS.includes(r.kind)) || new Set(metaRows.map(r => r.kind)).size !== metaRows.length) throw new Error('Некорректный список наборов WB_status');
  const current = new Map((await bridge.read()).map(r => [r.kind, r.meta.runId]));
  const errors = []; let changed = 0;
  for (const m of metaRows) {
    if (current.get(m.kind) === m.run_id) continue;
    try {
      const table = await csv('WB_' + m.kind), total = Number(m.total);
      if (!['id', 'payload', 'run_id'].every(k => table.headers.includes(k))) throw new Error('Не найдены колонки id / payload / run_id');
      if (!/^\d+$/.test(m.total) || !Number.isSafeInteger(total) || total < 0 || table.rows.length !== total || table.rows.some(r => r.run_id !== m.run_id)) throw new Error('Таблица ещё обновляется или получен неполный набор; прежние данные сохранены');
      const rows = table.rows.map(r => { const data = JSON.parse(r.payload); if (data.id !== r.id) throw new Error('ID строки не совпадает с содержимым'); return data; });
      const parts = Math.max(1, Math.ceil(total / 1000));
      for (let part = 0; part < parts; part++) await bridge.ingest({ cabinet: bridge.CABINET, kind: m.kind, runId: m.run_id, collectedAt: m.collected_at, from: m.from || null, to: m.to || null, warning: m.warning || '', total, parts, part, rows: rows.slice(part * 1000, (part + 1) * 1000) });
      changed++;
    } catch (e) { errors.push(`${m.kind}: ${e.message}`); }
  }
  return { changed, errors };
}
function status() { return { configured: configured(), ...state, lastCheckedAt: lastCheck ? new Date(lastCheck).toISOString() : null }; }
async function sync(force = false) {
  if (!configured()) return status();
  if (pending) { await pending; return status(); }
  if (!force && Date.now() - lastCheck < 60000) return status();
  lastCheck = Date.now(); state.busy = true;
  pending = collect().then(result => { state.errors = result.errors; state.error = result.errors.length ? result.errors.join('; ') : null; if (!result.errors.length) state.lastSuccessAt = new Date().toISOString(); })
    .catch(e => { state.error = e.response?.status === 401 || e.response?.status === 403 ? 'Таблица WB закрыта для чтения по ссылке' : e.message; state.errors = [state.error]; })
    .finally(() => { state.busy = false; pending = null; });
  await pending; return status();
}
function start() { const tick = () => sync().catch(e => console.error('[WB Sheet]', e.message)); setTimeout(tick, 12000).unref?.(); setInterval(tick, 5 * 60000).unref?.(); }
module.exports = { sync, start, status, configured };
