const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../../db');
const { delay, mskDate, sellerHeaders, request, bulkUpsert } = require('./ozonHttp');

// Аналитика по товарам (Seller API /v1/analytics/data): показы, показы в
// поиске, переходы в карточку, корзины, заказы (шт), заказано на сумму,
// позиция — по SKU и дням.
//
// Как было и почему ломалось: каждая из 7 метрик запрашивалась ОТДЕЛЬНЫМ
// запросом за весь месяц, с длинными паузами и сохранением построчно. Один
// прогон занимал 20-40+ минут, процесс на Render перезапускался раньше —
// успевала собраться только первая метрика (показы), а корзины и заказы
// месяцами оставались дырявыми.
//
// Как теперь (проверено живым запросом 24.09): Ozon отдаёт все 7 метрик
// ОДНИМ запросом за ~1.5 сек, 1000 строк на страницу; один день по всему
// кабинету — ~1650 строк (2 страницы). Второй запрос сразу следом тоже
// проходит. Заказы из аналитики сверены с отправлениями FBO+FBS за тот же
// день — совпали штука в штуку (243 = 24 + 219). Весь месяц собирается
// примерно за минуту.

const METRICS = ['hits_view', 'hits_view_search', 'hits_view_pdp', 'hits_tocart', 'ordered_units', 'revenue', 'position_category'];
const PAGE = 1000;
const WINDOW_DAYS = 7; // один запрос с пагинацией на неделю — страниц немного

async function fetchWindow(headers, from, to) {
  const rows = [];
  let totals = null;
  for (let offset = 0; ; offset += PAGE) {
    const data = await request(() => axios.post('https://api-seller.ozon.ru/v1/analytics/data', {
      date_from: from, date_to: to, metrics: METRICS, dimension: ['sku', 'day'], limit: PAGE, offset,
    }, { headers, timeout: 60000 }).then(r => r.data), `Аналитика ${from}..${to} стр.${offset / PAGE + 1}`);
    const part = data?.result?.data || [];
    totals = totals || data?.result?.totals || null;
    rows.push(...part);
    if (part.length < PAGE) break;
    await delay(400);
  }
  return { rows, totals };
}

// dateFrom/dateTo включительно, строки YYYY-MM-DD (московские даты).
async function collectProductAnalytics(cabinet, { dateFrom, dateTo } = {}) {
  const headers = sellerHeaders(cabinet);
  if (!headers) { console.log(`[Analytics:${cabinet}] Seller API не настроен`); return { rows: 0 }; }
  const to = dateTo || mskDate(0);
  const from = dateFrom || mskDate(6);

  // SKU -> offer_id из каталога кабинета: в ответе аналитики есть только SKU.
  const catalog = await query(`SELECT sku, offer_id FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND sku IS NOT NULL`, [cabinet]);
  const offerBySku = new Map(catalog.map(r => [String(r.sku), r.offer_id]));

  let saved = 0;
  const mismatches = [];
  // Идём окнами по неделе от свежих дат к старым: если что-то прервётся,
  // самое важное (последние дни) уже будет сохранено.
  let windowEnd = dayjs(to);
  const start = dayjs(from);
  while (!windowEnd.isBefore(start, 'day')) {
    let windowStart = windowEnd.subtract(WINDOW_DAYS - 1, 'day');
    if (windowStart.isBefore(start, 'day')) windowStart = start;
    const wf = windowStart.format('YYYY-MM-DD'), wt = windowEnd.format('YYYY-MM-DD');

    const { rows, totals } = await fetchWindow(headers, wf, wt);
    const out = [];
    let viewsInRows = 0;
    for (const r of rows) {
      const dims = r.dimensions || [];
      const sku = dims[0]?.id, date = dims[1]?.id;
      if (!sku || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) continue;
      const m = (r.metrics || []).map(v => Number(v) || 0);
      viewsInRows += m[0] || 0;
      out.push([cabinet, 'ozon', date, sku, offerBySku.get(String(sku)) || null,
        m[0], m[1], m[2], m[3], m[4], m[5], m[6] || null, new Date()]);
    }
    // Сверка полноты выгрузки с итогами, которые отдаёт сам Ozon, — по
    // показам (они сходятся до единицы). По заказам сверять нельзя: у Ozon
    // сумма заказов по товарам всегда чуть больше итога по кабинету
    // (проверено 24.09: 253 по товарам против 243 в итоге и в отправлениях),
    // это особенность Ozon, а не потеря строк.
    const totalViews = Number(totals?.[0]) || 0;
    if (totals && Math.abs(totalViews - viewsInRows) > Math.max(10, totalViews * 0.001)) {
      mismatches.push(`${wf}..${wt}: показы в строках ${viewsInRows}, в итогах Ozon ${totalViews} — выгрузка неполная`);
    }
    saved += await bulkUpsert('product_analytics_daily',
      ['cabinet', 'platform', 'date', 'sku', 'offer_id', 'hits_view', 'hits_view_search', 'hits_view_pdp',
       'hits_tocart', 'orders_item', 'revenue', 'position_category', 'collected_at'],
      out, ['cabinet', 'platform', 'date', 'sku']);

    windowEnd = windowStart.subtract(1, 'day');
    await delay(400);
  }
  if (mismatches.length) console.warn(`[Analytics:${cabinet}] Расхождение с итогами Ozon: ${mismatches.join('; ')}`);
  console.log(`[Analytics:${cabinet}] ${from}..${to}: сохранено строк ${saved}`);
  return { rows: saved, warning: mismatches.length ? mismatches.join('; ') : null };
}

module.exports = { collectProductAnalytics };
