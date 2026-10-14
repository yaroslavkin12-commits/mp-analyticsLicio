const axios = require('axios');
const { getCabinet } = require('./config/cabinets');
const { query } = require('./db');
const { getSettings, isQuietNow } = require('./collectors/ads/discountSettings');
const { autoPath } = require('./lib/categories');

// Уведомления в Telegram об изменении Соинвеста Ozon. Настройка через
// переменные окружения (одна и та же пара для всех кабинетов):
//   TELEGRAM_BOT_TOKEN — токен бота от @BotFather
//   TELEGRAM_CHAT_ID   — id чата/канала, куда слать сообщения (можно узнать
//                        через @userinfobot или API-метод getUpdates)
// Порог срабатывания по умолчанию — TELEGRAM_DISCOUNT_THRESHOLD (п.п., 1.5),
// но его можно переопределить на кабинет через вкладку "Настройки" в
// СПП-мониторе (см. collectors/ads/discountSettings.js) — там же тихие часы
// и ежедневный дайджест.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;
const THRESHOLD = Number(process.env.TELEGRAM_DISCOUNT_THRESHOLD) || 1.5;

async function sendMessage(text) {
  if (!TOKEN || !CHAT_ID) return false;
  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true,
  }, { timeout: 15000 });
  return true;
}

// Поштучные уведомления об изменении СПП отключены по просьбе владельца
// (14.10.2026): их было слишком много. Вместо них — одна сводка в день по
// категориям и сильным изменениям (sendDiscountDigest).
async function notifyDiscountChange() { /* отключено */ }

