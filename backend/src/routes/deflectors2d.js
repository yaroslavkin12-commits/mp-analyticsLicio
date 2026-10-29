const express = require('express');
const { createHash } = require('crypto');
const { query, getPool } = require('../db');
const { catalog2d, demand2d } = require('../lib/deflectorsDemand');
const router = express.Router();
const KEY = 'prod:defly:deflectors2d:v1';
const empty = () => ({ revision: 0, draft: { settings: { multiple: 10, periodDays: 7, salesDays: 30, total: 140, fill: false, source: 'ozon' }, rows: [] }, journal: [] });
const model = () => import('../../../dashboard/src/lib/deflectors2d.mjs');
const wrap = fn => async (req, res) => {
  try {
    if ((req.query.cabinet || req.body?.cabinet || 'defly') !== 'defly') return res.status(400).json({ success: false, error: 'Подсорт 2D общий для производства Defly' });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: await fn(req) });
  } catch (e) { res.status(e.status || 400).json({ success: false, error: e.message }); }
};
router.get('/', wrap(async () => { const r = await query('SELECT value FROM app_settings WHERE key = $1', [KEY]); return r[0] ? JSON.parse(r[0].value) : empty(); }));
router.get('/catalog', wrap(async () => (await catalog2d()).articles));
router.get('/demand', wrap(req => demand2d(req.query.refresh === '1')));
async function mutate(req, journal) {
  const { validate2d, calculate2d } = await model();
  const draft = validate2d(req.body.draft);
  // Повтор уже сохранённого запроса возвращается даже после обновления продаж.
  const requestHash = journal ? createHash('sha256').update(JSON.stringify({ draft, offers: req.body.offers, requestId: req.body.requestId, columns: req.body.columns, date: req.body.date, note: req.body.note, demandVersion: req.body.demandVersion })).digest('hex') : null;
  if (journal) {
    const r = await query('SELECT value FROM app_settings WHERE key = $1', [KEY]);
    const current = r[0] ? JSON.parse(r[0].value) : empty();
    const existing = current.journal.find(j => j.id === req.body.requestId);
    if (existing?.requestHash) {
      if (existing.requestHash !== requestHash) throw Object.assign(new Error('Этот запрос уже сохранён с другим содержимым'), { status: 409 });
      return { ...current, savedId: existing.id };
    }
  }
  const demand = journal && (draft.settings.source === 'ozon' || req.body.demandVersion) ? await demand2d(true) : null;
  if (demand && demand.version !== req.body.demandVersion) throw Object.assign(new Error('Продажи Ozon обновились. Обновите продажи в таблице и проверьте подсорт перед записью.'), { status: 409 });
  const calculated = calculate2d(draft, demand);
  const expected = req.body.revision;
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('Не указана версия таблицы');
  let snapshot;
  if (journal) {
    if (calculated.issues.length) throw new Error(calculated.issues.join('; '));
    const offers = req.body.offers;
    if (!Array.isArray(offers) || !offers.length || new Set(offers).size !== offers.length) throw new Error('Выберите строки для подсорта');
    const byOffer = new Map(calculated.rows.map(r => [r.offer, r]));
    if (offers.some(o => !byOffer.has(o))) throw new Error('В подсорте есть неизвестный артикул');
    const items = offers.map(o => byOffer.get(o)).filter(r => r.quantity > 0);
    if (!items.length) throw new Error('Количество подсорта равно нулю');
    if (typeof req.body.requestId !== 'string' || !/^[\w-]{8,80}$/.test(req.body.requestId)) throw new Error('Не указан идентификатор сохранения');
    const columns = Array.isArray(req.body.columns) ? req.body.columns.filter(x => typeof x === 'string').slice(0, 30) : [];
    snapshot = { id: req.body.requestId, date: String(req.body.date || '').slice(0, 10), note: String(req.body.note || '').slice(0, 500), settings: draft.settings, annual: draft.annual ? { ...draft.annual, items: undefined } : null, demand: demand ? { version: demand.version, to: demand.to, loadedAt: demand.loadedAt, shops: demand.shops, ranges: demand.ranges } : null, requestHash, items, total: items.reduce((s, r) => s + r.quantity, 0), columns };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.date) || Number.isNaN(Date.parse(snapshot.date)) || new Date(snapshot.date).toISOString().slice(0, 10) !== snapshot.date) throw new Error('Укажите дату подачи подсорта');
    snapshot.fingerprint = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [KEY]);
    const r = await client.query('SELECT value FROM app_settings WHERE key = $1 FOR UPDATE', [KEY]);
    const current = r.rows[0] ? JSON.parse(r.rows[0].value) : empty();
    const existing = snapshot && current.journal.find(x => x.id === snapshot.id);
    if (existing) {
      if (existing.requestHash ? existing.requestHash !== requestHash : existing.fingerprint !== snapshot.fingerprint) throw Object.assign(new Error('Этот запрос уже сохранён с другим содержимым'), { status: 409 });
      await client.query('COMMIT'); return { ...current, savedId: existing.id };
    }
    if (current.revision !== expected) throw Object.assign(new Error('Таблица изменена на другом компьютере. Сохраните свои правки в файл и обновите данные перед записью.'), { status: 409 });
    const next = { revision: current.revision + 1, draft, journal: snapshot ? [{ ...snapshot, createdAt: new Date().toISOString() }, ...current.journal] : current.journal, updatedAt: new Date().toISOString() };
    await client.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [KEY, JSON.stringify(next)]);
    await client.query('COMMIT'); return { ...next, savedId: snapshot?.id || null };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
router.post('/draft', wrap(req => mutate(req, false)));
router.post('/journal', wrap(req => mutate(req, true)));
module.exports = router;
