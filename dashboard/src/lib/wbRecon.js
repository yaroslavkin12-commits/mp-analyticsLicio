// Заголовки старых и новых выгрузок детализации WB. Суммы читаются в браузере.
const columns = {
  date: ['Дата продажи', 'Дата операции'],
  offer: ['Артикул поставщика', 'Артикул продавца'],
  type: ['Тип документа'],
  operation: ['Обоснование для оплаты'],
  reason: ['Виды логистики, штрафов и корректировок', 'Виды логистики, штрафов и доплат', 'Расшифровка удержания'],
  gross: ['Цена розничная с учетом согласованной скидки'],
  pay: ['К перечислению продавцу за реализованный товар'],
  acquiring: ['Компенсация платежных услуг', 'Эквайринг'],
  logistics: ['Услуги по доставке товара покупателю'],
  storage: ['Хранение'],
  deduction: ['Прочие удержания', 'Удержания'],
  penalty: ['Общая сумма штрафов', 'Штрафы'],
  acceptance: ['Платная приемка', 'Операции на приемке'],
  additional: ['Доплаты'],
  cashback: ['Сумма удержанная за начисленные баллы программы лояльности', 'Сумма удержанная за начисленные баллы', 'Сумма удержанная за начисленный кешбэк'],
  loyalty: ['Стоимость участия в программе лояльности'],
  cashbackDiscount: ['Компенсация скидки по программе лояльности'],
  schedule: ['Разовое изменение срока перечисления денежных средств'],
};
const clean = value => String(value ?? '').trim().toLowerCase().replaceAll('ё', 'е').replace(/[\s\u00a0]+/g, ' ');
const lookup = (header, variants) => header.findIndex(value => variants.some(alias => value.startsWith(clean(alias))));

function readAmount(value, field) {
  if (value == null || value === '' || value === '—') return 0;
  const numeric = Number(String(value).replace(/\s/g, '').replace(',', '.').replace('−', '-'));
  if (!Number.isFinite(numeric)) throw new Error('Не удалось прочитать сумму в колонке «' + columns[field][0] + '»');
  return numeric;
}

export function parseWbReport(sheets, dateOf) {
  const rows = [];
  let found = false;
  for (const matrix of sheets) {
    const headers = matrix.map(row => row.map(clean));
    const offset = headers.findIndex(h => lookup(h, columns.pay) >= 0 && lookup(h, columns.operation) >= 0);
    if (offset < 0) continue;
    found = true;
    const indices = Object.fromEntries(Object.entries(columns).map(([key, values]) => [key, lookup(headers[offset], values)]));
    if (['date', 'type', 'operation', 'offer', 'gross'].some(key => indices[key] < 0)) {
      throw new Error('В файле WB нет нужных колонок детализации: дата, артикул, тип документа и цена со скидкой');
    }
    for (const row of matrix.slice(offset + 1)) {
      const text = key => String(row[indices[key]] ?? '').trim();
      if (!text('operation')) continue;
      const d = dateOf(row[indices.date]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('В строке отчёта WB отсутствует дата операции');
      const art = text('offer'), type = text('operation'), sign = clean(text('type')) === 'возврат' ? -1 : 1;
      const value = key => readAmount(row[indices[key]], key);
      const put = (b, amount) => { if (amount) rows.push({ d, art, b, type, group: 'Реализация WB', amount }); };
      if (/^(продажа|возврат)$/i.test(type)) {
        const gross = sign * value('gross'), acquiring = sign * value('acquiring');
        put(sign > 0 ? 'sale' : 'return', gross);
        put('commission', sign * value('pay') - gross + acquiring);
        put('acquiring', -acquiring);
      } else put('other', sign * value('pay'));
      put('logistics', -value('logistics'));
      put('storage', -value('storage'));
      put(/WB Продвижение/i.test(text('reason')) ? 'ads' : 'other', -value('deduction'));
      put('other', -value('penalty') - value('acceptance') - value('additional') - sign * value('cashback') -
        sign * value('loyalty') - value('schedule') + sign * value('cashbackDiscount'));
    }
  }
  if (!found) throw new Error('Выберите XLSX с детализацией отчёта реализации WB');
  if (!rows.length) throw new Error('В детализации WB нет денежных операций');
  const dates = rows.map(row => row.d).sort();
  return { rows, from: dates[0], to: dates.at(-1) };
}
