// Кабинеты (юрлица/магазины) — задел на мультитенантность. Пока полноценно
// разведена только реклама (см. collectors/ads/*), Дашборд и Остатки
// по-прежнему работают только с "родными" переменными окружения (Licio),
// но структура готова к тому, чтобы позже завести туда и Defly.
//
// Токены Defly — это ДВА разных API Ozon:
//  - Seller API (Client-Id + Api-Key)      — тот же тип ключа, что уже
//    используется для Licio (остатки/заказы/аналитика).
//  - Performance API (Client-Id + Client-Secret) — отдельный OAuth-токен
//    именно для рекламного кабинета (расходы, ставки, статистика по кампаниям).

const CABINETS = {
  licio: {
    label: 'Licio',
    ozonClientId: process.env.OZON_CLIENT_ID || null,
    ozonApiKey: process.env.OZON_API_KEY || null,
    ozonPerfClientId: process.env.OZON_PERF_CLIENT_ID || null,
    ozonPerfSecret: process.env.OZON_PERF_SECRET || null,
    // Сессия кабинета seller.ozon.ru (не Seller API!) — нужна только для
    // получения реальной цены на витрине с учётом Соинвеста Ozon, которую
    // публичный Seller API не отдаёт (см. collectors/ads/ozonInternalPrices.js).
    ozonSellerCookie: process.env.OZON_SELLER_COOKIE || null,
    ozonCompanyId: process.env.OZON_COMPANY_ID || null,
  },
  defly: {
    label: 'Defly',
    ozonClientId: process.env.DEFLY_OZON_CLIENT_ID || null,
    ozonApiKey: process.env.DEFLY_OZON_API_KEY || null,
    ozonPerfClientId: process.env.DEFLY_OZON_PERF_CLIENT_ID || null,
    ozonPerfSecret: process.env.DEFLY_OZON_PERF_SECRET || null,
    ozonSellerCookie: process.env.DEFLY_OZON_SELLER_COOKIE || null,
    ozonCompanyId: process.env.DEFLY_OZON_COMPANY_ID || null,
  },
};

function listCabinets() {
  return Object.entries(CABINETS).map(([id, c]) => ({
    id,
    label: c.label,
    ozonSellerConfigured: !!(c.ozonClientId && c.ozonApiKey),
    ozonPerfConfigured: !!(c.ozonPerfClientId && c.ozonPerfSecret),
    ozonSessionConfigured: !!(c.ozonSellerCookie && c.ozonCompanyId),
  }));
}

function getCabinet(id) {
  const cfg = CABINETS[id];
  if (!cfg) throw new Error(`Неизвестный кабинет: ${id}`);
  return cfg;
}

module.exports = { CABINETS, listCabinets, getCabinet };
