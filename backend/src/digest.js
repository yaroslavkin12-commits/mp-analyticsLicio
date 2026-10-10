const dayjs = require('dayjs');
const { query } = require('./db');
const { sendMessage } = require('./telegram');

// ─────────────────────────────────────────────────────────────────────────
// Утренний дайджест в Telegram: итоги вчерашнего дня по кабинету.
//   • заказы ₽/шт — к позавчера и к среднему за 7 дней до вчера;
//   • реклама и ДРР;
//   • оценка прибыли от вчерашних заказов (средние за 30 дней: выкуп,
//     удержания Ozon и себестоимость — как в «Юнит-экономике»);
//   • выкупы и поступления по финансам;
//   • рост/падение по артикулам;
//   • остатки: закончились при спросе, хватит меньше чем на 7 дней.
// Настройки — app_settings 'morning_digest:<кабинет>' { enabled, time }.
// ─────────────────────────────────────────────────────────────────────────

const num = v => Number(v) || 0;
const fmt = v => Math.round(v).toLocaleString('ru-RU').replace(/ /g, ' ');
const pct = (a, b) => (b > 0 ? (a - b) / b * 100 : null);
const arrow = v => (v === null || !Number.isFinite(v) ? '' : ` ${v >= 0 ? '▲' : '▼'}${Math.abs(v).toFixed(0)}%`);
const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function getDigestSettings(cabinet) {
  const rows = await query(`SELECT value FROM app_settings WHERE key = $1`, [`morning_digest:${cabinet}`]).catch(() => []);
  const def = { enabled: cabinet === 'defly', time: '09:00', tax: 6 };
  try { return { ...def, ...(rows[0] ? JSON.parse(rows[0].value) : {}) }; } catch (e) { return def; }
}
async function saveDigestSettings(cabinet, s) {
  const cur = await getDigestSettings(cabinet);
  const next = { ...cur, ...s };
  await query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [`morning_digest:${cabinet}`, JSON.stringify(next)]);
  return next;
}

