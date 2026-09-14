const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../../db');
const { getCabinet } = require('../../config/cabinets');
const { saveRunStatus } = require('./runStatus');

const delay = ms => new Promise(r => setTimeout(r, ms));

// Аналитика по товару (Seller API, /v1/analytics/data) — показы, переходы в
// корзину, заказы и средняя позиция в поисковой выдаче/категории по SKU по
// дням. Часть метрик Ozon периодически убирает без предупреждения (см.
// комментарий в collectors/ozon/analytics.js — код 3 в ответе значит
// "метрика больше не поддерживается"), поэтому каждую метрику запрашиваем
// отдельно и просто пропускаем те, что отвалились, вместо падения сборщика
// целиком.
// Лимит запросов у Ozon Seller Analytics API оказался жёстче, чем казалось:
// живые тесты показывают code:8/429 даже при паузе 700мс и 5 попытках — на
// продакшене метрика может провалиться целиком на весь месяц. Поэтому здесь
// пауза между страницами увеличена и ретраи стали намного настойчивее:
// 10 попыток на страницу с паузой до 20 секунд на последней. Это делает один
// вызов дольше, но гарантированно не даёт метрике "потеряться" молча.
const MAX_RATE_LIMIT_RETRIES = 10;
const RATE_LIMIT_BASE_WAIT = 2000;

// "Пульс" — обновляет updated_at в ad_collect_runs, чтобы блокировка
// isRunActive() (см. runStatus.js) не сочла ещё живой процесс мёртвым из-за
// того, что одна метрика с несколькими повторными попытками (до 10 ретраев
// по 20 секунд каждый) заняла дольше окна "протухания" блокировки — иначе
// долгая, но НЕ зависшая работа выглядела бы так же, как реально мёртвый
// процесс, и второй параллельный запуск мог бы стартовать поверх первого
// (та самая гонка, которую блокировка должна предотвращать).
async function heartbeat(cabinet, detail) {
  await saveRunStatus(cabinet, { step: 'product_analytics', detail });
}

async function fetchMetric(headers, dateFrom, dateTo, metricName, cabinet) {
  const result = new Map();
  let offset = 0;
  while (true) {
    await delay(1800);
    let resp;
    let rateLimitRetries = 0;
    while (true) {
      try {
        resp = await axios.post('https://api-seller.ozon.ru/v1/analytics/data', {
          date_from: dateFrom,
          date_to: dateTo,
          metrics: [metricName],
          dimension: ['sku', 'day'],
          limit: 1000,
          offset,
        }, { headers, timeout: 60000 });
        break;
      } catch(e) {
        const code = e.response?.data?.code;
        const status = e.response?.status;
        // code 3 = метрика больше не поддерживается Ozon — пропускаем сразу,
        // без ретраев, это не временная ошибка.
        if (code === 3) {
          console.log(`[Ads Analytics] Метрика "${metricName}" недоступна — пропускаем`);
          return null;
        }
        // code 8 / HTTP 429 = превышен лимит запросов в секунду — это
        // временно, поэтому ждём и повторяем (с нарастающей паузой), а не
        // сдаёмся сразу, как раньше (из-за чего вся метрика молча терялась).
        if ((code === 8 || status === 429) && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
          rateLimitRetries++;
          const wait = Math.min(RATE_LIMIT_BASE_WAIT * rateLimitRetries, 20000);
          console.warn(`[Ads Analytics] "${metricName}": лимит запросов (429), retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} через ${wait}мс`);
          if (cabinet) await heartbeat(cabinet, `${metricName}: retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}`);
          await delay(wait);
          continue;
        }
        console.warn(`[Ads Analytics] "${metricName}" — не удалось получить после ${rateLimitRetries} попыток:`, e.response?.data?.message || e.message);
        return null;
      }
    }
    const rows = resp.data?.result?.data || [];
    for (const row of rows) {
      const dims = row.dimensions || [];
      const skuDim = dims.find(d => d.id && /^\d{5,}$/.test(String(d.id)));
      const dateDim = dims.find(d => d.id && /^\d{4}-\d{2}-\d{2}$/.test(String(d.id)));
      const sku = skuDim?.id || dims[0]?.id;
      const date = dateDim?.id || dims[1]?.id;
      if (!sku || !date) continue;
      const key = `${sku}|${date}`;
      const entry = result.get(key) || { sku, date };
      entry[metricName] = Number((row.metrics || [])[0]) || 0;
      result.set(key, entry);
    }
    if (rows.length < 1000) break;
    offset += 1000;
  }
  return result;
}

// Колонка в product_analytics_daily для каждой метрики Ozon — нужна для
// точечного UPSERT-а по одной метрике (см. ниже, почему это важно).
const METRIC_COLUMN = {
  hits_view: 'hits_view',
  hits_view_search: 'hits_view_search',
  hits_view_pdp: 'hits_view_pdp',
  hits_tocart: 'hits_tocart',
  orders_item: 'orders_item',
  revenue: 'revenue',
  position_category: 'position_category',
};

