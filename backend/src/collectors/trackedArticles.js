const { query } = require('../db');
const { notifyNewOrder } = require('../telegram');

// Отслеживание артикулов + уведомления в Telegram о новых заказах.
// Логика сопоставления специально гибкая: для WB пользователь может указать
// либо числовой артикул WB (nmId), либо свой "Артикул продавца"
// (supplierArticle) — так привычнее большинству продавцов. Для Ozon —
// offer_id (свой код) или SKU Ozon.

async function listTracked(cabinet) {
  return query(`SELECT * FROM tracked_articles WHERE cabinet = $1 ORDER BY created_at DESC`, [cabinet]);
}

async function addTracked(cabinet, platform, article, label) {
  const rows = await query(
    `INSERT INTO tracked_articles (cabinet, platform, article, label)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (cabinet, platform, article) DO UPDATE SET label = EXCLUDED.label, active = TRUE
     RETURNING *`,
    [cabinet, platform, String(article).trim(), label ? String(label).trim() : null]
  );
  return rows[0];
}

async function removeTracked(cabinet, id) {
  await query(`DELETE FROM tracked_articles WHERE cabinet = $1 AND id = $2`, [cabinet, id]);
}

async function getActiveTracked(cabinet, platform) {
  return query(
    `SELECT * FROM tracked_articles WHERE cabinet = $1 AND platform = $2 AND active = TRUE`,
    [cabinet, platform]
  );
}

function matchesArticle(platform, trackedValue, row) {
  const v = String(trackedValue || '').trim().toLowerCase();
  if (!v) return false;
  if (platform === 'wb') {
    return (
      (row.nm_id != null && String(row.nm_id) === v) ||
      (row.supplier_article && String(row.supplier_article).toLowerCase() === v) ||
      (row.article && String(row.article).toLowerCase() === v)
    );
  }
  return (
    (row.offer_id && String(row.offer_id).toLowerCase() === v) ||
    (row.sku != null && String(row.sku) === v)
  );
}

// newRows — массив свежевставленных (реально НОВЫХ, не повторных) строк
// заказов за этот прогон сборщика. См. collectors/wb/orders.js и
// collectors/ozon/orders.js — там это определяется через RETURNING на
// INSERT, а не задним числом сравнением, чтобы не задваивать уведомления
// при повторном сборе одного и того же окна дат.
async function checkAndNotify(cabinet, platform, newRows) {
  if (!newRows || !newRows.length) return;
  const tracked = await getActiveTracked(cabinet, platform).catch(() => []);
  if (!tracked.length) return;

  for (const row of newRows) {
    const match = tracked.find(t => matchesArticle(platform, t.article, row));
    if (!match) continue;
    await notifyNewOrder(cabinet, platform, match, row).catch(e =>
      console.error(`[TrackedArticles:${cabinet}] Telegram:`, e.message)
    );
    await query(
      `INSERT INTO order_notifications_log (cabinet, platform, article, label, order_ref, price, product_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [cabinet, platform, match.article, match.label, row.orderRef || null, row.price || null, row.productName || null]
    ).catch(() => {});
  }
}

async function getFeed(cabinet, limit = 50) {
  return query(
    `SELECT * FROM order_notifications_log WHERE cabinet = $1 ORDER BY sent_at DESC LIMIT $2`,
    [cabinet, limit]
  );
}

module.exports = { listTracked, addTracked, removeTracked, checkAndNotify, getFeed };
