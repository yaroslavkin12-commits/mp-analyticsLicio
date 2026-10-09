const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../db');
const { getCabinet } = require('../config/cabinets');
const { getActiveTracked, checkAndNotify } = require('./trackedArticles');

// Отдельный, лёгкий поллер заказов Ozon — специально для вкладки
// "Уведомления", для кабинетов БЕЗ общего сбора заказов (сейчас — Defly).
// Licio здесь НЕ обрабатывается: там уведомления уже встроены в основной
// сборщик заказов (collectors/ozon/orders.js, вызывается из scheduler.js) —
// повторная проверка тех же заказов здесь задвоила бы уведомления.
//
// Специально не пишет в ozon_orders (общую таблицу аналитики/дашборда) —
// та таблица не рассчитана на несколько кабинетов (нет колонки cabinet), и
// подмешивать туда заказы Defly нельзя, это испортит Дашборд/Аналитику
// Licio. Вместо этого — своя лёгкая таблица дедупликации (tracked_orders_seen,
// см. postgres/init.sql), которая нужна только для определения "это новый
// заказ или мы его уже видели" и ни для чего больше.
//
// Как и основной сбор заказов Licio, подвержен той же возможной сетевой
// блокировке Render -> Ozon (см. defly-sbor-dannyh.md в проекте) — если
// запрос падает по таймауту, просто пропускаем этот тик, данные подхватятся
// на следующем успешном прогоне (окно "since" — 2 дня, с запасом).

function headersFor(cfg) {
  return {
    'Client-Id': cfg.ozonClientId,
    'Api-Key': cfg.ozonApiKey,
    'Content-Type': 'application/json',
  };
}

async function fetchPostings(url, headers, since) {
  let offset = 0;
  let all = [];
  while (true) {
    const { data } = await axios.post(
      url,
      {
        dir: 'ASC',
        filter: { since, to: new Date().toISOString(), status: '' },
        limit: 100,
        offset,
        with: { analytics_data: true },
      },
      { headers, timeout: 60000 }
    );
    let postings = data?.result?.postings;
    if (!Array.isArray(postings) && Array.isArray(data?.result)) postings = data.result;
    postings = postings || [];
    all = all.concat(postings);
    if (postings.length < 100) break;
    offset += 100;
    await new Promise(r => setTimeout(r, 300));
  }
  return all;
}

async function pollOzonForCabinet(cabinet) {
  // Нечего проверять — не дёргаем Ozon впустую.
  const tracked = await getActiveTracked(cabinet, 'ozon').catch(() => []);
  if (!tracked.length) return 0;

  const cfg = getCabinet(cabinet);
  if (!cfg.ozonClientId || !cfg.ozonApiKey) return 0;

  const since = dayjs().subtract(2, 'day').toISOString();
  const headers = headersFor(cfg);
  const [fbo, fbs] = await Promise.all([
    fetchPostings('https://api-seller.ozon.ru/v2/posting/fbo/list', headers, since),
    fetchPostings('https://api-seller.ozon.ru/v3/posting/fbs/list', headers, since),
  ]);
  const postings = [...fbo, ...fbs];

  const newOrders = [];
  for (const p of postings) {
    if (p.status === 'cancelled') continue;
    for (const prod of p.products || []) {
      try {
        const rows = await query(
          `INSERT INTO tracked_orders_seen (cabinet, posting_number, sku)
           VALUES (?,?,?)
           ON CONFLICT (cabinet, posting_number, sku) DO NOTHING
           RETURNING id`,
          [cabinet, p.posting_number, prod.sku || 0]
        );
        if (rows.length) {
          newOrders.push({
            offer_id: prod.offer_id,
            sku: prod.sku,
            productName: prod.name,
            price: parseFloat(prod.price) || 0,
            warehouse: p.analytics_data?.warehouse_name || null,
            orderRef: `${p.posting_number}:${prod.sku}`,
          });
        }
      } catch (e) { /* skip */ }
    }
  }

  if (newOrders.length) {
    await checkAndNotify(cabinet, 'ozon', newOrders);
  }
  return newOrders.length;
}

// Основной путь (Render в Ozon не ходит): заказы за 2 дня кладёт во вкладку
// Orders Google-скрипт (syncOrders, каждые 5 минут), здесь только читаем
// таблицу, отсеиваем уже виденные (tracked_orders_seen) и шлём уведомления.
// Уведомляем только о заказах не старше NOTIFY_MAX_AGE_HOURS — иначе при
// первом запуске пришли бы уведомления по всем заказам за 2 дня разом.
const NOTIFY_MAX_AGE_HOURS = 3;
async function pollOrdersFromSheet(cabinet) {
  const tracked = await getActiveTracked(cabinet, 'ozon').catch(() => []);
  if (!tracked.length) return 0;
  const { fetchSheetRows } = require('./ads/sheetSync');
  const rows = await fetchSheetRows('Orders');
  if (!rows) return 0;
  const cutoff = Date.now() - NOTIFY_MAX_AGE_HOURS * 3600 * 1000;
  const newOrders = [];
  for (const r of rows) {
    if (r.cabinet !== cabinet || !r.posting_number) continue;
    if (String(r.status).toLowerCase() === 'cancelled') continue;
    const sku = Number(r.sku) || 0;
    let inserted;
    try {
      inserted = await query(
        `INSERT INTO tracked_orders_seen (cabinet, posting_number, sku) VALUES (?,?,?)
         ON CONFLICT (cabinet, posting_number, sku) DO NOTHING RETURNING id`,
        [cabinet, r.posting_number, sku]);
    } catch (e) { continue; }
    if (!inserted.length) continue;
    const created = r.created_at ? new Date(r.created_at).getTime() : Date.now();
    if (Number.isFinite(created) && created < cutoff) continue; // старый заказ — просто запомнили
    newOrders.push({
      offer_id: r.offer_id, sku, productName: r.name, price: parseFloat(r.price) || 0,
      warehouse: r.warehouse || null, orderRef: `${r.posting_number}:${sku}`,
    });
  }
  if (newOrders.length) await checkAndNotify(cabinet, 'ozon', newOrders);
  return newOrders.length;
}

module.exports = { pollOzonForCabinet, pollOrdersFromSheet };
