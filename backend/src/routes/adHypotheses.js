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
    await query('ALTER TABLE ad_hypotheses ADD COLUMN IF NOT EXISTS sort_order INTEGER, ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');
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

const todayMoscow = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
const validId = id => typeof id === 'string' && /^[1-9]\d{0,17}$/.test(id);
const comparisonJson = comparison => comparison && Number.isFinite(comparison.before) && Number.isFinite(comparison.during)
  ? JSON.stringify({ before: comparison.before, during: comparison.during }) : null;

function hypothesisFields(body) {
  const { start, plannedEnd = null, goal } = body;
  const title = string(body.title, 140);
  const customGoal = goal === 'custom' ? string(body.customGoal, 100) : '';
  if (!title || !goals.has(goal) || (goal === 'custom' && !customGoal)
    || !isDate(start) || (plannedEnd !== null && (!isDate(plannedEnd) || plannedEnd < start))) return null;
  return [title, goal, customGoal, string(body.description, 5000), start, plannedEnd];
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
    const data = await query(`SELECT ${fields} FROM ad_hypotheses WHERE cabinet = $1 AND offer_id = $2 AND deleted_at IS NULL ORDER BY sort_order NULLS FIRST, id DESC`,
      [req.query.cabinet, req.query.offerId]);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const values = hypothesisFields(req.body || {});
    const mode = req.body?.mode;
    if (!values || !['all', 'ads'].includes(mode)) {
      return res.status(400).json({ success: false, error: 'Проверьте название, цель и даты теста' });
    }
    await ensureTable();
    const [data] = await query(`INSERT INTO ad_hypotheses
      (cabinet, offer_id, title, goal, custom_goal, description, starts_on, plans_end_on, mode)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${fields}`,
    [req.query.cabinet, req.query.offerId, ...values, mode]);
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const values = hypothesisFields(body);
    if (!validId(id) || !values) {
      return res.status(400).json({ success: false, error: 'Проверьте название, цель и даты теста' });
    }
    const { end = null, verdict, start } = body;
    if (end !== null && (!isDate(end) || end < start || end > todayMoscow() || !verdicts.has(verdict))) {
      return res.status(400).json({ success: false, error: 'Проверьте дату завершения и результат теста' });
    }
    await ensureTable();
    const [data] = await query(`UPDATE ad_hypotheses SET title = $4, goal = $5, custom_goal = $6, description = $7,
      starts_on = $8, plans_end_on = $9, ends_on = $10, verdict = $11, result_note = $12,
      comparison = CASE
        WHEN $10::date IS NULL OR $5 = 'custom' THEN NULL
        WHEN goal = $5 AND starts_on = $8 AND ends_on = $10 THEN comparison
        ELSE $13::jsonb END
      WHERE cabinet = $1 AND offer_id = $2 AND id = $3 AND deleted_at IS NULL
        AND (ends_on IS NULL) = ($10::date IS NULL)
      RETURNING ${fields}`, [req.query.cabinet, req.query.offerId, id, ...values, end,
      end === null ? null : verdict, end === null ? '' : string(body.note, 5000),
      end !== null ? comparisonJson(body.comparison) : null]);
    if (!data) return res.status(409).json({ success: false, error: 'Гипотеза удалена или её статус изменился. Обновите список.' });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.post('/:id/finish', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { end, verdict, comparison } = req.body || {};
    if (!validId(id) || !isDate(end) || end > todayMoscow() || !verdicts.has(verdict)) {
      return res.status(400).json({ success: false, error: 'Укажите дату завершения и результат теста' });
    }
    await ensureTable();
    const [data] = await query(`UPDATE ad_hypotheses SET ends_on = $4, verdict = $5, result_note = $6,
      comparison = CASE WHEN goal = 'custom' THEN NULL ELSE $7::jsonb END, finished_at = NOW()
      WHERE cabinet = $1 AND offer_id = $2 AND id = $3 AND deleted_at IS NULL AND ends_on IS NULL AND starts_on <= $4::date
      RETURNING ${fields}`, [req.query.cabinet, req.query.offerId, id, end, verdict, string(req.body?.note, 5000),
      comparisonJson(comparison)]);
    if (!data) return res.status(409).json({ success: false, error: 'Тест уже завершён или дата завершения раньше начала' });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.post('/reorder', async (req, res, next) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || !ids.length || ids.length > 5000 || new Set(ids).size !== ids.length || !ids.every(validId)) {
      return res.status(400).json({ success: false, error: 'Некорректный порядок гипотез' });
    }
    await ensureTable();
    const updated = await query(`
      WITH requested AS (SELECT id, position FROM unnest($3::bigint[]) WITH ORDINALITY AS r(id, position)),
      current AS MATERIALIZED (
        SELECT id FROM ad_hypotheses WHERE cabinet = $1 AND offer_id = $2 AND deleted_at IS NULL ORDER BY id FOR UPDATE
      )
      UPDATE ad_hypotheses h SET sort_order = r.position
        FROM requested r
        WHERE h.id = r.id AND h.id IN (SELECT id FROM current)
          AND NOT EXISTS (SELECT id FROM current EXCEPT SELECT id FROM requested)
          AND NOT EXISTS (SELECT id FROM requested EXCEPT SELECT id FROM current)
      RETURNING h.id`, [req.query.cabinet, req.query.offerId, ids]);
    if (updated.length !== ids.length) return res.status(409).json({ success: false, error: 'Список гипотез изменился. Порядок обновлён, попробуйте ещё раз.' });
    res.json({ success: true });
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: 'Некорректный номер гипотезы' });
    await ensureTable();
    const [removed] = await query(`UPDATE ad_hypotheses SET deleted_at = NOW()
      WHERE cabinet = $1 AND offer_id = $2 AND id = $3 AND deleted_at IS NULL RETURNING id`,
    [req.query.cabinet, req.query.offerId, req.params.id]);
    if (!removed) return res.status(404).json({ success: false, error: 'Гипотеза уже удалена или недоступна' });
    res.json({ success: true });
  } catch (error) { next(error); }
});

module.exports = router;
