// Определение категории и пола товара по базовому артикулу (без размера).
// Категория — по префиксу артикула (список префиксов задан продавцом).
// Пол — по буквенному/словесному токену: либо отдельный сегмент между
// дефисами (LTiOv-W-9), либо приклеен прямо к коду категории без
// разделителя (HoodMen, SwWomen). Оба варианта возможны в обе стороны
// (буква или слово), поэтому проверяем все варианты.

const CATEGORIES = [
  { code: 'ti',    label: 'Детские футболки' },
  { code: 'ltiov', label: 'Взрослые футболки' },
  { code: 'llong', label: 'Лонгсливы' },
  { code: 'sw',    label: 'Свитшоты' },
  { code: 'hood',  label: 'Худи' },
  { code: 'sh',    label: 'Шорты' },
  { code: 'jogg',  label: 'Джоггеры' },
];
// От длинных кодов к коротким, чтобы не спутать похожие префиксы.
const CATEGORIES_SORTED = [...CATEGORIES].sort((a, b) => b.code.length - a.code.length);

function findCategory(baseArticle) {
  const s = String(baseArticle || '').toLowerCase();
  return CATEGORIES_SORTED.find(c => s.startsWith(c.code)) || null;
}

function detectCategory(baseArticle) {
  const found = findCategory(baseArticle);
  return found ? found.label : 'Другое';
}

const WOMEN_TOKENS = ['women', 'woman', 'female', 'w'];
const MEN_TOKENS = ['men', 'man', 'male', 'm'];
// Слова длиннее однобуквенных — первыми, чтобы не словить "m"/"w" как
// начало более длинного слова по ошибке.
const GENDER_TOKENS_SORTED = [...WOMEN_TOKENS, ...MEN_TOKENS].sort((a, b) => b.length - a.length);

function detectGender(baseArticle) {
  const raw = String(baseArticle || '');

  // 1) Пол как отдельный сегмент между дефисами, напр. LTiOv-W-9
  const segments = raw.split('-').filter(Boolean).map(s => s.toLowerCase());
  for (const seg of segments) {
    if (WOMEN_TOKENS.includes(seg)) return 'Женское';
    if (MEN_TOKENS.includes(seg)) return 'Мужское';
  }

  // 2) Пол приклеен сразу к коду категории без разделителя, напр. HoodMen
  const cat = findCategory(raw);
  if (cat) {
    const rest = raw.toLowerCase().slice(cat.code.length);
    for (const token of GENDER_TOKENS_SORTED) {
      if (rest.startsWith(token)) {
        return WOMEN_TOKENS.includes(token) ? 'Женское' : 'Мужское';
      }
    }
  }

  return null; // не удалось определить — товар останется вне фильтра пола
}

const ALL_CATEGORY_LABELS = CATEGORIES.map(c => c.label);

module.exports = { detectCategory, detectGender, ALL_CATEGORY_LABELS };
