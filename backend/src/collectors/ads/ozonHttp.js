const axios = require('axios');
const dayjs = require('dayjs');
const { getPool } = require('../../db');
const { getCabinet } = require('../../config/cabinets');

// Общие помощники для всех сборщиков кабинета (Defly и т.п.).
//
// Почему отдельный модуль: раньше в каждом сборщике была своя обёртка с
// повторами, свой токен Performance API и построчная запись в БД (тысячи
// отдельных INSERT подряд). Из-за этого один прогон шёл десятки минут и не
// успевал закончиться до перезапуска процесса на Render. Теперь запросы
// идут через одну обёртку с разумными повторами, а запись — пачками.

const delay = ms => new Promise(r => setTimeout(r, ms));

// Дата по Москве — Ozon считает дни аналитики и статистики по московскому
// времени, а сервер Render живёт в UTC (около полуночи даты расходились).
function mskDate(offsetDays = 0) {
  return dayjs().add(3, 'hour').subtract(offsetDays, 'day').format('YYYY-MM-DD');
}

function sellerHeaders(cabinet) {
  const cfg = getCabinet(cabinet);
  if (!cfg.ozonClientId || !cfg.ozonApiKey) return null;
  return { 'Client-Id': cfg.ozonClientId, 'Api-Key': cfg.ozonApiKey, 'Content-Type': 'application/json' };
}

// Токен Performance API живёт ~30 минут — держим в памяти 25 минут, чтобы
// не запрашивать его заново на каждый шаг.
const perfTokens = new Map(); // cabinet -> { token, until }
async function perfHeaders(cabinet) {
  const cfg = getCabinet(cabinet);
  if (!cfg.ozonPerfClientId || !cfg.ozonPerfSecret) return null;
  const cached = perfTokens.get(cabinet);
  if (cached && cached.until > Date.now()) return { Authorization: `Bearer ${cached.token}`, 'Content-Type': 'application/json' };
  const data = await request(() => axios.post('https://api-performance.ozon.ru/api/client/token',
    { client_id: cfg.ozonPerfClientId, client_secret: cfg.ozonPerfSecret, grant_type: 'client_credentials' },
    { timeout: 20000 }).then(r => r.data), 'Performance токен');
  if (!data?.access_token) throw new Error('Performance API не выдал токен');
  perfTokens.set(cabinet, { token: data.access_token, until: Date.now() + 25 * 60 * 1000 });
  return { Authorization: `Bearer ${data.access_token}`, 'Content-Type': 'application/json' };
}

// Повтор запроса при временных сбоях: лимит запросов (429 / code 8),
// ошибки сервера Ozon (5xx) и сетевые обрывы/таймауты. Постоянные ошибки
// (400, 403, 404) не повторяем — они не пройдут и со второго раза.
async function request(fn, label, { attempts = 6 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      const code = e.response?.data?.code;
      const transient = status === 429 || code === 8 || (status >= 500 && status < 600) || !e.response;
      if (!transient || i === attempts - 1) break;
      const wait = Math.min(5000 * 2 ** i, 60000);
      console.warn(`[Ozon] ${label}: временная ошибка (${status || e.code || e.message}), повтор ${i + 1}/${attempts - 1} через ${wait / 1000}с`);
      await delay(wait);
    }
  }
  const body = lastErr?.response?.data;
  const err = new Error(`${label}: ${body ? JSON.stringify(body).slice(0, 300) : lastErr?.message}`);
  err.status = lastErr?.response?.status;
  throw err;
}

// Русские числа из Performance API: "12005,20", "1 234,5".
function parseRuNumber(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  return Number(String(v).replace(/\s/g, '').replace(',', '.')) || 0;
}

// Пакетный UPSERT: одна команда на пачку строк вместо тысяч отдельных
// INSERT. columns — список колонок, rows — массив массивов значений в том же
// порядке, conflict — колонки уникального ключа, update — какие колонки
// обновлять при конфликте (по умолчанию все, кроме ключа).
async function bulkUpsert(table, columns, rows, conflict, update, { chunk } = {}) {
  // Postgres принимает до 65535 параметров в одной команде — берём пачку
  // побольше (меньше обращений к удалённой БД), но в пределах лимита.
  chunk = chunk || Math.floor(60000 / columns.length);
  if (!rows.length) return 0;
  // Postgres не даёт одной командой обновить одну и ту же строку дважды —
  // убираем дубли по ключу (последнее значение побеждает).
  const keyIdx = conflict.map(c => columns.indexOf(c));
  const byKey = new Map();
  for (const row of rows) byKey.set(keyIdx.map(i => String(row[i])).join('|'), row);
  rows = [...byKey.values()];
  const upd = (update || columns.filter(c => !conflict.includes(c)))
    .map(c => (c.includes('=') ? c : `${c} = EXCLUDED.${c}`));
  const pool = getPool();
  let done = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params = [];
    const values = part.map(row => {
      const ph = row.map(v => { params.push(v); return `$${params.length}`; });
      return `(${ph.join(',')})`;
    });
    const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${values.join(',')}
      ON CONFLICT (${conflict.join(',')}) ${upd.length ? `DO UPDATE SET ${upd.join(', ')}` : 'DO NOTHING'}`;
    await pool.query(sql, params);
    done += part.length;
  }
  return done;
}

async function bulkInsert(table, columns, rows, { chunk } = {}) {
  if (!rows.length) return 0;
  chunk = chunk || Math.floor(60000 / columns.length);
  const pool = getPool();
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params = [];
    const values = part.map(row => `(${row.map(v => { params.push(v); return `$${params.length}`; }).join(',')})`);
    await pool.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values.join(',')}`, params);
  }
  return rows.length;
}

module.exports = { delay, mskDate, sellerHeaders, perfHeaders, request, parseRuNumber, bulkUpsert, bulkInsert };
