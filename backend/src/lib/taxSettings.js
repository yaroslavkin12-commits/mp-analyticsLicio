const { query } = require('../db');
const { CABINETS } = require('../config/cabinets');

function checkCabinet(cabinet) {
  if (!Object.hasOwn(CABINETS, cabinet)) throw Object.assign(new Error('Неизвестный магазин'), { status: 400 });
}
async function getTaxSettings(cabinet) {
  checkCabinet(cabinet);
  const rows = await query('SELECT value FROM app_settings WHERE key = $1', [`tax:${cabinet}`]);
  const v = rows[0] ? JSON.parse(rows[0].value) : { enabled: true, rate: 6 };
  return { cabinet, enabled: v.enabled !== false, rate: v.rate, effectiveRate: v.enabled === false ? 0 : v.rate, configured: rows.length > 0 };
}
async function saveTaxSettings(cabinet, patch) {
  checkCabinet(cabinet);
  if (typeof patch.enabled !== 'boolean' || typeof patch.rate !== 'number' || !Number.isFinite(patch.rate) || patch.rate < 0 || patch.rate > 100) {
    throw Object.assign(new Error('Укажите, учитывать ли налог, и ставку от 0 до 100%'), { status: 400 });
  }
  await query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [`tax:${cabinet}`, JSON.stringify({ enabled: patch.enabled, rate: patch.rate })]);
  return { cabinet, enabled: patch.enabled, rate: patch.rate, effectiveRate: patch.enabled ? patch.rate : 0, configured: true };
}
module.exports = { getTaxSettings, saveTaxSettings };
