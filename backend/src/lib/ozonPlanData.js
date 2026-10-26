const dayjs = require('dayjs');
dayjs.extend(require('dayjs/plugin/utc'));
dayjs.extend(require('dayjs/plugin/timezone'));
const { query } = require('../db');
const { CABINETS, isConnected } = require('../config/cabinets');
const { loadPnl, loadCoefs, meta } = require('../routes/finance');
const { loadSales } = require('../routes/sales');
const { SHOPS, taxonomy, leafPath } = require('./ozonPlan');
const models = Promise.all([import('../../../dashboard/src/lib/pnlCalc.js'), import('../../../dashboard/src/pages/unitModel.js')]);
const today = () => dayjs().tz('Europe/Moscow').startOf('day');
// База распределения использует полные дни по вчера. Выполнение ниже включает
// и сегодня: новые начисления уточняют результат при каждом обновлении.
const cutoff = () => today().subtract(1, 'day').format('YYYY-MM-DD');
const validDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && dayjs(v).isValid() && dayjs(v).format('YYYY-MM-DD') === v;
function validMonth(m) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(m || ''); }
function defaultPeriod(month) {
  const prev = dayjs(month + '-01').subtract(1, 'day').format('YYYY-MM-DD');
  const to = prev < cutoff() ? prev : cutoff();
  return { from: dayjs(to).subtract(29, 'day').format('YYYY-MM-DD'), to };
}
function checkPeriod(from, to) {
  if (!validDate(from) || !validDate(to) || from > to || dayjs(to).diff(from, 'day') > 91) throw new Error('Период базы: от 1 до 92 дней');
  if (to > cutoff()) throw new Error(`Для базы доступны полные дни по ${cutoff()}; текущий день используется в выполнении предварительно`);
}
async function catalogs(ids = SHOPS) {
  const out = {}, errors = {};
  for (const shop of ids) {
    try { out[shop] = (await meta(shop)).articles; }
    catch (e) { out[shop] = []; errors[shop] = e.message; }
  }
  return { out, errors };
}
async function report(shop, from, to, tax, source, frozen, openDay = false) {
  const label = CABINETS[shop].label;
  if (!isConnected(shop)) return { label, error: 'магазин не подключён', byPath: {} };
  try {
    const [{ pnlTotals }, { unitCoefs, unitProfit }] = await models;
    const data = await loadPnl({ cabinet: shop, dateFrom: from, dateTo: to });
    const pathOf = a => frozen?.[a.o] || tax.byShop[shop]?.[a.o] || leafPath(a.cat, tax.branches);
    const result = pnlTotals(data, { tax: 0, groupOf: pathOf, withDays: true });
    const byPath = result.byGroup;
    const available = data.available || {};
    const requiredTo = openDay ? cutoff() : to;
    const partial = !available.mn || available.mn > from || !available.mx || available.mx < requiredTo;
    const [job] = await query(`SELECT last_success_at, last_error FROM ad_job_status WHERE cabinet = $1 AND job = 'finance'`, [shop]);
    let forecastError = null;
    if (source === 'forecast') {
      try {
        const coefs = await loadCoefs({ cabinet: shop });
        const sales = await loadSales({ cabinet: shop, dateFrom: from, dateTo: to });
        const arts = coefs.articles.map(a => ({ ...a, parts: String(a.cat || 'Без категории').split(' / ') }));
        const ks = unitCoefs(coefs, arts), byOffer = new Map(arts.map((a, i) => [a.o, ks[i]]));
        const fbs = new Map((coefs.fbsDays || []).filter(r => r[2] > 0).map(([ai, d, o, f]) => [coefs.articles[ai].o + '|' + d, f / o]));
        for (const r of sales.rows) {
          const a = sales.articles[r[0]], path = pathOf(a), k = byOffer.get(a.o);
          const out = byPath[path] || (byPath[path] = { qty: 0, payout: 0, days: [] });
          const fc = out.forecast || (out.forecast = { qty: 0, payout: 0 });
          if (!k) { if (r[5] || r[7] || r[8]) fc.missing = true; continue; }
          const v = unitProfit(k, { ordRub: r[6], ordQty: r[5], ads: (r[7] || 0) + (r[8] || 0), fbs: fbs.get(a.o + '|' + sales.dates[r[1]]) }, 0);
          fc.qty += v.expQty; fc.payout += v.expRev - v.comm - v.logi - v.acq - v.other - v.ads;
        }
      } catch (e) { forecastError = e.message; }
    }
    return { label, byPath, partial, available, updatedAt: job?.last_success_at || null, collectionError: job?.last_error || null, forecastError };
  } catch (e) { return { label, error: e.message, byPath: {} }; }
}
const basisCache = new Map();
// Агрегации пяти кабинетов выполняются последовательно: не держим несколько
// комплектов финансов и заказов одновременно на небольшом сервере Render.
let tail = Promise.resolve();
function serial(fn) { const job = tail.then(fn, fn); tail = job.catch(() => {}); return job; }
async function basis(from, to, source, force = false, ids = SHOPS) {
  checkPeriod(from, to);
  const key = `${ids.join(",")}|${from}|${to}|${source}`;
  const hit = basisCache.get(key);
  if (!force && hit && Date.now() - hit.at < 60000) return hit.promise;
  const promise = serial(async () => {
    const cat = await catalogs(ids), tax = taxonomy(cat.out, [], ids), shops = {};
    for (const shop of ids) {
      shops[shop] = cat.errors[shop] ? { label: CABINETS[shop].label, error: cat.errors[shop], byPath: {} } : await report(shop, from, to, tax, source);
    }
    return { from, to, source, asOf: new Date().toISOString(), cutoff: cutoff(), paths: tax.paths, taxonomy: tax.byShop, shops };
  });
  basisCache.set(key, { at: Date.now(), promise });
  if (basisCache.size > 4) basisCache.delete(basisCache.keys().next().value);
  return promise;
}
async function loadExecution(month, snapshot, ids = SHOPS) {
  const now = dayjs().tz('Europe/Moscow'), current = now.format('YYYY-MM-DD');
  const from = month + '-01', end = dayjs(from).endOf('month').format('YYYY-MM-DD'), to = end < current ? end : current;
  if (to < from) return { from, to: null, shops: {}, future: true };
  const cat = await catalogs(ids), tax = taxonomy(cat.out, snapshot?.targets.map(t => t.path) || [], ids), shops = {};
  const provisional = to === current;
  for (const shop of ids) shops[shop] = await report(shop, from, to, tax, 'fact', snapshot?.taxonomy?.[shop], provisional);
  const fraction = (now.hour() * 3600 + now.minute() * 60 + now.second()) / 86400;
  const elapsedDays = provisional ? now.date() - 1 + fraction : dayjs(to).date();
  return { from, to, shops, asOf: now.toISOString(), future: false, provisional, elapsedDays, evaluatedAtMoscow: now.format('HH:mm') };
}
const execution = (month, snapshot, ids = SHOPS) => serial(() => loadExecution(month, snapshot, ids));
module.exports = { today, cutoff, validMonth, defaultPeriod, checkPeriod, catalogs, basis, execution };
