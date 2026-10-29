import axios from 'axios';
const api = axios.create({ baseURL: '/api', timeout: 30000 });
export const getWbData = (cabinet, params) => api.get('/wb/data', { params: { cabinet, ...params }, timeout: 120000 });
export const getTaxSettings = cabinet => api.get('/settings/tax', { params: { cabinet } });
export const saveTaxSettings = (cabinet, settings) => api.post('/settings/tax', { cabinet, ...settings });
// Счётчик запросов в полёте: фоновая подгрузка разделов ждёт, пока сеть
// освободится, — открытая страница получает данные первой.
// WB использует те же страницы и контракты представления, что и Ozon.
api.interceptors.request.use(cfg => {
  const cabinet = cfg.params?.cabinet || (cfg.data && typeof cfg.data === 'object' ? cfg.data.cabinet : null);
  if (cabinet === 'defly_wb') {
    if (/^\/(sales|promo|ads|stocks|orders|clusters|finance|queries)(\/|$)/.test(cfg.url)) { cfg.url = '/wb/views' + cfg.url; cfg.timeout = Math.max(cfg.timeout || 0, 120000); }
    if (/^\/pricelog/.test(cfg.url)) { cfg.params = { ...cfg.params, platform: 'wb' }; if (cfg.data && typeof cfg.data === 'object') cfg.data.platform = 'wb'; }
  }
  return cfg;
});
let pending = 0;
api.interceptors.request.use(cfg => { pending++; return cfg; });
const done = () => { pending = Math.max(0, pending - 1); };
api.interceptors.response.use(r => { done(); return r; }, e => { done(); return Promise.reject(e); });
export function whenIdle(quietMs = 800, maxWaitMs = 60000) {
  return new Promise(resolve => {
    const start = Date.now(); let quietSince = null;
    const tick = () => {
      if (pending === 0) { quietSince = quietSince || Date.now(); if (Date.now() - quietSince >= quietMs) return resolve(); }
      else quietSince = null;
      if (Date.now() - start > maxWaitMs) return resolve();
      setTimeout(tick, 200);
    };
    tick();
  });
}
// Во время выкладки/перезапуска Render отдаёт 502/503 или HTML-заглушку вместо
// JSON — тогда GET-запрос повторяем (до 3 раз через 5 с), а не показываем
// «нет данных».
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function retry(cfg, why) {
  cfg.__try = (cfg.__try || 0) + 1;
  if (cfg.__try > 3 || (cfg.method || 'get') !== 'get') return null;
  await sleep(5000);
  return api.request(cfg);
}
api.interceptors.response.use(async r => {
  if (typeof r.data === 'string' && /<html|<!doctype/i.test(r.data.slice(0, 200))) {
    const again = await retry(r.config);
    if (again) return again;
    return Promise.reject(new Error('Сервер перезапускается — обновите страницу через минуту'));
  }
  return r;
}, async err => {
  const st = err.response?.status;
  if (err.config && err.code !== 'ECONNABORTED' && (!err.response || st === 502 || st === 503 || st === 504)) {
    const again = await retry(err.config);
    if (again) return again;
  }
  return Promise.reject(err);
});
api.interceptors.response.use(r => {
  const d = r.data?.data; if (!d?._wb) return r;
  const url = r.config.url;
  if (/\/sales\/data$/.test(url)) { d.rows = d.rows.map(row => row.map((v, i) => i >= 2 && v === null ? NaN : v)); d.prev = d.prev?.map(row => row.map((v, i) => i > 0 && v === null ? NaN : v)); }
  if (/\/stocks\/data$/.test(url)) for (const key of ['stock', 'orders', 'fbs']) d[key] = d[key].map(row => row.map((v, i) => i > (key === 'stock' ? 0 : 1) && v === null ? NaN : v));
  if (/\/finance\/pnl$/.test(url)) d.rows = d.rows.map(row => row.map((v, i) => i >= 3 && v === null ? NaN : v));
  if (/\/queries\/season$/.test(url)) d.rows = d.rows.map(row => row.map((v, i) => i >= 2 && v === null ? NaN : v));
  return r;
});
export const getOverview    = p => api.get('/dashboard/overview', { params: p });
export const getChart       = p => api.get('/dashboard/chart',    { params: p });