// Ежедневный дайджест — топ-3 изменения Соинвеста за последние сутки одним
// сообщением, в заданное в настройках время (аналог дайджеста TrueStats).
// Вызывается из планировщика (jobs.js), который сам следит, чтобы за день
// сообщение ушло не больше одного раза.
async function sendDiscountDigest(cabinet) {
  if (!TOKEN || !CHAT_ID) return false;
  const label = getCabinet(cabinet).label;
  const settings = await getSettings(cabinet).catch(() => null);
  const strongPp = Math.max(5, settings?.thresholdPct ?? 0); // «сильное» изменение, п.п.
  const rows = await query(
    `SELECT DISTINCT ON (offer_id) offer_id, ozon_discount_pct, marketing_price
       FROM product_discount_history
      WHERE cabinet = $1 AND platform = 'ozon' AND collected_at >= NOW() - INTERVAL '24 hours'
      ORDER BY offer_id, collected_at DESC`, [cabinet]).catch(() => []);
  const prevRows = await query(
    `SELECT DISTINCT ON (offer_id) offer_id, ozon_discount_pct
       FROM product_discount_history
      WHERE cabinet = $1 AND platform = 'ozon' AND collected_at < NOW() - INTERVAL '24 hours'
      ORDER BY offer_id, collected_at DESC`, [cabinet]).catch(() => []);
  const prevByOffer = new Map(prevRows.map(r => [r.offer_id, Number(r.ozon_discount_pct)]));
  const pairs = rows.map(r => ({ o: r.offer_id, prev: prevByOffer.get(r.offer_id), pct: Number(r.ozon_discount_pct), price: Number(r.marketing_price) }))
    .filter(x => x.prev !== undefined && Number.isFinite(x.prev) && Number.isFinite(x.pct));
  if (!pairs.length) return false;

  // Категория артикула — как в сервисе: ручная правка или автоматическая (2 уровня).
  const offers = pairs.map(x => x.o);
  const [names, ovs] = await Promise.all([
    query(`SELECT offer_id, product_name FROM ad_product_catalog WHERE cabinet = $1 AND offer_id = ANY($2::text[])`, [cabinet, offers]).catch(() => []),
    query(`SELECT offer_id, path FROM product_category_override WHERE cabinet = $1 AND offer_id = ANY($2::text[])`, [cabinet, offers]).catch(() => []),
  ]);
  const nameBy = new Map(names.map(r => [r.offer_id, r.product_name || '']));
  const ovBy = new Map(ovs.map(r => [r.offer_id, r.path]));
  const catOf = o => {
    const path = ovBy.get(o) || autoPath(cabinet, nameBy.get(o) || '', o).join(' / ');
    return String(path || 'Без категории').split(' / ').slice(0, 2).join(' / ');
  };
  const cats = new Map();
  for (const x of pairs) {
    const c = catOf(x.o);
    const g = cats.get(c) || { n: 0, prev: 0, now: 0, up: 0, down: 0 };
    g.n++; g.prev += x.prev; g.now += x.pct;
    if (x.pct - x.prev >= 0.1) g.up++; else if (x.prev - x.pct >= 0.1) g.down++;
    cats.set(c, g);
  }
  const pp = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1).replace('.', ',')} п.п.`;
  const f1 = v => v.toFixed(1).replace('.', ',');
  const catLines = [...cats.entries()].filter(([, g]) => g.n >= 3)
    .map(([c, g]) => ({ c, g, a0: g.prev / g.n, a1: g.now / g.n }))
    .sort((x, y) => Math.abs(y.a1 - y.a0) - Math.abs(x.a1 - x.a0))
    .map(({ c, g, a0, a1 }) => `${Math.abs(a1 - a0) < 0.1 ? '▫️' : a1 > a0 ? '📈' : '📉'} <b>${c}</b>: ${f1(a0)}% → ${f1(a1)}% (${pp(a1 - a0)}; выросла у ${g.up}, снизилась у ${g.down} из ${g.n})`);
  const strong = pairs.filter(x => Math.abs(x.pct - x.prev) >= strongPp).sort((a, b) => Math.abs(b.pct - b.prev) - Math.abs(a.pct - a.prev));
  const strongLines = strong.slice(0, 10).map(x => `${x.pct > x.prev ? '📈' : '📉'} <b>${x.o}</b> (${catOf(x.o).split(' / ').pop()}): ${f1(x.prev)}% → ${f1(x.pct)}%${x.price ? `, цена для покупателя ${Math.round(x.price)} ₽` : ''}`);
  const anyChange = [...cats.values()].some(g => g.up || g.down);
  if (!anyChange && !strong.length) return false;
  let text = `📋 <b>${label}: СПП Ozon за сутки</b>\n\n<b>По категориям</b> (средняя СПП):\n${catLines.join('\n')}`;
  if (strongLines.length) text += `\n\n<b>Сильные изменения</b> (от ${strongPp} п.п.):\n${strongLines.join('\n')}${strong.length > 10 ? `\n…и ещё ${strong.length - 10}` : ''}`;
  await sendMessage(text);
  return true;
}

// Уведомление о новом заказе по отслеживаемому артикулу (вкладка
// "Уведомления", см. collectors/trackedArticles.js). В отличие от
// Соинвеста, тут нет порога/тихих часов — каждый новый заказ по
// добавленному артикулу считается важным и шлётся сразу.
async function notifyNewOrder(cabinet, platform, tracked, order) {
  if (!TOKEN || !CHAT_ID) return;
  const label = getCabinet(cabinet).label;
  const platformLabel = platform === 'wb' ? 'Wildberries' : 'Ozon';
  const title = tracked.label ? `${tracked.article} (${tracked.label})` : tracked.article;
  const lines = [`🛒 <b>${label} · ${platformLabel}: новый заказ</b>`, `Артикул: <b>${title}</b>`];
  if (tracked.group_name) lines.push(`Группа: ${tracked.group_name}`);
  if (order.productName) lines.push(String(order.productName).slice(0, 150));
  if (order.price) lines.push(`Сумма: ${Math.round(Number(order.price)).toLocaleString('ru-RU')} ₽`);
  if (order.warehouse) lines.push(`Склад: ${order.warehouse}`);
  await sendMessage(lines.join('\n'));
}

module.exports = { sendMessage, notifyDiscountChange, sendDiscountDigest, notifyNewOrder, THRESHOLD };
