function replaceProductionOrder(list, { id, expected, items, file }, master) {
  const index = list.findIndex(o => o.id === id);
  if (index < 0 || JSON.stringify(list[index]) !== JSON.stringify(expected)) throw Object.assign(new Error('Заказ уже изменён или удалён. Обновите страницу и загрузите файл снова.'), { status: 409 });
  const old = list[index], previous = new Map(old.items.map(r => [r[0], r])), seen = new Set();
  if (!Array.isArray(items) || !items.length || items.length > 10000) throw new Error('В файле должны быть строки заказа.');
  const clean = items.map(row => {
    if (!Array.isArray(row)) throw new Error('Некорректная строка заказа');
    const [offer, qty, tasks] = row;
    if (typeof offer !== 'string' || (!Object.hasOwn(master, offer) && !previous.has(offer)) || seen.has(offer)) throw new Error('Неизвестный или повторяющийся артикул');
    if (!Number.isSafeInteger(qty) || qty <= 0 || !Number.isFinite(tasks) || tasks <= 0) throw new Error('Проверьте количества и задания');
    seen.add(offer);
    const baseline = previous.get(offer);
    return [offer, qty, Math.round(tasks * 10) / 10, baseline?.[3] ?? null, baseline?.[4] ?? null, Math.min(qty, Number(baseline?.[5]) || 0)];
  });
  const next = [...list];
  next[index] = { ...old, items: clean, pcs: clean.reduce((n,r) => n+r[1],0), tasks: Math.round(clean.reduce((n,r) => n+r[2],0)*10)/10, correctedAt: new Date().toISOString(), correctionFile: String(file || '').slice(0,200) };
  return next;
}
module.exports = { replaceProductionOrder };
