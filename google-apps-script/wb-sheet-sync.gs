// Wildberries → Google-таблица → сервис (как ozon-sheet-sync.gs для Ozon).
// Этап 0: проверка доступа к API WB. Ключ — ТОЛЬКО в свойствах скрипта:
//   Настройки проекта → Свойства скрипта → WB_TOKEN = <токен «только чтение»>
//   CABINET_ID = defly_wb (для других магазинов — alex_wb, nab_wb …)
// Никуда больше токен не вставляйте и никому не пересылайте.

function wbToken_() {
  const t = PropertiesService.getScriptProperties().getProperty('WB_TOKEN');
  if (!t) throw new Error('Нет WB_TOKEN в свойствах скрипта (Настройки проекта → Свойства скрипта)');
  return t.trim();
}
function wbCabinet_() {
  return PropertiesService.getScriptProperties().getProperty('CABINET_ID') || 'defly_wb';
}
function ymd_(daysAgo) {
  return Utilities.formatDate(new Date(Date.now() - daysAgo * 86400000), 'Europe/Moscow', 'yyyy-MM-dd');
}

// Запрос к API WB: текст ответа и код, без исключений (для проверки).
function wbRaw_(method, url, body) {
  const opt = { method: method, headers: { Authorization: wbToken_() }, muteHttpExceptions: true };
  if (body !== undefined) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  const r = UrlFetchApp.fetch(url, opt);
  return { code: r.getResponseCode(), text: r.getContentText() };
}

// Кратко описать ответ: верхние ключи, длину списка и первую запись.
function shape_(text) {
  try {
    const d = JSON.parse(text);
    const arr = Array.isArray(d) ? d : (d.data && Array.isArray(d.data) ? d.data
      : d.data && typeof d.data === 'object' ? (d.data.cards || d.data.listGoods || d.data.products || d.data.items || null)
      : d.cards || d.adverts || d.items || null);
    const keys = Array.isArray(d) ? '[массив]' : Object.keys(d).join(',');
    const sub = d.data && !Array.isArray(d.data) && typeof d.data === 'object' ? ' / data: ' + Object.keys(d.data).join(',') : '';
    return 'ключи: ' + keys + sub + (arr ? ' | записей ' + arr.length + (arr[0] ? ' | пример: ' + JSON.stringify(arr[0]).slice(0, 500) : '') : '');
  } catch (e) { return 'не JSON: ' + text.slice(0, 200); }
}

// Этап 0: пройти по всем нужным методам и записать в журнал, что отвечает.
// Запустить вручную (Выполнить → probeWb), прислать скрин «Журнала выполнения».
function probeWb() {
  const from = ymd_(2), to = ymd_(1), from7 = ymd_(8);
  const checks = [
    ['Статистика · заказы', 'get', 'https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=' + from],
    ['Статистика · продажи', 'get', 'https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=' + from],
    ['Статистика · отчёт о реализации', 'get', 'https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod?dateFrom=' + from7 + '&dateTo=' + to + '&limit=5'],
    ['Статистика · остатки (старый)', 'get', 'https://statistics-api.wildberries.ru/api/v1/supplier/stocks?dateFrom=' + ymd_(30)],
    ['Аналитика · воронка v3', 'post', 'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products',
      { selectedPeriod: { start: from, end: to }, limit: 5, offset: 0 }],
    ['Аналитика · воронка v2 (старый)', 'post', 'https://seller-analytics-api.wildberries.ru/api/v2/nm-report/detail',
      { period: { begin: from + ' 00:00:00', end: to + ' 23:59:59' }, page: 1 }],
    ['Продвижение · кампании', 'get', 'https://advert-api.wildberries.ru/adv/v1/promotion/count'],
    ['Продвижение · история затрат', 'get', 'https://advert-api.wildberries.ru/adv/v1/upd?from=' + from7 + '&to=' + to],
    ['Контент · карточки', 'post', 'https://content-api.wildberries.ru/content/v2/get/cards/list',
      { settings: { cursor: { limit: 3 }, filter: { withPhoto: -1 } } }],
    ['Цены и скидки', 'get', 'https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?limit=3&offset=0'],
    ['Маркетплейс · склады продавца', 'get', 'https://marketplace-api.wildberries.ru/api/v3/warehouses'],
    ['Тарифы · комиссии', 'get', 'https://common-api.wildberries.ru/api/v1/tariffs/commission?locale=ru'],
  ];
  Logger.log('Кабинет: ' + wbCabinet_() + ' · период ' + from + ' — ' + to);
  checks.forEach(function (c) {
    try {
      const r = wbRaw_(c[1], c[2], c[3]);
      Logger.log(c[0] + ': HTTP ' + r.code + ' | ' + (r.code === 200 ? shape_(r.text) : r.text.slice(0, 300)));
    } catch (e) {
      Logger.log(c[0] + ': ' + e.message);
    }
    Utilities.sleep(1200); // у WB строгие лимиты запросов
  });
  // Детальная статистика по одной РК — какие поля приходят (виды РК, зоны, оплата).
  try {
    const cnt = JSON.parse(wbRaw_('get', 'https://advert-api.wildberries.ru/adv/v1/promotion/count').text);
    const ids = [];
    (cnt.adverts || []).forEach(function (g) { (g.advert_list || []).forEach(function (a) { if (ids.length < 3) ids.push(a.advertId); }); });
    Logger.log('РК (типы/статусы): ' + JSON.stringify((cnt.adverts || []).map(function (g) { return { type: g.type, status: g.status, n: g.count }; })));
    if (ids.length) {
      Utilities.sleep(1200);
      const info = wbRaw_('post', 'https://advert-api.wildberries.ru/adv/v1/promotion/adverts', ids);
      Logger.log('Продвижение · параметры РК: HTTP ' + info.code + ' | ' + info.text.slice(0, 900));
      Utilities.sleep(1200);
      const st3 = wbRaw_('get', 'https://advert-api.wildberries.ru/adv/v3/fullstats?ids=' + ids.join(',') + '&beginDate=' + from7 + '&endDate=' + to);
      Logger.log('Продвижение · статистика v3: HTTP ' + st3.code + ' | ' + st3.text.slice(0, 900));
    }
  } catch (e) { Logger.log('Продвижение · детали: ' + e.message); }
}
