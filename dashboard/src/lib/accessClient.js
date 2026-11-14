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
