const axios = require('axios');
const { getCabinet } = require('./config/cabinets');
const { query } = require('./db');

// Уведомления в Telegram об изменении Соинвеста Ozon. Настройка через
// переменные окружения (одна и та же пара для всех кабинетов):
//   TELEGRAM_BOT_TOKEN — токен бота от @BotFather
//   TELEGRAM_CHAT_ID   — id чата/канала, куда слать сообщения (можно узнать
//                        через @userinfobot или API-метод getUpdates)
// Порог срабатывания — TELEGRAM_DISCOUNT_THRESHOLD (п.п., по умолчанию 1.5).

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
  const significant = changed.filter(c => Math.abs(c.pct - c.prevPct) >= THRESHOLD);
  if (!significant.length) return;

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

module.exports = { sendMessage, notifyDiscountChange, THRESHOLD };
