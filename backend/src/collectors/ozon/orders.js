const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../../db');

function headers() {
  return { 'Client-Id': process.env.OZON_CLIENT_ID, 'Api-Key': process.env.OZON_API_KEY, 'Content-Type': 'application/json' };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Одна страница с ретраями — сетевой сбой/таймаут не должен молча обрывать всю выгрузку
// и превращать частичный результат в ложный "success" в логе сборов.
async function fetchPage(url, since, offset) {
  const MAX_ATTEMPTS = 4;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { data } = await axios.post(url, {
        dir: 'ASC',
        filter: { since, to: new Date().toISOString(), status: '' },
        limit: 100, offset,
        with: { financial_data: true, analytics_data: true },
      }, { headers: headers(), timeout: 60000 });
      return data?.result?.postings || [];
    } catch(e) {
      lastErr = e;
      console.warn(`[Ozon] ${url} offset=${offset} попытка ${attempt}/${MAX_ATTEMPTS}:`, e.message);
      if (attempt < MAX_ATTEMPTS) await sleep(1000 * attempt);
    }
  }
  // Все попытки исчерпаны — бросаем ошибку, а не молча обрезаем список.
  // Иначе частично собранные данные тихо перезаписывают/дополняют таблицу и
  // сбор помечается как "success" с заниженным количеством записей.
  throw new Error(`не удалось получить страницу offset=${offset} после ${MAX_ATTEMPTS} попыток: ${lastErr.message}`);
}

async function fetchPostings(url, dateFrom) {
  const since = dayjs(dateFrom).toISOString();
  let offset = 0, all = [];
  while (true) {
    const postings = await fetchPage(url, since, offset);
    all = all.concat(postings);
    if (postings.length < 100) break;
    offset += 100;
    await sleep(300);
  }
  return all;
}

async function collectOrders(dateFrom) {
  if (!process.env.OZON_CLIENT_ID) throw new Error('OZON_CLIENT_ID не задан');
  const from = dateFrom || dayjs().subtract(30,'day').format('YYYY-MM-DD');
  console.log(`[Ozon] Заказы с ${from}...`);

  const [fbo, fbs] = await Promise.all([
    fetchPostings('https://api-seller.ozon.ru/v3/posting/fbo/list', from),
    fetchPostings('https://api-seller.ozon.ru/v3/posting/fbs/list', from),
  ]);
  console.log(`[Ozon] FBO: ${fbo.length}, FBS: ${fbs.length}`);

  let total = 0, failed = 0;
  for (const p of [...fbo, ...fbs]) {
    for (const prod of p.products || []) {
      try {
        const fin = p.financial_data?.products?.find(f => f.sku === prod.sku) || {};
        await query(
          `INSERT INTO ozon_orders (date,posting_number,order_id,sku,offer_id,product_name,price,quantity,commission_amount,commission_percent,payout,status,warehouse_name)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (posting_number,sku) DO UPDATE SET status=EXCLUDED.status,payout=EXCLUDED.payout`,
          [dayjs(p.in_process_at||p.created_at).format('YYYY-MM-DD'),p.posting_number,p.order_id||null,prod.sku,prod.offer_id,prod.name,parseFloat(prod.price)||0,prod.quantity||1,fin.commission_amount||0,fin.commission_percent||0,fin.payout||0,p.status,p.analytics_data?.warehouse_name||null]
        );
        total++;
      } catch(e) {
        failed++;
        // Раньше эта ошибка проглатывалась молча — строка просто пропадала без следа,
        // и итоговое число заказов на дашборде занижалось без единого сообщения в логах.
        console.warn(`[Ozon] Ошибка записи posting=${p.posting_number} sku=${prod.sku}:`, e.message);
      }
    }
  }
  console.log(`[Ozon] Заказы: ${total} записано, ${failed} с ошибкой`);
  return total;
}
module.exports = { collectOrders };
