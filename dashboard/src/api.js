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

export const getAdsCabinets = () => api.get('/ads/cabinets');
export const collectAds     = (cabinet, days) => api.post('/ads/collect', {}, { params: { cabinet, days } });
export const getAdsStats    = (cabinet, params) => api.get('/ads/stats', { params: { cabinet, ...params } });
export const saveManualAdsMetric = (cabinet, offerId, date, metric, value) =>
  api.post('/ads/manual', { cabinet, offerId, date, metric, value });
export const getAdsOrder  = cabinet => api.get('/ads/order', { params: { cabinet } });
export const saveAdsOrder = (cabinet, order) => api.post('/ads/order', { cabinet, order });