export const getCategories  = () => api.get('/dashboard/categories');
export const getStocks      = p => api.get('/dashboard/stocks',   { params: p });
export const getStocksV2    = () => api.get('/dashboard/stocks-v2');
export const getStocksHistory = days => api.get('/dashboard/stocks-history', { params: { days } });
export const getLog         = () => api.get('/dashboard/collection-log');
export const getCosts       = p => api.get('/settings/costs',     { params: p });
export const saveCosts      = c => api.post('/settings/costs',    { costs: c });
export const deleteCost     = id => api.delete(`/settings/costs/${id}`);
export const collect        = d => api.post('/settings/collect',  d);
export const getStatus      = () => api.get('/settings/status');
export const getOzonAnalytics   = p => api.get('/analytics/ozon',         { params: p });
export const getOzonFunnel      = p => api.get('/analytics/ozon/funnel',  { params: p });
export const getOzonCategories  = p => api.get('/analytics/ozon/categories', { params: p });

export const getAdsCabinets = () => api.get('/promo/cabinets');
export const collectAds     = (cabinet, days) => api.post('/promo/collect', {}, { params: { cabinet, days } });
export const getAdsDataStatus = cabinet => api.get('/promo/data-status', { params: { cabinet } });
export const saveCampaignTarget = (cabinet, campaignId, drr) => api.post('/promo/campaign-target', { cabinet, campaignId, drr });
export const getAdsStats    = (cabinet, params) => api.get('/promo/stats', { params: { cabinet, ...params } });
export const saveManualAdsMetric = (cabinet, offerId, date, metric, value) =>
  api.post('/promo/manual', { cabinet, offerId, date, metric, value });
export const saveManualStock = (cabinet, offerId, metric, value) =>
  api.post('/promo/manual-stock', { cabinet, offerId, metric, value });
export const getAdsOrder  = cabinet => api.get('/promo/order', { params: { cabinet } });
export const saveAdsOrder = (cabinet, order) => api.post('/promo/order', { cabinet, order });
export const getAdsTransit = cabinet => api.get('/promo/transit', { params: { cabinet } });
export const saveAdsTransit = (cabinet, offerId, patch) => api.post('/promo/transit', { cabinet, offerId, ...patch });
export const getAdsGroups    = cabinet => api.get('/promo/groups', { params: { cabinet } });
export const addAdsGroup     = (cabinet, name) => api.post('/promo/groups', { cabinet, name });
export const removeAdsGroup  = (cabinet, id) => api.delete(`/ads/groups/${id}`, { params: { cabinet } });
export const renameAdsGroup  = (cabinet, id, name) => api.post('/promo/groups/rename', { cabinet, id, name });
export const assignAdsGroup  = (cabinet, offerId, groupId) => api.post('/promo/groups/assign', { cabinet, offerId, groupId });
export const getSiblingClusters = cabinet => api.get('/promo/sibling-clusters', { params: { cabinet } });
export const addAdsGroupFromCluster = (cabinet, name, offerIds) => api.post('/promo/groups/from-cluster', { cabinet, name, offerIds });
export const reorderAdsGroups = (cabinet, order) => api.post('/promo/groups/reorder', { cabinet, order });
export const getAdsCatalog = cabinet => api.get('/promo/catalog', { params: { cabinet } });
// /api/discounts (не /api/ads/discounts): путь с "/ads/" у части пользователей
// режется блокировщиками рекламы прямо в браузере (см. комментарий в
// backend/src/routes/discounts.js), поэтому вынесен на отдельный путь.
export const getDiscounts = (cabinet, days) => api.get('/discounts', { params: { cabinet, days } });
export const getDiscountsSummary  = (cabinet, days) => api.get('/discounts/summary', { params: { cabinet, days } });
export const getDiscountsFeed     = (cabinet, days) => api.get('/discounts/feed', { params: { cabinet, days } });
export const getDiscountSettings  = cabinet => api.get('/discounts/settings', { params: { cabinet } });
export const saveDiscountSettings = (cabinet, settings) => api.post('/discounts/settings', { cabinet, ...settings });

export const getTrackedArticles = cabinet => api.get('/tracked-articles', { params: { cabinet } });
export const getTrackedArticlesFeed = cabinet => api.get('/tracked-articles/feed', { params: { cabinet } });
export const addTrackedArticle = (cabinet, platform, article, label, groupId) =>
  api.post('/tracked-articles', { cabinet, platform, article, label, groupId });
export const removeTrackedArticle = (cabinet, id) =>
  api.delete(`/tracked-articles/${id}`, { params: { cabinet } });
export const moveTrackedArticle = (cabinet, id, groupId) =>
  api.patch(`/tracked-articles/${id}`, { cabinet, groupId });

export const getTrackedGroups = cabinet => api.get('/tracked-articles/groups', { params: { cabinet } });
export const addTrackedGroup = (cabinet, name) =>
  api.post('/tracked-articles/groups', { cabinet, name });
export const removeTrackedGroup = (cabinet, id) =>
  api.delete(`/tracked-articles/groups/${id}`, { params: { cabinet } });

