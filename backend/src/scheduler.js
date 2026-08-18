const cron = require('node-cron');
const dayjs = require('dayjs');
const { query } = require('./db');

const { collectOrders: wbOrders } = require('./collectors/wb/orders');
const { collectSales: wbSales }   = require('./collectors/wb/sales');
const { collectStocks: wbStocks } = require('./collectors/wb/stocks');
const { collectAds: wbAds }       = require('./collectors/wb/ads');
const { collectOrders: ozOrders }     = require('./collectors/ozon/orders');
const { collectAnalytics: ozAnalytics } = require('./collectors/ozon/analytics');
const { collectStocks: ozStocks }     = require('./collectors/ozon/stocks');
const { collectAds: ozAds }           = require('./collectors/ozon/ads');

async function log(platform, type, status, records = 0, error = null) {
  try {
    await query(
      `INSERT INTO collection_log (platform,collector_type,status,records_collected,error_message,finished_at)
       VALUES (?,?,?,?,?,NOW())`,
      [platform, type, status, records, error]
    );
  } catch(e) {}
}

async function run(name, platform, type, fn, dateFrom) {
  console.log(`▶ ${name}...`);
  try {
    const count = await fn(dateFrom);
    await log(platform, type, 'success', count);
    console.log(`✅ ${name}: ${count}`);
  } catch(e) {
    console.error(`❌ ${name}:`, e.message);
    await log(platform, type, 'error', 0, e.message);
  }
}

async function runWB(dateFrom) {
  if (process.env.WB_ENABLED === 'false' || !process.env.WB_TOKEN) { console.log('[WB] Отключён'); return; }
  console.log('\n=== WB ===');
  await run('WB Заказы',  'wb', 'orders', wbOrders, dateFrom);
  await run('WB Продажи', 'wb', 'sales',  wbSales,  dateFrom);
  await run('WB Остатки', 'wb', 'stocks', wbStocks);
  await run('WB Реклама', 'wb', 'ads',    wbAds,    dateFrom);
}

async function runOzon(dateFrom) {
  if (process.env.OZON_ENABLED === 'false' || !process.env.OZON_CLIENT_ID) { console.log('[Ozon] Отключён'); return; }
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
  setTimeout(() => {
    console.log('🔄 Первый запуск: данные за 30 дней');
    runAll(dayjs().subtract(30,'day').format('YYYY-MM-DD')).catch(console.error);
  }, 8000);
}

module.exports = { startScheduler, runAll, runWB, runOzon };
