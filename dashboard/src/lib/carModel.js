// Короткое название модели авто из длинного названия товара:
// «Дефлекторы окон Chery Tiggo 8 Pro Max 2022-2025, тёмные, 4 шт» → «Chery Tiggo 8 Pro Max».
// Берём слова с первого латинского (или известной русской марки) до года,
// запятой, скобки или русского слова. Не нашли — возвращаем исходное название.
const RU_BRANDS = /^(Лада|LADA|ВАЗ|УАЗ|ГАЗ|Газель|Москвич|Нива|ЗАЗ|ИЖ|Иж|Haval|Хавал|Хендай|Хёндай|Киа|Тойота|Ниссан|Шкода|Рено|Шевроле|Мицубиси|Мазда|Фольксваген|Черри|Чери|Джили|Чанган|Эксид|Омода)$/i;
export function carModel(name) {
  const s = String(name || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const words = s.split(' ');
  let i = words.findIndex(w => /^[A-Za-z]/.test(w) || RU_BRANDS.test(w.replace(/[,.;:]$/, '')));
  if (i < 0) return s;
  const ru = !/^[A-Za-z]/.test(words[i]);
  const out = [];
  for (; i < words.length; i++) {
    const w = words[i];
    if (/^\(|^(19|20)\d\d|^\d{4}-|^(с|до|от|г\.?|гг\.?|года?)$/i.test(w)) break;
    if (out.length && /^[А-Яа-яЁё]/.test(w) && !RU_BRANDS.test(w) && !(ru && /^[А-ЯЁ]/.test(w))) break;
    const end = /[,;(]$/.test(w);
    out.push(w.replace(/[,;(]$/, ''));
    if (end || out.length >= 6) break;
  }
  return out.join(' ') || s;
}
