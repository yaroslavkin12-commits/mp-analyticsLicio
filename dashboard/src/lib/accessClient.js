let state = { readOnly: false, cacheTag: '', storagePrefix: '' }, signature = '';
export function configureAccess(user) {
  const next = JSON.stringify([user?.id,user?.role,user?.accessScope]);
  if (next === signature) return;
  signature = next;
  const scoped = !!user?.accessScope;
  state = { readOnly: scoped, cacheTag: scoped ? `${user.id || user.login}-${Date.now()}` : '', storagePrefix: scoped ? `access-${user.id || user.login}-${encodeURIComponent(JSON.stringify(user.accessScope.paths.slice().sort()))}:` : '' };
}
export const accessMode = () => state;
export const accessStorageKey = key => state.storagePrefix + key;

export const accessStorage = { getItem:key=>localStorage.getItem(accessStorageKey(key)), setItem:(key,value)=>localStorage.setItem(accessStorageKey(key),value), removeItem:key=>localStorage.removeItem(accessStorageKey(key)) };

export const canManageAccess = user => user?.role === 'admin' || (user?.role === 'owner' && user?.login === 'evgeniy');

// Исключения для ограниченного профиля: личная сессия и ручные заметки
// к конкретному товару. Принадлежность товара проверяет сервер.
export function canWriteScoped(cfg) {
  const method = String(cfg.method || 'get').toLowerCase();
  if (/^\/auth\/(password|logout|activity)$/.test(cfg.url)) return true;
  if (method === 'post' && /^\/ad-hypotheses(?:\/reorder|\/[1-9]\d{0,17}\/finish)?$/.test(cfg.url)) return true;
  if (method === 'delete' && /^\/ad-hypotheses\/[1-9]\d{0,17}$/.test(cfg.url)) return true;
  const cabinet = cfg.params?.cabinet || cfg.data?.cabinet;
  if (method === 'post' && cfg.url === '/promo/groups/assign') {
    return typeof cfg.data?.offerId === 'string' && typeof cfg.data?.groupId === 'string' && Boolean(cfg.data.groupId);
  }
  if (cabinet === 'defly_wb') return false;
  if (cfg.url === '/competitors' && ['post', 'delete'].includes(method)) {
    const input = method === 'post' ? cfg.data : cfg.params;
    return typeof input?.offerId === 'string' && !!input.offerId.trim();
  }
  if (method === 'post' && /^\/(ads|promo)\/events$/.test(cfg.url)) return typeof cfg.data?.offerId === 'string' && !!cfg.data.offerId.trim();
  return method === 'delete' && /^\/(ads|promo)\/events\/\d+$/.test(cfg.url);
}
