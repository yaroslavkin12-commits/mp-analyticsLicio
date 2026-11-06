// Разбор выгрузок кабинета Ozon (xlsx) прямо в браузере.
//  • «Товары на Ozon» (analytics_report_*.xlsx): «Дата формирования», «Период
//    отчета: 7 дней», строки товаров со ссылкой ozon.ru/product/<SKU>;
//  • «Результаты по запросу» (explainer_report_*.xlsx): «Запрос», «Регион»,
//    таблица выдачи с колонками «Позиция», «ID товара»…;
//  • «Запросы моего товара» / «По каким запросам» — это наши запросы: они и
//    так приходят из API, загружать их не нужно.

const s = v => (v === null || v === undefined ? '' : String(v)).replace(/ | /g, ' ').trim();
// «4 049», «1,29%», «14 690 ₽», «26,84 ₽» → число; «—», «-», «Выключено» → null.
export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = s(v).replace(/[₽%\s]/g, '').replace(',', '.');
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}
const iso = (y, m, d) => {
  const Y = y < 100 ? 2000 + y : y;
  const dt = new Date(Date.UTC(Y, m - 1, d));
  return dt.getUTCFullYear() === Y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${Y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
};
// Дата из имени файла: …_2026-11-06_… или …_06-11-2026_…
function dateFromName(name) {
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(name);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /(\d{2})-(\d{2})-(\d{4})/.exec(name);
  if (m) return iso(+m[3], +m[2], +m[1]);
  return null;
}

const MARKET_COLS = {
  'Заказано на сумму, ₽': 'rev', 'Динамика оборота, %': 'revDyn', 'Заказано, штуки': 'qty', 'Средняя цена, ₽': 'avgPrice', 'Минимальная цена, ₽': 'minPrice',
  'Доля выкупа, %': 'buyout', 'Упущенные продажи': 'lost', 'Дней без остатка': 'noStock', 'Среднесуточные продажи, ₽': 'dayRev', 'Среднесуточные продажи, штуки': 'dayQty',
  'Остаток на конец периода, штуки': 'stock', 'Схема работы': 'scheme', 'Объем товара, л': 'volume', 'Показы всего': 'views', 'Просмотры в поиске и каталоге': 'searchViews',
  'Просмотры карточки': 'pdp', 'Конверсия из показа в заказ, %': 'convOrder', 'В корзину из поиска и каталога, %': 'cartSearch', 'В корзину из карточки, %': 'cartPdp',
  'Скидка от медианной цены, %': 'disc', 'Доля суммы заказов по акциям, %': 'promoShare', 'Дней в акциях': 'promoDays', 'Дней с продвижением': 'adDays',
  'Доля рекламных расходов, %': 'drr', 'Дата создания карточки товара': 'created', 'Признак товара': 'badge', 'Категория 1 уровня': 'cat1', 'Категория 3 уровня': 'cat3',
};
const TEXT_KEYS = new Set(['noStock', 'scheme', 'promoDays', 'adDays', 'created', 'badge', 'cat1', 'cat3']);

function parseMarket(rows, fileName) {
  const hi = rows.findIndex(r => r.some(c => s(c) === 'Ссылка на товар'));
  const h = rows[hi].map(s);
  const meta = {};
  for (const r of rows.slice(0, hi)) if (s(r[0])) meta[s(r[0]).replace(/:$/, '')] = s(r[1]);
  const w = num(String(meta['Период отчета'] || '').replace(/\D/g, ''));
  // «Дата формирования: 11.06.26» — в этих отчётах месяц идёт первым; надёжнее имя файла.
  let date = dateFromName(fileName);
  if (!date) {
    const m = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})/.exec(meta['Дата формирования'] || '');
    if (m) date = iso(+m[3], +m[1], +m[2]) || iso(+m[3], +m[2], +m[1]);
  }
  const ix = Object.fromEntries(h.map((c, i) => [c, i]));
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const link = s(r[ix['Ссылка на товар']]);
    const m = /product\/(?:[^/?]*-)?(\d{5,15})/.exec(link);
    if (!m) continue; // «Среднее значение по товарам» и пустые строки
    const data = {};
    h.forEach((c, i) => {
      const k = MARKET_COLS[c]; if (!k) return;
      data[k] = TEXT_KEYS.has(k) ? s(r[i]) : num(r[i]);
    });
    out.push({ sku: m[1], name: s(r[ix['Название товара']]), seller: s(r[ix['Продавец']]), brand: s(r[ix['Бренд']]), data });
  }
  return { kind: 'market', date, window: w, rows: out, label: `Товары на Ozon · ${w || '?'} дн. · ${out.length} тов.` };
}

function parseSerp(rows, fileName) {
  const hi = rows.findIndex(r => r.some(c => s(c) === 'ID товара'));
  const h = rows[hi].map(s);
  const meta = {};
  for (const r of rows.slice(0, hi)) { const t = s(r[0]); const k = t.indexOf(':'); if (k > 0) meta[t.slice(0, k).trim()] = t.slice(k + 1).trim(); }
  let date = null;
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(meta['Дата'] || '');
  if (m) date = iso(+m[3], +m[2], +m[1]);
  if (!date) date = dateFromName(fileName);
  const col = name => h.findIndex(c => c.replace(/\s+/g, ' ').startsWith(name));
  const C = {
    pos: col('Позиция'), sku: col('ID товара'), name: col('Название товара'), seller: col('Имя селлера'), status: col('Статус'), cpc: col('Ставка Оплата за клик'),
    strategy: col('Стратегия'), cpo: col('Ставка Оплата за заказ'), rel: col('Соответствие запросу'), rev: col('Отзывы'), price: col('Цена на сайте'),
    pop: col('Популярность'), promo: col('Акции от Ozon'), deliv: col('Срок доставки'),
  };
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const sku = s(r[C.sku]).replace(/\D/g, '');
    if (!sku || sku.length < 5) continue; // служебные строки-пояснения
    const rv = /([\d,]+)\s*\(([\d\s]+)\s*шт/.exec(s(r[C.rev]));
    const cpo = s(r[C.cpo]);
    out.push({
      sku, position: num(r[C.pos]), name: s(r[C.name]), seller: s(r[C.seller]), status: s(r[C.status]), cpc: num(r[C.cpc]),
      strategy: s(r[C.strategy]) === '—' ? '' : s(r[C.strategy]), cpo: cpo === '—' ? '' : cpo, relevance: num(r[C.rel]),
      rating: rv ? num(rv[1]) : null, reviews: rv ? num(rv[2]) : null, price: num(r[C.price]), popularity: num(r[C.pop]), promo: s(r[C.promo]), delivery: s(r[C.deliv]),
    });
  }
  return { kind: 'serp', date, query: meta['Запрос'] || '', region: meta['Регион'] || '', total: num(meta['Сколько позиций в выдаче']), rows: out,
    label: `Выдача «${meta['Запрос'] || '?'}» · ${meta['Регион'] || ''} · ${out.length} тов.` };
}

export async function parseOzonReport(file) {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const has = t => rows.some(r => r.some(c => s(c) === t));
  if (has('Ссылка на товар')) return parseMarket(rows, file.name);
  if (has('ID товара')) return parseSerp(rows, file.name);
  if (wb.SheetNames[0] === 'Запросы моего товара' || has('Запрос')) return { kind: 'ours', label: 'Отчёт по нашим запросам — эти данные сервис получает сам по API, загружать не нужно' };
  return { kind: 'unknown', label: 'Не похоже на отчёт «Товары на Ozon» или «Результаты по запросу»' };
}
