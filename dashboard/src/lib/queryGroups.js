// Группы поисковых запросов товара — автоматически, по названию товара.
// Ручная группа (из настроек) всегда важнее автоматической.
//   target — «Целевые»: наш тип товара + наша модель («чехлы на хавал м6»);
//   model  — «Модель без типа»: модель есть, а типа товара нет («хавал м6»);
//   type   — «Тип без модели»: тип товара без модели или только с маркой
//            («чехлы на сиденья», «чехлы на хавал»);
//   other  — «Прочие»: чужая модель, чужой тип товара, всё непонятное.

export const QUERY_GROUPS = [
  { key: 'target', label: 'Целевые', hint: 'Наш тип товара и наша модель — человек ищет именно такой товар' },
  { key: 'model', label: 'Модель без типа', hint: 'Есть модель авто, но не указан тип товара — ищут всё подряд для этой машины' },
  { key: 'type', label: 'Тип без модели', hint: 'Тип товара без модели (или только марка) — подходит многим машинам' },
  { key: 'other', label: 'Прочие', hint: 'Чужая модель, другой тип товара, мусорные запросы' },
];
export const GROUP_LABEL = Object.fromEntries(QUERY_GROUPS.map(g => [g.key, g.label]));

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
