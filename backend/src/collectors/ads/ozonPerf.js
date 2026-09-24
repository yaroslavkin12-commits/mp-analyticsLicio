const axios = require('axios');
const { query } = require('../../db');
const { delay, mskDate, perfHeaders, request, parseRuNumber, bulkUpsert } = require('./ozonHttp');

// Кампании (метаданные + привязка к артикулу) и расход по дням.
//
// Что было медленным: на КАЖДЫЙ прогон для каждой из ~620 активных кампаний
// отдельным запросом спрашивался список товаров (с паузой 350 мс) — 5-7
// минут только на это, хотя реально тратят деньги ~25 кампаний в день.
// Теперь список товаров спрашиваем только у кампаний, у которых был расход
// за период, и не чаще раза в сутки на кампанию — привязка сохраняется в БД.

async function getCampaignSkus(campaignId, headers) {
  try {
    const data = await request(() => axios.get(
      `https://api-performance.ozon.ru/api/client/campaign/${campaignId}/v2/products`,
      { headers, timeout: 20000 }).then(r => r.data), `Товары РК ${campaignId}`, { attempts: 3 });
    return (data?.products || []).map(p => String(p.sku)).filter(Boolean);
  } catch (e) { return []; }
}

// Запасной вариант, когда Ozon не отдаёт товары кампании: ищем offer_id в
// названии кампании.
function matchOfferByTitle(title, catalogByOfferId) {
  if (!title) return null;
  const t = title.trim().toLowerCase();
  if (catalogByOfferId.has(t)) return catalogByOfferId.get(t);
  for (const [offerId, row] of catalogByOfferId) {
    if (offerId && offerId.length >= 4 && t.includes(offerId)) return row;
  }
  return null;
}

async function collectAdStats(cabinet, { dateFrom, dateTo } = {}) {
  const headers = await perfHeaders(cabinet);
  if (!headers) { console.log(`[Perf:${cabinet}] Performance API не настроен`); return { rows: 0 }; }
  const from = dateFrom || mskDate(13);
  const to = dateTo || mskDate(0);

  // 1. Список кампаний — метаданные, без трогания привязки к артикулу.
  const listData = await request(() => axios.get('https://api-performance.ozon.ru/api/client/campaign',
    { headers, timeout: 60000 }).then(r => r.data), 'Список кампаний');
  const campaigns = listData?.list || [];
  await bulkUpsert('ad_campaigns',
    ['cabinet', 'platform', 'campaign_id', 'title', 'state', 'adv_object_type', 'payment_type',
     'autopilot_strategy', 'placement', 'expense_strategy', 'updated_at'],
    campaigns.map(c => [cabinet, 'ozon', String(c.id), c.title ? String(c.title).slice(0, 500) : null, c.state || null, c.advObjectType || null,
      c.PaymentType || c.paymentType || null, c.productAutopilotStrategy || null,
      (Array.isArray(c.placement) ? c.placement.join(',') : (c.placement || '')).slice(0, 128) || null,
      c.expenseStrategy || null, new Date()]),
    ['cabinet', 'platform', 'campaign_id']);

  // 2. Расход по дням — один запрос на весь период по всем кампаниям.
  const expData = await request(() => axios.get('https://api-performance.ozon.ru/api/client/statistics/expense/json',
    { headers, params: { dateFrom: from, dateTo: to }, timeout: 60000 }).then(r => r.data), `Расход ${from}..${to}`);
  const expenseRows = expData?.rows || expData?.list || (Array.isArray(expData) ? expData : []);
  const spendRows = [];
  const activeIds = new Set();
  for (const r of expenseRows) {
    const campaignId = String(r.id ?? r.campaignId ?? r.campaign_id ?? '');
    if (!campaignId || !r.date) continue;
    const spend = parseRuNumber(r.moneySpent);
    if (spend > 0) activeIds.add(campaignId);
    spendRows.push([cabinet, 'ozon', r.date, campaignId, spend, new Date()]);
  }
  const saved = await bulkUpsert('ad_stats_daily', ['cabinet', 'platform', 'date', 'campaign_id', 'spend', 'collected_at'],
    spendRows, ['cabinet', 'platform', 'date', 'campaign_id']);

  // 3. Привязка кампаний к артикулам.
  const catalogRows = await query(`SELECT offer_id, sku FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet]);
  const catalogByOfferId = new Map(catalogRows.map(r => [String(r.offer_id).toLowerCase(), r]));
  const catalogBySku = new Map(catalogRows.filter(r => r.sku != null).map(r => [String(r.sku), r]));
  const known = await query(
    `SELECT campaign_id, title, matched_offer_id, sku_checked_at FROM ad_campaigns WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet]);
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  let checked = 0;
  for (const c of known) {
    const needApi = activeIds.has(c.campaign_id) && (!c.sku_checked_at || new Date(c.sku_checked_at).getTime() < dayAgo);
    if (needApi) {
      const skus = await getCampaignSkus(c.campaign_id, headers);
      let match = null;
      for (const sku of skus) if (catalogBySku.has(sku)) { match = catalogBySku.get(sku); break; }
      if (!match) match = matchOfferByTitle(c.title, catalogByOfferId);
      await query(
        `UPDATE ad_campaigns SET matched_offer_id = COALESCE($3, matched_offer_id), matched_sku = COALESCE($4, matched_sku),
           sku_checked_at = NOW() WHERE cabinet = $1 AND platform = 'ozon' AND campaign_id = $2`,
        [cabinet, c.campaign_id, match?.offer_id || null, match?.sku || null]);
      checked++;
      await delay(250);
    } else if (!c.matched_offer_id) {
      const match = matchOfferByTitle(c.title, catalogByOfferId);
      if (match) {
        await query(`UPDATE ad_campaigns SET matched_offer_id = $3, matched_sku = $4 WHERE cabinet = $1 AND platform = 'ozon' AND campaign_id = $2`,
          [cabinet, c.campaign_id, match.offer_id, match.sku || null]);
      }
    }
  }
  console.log(`[Perf:${cabinet}] Кампаний ${campaigns.length}, строк расхода ${saved}, проверено привязок ${checked}`);
  return { rows: saved };
}

module.exports = { collectAdStats };
