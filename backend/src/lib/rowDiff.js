// Память «что уже лежит в базе»: по каждой таблице (и кабинету) — ключ строки
// → короткий хэш её значений. Импорт из Google-таблицы каждые полчаса
// приносит в основном те же строки; пишем в базу только изменившиеся.
// Раз в сутки память сбрасывается — тогда один импорт пишет всё целиком
// (страховка, если базу поменял кто-то ещё).
const crypto = require('crypto');
const TTL = 24 * 3600 * 1000;
const MEM = new Map(); // id -> { at, map: Map<key, hash> }

function hashRow(row, skip) {
  const v = row.map((x, i) => (skip.has(i) ? null : x instanceof Date ? x.getTime() : x));
  return crypto.createHash('md5').update(JSON.stringify(v)).digest('base64').slice(0, 16);
}
function state(id) {
  const s = MEM.get(id);
  if (!s || Date.now() - s.at > TTL) { MEM.delete(id); return null; }
  return s.map;
}
function remember(id, entries, replace) {
  let s = MEM.get(id);
  if (!s || replace) { s = { at: s && !replace ? s.at : Date.now(), map: new Map() }; MEM.set(id, s); }
  for (const [k, h] of entries) s.map.set(k, h);
}
function forget(id, keys) { const s = MEM.get(id); if (s) for (const k of keys) s.map.delete(k); }
function drop(id) { MEM.delete(id); }

// Целый набор строк: тот же, что в прошлый раз?
const SAME = new Map();
function sameAsLast(id, rows) {
  const h = crypto.createHash('md5').update(JSON.stringify(rows)).digest('base64');
  const prev = SAME.get(id);
  return { same: !!prev && prev.h === h && Date.now() - prev.at < TTL, save: () => SAME.set(id, { h, at: prev && prev.h === h ? prev.at : Date.now() }) };
}

// Сбросить всю память по кабинету (например, когда у нового магазина появился
// каталог и строки, записанные без артикула, нужно перечитать).
function dropCabinet(cabinet) {
  const suf = ':' + cabinet;
  for (const k of [...MEM.keys()]) if (k.endsWith(suf)) MEM.delete(k);
  for (const k of [...SAME.keys()]) if (k.endsWith(suf)) SAME.delete(k);
}

module.exports = { hashRow, state, remember, forget, drop, sameAsLast, dropCabinet };
