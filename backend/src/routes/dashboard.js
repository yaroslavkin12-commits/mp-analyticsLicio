const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const dayjs = require('dayjs');
const { parseArticle } = require('../lib/articleGrouping');
const { detectCategory, detectGender, ALL_CATEGORY_LABELS } = require('../lib/productTaxonomy');

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

// ---- категоризация и загрузка "сырых" строк ----
//
// Категория определяется по базовому артикулу через ту же таксономию, что
// и на странице Остатки (lib/productTaxonomy), а не по "родным" категориям
// WB/Ozon — те слишком разнородны между площадками для общего фильтра.
// Артикул WB (supplier_article) уже является базовым; артикул Ozon
// (offer_id) содержит ещё и размер в конце — его сначала разбираем через
// parseArticle (lib/articleGrouping), как и на Остатках.
//
// Фильтрация по категории считается в JS (не в SQL), поэтому тянем сырые
// строки за период без группировки и агрегируем сами — и для /overview
// (итог за период), и для /chart (по дням). Объёмы данных у отдельного
// продавца небольшие (сотни-тысячи строк в месяц), так что это не проблема
// производительности.

function ozonCategoryOf(offerId) {
  return detectCategory(parseArticle(offerId).baseArticle);
}
function wbCategoryOf(supplierArticle) {
  return detectCategory(supplierArticle);
}

async function loadWbRaw(from, to) {
  const [orders, sales, ads, costs] = await Promise.all([
    query(`SELECT date::text as date, nm_id, supplier_article, total_price, is_cancel FROM wb_orders WHERE date BETWEEN $1 AND $2`, [from, to]),
    query(`SELECT date::text as date, nm_id, supplier_article, for_pay FROM wb_sales WHERE date BETWEEN $1 AND $2`, [from, to]),
    query(`SELECT date::text as date, nm_id, spend FROM wb_ads WHERE date BETWEEN $1 AND $2`, [from, to]),
    query(`SELECT article, cost_price FROM product_costs WHERE platform='wb'`),
  ]);

  // wb_ads даёт nm_id, а не supplier_article — строим карту соответствия
  // по уже загруженным заказам/продажам, чтобы можно было фильтровать
  // расходы на рекламу по той же категории.
  const nmToArticle = new Map();
  for (const r of orders) if (r.nm_id != null && r.supplier_article) nmToArticle.set(String(r.nm_id), r.supplier_article);
  for (const r of sales)  if (r.nm_id != null && r.supplier_article) nmToArticle.set(String(r.nm_id), r.supplier_article);

  const costByArticle = new Map(costs.map(c => [c.article, Number(c.cost_price) || 0]));

  for (const r of orders) r.category = wbCategoryOf(r.supplier_article);
  for (const r of sales)  { r.category = wbCategoryOf(r.supplier_article); r.cost = costByArticle.get(r.supplier_article) || 0; }
  for (const r of ads)    r.category = wbCategoryOf(nmToArticle.get(String(r.nm_id)) || '');

  return { orders, sales, ads };
}

async function loadOzonRaw(from, to) {
  const [orders, ads, costs, analytics] = await Promise.all([
    query(`SELECT date::text as date, offer_id, price, quantity, status FROM ozon_orders WHERE date BETWEEN $1 AND $2`, [from, to]),
    query(`SELECT date::text as date, offer_id, spend FROM ozon_ads WHERE date BETWEEN $1 AND $2`, [from, to]),
    query(`SELECT article, cost_price FROM product_costs WHERE platform='ozon'`),
    query(`SELECT date::text as date, offer_id, hits_view, hits_view_pdp, hits_tocart FROM ozon_analytics WHERE date BETWEEN $1 AND $2`, [from, to]),
  ]);

  const costByArticle = new Map(costs.map(c => [c.article, Number(c.cost_price) || 0]));

  for (const r of orders)    { r.category = ozonCategoryOf(r.offer_id); r.cost = (costByArticle.get(r.offer_id) || 0) * (Number(r.quantity) || 1); }
  for (const r of ads)       r.category = ozonCategoryOf(r.offer_id);
  for (const r of analytics) r.category = ozonCategoryOf(r.offer_id);

  return { orders, ads, analytics };
}

