const express = require('express');
const { query } = require('../db');
const { CABINETS } = require('../config/cabinets');

const router = express.Router();
const goals = new Set(['ctr', 'crToCart', 'crToOrder', 'drr', 'spend', 'profitF', 'orders', 'payoutPerBuyoutF', 'custom']);
const verdicts = new Set(['worked', 'failed', 'unclear']);
const fields = `id::text, title, goal, custom_goal AS "customGoal", description,
  starts_on::text AS "start", plans_end_on::text AS "plannedEnd",
  ends_on::text AS "end", mode, verdict, result_note AS note, comparison`;

let ready;
function ensureTable() {
  if (!ready) ready = (async () => {
    await query(`CREATE TABLE IF NOT EXISTS ad_hypotheses (
      id BIGSERIAL PRIMARY KEY, cabinet TEXT NOT NULL, offer_id TEXT NOT NULL,
      title TEXT NOT NULL, goal TEXT NOT NULL, custom_goal TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '', starts_on DATE NOT NULL, plans_end_on DATE,
      ends_on DATE, mode TEXT NOT NULL, verdict TEXT, result_note TEXT NOT NULL DEFAULT '',
      comparison JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ, CHECK (plans_end_on >= starts_on), CHECK (ends_on >= starts_on)
    )`);
    await query('CREATE INDEX IF NOT EXISTS ad_hypotheses_article ON ad_hypotheses (cabinet, offer_id, id DESC)');
  })().catch(error => { ready = null; throw error; });
  return ready;
}

const string = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
function isDate(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

router.use((req, res, next) => {
  const { cabinet, offerId } = req.query;
  if (typeof cabinet !== 'string' || !Object.hasOwn(CABINETS, cabinet) || typeof offerId !== 'string' || !offerId.trim() || offerId.length > 128) {
    return res.status(400).json({ success: false, error: 'Укажите кабинет и артикул' });
  }
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/', async (req, res, next) => {
  try {
    await ensureTable();
    const data = await query(`SELECT ${fields} FROM ad_hypotheses WHERE cabinet = $1 AND offer_id = $2 ORDER BY id DESC`,
      [req.query.cabinet, req.query.offerId]);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const { start, plannedEnd, goal, mode } = req.body || {};
    const title = string(req.body?.title, 140), customGoal = goal === 'custom' ? string(req.body?.customGoal, 100) : '';
    if (!title || !goals.has(goal) || (goal === 'custom' && !customGoal) || !['all', 'ads'].includes(mode)
      || !isDate(start) || (plannedEnd != null && (!isDate(plannedEnd) || plannedEnd < start))) {
      return res.status(400).json({ success: false, error: 'Проверьте название, цель и даты теста' });
    }
    await ensureTable();
    const [data] = await query(`INSERT INTO ad_hypotheses
      (cabinet, offer_id, title, goal, custom_goal, description, starts_on, plans_end_on, mode)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${fields}`,
    [req.query.cabinet, req.query.offerId, title, goal, customGoal, string(req.body?.description, 5000), start, plannedEnd ?? null, mode]);
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
});

router.post('/:id/finish', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { end, verdict, comparison } = req.body || {};
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
    if (!/^[1-9]\d{0,17}$/.test(id) || !isDate(end) || end > today || !verdicts.has(verdict)) {
      return res.status(400).json({ success: false, error: 'Укажите дату завершения и результат теста' });
    }
    const snapshot = comparison && Number.isFinite(comparison.before) && Number.isFinite(comparison.during)
      ? { before: comparison.before, during: comparison.during } : null;
    await ensureTable();
    const [data] = await query(`UPDATE ad_hypotheses SET ends_on = $4, verdict = $5, result_note = $6,
      comparison = CASE WHEN goal = 'custom' THEN NULL ELSE $7::jsonb END, finished_at = NOW()
      WHERE cabinet = $1 AND offer_id = $2 AND id = $3 AND ends_on IS NULL AND starts_on <= $4::date
      RETURNING ${fields}`, [req.query.cabinet, req.query.offerId, id, end, verdict, string(req.body?.note, 5000),
      snapshot ? JSON.stringify(snapshot) : null]);
    if (!data) return res.status(409).json({ success: false, error: 'Тест уже завершён или дата завершения раньше начала' });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

module.exports = router;
