const fs = require('node:fs');
const axios = require('axios');
const { CABINETS } = require('./cabinets');

const metadata = 'http://169.254.169.254/computeMetadata/v1/instance/attributes';

async function loadYandexSheetSources() {
  if (!fs.existsSync('/var/lib/mp/status.json')) return;
  await Promise.all(Object.entries(CABINETS).filter(([, cfg]) => cfg.sheetOnly).map(async ([id]) => {
    const envKey = `ADS_SHEET_ID_${id.toUpperCase()}`;
    if (process.env[envKey]) return;
    const attribute = `ads-sheet-id-${id.replaceAll("_", "-")}`;
    try {
      const { data } = await axios.get(`${metadata}/${attribute}`, {
        headers: { 'Metadata-Flavor': 'Google' },
        timeout: 1200,
        proxy: false,
        maxRedirects: 0,
        maxContentLength: 256,
        responseType: 'text',
      });
      const sheetId = String(data).trim();
      if (/^[A-Za-z0-9_-]{20,100}$/.test(sheetId)) process.env[envKey] = sheetId;
      else console.warn(`[Кабинеты] Некорректный идентификатор таблицы для ${id}`);
    } catch (error) {
      if (error.response?.status !== 404) console.warn(`[Кабинеты] Метаданные для ${id} недоступны`);
    }
  }));
}

module.exports = { loadYandexSheetSources };
