const axios = require('axios');
const dayjs = require('dayjs');
const AdmZip = require('adm-zip');
const { query } = require('../../db');
const { getCabinet } = require('../../config/cabinets');

const delay = ms => new Promise(r => setTimeout(r, ms));

// Клики/показы/средняя цена клика по кампаниям — через асинхронный CSV-отчёт
// Ozon Performance API (POST .../api/client/statistics -> UUID -> поллинг
// GET .../api/client/statistics/{UUID} -> скачать CSV/ZIP по ссылке из ответа).
//
// Это НЕ то же самое, что .../statistics/expense/json (используется в
// ozonPerf.js для расхода) — тот эндпоинт не отдаёт клики вообще. Раньше
// пробовали синхронный GET .../api/client/statistics и получали 405 —
// оказалось, этот путь работает только через POST (создаёт отчёт), а не GET.
//
// Важное ограничение аккаунта: только ОДИН активный запрос отчёта одновременно
// ("Превышен лимит активных запросов, максимум 1") — поэтому кампании идут
// батчами (BATCH_SIZE шт. в одном отчёте), строго последовательно, и ждём
// завершения одного батча, прежде чем запрашивать следующий.
const BATCH_SIZE = 20;
const POLL_ATTEMPTS = 15;
const POLL_DELAY_MS = 2000;

async function getToken(cfg) {
  if (!cfg.ozonPerfClientId || !cfg.ozonPerfSecret) return null;
  try {
    const { data } = await axios.post('https://api-performance.ozon.ru/api/client/token',
      { client_id: cfg.ozonPerfClientId, client_secret: cfg.ozonPerfSecret, grant_type: 'client_credentials' },
      { timeout: 15000 });
    return data?.access_token || null;
  } catch (e) {
    console.warn('[Ads Clicks] Токен:', e.response?.data || e.message);
    return null;
  }
}

function parseRuNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  return Number(String(v).replace(/\s/g, '').replace(',', '.')) || 0;
}

// Парсинг одного CSV-отчёта по одной кампании. Формат (разделитель ";"):
// строка 1 — заголовок отчёта (";Рекламная кампания № ..."), пропускаем;
// строка 2 — названия колонок, пропускаем;
// далее — по одной строке на день (может быть несколько строк на день, если
// в кампании больше одного SKU/типа страницы — суммируем по дате);
// последняя строка "Всего" — общий итог, пропускаем (считаем сумму сами).
//
// Колонки (по индексу): 0 День, 1 sku, 2 Название, 3 Цена, 4 Тип страницы,
// 5 Условие показа, 6 Показы, 7 Клики, 8 CTR, 9 В корзину,
// 10 Средняя ставка, 11 Расход, 12 Заказы, 13 Выручка, 14 Заказы модели,
// 15 Выручка с заказов модели.
function parseCampaignCsv(csvText) {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
  const byDate = new Map(); // "YYYY-MM-DD" -> {views,clicks,spend,orders,ordersMoney}
  for (const line of lines) {
    if (line.startsWith(';')) continue; // строка заголовка отчёта
    const cols = line.split(';');
    const day = cols[0];
    if (!day || day === 'Всего' || day === 'День') continue;
    // День приходит как "12.09.2026"
    const m = day.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!m) continue;
    const date = `${m[3]}-${m[2]}-${m[1]}`;
    const views = parseRuNumber(cols[6]);
    const clicks = parseRuNumber(cols[7]);
    const spend = parseRuNumber(cols[11]);
    const orders = parseRuNumber(cols[12]);
    const ordersMoney = parseRuNumber(cols[13]);
    if (!byDate.has(date)) byDate.set(date, { views: 0, clicks: 0, spend: 0, orders: 0, ordersMoney: 0 });
    const acc = byDate.get(date);
    acc.views += views; acc.clicks += clicks; acc.spend += spend;
    acc.orders += orders; acc.ordersMoney += ordersMoney;
  }
  return byDate;
}

// Ответ Ozon: для ОДНОЙ кампании — сырой CSV; для НЕСКОЛЬКИХ — ZIP с одним
// CSV на кампанию (имя файла начинается с campaign_id). Различаем по сигнатуре
// ZIP ("PK").
function parseReport(buffer, campaignIds) {
  const result = new Map(); // campaignId -> Map(date -> metrics)
  const isZip = buffer.length > 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (isZip) {
    const zip = new AdmZip(buffer);
    for (const entry of zip.getEntries()) {
      const idMatch = entry.entryName.match(/^(\d+)_/);
      const campaignId = idMatch ? idMatch[1] : null;
      if (!campaignId) continue;
      const text = entry.getData().toString('utf8');
      result.set(campaignId, parseCampaignCsv(text));
    }
  } else {
    // Один campaignId в запросе — весь текст относится к нему.
    const text = buffer.toString('utf8');
    result.set(String(campaignIds[0]), parseCampaignCsv(text));
  }
  return result;
}

