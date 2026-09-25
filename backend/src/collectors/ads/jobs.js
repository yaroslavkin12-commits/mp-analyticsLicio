const { query } = require('../../db');
const { CABINETS } = require('../../config/cabinets');
const { mskDate } = require('./ozonHttp');
const { collectCatalog } = require('./ozonCatalog');
const { collectAdStats } = require('./ozonPerf');
const { collectClicks } = require('./ozonClicks');
const { collectProductAnalytics } = require('./ozonProductAnalytics');
const { collectProductStocks } = require('./ozonProductStocks');
const { collectDiscounts } = require('./ozonDiscounts');

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

// Порядок важен: каталог нужен раньше всех (SKU -> артикул).
const JOBS = [
  { id: 'catalog',        every: 6 * HOUR,  run: c => collectCatalog(c) },
  { id: 'perf',           every: 30 * MIN,  run: c => collectAdStats(c, { dateFrom: mskDate(13), dateTo: mskDate(0) }) },
  { id: 'clicks',         every: 30 * MIN,  run: c => collectClicks(c, { dateFrom: mskDate(13), dateTo: mskDate(0) }) },
  { id: 'analytics',      every: 30 * MIN,  run: c => collectProductAnalytics(c, { dateFrom: mskDate(6), dateTo: mskDate(0) }) },
  { id: 'stocks',         every: 1 * HOUR,  run: c => collectProductStocks(c) },
  // Раз в сутки — полная докачка истории: Ozon задним числом уточняет
  // заказы/выручку (отмены, поздние данные), и так же закрываются любые дыры.
  { id: 'perf_full',      every: 20 * HOUR, run: c => collectAdStats(c, { dateFrom: mskDate(59), dateTo: mskDate(0) }) },
  { id: 'clicks_full',    every: 20 * HOUR, run: c => collectClicks(c, { dateFrom: mskDate(59), dateTo: mskDate(0) }) },
  { id: 'analytics_full', every: 20 * HOUR, run: c => collectProductAnalytics(c, { dateFrom: mskDate(59), dateTo: mskDate(0) }) },
];

function adsCabinets() {
  return Object.entries(CABINETS)
    .filter(([id, cfg]) => id !== 'licio' && (cfg.ozonClientId || cfg.ozonPerfClientId))
    .map(([id]) => id);
}

// Соинвест (аналог СПП) — отдельная от остальной рекламной аналитики
// задача: интересна ОБОИМ кабинетам (у Licio своя старая аналитика/остатки,
// но Seller API один и тот же), поэтому не ограничиваем adsCabinets().
const DISCOUNT_JOB = { id: 'discounts', every: 20 * MIN, run: c => collectDiscounts(c) };
function discountCabinets() {
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
      const plan = [
        ...(catalogAge > HOUR ? [[JOBS[0], null]] : []),
        [JOBS[1], c => collectAdStats(c, { dateFrom: mskDate(days - 1), dateTo: mskDate(0) })],
        [JOBS[2], c => collectClicks(c, { dateFrom: mskDate(days - 1), dateTo: mskDate(0) })],
        [JOBS[3], c => collectProductAnalytics(c, { dateFrom: mskDate(days - 1), dateTo: mskDate(0) })],
        [JOBS[4], null],
      ];
      for (const [job, fn] of plan) { busy.set(cabinet, job.id); await runJob(cabinet, job, fn); }
    }
    const st = await getStatus(cabinet);
    const now = Date.now();
    for (const job of JOBS) {
      if (!isDue(job, st.get(job.id), now)) continue;
      busy.set(cabinet, job.id);
      await runJob(cabinet, job);
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
  setTimeout(() => tick().catch(() => {}), 10 * 1000);
  setInterval(() => tick().catch(() => {}), 5 * MIN);
  console.log(`⏰ Сбор кабинетов (${adsCabinets().join(', ') || 'нет'}): проверка каждые 5 мин`);
  console.log(`⏰ Соинвест/СПП (${discountCabinets().join(', ') || 'нет'}): проверка каждые 5 мин`);
}

module.exports = { startAdsJobs, requestRefresh, currentJob, getStatus, JOBS, adsCabinets, discountCabinets };
