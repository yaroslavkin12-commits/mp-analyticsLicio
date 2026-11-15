const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

let pool;
const recent=[];let queryCount=0,errors=0;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // База на том же сервере (Яндекс) — без SSL; внешняя (Neon) — с SSL.
      ssl: process.env.NODE_ENV === 'production' && !/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '') ? { rejectUnauthorized: false } : false,
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
  const p=getPool(),start=performance.now(),waiting=p.waitingCount||0;queryCount++;
  let rows,error;
  try{({rows}=await p.query(toPostgres(sql),params));return rows;}
  catch(e){error=e.code||'error';errors++;throw e;}
  finally{
    const ms=Math.round(performance.now()-start);
    if(ms>=250||error){
      const operation=String(sql).trim().match(/^\w+/)?.[0]?.toUpperCase()||'OTHER';
      const relation=String(sql).match(/\b(?:FROM|UPDATE|INTO|TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z_0-9]*)/i)?.[1]||'other';
      recent.push({at:new Date().toISOString(),operation,relation,ms,rows:rows?.length??0,waiting,...(error?{error}:{} )});if(recent.length>32)recent.shift();
    }
  }
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

module.exports = { query, getPool, testConnection, initSchema, diagnostics:()=>({queries:queryCount,errors,pool:pool?{total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount}:null,recent:[...recent]}) };
