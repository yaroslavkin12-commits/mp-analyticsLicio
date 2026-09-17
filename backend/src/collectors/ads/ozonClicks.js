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
// завершения одного батча, прежде чем запрашивать следующий. Также у самого
// эндпоинта создания отчёта есть отдельный лимит на количество кампаний в
// ОДНОМ запросе — "Превышен лимит по количеству кампаний (максимум 10)" —
// поэтому BATCH_SIZE не может быть больше 10, даже если лимит активных
// отчётов позволил бы отправлять более крупные батчи.
const BATCH_SIZE = 10;
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

// Определяем индексы нужных колонок ПО НАЗВАНИЮ из строки заголовка, а не по
// фиксированной позиции. Раньше индексы были жёстко зашиты (6 Показы, 7 Клики,
// 11 Расход, ...), и для большинства кампаний совпадали — но у части кампаний
// набор колонок отличается (например, нет разбивки по SKU/типу страницы, если
// в кампании всего один товар), из-за чего фиксированные индексы съезжали и
// "Клики"/"Расход" читались из совсем других колонок — отсюда наблюдались
// бессмысленные результаты вроде 43 837 ₽ за клик.
function detectColumns(headerCols) {
  const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const idx = {};
  headerCols.forEach((raw, i) => {
    const c = norm(raw);
    if (c.startsWith('день')) idx.day = i;
    else if (c.startsWith('показы')) idx.views = i;
    else if (c.startsWith('клики')) idx.clicks = i;
    else if (c.startsWith('расход')) idx.spend = i;
    else if (c.startsWith('заказы модели')) { /* отдельная метрика, не нужна */ }
    else if (c.startsWith('заказы')) idx.orders = i;
    else if (c.startsWith('выручка с заказов модели')) { /* не нужна */ }
    else if (c.startsWith('выручка')) idx.ordersMoney = i;
  });
  return idx;
}

// Парсинг одного CSV-отчёта по одной кампании. Формат (разделитель ";"):
// строка 1 — заголовок отчёта (";Рекламная кампания № ..."), пропускаем;
// строка 2 — названия колонок — по ней определяем индексы (см. detectColumns);
// далее — по одной строке на день (может быть несколько строк на день, если
// в кампании больше одного SKU/типа страницы — суммируем по дате);
// последняя строка "Всего" — общий итог, пропускаем (считаем сумму сами).
function parseCampaignCsv(csvText) {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
  const byDate = new Map(); // "YYYY-MM-DD" -> {views,clicks,spend,orders,ordersMoney}
  let cols_ = null; // индексы колонок, из строки заголовка
  for (const line of lines) {
    if (line.startsWith(';')) continue; // строка заголовка отчёта (комментарий)
    const cols = line.split(';');
    if (!cols_) {
      // Первая не-комментарийная строка — заголовки колонок, саму строку с
      // данными не считаем.
      cols_ = detectColumns(cols);
      continue;
    }
    const day = cols[cols_.day != null ? cols_.day : 0];
    if (!day || day === 'Всего' || day === 'День') continue;
    // День приходит как "12.09.2026"
    const m = day.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!m) continue;
    const date = `${m[3]}-${m[2]}-${m[1]}`;
    const views = cols_.views != null ? parseRuNumber(cols[cols_.views]) : 0;
    const clicks = cols_.clicks != null ? parseRuNumber(cols[cols_.clicks]) : 0;
    const spend = cols_.spend != null ? parseRuNumber(cols[cols_.spend]) : 0;
    const orders = cols_.orders != null ? parseRuNumber(cols[cols_.orders]) : 0;
    const ordersMoney = cols_.ordersMoney != null ? parseRuNumber(cols[cols_.ordersMoney]) : 0;
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

// Лимит "1 активный запрос на аккаунт" — сообщение об ошибке приходит как
// 429, в том числе если "завис" отчёт от предыдущего/параллельного запуска
// (например, ручной сбор и сбор по расписанию пересеклись, или на аккаунте
// ещё донашивается отчёт с прошлого запроса). Ретраим с растущей паузой,
// а не сразу сдаёмся — иначе весь батч кампаний остаётся без кликов.
async function createReport(campaignIds, from, to, headers) {
  for (let attempt = 0; attempt <= 5; attempt++) {
    try {
      const { data } = await axios.post('https://api-performance.ozon.ru/api/client/statistics',
        { campaigns: campaignIds, dateFrom: from, dateTo: to, groupBy: 'DATE' },
        { headers, timeout: 30000 });
      return data;
    } catch (e) {
      if (e.response?.status === 429 && attempt < 5) {
        const wait = 5000 * (attempt + 1);
        console.warn(`[Ads Clicks] Лимит активных отчётов (429), retry ${attempt + 1}/5 через ${wait}мс`);
        await delay(wait);
        continue;
      }
      throw e;
    }
  }
}

async function requestReport(campaignIds, from, to, headers) {
  const startData = await createReport(campaignIds, from, to, headers);
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
async function collectClicks(cabinet, days, debugErrors) {
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
      if (byCampaign.size === 0) {
        try {
          await query(
            `INSERT INTO collection_log (platform,collector_type,status,records_collected,error_message,finished_at)
             VALUES ($1,'ads_clicks_batch','error',0,$2,NOW())`,
            [cabinet, JSON.stringify({ batch, error: 'Отчёт получен, но парсер не нашёл ни одной кампании (пустой Map)' }).slice(0, 1000)]
          );
        } catch (logErr) { /* non-critical */ }
      }
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
      const errInfo = e.response?.data || e.message;
      console.warn(`[Ads Clicks] ${cabinet}: батч ${i / BATCH_SIZE + 1}:`, errInfo);
      if (Array.isArray(debugErrors)) debugErrors.push({ batch: batch.slice(0, 3), error: errInfo });
      // Логи console.warn недоступны без доступа к панели Render — пишем
      // ошибку батча в collection_log, чтобы её можно было посмотреть через
      // существующий GET /api/dashboard/collection-log без доступа к серверу.
      try {
        await query(
          `INSERT INTO collection_log (platform,collector_type,status,records_collected,error_message,finished_at)
           VALUES ($1,'ads_clicks_batch','error',0,$2,NOW())`,
          [cabinet, JSON.stringify({ batch, error: errInfo }).slice(0, 1000)]
        );
      } catch (logErr) { /* non-critical */ }
    }
    await delay(500);
  }
  console.log(`[Ads Clicks] ${cabinet}: строк с кликами обновлено ${total}`);
  return total;
}

module.exports = { collectClicks, BATCH_SIZE };
