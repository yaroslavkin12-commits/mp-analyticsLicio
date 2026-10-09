// Категории товаров для вкладки «Аналитика продаж» и «Себестоимость».
//
// Категория — путь от общего к частному, например
// ['Чехлы', 'Чехлы на сиденья', 'Экокожа', 'Ромб (KR)'].
// Определяется автоматически по названию и артикулу; любой артикул можно
// перенести вручную (таблица product_category_override) — ручной выбор
// всегда важнее правил.

// Порядок категорий в интерфейсе (то, чего нет в списке, идёт следом по алфавиту).
const ORDER = {
  defly: [
    'Чехлы', 'Чехлы на сиденья', 'Жаккард', 'Экокожа', 'Обычная (K)', 'Ромб (KR)', 'Накидки и другое', 'Чехлы на подлокотник',
    'Дефлекторы', 'Окна', '3D', '2D', 'PSA', 'Капот', 'Люк',
    'Утеплители', 'Утеплитель двигателя', 'Утеплитель радиатора',
    'Аксессуары', 'Рамки', 'Брызговики', 'Крепёж', 'Щётки', 'Ковры', 'Прочее',
    'Без категории',
  ],
};

function deflyPath(name, offerId) {
  const n = String(name || '').toLowerCase();
  const o = String(offerId || '');
  const ou = o.toUpperCase();

  // Чехлы
  if (/подлокотник/.test(n) || /^ARM-/i.test(o)) return ['Чехлы', 'Чехлы на подлокотник'];
  if (/чехл|чехол|накидк|автогамак/.test(n)) {
    // Материал — по окончанию артикула (-2 жаккард, -2K экокожа, -2KR ромб)
    // и по названию как запасной вариант.
    const isKR = /KR$/i.test(o) || /ромб/.test(n);
    const isK = !isKR && (/\dK$/i.test(o) || /экокож|кожа/.test(n));
    const isJac = !isKR && !isK && (/-\d+$/.test(o) || /жаккард/.test(n));
    if (/накидк|автогамак|универсальн/.test(n)) return ['Чехлы', 'Чехлы на сиденья', 'Накидки и другое'];
    if (isKR) return ['Чехлы', 'Чехлы на сиденья', 'Экокожа', 'Ромб (KR)'];
    if (isK) return ['Чехлы', 'Чехлы на сиденья', 'Экокожа', 'Обычная (K)'];
    if (isJac) return ['Чехлы', 'Чехлы на сиденья', 'Жаккард'];
    return ['Чехлы', 'Чехлы на сиденья', 'Накидки и другое'];
  }

  // Дефлекторы
  if (/^дефлектор[а-я]* капота/.test(n)) return ['Дефлекторы', 'Капот'];
  if (/^дефлектор[а-я]* люка/.test(n) || /^DL-/i.test(o)) return ['Дефлекторы', 'Люк'];
  if (/^дефлектор[а-я]* окон/.test(n)) {
    if (/\bpsa\b|«psa»|"psa"/i.test(n) || /PSA/.test(ou)) return ['Дефлекторы', 'Окна', 'PSA'];
    if (/\b2d\b/i.test(n) || /^2D/.test(ou)) return ['Дефлекторы', 'Окна', '2D'];
    // Остальные окна — объёмные 3D (основная линейка); если это не так,
    // артикул переносится вручную.
    return ['Дефлекторы', 'Окна', '3D'];
  }

  // Утеплители
  if (/утеплитель радиатора/.test(n)) return ['Утеплители', 'Утеплитель радиатора'];
  if (/утеплитель|автоодеял/.test(n)) return ['Утеплители', 'Утеплитель двигателя'];

  // Аксессуары
  if (/рамк[аи] для номера|рамка номер/.test(n)) return ['Аксессуары', 'Рамки'];
  if (/брызговик/.test(n)) return ['Аксессуары', 'Брызговики'];
  if (/щетк|щётк|стеклоочист/.test(n)) return ['Аксессуары', 'Щётки'];
  if (/^крепеж|^крепёж|клипс|саморез/.test(n)) return ['Аксессуары', 'Крепёж'];
  if (/ковр|коврик/.test(n)) return ['Аксессуары', 'Ковры'];
  if (n) return ['Аксессуары', 'Прочее'];
  return ['Без категории'];
}

// Licio (одежда): тип изделия — первое слово названия («Худи», «Футболка»…).
function genericPath(name) {
  const w = String(name || '').trim().split(/[\s,]+/)[0] || '';
  if (!w) return ['Без категории'];
  return [w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()];
}

function autoPath(cabinet, name, offerId) {
  return cabinet === 'defly' ? deflyPath(name, offerId) : genericPath(name);
}

// Марка автомобиля из названия — второй срез для автотоваров.
const BRANDS = [
  ['Toyota', /toyota|тойота/i], ['Lexus', /lexus/i], ['Honda', /honda/i], ['Nissan', /nissan|datsun/i],
  ['Mitsubishi', /mitsubishi/i], ['Mazda', /mazda/i], ['Subaru', /subaru/i], ['Suzuki', /suzuki/i],
  ['Daihatsu', /daihatsu/i], ['Infiniti', /infiniti/i], ['Isuzu', /isuzu/i],
  ['Haval', /haval/i], ['Chery', /chery/i], ['Geely', /geely/i], ['Changan', /changan/i], ['Jetour', /jetour/i],
  ['Exeed', /exeed/i], ['Omoda', /omoda/i], ['Tank', /\btank\b/i], ['JAC', /\bjac\b/i], ['FAW', /\bfaw\b/i],
  ['Great Wall', /great wall/i], ['Lifan', /lifan/i], ['Jaecoo', /jaecoo/i], ['Livan', /livan/i],
  ['Москвич', /москвич/i], ['Belgee', /belgee/i], ['Kaiyi', /kaiyi/i], ['Dongfeng', /dongfeng/i], ['GAC', /\bgac\b/i],
  ['BYD', /\bbyd\b/i], ['Hongqi', /hongqi/i], ['Zeekr', /zeekr/i], ['Li Auto', /li auto|lixiang/i], ['Voyah', /voyah/i],
  ['Hyundai', /hyundai/i], ['Kia', /\bkia\b/i], ['SsangYong', /ssang ?yong/i], ['Daewoo', /daewoo/i], ['Genesis', /genesis/i],
  ['Лада', /ваз|лада|lada/i], ['УАЗ', /уаз|uaz/i], ['ГАЗ', /\bгаз\b|газель|соболь/i], ['Нива', /нива|niva/i],
  ['Volkswagen', /volkswagen|\bvw\b/i], ['Skoda', /skoda/i], ['Renault', /renault/i], ['BMW', /\bbmw\b/i],
  ['Audi', /\baudi\b/i], ['Mercedes', /mercedes/i], ['Ford', /\bford\b/i], ['Opel', /\bopel\b/i],
  ['Chevrolet', /chevrolet/i], ['Peugeot', /peugeot/i], ['Citroen', /citroen/i], ['Volvo', /volvo/i],
  ['Land Rover', /land rover|range rover/i], ['Jeep', /\bjeep\b/i], ['Cadillac', /cadillac/i], ['Porsche', /porsche/i],
];
function carBrand(name) {
  const s = String(name || '');
  for (const [b, re] of BRANDS) if (re.test(s)) return b;
  return null;
}

module.exports = { autoPath, carBrand, ORDER };
