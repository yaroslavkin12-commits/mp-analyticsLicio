// Старые SKU артикула. Когда Ozon меняет у карточки SKU (пересоздание, склейка),
// каталог перезаписывает SKU у артикула, а история (аналитика, реклама, запросы)
// лежит под старым SKU и «отрывалась» от артикула. Здесь помним старые SKU,
// чтобы история оставалась у того же артикула.
const { query } = require('../db');

let ready = null;
function ensure() {
  if (!ready) ready = (async () => {
    await query(`CREATE TABLE IF NOT EXISTS sku_alias (cabinet VARCHAR(32) NOT NULL, platform VARCHAR(16) NOT NULL DEFAULT 'ozon',
      sku BIGINT NOT NULL, offer_id VARCHAR(128) NOT NULL, replaced_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (cabinet, platform, sku))`);
    // Каталог + старые SKU: для запросов, где история сопоставляется с артикулом по SKU.
    await query(`CREATE OR REPLACE VIEW sku_offer AS
      SELECT cabinet, platform, sku, offer_id FROM ad_product_catalog WHERE sku IS NOT NULL
      UNION ALL
      SELECT a.cabinet, a.platform, a.sku, a.offer_id FROM sku_alias a
       WHERE NOT EXISTS (SELECT 1 FROM ad_product_catalog c WHERE c.cabinet = a.cabinet AND c.platform = a.platform AND c.sku = a.sku)`);
  })().catch(e => { ready = null; throw e; });
  return ready;
}

// Перед обновлением каталога: у каких артикулов меняется SKU — старый запоминаем.
async function rememberChanged(cabinet, rows /* [{offer_id, sku}] */) {
  await ensure();
  const cur = await query(`SELECT offer_id, sku FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND sku IS NOT NULL`, [cabinet]);
  const was = new Map(cur.map(r => [r.offer_id, String(r.sku)]));
  const changed = [];
  for (const r of rows) {
    const old = was.get(r.offer_id), now = r.sku ? String(r.sku) : null;
    if (old && now && old !== now && old !== '0') changed.push([old, r.offer_id]);
  }
  for (const [sku, offer] of changed) {
    await query(`INSERT INTO sku_alias (cabinet, platform, sku, offer_id) VALUES ($1, 'ozon', $2, $3)
      ON CONFLICT (cabinet, platform, sku) DO UPDATE SET offer_id = EXCLUDED.offer_id, replaced_at = NOW()`, [cabinet, sku, offer]);
    console.log(`[SKU] ${cabinet} ${offer}: SKU сменился ${sku} → новый; история старого SKU остаётся у артикула`);
  }
  return changed.length;
}

// Разово для уже случившихся смен: SKU из аналитики с известным артикулом, которых нет в каталоге.
const backfilled = new Set();
async function backfill(cabinet) {
  if (backfilled.has(cabinet)) return;
  backfilled.add(cabinet);
  await ensure();
  // Источники, где у строки записан и SKU, и артикул: аналитика и лента заказов.
  for (const [t, d] of [['product_analytics_daily', 'date'], ['order_feed', 'created_at']]) {
    await query(`INSERT INTO sku_alias (cabinet, platform, sku, offer_id)
      SELECT DISTINCT ON (p.sku) p.cabinet, 'ozon', p.sku::bigint, p.offer_id FROM ${t} p
       WHERE p.cabinet = $1 AND p.offer_id IS NOT NULL AND p.sku IS NOT NULL AND p.sku <> 0
         AND EXISTS (SELECT 1 FROM ad_product_catalog c WHERE c.cabinet = p.cabinet AND c.platform = 'ozon' AND c.offer_id = p.offer_id)
         AND NOT EXISTS (SELECT 1 FROM ad_product_catalog c WHERE c.cabinet = p.cabinet AND c.platform = 'ozon' AND c.sku::text = p.sku::text)
       ORDER BY p.sku, p.${d} DESC
      ON CONFLICT DO NOTHING`, [cabinet]).catch(e => console.warn('[SKU] backfill', t, cabinet, e.message));
  }
}

// Добавить старые SKU в карту «SKU → артикул» (текущие SKU каталога не перебиваем).
async function extend(map, cabinet) {
  try {
    await ensure();
    const rows = await query(`SELECT sku, offer_id FROM sku_alias WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet]);
    for (const r of rows) if (!map.has(String(r.sku))) map.set(String(r.sku), r.offer_id);
  } catch (e) { /* без старых SKU — как раньше */ }
  return map;
}
// Все SKU артикула: текущий и старые.
async function skusOf(cabinet, offerId) {
  await ensure().catch(() => {});
  const rows = await query(`SELECT sku FROM sku_offer WHERE cabinet = $1 AND platform = 'ozon' AND offer_id = $2`, [cabinet, offerId])
    .catch(() => query(`SELECT sku FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND offer_id = $2 AND sku IS NOT NULL`, [cabinet, offerId]));
  return rows.map(r => String(r.sku));
}

module.exports = { ensure, rememberChanged, backfill, extend, skusOf };
