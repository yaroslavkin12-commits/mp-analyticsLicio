// Wildberries → Google-таблица → сервис (как ozon-sheet-sync.gs для Ozon).
// Рабочий сбор и отдельная диагностика доступа. Финансы загружаются отдельно. Ключ — ТОЛЬКО в свойствах скрипта:
//   Настройки проекта → Свойства скрипта → WB_TOKEN = <токен «только чтение»>
//   CABINET_ID = defly_wb (для других магазинов — alex_wb, nab_wb …)
// Доступы: Статистика, Аналитика, Продвижение, Контент, Цены и скидки,
// Маркетплейс, Финансы. Только чтение, не тестовый контур.
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

// Этап 1: рабочий сбор Defly WB БЕЗ финансов → открытая Google-таблица → Render.
// Render Environment: ADS_SHEET_ID_DEFLY_WB = ID этой таблицы между /d/ и /edit.
// WB_TOKEN остаётся только в свойствах скрипта. WB_SYNC_SECRET не нужен.
// После вставки: setupWbTriggers(), syncWbRecent(), syncWbDaily(), syncWbAds().
// Каждый запуск независим; заказы/продажи сначала забираются за 90 дней.
var WB_JOB_STARTED = 0;
function wbCheckTime_() { if (Date.now() - WB_JOB_STARTED > 265000) throw new Error('Заканчивается время запуска; прежние данные сохранены. Повторите сбор.'); }
function wbFetch_(method, url, body, statistics) {
  wbCheckTime_();
  var props = PropertiesService.getScriptProperties(), key = statistics ? 'WB_STAT_LAST' : null;
  if (key) { var wait = Number(props.getProperty(key) || 0) + 61000 - Date.now(); if (wait > 0) { if (Date.now() + wait - WB_JOB_STARTED > 265000) throw new Error('Лимит времени WB: повторите сбор'); Utilities.sleep(wait); } props.setProperty(key, String(Date.now())); }
  var r = wbRaw_(method, url, body);
  if (r.code === 204) return [];
  if (r.code !== 200) throw new Error('WB HTTP ' + r.code + ' · ' + r.text.slice(0, 250));
  return r.text.trim() && r.text.trim() !== 'null' ? JSON.parse(r.text) : [];
}
function wbLock_(name, fn) {
  var lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) { Logger.log('Уже идёт сбор WB, следующий запуск по расписанию.'); return; }
  WB_JOB_STARTED = Date.now();
  try { if (SpreadsheetApp.getActiveSpreadsheet().getId() !== '13_54MPKRjkSz49DmDhV5eA4Q0SJoPgAPwXnikKBqoHs') throw new Error('Скрипт должен быть привязан к таблице WB Defly'); if (wbCabinet_() !== 'defly_wb') throw new Error('Эта версия подключает только defly_wb'); fn(); }
  finally { lock.releaseLock(); }
}
function wbSheet_(kind) { var book = SpreadsheetApp.getActiveSpreadsheet(), name = 'WB_' + kind; return book.getSheetByName(name) || book.insertSheet(name); }
function wbRead_(kind) {
  var s = wbSheet_(kind); if (s.getLastRow() < 2) return [];
  var values = s.getRange(2, 1, s.getLastRow() - 1, 2).getValues();
  return values.filter(function (r) { return r[0] && r[1]; }).map(function (r) { return JSON.parse(r[1]); });
}
function wbSave_(kind, rows, from, to, warning, sourceAt) {
  var ids = {}; rows.forEach(function (r) { if (!r.id || ids[r.id]) throw new Error('Нет идентификатора или повтор WB: ' + r.id); ids[r.id] = true; });
  var run = Utilities.getUuid(), collectedAt = sourceAt || new Date().toISOString();
  var metadata = { cabinet: wbCabinet_(), kind: kind, runId: run, collectedAt: collectedAt, from: from || null, to: to || null, total: rows.length, warning: warning || '' };
  var sheet = wbSheet_(kind), values = [['id', 'payload', 'run_id']].concat(rows.map(function (r) { var text = JSON.stringify(r); if (text.length > 49000) throw new Error('Слишком большая строка WB'); return [r.id, text, run]; }));
  if (sheet.getMaxRows() < values.length) sheet.insertRowsAfter(sheet.getMaxRows(), values.length - sheet.getMaxRows());
  sheet.getRange(1, 1, values.length, 3).setNumberFormat('@').setValues(values);
  if (sheet.getLastRow() > values.length) sheet.getRange(values.length + 1, 1, sheet.getLastRow() - values.length, 3).clearContent();
  SpreadsheetApp.flush();
  PropertiesService.getScriptProperties().setProperty('WB_META_' + kind, JSON.stringify(metadata));
  wbStatus_(metadata);
  Logger.log('WB ' + kind + ': сохранено в таблицу ' + rows.length + ' строк');
}
function wbStatus_(meta) {
  var sheet = wbSheet_('status'), header = ['cabinet', 'kind', 'run_id', 'collected_at', 'from', 'to', 'total', 'warning'];
  var rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).getValues().filter(function (r) { return r[0] && !(r[0] === meta.cabinet && r[1] === meta.kind); }) : [];
  rows.push([meta.cabinet, meta.kind, meta.runId, meta.collectedAt, meta.from || '', meta.to || '', meta.total, meta.warning || '']);
  var values = [header].concat(rows);
  if (sheet.getMaxRows() < values.length) sheet.insertRowsAfter(sheet.getMaxRows(), values.length - sheet.getMaxRows());
  sheet.getRange(1, 1, values.length, 8).setNumberFormat('@').setValues(values);
  if (sheet.getLastRow() > values.length) sheet.getRange(values.length + 1, 1, sheet.getLastRow() - values.length, 8).clearContent();
  SpreadsheetApp.flush();
}
// Повторная публикация уже собранных вкладок: API WB повторно не вызывается.
function resendWbData() { wbLock_('resend', function () { ['catalog', 'orders', 'sales', 'stocks', 'campaigns', 'ads', 'prices', 'finance'].forEach(function (kind) { var meta = PropertiesService.getScriptProperties().getProperty('WB_META_' + kind); if (meta) { var m = JSON.parse(meta); wbSave_(kind, wbRead_(kind), m.from, m.to, m.warning, m.collectedAt); } }); }); }
function wbMeta_(kind) { try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('WB_META_' + kind) || 'null'); } catch (e) { return null; } }
function wbNumber_(v) { return v === undefined || v === null || v === '' || !isFinite(Number(v)) ? null : Number(v); }
function wbStats_(kind) {
  var old = wbRead_(kind), previous = wbMeta_(kind), floor = ymd_(89), from = previous ? ymd_(3) : floor;
  if (previous && previous.to && previous.to < from) from = previous.to < floor ? floor : previous.to;
  var map = {}; old.forEach(function (r) { map[r.id] = r; });
  var cursor = from + 'T00:00:00', last = '', page = 0;
  while (true) {
    var batch = wbFetch_('get', 'https://statistics-api.wildberries.ru/api/v1/supplier/' + kind + '?dateFrom=' + encodeURIComponent(cursor) + '&flag=0', undefined, true);
    if (!Array.isArray(batch)) throw new Error('Неверный ответ статистики WB');
    if (!batch.length) break;
    batch.forEach(function (r) {
      var id = kind === 'orders' ? r.srid : r.saleID;
      if (!id) throw new Error('WB не прислал идентификатор строки ' + kind);
      map[String(id)] = { id: String(id), date: String(r.date || '').slice(0, 10), at: r.date || null, changed: r.lastChangeDate || '', nmId: r.nmId, offer: r.supplierArticle || '', name: r.subject || '', price: Number(r.priceWithDisc) > 0 ? wbNumber_(r.priceWithDisc) : null, customerPrice: Number(r.finishedPrice) > 0 ? wbNumber_(r.finishedPrice) : null, warehouse: r.warehouseName || '', warehouseType: r.warehouseType || '', region: r.regionName || r.oblast || '', cancelled: r.isCancel === true, cancelDate: r.cancelDate || r.cancel_dt || '', type: kind === 'sales' ? (/^S/.test(String(id)) ? 'sale' : /^R/.test(String(id)) ? 'return' : 'unknown') : 'order', srid: r.srid || '' };
    });
    last = String(batch[batch.length - 1].lastChangeDate || '');
    if (!last || last === cursor || ++page > 8) throw new Error('WB не продвигает курсор статистики; неполный набор не отправлен');
    cursor = last;
  }
  // Окно покрытия не расширяется назад без полного первоначального сбора.
  var coverageFrom = previous && previous.to >= floor ? previous.from : floor;
  if (coverageFrom < ymd_(399)) coverageFrom = ymd_(399);
  // При пропуске более 3 дней запрашиваем с последней успешной даты (не старше 90 дней).
  var rows = Object.keys(map).map(function (k) { return map[k]; }).filter(function (r) { return r.date >= ymd_(399); });
  wbSave_(kind, rows, coverageFrom, ymd_(0));
}
function syncWbRecent() { wbLock_('recent', function () { ['orders', 'sales'].forEach(function (kind) { try { wbStats_(kind); } catch (e) { Logger.log('WB ' + kind + ': ' + e.message); } }); }); }
function wbCatalog_() {
  var rows = [], cursor = { limit: 100 };
  for (var page = 0; page < 100; page++) {
    var data = wbFetch_('post', 'https://content-api.wildberries.ru/content/v2/get/cards/list', { settings: { cursor: cursor, filter: { withPhoto: -1 } } });
    if (!Array.isArray(data.cards)) throw new Error('WB не прислал каталог');
    data.cards.forEach(function (r) { rows.push({ id: String(r.nmID), nmId: r.nmID, imtId: r.imtID || null, created: r.createdAt || null, offer: r.vendorCode || '', name: r.title || '', brand: r.brand || '', sizes: (r.sizes || []).map(function (s) { return { chrtId: s.chrtID, skus: s.skus || [] }; }) }); });
    if (data.cards.length < 100) { wbSave_('catalog', rows); return; }
    if (!data.cursor || !data.cursor.updatedAt || !data.cursor.nmID || JSON.stringify(cursor) === JSON.stringify(data.cursor)) throw new Error('Некорректный курсор каталога WB');
    cursor = { limit: 100, updatedAt: data.cursor.updatedAt, nmID: data.cursor.nmID }; Utilities.sleep(700);
  }
  throw new Error('Каталог WB слишком большой для одного запуска');
}
function wbPrices_() {
  var rows = [], offset = 0;
  for (var page = 0; page < 100; page++) {
    var data = wbFetch_('get', 'https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?limit=1000&offset=' + offset);
    if (!data.data || !Array.isArray(data.data.listGoods)) throw new Error('WB не прислал цены');
    data.data.listGoods.forEach(function (r) { var prices = (r.sizes || []).map(function (s) { return wbNumber_(s.discountedPrice); }).filter(function (p) { return p !== null; }); rows.push({ id: String(r.nmID), nmId: r.nmID, offer: r.vendorCode || '', price: prices.length ? Math.min.apply(null, prices) : null }); });
    if (data.data.listGoods.length < 1000) { wbSave_('prices', rows); return; } offset += 1000; Utilities.sleep(700);
  }
  throw new Error('Слишком большой список цен WB');
}
function wbStocks_() {
  if (!wbMeta_('catalog')) throw new Error('Сначала успешно загрузите каталог WB');
  var rows = [], offset = 0, catalog = wbRead_('catalog'), byNm = {}, barcodes = [], byBarcode = {};
  catalog.forEach(function (r) { byNm[String(r.nmId)] = r; (r.sizes || []).forEach(function (s) { (s.skus || []).forEach(function (b) { if (!byBarcode[String(b)]) { barcodes.push(String(b)); byBarcode[String(b)] = r; } }); }); });
  for (var page = 0; page < 100; page++) {
    var data = wbFetch_('post', 'https://seller-analytics-api.wildberries.ru/api/analytics/v1/stocks-report/wb-warehouses', { nmIds: [], limit: 10000, offset: offset });
    var items = Array.isArray(data) && !data.length ? [] : data.data && data.data.items;
    if (!Array.isArray(items)) throw new Error('WB не прислал остатки');
    items.forEach(function (r) { rows.push({ id: ['wb', r.nmId, r.chrtId, r.warehouseId].join('|'), nmId: r.nmId, offer: byNm[String(r.nmId)]?.offer || '', scheme: 'wb', warehouse: r.warehouseName || String(r.warehouseId), quantity: wbNumber_(r.quantity), toClient: wbNumber_(r.inWayToClient), fromClient: wbNumber_(r.inWayFromClient) }); });
    if (items.length < 10000) break; offset += 10000; Utilities.sleep(21000);
    if (page === 99) throw new Error('Неполный список остатков WB');
  }
  var warehouses = wbFetch_('get', 'https://marketplace-api.wildberries.ru/api/v3/warehouses');
  if (!Array.isArray(warehouses)) throw new Error('WB не прислал склады продавца');
  warehouses.forEach(function (w) { for (var i = 0; i < barcodes.length; i += 1000) { var data = wbFetch_('post', 'https://marketplace-api.wildberries.ru/api/v3/stocks/' + w.id, { skus: barcodes.slice(i, i + 1000) }); if (!Array.isArray(data.stocks)) throw new Error('Не получены остатки склада продавца ' + w.id); data.stocks.forEach(function (s) { var product = byBarcode[String(s.sku)] || {}; rows.push({ id: ['seller', w.id, s.sku].join('|'), nmId: product.nmId, offer: product.offer || '', scheme: 'seller', warehouse: w.name || String(w.id), quantity: wbNumber_(s.amount), toClient: 0, fromClient: 0 }); }); Utilities.sleep(400); } });
  wbSave_('stocks', rows);
}
function syncWbDaily() { wbLock_('daily', function () { [wbCatalog_, wbPrices_, wbStocks_].forEach(function (fn) { try { fn(); } catch (e) { Logger.log('WB справочники: ' + e.message); } }); }); }
function syncWbAds() { wbLock_('ads', function () {
  var from = ymd_(13), to = ymd_(0), count = wbFetch_('get', 'https://advert-api.wildberries.ru/adv/v1/promotion/count');
  if (!Array.isArray(count.adverts)) throw new Error('WB не прислал список кампаний');
  var costs = wbFetch_('get', 'https://advert-api.wildberries.ru/adv/v1/upd?from=' + from + '&to=' + to), spend = {}, campaigns = [], candidates = [];
  (Array.isArray(costs) ? costs : []).forEach(function (r) { spend[String(r.advertId)] = (spend[String(r.advertId)] || 0) + (Number(r.updSum) || 0); });
  count.adverts.forEach(function (g) { (g.advert_list || []).forEach(function (r) { var c = { id: String(r.advertId), name: 'РК ' + r.advertId, type: Number(g.type), status: Number(g.status) }; campaigns.push(c); if ([8, 9].indexOf(c.type) >= 0 && ([9, 11].indexOf(c.status) >= 0 || c.status === 7 && (spend[c.id] > 0 || String(r.changeTime || '').slice(0, 10) >= from))) candidates.push(c.id); }); });
  var all = {}, oldMeta = wbMeta_('ads'); wbRead_('ads').forEach(function (r) { if (r.date < from) all[r.id] = r; });
  for (var i = 0; i < candidates.length; i += 50) {
    var ids = candidates.slice(i, i + 50), info = wbFetch_('get', 'https://advert-api.wildberries.ru/api/advert/v2/adverts?ids=' + ids.join(','));
    if (!Array.isArray(info.adverts)) throw new Error('WB не прислал параметры кампаний');
    info.adverts.forEach(function (r) { var c = campaigns.find(function (c) { return c.id === String(r.id); }); if (c) { c.name = r.settings?.name || c.name; c.payment = r.settings?.payment_type || ''; c.bidType = r.bid_type || null; c.nmIds = (r.nm_settings || []).map(function(n){ return n.nm_id; }); c.search = r.settings?.placements?.search === true; c.recommendations = r.settings?.placements?.recommendations === true; } });
    var stats = wbFetch_('get', 'https://advert-api.wildberries.ru/adv/v3/fullstats?ids=' + ids.join(',') + '&beginDate=' + from + '&endDate=' + to);
    if (!Array.isArray(stats)) throw new Error('WB не прислал статистику рекламы');
    stats.forEach(function (c) { (c.days || []).forEach(function (d) {
      var date = String(d.date).slice(0, 10), id = [c.advertId, date].join('|');
      all[id] = { id: id, campaign: String(c.advertId), date: date, scope: 'campaign', spend: wbNumber_(d.sum), views: wbNumber_(d.views), clicks: wbNumber_(d.clicks), orders: wbNumber_(d.orders), orderRub: wbNumber_(d.sum_price), atbs: wbNumber_(d.atbs) };
      (d.apps || []).forEach(function (app) { (app.nms || []).forEach(function (n) { var key = id + '|' + n.nmId, a = all[key]; if (!a) a = all[key] = { id: key, campaign: String(c.advertId), date: date, scope: 'sku', nmId: n.nmId, name: n.name || '', spend: 0, views: 0, clicks: 0, orders: 0, orderRub: 0, atbs: 0 }; [['spend', 'sum'], ['views', 'views'], ['clicks', 'clicks'], ['orders', 'orders'], ['orderRub', 'sum_price'], ['atbs', 'atbs']].forEach(function (p) { var v = wbNumber_(n[p[1]]); a[p[0]] = a[p[0]] === null || v === null ? null : a[p[0]] + v; }); }); });
    }); (c.boosterStats || []).forEach(function(p){var a=all[[c.advertId,String(p.date).slice(0,10),p.nm].join('|')];if(a)a.position=wbNumber_(p.avg_position);}); });
    if (i + 50 < candidates.length) Utilities.sleep(61000);
  }
  wbSave_('campaigns', campaigns);
  var legacy = campaigns.some(function (c) { return [8, 9].indexOf(c.type) < 0 && ([9, 11].indexOf(c.status) >= 0 || spend[c.id] > 0); });
  wbSave_('ads', Object.keys(all).map(function (id) { return all[id]; }).filter(function (r) { return r.date >= ymd_(399); }), oldMeta && oldMeta.to >= from ? oldMeta.from : from, to, legacy ? 'Активные кампании старых типов не поддерживаются fullstats v3; расходы могут быть неполными.' : '');
}); }
// Финансовый отчёт WB: отдельный сбор. Денежные строки не преобразуем в Number.
// Публикуем WB_finance и его статус только после HTTP 204 (все страницы получены).
var WB_FINANCE_FIELDS = ['reportId','rrdId','dateFrom','dateTo','createDate','currency','reportType','nmId','vendorCode','title','sku','docTypeName','sellerOperName','bonusTypeName','quantity','orderDt','saleDt','rrDate','retailPrice','retailAmount','retailPriceWithDisc','commissionPercent','ppvzSalesCommission','forPay','ppvzReward','acquiringFee','vw','vwNds','deliveryAmount','returnAmount','deliveryService','penalty','additionalPayment','rebillLogisticCost','paidStorage','deduction','paidAcceptance','installmentCofinancingAmount','cashbackAmount','cashbackDiscount','cashbackCommissionChange','paymentSchedule','deliveryMethod','srid'];
// Проверка состава ответа: без токена, сумм и реквизитов контрагентов в журнале.
function probeWbFinanceFields() {
  var r = wbRaw_('post', 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed', {dateFrom:ymd_(90),dateTo:ymd_(1),period:'daily',limit:10000,rrdId:0,fields:WB_FINANCE_FIELDS});
  Logger.log('Поля финансов WB: HTTP '+r.code+'; bonusTypeName запрошен: '+(WB_FINANCE_FIELDS.indexOf('bonusTypeName')>=0));
  if(r.code!==200)return;
  var rows=JSON.parse(r.text); if(!Array.isArray(rows))throw new Error('Ожидался массив финансов WB');
  var deductions=rows.filter(function(x){return Number(x.deduction)!==0 && x.deduction!=null;});
  Logger.log('Строк: '+rows.length+'; с полем bonusTypeName: '+rows.filter(function(x){return Object.prototype.hasOwnProperty.call(x,'bonusTypeName');}).length+'; удержаний: '+deductions.length);
  Logger.log('Поля ответа: '+Object.keys(rows[0]||{}).join(', '));
  Logger.log('Поля удержания: '+Object.keys(deductions[0]||{}).join(', '));
  Logger.log('Пояснения удержаний: '+JSON.stringify(deductions.slice(0,20).map(function(x){return x.bonusTypeName===undefined?null:x.bonusTypeName;})));
}
function wbFinanceId_(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('WB прислал неточный идентификатор финансов');
  var s = String(value); if (!/^[1-9]\d*$/.test(s)) throw new Error('WB прислал неверный идентификатор финансов'); return s;
}
function wbFinanceParse_(text) {
  // reportId может превышать MAX_SAFE_INTEGER. Кавычки ставим до JSON.parse.
  var raw = String(text).replace(/("(?:reportId|rrdId)"\s*:\s*)(\d+)(?=\s*[,}])/g, '$1"$2"');
  var rows = JSON.parse(raw); if (!Array.isArray(rows) || !rows.length) throw new Error('Ожидался массив финансов WB. Конец отчёта подтверждается только HTTP 204');
  return rows.map(function (r) {
    var result = {}; WB_FINANCE_FIELDS.forEach(function (k) { if (r[k] !== undefined) result[k] = r[k]; });
    result.reportId = wbFinanceId_(r.reportId); result.rrdId = wbFinanceId_(r.rrdId); result.id = result.reportId + '|' + result.rrdId;
    return result;
  });
}
function wbFinanceRequest_(job) {
  var props = PropertiesService.getScriptProperties(), wait = Number(props.getProperty('WB_FINANCE_LAST') || 0) + 61000 - Date.now();
  if (wait > 0) { if (Date.now() + wait - WB_JOB_STARTED > 240000) return null; Utilities.sleep(wait); }
  wbCheckTime_(); props.setProperty('WB_FINANCE_LAST', String(Date.now()));
  var body = {dateFrom:job.from+'T00:00:00+03:00',dateTo:job.to+'T23:59:59+03:00',period:'daily',limit:10000,rrdId:job.cursor,fields:WB_FINANCE_FIELDS};
  // В запросе нужен JSON integer, но курсор в памяти хранится точной строкой.
  var payload = JSON.stringify(body).replace(/"rrdId":"(\d+)"/, '"rrdId":$1');
  var response = UrlFetchApp.fetch('https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed', {method:'post',contentType:'application/json',headers:{Authorization:wbToken_()},payload:payload,muteHttpExceptions:true});
  var code = response.getResponseCode();
  if (code === 204) return {done:true};
  if (code !== 200) throw new Error('Финансы WB: HTTP '+code+'. Полученные страницы сохранены, прежний отчёт не изменён. '+(code===401||code===403?'Проверьте WB_TOKEN и доступ «Финансы».':code===429?'Лимит WB — повторите syncWbFinance позже.':''));
  return {done:false,rows:wbFinanceParse_(response.getContentText())};
}
function wbFinanceStage_(job, rows) {
  var s = wbSheet_('finance_pending'), values = [['id','payload','run_id']].concat(rows.map(function(r){return [r.id,JSON.stringify(r),job.runId];}));
  if (s.getMaxRows() < values.length) s.insertRowsAfter(s.getMaxRows(),values.length-s.getMaxRows());
  s.getRange(1,1,values.length,3).setNumberFormat('@').setValues(values);
  if (s.getLastRow()>values.length) s.getRange(values.length+1,1,s.getLastRow()-values.length,3).clearContent();
  SpreadsheetApp.flush();
}
function syncWbFinance() { wbLock_('finance',function(){
  var props = PropertiesService.getScriptProperties(), saved=props.getProperty('WB_FINANCE_JOB'), job=saved?JSON.parse(saved):null;
  if (!job || Date.now()-job.startedAt>86400000) {
    job={runId:Utilities.getUuid(),from:ymd_(90),to:ymd_(1),cursor:'0',startedAt:Date.now()};
    wbFinanceStage_(job,[]); props.setProperty('WB_FINANCE_JOB',JSON.stringify(job));
  }
  if(!/^\d+$/.test(job.cursor)) throw new Error('Неверный курсор финансов WB');
  var stage=wbSheet_('finance_pending'), raw=stage.getLastRow()>1?stage.getRange(2,1,stage.getLastRow()-1,3).getValues():[];
  if(raw.some(function(r){return r[0]&&r[2]!==job.runId;}))throw new Error('Незавершённые страницы финансов относятся к другой загрузке');
  var map={}; raw.forEach(function(r){if(r[0]&&r[1])map[r[0]]=JSON.parse(r[1]);});
  for(var page=0;page<3;page++) {
    var result=wbFinanceRequest_(job); if(!result)break;
    if(result.done) {
      var rows=Object.keys(map).map(function(id){return map[id];});
      wbSave_('finance',rows,job.from,job.to,'Исходный ежедневный отчёт WB. Финансовые расчёты включаются после сверки полей.');
      props.deleteProperty('WB_FINANCE_JOB');
      Logger.log('Финансы WB: загрузка завершена. '+rows.length+' строк за '+job.from+' — '+job.to+'. Сервис заберёт WB_finance автоматически.'); return;
    }
    var next=result.rows[result.rows.length-1].rrdId;
    if(next.length<job.cursor.length||next.length===job.cursor.length&&next<=job.cursor)throw new Error('Курсор финансов WB не продвинулся. Прежний отчёт сохранён');
    result.rows.forEach(function(r){map[r.id]=r;});
    var all=Object.keys(map).map(function(id){return map[id];});if(all.length>150000)throw new Error('Отчёт WB превышает 150000 строк. Прежний отчёт сохранён');
    wbFinanceStage_(job,all); job.cursor=next; props.setProperty('WB_FINANCE_JOB',JSON.stringify(job));
    Logger.log('Финансы WB: получено '+all.length+' строк, сбор продолжается.');
  }
  Logger.log('Финансы WB: страницы сохранены, но отчёт ещё не завершён. Запустите syncWbFinance ещё раз; сбор продолжится с сохранённой страницы. Триггер тоже продолжит сбор автоматически.');
}); }

function setupWbTriggers() {
  wbLock_('setup', function () {
    var names = ['syncWbRecent', 'syncWbDaily', 'syncWbAds', 'syncWbFinance'];
    ScriptApp.getProjectTriggers().forEach(function (t) { if (names.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t); });
    ScriptApp.newTrigger('syncWbRecent').timeBased().everyMinutes(30).create();
    ScriptApp.newTrigger('syncWbDaily').timeBased().everyHours(1).create();
    ScriptApp.newTrigger('syncWbAds').timeBased().everyHours(1).create();
    ScriptApp.newTrigger('syncWbFinance').timeBased().everyHours(1).create();
    Logger.log('Триггеры WB установлены. Запустите syncWbRecent, затем syncWbDaily и syncWbAds по отдельности. Финансы собираются функцией syncWbFinance. Запустите её отдельно.');
  });
}
