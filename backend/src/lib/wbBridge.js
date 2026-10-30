const crypto = require('crypto');
const { query, getPool } = require('../db');
const CABINET = 'defly_wb';
const KINDS = ['catalog', 'orders', 'sales', 'stocks', 'campaigns', 'ads', 'prices', 'finance'];
let ready;
function ensure() {
  if (!ready) ready = (async () => {
    await query(`CREATE TABLE IF NOT EXISTS wb_bridge_data (cabinet TEXT NOT NULL, kind TEXT NOT NULL, run_id TEXT NOT NULL, collected_at TIMESTAMPTZ NOT NULL, meta JSONB NOT NULL, rows JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY(cabinet, kind))`);
    await query(`CREATE TABLE IF NOT EXISTS wb_bridge_parts (cabinet TEXT NOT NULL, kind TEXT NOT NULL, run_id TEXT NOT NULL, part INT NOT NULL, hash TEXT NOT NULL, meta JSONB NOT NULL, rows JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY(cabinet,kind,run_id,part))`);
  })().catch(e => { ready = null; throw e; });
  return ready;
}
function verify(raw, timestamp, signature, now = Date.now(), secret = process.env.WB_SYNC_SECRET) {
  if (!secret || secret.length < 32) throw Object.assign(new Error('На сервере не настроен WB_SYNC_SECRET (не менее 32 символов)'), { status: 503 });
  if (!raw || !/^\d{13}$/.test(String(timestamp || '')) || Math.abs(now - Number(timestamp)) > 300000 || !/^[a-f0-9]{64}$/i.test(signature || '')) throw Object.assign(new Error('Подпись синхронизации WB недействительна'), { status: 401 });
  const expected = crypto.createHmac('sha256', secret).update(String(timestamp) + '.' + raw.toString('utf8')).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw Object.assign(new Error('Подпись синхронизации WB недействительна'), { status: 401 });
}
function validate(input) {
  const { cabinet, kind, runId, collectedAt, from, to, part, parts, total, rows } = input || {};
  if (cabinet !== CABINET || !KINDS.includes(kind)) throw new Error('Неизвестный кабинет или набор WB');
  if (!/^[\w-]{8,80}$/.test(runId || '') || !Number.isFinite(Date.parse(collectedAt)) || Date.parse(collectedAt) > Date.now() + 300000) throw new Error('Некорректная версия WB');
  if (![part, parts, total].every(Number.isSafeInteger) || parts < 1 || parts > 200 || part < 0 || part >= parts || total < 0 || total > 150000 || !Array.isArray(rows) || rows.length > 1000) throw new Error('Некорректный пакет WB');
  if (['orders', 'sales', 'ads', 'finance'].includes(kind) && (![from, to].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d) || from > to)) throw new Error('Некорректный период WB');
  if (rows.some(r => !r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || r.id.length > 250)) throw new Error('У строки WB отсутствует идентификатор');
  if (kind === 'finance' && rows.some(r => !/^[1-9]\d*$/.test(r.reportId || '') || !/^[1-9]\d*$/.test(r.rrdId || '') || typeof r.reportId !== 'string' || typeof r.rrdId !== 'string' || r.id !== r.reportId + '|' + r.rrdId)) throw new Error('Некорректные точные идентификаторы финансов WB');
  return { meta: { cabinet, kind, runId, collectedAt, from: from || null, to: to || null, parts, total, warning: String(input.warning || '').slice(0, 500) }, part, rows };
}
async function ingest(input) {
  const { meta, part, rows } = validate(input); await ensure();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [meta.cabinet + ':' + meta.kind]);
    const current = (await client.query('SELECT run_id, collected_at FROM wb_bridge_data WHERE cabinet=$1 AND kind=$2', [meta.cabinet, meta.kind])).rows[0];
    if (current?.run_id === meta.runId) { await client.query('COMMIT'); return { complete: true, duplicate: true }; }
    if (current && Date.parse(current.collected_at) > Date.parse(meta.collectedAt)) throw new Error('Уже получена более новая версия WB');
    const hash = crypto.createHash('sha256').update(JSON.stringify({ meta, rows })).digest('hex');
    const previous = (await client.query('SELECT hash FROM wb_bridge_parts WHERE cabinet=$1 AND kind=$2 AND run_id=$3 AND part=$4', [meta.cabinet, meta.kind, meta.runId, part])).rows[0];
    if (previous && previous.hash !== hash) throw new Error('Повторный пакет WB отличается от первого');
    await client.query(`INSERT INTO wb_bridge_parts(cabinet,kind,run_id,part,hash,meta,rows) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ON CONFLICT DO NOTHING`, [meta.cabinet, meta.kind, meta.runId, part, hash, JSON.stringify(meta), JSON.stringify(rows)]);
    const chunks = (await client.query('SELECT part, meta, rows FROM wb_bridge_parts WHERE cabinet=$1 AND kind=$2 AND run_id=$3 ORDER BY part', [meta.cabinet, meta.kind, meta.runId])).rows;
    let complete = false;
    if (chunks.length === meta.parts) {
      if (chunks.some((c, i) => c.part !== i || JSON.stringify(c.meta) !== JSON.stringify(chunks[0].meta))) throw new Error('Пакеты WB относятся к разным версиям');
      const all = chunks.flatMap(c => c.rows);
      if (all.length !== meta.total || new Set(all.map(r => r.id)).size !== all.length) throw new Error('Количество или идентификаторы строк WB не совпадают');
      await client.query(`INSERT INTO wb_bridge_data(cabinet,kind,run_id,collected_at,meta,rows) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT(cabinet,kind) DO UPDATE SET run_id=EXCLUDED.run_id,collected_at=EXCLUDED.collected_at,meta=EXCLUDED.meta,rows=EXCLUDED.rows,updated_at=NOW()`, [meta.cabinet, meta.kind, meta.runId, meta.collectedAt, JSON.stringify(meta), JSON.stringify(all)]);
      await client.query('DELETE FROM wb_bridge_parts WHERE cabinet=$1 AND kind=$2 AND run_id=$3', [meta.cabinet, meta.kind, meta.runId]);
      complete = true;
    }
    await client.query("DELETE FROM wb_bridge_parts WHERE created_at < NOW() - INTERVAL '1 day'");
    await client.query('COMMIT');
    if (complete) require('./dataVersion').bump();
    return { complete, received: chunks.length, parts: meta.parts };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
async function read({ excludeFinance = false } = {}) { await ensure(); return query('SELECT kind, meta, rows, updated_at FROM wb_bridge_data WHERE cabinet=$1' + (excludeFinance ? " AND kind <> 'finance'" : ''), [CABINET]); }
async function readMeta() { await ensure(); return query('SELECT kind, meta, updated_at FROM wb_bridge_data WHERE cabinet=$1', [CABINET]); }
module.exports = { CABINET, KINDS, verify, validate, ingest, read, readMeta };
