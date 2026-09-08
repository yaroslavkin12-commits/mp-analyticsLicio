const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../../db');

function headers() {
  return {
    'Client-Id': process.env.OZON_CLIENT_ID,
    'Api-Key': process.env.OZON_API_KEY,
    'Content-Type': 'application/json',
  };
}

// Ozon отдаёт created_at/in_process_at в UTC, но кабинет Ozon (и сам продавец)
// считает "день заказа" по московскому времени — без этой поправки заказы,
// оформленные в последние ~3 часа суток по МСК, попадали в предыдущий
// UTC-день и портили дневные суммы (например, за 07.09 расходилось на
// 3 113 ₽/1 шт — ровно на заказы у границы полуночи МСК).
function mskDate(isoString) {
  return new Date(new Date(isoString).getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

// Собирает заказы из одного источника (FBO или FBS).
// ВАЖНО: список отправлений FBO у Ozon — это v2/posting/fbo/list, а не v3
// (v3 существует только для FBS).
async function fetchPostings(url, dateFrom) {
  const since = dayjs(dateFrom).toISOString();
  let offset = 0;
  let allPostings = [];

  while (true) {
    try {
      const { data } = await axios.post(
        url,
        {
          dir: 'ASC',
          filter: { since, to: new Date().toISOString(), status: '' },
          limit: 100,
          offset,
          with: { financial_data: true, analytics_data: true },
        },
        { headers: headers(), timeout: 60000 }
      );

      let postings = data?.result?.postings;
      if (!Array.isArray(postings) && Array.isArray(data?.result)) postings = data.result;
      postings = postings || [];
      allPostings = allPostings.concat(postings);
      if (postings.length < 100) break;
      offset += 100;
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.warn(`[Ozon] Ошибка ${url}:`, e.message);
      break;
    }
  }

  return allPostings;
}

async function collectOrders(dateFrom) {
  if (!process.env.OZON_CLIENT_ID) throw new Error('OZON_CLIENT_ID не задан');

  const from = dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  console.log(`[Ozon] Заказы с ${from}...`);

  // Собираем и FBO и FBS
  const [fboPostings, fbsPostings] = await Promise.all([
    fetchPostings('https://api-seller.ozon.ru/v2/posting/fbo/list', from),
    fetchPostings('https://api-seller.ozon.ru/v3/posting/fbs/list', from),
  ]);

  const allPostings = [...fboPostings, ...fbsPostings];
  console.log(`[Ozon] FBO: ${fboPostings.length}, FBS: ${fbsPostings.length}`);

  let total = 0;
  for (const p of allPostings) {
    for (const prod of p.products || []) {
      try {
        // financial_data.products матчится по product_id, а не по sku.
        const fin = p.financial_data?.products?.find(f => f.product_id === prod.sku) || {};
        await query(
          `INSERT INTO ozon_orders
            (date, posting_number, order_id, sku, offer_id, product_name,
             price, quantity, commission_amount, commission_percent, payout, status, warehouse_name)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (posting_number, sku) DO UPDATE SET
             date=EXCLUDED.date, status=EXCLUDED.status, payout=EXCLUDED.payout,
             commission_amount=EXCLUDED.commission_amount, commission_percent=EXCLUDED.commission_percent`,
          [
            mskDate(p.in_process_at || p.created_at),
            p.posting_number,
            p.order_id || null,
            prod.sku,
            prod.offer_id,
            prod.name,
            parseFloat(prod.price) || 0,
            prod.quantity || 1,
            fin.commission_amount || 0,
            fin.commission_percent || 0,
            fin.payout || 0,
            p.status,
            p.analytics_data?.warehouse_name || null,
          ]
        );
        total++;
      } catch (e) { /* skip */ }
    }
  }

  console.log(`[Ozon] Заказы сохранено: ${total}`);
  return total;
}

module.exports = { collectOrders };
