// Магазины (кабинеты). Ozon делится на магазины; WB — позже.
// family 'defly' — те же товары: разделы, категории и марки авто как у Defly.
export const SHOPS = [
  { id: 'defly', label: 'Defly', platform: 'ozon', family: 'defly', color: '#3b82f6' },
  { id: 'nabauto', label: 'NABauto', platform: 'ozon', family: 'defly', color: '#10b981' },
  { id: 'alex', label: 'Alex', platform: 'ozon', family: 'defly', color: '#f59e0b' },
  { id: 'fullgas', label: 'Fullgas', platform: 'ozon', family: 'defly', color: '#ef4444' },
  { id: 'accent', label: 'Accent Line', platform: 'ozon', family: 'defly', color: '#a855f7' },
  { id: 'defly_wb', label: 'Defly WB', platform: 'wb', family: 'defly', color: '#b735db' },
  { id: 'licio', label: 'Licio', platform: 'mix', family: 'licio', color: '#94a3b8' },
];
export const shopOf = id => SHOPS.find(s => s.id === id) || null;
export const familyOf = id => shopOf(id)?.family || id;
export const isDeflyLike = id => familyOf(id) === 'defly';
// Раздел «Производство» общий для всех магазинов (считается по 1С и данным Defly).
export const SHARED_PAGES = { production: 'defly' };