export const getAdsEvents   = (cabinet, dateFrom, dateTo) => api.get('/promo/events', { params: { cabinet, dateFrom, dateTo } });
export const addAdsEvent    = (cabinet, offerId, date, text) => api.post('/promo/events', { cabinet, offerId, date, text });
export const deleteAdsEvent = (cabinet, id) => api.delete(`/ads/events/${id}`, { params: { cabinet } });
export const getNotificationsHealth = cabinet => api.get('/tracked-articles/health', { params: { cabinet } });
export const testTelegram = () => api.post('/tracked-articles/test-telegram');

// «Аналитика продаж» и «Себестоимость»
export const getSalesData = (cabinet, p) => api.get('/sales/data', { params: { cabinet, ...p }, timeout: 90000 });
export const getSewing = cabinet => api.get('/sales/sewing', { params: { cabinet } });
export const saveSewing = (cabinet, items) => api.post('/sales/sewing', { cabinet, items });
export const getBuilderTemplates = cabinet => api.get('/sales/builder-templates', { params: { cabinet } });
export const saveBuilderTemplates = (cabinet, templates) => api.post('/sales/builder-templates', { cabinet, templates });
export const setSalesCategory = (cabinet, offerIds, path) => api.post('/sales/category', { cabinet, offerIds, path });
export const getCostList = cabinet => api.get('/sales/costs', { params: { cabinet }, timeout: 60000 });
export const saveCostList = (cabinet, items) => api.post('/sales/costs', { cabinet, items }, { timeout: 120000 });
export const getSalesGeo = (cabinet, p) => api.get('/sales/geo', { params: { cabinet, ...p }, timeout: 90000 });
export const getDiscountOverview = cabinet => api.get('/discounts/overview', { params: { cabinet } });
export const getDiscountHistory = (cabinet, days) => api.get('/discounts/history', { params: { cabinet, days } });
// Юнит-экономика, P&L, % выкупа
export const getBuyerShare = cabinet => api.get('/finance/buyer-share', { params: { cabinet } });
export const saveBuyerShare = (cabinet, body) => api.post('/finance/buyer-share', { cabinet, ...body });
export const deleteBuyerShare = (cabinet, from, to) => api.post('/finance/buyer-share/delete', { cabinet, from, to });
export const getFinanceCoefs = cabinet => api.get('/finance/coefs', { params: { cabinet }, timeout: 90000 });
export const getFinanceOps = (cabinet, bucket, p) => api.get('/finance/ops', { params: { cabinet, bucket, ...p }, timeout: 60000 });
export const getFinancePnl = (cabinet, p) => api.get('/finance/pnl', { params: { cabinet, ...p }, timeout: 90000 });
export const getBuyoutData = (cabinet, p) => api.get('/finance/buyout', { params: { cabinet, ...p }, timeout: 90000 });
export const getCalcBase = (cabinet, fresh) => api.get('/finance/calc-base', { params: fresh ? { cabinet, fresh: 1 } : { cabinet }, timeout: 90000 });
export const refreshPrices = cabinet => api.post('/finance/refresh-prices', null, { params: { cabinet }, timeout: 200000 });
export const getStocksData = (cabinet, p) => api.get('/stocks/data', { params: { cabinet, ...p }, timeout: 90000 });
export const getDigestSettings = cabinet => api.get('/digest/settings', { params: { cabinet } });
export const saveDigestSettings = (cabinet, s) => api.post('/digest/settings', { cabinet, ...s });
export const previewDigest = cabinet => api.get('/digest/preview', { params: { cabinet }, timeout: 60000 });
export const sendDigestNow = cabinet => api.post('/digest/send', { cabinet }, { timeout: 60000 });
export const getPlan = (cabinet, month) => api.get('/plan', { params: { cabinet, month } });
export const savePlan = (cabinet, month, plan) => api.post('/plan', { cabinet, month, plan });
export const getOzonPlan = (month, scope) => api.get('/plan/ozon', { params: { month, scope } });
export const getOzonPlanBasis = params => api.get('/plan/ozon/basis', { params, timeout: 180000 });
export const previewOzonPlan = data => api.post('/plan/ozon/preview', data, { timeout: 180000 });
export const fixOzonPlan = data => api.post('/plan/ozon/fix', data);
export const getOzonPlanExecution = params => api.get('/plan/ozon/execution', { params, timeout: 180000 });
export const getQueries = (cabinet, p) => api.get('/queries/data', { params: { cabinet, ...p }, timeout: 90000 });
export const getQuerySeries = (cabinet, offerId, q, days) => api.get('/queries/series', { params: { cabinet, offerId, query: q, days } });
export const getSeason = cabinet => api.get('/queries/season', { params: { cabinet }, timeout: 90000 });
export const getRestock = (cabinet, days = 14) => api.get('/tracked-articles/restock', { params: { cabinet, days } });
export const saveRestockSettings = (cabinet, s) => api.post('/tracked-articles/restock/settings', { cabinet, ...s });

