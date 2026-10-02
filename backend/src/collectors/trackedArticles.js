const { query } = require('../db');
const { notifyNewOrder } = require('../telegram');

// Отслеживание артикулов + уведомления в Telegram о новых заказах.
// Логика сопоставления специально гибкая: для WB пользователь может указать
// либо числовой артикул WB (nmId), либо свой "Артикул продавца"
// (supplierArticle) — так привычнее большинству продавцов. Для Ozon —
// offer_id (свой код) или SKU Ozon.
//
// Тестируемые группы (tracked_groups) — опциональная группировка артикулов
// (например "Чехлы"), чтобы видеть сводную статистику по группе целиком, а
// не только по каждому артикулу отдельно. order_count артикула/группы — это
// просто COUNT уже отправленных уведомлений (order_notifications_log): так
// как уведомления шлются по каждому новому заказу без порогов и фильтров,
// количество уведомлений == количество реально поступивших заказов.

async function listGroups(cabinet) {
  return query(
    `SELECT g.*,
            (SELECT COUNT(*) FROM tracked_articles ta WHERE ta.group_id = g.id) AS articles_count,
            (SELECT COUNT(*) FROM order_notifications_log onl
               WHERE onl.cabinet = g.cabinet
                 AND (onl.article, onl.platform) IN (
                   SELECT ta2.article, ta2.platform FROM tracked_articles ta2 WHERE ta2.group_id = g.id
                 )
            ) AS total_orders
     FROM tracked_groups g WHERE g.cabinet = $1 ORDER BY g.created_at ASC`,
    [cabinet]
  );
}

async function addGroup(cabinet, name) {
  const rows = await query(
    `INSERT INTO tracked_groups (cabinet, name) VALUES ($1,$2)
     ON CONFLICT (cabinet, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [cabinet, String(name).trim()]
  );
  return rows[0];
}

async function removeGroup(cabinet, id) {
  // Артикулы группы не удаляются — ON DELETE SET NULL (см. postgres/init.sql),
  // они просто становятся "без группы".
  await query(`DELETE FROM tracked_groups WHERE cabinet = $1 AND id = $2`, [cabinet, id]);
}

async function setArticleGroup(cabinet, id, groupId) {
  const rows = await query(
    `UPDATE tracked_articles SET group_id = $3 WHERE cabinet = $1 AND id = $2 RETURNING *`,
    [cabinet, id, groupId || null]
  );
  return rows[0];
}

async function listTracked(cabinet) {
  return query(
    `SELECT ta.*, g.name AS group_name,
            COALESCE(cnt.order_count, 0) AS order_count
     FROM tracked_articles ta
     LEFT JOIN tracked_groups g ON g.id = ta.group_id
     LEFT JOIN (
       SELECT article, platform, COUNT(*) AS order_count
       FROM order_notifications_log
       WHERE cabinet = $1
       GROUP BY article, platform
     ) cnt ON cnt.article = ta.article AND cnt.platform = ta.platform
     WHERE ta.cabinet = $1
     ORDER BY ta.created_at DESC`,
    [cabinet]
  );
}

async function addTracked(cabinet, platform, article, label, groupId) {
  const rows = await query(
    `INSERT INTO tracked_articles (cabinet, platform, article, label, group_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (cabinet, platform, article) DO UPDATE SET
       label = EXCLUDED.label, group_id = EXCLUDED.group_id, active = TRUE
     RETURNING *`,
    [cabinet, platform, String(article).trim(), label ? String(label).trim() : null, groupId || null]
  );
  return rows[0];
}

async function removeTracked(cabinet, id) {
  await query(`DELETE FROM tracked_articles WHERE cabinet = $1 AND id = $2`, [cabinet, id]);
}

// Включает имя группы (g.name) — используется в тексте Telegram-уведомления
// (см. telegram.js:notifyNewOrder), чтобы сразу было видно, по какой
// тестируемой группе пришёл заказ.
async function getActiveTracked(cabinet, platform) {
  return query(
    `SELECT ta.*, g.name AS group_name
     FROM tracked_articles ta
     LEFT JOIN tracked_groups g ON g.id = ta.group_id
     WHERE ta.cabinet = $1 AND ta.platform = $2 AND ta.active = TRUE`,
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
// при повторном сборе одного и того же окна дат. Для кабинетов без общего
// сбора заказов (Defly) используется отдельный collectors/trackedOrdersPoll.js
// со своей дедупликацией (tracked_orders_seen), но итоговый вызов — тот же.
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

module.exports = {
  listTracked, addTracked, removeTracked, getActiveTracked, checkAndNotify, getFeed,
  listGroups, addGroup, removeGroup, setArticleGroup,
};