function byCat(rows, category) {
  return category ? rows.filter(r => r.category === category) : rows;
}
function num(v) { return Number(v || 0); }
function pct1(a, b) { return b > 0 ? +((a / b) * 100).toFixed(1) : 0; }

// GET /api/dashboard/categories — список категорий для фильтра (тот же
// справочник, что и на Остатках).
router.get('/categories', (req, res) => {
  res.json({ success: true, data: ALL_CATEGORY_LABELS.concat('Другое') });
});

// GET /api/dashboard/overview?platform=all&dateFrom=&dateTo=&category=
router.get('/overview', async (req, res) => {
  try {
    const { platform = 'all', dateFrom, dateTo, category } = req.query;
    const from = dateFrom || dayjs().subtract(30,'day').format('YYYY-MM-DD');
    const to   = dateTo   || dayjs().format('YYYY-MM-DD');
    const cat = category && category !== 'all' ? category : null;
    const result = {};

    if (platform === 'all' || platform === 'wb') {
      const { orders, sales, ads } = await loadWbRaw(from, to);
      const o = byCat(orders, cat).filter(r => !r.is_cancel);
      const s = byCat(sales, cat);
      const a = byCat(ads, cat);

      const ordersQty = o.length;
      const ordersSum = o.reduce((sum, r) => sum + num(r.total_price), 0);
      const salesQty  = s.length;
      const revenue   = s.reduce((sum, r) => sum + num(r.for_pay), 0);
      const adSpend   = a.reduce((sum, r) => sum + num(r.spend), 0);
      const costSum   = s.reduce((sum, r) => sum + num(r.cost), 0);
      const netProfit = revenue - costSum - adSpend;

      result.wb = {
        orders_sum: ordersSum, orders_qty: ordersQty, revenue, sales_qty: salesQty,
        redemption_rate: pct1(salesQty, ordersQty).toFixed(1),
        ad_spend: adSpend, drr: pct1(adSpend, ordersSum).toFixed(1),
        cost_sum: costSum, net_profit: netProfit,
        margin_pct: pct1(netProfit, revenue).toFixed(1),
      };
    }

    if (platform === 'all' || platform === 'ozon') {
      const { orders, ads } = await loadOzonRaw(from, to);
      const oAll = byCat(orders, cat);
      const oDel = oAll.filter(r => r.status === 'delivered');
      const a = byCat(ads, cat);

      const ordersQty = oAll.reduce((sum, r) => sum + num(r.quantity || 1), 0);
      const ordersSum = oAll.reduce((sum, r) => sum + num(r.price) * num(r.quantity || 1), 0);
      const salesQty  = oDel.reduce((sum, r) => sum + num(r.quantity || 1), 0);
      const revenue   = oDel.reduce((sum, r) => sum + num(r.price) * num(r.quantity || 1), 0);
      const adSpend   = a.reduce((sum, r) => sum + num(r.spend), 0);
      const costSum   = oDel.reduce((sum, r) => sum + num(r.cost), 0);
      const netProfit = revenue - costSum - adSpend;

      result.ozon = {
        orders_sum: ordersSum, orders_qty: ordersQty, revenue, sales_qty: salesQty,
        redemption_rate: pct1(salesQty, ordersQty).toFixed(1),
        ad_spend: adSpend, drr: pct1(adSpend, ordersSum).toFixed(1),
        cost_sum: costSum, net_profit: netProfit,
        margin_pct: pct1(netProfit, revenue).toFixed(1),
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
        orders_sum: ordersSum, orders_qty: ordersQty, revenue, sales_qty: salesQty,
        redemption_rate: pct1(salesQty, ordersQty).toFixed(1),
        ad_spend: adSpend, drr: pct1(adSpend, ordersSum).toFixed(1),
        cost_sum: result.wb.cost_sum + result.ozon.cost_sum, net_profit: netProfit,
        margin_pct: pct1(netProfit, revenue).toFixed(1),
      };
    }

    res.json({ success: true, data: result, period: { from, to } });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

function groupByDate(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.date)) m.set(r.date, []);
    m.get(r.date).push(r);
  }
  return m;
}
function allDatesOf(...maps) {
  const s = new Set();
  for (const m of maps) for (const d of m.keys()) s.add(d);
  return [...s].sort();
}

