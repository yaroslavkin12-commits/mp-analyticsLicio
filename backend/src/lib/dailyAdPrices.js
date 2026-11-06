const { query } = require('../db');
let ready;
function ensureDailyAdPrices() {
  if (!ready) ready = query(`CREATE TABLE IF NOT EXISTS ad_price_samples_daily (
    cabinet TEXT NOT NULL, offer_id TEXT NOT NULL, date DATE NOT NULL,
    seller_sum NUMERIC NOT NULL DEFAULT 0, seller_count INTEGER NOT NULL DEFAULT 0,
    client_sum NUMERIC NOT NULL DEFAULT 0, client_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (cabinet, offer_id, date))`).catch(e => { ready = null; throw e; });
  return ready;
}
const positive = v => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
async function recordDailyAdPrices(cabinet, rows) {
  if (cabinet === 'licio') return;
  await ensureDailyAdPrices();
  // Каждый полученный замер имеет одинаковый вес, включая неизменившуюся цену.
  // Один артикул в ответе источника учитываем один раз.
  const unique = [...new Map(rows.filter(r => r.offer).map(r => [r.offer, r])).values()];
  for (let i = 0; i < unique.length; i += 500) {
    const params = [cabinet], tuples = unique.slice(i, i + 500).map(r => {
      const s = positive(r.seller), c = positive(r.card);
      const values = [r.offer, s || 0, s ? 1 : 0, c || 0, c ? 1 : 0].map(v => { params.push(v); return '$' + params.length; });
      return `($1,${values[0]},(NOW() AT TIME ZONE 'Europe/Moscow')::date,${values.slice(1).join(',')})`;
    });
    await query(`INSERT INTO ad_price_samples_daily (cabinet, offer_id, date, seller_sum, seller_count, client_sum, client_count)
      VALUES ${tuples.join(',')} ON CONFLICT (cabinet, offer_id, date) DO UPDATE SET
      seller_sum = ad_price_samples_daily.seller_sum + EXCLUDED.seller_sum,
      seller_count = ad_price_samples_daily.seller_count + EXCLUDED.seller_count,
      client_sum = ad_price_samples_daily.client_sum + EXCLUDED.client_sum,
      client_count = ad_price_samples_daily.client_count + EXCLUDED.client_count`, params);
  }
}
function mergeDailyPrices(samples, history, daily) {
  const result = new Map();
  // Приоритет: все новые замеры → сохранённая история изменений → единственный дневной снимок.
  for (const rows of [daily, history, samples]) for (const r of rows) {
    const key = `${r.offer_id}|${r.d}`, prev = result.get(key) || {};
    result.set(key, { sellerPrice: positive(r.seller) ?? prev.sellerPrice ?? null,
      clientPrice: positive(r.client) ?? prev.clientPrice ?? null });
  }
  return result;
}
async function dailyAdPrices(cabinet, from, to, offers) {
  if (!offers.length || cabinet === 'licio') return new Map();
  await ensureDailyAdPrices();
  const args = [cabinet, from, to, offers];
  const [samples, history, daily] = await Promise.all([
    query(`SELECT offer_id, date::text d, seller_sum / NULLIF(seller_count,0) seller,
      client_sum / NULLIF(client_count,0) client FROM ad_price_samples_daily
      WHERE cabinet=$1 AND date BETWEEN $2::date AND $3::date AND offer_id=ANY($4::text[])`, args),
    query(`SELECT offer_id, (collected_at + INTERVAL '3 hours')::date::text d,
      AVG(NULLIF(marketing_seller_price,0)) seller, AVG(NULLIF(marketing_oa_price,0)) client
      FROM product_discount_history WHERE cabinet=$1 AND platform='ozon'
      AND collected_at >= $2::date - INTERVAL '3 hours' AND collected_at < $3::date + INTERVAL '21 hours'
      AND offer_id=ANY($4::text[]) GROUP BY offer_id, (collected_at + INTERVAL '3 hours')::date`, args),
    query(`SELECT offer_id, date::text d, seller, card client FROM price_daily
      WHERE cabinet=$1 AND date BETWEEN $2::date AND $3::date AND offer_id=ANY($4::text[])`, args),
  ]);
  return mergeDailyPrices(samples, history, daily);
}
module.exports = { recordDailyAdPrices, dailyAdPrices, mergeDailyPrices };
