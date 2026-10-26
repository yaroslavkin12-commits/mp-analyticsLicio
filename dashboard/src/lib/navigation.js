import { isDeflyLike } from './cabinets';
const DEFLY_NAV = [
    ['__h','Продажи'],['summary','🏬','Сводка по магазинам'],['sales','📈','Аналитика продаж'],['rnp','🩺','РНП'],['orders','🛒','Лента заказов'],['plan','🎯','План / факт'],['check','🧾','Средний чек'],['abc','🔤','ABC-анализ'],['season','🍂','Сезонность'],['geo','🗺️','География продаж'],
    ['__h','Реклама и поиск'],['ads','📣','Реклама'],['search','🔍','Позиции в поиске'],['discounts','💸','Соинвест'],
    ['__h','Склад'],['inventory','🏬','Остатки'],['production','🧵','Производство'],['buyout','📦','% выкупа'],
    ['__h','Деньги'],['unit','🧩','Юнит-экономика'],['margin','🏷️','Цены и маржа'],['pricelog','📝','Журнал цен'],['pnl','💰','P&L'],['recon','🔎','Сверка с Ozon'],
    ['__h','Инструменты'],['notifications','🔔','Уведомления'],['calculator','🧮','Калькулятор'],['costs','🧾','Товары'],
  ];
const LICIO_NAV = [...DEFLY_NAV.filter(([id]) => id !== 'production'), ['settings', '⚙️', 'Настройки']];
export const navOf = cabinet => cabinet === 'licio' ? LICIO_NAV : isDeflyLike(cabinet) ? DEFLY_NAV : LICIO_NAV;
export const pagesOf = cabinet => ['sales', ...navOf(cabinet).map(([id]) => id).filter(id => id !== '__h' && id !== 'sales')];
export const navLabel = (cabinet, page) => (navOf(cabinet).find(([id]) => id === page) || [])[2] || '';
