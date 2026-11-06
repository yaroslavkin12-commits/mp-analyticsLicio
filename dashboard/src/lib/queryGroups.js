// Поисковые запросы товара: два признака.
// 1) Целевой или нет — отмечает владелец галочкой; пока не отмечено,
//    подсказка автоматически: в запросе наш тип товара и наша модель
//    («чехлы на хавал м6»). Ручная отметка всегда важнее.
// 2) Частотность — по числу искавших за 30 дней: ВЧ / СЧ / НЧ (пороги
//    настраиваются на странице).

export const FREQ = [
  { key: 'hi', label: 'ВЧ', title: 'Высокочастотный' },
  { key: 'mid', label: 'СЧ', title: 'Среднечастотный' },
  { key: 'lo', label: 'НЧ', title: 'Низкочастотный' },
];
export const FREQ_LABEL = Object.fromEntries(FREQ.map(f => [f.key, f.label]));
export const DEFAULT_FREQ = { hi: 1000, mid: 100 }; // искали за 30 дней: от 1000 — ВЧ, от 100 — СЧ, меньше — НЧ
export const freqOf = (per30, th = DEFAULT_FREQ) => (per30 >= th.hi ? 'hi' : per30 >= th.mid ? 'mid' : 'lo');
// Ручная отметка: 'target' — целевой, 'other' — нецелевой (старые значения model/type — тоже нецелевые).
export const isTarget = (q, manual, profile) => (manual ? manual === 'target' : autoGroup(q, profile) === 'target');

// Типы товаров: по началу слова.
const TYPES = [
  ['чехол', ['чехл', 'чехол', 'авточехл', 'накидк', 'автонакидк']],
  ['дефлектор', ['дефлект', 'ветровик', 'ветрови', 'мухобойк']],
  ['утеплитель', ['утепл']],
  ['коврик', ['коврик', 'ковр', 'автоковр']],
  ['брызговик', ['брызгов']],
  ['рамка', ['рамк']],
  ['щётка', ['щетк', 'щётк', 'дворник']],
  ['подлокотник', ['подлокот']],
  ['органайзер', ['органайз']],
  ['шторка', ['шторк']],
  ['сетка', ['сетк']],
  ['накладка', ['накладк']],
  ['крепление', ['креплен', 'крепеж', 'крепёж', 'клипс', 'пистон']],
];
// Общие слова — не модель и не тип.
const GENERIC_EXACT = new Set(['на', 'для', 'в', 'во', 'с', 'со', 'и', 'по', 'от', 'до', 'из', 'без', 'под', 'к', 'а', 'г', 'гг', 'гв', 'нв', 'н', 'шт', 'все', 'всё', 'весь', 'ii', 'iii', 'new', 'то', 'же', 'or', 'the']);
const GENERIC_PREFIX = ['черн', 'бел', 'сер', 'беж', 'корич', 'красн', 'син', 'цвет', 'экокож', 'кож', 'перфор', 'ромб', 'сот', 'жаккар', 'алькан', 'ткан',
  'сиден', 'сидуш', 'автомоб', 'авто', 'машин', 'салон', 'комплек', 'передн', 'задн', 'модельн', 'универс', 'аксессуар', 'вес', 'полност', 'мест',
  'нов', 'рестайл', 'дорест', 'поколен', 'купит', 'озон', 'ozon', 'недорог', 'оригин', 'набор', 'года', 'год', 'строчк', 'окн', 'двер', 'капот',
  'лобов', 'боков', 'спинк', 'кресл', 'кресе', 'тепл', 'защит', 'премиум', 'люкс', 'стандарт', 'классик', 'качеств'];

const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');
const tokens = s => norm(s).replace(/(^|[^a-zа-я])([a-zа-я])\s+(\d{1,2})(?!\d)/gi, '$1$2$3').split(/[^a-zа-я0-9]+/i).filter(Boolean);
const stem = t => (t.length > 5 ? t.slice(0, 5) : t);
const isNumber = t => /^\d+$/.test(t);
const isGeneric = t => GENERIC_EXACT.has(t) || (t.length > 2 && GENERIC_PREFIX.some(p => t.startsWith(p)));
const typeOf = t => { for (const [k, ps] of TYPES) if (ps.some(p => t.startsWith(p))) return k; return null; };
const hasDigitAndLetter = t => /\d/.test(t) && /[a-zа-я]/i.test(t);

// Описание товара для классификации: его типы и «модельные» слова.
export function productProfile(name) {
  const ts = tokens(name);
  const types = new Set(ts.map(typeOf).filter(Boolean));
  const words = new Set(), strong = new Set();
  for (const t of ts) {
    if (isNumber(t) || isGeneric(t) || typeOf(t)) continue;
    words.add(stem(t));
    if (hasDigitAndLetter(t)) strong.add(stem(t));
  }
  return { types, words, strong };
}

export function autoGroup(query, profile) {
  const ts = tokens(query);
  let ownType = false, foreignType = false;
  const matched = [], unmatched = [];
  for (const t of ts) {
    const ty = typeOf(t);
    if (ty) { if (profile.types.has(ty)) ownType = true; else foreignType = true; continue; }
    if (isNumber(t) || isGeneric(t)) continue;
    (profile.words.has(stem(t)) ? matched : unmatched).push(stem(t));
  }
  if (foreignType || unmatched.length) return 'other';
  const strongHit = matched.some(t => profile.strong.has(t));
  const modelOk = matched.length > 0 && (profile.strong.size === 0 || strongHit);
  if (ownType && modelOk) return 'target';
  if (ownType) return 'type';
  if (matched.length) return 'model';
  return 'other';
}
