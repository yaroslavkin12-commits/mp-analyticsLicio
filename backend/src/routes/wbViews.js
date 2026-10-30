const express = require('express');
const { randomUUID } = require('crypto');
const V = require('../lib/wbViews');
const bridge = require('../lib/wbBridge');
const router = express.Router();
const groups = p => ({ groups: p.groups, members: p.members });
const bounded = (v, max = 500) => String(v || '').trim().slice(0, max);
const finite = v => v !== '' && v != null && Number.isFinite(Number(v));
router.use(async (req, res) => {
  try {
    if ((req.query.cabinet || req.body?.cabinet || 'defly_wb') !== 'defly_wb') throw new Error('Неизвестный кабинет WB');
    const path = req.path.replace(/^\/ads(?=\/|$)/, '/promo'), body = req.body || {};
    if (req.method !== 'GET') {
      if (path === '/promo/collect') { await require('../collectors/wb/sheetSync').sync(true); return res.json({ success: true, data: { running: false } }); }
      if (path === '/sales/costs') {
        const route = require('./sales').stack.find(l => l.route?.path === '/costs' && l.route.methods.post);
        return route.route.stack[0].handle(req, res);
      }
      const result = await V.update(p => {
        const id = bounded(body.offerId, 128), groupId = body.id || path.split('/').at(-1);
        if (path === '/promo/order') { if (!Array.isArray(body.order) || body.order.length > 5000) throw new Error('Некорректный порядок'); p.order = [...new Set(body.order.map(x => bounded(x, 128)))]; return p.order; }
        if (path === '/promo/transit') { if (!id) throw new Error('Укажите артикул'); const old = p.transit[id] || {}; p.transit[id] = { q: body.qty === undefined ? old.q || 0 : Math.max(0, Math.min(1000000, Math.round(Number(body.qty) || 0))), d: body.date === undefined ? old.d || '' : bounded(body.date, 10) }; return p.transit; }
        if (path === '/promo/manual') { if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(body.date || '') || !['views', 'pdpViews', 'cart', 'orders', 'revenue'].includes(body.metric)) throw new Error('Некорректная ручная метрика'); const key = id + '|' + body.date; p.manual[key] ||= {}; if (body.value == null || body.value === '') delete p.manual[key][body.metric]; else { if (!finite(body.value) || Number(body.value) < 0) throw new Error('Укажите неотрицательное число'); p.manual[key][body.metric] = Number(body.value); } return p.manual[key]; }
        if (path === '/promo/groups' && req.method === 'POST') { const name = bounded(body.name, 100); if (!name) throw new Error('Введите название'); p.groups.push({ id: randomUUID(), name }); return groups(p); }
        if (path.startsWith('/promo/groups/') && req.method === 'DELETE') { p.groups = p.groups.filter(g => g.id !== groupId); for (const [o, g] of Object.entries(p.members)) if (g === groupId) delete p.members[o]; return groups(p); }
        if (path === '/promo/groups/assign') { if (!id || (body.groupId && !p.groups.some(g => g.id === body.groupId))) throw new Error('Неизвестный артикул или группа'); if (body.groupId) p.members[id] = body.groupId; else delete p.members[id]; return groups(p); }
        if (path === '/promo/groups/rename') { const g = p.groups.find(g => g.id === body.id); if (!g || !bounded(body.name, 100)) throw new Error('Неизвестная группа'); g.name = bounded(body.name, 100); return groups(p); }
        if (path === '/promo/groups/reorder') { const ids = Array.isArray(body.order) ? body.order : []; p.groups.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); return groups(p); }
        if (path === '/promo/groups/from-cluster') { const name = bounded(body.name, 100), offers = body.offerIds; if (!name || !Array.isArray(offers) || offers.length > 5000) throw new Error('Некорректная группа'); const g = { id: randomUUID(), name }; p.groups.push(g); for (const o of offers) p.members[bounded(o, 128)] = g.id; return groups(p); }
        if (path === '/promo/events' && req.method === 'POST') { if (!bounded(body.text) || !/^\d{4}-\d{2}-\d{2}$/.test(body.date || '')) throw new Error('Введите дату и текст'); const e = { id: randomUUID(), offerId: id, date: body.date, text: bounded(body.text), kind: 'note', manual: true }; p.events.unshift(e); return e; }
        if (path.startsWith('/promo/events/') && req.method === 'DELETE') { p.events = p.events.filter(e => e.id !== path.split('/').at(-1)); return {}; }
        if (path === '/sales/category') { if (!Array.isArray(body.offerIds) || body.offerIds.length > 5000) throw new Error('Выберите артикулы'); for (const o of body.offerIds) { if (body.path) p.categories[bounded(o, 128)] = bounded(body.path); else delete p.categories[bounded(o, 128)]; } return { path: bounded(body.path) }; }
        if (path === '/sales/sewing') { p.sewing = body.items || {}; return { items: p.sewing }; }
        if (path === '/sales/builder-templates') { p.templates = body.templates; return { templates: p.templates }; }
        if (path === '/orders/self') { if (!Array.isArray(body.items) || body.items.length > 2000) throw new Error('Выберите заказы'); for (const item of body.items) { const key = bounded(item.p, 150) + '|' + bounded(item.sku, 30); if (body.on) p.self[key] = true; else delete p.self[key]; } return { changed: body.items.length }; }
        if (path === '/clusters/decide') { if (!Array.isArray(body.offers) || !['add', 'ignore', 'reset'].includes(body.action)) throw new Error('Некорректное действие'); for (const o of body.offers) { if (body.action === 'reset') delete p.clusterDecisions[o]; else p.clusterDecisions[o] = body.action === 'add' ? bounded(body.id, 128) : null; } return {}; }
        throw new Error('Эта операция WB пока недоступна');
      });
      if (path === '/clusters/decide') { const m = V.build(await bridge.read({excludeFinance:true}), await V.preferences()); return res.json({ success: true, data: m.clusters() }); }
      return res.json({ success: true, data: result });
    }
    const prefs = await V.preferences();
    if (path === '/promo/groups') return res.json({ success: true, data: groups(prefs) });
    if (path === '/promo/order') return res.json({ success: true, data: prefs.order });
    if (path === '/promo/transit') return res.json({ success: true, data: prefs.transit });
    if (path === '/promo/events') return res.json({ success: true, data: prefs.events.filter(e => (!req.query.dateFrom || e.date >= req.query.dateFrom) && (!req.query.dateTo || e.date <= req.query.dateTo)) });
    if (path === '/sales/sewing') return res.json({ success: true, data: { items: prefs.sewing } });
    if (path === '/sales/builder-templates') return res.json({ success: true, data: { templates: prefs.templates } });
    if (path === '/finance/buyer-share') return res.json({ success: true, data: { periods: [] } });
    if (path === '/promo/data-status') {
      const ds = await bridge.read({excludeFinance:true}), status = require('../collectors/wb/sheetSync').status();
      return res.json({ success: true, data: { running: status.busy, jobs: [['catalog', 'catalog'], ['analytics', 'orders'], ['perf', 'ads'], ['stocks', 'stocks']].map(([job, kind]) => ({ job, everyMin: 60, lastSuccessAt: ds.find(x => x.kind === kind)?.meta.collectedAt || null, lastError: status.error })) } });
    }
    const supported = ['/orders/feed', '/sales/data', '/sales/geo', '/sales/costs', '/sales/skus', '/promo/stats', '/promo/catalog', '/promo/sibling-clusters', '/stocks/data', '/finance/coefs', '/finance/pnl', '/finance/calc-base', '/clusters', '/queries/season'];
    if (!supported.includes(path)) return res.status(503).json({ success: false, error: 'Данные WB для этого раздела пока не подключены' });
    await require('../collectors/wb/sheetSync').sync(req.query.fresh === '1');
    const ds = await bridge.read({excludeFinance:true}), m = V.build(ds, prefs, req.query); let out;
    if (path === '/sales/data') out = m.sales();
    if (path === '/promo/stats') out = m.ads();
    if (path === '/orders/feed') out = m.feed();
    if (path === '/stocks/data') out = m.stocks();
    if (path === '/finance/coefs') out = m.coefs();
    if (path === '/finance/pnl') out = m.pnl();
    if (path === '/sales/geo') out = m.geo();
    if (path === '/queries/season') out = m.season();
    if (path === '/clusters') out = m.clusters();
    if (path === '/promo/sibling-clusters') out = m.clusters().clusters.map(c => ({ primary: c.members[0], members: c.members, name: c.name }));
    if (path === '/promo/catalog') out = m.articles.map(a => ({ offerId: a.o, productName: a.n, sku: a.sku }));
    if (path === '/sales/skus') out = Object.fromEntries(m.articles.map(a => [a.o, a.sku]));
    if (['/sales/costs','/finance/calc-base'].includes(path)) { const costs = await require('../db').query("SELECT article,cost_price,updated_at FROM product_costs WHERE cabinet='defly' OR cabinet IS NULL ORDER BY updated_at DESC"); out = path === '/sales/costs' ? m.costs(costs) : m.calcBase(costs); }
    res.set('Cache-Control', 'no-store'); res.json({ success: true, data: out });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
module.exports = router;
