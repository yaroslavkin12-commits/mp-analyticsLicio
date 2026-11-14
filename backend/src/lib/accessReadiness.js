const axios = require('axios');
const { query } = require('../db');
const LEGACY = 'https://mp-analyticslicio-1.onrender.com';
async function status() {
  const keys = await query("SELECT EXISTS(SELECT 1 FROM app_api_keys WHERE last_used > NOW()-INTERVAL '24 hours') AS connected");
  let legacyReady = false, locked = false;
  try {
    const r = await axios.get(LEGACY + '/api/auth/feature-status', { timeout: 7000, validateStatus: () => true });
    legacyReady = r.status === 200 && r.data?.categoryAccessVersion === 1;
    locked = legacyReady && r.data.auth === true;
  } catch {}
  return { keyConnected: keys[0]?.connected === true, legacyReady, locked };
}
async function ensureReady() {
  const initial = await status();
  if (!initial.keyConnected) throw Object.assign(Error('Сначала подключите расширение ключом доступа и выполните сбор цен'), { status: 409 });
  if (!initial.legacyReady) throw Object.assign(Error('Обновление доступа ещё устанавливается. Повторите сохранение через несколько минут'), { status: 409 });
  await require('./auth').requireAuthentication();
  for (let i=0; i<6; i++) {
    if ((await status()).locked) return;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw Object.assign(Error('Проверяем закрытие старого открытого адреса. Повторите сохранение через несколько секунд'), { status: 409 });
}
module.exports = { status, ensureReady };