// Ответ только на ПОСЛЕДНИЙ запрос раздела. Если период меняли быстро (или
// выбор дат прошёл в два шага), более ранний запрос мог прийти позже нового
// и показать данные за другой период, чем стоит в календаре.
//   const ok = latestOnly('sales');
//   getX().then(ok(r => setData(...))).finally(ok(() => setLoading(false)));
const LATEST = new Map();
export function latestOnly(key) {
  const n = (LATEST.get(key) || 0) + 1;
  LATEST.set(key, n);
  return fn => (...args) => (LATEST.get(key) === n ? fn(...args) : undefined);
}

// «Производство» — потребность в пошив
export const getProduction = cabinet => api.get('/production', { params: { cabinet } });
export const getDeflectors2d = () => api.get('/production/deflectors2d');
export const getDeflectors2dDemand = (refresh = false) => api.get('/production/deflectors2d/demand', { params: { refresh: refresh ? '1' : undefined } });
export const getDeflectors2dCatalog = () => api.get('/production/deflectors2d/catalog');
export const saveDeflectors2d = data => api.post('/production/deflectors2d/draft', data);
export const submitDeflectors2d = data => api.post('/production/deflectors2d/journal', data);
export const uploadProduction = (cabinet, kind, items, file) => api.post('/production/upload', { cabinet, kind, items, file });
export const saveProductionMaster = (cabinet, items, replace) => api.post('/production/master', { cabinet, items, replace });
export const saveProductionSettings = (cabinet, settings) => api.post('/production/settings', { cabinet, settings });
export const saveProductionOrder = (cabinet, order) => api.post('/production/orders', { cabinet, order });
export const removeProductionOrder = (cabinet, id) => api.post('/production/orders', { cabinet, remove: id });

// «Журнал цен» (репрайсер)
export const getPriceLog = (cabinet, platform = 'ozon') => api.get('/pricelog', { params: { cabinet, platform }, timeout: 60000 });
export const uploadPriceLog = (cabinet, platform, date, snap, file) => api.post('/pricelog/upload', { cabinet, platform, date, file, ...snap });
export const getPriceSnap = (cabinet, platform, id) => api.get('/pricelog/snap', { params: { cabinet, platform, id }, timeout: 60000 });
export const getPriceHistory = (cabinet, platform, offer) => api.get('/pricelog/history', { params: { cabinet, platform, offer }, timeout: 60000 });
export const deletePriceLog = (cabinet, platform, id) => api.post('/pricelog/delete', { cabinet, platform, id });
export const markPriceLog = (cabinet, platform, snapId, offers, goal, note) => api.post('/pricelog/marks', { cabinet, platform, snapId, offers, goal, note });
export const getSkus = cabinet => api.get('/sales/skus', { params: { cabinet }, timeout: 30000 });
export const closeProductionJournal = (cabinet, offers, close) => api.post('/production/journal', { cabinet, offers, close });
export const getPriceDynamics = (cabinet, days) => api.get('/pricelog/dynamics', { params: { cabinet, days }, timeout: 60000 });
export const getPriceRules = (cabinet, platform = 'ozon') => api.get('/pricelog/rules', { params: { cabinet, platform } });
export const savePriceRules = (cabinet, add, remove, platform = 'ozon') => api.post('/pricelog/rules', { cabinet, platform, add, remove });
export const savePricePlans = (cabinet, items, platform = 'ozon') => api.post('/pricelog/plans', { cabinet, platform, items });
export const setSnapRule = (cabinet, platform, snapId, offers, rule) => api.post('/pricelog/snap-rule', { cabinet, platform, snapId, offers, rule });
export const getClusters = cabinet => api.get('/clusters', { params: { cabinet }, timeout: 60000 });
export const decideCluster = (cabinet, action, offers, id) => api.post('/clusters/decide', { cabinet, action, offers, id });
export const getOrderFeed = (cabinet, dateFrom, dateTo, kind) => api.get('/orders/feed', { params: { cabinet, dateFrom, dateTo, kind }, timeout: 60000 });
export const setSelfBuyout = (cabinet, items, on) => api.post('/orders/self', { cabinet, items, on });
export const getSalesSummary = (dateFrom, dateTo, cabinet) => api.get('/sales/summary', { params: { dateFrom, dateTo, cabinet }, timeout: 120000 });
