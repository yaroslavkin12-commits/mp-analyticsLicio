const { query } = require('../../db');
const { CABINETS } = require('../../config/cabinets');
const { mskDate } = require('./ozonHttp');
const { collectCatalog } = require('./ozonCatalog');
const { collectAdStats } = require('./ozonPerf');
const { collectClicks } = require('./ozonClicks');
const { collectProductAnalytics } = require('./ozonProductAnalytics');
const { collectProductStocks } = require('./ozonProductStocks');
const {
  sheetId,
  syncCatalogFromSheet,
  syncAnalyticsFromSheet,
  syncStocksFromSheet,
  syncCampaignsFromSheet,
  syncStatsFromSheet,
  syncCampaignSkusFromSheet,
  syncAdDetailsFromSheet,
  cleanupSheetJunk,
} = require('./sheetSync');
const { collectDiscounts } = require('./ozonDiscounts');
const { getSettings } = require('./discountSettings');
const { sendDiscountDigest } = require('../../telegram');
const { pollOrdersFromSheet } = require('../trackedOrdersPoll');
const dayjs = require('dayjs');
const dayjsUtc = require('dayjs/plugin/utc');
const dayjsTz = require('dayjs/plugin/timezone');
dayjs.extend(dayjsUtc);
dayjs.extend(dayjsTz);

// Планировщик сбора по кабинетам (Defly и т.д.).
//
// Как было: один длинный конвейер (каталог -> кампании -> клики -> остатки
// -> аналитика) раз в 2 часа и при каждом старте процесса, причём только
// ПОСЛЕ того, как закончатся WB и Ozon Licio. Весь конвейер шёл 30-60+
// минут, процесс на Render перезапускался раньше — до корзин/заказов дело
// почти не доходило, а блокировка в БД после рестарта ещё и мешала начать
// заново.
//
// Как теперь: несколько коротких независимых задач, у каждой свой интервал и
// своя отметка "когда последний раз успешно" в таблице ad_job_status. Каждые
// 5 минут проверяем, какие задачи "созрели", и выполняем их. Каждая задача
// занимает секунды, поэтому перезапуск процесса почти ничего не теряет, а
// после рестарта продолжаем по отметкам в БД, а не начинаем всё с нуля.
// Кабинет не ждёт WB/Licio — у него свои токены и свои лимиты.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const RETRY_AFTER_FAIL = 10 * MIN;

// Сеть до Ozon с Render иногда блокируется целиком (см. /api/netcheck) — на
// этот случай у каждой задачи есть запасной путь через Google Таблицу: её
// отдельным скриптом (google-apps-script/ozon-sheet-sync.gs) наполняет сам
// Google, у которого такой блокировки нет. Сначала всегда пробуем настоящий
// запрос к Ozon; если он упал — берём то, что успело собраться в таблице.
// Как только сеть разблокируется, всё само вернётся на прямой сбор.
//
// ADS_DIRECT_DISABLED=true — полностью отключает прямой запрос к Ozon и сразу
// идёт в Google Таблицу (быстрее и без лишних таймаутов/логов, пока прямая
// сеть Render -> Ozon стабильно не работает). Поставлено в render.yaml по
// умолчанию. Если сеть когда-нибудь починят — достаточно поставить обратно
// "false" в Render (Environment), код менять не нужно, прямой сбор включится
// автоматически.
// С 09.10.2026 — ВСЕГДА через Google Таблицу (решение владельца: Render в
// Ozon не ходит вообще, все данные Ozon собирает Google-скрипт). Переменная
// ADS_DIRECT_DISABLED больше не учитывается: на Render она стояла в "false",
// и сбор по 4 минуты бился в недоступный Ozon, прежде чем взять таблицу.
const DIRECT_DISABLED = true;