async function requestReport(campaignIds, from, to, headers) {
  const { data: startData } = await axios.post('https://api-performance.ozon.ru/api/client/statistics',
    { campaigns: campaignIds, dateFrom: from, dateTo: to, groupBy: 'DATE' },
    { headers, timeout: 30000 });
  const uuid = startData?.UUID;
  if (!uuid) throw new Error('Нет UUID в ответе на создание отчёта');

  let status = null;
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await delay(POLL_DELAY_MS);
    const { data } = await axios.get(`https://api-performance.ozon.ru/api/client/statistics/${uuid}`,
      { headers, timeout: 30000 });
    status = data;
    if (status?.state === 'OK' || status?.state === 'ERROR') break;
  }
  if (status?.state !== 'OK' || !status?.link) {
    throw new Error(`Отчёт не готов вовремя (state=${status?.state})`);
  }
  const { data: reportBuf } = await axios.get(`https://api-performance.ozon.ru${status.link}`,
    { headers, timeout: 30000, responseType: 'arraybuffer' });
  return parseReport(Buffer.from(reportBuf), campaignIds);
}

// Клики/CPC собираем только для кампаний с реальной привязкой к артикулу
// (matched_offer_id) — так же, как остальная сводка по артикулу — и не
// архивных/завершённых, чтобы не тратить драгоценные батчи (лимит 1 отчёт
// одновременно на аккаунт) на кампании, которые всё равно не показываются.
async function collectClicks(cabinet, days) {
  const cfg = getCabinet(cabinet);
  const token = await getToken(cfg);
  if (!token) {
    console.log(`[Ads Clicks] ${cabinet}: Performance API не настроен`);
    return 0;
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const from = dayjs().subtract(days || 7, 'day').format('YYYY-MM-DD');
  const to = dayjs().format('YYYY-MM-DD');

  const campaignRows = await query(
    `SELECT campaign_id FROM ad_campaigns
     WHERE cabinet = $1 AND platform = 'ozon' AND matched_offer_id IS NOT NULL
       AND state NOT IN ('CAMPAIGN_STATE_ARCHIVED', 'CAMPAIGN_STATE_FINISHED')`,
    [cabinet]
  );
  const campaignIds = campaignRows.map(r => r.campaign_id);
  if (!campaignIds.length) {
    console.log(`[Ads Clicks] ${cabinet}: нет активных кампаний с привязкой к артикулу`);
    return 0;
  }

  let total = 0;
  for (let i = 0; i < campaignIds.length; i += BATCH_SIZE) {
    const batch = campaignIds.slice(i, i + BATCH_SIZE);
    try {
      const byCampaign = await requestReport(batch, from, to, headers);
      for (const [campaignId, byDate] of byCampaign) {
        for (const [date, m] of byDate) {
          try {
            await query(
              `INSERT INTO ad_stats_daily (cabinet, platform, date, campaign_id, views, clicks, ctr, spend, avg_bid, orders, orders_money)
               VALUES ($1,'ozon',$2,$3,$4,$5,$6,$7,$8,$9,$10)
               ON CONFLICT (cabinet, platform, date, campaign_id) DO UPDATE SET
                 views = EXCLUDED.views, clicks = EXCLUDED.clicks, ctr = EXCLUDED.ctr,
                 avg_bid = EXCLUDED.avg_bid, orders = EXCLUDED.orders, orders_money = EXCLUDED.orders_money`,
              [cabinet, date, campaignId, m.views, m.clicks,
               m.views > 0 ? (m.clicks / m.views * 100) : 0,
               m.spend, m.clicks > 0 ? (m.spend / m.clicks) : 0,
               m.orders, m.ordersMoney]
            );
            total++;
          } catch (e) { console.warn(`[Ads Clicks] ${cabinet} ${campaignId}/${date}:`, e.message); }
        }
      }
    } catch (e) {
      console.warn(`[Ads Clicks] ${cabinet}: батч ${i / BATCH_SIZE + 1}:`, e.response?.data || e.message);
    }
    await delay(500);
  }
  console.log(`[Ads Clicks] ${cabinet}: строк с кликами обновлено ${total}`);
  return total;
}

module.exports = { collectClicks };
