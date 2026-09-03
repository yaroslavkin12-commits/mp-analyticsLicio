// Разбор артикула на "базовую модель" (для группировки по карточке) и размер.
//
// На WB один товар (nmId) уже соответствует одной модели+цвету — размеры внутри
// него НЕ входят в артикул (supplier_article), они отдельным полем (tech_size).
// На Ozon, наоборот, каждый размер — отдельный offer_id, и размер приклеен
// в конец WB-шного базового артикула без разделителя, например:
//   WB:   LTiOv-W-9      (базовый артикул, цвет = "9")
//   Ozon: LTiOv-W-9XS    (тот же артикул + размер "XS" в конце)
//
// Отдельно встречается детская линейка вида "Ti-134-5", где наоборот размер
// (числовой, рос­товка) стоит В СЕРЕДИНЕ, а не в конце: Ti-{размер}-{цвет}.
//
// Если ни один шаблон не подошёл — возвращаем артикул как есть (без размера).
// Это осознанный компромисс: лучше товар останется несгруппированным (будет
// видна отдельная строка), чем два разных товара молча схлопнутся в один.

const SIZE_TOKENS = ['3XL', '4XL', '5XL', 'XXXL', 'XXL', '2XL', 'XL', 'L', 'M', 'S', 'XS'];
// Сортируем по убыванию длины, чтобы "XL" не откусился раньше "2XL"/"3XL" и т.п.
const SIZE_ALTERNATION = SIZE_TOKENS.sort((a, b) => b.length - a.length).join('|');
const TRAILING_SIZE_RE = new RegExp(`^(.*?-)(\\d{1,2})(${SIZE_ALTERNATION})$`, 'i');
const KIDS_RE = /^(Ti)-(\d{2,3})-(\d{1,2})$/i;

function parseArticle(rawArticle) {
  const article = String(rawArticle || '').trim();
  if (!article) return { baseArticle: article, size: null };

  const kids = article.match(KIDS_RE);
  if (kids) {
    const [, prefix, size, color] = kids;
    return { baseArticle: `${prefix}-${color}`, size };
  }

  const trailing = article.match(TRAILING_SIZE_RE);
  if (trailing) {
    const [, prefixWithDash, color, size] = trailing;
    return { baseArticle: `${prefixWithDash}${color}`, size: size.toUpperCase() };
  }

  // Не распознали шаблон размера — считаем весь артикул базовым, без размера.
  return { baseArticle: article, size: null };
}

module.exports = { parseArticle };