// Подстраховка: axios'овский timeout иногда не покрывает зависший DNS/TCP-
// коннект (бывает на части сетей Render) — запрос к Google может висеть
// заметно дольше указанных 20000мс и так и не долетать до catch. Без этой
// обёртки такой запрос блокирует busy-лок кабинета навсегда (виден в
// /api/ads/data-status как "идёт сбор..." без конца, чинится только
// рестартом процесса). Promise.race гарантирует, что runJob всегда
// получит resolve/reject за разумное время.
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label}: не ответил за ${Math.round(ms / 1000)}с`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function withSheetFallback(cabinet, label, primary, fallback) {
  if (DIRECT_DISABLED) {
    // В Ozon не ходим никогда. Нет ADS_SHEET_ID — честная ошибка, а не
    // 4 минуты таймаутов в недоступный Ozon.
    if (!sheetId()) throw new Error('На этом сервере не задан ADS_SHEET_ID (ссылка на Google-таблицу) — данные Ozon взять неоткуда');
    return await withTimeout(fallback(), 30000, `${label}(таблица)`);
  }
  try {
    return await primary();
  } catch (e) {
    if (!sheetId()) throw e; // фоллбек не настроен — ведём себя как раньше
    console.warn(`[Jobs:${cabinet}] ${label}: Ozon недоступен (${e.message}), беру данные из Google-таблицы`);
    return await withTimeout(fallback(), 30000, `${label}(таблица)`);
  }
}

// Реклама из Google Таблицы: кампании, расход/клики, товары мультитоварных
// РК, а также точные данные по товарам (расход за клик по SKU, заказы
// "оплаты за заказ", её статус и ставки — с авто-записями в журнал).
function perfFromSheet(c) {
  return Promise.all([syncCampaignsFromSheet(c), syncStatsFromSheet(c), syncCampaignSkusFromSheet(c), syncAdDetailsFromSheet(c)])
    .then(([a, b, s, d]) => ({ rows: (a.rows || 0) + (b.rows || 0) + (s.rows || 0) + (d.rows || 0), warning: d.warning || null }));
}

// Порядок важен: каталог нужен раньше всех (SKU -> артикул).
const JOBS = [
  { id: 'catalog', every: 6 * HOUR, run: c => withSheetFallback(c, 'catalog',
      () => collectCatalog(c), () => syncCatalogFromSheet(c)) },
  { id: 'perf', every: 30 * MIN, run: c => withSheetFallback(c, 'perf',
      () => collectAdStats(c, { dateFrom: mskDate(13), dateTo: mskDate(0) }),
      () => perfFromSheet(c)) },
  { id: 'clicks', every: 30 * MIN, run: c => withSheetFallback(c, 'clicks',
      () => collectClicks(c, { dateFrom: mskDate(13), dateTo: mskDate(0) }),
      () => syncStatsFromSheet(c)) },
  { id: 'analytics', every: 30 * MIN, run: c => withSheetFallback(c, 'analytics',
      () => collectProductAnalytics(c, { dateFrom: mskDate(6), dateTo: mskDate(0) }),
      () => syncAnalyticsFromSheet(c)) },
  { id: 'stocks', every: 1 * HOUR, run: c => withSheetFallback(c, 'stocks',
      () => collectProductStocks(c), () => syncStocksFromSheet(c)) },
  // Раз в сутки — полная докачка истории: Ozon задним числом уточняет
  // заказы/выручку (отмены, поздние данные), и так же закрываются любые дыры.
  { id: 'perf_full', every: 20 * HOUR, run: c => withSheetFallback(c, 'perf_full',
      () => collectAdStats(c, { dateFrom: mskDate(59), dateTo: mskDate(0) }),
      () => perfFromSheet(c)) },
  { id: 'clicks_full', every: 20 * HOUR, run: c => withSheetFallback(c, 'clicks_full',
      () => collectClicks(c, { dateFrom: mskDate(59), dateTo: mskDate(0) }),
      () => syncStatsFromSheet(c)) },
  { id: 'analytics_full', every: 20 * HOUR, run: c => withSheetFallback(c, 'analytics_full',
      () => collectProductAnalytics(c, { dateFrom: mskDate(59), dateTo: mskDate(0) }),
      () => syncAnalyticsFromSheet(c)) },
];

// Уведомления о новых заказах (вкладка «Уведомления») — для ВСЕХ кабинетов
// (Licio и Defly), заказы берутся из вкладки Orders Google-таблицы (её
// каждые 5 минут обновляет Google-скрипт, функция syncOrders).
const ORDERS_JOB = { id: 'tracked_orders', every: 4 * MIN, run: c => pollOrdersFromSheet(c) };
function ordersCabinets() {
  return Object.keys(CABINETS);
}
const ordersBusy = new Set();
async function tickOrders(cabinet) {
  if (ordersBusy.has(cabinet)) return;
  ordersBusy.add(cabinet);
  try {
    const st = await getStatus(cabinet);
    if (isDue(ORDERS_JOB, st.get(ORDERS_JOB.id), Date.now())) await runJobGuarded(cabinet, ORDERS_JOB);
  } finally {
    ordersBusy.delete(cabinet);
  }
}

function adsCabinets() {
  return Object.entries(CABINETS)
    .filter(([id, cfg]) => id !== 'licio' && (cfg.ozonClientId || cfg.ozonPerfClientId))
    .map(([id]) => id);
}

// Соинвест (аналог СПП) — отдельная от остальной рекламной аналитики
// задача: интересна ОБОИМ кабинетам (у Licio своя старая аналитика/остатки,
// но Seller API один и тот же), поэтому не ограничиваем adsCabinets().
const DISCOUNT_JOB = { id: 'discounts', every: 20 * MIN, run: c => collectDiscounts(c) };

// ВРЕМЕННО ОТКЛЮЧЕНО (28.09): сеть до Ozon с этого сервера заблокирована
// (см. /api/netcheck) — попытки collectDiscounts всё равно ничего не
// соберут, только впустую бьются в таймауты (5 попыток с задержкой до 60с
// на каждый эндпоинт) и засоряют логи. Включить обратно, когда починим
// сеть (прокси) — просто вернуть исходный фильтр ниже.
const DISCOUNTS_ENABLED = false;
function discountCabinets() {
  if (!DISCOUNTS_ENABLED) return [];
  return Object.entries(CABINETS)
    .filter(([, cfg]) => cfg.ozonClientId && cfg.ozonApiKey)
    .map(([id]) => id);
}
const discBusy = new Set();
async function tickDiscounts(cabinet) {
  if (discBusy.has(cabinet)) return;
  discBusy.add(cabinet);
  try {
    const st = await getStatus(cabinet);
    if (isDue(DISCOUNT_JOB, st.get(DISCOUNT_JOB.id), Date.now())) await runJob(cabinet, DISCOUNT_JOB);
  } finally {
    discBusy.delete(cabinet);
  }
}

// Дайджест Соинвеста — раз в сутки, в момент времени из настроек кабинета
// (вкладка "Настройки" в СПП-мониторе). Проверяем на каждом тике (каждые
// 5 минут): если текущее локальное время кабинета попало в 5-минутное окно
// вокруг digestTime и сегодня ещё не отправляли — шлём.
const digestBusy = new Set();
async function tickDigest(cabinet) {
  if (digestBusy.has(cabinet)) return;
  digestBusy.add(cabinet);
  try {
    const settings = await getSettings(cabinet);
    if (!settings.digestEnabled) return;
    const tz = settings.timezone || 'Europe/Moscow';
    const now = dayjs().tz(tz);
    const [dh, dm] = (settings.digestTime || '09:00').split(':').map(Number);
    const target = now.hour(dh).minute(dm).second(0);
    if (Math.abs(now.diff(target, 'minute')) > 5) return;

    const st = await getStatus(cabinet);
    const last = st.get('discount_digest')?.last_success_at;
    if (last && dayjs(last).tz(tz).format('YYYY-MM-DD') === now.format('YYYY-MM-DD')) return;

    const sent = await sendDiscountDigest(cabinet).catch(e => { console.warn('[Digest] telegram:', e.message); return false; });
    if (sent) await mark(cabinet, 'discount_digest', { last_success_at: new Date() });
  } finally {
    digestBusy.delete(cabinet);
  }
}

async function getStatus(cabinet) {
  try {
    const rows = await query(`SELECT * FROM ad_job_status WHERE cabinet = $1`, [cabinet]);
    return new Map(rows.map(r => [r.job, r]));
  } catch (e) { return new Map(); }
}

async function mark(cabinet, job, patch) {
  const cols = Object.keys(patch);
  const sets = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
  try {
    await query(
      `INSERT INTO ad_job_status (cabinet, job, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')})
       ON CONFLICT (cabinet, job) DO UPDATE SET ${sets}`,
      [cabinet, job, ...cols.map(c => patch[c])]);
  } catch (e) { console.warn('[Jobs] статус не сохранён:', e.message); }
}

async function logRun(cabinet, job, status, records, error) {
  try {
    await query(`INSERT INTO collection_log (platform,collector_type,status,records_collected,error_message,finished_at)
                 VALUES ($1,$2,$3,$4,$5,NOW())`, [cabinet, `ads_${job}`, status, records || 0, error || null]);
  } catch (e) { /* не критично */ }
}

function isDue(job, st, now) {
  if (!st || !st.last_success_at) {
    // Никогда не было успеха: пробуем сразу, после неудачи — через паузу.
    return !st?.last_started_at || now - new Date(st.last_started_at).getTime() > RETRY_AFTER_FAIL;
  }
  const sinceSuccess = now - new Date(st.last_success_at).getTime();
  if (sinceSuccess < job.every) return false;
  const lastFailed = st.last_error_at && new Date(st.last_error_at) > new Date(st.last_success_at);
  if (lastFailed && now - new Date(st.last_error_at).getTime() < RETRY_AFTER_FAIL) return false;
  return true;
}

// Доп. подстраховка на уровень выше withSheetFallback: даже если зависнет
// что-то совсем другое (например, mark() в начале runJob ждёт свободного
// соединения из пула, или сам Google CSV не словился таймаутом axios) —
// runJobGuarded всё равно отпустит busy-лок кабинета за HARD_JOB_TIMEOUT.
// Без этого один зависший job навсегда показывает "идёт сбор..." даже
// после всех внутренних таймаутов.
const HARD_JOB_TIMEOUT = 45 * 1000;
async function runJobGuarded(cabinet, job, runFn) {
  try {
    await withTimeout(runJob(cabinet, job, runFn), HARD_JOB_TIMEOUT, `${job.id}(watchdog)`);
  } catch (e) {
    console.error(`[Jobs:${cabinet}] ${job.id}: не снялся за ${HARD_JOB_TIMEOUT / 1000}с, принудительно считаю ошибкой —`, e.message);
    mark(cabinet, job.id, { last_error_at: new Date(), last_error: e.message }).catch(() => {});
  }
}

async function runJob(cabinet, job, runFn) {
  const t0 = Date.now();
  await mark(cabinet, job.id, { last_started_at: new Date() });
  try {
    const res = await (runFn || job.run)(cabinet);
    const rows = res?.rows ?? (typeof res === 'number' ? res : 0);
    await mark(cabinet, job.id, { last_success_at: new Date(), last_rows: rows, last_duration_ms: Date.now() - t0, last_warning: res?.warning || null });
    await logRun(cabinet, job.id, 'success', rows, res?.warning || null);
    return true;
  } catch (e) {
    const msg = (e.message || String(e)).slice(0, 1000);
    console.error(`[Jobs:${cabinet}] ${job.id}:`, msg);
    await mark(cabinet, job.id, { last_error_at: new Date(), last_error: msg, last_duration_ms: Date.now() - t0 });
    await logRun(cabinet, job.id, 'error', 0, msg);
    return false;
  }
}

const busy = new Map();       // cabinet -> id текущей задачи
const forced = new Map();     // cabinet -> { days } запрос ручного обновления

async function tickCabinet(cabinet) {
  if (busy.has(cabinet)) return;
  busy.set(cabinet, 'start');
  try {
    // Ручное обновление с кнопки — все основные задачи сразу, за нужный период.
    const force = forced.get(cabinet);
    if (force) {
      forced.delete(cabinet);
      const days = Math.max(7, Math.min(90, force.days || 30));
      const st = await getStatus(cabinet);
      const catalogAge = st.get('catalog')?.last_success_at ? Date.now() - new Date(st.get('catalog').last_success_at).getTime() : Infinity;
      // ВАЖНО: эти 3 задачи раньше звали collectAdStats/collectClicks/
      // collectProductAnalytics НАПРЯМУЮ, в обход withSheetFallback — то
      // есть кнопка "Обновить данные" всегда била в Ozon напрямую, даже при
      // ADS_DIRECT_DISABLED=true, и могла висеть по 4-8 минут на таймаутах.
      // Теперь обёрнуты так же, как и обычный job.run, просто с периодом
      // days (а не дефолтным) — фоллбек и флаг отключения работают одинаково
      // что по расписанию, что по кнопке.
      const plan = [
        ...(catalogAge > HOUR ? [[JOBS[0], null]] : []),
        [JOBS[1], c => withSheetFallback(c, 'perf(forced)',
            () => collectAdStats(c, { dateFrom: mskDate(days - 1), dateTo: mskDate(0) }),
            () => perfFromSheet(c))],
        [JOBS[2], c => withSheetFallback(c, 'clicks(forced)',
            () => collectClicks(c, { dateFrom: mskDate(days - 1), dateTo: mskDate(0) }),
            () => syncStatsFromSheet(c))],
        [JOBS[3], c => withSheetFallback(c, 'analytics(forced)',
            () => collectProductAnalytics(c, { dateFrom: mskDate(days - 1), dateTo: mskDate(0) }),
            () => syncAnalyticsFromSheet(c))],
        [JOBS[4], null],
      ];
      for (const [job, fn] of plan) { busy.set(cabinet, job.id); await runJobGuarded(cabinet, job, fn); }
    }
    const st = await getStatus(cabinet);
    const now = Date.now();
    for (const job of JOBS) {
      if (!isDue(job, st.get(job.id), now)) continue;
      busy.set(cabinet, job.id);
      await runJobGuarded(cabinet, job);
    }
  } finally {
    busy.delete(cabinet);
    if (forced.has(cabinet)) setTimeout(() => tickCabinet(cabinet).catch(() => {}), 1000);
  }
}

async function tick() {
  await Promise.all([
    ...adsCabinets().map(c => tickCabinet(c).catch(e => console.error(`[Jobs:${c}]`, e.message))),
    ...discountCabinets().map(c => tickDiscounts(c).catch(e => console.error(`[Discounts:${c}]`, e.message))),
    // Дайджест Соинвеста работает по данным из расширения — для всех кабинетов.
    ...Object.keys(CABINETS).map(c => tickDigest(c).catch(e => console.error(`[Digest:${c}]`, e.message))),
    ...ordersCabinets().map(c => tickOrders(c).catch(e => console.error(`[Orders:${c}]`, e.message))),
  ]);
}

function requestRefresh(cabinet, days) {
  forced.set(cabinet, { days });
  tickCabinet(cabinet).catch(e => console.error(`[Jobs:${cabinet}]`, e.message));
  return busy.has(cabinet);
}

function currentJob(cabinet) { return busy.get(cabinet) || null; }

let started = false;
function startAdsJobs() {
  if (started) return;
  started = true;
  // Чистка ДО первого тика — чтобы следующий сбор не сравнивал новые данные с мусором.
  setTimeout(() => cleanupSheetJunk().catch(() => {}).finally(() => tick().catch(() => {})), 10 * 1000);
  setInterval(() => tick().catch(() => {}), 5 * MIN);
  console.log(`⏰ Сбор кабинетов (${adsCabinets().join(', ') || 'нет'}): проверка каждые 5 мин`);
  console.log(`⏰ Соинвест/СПП (${discountCabinets().join(', ') || 'нет'}): проверка каждые 5 мин`);
}

module.exports = { startAdsJobs, requestRefresh, currentJob, getStatus, JOBS, adsCabinets, discountCabinets };
