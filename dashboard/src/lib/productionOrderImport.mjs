const header = v => String(v ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9]/g, '');
const number = v => typeof v === 'number' ? v : Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
export function parseProductionOrder(sheet, known, taskSize) {
  const hi = sheet.findIndex(r => r.some(v => header(v) === 'артикул'));
  if (hi < 0) throw new Error('Не найдена колонка «Артикул». Загрузите файл заказа с заголовками.');
  const h = sheet[hi].map(header), ai = h.indexOf('артикул');
  const qi = h.findIndex(v => ['колвошт', 'количество', 'количествошт', 'штук', 'шт'].includes(v));
  const ti = h.findIndex(v => ['заданий', 'колвозаданий', 'количествозаданий'].includes(v));
  if (qi < 0) throw new Error('Не найдена колонка «Кол-во, шт».');
  const seen = new Set(), items = [];
  for (const [i, row] of sheet.slice(hi + 1).entries()) {
    if (row.every(v => v === '' || v == null)) continue;
    const offer = String(row[ai] ?? '').trim();
    if (/^итого/i.test(offer)) continue;
    if (!offer || !known.has(offer)) throw new Error(`Строка ${hi + i + 2}: неизвестный артикул «${offer}».`);
    if (seen.has(offer)) throw new Error(`Артикул ${offer} повторяется. Оставьте одну строку.`);
    seen.add(offer);
    const qty = number(row[qi]);
    if (row[qi] == null || String(row[qi]).trim() === '' || !Number.isSafeInteger(qty) || qty < 0) throw new Error(`${offer}: количество должно быть целым числом от нуля.`);
    const tasks = ti < 0 ? Math.ceil(qty / taskSize(offer)) : number(row[ti]);
    if (ti >= 0 && (row[ti] == null || String(row[ti]).trim() === '') || !Number.isFinite(tasks) || tasks < 0 || (qty > 0 && tasks === 0)) throw new Error(`${offer}: проверьте количество заданий.`);
    if (qty) items.push([offer, qty, Math.round(tasks * 10) / 10]);
  }
  if (!items.length) throw new Error('В файле нет строк с количеством больше нуля.');
  return items;
}
