const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 10,
    });
  }
  return pool;
}

// Автоматически конвертирует MySQL-стиль ? в PostgreSQL $1, $2...
function toPostgres(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function query(sql, params = []) {
  const pgSql = toPostgres(sql);
  const { rows } = await getPool().query(pgSql, params);
  return rows;
}

async function initSchema() {
  const fs = require('fs');
  const path = require('path');
  const sqlFile = path.join(__dirname, '../../postgres/init.sql');
  if (!fs.existsSync(sqlFile)) return;
  const sql = fs.readFileSync(sqlFile, 'utf8');
  // Выполняем каждый блок отдельно
  const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    try {
      await getPool().query(stmt);
    } catch (e) {
      // Если таблица уже есть — нормально
      if (!e.message.includes('already exists')) {
        console.error('Schema init error:', e.message.slice(0, 100));
      }
    }
  }
  console.log('✅ Database schema ready');
}

async function testConnection() {
  try {
    await getPool().query('SELECT 1');
    console.log('✅ PostgreSQL connected');
    return true;
  } catch (e) {
    console.error('❌ DB connection failed:', e.message);
    return false;
  }
}

module.exports = { query, getPool, testConnection, initSchema };