async function buildMorningDigest(cabinet) {
  const settings = await getDigestSettings(cabinet);
  const msk = dayjs().tz ? dayjs().tz('Europe/Moscow') : dayjs().add(3, 'hour');
  const Y = msk.subtract(1, 'day').format('YYYY-MM-DD'), D2 = msk.subtract(2, 'day').format('YYYY-MM-DD');
  const f7 = msk.subtract(8, 'day').format('YYYY-MM-DD'), f30 = msk.subtract(31, 'day').format('YYYY-MM-DD');
  const b45 = msk.subtract(45, 'day').format('YYYY-MM-DD'), b5 = msk.subtract(5, 'day').format('YYYY-MM-DD');
  const [ord, ads, arts, fin, buy, costs, stock, cat] = await Promise.all([
    query(`SELECT date::text d, SUM(orders_item)::int q, SUM(revenue) r FROM product_analytics_daily
            WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3 GROUP BY date`, [cabinet, f7, Y]),
    query(`SELECT date::text d, SUM(spend) s FROM ad_stats_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3 GROUP BY date`, [cabinet, D2, Y]).catch(() => []),
    query(`SELECT offer_id, SUM(CASE WHEN date = $3 THEN revenue ELSE 0 END) y, SUM(CASE WHEN date < $3 THEN revenue ELSE 0 END) / 7.0 a,
                  SUM(CASE WHEN date >= $4 THEN orders_item ELSE 0 END) / 14.0 v
             FROM product_analytics_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3 GROUP BY offer_id`,
      [cabinet, f7, Y, msk.subtract(14, 'day').format('YYYY-MM-DD')]),
    query(`SELECT date::text d, sku, name, SUM(amount) a, SUM(qty) q FROM finance_daily WHERE cabinet = $1 AND date BETWEEN $2 AND $3 GROUP BY date, sku, name`, [cabinet, f30, Y]).catch(() => []),
    query(`SELECT SUM(delivered)::int d, SUM(cancelled)::int c FROM buyout_daily WHERE cabinet = $1 AND date BETWEEN $2 AND $3`, [cabinet, b45, b5]).catch(() => []),
    query(`SELECT article, cost_price FROM product_costs WHERE cabinet = $1 OR cabinet IS NULL`, [cabinet]).catch(() => []),
    query(`SELECT DISTINCT ON (offer_id) offer_id, fbo_present - fbo_reserved + fbs_present - fbs_reserved s FROM ad_product_stocks
            WHERE cabinet = $1 AND platform = 'ozon' AND snapshot_date >= $2 ORDER BY offer_id, snapshot_date DESC, collected_at DESC`, [cabinet, msk.subtract(4, 'day').format('YYYY-MM-DD')]).catch(() => []),
    query(`SELECT offer_id, sku, product_name FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet]).catch(() => []),
  ]);
  const byD = new Map(ord.map(r => [r.d, { q: num(r.q), r: num(r.r) }]));
  const y = byD.get(Y) || { q: 0, r: 0 }, d2 = byD.get(D2) || { q: 0, r: 0 };
  const prev = ord.filter(r => r.d < Y); const avgR = prev.reduce((s, r) => s + num(r.r), 0) / 7, avgQ = prev.reduce((s, r) => s + num(r.q), 0) / 7;
  if (!y.r && !y.q && !avgR) return null;
  const spendY = num(ads.find(r => r.d === Y)?.s);
  // Средние за 30 дней: удержания Ozon и себестоимость к выручке по выкупам.
  const offerBySku = new Map(cat.filter(r => r.sku).map(r => [String(r.sku), r.offer_id]));
  const nameOf = new Map(cat.map(r => [r.offer_id, r.product_name]));
  const cost = new Map(costs.map(r => [r.article, num(r.cost_price)]));
  let sale = 0, oz = 0, costSum = 0, saleY = 0, payY = 0, qtyY = 0;
  for (const r of fin) {
    const a = num(r.a), q = num(r.q), n = String(r.name);
    const isSale = /^Продажа/.test(n), isRet = /^Возврат выручки/.test(n);
    if (isSale || isRet) {
      sale += a; const o = offerBySku.get(String(r.sku)); const c = o ? cost.get(o) : null;
      if (c) costSum += c * (isSale ? Math.abs(q) : -Math.abs(q));
      if (r.d === Y) { saleY += a; qtyY += isSale ? Math.abs(q) : -Math.abs(q); }
    } else if (!/payperclick|promotion|costperorder/i.test(n)) oz += a;
    if (r.d === Y && !/payperclick|promotion|costperorder/i.test(n)) payY += a;
  }
  const b = buy[0] && num(buy[0].d) + num(buy[0].c) > 0 ? num(buy[0].d) / (num(buy[0].d) + num(buy[0].c)) : 0.8;
  const ozRate = sale > 0 ? -oz / sale : 0.4, costRate = sale > 0 ? costSum / sale : 0;
  const tax = (settings.tax ?? 6) / 100;
  const expRev = y.r * b;
  const profit = expRev * (1 - ozRate - costRate - tax) - spendY;

  const L = [];
  L.push(`☀️ <b>${cabinet === 'defly' ? 'Defly' : esc(cabinet)} · итоги ${dayjs(Y).format('DD.MM')}</b>`);
  L.push(`📦 Заказы: <b>${fmt(y.r)} ₽</b> · ${fmt(y.q)} шт${arrow(pct(y.r, d2.r))} к позавчера,${arrow(pct(y.r, avgR)) || ' —'} к среднему за неделю`);
  L.push(`💳 Средний чек: ${y.q ? fmt(y.r / y.q) : '—'} ₽ (за неделю ${avgQ ? fmt(avgR / avgQ) : '—'} ₽)`);
  L.push(`📣 Реклама: ${fmt(spendY)} ₽ · ДРР ${y.r ? (spendY / y.r * 100).toFixed(1).replace('.', ',') : '—'}%`);
  L.push(`💰 Прибыль от заказов (оценка): <b>${fmt(profit)} ₽</b> · маржа ${expRev > 0 ? (profit / expRev * 100).toFixed(0) : '—'}%`);
  L.push(`   <i>выкуп ${(b * 100).toFixed(0)}%, удержания Ozon ${(ozRate * 100).toFixed(0)}%, себестоимость ${(costRate * 100).toFixed(0)}%${costRate === 0 ? ' (не заполнена)' : ''}, налог ${(tax * 100).toFixed(0)}%</i>`);
  if (saleY) L.push(`🧾 Выкупы по финансам: ${fmt(saleY)} ₽ · ${fmt(qtyY)} шт · к перечислению ≈ ${fmt(payY)} ₽`);

  const movers = arts.map(r => ({ o: r.offer_id, y: num(r.y), a: num(r.a), d: num(r.y) - num(r.a) })).filter(r => r.a >= 3000 || r.y >= 3000);
  const up = [...movers].sort((x, z) => z.d - x.d).slice(0, 3).filter(r => r.d > 0);
  const down = [...movers].sort((x, z) => x.d - z.d).slice(0, 3).filter(r => r.d < 0);
  const short = o => esc((nameOf.get(o) || '').slice(0, 38));
  if (up.length) L.push(`\n📈 <b>Растут</b> (вчера к среднему за неделю):\n${up.map(r => `• ${esc(r.o)} ${short(r.o)}: ${fmt(r.y)} ₽ (+${fmt(r.d)})`).join('\n')}`);
  if (down.length) L.push(`📉 <b>Падают</b>:\n${down.map(r => `• ${esc(r.o)} ${short(r.o)}: ${fmt(r.y)} ₽ (${fmt(r.d)})`).join('\n')}`);

  const st = new Map(stock.map(r => [r.offer_id, num(r.s)]));
  const vel = new Map(arts.map(r => [r.offer_id, num(r.v)]));
  const risk = [];
  for (const [o, v] of vel) {
    if (v < 0.3) continue;
    const s = st.has(o) ? st.get(o) : null; if (s === null) continue;
    const cover = s / v;
    if (cover < 7) risk.push({ o, s, v, cover });
  }
  risk.sort((x, z) => x.cover - z.cover || z.v - x.v);
  const out = risk.filter(r => r.s <= 0), low = risk.filter(r => r.s > 0);
  if (out.length || low.length) {
    L.push(`\n🏬 <b>Остатки</b>: закончились при спросе — ${out.length}, хватит меньше чем на 7 дней — ${low.length}`);
    L.push(risk.slice(0, 6).map(r => `• ${esc(r.o)} ${short(r.o)}: ${r.s <= 0 ? 'нет в наличии' : `${fmt(r.s)} шт ≈ ${Math.max(1, Math.round(r.cover))} дн`} (${r.v.toFixed(1).replace('.', ',')} шт/день)`).join('\n'));
  }
  return L.join('\n');
}

async function sendMorningDigest(cabinet) {
  const text = await buildMorningDigest(cabinet);
  if (!text) return false;
  return sendMessage(text);
}

module.exports = { buildMorningDigest, sendMorningDigest, getDigestSettings, saveDigestSettings };
