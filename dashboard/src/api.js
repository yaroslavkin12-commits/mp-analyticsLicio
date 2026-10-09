import axios from 'axios';
const api = axios.create({ baseURL: '/api', timeout: 30000 });
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
export const getAdsStats    = (cabinet, params) => api.get('/promo/stats', { params: { cabinet, ...params } });
export const saveManualAdsMetric = (cabinet, offerId, date, metric, value) =>
  api.post('/promo/manual', { cabinet, offerId, date, metric, value });
export const saveManualStock = (cabinet, offerId, metric, value) =>
  api.post('/promo/manual-stock', { cabinet, offerId, metric, value });
export const getAdsOrder  = cabinet => api.get('/promo/order', { params: { cabinet } });
export const saveAdsOrder = (cabinet, order) => api.post('/promo/order', { cabinet, order });
export const getAdsGroups    = cabinet => api.get('/promo/groups', { params: { cabinet } });
export const addAdsGroup     = (cabinet, name) => api.post('/promo/groups', { cabinet, name });
export const removeAdsGroup  = (cabinet, id) => api.delete(`/ads/groups/${id}`, { params: { cabinet } });
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
export const setSalesCategory = (cabinet, offerIds, path) => api.post('/sales/category', { cabinet, offerIds, path });
export const getCostList = cabinet => api.get('/sales/costs', { params: { cabinet }, timeout: 60000 });
export const saveCostList = (cabinet, items) => api.post('/sales/costs', { cabinet, items }, { timeout: 120000 });
export const getSalesGeo = (cabinet, p) => api.get('/sales/geo', { params: { cabinet, ...p }, timeout: 90000 });
export const getDiscountOverview = cabinet => api.get('/discounts/overview', { params: { cabinet } });
