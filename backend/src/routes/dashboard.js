const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const dayjs = require('dayjs');

// Себестоимость (product_costs, вводится вручную в Настройках) даёт нам
// возможность прикинуть чистую прибыль и маржинальность. Важная оговорка,
// которую стоит держать в голове при чтении этих цифр: у WB "выручка" уже
// нетто — for_pay это то, что WB реально перечисляет продавцу ПОСЛЕ своей
// комиссии и логистики. У Ozon же "выручка" (см. комментарий ниже) — это
// цена*кол-во, то есть то, что заплатил покупатель, ДО вычета комиссии
// Ozon (payout от Ozon приходит с задержкой и часто пустой сразу после
// доставки — см. комментарий в /overview для ozon). Поэтому чистая прибыль
// по Ozon в текущем виде занижена меньше, чем должна быть — комиссия
// маркетплейса пока не вычитается. Когда payout стабилизируется, стоит
// переключить на него.

// GET /api/dashboard/overview?platform=all&dateFrom=&dateTo=
router.get('/overview', async (req, res) => {
  try {
    const { platform = 'all', dateFrom, dateTo } = req.query;
    const from = dateFrom || dayjs().subtract(30,'day').format('YYYY-MM-DD');
    const to   = dateTo   || dayjs().format('YYYY-MM-DD');
    const result = {};

    if (platform === 'all' || platform === 'wb') {
      // Сумма заказов = ВСЕ заказы (total_price до скидки продавца — как в WB аналитике)
      const [wbO] = await query(`
        SELECT
          COUNT(*) FILTER (WHERE is_cancel = false)              as orders_qty,
          SUM(total_price) FILTER (WHERE is_cancel = false)      as orders_sum
        FROM wb_orders WHERE date BETWEEN $1 AND $2
      `, [from, to]);

      // Выручка = фактические продажи (for_pay) из wb_sales (что выкупили и оплатили)
      const [wbS] = await query(`
        SELECT
          COUNT(*)     as sales_qty,
          SUM(for_pay) as revenue
        FROM wb_sales WHERE date BETWEEN $1 AND $2
      `, [from, to]);

      const [wbA] = await query(`
        SELECT SUM(spend) as spend FROM wb_ads WHERE date BETWEEN $1 AND $2
      `, [from, to]);

      // Себестоимость проданного — джойним каждую строку продажи (1 шт. на
      // строку в wb_sales) с себестоимостью по артикулу из Настроек.
      const [wbC] = await query(`
        SELECT COALESCE(SUM(pc.cost_price), 0) as cost_sum
        FROM wb_sales s
        JOIN product_costs pc ON pc.platform = 'wb' AND pc.article = s.supplier_article
        WHERE s.date BETWEEN $1 AND $2
      `, [from, to]);

      const ordersQty = Number(wbO?.orders_qty || 0);
      const ordersSum = Number(wbO?.orders_sum || 0);
      const salesQty  = Number(wbS?.sales_qty  || 0);
      const revenue   = Number(wbS?.revenue    || 0);
      const adSpend   = Number(wbA?.spend      || 0);
      const costSum   = Number(wbC?.cost_sum   || 0);
      const netProfit = revenue - costSum - adSpend;

      result.wb = {
        orders_sum:      ordersSum,
        orders_qty:      ordersQty,
        revenue:         revenue,
        sales_qty:       salesQty,
        redemption_rate: ordersQty > 0 ? (salesQty / ordersQty * 100).toFixed(1) : 0,
        ad_spend:        adSpend,
        drr:             ordersSum > 0 ? (adSpend / ordersSum * 100).toFixed(1) : 0,
        cost_sum:        costSum,
        net_profit:      netProfit,
        margin_pct:      revenue > 0 ? (netProfit / revenue * 100).toFixed(1) : 0,
      };
    }

    if (platform === 'all' || platform === 'ozon') {
      // Сумма заказов = ВСЕ заказы включая отменённые (как в Ozon аналитике "Заказано на сумму")
      const [ozAll] = await query(`
        SELECT
          SUM(quantity)         as orders_qty,
          SUM(price * quantity) as orders_sum
        FROM ozon_orders
        WHERE date BETWEEN $1 AND $2
      `, [from, to]);

      // Выручка / Продажи = фактическая продажа — статус "delivered" (= "Доставлено" в кабинете Ozon,
      // товар получен и оплачен покупателем). "Выкуплено" в отчётах Ozon — это НЕ то же самое: туда
      // попадают заказы ещё в пути / ожидающие клиента в ПВЗ, которые ещё не факт продажи.
      // Выручку считаем по price*quantity (сумма, которую заплатил покупатель), а не по payout —
      // payout (нетто-выплата после комиссии) заполняется Ozon с задержкой и первое время после
      // доставки часто равен 0, из-за чего "Выручка" на дашборде обнулялась.
      const [ozDel] = await query(`
        SELECT
          SUM(quantity)         as sales_qty,
          SUM(price * quantity) as revenue
        FROM ozon_orders
        WHERE date BETWEEN $1 AND $2
          AND status = 'delivered'
      `, [from, to]);

      const [ozA] = await query(`
        SELECT SUM(spend) as spend FROM ozon_ads WHERE date BETWEEN $1 AND $2
      `, [from, to]);

      // Себестоимость проданного (delivered) — cost_price за штуку * количество.
      const [ozC] = await query(`
        SELECT COALESCE(SUM(pc.cost_price * o.quantity), 0) as cost_sum
        FROM ozon_orders o
        JOIN product_costs pc ON pc.platform = 'ozon' AND pc.article = o.offer_id
        WHERE o.date BETWEEN $1 AND $2 AND o.status = 'delivered'
      `, [from, to]);

      const ordersQty = Number(ozAll?.orders_qty || 0);
      const ordersSum = Number(ozAll?.orders_sum || 0);
      const salesQty  = Number(ozDel?.sales_qty  || 0);
      const revenue   = Number(ozDel?.revenue    || 0);
      const adSpend   = Number(ozA?.spend        || 0);
      const costSum   = Number(ozC?.cost_sum     || 0);
      const netProfit = revenue - costSum - adSpend;

      result.ozon = {
        orders_sum:      ordersSum,
        orders_qty:      ordersQty,
        revenue:         revenue,
        sales_qty:       salesQty,
        redemption_rate: ordersQty > 0 ? (salesQty / ordersQty * 100).toFixed(1) : 0,
        ad_spend:        adSpend,
        drr:             ordersSum > 0 ? (adSpend / ordersSum * 100).toFixed(1) : 0,
        cost_sum:        costSum,
        net_profit:      netProfit,
        margin_pct:      revenue > 0 ? (netProfit / revenue * 100).toFixed(1) : 0,
      };
    }

    // Сводный блок "Все площадки" — деньги просто складываем, а проценты
    // пересчитываем от суммарных чисел (не усредняем сами проценты).
    if (result.wb && result.ozon) {
      const ordersSum = result.wb.orders_sum + result.ozon.orders_sum;
      const ordersQty = result.wb.orders_qty + result.ozon.orders_qty;
      const revenue   = result.wb.revenue    + result.ozon.revenue;
      const salesQty  = result.wb.sales_qty  + result.ozon.sales_qty;
      const adSpend   = result.wb.ad_spend   + result.ozon.ad_spend;
      const netProfit = result.wb.net_profit + result.ozon.net_profit;

      result.all = {
        orders_sum:      ordersSum,
        orders_qty:      ordersQty,
        revenue:         revenue,
        sales_qty:       salesQty,
        redemption_rate: ordersQty > 0 ? (salesQty / ordersQty * 100).toFixed(1) : 0,
        ad_spend:        adSpend,
        drr:             ordersSum > 0 ? (adSpend / ordersSum * 100).toFixed(1) : 0,
        cost_sum:        result.wb.cost_sum + result.ozon.cost_sum,
        net_profit:      netProfit,
        margin_pct:      revenue > 0 ? (netProfit / revenue * 100).toFixed(1) : 0,
      };
    }

    res.json({ success: true, data: result, period: { from, to } });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Объединяет несколько массивов вида [{date, ...поля}] в один по датам —
// чтобы не писать один гигантский SQL-джойн на несколько независимых
// источников (заказы/продажи/себестоимость/реклама лежат в разных таблицах).
function mergeByDate(...parts) {
  const map = new Map();
  for (const part of parts) {
    for (const row of part) {
      const rec = map.get(row.date) || { date: row.date };
      Object.assign(rec, row);
      map.delete(row.date);
      map.set(row.date, rec);
    }
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function num(v) { return Number(v || 0); }

// Достраивает производные метрики (% выкупа, прибыль, % маржинальности) поверх
// уже слитых по датам "сырых" сумм — общая логика для WB и Ozon.
function withDerived(rows) {
  return rows.map(r => {
    const ordersQty = num(r.orders_qty);
    const salesQty  = num(r.sales_qty);
    const salesSum  = num(r.sales_sum);
    const costSum   = num(r.cost_sum);
    const adSpend   = num(r.ad_spend);
    const netProfit = salesSum - costSum - adSpend;
    return {
      date: r.date,
      orders_sum:     num(r.orders_sum),
      orders_qty:     ordersQty,
      sales_sum:      salesSum,
      sales_qty:      salesQty,
      redemption_pct: ordersQty > 0 ? +(salesQty / ordersQty * 100).toFixed(1) : 0,
      net_profit:     netProfit,
      margin_pct:     salesSum > 0 ? +(netProfit / salesSum * 100).toFixed(1) : 0,
    };
  });
}

// GET /api/dashboard/chart?platform=all&dateFrom=&dateTo=
// По дням: заказы (₽/шт), продажи-выкуп (₽/шт), % выкупа, чистая прибыль,
// % маржинальность — для гибкого графика на Дашборде (метрики выбирает
// фронт, здесь отдаём все посчитанные разом, чтобы не дёргать API на
// каждое переключение метрики).
router.get('/chart', async (req, res) => {
  try {
    const { platform = 'all', dateFrom, dateTo } = req.query;
    const from = dateFrom || dayjs().subtract(30,'day').format('YYYY-MM-DD');
    const to   = dateTo   || dayjs().format('YYYY-MM-DD');
    const result = {};

    if (platform === 'all' || platform === 'wb') {
      const [orders, sales, cost, ads] = await Promise.all([
        query(`
          SELECT date::text as date,
            SUM(total_price) FILTER (WHERE is_cancel=false) as orders_sum,
            COUNT(*) FILTER (WHERE is_cancel=false) as orders_qty
          FROM wb_orders WHERE date BETWEEN $1 AND $2 GROUP BY date
        `, [from, to]),
        query(`
          SELECT date::text as date, COUNT(*) as sales_qty, SUM(for_pay) as sales_sum
          FROM wb_sales WHERE date BETWEEN $1 AND $2 GROUP BY date
        `, [from, to]),
        query(`
          SELECT s.date::text as date, COALESCE(SUM(pc.cost_price), 0) as cost_sum
          FROM wb_sales s
          JOIN product_costs pc ON pc.platform = 'wb' AND pc.article = s.supplier_article
          WHERE s.date BETWEEN $1 AND $2 GROUP BY s.date
        `, [from, to]),
        query(`
          SELECT date::text as date, SUM(spend) as ad_spend
          FROM wb_ads WHERE date BETWEEN $1 AND $2 GROUP BY date
        `, [from, to]),
      ]);
      result.wb = withDerived(mergeByDate(orders, sales, cost, ads));
    }

    if (platform === 'all' || platform === 'ozon') {
      const [orders, sales, cost, ads] = await Promise.all([
        query(`
          SELECT date::text as date, SUM(price*quantity) as orders_sum, SUM(quantity) as orders_qty
          FROM ozon_orders WHERE date BETWEEN $1 AND $2 GROUP BY date
        `, [from, to]),
        query(`
          SELECT date::text as date, SUM(quantity) as sales_qty, SUM(price*quantity) as sales_sum
          FROM ozon_orders WHERE date BETWEEN $1 AND $2 AND status = 'delivered' GROUP BY date
        `, [from, to]),
        query(`
          SELECT o.date::text as date, COALESCE(SUM(pc.cost_price * o.quantity), 0) as cost_sum
          FROM ozon_orders o
          JOIN product_costs pc ON pc.platform = 'ozon' AND pc.article = o.offer_id
          WHERE o.date BETWEEN $1 AND $2 AND o.status = 'delivered' GROUP BY o.date
        `, [from, to]),
        query(`
          SELECT date::text as date, SUM(spend) as ad_spend
          FROM ozon_ads WHERE date BETWEEN $1 AND $2 GROUP BY date
        `, [from, to]),
      ]);
      result.ozon = withDerived(mergeByDate(orders, sales, cost, ads));
    }

    // "Все площадки" — те же даты, суммируем денежные/количественные поля,
    // проценты пересчитываем от суммы, а не усредняем.
    if (result.wb && result.ozon) {
      const byDate = new Map();
      for (const r of [...result.wb, ...result.ozon]) {
        const acc = byDate.get(r.date) || {
          date: r.date, orders_sum: 0, orders_qty: 0, sales_sum: 0, sales_qty: 0, net_profit: 0,
        };
        acc.orders_sum += r.orders_sum;
        acc.orders_qty += r.orders_qty;
        acc.sales_sum  += r.sales_sum;
        acc.sales_qty  += r.sales_qty;
        acc.net_profit += r.net_profit;
        byDate.set(r.date, acc);
      }
      result.all = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).map(r => ({
        ...r,
        redemption_pct: r.orders_qty > 0 ? +(r.sales_qty / r.orders_qty * 100).toFixed(1) : 0,
        margin_pct:     r.sales_sum > 0 ? +(r.net_profit / r.sales_sum * 100).toFixed(1) : 0,
      }));
    }

    res.json({ success: true, data: result });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/dashboard/stocks
router.get('/stocks', async (req, res) => {
  try {
    const { platform = 'all' } = req.query;
    const result = {};
    if (platform === 'all' || platform === 'wb') {
      result.wb = await query(`
        SELECT nm_id, supplier_article as article, subject, category,
          SUM(quantity) as total_quantity, MAX(snapshot_date)::text as last_update
        FROM wb_stocks
        WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM wb_stocks)
        GROUP BY nm_id, supplier_article, subject, category
        ORDER BY total_quantity ASC LIMIT 200
      `);
    }
    if (platform === 'all' || platform === 'ozon') {
      result.ozon = await query(`
        SELECT sku, offer_id, product_name,
          SUM(fbo_present) as fbo_qty, SUM(fbs_present) as fbs_qty,
          SUM(fbo_present+fbs_present) as total_qty,
          MAX(snapshot_date)::text as last_update
        FROM ozon_stocks
        WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM ozon_stocks)
        GROUP BY sku, offer_id, product_name
        ORDER BY total_qty ASC LIMIT 200
      `);
    }
    res.json({ success: true, data: result });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/dashboard/stocks-v2
// Остатки, сгруппированные по базовому артикулу (модель+цвет), с разбивкой по
// размеру, площадке (WB/Ozon) и типу фулфилмента (FBO/FBS). Категория и пол
// определяются по префиксу/токенам базового артикула (lib/productTaxonomy.js),
// а не по «сырым» категориям WB/Ozon — те слишком разнородны между площадками
// для нормального фильтра.
//
// Фото: основной источник — каталог Ozon (ozon_catalog, реальные картинки,
// полученные через API карточки товара — см. collectors/ozon/catalog.js).
// Формула по nmId для WB (wbPhoto.js) используется только как запасной вариант,
// когда для товара нет карточки на Ozon — таблица диапазонов "корзин" WB
// периодически устаревает по мере роста nmId, поэтому не все WB-фото по ней
// открываются. Отдаём фронту оба вариант (photoUrl — основной, photoUrlAlt —
// запасной), чтобы при ошибке загрузки картинки можно было попробовать второй.
router.get('/stocks-v2', async (req, res) => {
  try {
    const { parseArticle } = require('../lib/articleGrouping');
    const { wbPhotoUrl } = require('../lib/wbPhoto');
    const { detectCategory, detectGender, ALL_CATEGORY_LABELS } = require('../lib/productTaxonomy');

    const [wbRows, ozonRows, ozonCatalog] = await Promise.all([
      query(`
        SELECT nm_id, supplier_article, subject, category, tech_size, warehouse_name, stock_type, quantity
        FROM wb_stocks w
        WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM wb_stocks w2 WHERE w2.stock_type = w.stock_type)
          AND supplier_article IS NOT NULL
      `),
      query(`
        SELECT offer_id, sku, fbo_present, fbs_present
        FROM ozon_stocks
        WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM ozon_stocks)
          AND offer_id IS NOT NULL
      `),
      query(`SELECT offer_id, product_name, photo_url FROM ozon_catalog`),
    ]);

    const catalogByOffer = new Map(ozonCatalog.map(c => [c.offer_id, c]));
    const products = new Map(); // baseArticle -> product

    function getProduct(baseArticle) {
      if (!products.has(baseArticle)) {
        products.set(baseArticle, {
          baseArticle,
          category: detectCategory(baseArticle),
          gender: detectGender(baseArticle),
          subject: null,
          photoUrlOzon: null, // из каталога Ozon — приоритетный источнии
          photoUrlWb: null,   // по формуле nmId — запасной вариант
          sizes: new Map(), // size -> {wb_fbo, wb_fbs, ozon_fbo, ozon_fbs}
          wbFbsWarehouses: new Map(), // склад FBS (WB) -> кол-во, для разбивки по складам
        });
      }
      return products.get(baseArticle);
    }
    function getSize(product, size) {
      const key = size || '—';
      if (!product.sizes.has(key)) {
        product.sizes.set(key, { wb_fbo: 0, wb_fbs: 0, ozon_fbo: 0, ozon_fbs: 0 });
      }
      return product.sizes.get(key);
    }

    for (const r of wbRows) {
      const p = getProduct(r.supplier_article);
      if (!p.photoUrlWb && r.nm_id) p.photoUrlWb = wbPhotoUrl(r.nm_id);
      if (!p.subject && r.subject) p.subject = r.subject;
      const s = getSize(p, r.tech_size);
      const field = r.stock_type === 'fbs' ? 'wb_fbs' : 'wb_fbo';
      const qty = Number(r.quantity) || 0;
      s[field] += qty;
      if (r.stock_type === 'fbs') {
        const wh = r.warehouse_name || 'Без названия';
        p.wbFbsWarehouses.set(wh, (p.wbFbsWarehouses.get(wh) || 0) + qty);
      }
    }

    for (const r of ozonRows) {
      const { baseArticle, size } = parseArticle(r.offer_id);
      const p = getProduct(baseArticle);
      const cat = catalogByOffer.get(r.offer_id);
      if (!p.photoUrlOzon && cat?.photo_url) p.photoUrlOzon = cat.photo_url;
      if (!p.subject && cat?.product_name) p.subject = cat.product_name;
      const s = getSize(p, size);
      s.ozon_fbo += Number(r.fbo_present) || 0;
      s.ozon_fbs += Number(r.fbs_present) || 0;
    }

    // FBS — это один и тот же физический остаток, который просто выгружается
    // сразу на обе площадки, а не два независимых остатка. Поэтому при
    // подсчёте «итого по обеим площадкам» его нельзя складывать (wb_fbs +
    // ozon_fbs) — берём максимум из двух значений как наиболее свежую оценку
    // (площадки синкают выгрузку с небольшой задержкой относительно друг
    // друга), и отмечаем факт расхождения, если оно есть.
    const result = [...products.values()].map(p => {
      const sizes = [...p.sizes.entries()].map(([size, q]) => {
        const fbsShared = Math.max(q.wb_fbs, q.ozon_fbs);
        return {
          size,
          wb_fbo: q.wb_fbo, wb_fbs: q.wb_fbs, ozon_fbo: q.ozon_fbo, ozon_fbs: q.ozon_fbs,
          fbs_shared: fbsShared,
          fbs_mismatch: q.wb_fbs !== q.ozon_fbs,
          wb_total: q.wb_fbo + q.wb_fbs,
          ozon_total: q.ozon_fbo + q.ozon_fbs,
          total: q.wb_fbo + q.ozon_fbo + fbsShared,
        };
      });
      const totals = sizes.reduce((a, s) => ({
        wb_fbo: a.wb_fbo + s.wb_fbo, wb_fbs: a.wb_fbs + s.wb_fbs,
        ozon_fbo: a.ozon_fbo + s.ozon_fbo, ozon_fbs: a.ozon_fbs + s.ozon_fbs,
        fbs_shared: a.fbs_shared + s.fbs_shared,
        total: a.total + s.total,
      }), { wb_fbo: 0, wb_fbs: 0, ozon_fbo: 0, ozon_fbs: 0, fbs_shared: 0, total: 0 });
      const wbFbsWarehouses = [...p.wbFbsWarehouses.entries()]
        .map(([warehouse, qty]) => ({ warehouse, qty }))
        .sort((a, b) => b.qty - a.qty);
      // Ozon-фото приоритетнее (реальная картинка из НPI), WB-формула — запасной
      // вариант, plus отдаём его отдельно как photoUrlAlt для фронта на случай,
      // если основная картинка не откроется (404/сеть).
      const photoUrl = p.photoUrlOzon || p.photoUrlWb || null;
      const photoUrlAlt = (p.photoUrlOzon && p.photoUrlWb && p.photoUrlWb !== p.photoUrlOzon) ? p.photoUrlWb : null;
      const { wbFbsWarehouses: _drop, photoUrlOzon: _po, photoUrlWb: _pw, ...rest } = p;
      return { ...rest, photoUrl, photoUrlAlt, sizes, totals, wbFbsWarehouses };
    }).sort((a, b) => a.baseArticle.localeCompare(b.baseArticle));

    const categories = [...ALL_CATEGORY_LABELS];
    if (result.some(p => p.category === 'Другое')) categories.push('Другое');

    res.json({ success: true, data: { products: result, categories } });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/dashboard/collection-log
router.get('/collection-log', async (req, res) => {
  try {
    const logs = await query(`SELECT * FROM collection_log ORDER BY started_at DESC LIMIT 50`);
    res.json({ success: true, data: logs });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
