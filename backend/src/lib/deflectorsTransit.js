const { createHash } = require('crypto');
const { query } = require('../db');
const KEY = 'prod:defly:deflectors2d:v1';
const norm = s => String(s || '').trim().toLowerCase();
const qty = n => Math.max(0, Number(n) || 0);

// Одно событие расходуется один раз: сначала самая ранняя открытая партия.
// Старые записи журнала не превращаем задним числом в ожидаемые поставки.
function reconcile(journal, events) {
  const batches = journal.map(j => ({ ...j, items: j.items.map(r => ({ ...r, received: 0, receipts: [] })) }));
  const ordered = batches.filter(j => j.tracked).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || a.id.localeCompare(b.id));
  const seen = new Set();
  for (const e of [...events].sort((a, b) => new Date(a.at) - new Date(b.at) || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) {
    if (seen.has(String(e.id))) continue;
    seen.add(String(e.id));
    let available = Math.max(0, Number(e.fbo_after) + Number(e.fbs_after) - Number(e.fbo_before) - Number(e.fbs_before));
    if (!available) continue;
    for (const j of ordered) {
      if (j.receivingCabinet !== e.cabinet || new Date(e.at) <= new Date(j.createdAt)) continue;
      const r = j.items.find(r => norm(r.offer) === norm(e.offer_id));
      if (!r) continue;
      const take = Math.min(available, Math.max(0, qty(r.quantity) - r.received));
      if (!take) continue;
      r.received += take; available -= take;
      r.receipts.push({ id: String(e.id), at: e.at, quantity: take, cabinet: e.cabinet });
      if (!available) break;
    }
  }
  for (const j of batches) {
    for (const r of j.items) r.remaining = j.tracked ? Math.max(0, qty(r.quantity) - r.received) : null;
    j.received = j.items.reduce((s, r) => s + r.received, 0);
    j.remaining = j.tracked ? j.items.reduce((s, r) => s + r.remaining, 0) : null;
  }
  return batches;
}
async function ledger(state, run = query) {
  if (!state) { const rows = await run('SELECT value FROM app_settings WHERE key=$1', [KEY]); state = rows[0] ? JSON.parse(rows[0].value) : { journal: [] }; }
  const tracked = (state.journal || []).filter(j => j.tracked);
  if (!tracked.length) return reconcile(state.journal || [], []);
  const first = tracked.reduce((s, j) => j.createdAt < s ? j.createdAt : s, tracked[0].createdAt);
  const exists = await run("SELECT to_regclass('public.restock_events') AS name");
  const events = exists[0]?.name ? await run('SELECT id, cabinet, offer_id, at, fbo_before, fbo_after, fbs_before, fbs_after FROM restock_events WHERE at > $1 AND cabinet = ANY($2::text[]) ORDER BY at, id', [first, [...new Set(tracked.map(j => j.receivingCabinet))]]) : [];
  return reconcile(state.journal || [], events);
}
function pendingMap(journal, cabinet) {
  const map = {};
  for (const j of journal) if (j.tracked && j.receivingCabinet === cabinet) for (const r of j.items) {
    const k = norm(r.offer), item = map[k] || (map[k] = { offer: r.offer, q: 0, d: '', managed: true });
    item.q += qty(r.remaining);
    if (r.remaining > 0 && j.expectedDate && (!item.d || j.expectedDate < item.d)) item.d = j.expectedDate;
  }
  return map;
}
async function adsTransit(cabinet, manual, state, run = query) {
  const journal = await ledger(state, run);
  return mergeTransit(journal, cabinet, manual);
}
function mergeTransit(journal, cabinet, manual) {
  const managed = pendingMap(journal, cabinet);
  const result = { ...manual };
  for (const p of Object.values(managed)) {
    const key = Object.keys(result).find(k => norm(k) === norm(p.offer)) || p.offer;
    const old = result[key], manualQty = qty(typeof old === 'number' ? old : old?.q);
    result[key] = { q: p.q + manualQty, d: [p.d, old?.d].filter(Boolean).sort()[0] || '', managed: true, productionQty: p.q, manualQty, manualDate: old?.d || '' };
  }
  return result;
}
async function inventory(state, cabinet, run = query) {
  const journal = await ledger(state, run);
  const [stocks, manualRows] = await Promise.all([
    run(`SELECT offer_id, snapshot_date::text date, SUM(fbo_present) AS fbo_present, SUM(fbs_present) AS fbs_present, snapshot_date >= CURRENT_DATE - INTERVAL '1 day' AS fresh
      FROM ad_product_stocks WHERE cabinet=$1 AND platform='ozon' AND snapshot_date >= CURRENT_DATE - INTERVAL '60 days'
      GROUP BY offer_id, snapshot_date ORDER BY offer_id, snapshot_date DESC`, [cabinet]),
    run('SELECT value FROM app_settings WHERE key=$1', [`ads_transit:${cabinet}`]),
  ]);
  const transit = mergeTransit(journal, cabinet, manualRows[0] ? JSON.parse(manualRows[0].value) : {});
  const byOffer = {}, history = [];
  for (const r of stocks) {
    const key = norm(r.offer_id), stock = qty(r.fbo_present) + qty(r.fbs_present);
    if (!byOffer[key]) byOffer[key] = { stock: r.fresh ? stock : null, stale: !r.fresh, date: r.date };
    history.push({ offer: r.offer_id, date: r.date, stock });
  }
  for (const [offer, t] of Object.entries(transit)) {
    const row = byOffer[norm(offer)] ||= { stock: null, date: null };
    row.productionTransit = qty(t?.productionQty);
    row.transit = qty(typeof t === 'number' ? t : t.q); row.manualTransit = typeof t === 'number' ? t : t.manualQty ?? t.q ?? 0;
  }
  for (const r of Object.values(byOffer)) r.transit ??= 0;
  const version = createHash('sha256').update(JSON.stringify({ cabinet, byOffer })).digest('hex');
  return { cabinet, byOffer, history, journal, version };
}
module.exports = { KEY, reconcile, ledger, pendingMap, mergeTransit, adsTransit, inventory };
