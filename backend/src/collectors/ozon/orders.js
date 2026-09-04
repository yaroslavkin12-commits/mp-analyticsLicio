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

// Собирает заказы из одного источника (FBO или FBS)
async function fetchPostings(url, dateFrom, label) {
  const since = dayjs(dateFrom).toISOString();
  let offset = 0;
  let allPostings = [];
  let lastError = null;

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

      const postings = data?.result?.postings || [];
      allPostings = allPostings.concat(postings);
      if (postings.length < 100) break;
      offset += 100;
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      lastError = e.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : e.message;
      console.warn(`[Ozon] Ошибка ${url}:`, e.message);
      break;
    }
  }

  return { postings: allPostings, error: lastError, label };
}

async function collectOrders(dateFrom) {
  if (!process.env.OZON_CLIENT_ID) throw new Error('OZON_CLIENT_ID не задан');

  const from = dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  console.log(`[Ozon] Заказы с ${from}...`);

  // Собираем и FBO и FBS
  const [fbo, fbs] = await Promise.all([
    fetchPostings('https://api-seller.ozon.ru/v3/posting/fbo/list', from, 'fbo'),
    fetchPostings('https://api-seller.ozon.ru/v3/posting/fbs/list', from, 'fbs'),
  ]);
  const fboPostings = fbo.postings;
  const fbsPostings = fbs.postings;

  const allPostings = [...fboPostings, ...fbsPostings];
  console.log(`[Ozon] FBO: ${fboPostings.length}, FBS: ${fbsPostings.length}`);

  // ВРЕМЕННАЯ ДИАГНОСТИКА — пишем разбивку FBO/FBS, ошибки и сэмпл сырых полей
  // одного посылки в collection_log, чтобы понять расхождение с кабинетом Ozon.
  // Убрать после того, как найдём причину недосчёта заказов.
  try {
    const sampleP = allPostings[0];
    const sampleProd = sampleP?.products?.[0];
    const sampleFin = sampleP?.financial_data?.products?.find(f => f.sku === sampleProd?.sku) || sampleP?.financial_data?.products?.[0];
    const debugMsg = JSON.stringify({
      since: from,
      fbo_postings: fboPostings.length,
      fbs_postings: fbsPostings.length,
      fbo_error: fbo.error,
      fbs_error: fbs.error,
      sample_product: sampleProd ? { sku: sampleProd.sku, offer_id: sampleProd.offer_id, price: sampleProd.price, quantity: sampleProd.quantity } : null,
      sample_financial: sampleFin || null,
      sample_posting_status: sampleP?.status,
    }).slice(0, 1900);
    await query(
      `INSERT INTO collection_log (platform, collector_type, status, records_collected, error_message, finished_at)
       VALUES (?,?,?,?,?,NOW())`,
      ['ozon', 'orders_debug', 'success', allPostings.length, debugMsg]
    );
  } catch (e) { console.warn('[Ozon] debug log:', e.message); }

  let total = 0;
  for (const p of allPostings) {
    for (const prod of p.products || []) {
      try {
        const fin = p.financial_data?.products?.find(f => f.sku === prod.sku) || {};
        await query(
          `INSERT INTO ozon_orders
            (date, posting_number, order_id, sku, offer_id, product_name,
             price, quantity, commission_amount, commission_percent, payout, status, warehouse_name)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (posting_number, sku) DO UPDATE SET
             status=EXCLUDED.status, payout=EXCLUDED.payout`,
          [
            dayjs(p.in_process_at || p.created_at).format('YYYY-MM-DD'),
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
