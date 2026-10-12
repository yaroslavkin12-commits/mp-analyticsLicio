const { query } = require('./db');
const { sendMessage } = require('./telegram');

// ─────────────────────────────────────────────────────────────────────────
// Пополнения остатков. После каждого импорта остатков (вкладка Stocks
// Google-таблицы, обновляется каждые 30 минут) сравниваем остаток по каждому
// артикулу с прошлым снимком. Рост на minInc шт и больше — «пополнение».
//   • артикулы из списка наблюдения (свои артикулы + группы из «Рекламы»)
//     → сразу сообщение в Telegram;
//   • остальные → одним списком раз в день, следом за утренним дайджестом.
// Настройки — app_settings 'restock:<кабинет>'; прошлый снимок —
// 'restock_last:<кабинет>' = { offer: [fbo, fbs] } (fbo/fbs_present — весь
// физический остаток, вместе с резервом: резерв меняется от заказов/отмен,
// а present растёт только от поставок и возвратов).
// ─────────────────────────────────────────────────────────────────────────

const DEF = { enabled: true, minInc: 3, arts: [], groups: [], instant: true, daily: true };
const num = v => Number(v) || 0;
const fmt = v => Math.round(v).toLocaleString('ru-RU').replace(/ /g, ' ');
const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await query(`CREATE TABLE IF NOT EXISTS restock_events (
    id BIGSERIAL PRIMARY KEY, cabinet VARCHAR(32) NOT NULL, offer_id VARCHAR(128) NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fbo_before INT NOT NULL DEFAULT 0, fbo_after INT NOT NULL DEFAULT 0, fbs_before INT NOT NULL DEFAULT 0, fbs_after INT NOT NULL DEFAULT 0,
    watched BOOLEAN NOT NULL DEFAULT FALSE, sent_instant BOOLEAN NOT NULL DEFAULT FALSE, sent_daily BOOLEAN NOT NULL DEFAULT FALSE)`);
  await query(`CREATE INDEX IF NOT EXISTS restock_events_cab_at ON restock_events (cabinet, at DESC)`);
  tableReady = true;
}

async function getSetting(key) {
  const r = await query(`SELECT value FROM app_settings WHERE key = $1`, [key]).catch(() => []);
  try { return r[0] ? JSON.parse(r[0].value) : null; } catch (e) { return null; }
}
async function putSetting(key, v) {
  await query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, JSON.stringify(v)]);
}

async function getRestockSettings(cabinet) { return { ...DEF, ...(await getSetting(`restock:${cabinet}`) || {}) }; }
async function saveRestockSettings(cabinet, s) {
  const cur = await getRestockSettings(cabinet);
  const next = { ...cur };
  if (s.enabled !== undefined) next.enabled = !!s.enabled;
  if (s.instant !== undefined) next.instant = !!s.instant;
  if (s.daily !== undefined) next.daily = !!s.daily;
  if (s.minInc !== undefined) next.minInc = Math.max(1, Math.min(1000, Math.round(num(s.minInc)) || 1));
  if (Array.isArray(s.arts)) next.arts = [...new Set(s.arts.map(a => String(a).trim()).filter(Boolean))].slice(0, 500);
  if (Array.isArray(s.groups)) next.groups = [...new Set(s.groups.map(String))].slice(0, 50);
  await putSetting(`restock:${cabinet}`, next);
  return next;
}

// Список наблюдения: свои артикулы + участники выбранных групп «Рекламы».
async function watchSet(cabinet, s) {
  const set = new Set(s.arts.map(a => a.toLowerCase()));
  if (s.groups.length) {
    const members = await getSetting(`ads_group_members:${cabinet}`) || {};
    for (const [o, g] of Object.entries(members)) if (s.groups.includes(String(g))) set.add(o.toLowerCase());
  }
  return set;
}

async function names(cabinet, offers) {
  if (!offers.length) return new Map();
  const r = await query(`SELECT offer_id, product_name FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND offer_id = ANY($2)`, [cabinet, offers]).catch(() => []);
  return new Map(r.map(x => [x.offer_id, x.product_name || '']));
}