// GET /api/dashboard/chart?platform=all&dateFrom=&dateTo=&category=
// По дням: заказы (₽/шт), продажи-выкуп (₽/шт), % выкупа, чистая прибыль,
// % маржинальности, ДРР, расходы на рекламу, а для Ozon ещё и воронка
// (показы/переходы в карточку/добавления в корзину) — для гибкого графика
// на Дашборде. Опциональный `category` фильтрует все метрики по одной
// товарной категории (см. loadWbRaw/loadOzonRaw выше).
router.get('/chart', async (req, res) => {
  try {
    const { platform = 'all', dateFrom, dateTo, category } = req.query;
    const from = dateFrom || dayjs().subtract(30,'day').format('YYYY-MM-DD');
    const to   = dateTo   || dayjs().format('YYYY-MM-DD');
    const cat = category && category !== 'all' ? category : null;
    const result = {};

    let wbByDate = null, ozonByDate = null;

    if (platform === 'all' || platform === 'wb') {
      const { orders, sales, ads } = await loadWbRaw(from, to);
      const oByDate = groupByDate(byCat(orders, cat).filter(r => !r.is_cancel));
      const sByDate = groupByDate(byCat(sales, cat));
      const aByDate = groupByDate(byCat(ads, cat));
      const dates = allDatesOf(oByDate, sByDate, aByDate);

      wbByDate = new Map();
      for (const date of dates) {
        const o = oByDate.get(date) || [];
        const s = sByDate.get(date) || [];
        const a = aByDate.get(date) || [];
        const ordersQty = o.length;
        const ordersSum = o.reduce((sum, r) => sum + num(r.total_price), 0);
        const salesQty  = s.length;
        const salesSum  = s.reduce((sum, r) => sum + num(r.for_pay), 0);
        const costSum   = s.reduce((sum, r) => sum + num(r.cost), 0);
        const adSpend   = a.reduce((sum, r) => sum + num(r.spend), 0);
        const netProfit = salesSum - costSum - adSpend;
        wbByDate.set(date, {
          date, orders_sum: ordersSum, orders_qty: ordersQty,
          sales_sum: salesSum, sales_qty: salesQty, ad_spend: adSpend,
          redemption_pct: pct1(salesQty, ordersQty),
          drr_pct: pct1(adSpend, ordersSum),
          net_profit: netProfit,
          margin_pct: pct1(netProfit, salesSum),
          impressions: 0, pdp_views: 0, add_to_cart: 0,
        });
      }
      result.wb = dates.map(d => wbByDate.get(d));
    }

    if (platform === 'all' || platform === 'ozon') {
      const { orders, ads, analytics } = await loadOzonRaw(from, to);
      const allByDate = groupByDate(byCat(orders, cat));
      const aByDate   = groupByDate(byCat(ads, cat));
      const anByDate  = groupByDate(byCat(analytics, cat));
      const dates = allDatesOf(allByDate, aByDate, anByDate);

      ozonByDate = new Map();
      for (const date of dates) {
        const oAll = allByDate.get(date) || [];
        const oDel = oAll.filter(r => r.status === 'delivered');
        const a  = aByDate.get(date) || [];
        const an = anByDate.get(date) || [];
        const ordersQty = oAll.reduce((sum, r) => sum + num(r.quantity || 1), 0);
        const ordersSum = oAll.reduce((sum, r) => sum + num(r.price) * num(r.quantity || 1), 0);
        const salesQty  = oDel.reduce((sum, r) => sum + num(r.quantity || 1), 0);
        const salesSum  = oDel.reduce((sum, r) => sum + num(r.price) * num(r.quantity || 1), 0);
        const costSum   = oDel.reduce((sum, r) => sum + num(r.cost), 0);
        const adSpend   = a.reduce((sum, r) => sum + num(r.spend), 0);
        const netProfit = salesSum - costSum - adSpend;
        const impressions = an.reduce((sum, r) => sum + num(r.hits_view), 0);
        const pdpViews     = an.reduce((sum, r) => sum + num(r.hits_view_pdp), 0);
        const addToCart    = an.reduce((sum, r) => sum + num(r.hits_tocart), 0);
        ozonByDate.set(date, {
          date, orders_sum: ordersSum, orders_qty: ordersQty,
          sales_sum: salesSum, sales_qty: salesQty, ad_spend: adSpend,
          redemption_pct: pct1(salesQty, ordersQty),
          drr_pct: pct1(adSpend, ordersSum),
          net_profit: netProfit,
          margin_pct: pct1(netProfit, salesSum),
          impressions, pdp_views: pdpViews, add_to_cart: addToCart,
        });
      }
      result.ozon = dates.map(d => ozonByDate.get(d));
    }

    // "Все площадки" — те же даты, суммируем денежные/количественные поля
    // (включая показы Ozon — WB просто не участвует в этой метрике),
    // проценты пересчитываем от суммы, а не усредняем.
    if (wbByDate && ozonByDate) {
      const dates = allDatesOf(wbByDate, ozonByDate);
      result.all = dates.map(date => {
        const w = wbByDate.get(date) || {};
        const o = ozonByDate.get(date) || {};
        const ordersSum = num(w.orders_sum) + num(o.orders_sum);
        const ordersQty = num(w.orders_qty) + num(o.orders_qty);
        const salesSum  = num(w.sales_sum)  + num(o.sales_sum);
        const salesQty  = num(w.sales_qty)  + num(o.sales_qty);
        const adSpend   = num(w.ad_spend)   + num(o.ad_spend);
        const netProfit = num(w.net_profit) + num(o.net_profit);
        return {
          date, orders_sum: ordersSum, orders_qty: ordersQty,
          sales_sum: salesSum, sales_qty: salesQty, ad_spend: adSpend,
          redemption_pct: pct1(salesQty, ordersQty),
          drr_pct: pct1(adSpend, ordersSum),
          net_profit: netProfit,
          margin_pct: pct1(netProfit, salesSum),
          impressions: num(o.impressions), pdp_views: num(o.pdp_views), add_to_cart: num(o.add_to_cart),
        };
      });
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

// GET /api/dashboard/stocks-history?days=30
// История остатков по дням. Снимок остатков хранится ровно один на
// календарную дату (см. collectors/wb/stocks.js и collectors/ozon/stocks.js —
// там DELETE+INSERT по snapshot_date перед каждой записью), поэтому история
// по датам уже накоплена и ничего досчитывать заново не нужно. Отдаём по
// каждому базовому артикулу сумму по размерам на каждую дату — этого
// достаточно и для мини-графика в таблице на Остатках, и чтобы на фронте
// посчитать агрегат по любой комбинации категория/пол/площадка через ту же
// функцию qtyOf(), что уже используется для текущего (последнего) снимка.
// ВРЕМЕННЫЙ диагностический роут — проверить, нет ли задвоенных снимков по датам
// (снимок должен быть ровно один на дату, если коллектор один раз в день делает
// DELETE+INSERT; задвоение объясняло бы аномальный скачок в истории 03.09).
router.get('/debug-stock-dupes-v2', async (req, res) => {
  try {
    const [wbByType, wbKeyCounts, ozonKeyCounts, wbBatches] = await Promise.all([
      query(`
        SELECT stock_type, COUNT(*) as rows, COUNT(DISTINCT supplier_article) as distinct_articles
        FROM wb_stocks WHERE snapshot_date = '2026-09-03'
        GROUP BY stock_type
      `),
      query(`
        SELECT supplier_article, tech_size, warehouse_name, stock_type, COUNT(*) as cnt
        FROM wb_stocks WHERE snapshot_date = '2026-09-03' AND supplier_article = 'HoodMen-1'
        GROUP BY supplier_article, tech_size, warehouse_name, stock_type
        ORDER BY cnt DESC LIMIT 20
      `),
      query(`
        SELECT offer_id, COUNT(*) as cnt, array_agg(DISTINCT fbo_present) as fbo_vals, array_agg(DISTINCT fbs_present) as fbs_vals
        FROM ozon_stocks WHERE snapshot_date = '2026-09-03'
        GROUP BY offer_id
        ORDER BY cnt DESC LIMIT 10
      `),
      query(`
        SELECT date_trunc('minute', collected_at) as minute, COUNT(*) as cnt
        FROM wb_stocks WHERE snapshot_date = '2026-09-03'
        GROUP BY minute ORDER BY minute
      `),
    ]);
    res.json({ success: true, wbByType, wbKeyCounts, ozonKeyCounts, wbBatches });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ВРЕМЕННЫЙ маршрут: убрать задвоение снимков остатков за конкретную дату.
// Раньше сборщики остатков (WB FBS и Ozon) могли отработать несколько раз за
// один день без удаления предыдущего прогона (см. комментарии в
// collectors/wb/fbsStocks.js и collectors/ozon/stocks.js — баг там уже
// починен). За даты ДО фикса в базе остались задвоенные строки за один день,
// и они складывались все вместе. Оставляем по каждому товару/складу только
// САМУЮ ПОЗДНЮЮ по collected_at запись за дату — это и есть финальное
// состояние остатков на конец дня, а не сумма всех прогонов сборщика.
router.get('/maintenance/dedup-stock-snapshot', async (req, res) => {
  try {
    const date = req.query.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      return res.status(400).json({ success: false, error: 'Нужен параметр date=YYYY-MM-DD' });
    }

    const before = await Promise.all([
      query(`SELECT COUNT(*) as c FROM wb_stocks WHERE snapshot_date = $1`, [date]),
      query(`SELECT COUNT(*) as c FROM ozon_stocks WHERE snapshot_date = $1`, [date]),
    ]);

    const wbDeleted = await query(`
      DELETE FROM wb_stocks a
      USING wb_stocks b
      WHERE a.snapshot_date = $1
        AND b.snapshot_date = $1
        AND a.supplier_article IS NOT DISTINCT FROM b.supplier_article
        AND a.tech_size IS NOT DISTINCT FROM b.tech_size
        AND COALESCE(a.warehouse_name,'') = COALESCE(b.warehouse_name,'')
        AND COALESCE(a.stock_type,'') = COALESCE(b.stock_type,'')
        AND a.collected_at < b.collected_at
      RETURNING a.id
    `, [date]);

    const ozonDeleted = await query(`
      DELETE FROM ozon_stocks a
      USING ozon_stocks b
      WHERE a.snapshot_date = $1
        AND b.snapshot_date = $1
        AND a.offer_id IS NOT DISTINCT FROM b.offer_id
        AND a.collected_at < b.collected_at
      RETURNING a.id
    `, [date]);

    const after = await Promise.all([
      query(`SELECT COUNT(*) as c FROM wb_stocks WHERE snapshot_date = $1`, [date]),
      query(`SELECT COUNT(*) as c FROM ozon_stocks WHERE snapshot_date = $1`, [date]),
    ]);

    res.json({
      success: true,
      date,
      wb: { before: before[0][0].c, deleted: wbDeleted.length, after: after[0][0].c },
      ozon: { before: before[1][0].c, deleted: ozonDeleted.length, after: after[1][0].c },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/debug-stock-dupes', async (req, res) => {
  try {
    const [wb, ozon] = await Promise.all([
      query(`
        SELECT snapshot_date::text as date, COUNT(*) as rows, COUNT(DISTINCT (supplier_article, stock_type)) as distinct_keys
        FROM wb_stocks
        WHERE snapshot_date >= CURRENT_DATE - 14
        GROUP BY snapshot_date ORDER BY snapshot_date
      `),
      query(`
        SELECT snapshot_date::text as date, COUNT(*) as rows, COUNT(DISTINCT offer_id) as distinct_keys
        FROM ozon_stocks
        WHERE snapshot_date >= CURRENT_DATE - 14
        GROUP BY snapshot_date ORDER BY snapshot_date
      `),
    ]);
    res.json({ success: true, wb, ozon });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
router.get('/debug-stock-dupes-detail', async (req, res) => {
  try {
    const [wbSample, ozonSample, wbCollectedAt, ozonCollectedAt] = await Promise.all([
      query(`
        SELECT supplier_article, tech_size, warehouse_name, quantity, collected_at::text
        FROM wb_stocks
        WHERE snapshot_date = '2026-09-03' AND stock_type = 'fbo' AND supplier_article = 'HoodMen-1'
        ORDER BY collected_at
      `),
      query(`
        SELECT offer_id, fbo_present, fbs_present, warehouse_id, collected_at::text
        FROM ozon_stocks
        WHERE snapshot_date = '2026-09-03' AND offer_id LIKE 'HoodMen-1-%'
        ORDER BY collected_at
        LIMIT 30
      `),
      query(`
        SELECT collected_at::text, COUNT(*) as cnt
        FROM wb_stocks WHERE snapshot_date = '2026-09-03' AND stock_type = 'fbo'
        GROUP BY collected_at ORDER BY collected_at
      `),
      query(`
        SELECT collected_at::text, COUNT(*) as cnt
        FROM ozon_stocks WHERE snapshot_date = '2026-09-03'
        GROUP BY collected_at ORDER BY collected_at
      `),
    ]);
    res.json({ success: true, wbSample, ozonSample, wbCollectedAt, ozonCollectedAt });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

});

router.get('/stocks-history', async (req, res) => {
  try {
    const days = Math.min(60, Math.max(7, parseInt(req.query.days, 10) || 30));
    // Снимки остатков сохраняются не каждый календарный день (сборщик исторически
    // запускался нерегулярно), поэтому для дат без своего снимка нужно брать
    // последнее известное значение (forward-fill), а не 0 — иначе на графике
    // возникают ложные "свечки" (0 -> резкий скачок -> 0). Берём лишний буфер
    // в прошлое (+14 дней), чтобы у forward-fill был сид уже на первой дате
    // отдаваемого окна.
    const lookback = days + 14;

    const [wbRows, ozonRows] = await Promise.all([
      query(`
        SELECT snapshot_date::text as date, supplier_article, stock_type, quantity
        FROM wb_stocks
        WHERE snapshot_date >= CURRENT_DATE - $1::int AND supplier_article IS NOT NULL
      `, [lookback]),
      query(`
        SELECT snapshot_date::text as date, offer_id, fbo_present, fbs_present
        FROM ozon_stocks
        WHERE snapshot_date >= CURRENT_DATE - $1::int AND offer_id IS NOT NULL
      `, [lookback]),
    ]);

    const products = new Map(); // baseArticle -> { category, gender, byDate: Map }

    function getProduct(baseArticle) {
      if (!products.has(baseArticle)) {
        products.set(baseArticle, {
          category: detectCategory(baseArticle),
          gender: detectGender(baseArticle),
          byDate: new Map(),
        });
      }
      return products.get(baseArticle);
    }
    function getDay(product, date) {
      if (!product.byDate.has(date)) product.byDate.set(date, { wb_fbo: 0, wb_fbs: 0, ozon_fbo: 0, ozon_fbs: 0 });
      return product.byDate.get(date);
    }

    for (const r of wbRows) {
      const p = getProduct(r.supplier_article);
      const d = getDay(p, r.date);
      const field = r.stock_type === 'fbs' ? 'wb_fbs' : 'wb_fbo';
      d[field] += Number(r.quantity) || 0;
    }
    for (const r of ozonRows) {
      const { baseArticle } = parseArticle(r.offer_id);
      const p = getProduct(baseArticle);
      const d = getDay(p, r.date);
      d.ozon_fbo += Number(r.fbo_present) || 0;
      d.ozon_fbs += Number(r.fbs_present) || 0;
    }

    // Непрерывный список календарных дат за окно [сегодня - lookback, сегодня],
    // из которого клиенту отдаём только последние `days` — остальное было нужно
    // лишь чтобы получить сид для forward-fill.
    const allDates = [];
    for (let i = lookback; i >= 0; i--) {
      allDates.push(dayjs().subtract(i, 'day').format('YYYY-MM-DD'));
    }
    const outDates = allDates.slice(-days);
    const outDateSet = new Set(outDates);

    const productsOut = {};
    for (const [baseArticle, p] of products) {
      const byDate = {};
      let last = null; // последнее известное значение по мере движения по датам вперёд
      let hasAny = false;
      for (const date of allDates) {
        if (p.byDate.has(date)) {
          last = p.byDate.get(date);
          hasAny = true;
        }
        if (outDateSet.has(date)) {
          byDate[date] = last || { wb_fbo: 0, wb_fbs: 0, ozon_fbo: 0, ozon_fbs: 0 };
        }
      }
      if (hasAny) {
        productsOut[baseArticle] = { category: p.category, gender: p.gender, byDate };
      }
    }

    res.json({ success: true, data: { dates: outDates, products: productsOut } });
  } catch (e) {
    console.error(e);
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
