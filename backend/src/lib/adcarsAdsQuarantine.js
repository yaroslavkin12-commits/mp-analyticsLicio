const { getPool } = require('../db');

const tables = [
  'ad_campaigns', 'ad_stats_daily', 'ad_campaign_skus', 'ad_sku_stats_daily',
  'ad_cpo_orders', 'ad_cpo_products', 'ad_cpc_bids', 'ad_events',
];

async function quarantineAdcarsAds() {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, 'true', NOW())
       ON CONFLICT (key) DO NOTHING`, ['migration:adcars-defly-performance-20261125'],
    );
    if (rowCount) {
      for (const table of tables) {
        const scope = table === 'ad_events' ? ' AND auto = true' : '';
        await client.query(
          `UPDATE ${table} SET cabinet = $2 WHERE cabinet = $1 AND platform = 'ozon'${scope}`,
          ['adcars', 'adcars_wrong_perf_20261125'],
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
module.exports = { quarantineAdcarsAds };
