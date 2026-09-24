const axios = require('axios');
const { mskDate, perfHeaders, request, parseRuNumber, bulkUpsert } = require('./ozonHttp');

// Показы/клики/заказы по рекламным кампаниям по дням — синхронный метод
// Performance API GET /api/client/statistics/daily/json.
//
// Раньше клики собирались через асинхронные CSV-отчёты (POST statistics ->
// ожидание -> скачивание ZIP), не больше 10 кампаний в отчёте и только один
// отчёт одновременно на аккаунт. Отчёты часто не успевали сформироваться
// ("state=NOT_STARTED"), и клики за дни оставались пустыми. Проверено живым
// запросом 24.09: daily/json отдаёт все кампании сразу, за 7 дней, за ~0.2
// сек (id, date, views, clicks, moneySpent, orders, ordersMoney).
async function collectClicks(cabinet, { dateFrom, dateTo } = {}) {
  const headers = await perfHeaders(cabinet);
  if (!headers) { console.log(`[Clicks:${cabinet}] Performance API не настроен`); return { rows: 0 }; }
  const from = dateFrom || mskDate(13);
  const to = dateTo || mskDate(0);

  const data = await request(() => axios.get('https://api-performance.ozon.ru/api/client/statistics/daily/json',
    { headers, params: { dateFrom: from, dateTo: to }, timeout: 60000 }).then(r => r.data), `Дневная статистика РК ${from}..${to}`);
  const list = data?.rows || data?.list || (Array.isArray(data) ? data : []);

  const rows = [];
  for (const r of list) {
    const campaignId = String(r.id ?? r.campaignId ?? '');
    if (!campaignId || !r.date) continue;
    const views = parseRuNumber(r.views), clicks = parseRuNumber(r.clicks);
    rows.push([cabinet, 'ozon', r.date, campaignId, views, clicks,
      views > 0 ? clicks / views * 100 : 0,
      clicks > 0 ? parseRuNumber(r.moneySpent) / clicks : 0,
      parseRuNumber(r.orders), parseRuNumber(r.ordersMoney), new Date()]);
  }
  // Расход (spend) здесь НЕ трогаем — его пишет сборщик расходов
  // (statistics/expense/json), он охватывает и кампании с оплатой за заказ.
  const saved = await bulkUpsert('ad_stats_daily',
    ['cabinet', 'platform', 'date', 'campaign_id', 'views', 'clicks', 'ctr', 'avg_bid', 'orders', 'orders_money', 'collected_at'],
    rows, ['cabinet', 'platform', 'date', 'campaign_id']);
  console.log(`[Clicks:${cabinet}] ${from}..${to}: строк ${saved}`);
  return { rows: saved };
}

module.exports = { collectClicks };
