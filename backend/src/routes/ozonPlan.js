const express = require('express');
const { randomUUID } = require('crypto');
const { query, getPool } = require('../db');
const { SHOPS: DEFAULT_SHOPS, allocate } = require('../lib/ozonPlan');
const data = require('../lib/ozonPlanData');
const router = express.Router();
const scopeOf = req => { const s = req.query.scope || req.body?.scope || 'ozon'; if (!['ozon', 'licio'].includes(s)) throw new Error('Неизвестная область плана'); return s; };
const shopsOf = scope => scope === 'licio' ? ['licio'] : DEFAULT_SHOPS;
const key = (month, scope = 'ozon') => `plan:${scope}:v2:${month}`;
const previews = new Map();
const empty = () => ({ schema: 2, revision: 0, activeId: null, versions: [] });
const monthOf = req => {
  const m = req.query.month || req.body?.month;
  if (!data.validMonth(m)) throw new Error('Нужен месяц в формате ГГГГ-ММ');
  return m;
};
async function load(month, scope = 'ozon') {
  const [r] = await query('SELECT value FROM app_settings WHERE key = $1', [key(month, scope)]);
  return r ? JSON.parse(r.value) : empty();
}
const wrap = fn => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (e) { res.status(e.status || 400).json({ success: false, error: e.message }); }
};
router.get('/', wrap(async req => {
  const month = monthOf(req), scope = scopeOf(req), SHOPS = shopsOf(scope), state = await load(month, scope);
  const legacyRows = await query('SELECT key, value FROM app_settings WHERE key = ANY($1::text[])', [SHOPS.map(s => `plan:${s}:${month}`)]);
  return { ...state, month, defaultPeriod: data.defaultPeriod(month), cutoff: data.cutoff(), legacy: legacyRows.map(r => ({ shop: r.key.split(':')[1], plan: JSON.parse(r.value) })) };
}));
router.get('/basis', wrap(async req => {
  const month = monthOf(req), scope = scopeOf(req), SHOPS = shopsOf(scope), defaults = data.defaultPeriod(month);
  const source = req.query.source === 'forecast' ? 'forecast' : 'fact';
  return data.basis(req.query.from || defaults.from, req.query.to || defaults.to, source, Number(req.query.refresh) > 0, SHOPS);
}));
router.post('/preview', wrap(async req => {
  const month = monthOf(req), scope = scopeOf(req), SHOPS = shopsOf(scope), { from, to, source = 'fact', targets, expectedRevision } = req.body;
  if (!['fact', 'forecast'].includes(source)) throw new Error('Неизвестный источник поступления');
  const state = await load(month, scope);
  if (state.revision !== expectedRevision) { const e = new Error('Общий план изменён в другом окне. Обновите страницу перед пересчётом'); e.status = 409; throw e; }
  const basis = await data.basis(from, to, source, false, SHOPS);
  const result = allocate(targets, basis, source, SHOPS);
  const known = new Set(basis.paths);
  if (result.targets.some(t => !known.has(t.path))) result.errors.push('Категория отсутствует в текущем каталоге. Проверьте период и категории');
  const id = randomUUID(), snapshot = { id, month, createdAt: new Date().toISOString(), methodology: 'pnl-v1; net-buyouts; largest-remainder; weighted-ratio-v1', basis: { from, to, source, asOf: basis.asOf, shops: Object.fromEntries(SHOPS.map(s => [s, { available: basis.shops[s].available, updatedAt: basis.shops[s].updatedAt, partial: basis.shops[s].partial, error: basis.shops[s].error }])) }, taxonomy: basis.taxonomy, ...result };
  if (!result.errors.length) {
    previews.set(id, { scope, at: Date.now(), expectedRevision, snapshot });
    if (previews.size > 20) previews.delete(previews.keys().next().value);
  }
  return snapshot;
}));
router.post('/fix', wrap(async req => {
  const month = monthOf(req), scope = scopeOf(req), entry = previews.get(req.body.previewId);
  if (!entry || entry.scope !== scope || Date.now() - entry.at > 30 * 60000 || entry.snapshot.month !== month) throw new Error('Предпросмотр истёк или сервер перезапустился. Постройте его снова');
  if (entry.snapshot.warnings.length && !req.body.acknowledgeWarnings) throw new Error('Подтвердите предупреждения распределения');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Общая блокировка месяца защищает и первую запись, когда строки ещё нет.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key(month, scope)]);
    const result = await client.query('SELECT value FROM app_settings WHERE key = $1 FOR UPDATE', [key(month, scope)]);
    const state = result.rows[0] ? JSON.parse(result.rows[0].value) : empty();
    if (state.revision !== entry.expectedRevision) { const e = new Error('Другой пользователь уже изменил план. Обновите страницу и предпросмотр'); e.status = 409; throw e; }
    const snapshot = { ...entry.snapshot, createdAt: new Date().toISOString(), note: String(req.body.note || '').slice(0, 300) };
    const next = { schema: 2, revision: state.revision + 1, activeId: snapshot.id, versions: [...state.versions, snapshot] };
    await client.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key(month, scope), JSON.stringify(next)]);
    await client.query('COMMIT');
    previews.delete(snapshot.id);
    return next;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));
router.get('/execution', wrap(async req => {
  const month = monthOf(req), scope = scopeOf(req), SHOPS = shopsOf(scope), state = await load(month, scope);
  const id = req.query.version || state.activeId, snapshot = state.versions.find(v => v.id === id);
  if (id && !snapshot) throw new Error('Версия плана не найдена');
  return { snapshot: snapshot || null, revision: state.revision, ...await data.execution(month, snapshot, SHOPS) };
}));
module.exports = router;
