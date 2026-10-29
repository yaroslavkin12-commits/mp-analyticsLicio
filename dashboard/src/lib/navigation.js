import { isDeflyLike } from './cabinets';
const DEFLY_NAV = [
    ['__h','Продажи'],['summary','🏬','Сводка по магазинам'],['sales','📈','Аналитика продаж'],['rnp','🩺','РНП'],['orders','🛒','Лента заказов'],['plan','🎯','План / факт'],['check','🧾','Средний чек'],['abc','🔤','ABC-анализ'],['season','🍂','Сезонность'],['geo','🗺️','География продаж'],
    ['__h','Реклама и поиск'],['ads','📣','Реклама'],['search','🔍','Позиции в поиске'],['discounts','💸','Соинвест'],
    ['__h','Склад'],['inventory','🏬','Остатки'],['production','🧵','Производство'],['buyout','📦','% выкупа'],
    ['__h','Деньги'],['unit','🧩','Юнит-экономика'],['margin','🏷️','Цены и маржа'],['pricelog','📝','Журнал цен'],['pnl','💰','P&L'],['recon','🔎','Сверка с Ozon'],
    ['__h','Инструменты'],['notifications','🔔','Уведомления'],['calculator','🧮','Калькулятор'],['costs','🧾','Товары'],
  ];
const LICIO_NAV = [...DEFLY_NAV.filter(([id]) => id !== 'production'), ['settings', '⚙️', 'Настройки']];
// Меню одинаковое; недоступные источники остаются на своих местах с подсказкой.
const WB_NAV = DEFLY_NAV;
export const unavailablePage = (cabinet, page) => cabinet === 'defly_wb' && ['summary','plan','search','discounts','buyout','unit','margin','pnl','recon','notifications','calculator'].includes(page)
  ? (['unit','margin','pnl','recon','plan','calculator'].includes(page) ? 'Финансы WB пока не подключены' : 'Источник WB для этого раздела пока не подключён') : '';
export const navOf = cabinet => cabinet === 'defly_wb' ? WB_NAV : cabinet === 'licio' ? LICIO_NAV : isDeflyLike(cabinet) ? DEFLY_NAV : LICIO_NAV;
export const pagesOf = cabinet => ['sales', ...navOf(cabinet).map(([id]) => id).filter(id => id !== '__h' && id !== 'sales' && !unavailablePage(cabinet, id))];
export const navLabel = (cabinet, page) => (navOf(cabinet).find(([id]) => id === page) || [])[2] || '';
