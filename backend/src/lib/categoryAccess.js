const { query } = require('../db');
const { CABINETS, familyOf } = require('../config/cabinets');
const { autoPath, OV_SQL, overrideArgs } = require('./categories');
const SEP = ' / ';
const PAGES = ['sales','rnp','orders','check','abc','season','ads','discounts','inventory','buyout','unit','margin','pnl','calculator','access'];
const ROOTS = ['Чехлы','Дефлекторы','Утеплители','Аксессуары','Одежда'];
function normalize(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || !Array.isArray(value.paths) || value.paths.length < 1 || value.paths.length > 100) throw Object.assign(Error('Выберите хотя бы одну категорию'), { status: 400 });
  const paths = [...new Set(value.paths.map(p => {
    if (typeof p !== 'string' || p.length > 256 || /[\x00-\x1f]/.test(p)) throw Object.assign(Error('Неверная категория'), { status: 400 });
    const parts = p.split('/').map(s => s.trim());
    if (!parts.length || parts.some(s => !s) || parts.length > 8) throw Object.assign(Error('Неверная категория'), { status: 400 });
    return parts.join(SEP);
  }))];
  return { paths: paths.filter(p => !paths.some(other => other !== p && p.startsWith(other + SEP))), readOnly: true };
}
const inPath = (path, parent) => path === parent || path.startsWith(parent + SEP);
function cabinets(scope) {
  const clothes = scope.paths.some(p => inPath(p, 'Одежда'));
  const cars = scope.paths.some(p => !inPath(p, 'Одежда'));
  return Object.keys(CABINETS).filter(id => (id === 'licio' && clothes) || (familyOf(id) === 'defly' && cars));
}
function publicScope(value) {
  if (value == null) return null;
  try { const scope = normalize(value); return { ...scope, cabinets: cabinets(scope), pages: PAGES }; }
  catch { return { paths: [], readOnly: true, cabinets: [], pages: ['access'] }; }
}
function category(cabinet, path) {
  const clean = String(path || '').split('/').map(s => s.trim()).filter(Boolean).join(SEP);
  return cabinet === 'licio' && !inPath(clean, 'Одежда') ? ['Одежда', clean].filter(Boolean).join(SEP) : clean;
}
async function catalogue(cabinet) {
  const map = new Map();
  if (cabinet === 'defly_wb') {
    const [rows, prefs] = await Promise.all([
      query("SELECT rows FROM wb_bridge_data WHERE cabinet=$1 AND kind='catalog'", [cabinet]),
      require('./wbViews').preferences(),
    ]);
    for (const r of rows[0]?.rows || []) if (r.offer) map.set(String(r.offer), { path: prefs.categories[r.offer] || autoPath('defly', r.name || '', r.offer).join(SEP), sku: r.nmId, name: r.name });
  } else {
    const [rows, overrides] = await Promise.all([
      query("SELECT offer_id, product_name, sku FROM ad_product_catalog WHERE cabinet=$1 AND platform='ozon'", [cabinet]),
      query(OV_SQL, overrideArgs(cabinet)),
    ]);
    const ov = new Map(overrides.map(r => [r.offer_id, r.path]));
    for (const r of rows) if (r.offer_id) map.set(String(r.offer_id), { path: category(cabinet, ov.get(r.offer_id) || autoPath(cabinet, r.product_name, r.offer_id).join(SEP)), sku: r.sku, name: r.product_name });
  }
  return map;
}
async function availablePaths() {
  const out = new Set(['Одежда']);
  // Справочник Ozon общий для магазинов Defly; сохраняем ручные категории каждого кабинета.
  for (const cabinet of Object.keys(CABINETS)) {
    const entries = await catalogue(cabinet);
    for (const { path } of entries.values()) {
      const parts = path.split(SEP);
      for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0,i).join(SEP));
    }
  }
  return [...out].sort((a,b) => {
    const ai = ROOTS.indexOf(a.split(SEP)[0]), bi = ROOTS.indexOf(b.split(SEP)[0]);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.localeCompare(b, 'ru');
  });
}
async function validate(value) {
  const scope = normalize(value);
  if (scope) {
    const known = new Set(await availablePaths());
    if (scope.paths.some(path => !known.has(path))) throw Object.assign(Error('Категория отсутствует в справочнике. Обновите список категорий'), { status: 400 });
  }
  return scope;
}
async function context(cabinet, scope) {
  if (!cabinets(scope).includes(cabinet)) throw Object.assign(Error('Нет доступа к этому кабинету'), { status: 403 });
  const all = await catalogue(cabinet), allowed = new Map();
  for (const [offer, meta] of all) if (scope.paths.some(p => inPath(category(cabinet, meta.path), p))) allowed.set(offer, { ...meta, path: category(cabinet, meta.path) });
  return { cabinet, scope, allowed };
}
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const offerOf = value => String(value?.o ?? value?.offerId ?? value?.offer_id ?? '');
const filterMap = (value, ctx) => Object.fromEntries(Object.entries(value || {}).filter(([o]) => ctx.allowed.has(o)));
function selectArticles(data, ctx) {
  if (!Array.isArray(data.articles)) throw Error('Неизвестный формат отчёта');
  const index = new Map(), old = [], articles = [];
  data.articles.forEach((a,i) => {
    const meta = ctx.allowed.get(offerOf(a)); if (!meta) return;
    index.set(i, articles.length); old.push(i);
    articles.push({ ...pick(a, ['o','offerId','n','productName','sku','brand','st','manual']), cat: meta.path, auto: meta.path });
  });
  return { articles, old, rows: value => (value || []).filter(r => Array.isArray(r) && index.has(r[0])).map(r => [index.get(r[0]), ...r.slice(1)]), index };
}
const INDEXED = {
  '/sales/data': ['rows','stock','prev','self'],
  '/finance/coefs': ['coefs','fbsDays'],
  '/finance/pnl': ['rows','ads','self','taxBase'],
  '/finance/calc-base': ['a'],
  '/finance/buyout': ['rows','prev'],
  '/stocks/data': ['stock','hist','cl','demand','orders','fbs','clHist'],
  '/queries/season': ['rows'],
};
function indexed(path, data, ctx) {
  const selection = selectArticles(data,ctx);
  const out = { ...pick(data, ['dates','months','days','from','to','since','available','stockDate','clusterDate','buckets','_wb','_metadataOnly','financeSource']), articles: selection.articles, order: [...new Set(selection.articles.map(a => a.cat.split(SEP)[0]))] };
  for (const key of INDEXED[path]) out[key] = selection.rows(data[key]);
  if (path === '/sales/data') out.unallocated = { cur: 0, prev: 0, byDate: {} };
  if (path === '/finance/coefs') { out.noSku = {}; out.names = []; out.totalSale = out.coefs.reduce((n,r) => n + Math.max(0, Number(r[1]) || 0),0); }
  if (path === '/finance/pnl') { out.noSku = []; out.adNoSku = []; out.cost = selection.old.map(i => data.cost?.[i] ?? null); }
  if (path === '/stocks/data') Object.assign(out, pick(data, ['clusters','districts']));
  return out;
}
function ads(data, ctx) {
  if (!Array.isArray(data.articles)) throw Error('Неизвестный формат рекламы');
  const articles = data.articles.filter(a => ctx.allowed.has(offerOf(a))).map(a => ({
    ...pick(a,['offerId','sku','productName','byDate','totals','stock','stockDays','prev']), cat: ctx.allowed.get(offerOf(a)).path,
    // Числа смешанной кампании могут включать чужие товары. Сохраняем только статус и вид рекламы.
    campaigns: (a.campaigns || []).map(c => ({ ...pick(c, ['campaignId','id','status','state','paymentType','payment_type','type','zone','kind','strategy','targetDrr','adObjectType']), name: 'Реклама товара' })),
    associated: (a.associated || []).filter(x => ctx.allowed.has(offerOf(x))).map(x => pick(x,['offerId','sku','productName','byDate','totals'])),
  }));
  return { ...pick(data,['dates','_wb']), articles, cpoCharge: (data.cpoCharge || []).filter(r => ctx.allowed.has(String(r[0]))), catOfOffer: filterMap(data.catOfOffer, ctx) };
}
function projection(path, data, ctx) {
  if (INDEXED[path]) return indexed(path,data,ctx);
  if (path === '/promo/stats') return ads(data,ctx);
  if (path === '/orders/feed') return { ...pick(data,['from','to','since','_wb']), rows: (data.rows || []).filter(r => ctx.allowed.has(offerOf(r))).map(r => ({ ...pick(r,['p','sku','o','n','price','est','qty','st','wh','at','sch','self']), cat: ctx.allowed.get(offerOf(r)).path })) };
  if (path === '/discounts/overview') return { ...pick(data,['cabinet','lastCheckedAt']), items: (data.items || []).filter(r => ctx.allowed.has(offerOf(r))).map(r => ({ ...pick(r,['o','n','seller','site','card','pct','pctCard','schema','c1','c7','d1','d7','orders30','revenue30','checkedAt']), cat: ctx.allowed.get(offerOf(r)).path })) };
  if (path === '/discounts/history') return { dates: data.dates, rows: (data.rows || []).filter(r => ctx.allowed.has(String(r[0]))), base: (data.base || []).filter(r => ctx.allowed.has(String(r[0]))) };
  if (path === '/promo/groups') {
    const members = filterMap(data.members,ctx), ids = new Set(Object.values(members));
    return { members, groups: (data.groups || []).filter(g => ids.has(g.id)).map(g => pick(g,['id','name','color'])) };
  }
  if (path === '/sales/sewing') return {items:filterMap(data.items,ctx)};
  if (['/promo/transit','/sales/skus'].includes(path)) return filterMap(data,ctx);
  if (path === '/promo/order') return (data || []).filter(o => ctx.allowed.has(String(o)));
  if (path === '/promo/events') return []; // события смешанных кампаний могут содержать общие бюджеты и названия чужих товаров
  if (path === '/pricelog/dynamics') return { ...pick(data,['from','to','days']), items: filterMap(data.items,ctx) };
  if (path === '/sales/builder-templates') return {templates:[]}; // общие шаблоны могут содержать списки чужих артикулов
  if (path === '/finance/buyer-share') return { periods: (data?.periods || []).map(p => ({ ...pick(p,['from','to','total','at']), byOffer: filterMap(p.byOffer,ctx) })) };
  if (path === '/settings/tax') return pick(data,['enabled','rate']);
  if (path === '/promo/data-status') return { ...pick(data,['automatic']), running: false, jobs: (data.jobs || []).map(j=>pick(j,['job','everyMin','lastSuccessAt'])) };
  if (path === '/discounts/settings') return pick(data,['enabled','intervalMin','threshold']);
  throw Error('Раздел не поддерживает ограниченный доступ');
}
function routeOf(path) {
  const normalized = path.toLowerCase().replace(/\/+$/, '').replace(/^\/api\/wb\/views/, '/api').replace(/^\/api\/ads(?=\/)/, '/api/promo');
  return normalized.replace(/^\/api/, '');
}
const EXTRA = ['/promo/stats','/promo/groups','/promo/transit','/promo/order','/promo/events','/promo/data-status','/orders/feed','/discounts/overview','/discounts/history','/discounts/settings','/sales/sewing','/sales/skus','/sales/builder-templates','/pricelog/dynamics','/finance/buyer-share','/settings/tax'];
function middleware() {
  return async (req,res,next) => {
    if (req.user?.accessScope == null || !/^\/api(?:\/|$)/i.test(req.path)) return next();
    const path = routeOf(req.path);
    if (['/auth/me','/auth/logout','/auth/password','/auth/activity'].includes(path)) return next();
    req.restricted = true;
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (!read) return res.status(403).json({ success:false, error:'Доступ только для просмотра и выгрузки' });
    const scope = publicScope(req.user.accessScope);
    if (path === '/promo/cabinets') {
      const list = require('../config/cabinets').listCabinets().filter(c => scope.cabinets.includes(c.id));
      return res.json({ success:true, data:list.map(c => pick(c,['id','label','platform','family','connected'])) });
    }
    if (!INDEXED[path] && !EXTRA.includes(path)) return res.status(403).json({ success:false, error:'Этот раздел недоступен в вашем профиле' });
    const cabinet = req.query.cabinet === undefined ? 'defly' : req.query.cabinet;
    if (typeof cabinet !== 'string' || !scope.cabinets.includes(cabinet) || (/^\/api\/wb\/views/i.test(req.path) && cabinet !== 'defly_wb')) return res.status(403).json({ success:false, error:'Нет доступа к этому кабинету' });
    try {
      const ctx = await context(cabinet,scope), json = res.json.bind(res);
      res.set('Cache-Control','no-store');
      res.json = body => {
        res.set('Cache-Control','no-store'); res.set('Vary','Cookie');
        if (res.statusCode >= 400 || !body?.success) return json({ success:false, error:'Не удалось получить данные разрешённых категорий' });
        try { return json({ success:true, data:projection(path,body.data,ctx) }); }
        catch { return res.status(403).type('json').send(JSON.stringify({ success:false,error:'Раздел временно недоступен для ограниченного профиля' })); }
      };
      next();
    } catch { return res.status(503).json({ success:false,error:'Не удалось проверить доступ к категориям' }); }
  };
}
module.exports = { normalize, publicScope, category, cabinets, availablePaths, validate, context, projection, middleware, inPath, PAGES, routeOf };
