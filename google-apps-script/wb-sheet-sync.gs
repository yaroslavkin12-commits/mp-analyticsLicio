// Wildberries → Google-таблица → сервис (как ozon-sheet-sync.gs для Ozon).
// Этап 0: проверка доступа к API WB. Ключ — ТОЛЬКО в свойствах скрипта:
//   Настройки проекта → Свойства скрипта → WB_TOKEN = <токен «только чтение»>
//   CABINET_ID = defly_wb (для других магазинов — alex_wb, nab_wb …)
// Доступы: Статистика, Аналитика, Продвижение, Контент, Цены и скидки,
// Маркетплейс и Финансы. Только чтение, не тестовый контур.
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
    if (d === null) return 'данных нет (null)';
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
  const from = ymd_(2), to = ymd_(1), from7 = ymd_(7);
  const results = {};
  const checks = [
    ['Статистика · заказы', 'get', 'https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=' + from],
    ['Статистика · продажи', 'get', 'https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=' + from],
    ['Финансы · отчёт реализации (новый)', 'post', 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed',
      { dateFrom: from7 + 'T00:00:00+03:00', dateTo: to + 'T23:59:59+03:00', period: 'daily', limit: 5, rrdId: 0 }],
    ['Аналитика · остатки WB (новый)', 'post', 'https://seller-analytics-api.wildberries.ru/api/analytics/v1/stocks-report/wb-warehouses',
      { nmIds: [], limit: 5, offset: 0 }],
    ['Аналитика · воронка v3', 'post', 'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products',
      { selectedPeriod: { start: from, end: to }, limit: 5, offset: 0 }],
    ['Продвижение · кампании', 'get', 'https://advert-api.wildberries.ru/adv/v1/promotion/count'],
    ['Продвижение · история затрат', 'get', 'https://advert-api.wildberries.ru/adv/v1/upd?from=' + from7 + '&to=' + to],
    ['Контент · карточки', 'post', 'https://content-api.wildberries.ru/content/v2/get/cards/list',
      { settings: { cursor: { limit: 3 }, filter: { withPhoto: -1 } } }],
    ['Цены и скидки', 'get', 'https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?limit=3&offset=0'],
    ['Маркетплейс · склады продавца', 'get', 'https://marketplace-api.wildberries.ru/api/v3/warehouses'],
    ['Тарифы · комиссии', 'get', 'https://common-api.wildberries.ru/api/v1/tariffs/commission?locale=ru'],
  ];
  Logger.log('Проверка WB · версия 29.10.2026 · кабинет: ' + wbCabinet_() + ' · период ' + from + ' — ' + to);
  Logger.log('Только проверка доступа. Регулярный сбор и запись данных ещё не запускаются.');
  checks.forEach(function (c) {
    try {
      const r = wbRaw_(c[1], c[2], c[3]);
      results[c[0]] = r;
      Logger.log(c[0] + ': HTTP ' + r.code + ' | ' + (r.code === 200 ? shape_(r.text) : r.code === 204 ? 'доступен, за этот период данных нет' : r.text.slice(0, 300)));
      if (/^Финансы/.test(c[0]) && (r.code === 401 || r.code === 403)) Logger.log('Проверьте категорию «Финансы» и тип токена: это отдельный доступ для нового финансового API.');
    } catch (e) {
      Logger.log(c[0] + ': ' + e.message);
    }
    Utilities.sleep(1200); // у WB строгие лимиты запросов
  });
  // Проверяем свежие кампании типов 8/9. Старые завершённые кампании из
  // начала списка могли давать null при HTTP 200 даже при рабочем доступе.
  try {
    const countResponse = results['Продвижение · кампании'];
    if (!countResponse || countResponse.code !== 200) { Logger.log('Продвижение · детали: список кампаний не получен, повторный запрос не делаем.'); return; }
    const cnt = JSON.parse(countResponse.text) || {};
    const costResponse = results['Продвижение · история затрат'];
    const costs = costResponse && costResponse.code === 200 ? JSON.parse(costResponse.text) : [];
    const spend = {};
    (Array.isArray(costs) ? costs : []).forEach(function (r) { spend[String(r.advertId)] = (spend[String(r.advertId)] || 0) + (Number(r.updSum) || 0); });
    const candidates = [];
    (cnt.adverts || []).forEach(function (g) {
      if ([8, 9].indexOf(Number(g.type)) < 0) return;
      (g.advert_list || []).forEach(function (a) {
        const status = Number(g.status), cost = spend[String(a.advertId)] || 0;
        if ([9, 11].indexOf(status) < 0 && !(status === 7 && cost > 0)) return;
        candidates.push({ id: a.advertId, status: status, spend: cost, changed: a.changeTime || '' });
      });
    });
    candidates.sort(function (a, b) { return Number(b.spend > 0) - Number(a.spend > 0) || Number(b.status === 9) - Number(a.status === 9) || b.spend - a.spend || String(b.changed).localeCompare(String(a.changed)); });
    const ids = [];
    candidates.forEach(function (a) { if (ids.length < 3 && ids.indexOf(a.id) < 0) ids.push(a.id); });
    Logger.log('РК (типы/статусы): ' + JSON.stringify((cnt.adverts || []).map(function (g) { return { type: g.type, status: g.status, n: g.count }; })));
    if (ids.length) {
      Logger.log('РК для проверки за ' + from7 + ' — ' + to + ': ' + ids.join(', '));
      Utilities.sleep(1200);
      const info = wbRaw_('get', 'https://advert-api.wildberries.ru/api/advert/v2/adverts?ids=' + ids.join(','));
      Logger.log('Продвижение · параметры РК: HTTP ' + info.code + ' | ' + info.text.slice(0, 900));
      Utilities.sleep(1200);
      const st3 = wbRaw_('get', 'https://advert-api.wildberries.ru/adv/v3/fullstats?ids=' + ids.join(',') + '&beginDate=' + from7 + '&endDate=' + to);
      Logger.log('Продвижение · статистика v3: HTTP ' + st3.code + ' | ' + (st3.code === 200 ? shape_(st3.text) : st3.text.slice(0, 900)));
      if (st3.code === 200 && (!st3.text.trim() || st3.text.trim() === 'null' || st3.text.trim() === '[]')) Logger.log('Запрос выполнен, но статистики по выбранным кампаниям за период нет. Это не подтверждение отсутствия доступа.');
    } else Logger.log('Продвижение · детали: нет подходящих кампаний типов 8/9 со статусом «активна», «на паузе» или недавними расходами.');
  } catch (e) { Logger.log('Продвижение · детали: ' + e.message); }
}
