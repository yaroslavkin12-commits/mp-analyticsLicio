const { query } = require('../db');
const { CABINETS, familyOf } = require('../config/cabinets');
const { autoPath, OV_SQL, overrideArgs } = require('./categories');
const SEP = ' / ';
const PAGES = ['summary','plan','geo','search','costs','sales','rnp','orders','check','abc','season','ads','discounts','inventory','buyout','unit','margin','pnl','calculator','pricelog'];
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
  catch { return { paths: [], readOnly: true, cabinets: [], pages: [] }; }
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
  const out = { ...pick(data, ['dates','months','days','from','to','since','available','stockDate','clusterDate','buckets','_wb','_metadataOnly','_operational','financeSource','coverage','availability']), articles: selection.articles, order: [...new Set(selection.articles.map(a => a.cat.split(SEP)[0]))] };
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
    ...(a.cpo ? { cpo: pick(a.cpo, ['enabled','available','bidPct','bidRub','checkedAt']) } : {}),
    // Числа смешанной кампании могут включать чужие товары. Сохраняем только статус и вид рекламы.
    campaigns: (a.campaigns || []).map(c => ({ ...pick(c, ['campaignId','id','status','state','paymentType','payment_type','type','zone','kind','strategy','targetDrr','adObjectType']), name: 'Реклама товара' })),
    associated: (a.associated || []).filter(x => ctx.allowed.has(offerOf(x))).map(x => pick(x,['offerId','sku','productName','byDate','totals'])),
  }));
  return { ...pick(data,['dates','_wb']), articles, cpoCharge: (data.cpoCharge || []).filter(r => ctx.allowed.has(String(r[0]))), catOfOffer: filterMap(data.catOfOffer, ctx) };
}
function projection(path, data, ctx) {
  if (INDEXED[path]) return indexed(path,data,ctx);
  if(path==='/sales/history'){if(!data._categoryFiltered)throw Error('Нужна фильтрация истории');return pick(data,['cabinet','mode','available','coverage','periods','olderThan']);}
  if(path==='/sales/summary'&&!data._categoryFiltered)throw Error('Нужна фильтрация до агрегации');
  if(path==='/sales/geo'&&!data._categoryFiltered)throw Error('Нужна фильтрация дневных сумм');
  if(path==='/sales/summary')return { ...pick(data,['from','to','pFrom','pTo']),shops:data.shops.filter(s=>ctx.contexts[s.id])};
  if(path==='/plan/ozon')return require('./scopedReports').planState(data,ctx.contexts);
  if(path==='/plan/ozon/execution'){if(!data._categoryFiltered)throw Error('Нужен ограниченный факт');return pick(data,['snapshot','revision','from','to','requestedTo','shops','asOf','future','provisional','elapsedDays','evaluatedAtMoscow']);} // Факт рассчитывается только из разрешённых артикулов в ozonPlanData.
  if(path==='/sales/geo')return require('./scopedReports').geo(data,ctx,selectArticles);
  if(path==='/queries/data')return require('./scopedReports').queries(data,ctx,selectArticles);
  if(path==='/queries/series')return data;
  if(path==='/queries/article'){const names=new Set(data.rows.map(r=>r[1]));return {...pick(data,['offerId','name','from','to','rows','freq']),groups:Object.fromEntries(Object.entries(data.groups||{}).filter(([q])=>names.has(q)))};}
  // Эти два отчёта фильтруются по артикулу и SKU в самом маршруте.
  if(path==='/competitors'||path==='/competitors/serp'){
    if(data?._categoryFiltered!==true)throw Error('Нужна фильтрация конкурентов');
    return data.result;
  }
  if (path === '/finance/ops') {
    return { ...pick(data,['dates']), rows: (data.rows || []).filter(row => row[2] != null && ctx.allowed.has(String(row[2]))) };
  }
  if (['/pricelog','/pricelog/snap','/pricelog/history','/pricelog/rules'].includes(path)) {
    if (data?._categoryFiltered !== true) throw Error('Нужна фильтрация журнала цен');
    return data.result;
  }
  if(path==='/competitors/tracking')return pick(data,['queries','regions','allRegions']);
  if(path==='/sales/costs')return {_wb:data._wb,items:(data.items||[]).filter(r=>ctx.allowed.has(String(r.offerId))).map(r=>({...pick(r,['offerId','name','cost','updatedAt','orders30','avgPrice30','stock']),category:ctx.allowed.get(String(r.offerId)).path})),order:[...new Set([...ctx.allowed.values()].map(a=>a.path.split(SEP)[0]))]};
  if (path === '/promo/stats') return ads(data,ctx);
  if (path === '/orders/feed') return { ...pick(data,['from','to','since','_wb']), rows: (data.rows || []).filter(r => ctx.allowed.has(offerOf(r))).map(r => ({ ...pick(r,['p','sku','o','n','price','est','qty','st','wh','at','sch','self']), cat: ctx.allowed.get(offerOf(r)).path })) };
  if (path === '/discounts/overview') return { ...pick(data,['cabinet','lastCheckedAt']), items: (data.items || []).filter(r => ctx.allowed.has(offerOf(r))).map(r => ({ ...pick(r,['o','n','seller','site','card','pct','pctCard','schema','c1','c7','d1','d7','orders30','revenue30','checkedAt']), cat: ctx.allowed.get(offerOf(r)).path })) };
  if (path === '/sales/daily-prices') return { rows: data.rows.filter(r => ctx.allowed.has(String(r[0]))) };
  if (path === '/discounts/history') return { dates: data.dates, from:data.from,to:data.to, rows: (data.rows || []).filter(r => ctx.allowed.has(String(r[0]))), base: (data.base || []).filter(r => ctx.allowed.has(String(r[0]))) };
  if (path === '/promo/catalog') return (data || []).filter(a => ctx.allowed.has(offerOf(a))).map(a => pick(a,['offerId','productName']));
  if (path === '/competitors/product-ratings') return filterMap(data,ctx);
  if (['/promo/groups','/promo/groups/assign'].includes(path)) {
    const members = filterMap(data.members,ctx), ids = new Set(Object.values(members));
    return { members, groups: (data.groups || []).filter(g => (ids.has(g.id) || (ctx.userId != null && ctx.userId === g.createdBy))).map(g => pick(g,['id','name','color'])) };
  }
  if (path === '/sales/sewing') return {items:filterMap(data.items,ctx)};
  if (['/promo/transit','/sales/skus'].includes(path)) return filterMap(data,ctx);
  if (path === '/promo/order') return (data || []).filter(o => ctx.allowed.has(String(o)));
  if (path === '/promo/events') return require('./scopedAdEvents').scopedAdEvents(data, ctx.allowed);
  if (path === '/pricelog/dynamics') return { ...pick(data,['from','to','days']), items: filterMap(data.items,ctx) };
  if (path === '/sales/builder-templates') {
    if (data?._categoryFiltered !== true) throw Error('Нужен личный шаблон сотрудника');
    return {templates:data.templates ?? null};
  }
  if (path === '/finance/buyer-share') return { periods: (data?.periods || []).map(p => ({ ...pick(p,['from','to','total','at']), byOffer: filterMap(p.byOffer,ctx) })) };
  if (path === '/settings/tax') return pick(data,['cabinet','enabled','rate','effectiveRate','configured']);
  if (path === '/promo/data-status') return { ...pick(data,['automatic']), running: false, jobs: (data.jobs || []).map(j=>pick(j,['job','everyMin','lastSuccessAt'])) };
  if (path === '/discounts/settings') return pick(data,['enabled','intervalMin','threshold']);
  throw Error('Раздел не поддерживает ограниченный доступ');
}
function routeOf(path) {
  const normalized = path.toLowerCase().replace(/\/+$/, '').replace(/^\/api\/wb\/views/, '/api').replace(/^\/api\/ads(?=\/)/, '/api/promo');
  return normalized.replace(/^\/api/, '');
}
const EXTRA = ['/finance/ops','/pricelog','/pricelog/snap','/pricelog/history','/pricelog/rules','/sales/daily-prices','/sales/history','/sales/summary', '/sales/geo','/sales/costs','/queries/data','/queries/series','/queries/article','/competitors','/competitors/serp','/competitors/tracking','/plan/ozon','/plan/ozon/execution','/promo/stats','/promo/groups','/promo/catalog','/competitors/product-ratings','/promo/transit','/promo/order','/promo/events','/promo/data-status','/orders/feed','/discounts/overview','/discounts/history','/discounts/settings','/sales/sewing','/sales/skus','/sales/builder-templates','/pricelog/dynamics','/finance/buyer-share','/settings/tax'];
function middleware() {
  return async (req,res,next) => {
    if (req.user?.accessScope == null || !/^\/api(?:\/|$)/i.test(req.path)) return next();
    const path = routeOf(req.path);
    if (['/auth/me','/auth/logout','/auth/password','/auth/activity'].includes(path)) return next();
    req.restricted = true;
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (path === '/ad-hypotheses' || path.startsWith('/ad-hypotheses/')) {
      const allowedMethod = path === '/ad-hypotheses'
        ? read || req.method === 'POST'
        : (req.method === 'POST' && (path === '/ad-hypotheses/reorder' || /^\/ad-hypotheses\/[1-9]\d{0,17}\/finish$/.test(path)))
          || (req.method === 'DELETE' && /^\/ad-hypotheses\/[1-9]\d{0,17}$/.test(path));
      const scope = publicScope(req.user.accessScope);
      const { cabinet, offerId } = req.query;
      const deny = () => res.status(403).json({ success:false, error:'Нет доступа к этому товару' });
      if (!/^\/api\/ad-hypotheses(?:\/|$)/i.test(req.path) || !allowedMethod || !scope.pages.includes('ads')
        || typeof cabinet !== 'string' || !scope.cabinets.includes(cabinet) || typeof offerId !== 'string') return deny();
      try {
        if (!(await context(cabinet, scope)).allowed.has(offerId)) return deny();
      } catch { return res.status(503).json({success:false,error:'Не удалось проверить доступ к категориям'}); }
      res.set('Cache-Control', 'no-store');
      res.set('Vary', 'Cookie');
      return next();
    }
    const journalWrite = !/^\/api\/wb\/views/i.test(req.path) && ((req.method === 'POST' && path === '/promo/events') || (req.method === 'DELETE' && /^\/promo\/events\/\d+$/.test(path)));
    const groupAssignment = req.method === 'POST' && path === '/promo/groups/assign';
    const competitorWrite = /^\/api\/competitors\/?$/i.test(req.path) && ['POST', 'DELETE'].includes(req.method);
    const groupCreate = req.method === 'POST' && path === '/promo/groups';
    const transitWrite = req.method === 'POST' && path === '/promo/transit';
    const templateWrite = req.method === 'POST' && path === '/sales/builder-templates';
    const orderWrite = req.method === 'POST' && path === '/orders/self';
    const queryWrite = req.method === 'POST' && ['/queries/groups','/competitors/tracking'].includes(path);
    const scopedWrite = groupAssignment || groupCreate || transitWrite || templateWrite || orderWrite || queryWrite;
    if (!read && !journalWrite && !competitorWrite && !scopedWrite) return res.status(403).json({ success:false, error:'Доступ только для просмотра и выгрузки' });
    const scope = publicScope(req.user.accessScope);
    if (path === '/promo/cabinets') {
      const list = require('../config/cabinets').listCabinets().filter(c => scope.cabinets.includes(c.id));
      return res.json({ success:true, data:list.map(c => pick(c,['id','label','platform','family','connected'])) });
    }
    if (!journalWrite && !scopedWrite && !INDEXED[path] && !EXTRA.includes(path)) return res.status(403).json({ success:false, error:'Этот раздел недоступен в вашем профиле' });
    if(['/sales/summary','/plan/ozon','/plan/ozon/execution'].includes(path)){
      try{
        const requested=path==='/sales/summary'?(req.query.cabinet==='licio'?'licio':'marketplaces'):(req.query.scope||'ozon');
        if(!['licio','ozon','marketplaces'].includes(requested))return res.status(403).json({success:false,error:'Нет доступа к этой области'});
        const ids=scope.cabinets.filter(id=>requested==='licio'?id==='licio':id!=='licio');
        if(!ids.length)return res.status(403).json({success:false,error:'Нет доступа к этой области'});
        req.categoryContexts=Object.fromEntries(await Promise.all(ids.map(async id=>[id,await context(id,scope)])));
        return filtered({contexts:req.categoryContexts});
      }catch{return res.status(503).json({success:false,error:'Не удалось проверить доступ к категориям'});}
    }
    const cabinet = (journalWrite || competitorWrite || scopedWrite) && req.method === 'POST' ? req.body?.cabinet : (req.query.cabinet === undefined ? 'defly' : req.query.cabinet);
    if (typeof cabinet !== 'string' || !scope.cabinets.includes(cabinet) || (/^\/api\/wb\/views/i.test(req.path) && cabinet !== 'defly_wb')) return res.status(403).json({ success:false, error:'Нет доступа к этому кабинету' });
    if (queryWrite && cabinet === 'defly_wb') return res.status(403).json({success:false,error:'Поисковые запросы WB недоступны'});
    try {
      const ctx = await context(cabinet,scope);
      ctx.userId = req.user.id;
      if ((groupAssignment || transitWrite || queryWrite) && !ctx.allowed.has(req.body?.offerId)) {
        return res.status(403).json({success:false,error:'Нет доступа к этому товару'});
      }
      if (groupAssignment && req.body.groupId !== null && (typeof req.body.groupId !== 'string' || !req.body.groupId)) {
        return res.status(400).json({success:false,error:'Выберите группу'});
      }
      if (competitorWrite) {
        const offerId = req.method === 'POST' ? req.body?.offerId : req.query.offerId;
        if (cabinet === 'defly_wb' || typeof offerId !== 'string' || !ctx.allowed.has(offerId)) {
          return res.status(403).json({ success:false, error:'Нет доступа к этому товару' });
        }
        req.categoryContext = ctx;
        res.set('Cache-Control', 'no-store');
        return next();
      }
      if(!queryWrite && ['/queries/article','/queries/series','/competitors','/competitors/serp','/competitors/tracking'].includes(path) &&
        (typeof req.query.offerId !== 'string' || !ctx.allowed.has(req.query.offerId)))return res.status(403).json({success:false,error:'Нет доступа к этому товару'});
      req.categoryContext=ctx;
      if (journalWrite) {
        if (req.method === 'POST' && (typeof req.body?.offerId !== 'string' || !ctx.allowed.has(req.body.offerId))) return res.status(403).json({success:false,error:'Выберите доступный товар для заметки'});
        return next(); // Удаление дополнительно ограничено разрешёнными артикулами в самом SQL.
      }
      if (orderWrite || queryWrite || templateWrite) {
        res.set('Cache-Control', 'no-store');
        return next();
      }
      return filtered(ctx);
    } catch { return res.status(503).json({success:false,error:'Не удалось проверить доступ к категориям'}); }
    function filtered(ctx){
      const json = res.json.bind(res);
      res.set('Cache-Control','no-store');
      res.json = body => {
        res.set('Cache-Control','no-store'); res.set('Vary','Cookie');
        if (res.statusCode >= 400 || !body?.success) return json({ success:false, error:(groupAssignment || groupCreate)
          ? 'Не удалось сохранить группу. Проверьте доступ и обновите отчёт.'
          : 'Не удалось получить данные разрешённых категорий' });
        try { return json({ success:true, data:projection(path,body.data,ctx) }); }
        catch { return res.status(403).type('json').send(JSON.stringify({ success:false,error:'Раздел временно недоступен для ограниченного профиля' })); }
      };
      next();
    }
  };
}
module.exports = { normalize, publicScope, category, cabinets, availablePaths, validate, context, projection, middleware, inPath, PAGES, routeOf };
