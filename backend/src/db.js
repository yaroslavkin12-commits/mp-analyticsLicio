const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 10,
      // Без этого зависший или заблокированный запрос (например, ожидание
      // лока от другого долгого INSERT) держит соединение из пула вечно —
      // следующие запросы (включая mark() в jobs.js) просто бесконечно ждут
      // свободного клиента, и busy-лок кабинета никогда не снимается.
      // С таймаутами зависание превращается в быструю явную ошибку.
      connectionTimeoutMillis: 10000,   // не ждать свободное соединение дольше 10с
      statement_timeout: 20000,          // Postgres сам обрубит запрос дольше 20с
      query_timeout: 25000,              // то же самое на стороне клиента node-postgres
      idle_in_transaction_session_timeout: 20000,
    });
  }
  return pool;
}

function toPostgres(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function query(sql, params = []) {
  const { rows } = await getPool().query(toPostgres(sql), params);
  return rows;
}

async function initSchema() {
  const sqlFile = path.join(__dirname, '../../postgres/init.sql');
  if (!fs.existsSync(sqlFile)) return;
  // Комментарии вырезаем ДО разбиения по ";" — иначе ";" внутри комментария
  // ломает следующий CREATE (так однажды молча не создалась
  // ad_campaign_skus: её комментарий содержал точку с запятой).
  const sql = fs.readFileSync(sqlFile, 'utf8').replace(/--[^\n]*/g, '');
  const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    try { await getPool().query(stmt); } catch (e) {
      if (!e.message.includes('already exists')) console.error('Schema:', e.message.slice(0,80));
    }
  }
  console.log('✅ Database schema ready');
}

async function testConnection() {
  try { await getPool().query('SELECT 1'); console.log('✅ PostgreSQL connected'); return true; }
  catch (e) { console.error('❌ DB error:', e.message); return false; }
}

module.exports = { query, getPool, testConnection, initSchema };
