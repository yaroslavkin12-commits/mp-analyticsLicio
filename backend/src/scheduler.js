const cron = require('node-cron');
const dayjs = require('dayjs');
const { query } = require('./db');

const { collectOrders: wbOrders } = require('./collectors/wb/orders');
const { collectSales: wbSales }   = require('./collectors/wb/sales');
const { collectStocks: wbStocks } = require('./collectors/wb/stocks');
const { collectAds: wbAds }       = require('./collectors/wb/ads');

const { collectOrders: ozOrders }       = require('./collectors/ozon/orders');
const { collectAnalytics: ozAnalytics } = require('./collectors/ozon/analytics');
const { collectStocks: ozStocks }       = require('./collectors/ozon/stocks');
const { collectAds: ozAds }             = require('./collectors/ozon/ads');

const delay = ms => new Promise(r => setTimeout(r, ms));

// Через сколько повторить WB-сбор, если он упал (например по 429) — не ждать
// следующего случайного захода на сайт, а самим попробовать ещё раз чуть позже.
const WB_RETRY_DELAY_MS = 6 * 60 * 1000;

async function log(platform, type, status, records = 0, error = null) {
  try {
    await query(
      `INSERT INTO collection_log (platform,collector_type,status,records_collected,error_message,finished_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [platform, type, status, records, error]
    );
  } catch(e) { /* non-critical */ }
}

// Возвращает { ok, count } — раньше run() ничего не возвращал, из-за чего
// вызывающий код не мог узнать, что сбор упал, и никак на это не реагировал.
async function run(name, platform, type, fn, dateFrom) {
  console.log(`▶ ${name}...`);
  try {
    const count = await fn(dateFrom);
    await log(platform, type, 'success', count);
    console.log(`✅ ${name}: ${count} записей`);
    return { ok: true, count };
  } catch(e) {
    console.error(`❌ ${name}:`, e.message);
    await log(platform, type, 'error', 0, e.message);
    return { ok: false, count: 0 };
  }
}

// Дата последнего УСПЕШНОГО сбора по площадке (по любому из её коллекторов).
// Нужна, чтобы при рестарте (Render "просыпается" после сна) не гнать заново
// слепой 30-дневный бэкфилл, а докатить только реально пропущенный период —
// это и быстрее, и не долбит WB лишними запросами, провоцируя 429.
async function lastSuccessDate(platform) {
  try {
    const [row] = await query(
      `SELECT MAX(finished_at) as t FROM collection_log WHERE platform = $1 AND status = 'success'`,
      [platform]
    );
    return row?.t ? dayjs(row.t) : null;
  } catch(e) { return null; }
}

// dateFrom для докатки: от даты последнего успеха (с запасом в 1 день на случай
// частично собранных суток), но не больше MAX_BACKFILL_DAYS назад и не позже
// сегодняшнего дня минус минимум, если данных вообще никогда не было.
async function catchUpFrom(platform, maxBackfillDays) {
  const last = await lastSuccessDate(platform);
  const floor = dayjs().subtract(maxBackfillDays, 'day');
  if (!last || last.isBefore(floor)) return floor.format('YYYY-MM-DD');
  return last.subtract(1, 'day').format('YYYY-MM-DD');
}

async function runWB(dateFrom, { isRetry = false } = {}) {
  if (process.env.WB_ENABLED === 'false' || !process.env.WB_TOKEN) {
    console.log('[WB] Отключён'); return;
  }
  console.log(`\n=== WB${isRetry ? ' (повтор после сбоя)' : ''} ===`);
  const results = [];
  results.push(await run('WB Заказы',  'wb', 'orders', wbOrders, dateFrom));
  await delay(3000); // пауза между запросами WB
  results.push(await run('WB Продажи', 'wb', 'sales',  wbSales,  dateFrom));
  await delay(3000);
  results.push(await run('WB Остатки', 'wb', 'stocks', wbStocks));
  await delay(2000);
  await run('WB Реклама', 'wb', 'ads', wbAds, dateFrom);

  // Если что-то упало (обычно 429 после долгого простоя сервиса) — не оставляем
  // эти дни несобранными до следующего случайного захода на сайт, а сами
  // пробуем ещё раз через паузу. Повторяем только один раз, чтобы не зациклиться.
  const hadFailure = results.some(r => !r.ok);
  if (hadFailure && !isRetry) {
    console.log(`[WB] Часть сборов не удалась — повтор через ${WB_RETRY_DELAY_MS / 60000} мин.`);
    setTimeout(() => {
      runWB(dateFrom, { isRetry: true }).catch(e => console.error('[WB] Повтор не удался:', e.message));
    }, WB_RETRY_DELAY_MS);
  }
}

async function runOzon(dateFrom) {
  if (process.env.OZON_ENABLED === 'false' || !process.env.OZON_CLIENT_ID) {
    console.log('[Ozon] Отключён'); return;
  }
  console.log('\n=== OZON ===');
  await run('Ozon Заказы',    'ozon', 'orders',    ozOrders,    dateFrom);
  await run('Ozon Аналитика', 'ozon', 'analytics', ozAnalytics, dateFrom);
  await run('Ozon Остатки',   'ozon', 'stocks',    ozStocks);
  await run('Ozon Реклама',   'ozon', 'ads',       ozAds,       dateFrom);
}

async function runAll(dateFrom) {
  console.log(`\n🚀 Сбор данных ${dayjs().format('DD.MM.YYYY HH:mm')}`);
  await runWB(dateFrom);
  await runOzon(dateFrom);
  console.log(`✅ Готово ${dayjs().format('HH:mm')}\n`);
}

function startScheduler() {
  const hours = parseInt(process.env.COLLECT_INTERVAL_HOURS) || 2;
  cron.schedule(`0 */${hours} * * *`, () => {
    runAll(dayjs().subtract(3,'day').format('YYYY-MM-DD')).catch(console.error);
  });
  console.log(`⏰ Сбор каждые ${hours} ч.`);

  // Запуск вскоре после старта процесса. Render (бесплатный тариф) "усыпляет"
  // сервис без трафика и процесс перезапускается заново при каждом заходе —
  // раньше это всегда гнало слепой 30-дневный бэкфилл по всем площадкам сразу,
  // что и было одной из причин 429 у WB. Теперь докатываем только реально
  // пропущенный период (по факту последнего успешного сбора в collection_log),
  // а не жёстко 30 дней каждый раз.
  setTimeout(async () => {
    const [wbFrom, ozFrom] = await Promise.all([
      catchUpFrom('wb', 30),
      catchUpFrom('ozon', 30),
    ]);
    console.log(`🔄 Первый запуск: WB с ${wbFrom}, Ozon с ${ozFrom}`);
    await runWB(wbFrom);
    await runOzon(ozFrom);
  }, 8000);
}

module.exports = { startScheduler, runAll, runWB, runOzon };