// Сохраняет результат ОДНОЙ метрики сразу после её сбора, а не в самом конце
// после всех 7 метрик. Раньше все метрики копились в памяти и запись в БД
// шла одним проходом в конце collectProductAnalytics — из-за этого, если
// процесс обрывался посреди сбора (сервер Render на бесплатном тарифе
// периодически "засыпает"/перезапускается без явной ошибки), ВСЯ уже
// проделанная работа пропадала бесследно: ни одной строки не сохранялось,
// даже если 5 из 7 метрик уже успешно собрались. Точечный upsert по каждой
// метрике сразу же фиксирует прогресс — обрыв на середине теряет только то,
// что ещё не собрано, а не всё целиком.
async function saveMetric(cabinet, metricName, dataMap, offerBySku) {
  const column = METRIC_COLUMN[metricName];
  if (!column || !dataMap || !dataMap.size) return 0;
  let saved = 0;
  for (const [key, entry] of dataMap) {
    const [sku, date] = key.split('|');
    const value = metricName === 'position_category' ? (entry[metricName] ?? null) : (entry[metricName] ?? 0);
    try {
      await query(
        `INSERT INTO product_analytics_daily (cabinet, platform, date, sku, offer_id, ${column})
         VALUES ($1,'ozon',$2,$3,$4,$5)
         ON CONFLICT (cabinet, platform, date, sku) DO UPDATE SET
           offer_id = COALESCE(EXCLUDED.offer_id, product_analytics_daily.offer_id),
           ${column} = EXCLUDED.${column}`,
        [cabinet, date, sku, offerBySku.get(String(sku)) || null, value]
      );
      saved++;
    } catch(e) { /* пропускаем отдельную строку, не весь сбор */ }
  }
  return saved;
}

async function collectProductAnalytics(cabinet, days) {
  const cfg = getCabinet(cabinet);
  if (!cfg.ozonClientId || !cfg.ozonApiKey) {
    console.log(`[Ads Analytics:${cabinet}] Ozon Seller API не настроен`);
    return 0;
  }
  const headers = { 'Client-Id': cfg.ozonClientId, 'Api-Key': cfg.ozonApiKey, 'Content-Type': 'application/json' };
  const from = dayjs().subtract(days || 30, 'day').format('YYYY-MM-DD');
  const to = dayjs().format('YYYY-MM-DD');

  const catalogRows = await query(
    `SELECT sku, offer_id FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND sku IS NOT NULL`,
    [cabinet]
  );
  const offerBySku = new Map(catalogRows.map(r => [String(r.sku), r.offer_id]));

  const METRICS = ['hits_view', 'hits_view_search', 'hits_view_pdp', 'hits_tocart', 'orders_item', 'revenue', 'position_category'];
  const failedMetrics = [];
  let total = 0;
  for (const m of METRICS) {
    await heartbeat(cabinet, `метрика: ${m}`);
    const data = await fetchMetric(headers, from, to, m, cabinet);
    if (data !== null) {
      const saved = await saveMetric(cabinet, m, data, offerBySku);
      total += saved;
      console.log(`[Ads Analytics:${cabinet}] "${m}": сохранено строк ${saved}`);
    } else {
      failedMetrics.push(m);
    }
    // Пауза между разными метриками — не только между страницами одной
    // метрики — чтобы не начинать следующую метрику "с разбегу" сразу после
    // серии ретраев предыдущей.
    await delay(2500);
  }

  // Если какая-то метрика не набралась вообще ни с одной попытки — пробуем
  // её ещё раз отдельным проходом после паузы. На практике лимит запросов
  // Ozon посекундный и "отпускает" за несколько секунд простоя, поэтому
  // повторный проход после того, как остальные метрики уже отработали и
  // API "остыл", часто успешен там, где первый проход упёрся в лимит.
  if (failedMetrics.length) {
    console.warn(`[Ads Analytics] Повторная попытка для метрик, не собравшихся с первого раза: ${failedMetrics.join(', ')}`);
    await delay(5000);
    for (const m of failedMetrics) {
      await heartbeat(cabinet, `повтор метрики: ${m}`);
      const data = await fetchMetric(headers, from, to, m, cabinet);
      if (data !== null) {
        const saved = await saveMetric(cabinet, m, data, offerBySku);
        total += saved;
        console.log(`[Ads Analytics:${cabinet}] "${m}" (повтор): сохранено строк ${saved}`);
      }
      await delay(2500);
    }
  }

  console.log(`[Ads Analytics:${cabinet}] Сохранено всего: ${total}`);
  return total;
}

module.exports = { collectProductAnalytics };