function line(e, nm) {
  const b = e.fbo_before + e.fbs_before, a = e.fbo_after + e.fbs_after;
  const parts = [];
  if (e.fbo_after !== e.fbo_before) parts.push(`FBO ${fmt(e.fbo_before)}→${fmt(e.fbo_after)}`);
  if (e.fbs_after !== e.fbs_before) parts.push(`FBS ${fmt(e.fbs_before)}→${fmt(e.fbs_after)}`);
  const n = (nm.get(e.offer_id) || '').slice(0, 40);
  return `• <b>${esc(e.offer_id)}</b>${n ? ' ' + esc(n) : ''}: ${fmt(b)} → <b>${fmt(a)}</b> шт (+${fmt(a - b)})${parts.length ? ` · ${parts.join(', ')}` : ''}`;
}

// rows: [{ offer_id, fbo, fbs }] — свежий снимок остатков кабинета.
async function detectRestocks(cabinet, rows) {
  await ensureTable();
  const s = await getRestockSettings(cabinet);
  const key = `restock_last:${cabinet}`;
  let prev = await getSetting(key);
  if (!prev) {
    // Первый запуск: за точку отсчёта берём вчерашний снимок — так сразу
    // видны пополнения, пришедшие сегодня.
    const y = await query(`SELECT offer_id, SUM(fbo_present) fbo, SUM(fbs_present) fbs FROM ad_product_stocks
      WHERE cabinet = $1 AND platform = 'ozon' AND snapshot_date = (SELECT MAX(snapshot_date) FROM ad_product_stocks WHERE cabinet = $1 AND platform = 'ozon' AND snapshot_date < CURRENT_DATE)
      GROUP BY offer_id`, [cabinet]).catch(() => []);
    if (y.length) prev = Object.fromEntries(y.map(r => [r.offer_id, [num(r.fbo), num(r.fbs)]]));
  }
  const cur = {};
  for (const r of rows) { const o = r.offer_id; if (!o) continue; const c = cur[o] || (cur[o] = [0, 0]); c[0] += num(r.fbo); c[1] += num(r.fbs); }
  const sumOf = m => Object.values(m).reduce((t, v) => t + v[0] + v[1], 0);
  if (!prev) { await putSetting(key, cur); return { events: 0, first: true }; }
  // Защита от сбоя выгрузки: если остаток кабинета вдруг упал больше чем
  // вдвое — это скорее неполные данные; снимок не обновляем.
  // Сравниваем только артикулы, которые есть в обоих снимках.
  const common = Object.keys(cur).filter(o => prev[o]);
  const prevSum = sumOf(Object.fromEntries(common.map(o => [o, prev[o]]))), curSum = sumOf(Object.fromEntries(common.map(o => [o, cur[o]])));
  if (prevSum > 50 && curSum < prevSum * 0.5) { console.warn(`[Restock:${cabinet}] подозрительный снимок (${curSum} против ${prevSum}) — пропуск`); return { events: 0, skipped: true }; }
  const merged = { ...prev, ...cur };
  await putSetting(key, merged);
  if (!s.enabled) return { events: 0 };

  const ev = [];
  for (const [o, [fbo, fbs]] of Object.entries(cur)) {
    const p = prev[o]; if (!p) continue;
    if ((fbo + fbs) - (p[0] + p[1]) >= s.minInc) ev.push({ offer_id: o, fbo_before: p[0], fbo_after: fbo, fbs_before: p[1], fbs_after: fbs });
  }
  if (!ev.length) return { events: 0 };
  // Если «пополнилось» почти всё сразу — это перезагрузка данных, а не поставки.
  const known = Object.keys(cur).filter(o => prev[o]).length;
  if (known >= 20 && ev.length > known * 0.4) { console.warn(`[Restock:${cabinet}] ${ev.length} из ${known} — похоже на перезагрузку данных, без уведомлений`); return { events: 0, skipped: true }; }

  const watch = await watchSet(cabinet, s);
  for (const e of ev) e.watched = watch.has(e.offer_id.toLowerCase());
  const instant = s.instant ? ev.filter(e => e.watched) : [];
  let sent = false;
  if (instant.length) {
    const nm = await names(cabinet, instant.map(e => e.offer_id));
    const head = `📦 <b>Пополнение остатка${instant.length > 1 ? ` · ${instant.length} арт.` : ''}</b>`;
    sent = await sendMessage(`${head}\n${instant.map(e => line(e, nm)).join('\n')}`).catch(e => { console.warn('[Restock] telegram:', e.message); return false; });
  }
  for (const e of ev) {
    await query(`INSERT INTO restock_events (cabinet, offer_id, fbo_before, fbo_after, fbs_before, fbs_after, watched, sent_instant)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [cabinet, e.offer_id, e.fbo_before, e.fbo_after, e.fbs_before, e.fbs_after, e.watched, !!(sent && e.watched)]);
  }
  // В журнал изменений «Рекламы» — чтобы рост заказов было с чем связать.
  for (const e of ev) {
    const b = e.fbo_before + e.fbs_before, a = e.fbo_after + e.fbs_after;
    await query(`INSERT INTO ad_events (cabinet, platform, offer_id, date, kind, text, old_value, new_value, auto)
      VALUES ($1, 'ozon', $2, (NOW() AT TIME ZONE 'Europe/Moscow')::date, 'restock', $3, $4, $5, true)`,
      [cabinet, e.offer_id, `Пополнение остатка: ${fmt(b)} → ${fmt(a)} шт (+${fmt(a - b)})`, String(b), String(a)]).catch(() => {});
  }
  console.log(`[Restock:${cabinet}] пополнений ${ev.length}, сразу отправлено ${sent ? instant.length : 0}`);
  return { events: ev.length, instant: sent ? instant.length : 0 };
}

// Ежедневная сводка (после утреннего дайджеста): все пополнения, о которых
// ещё не сообщали сразу. Несколько пополнений одного артикула — одной строкой.
async function sendRestockDaily(cabinet) {
  await ensureTable();
  const s = await getRestockSettings(cabinet);
  if (!s.enabled || !s.daily) return false;
  const rows = await query(`SELECT id, offer_id, at, fbo_before, fbo_after, fbs_before, fbs_after FROM restock_events
    WHERE cabinet = $1 AND NOT sent_instant AND NOT sent_daily AND at > NOW() - INTERVAL '3 days' ORDER BY at`, [cabinet]);
  if (!rows.length) return false;
  const by = new Map();
  for (const r of rows) {
    const x = by.get(r.offer_id);
    if (!x) by.set(r.offer_id, { ...r });
    else { x.fbo_after = r.fbo_after; x.fbs_after = r.fbs_after; }
  }
  const list = [...by.values()].sort((a, b) => (b.fbo_after + b.fbs_after - b.fbo_before - b.fbs_before) - (a.fbo_after + a.fbs_after - a.fbo_before - a.fbs_before));
  const nm = await names(cabinet, list.map(e => e.offer_id));
  const MAX = 40;
  const text = `📦 <b>Пополнения остатков за сутки</b> · ${list.length} арт.\n${list.slice(0, MAX).map(e => line(e, nm)).join('\n')}${list.length > MAX ? `\n…и ещё ${list.length - MAX} — во вкладке «Уведомления»` : ''}`;
  const sent = await sendMessage(text);
  if (sent) await query(`UPDATE restock_events SET sent_daily = TRUE WHERE id = ANY($1)`, [rows.map(r => r.id)]);
  return sent;
}

async function listRestocks(cabinet, days = 14) {
  await ensureTable();
  const rows = await query(`SELECT e.offer_id, e.at, e.fbo_before, e.fbo_after, e.fbs_before, e.fbs_after, e.watched, e.sent_instant, e.sent_daily,
      (SELECT c.product_name FROM ad_product_catalog c WHERE c.cabinet = e.cabinet AND c.platform = 'ozon' AND c.offer_id = e.offer_id LIMIT 1) AS product_name
    FROM restock_events e
    WHERE e.cabinet = $1 AND e.at > NOW() - ($2 || ' days')::interval ORDER BY e.at DESC LIMIT 1000`, [cabinet, String(days)]);
  return rows;
}

module.exports = { detectRestocks, sendRestockDaily, listRestocks, getRestockSettings, saveRestockSettings };
