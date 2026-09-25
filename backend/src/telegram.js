const axios = require('axios');
const { getCabinet } = require('./config/cabinets');
const { query } = require('./db');
const { getSettings, isQuietNow } = require('./collectors/ads/discountSettings');

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

async function notifyDiscountChange(cabinet, changed) {
  if (!TOKEN || !CHAT_ID) return;
  const settings = await getSettings(cabinet).catch(() => null);
  const threshold = settings?.thresholdPct ?? THRESHOLD;
  const significant = changed.filter(c => Math.abs(c.pct - c.prevPct) >= threshold);
  if (!significant.length) return;
  // В тихие часы не шлём поштучные уведомления — они попадут в утренний
  // дайджест (если он включён) или молча останутся в истории.
  if (settings && isQuietNow(settings)) return;

  const label = getCabinet(cabinet).label;
  // Названия товаров для читаемого сообщения — берём из каталога, если есть.
  const offerIds = significant.map(c => c.offerId);
  const names = await query(
    `SELECT offer_id, product_name FROM ad_product_catalog WHERE cabinet = $1 AND offer_id = ANY($2::text[])`,
    [cabinet, offerIds]).catch(() => []);
  const nameByOffer = new Map(names.map(r => [r.offer_id, r.product_name]));

  const lines = significant.slice(0, 15).map(c => {
    const dir = c.pct > c.prevPct ? '📈' : '📉';
    const name = nameByOffer.get(c.offerId);
    const title = name ? `${c.offerId} (${name.slice(0, 40)})` : c.offerId;
    return `${dir} <b>${title}</b>: ${c.prevPct.toFixed(1)}% → ${c.pct.toFixed(1)}% (цена для покупателя ${Math.round(c.marketingPrice)} ₽)`;
  });
  const text = `⚠️ <b>${label}: изменился Соинвест Ozon</b>\n\n${lines.join('\n')}` +
    (significant.length > 15 ? `\n\n…и ещё ${significant.length - 15}` : '');
  await sendMessage(text);
}

// Разово предупреждаем, что сессия кабинета (cookie) протухла и Соинвест
// больше не считается по реальной цене — раз в час максимум на кабинет,
// чтобы не заспамить чат при каждом прогоне сборщика (каждые 20 минут).
const sessionAlertSentAt = new Map();
async function notifySessionExpired(cabinet) {
  if (!TOKEN || !CHAT_ID) return;
  const last = sessionAlertSentAt.get(cabinet) || 0;
  if (Date.now() - last < 60 * 60 * 1000) return;
  sessionAlertSentAt.set(cabinet, Date.now());
  const label = getCabinet(cabinet).label;
  await sendMessage(`⚠️ <b>${label}: сессия кабинета Ozon протухла</b>\n\nСоинвест считается неточно (без реальной цены на сайте). Нужно обновить cookie кабинета (OZON_SELLER_COOKIE) в Render.`);
}

// Ежедневный дайджест — топ-3 изменения Соинвеста за последние сутки одним
// сообщением, в заданное в настройках время (аналог дайджеста TrueStats).
// Вызывается из планировщика (jobs.js), который сам следит, чтобы за день
// сообщение ушло не больше одного раза.
async function sendDiscountDigest(cabinet) {
  if (!TOKEN || !CHAT_ID) return false;
  const label = getCabinet(cabinet).label;
  const rows = await query(
    `SELECT DISTINCT ON (offer_id) offer_id, ozon_discount_pct, marketing_price, collected_at
       FROM product_discount_history
      WHERE cabinet = $1 AND platform = 'ozon' AND collected_at >= NOW() - INTERVAL '24 hours'
      ORDER BY offer_id, collected_at DESC`, [cabinet]).catch(() => []);
  const prevRows = await query(
    `SELECT DISTINCT ON (offer_id) offer_id, ozon_discount_pct
       FROM product_discount_history
      WHERE cabinet = $1 AND platform = 'ozon' AND collected_at < NOW() - INTERVAL '24 hours'
      ORDER BY offer_id, collected_at DESC`, [cabinet]).catch(() => []);
  const prevByOffer = new Map(prevRows.map(r => [r.offer_id, Number(r.ozon_discount_pct)]));

  const changes = rows
    .map(r => {
      const prev = prevByOffer.get(r.offer_id);
      if (prev === undefined) return null;
      const pct = Number(r.ozon_discount_pct);
      return { offerId: r.offer_id, prevPct: prev, pct, delta: pct - prev, marketingPrice: Number(r.marketing_price) };
    })
    .filter(c => c && Math.abs(c.delta) >= 0.1)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 3);

  if (!changes.length) return false;

  const offerIds = changes.map(c => c.offerId);
  const names = await query(
    `SELECT offer_id, product_name FROM ad_product_catalog WHERE cabinet = $1 AND offer_id = ANY($2::text[])`,
    [cabinet, offerIds]).catch(() => []);
  const nameByOffer = new Map(names.map(r => [r.offer_id, r.product_name]));

  const lines = changes.map(c => {
    const dir = c.delta > 0 ? '📈' : '📉';
    const name = nameByOffer.get(c.offerId);
    const title = name ? `${c.offerId} (${name.slice(0, 40)})` : c.offerId;
    return `${dir} <b>${title}</b>: ${c.prevPct.toFixed(1)}% → ${c.pct.toFixed(1)}%`;
  });
  const text = `📋 <b>${label}: дайджест Соинвеста Ozon за сутки</b>\n\n${lines.join('\n')}`;
  await sendMessage(text);
  return true;
}

module.exports = { sendMessage, notifyDiscountChange, notifySessionExpired, sendDiscountDigest, THRESHOLD };
