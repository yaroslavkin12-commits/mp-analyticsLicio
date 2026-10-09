require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { testConnection, initSchema, query } = require('./db');
const { startScheduler } = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(require('compression')());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
// Короткий кэш тяжёлых отчётов (вкладки «Реклама» и «Аналитика продаж»):
// повторное открытие раздела отдаётся сразу. Любое изменение (POST/PUT/
// DELETE) в этих разделах кэш сбрасывает; данные с маркетплейса и так
// обновляются раз в несколько минут.
const reportCache = new Map();
const CACHE_TTL = 3 * 60 * 1000;
const CACHED = ['/api/ads/stats', '/api/promo/stats', '/api/sales/data', '/api/sales/costs', '/api/sales/geo'];
app.use((req, res, next) => {
  if (req.method !== 'GET') {
    if (req.path.startsWith('/api/ads') || req.path.startsWith('/api/promo') || req.path.startsWith('/api/sales') || req.path.startsWith('/api/settings')) reportCache.clear();
    return next();
  }
  if (!CACHED.includes(req.path) || req.query.fresh) return next();
  const key = req.originalUrl;
  const hit = reportCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) { res.set('X-Cache', 'hit'); return res.type('json').send(hit.body); }
  const json = res.json.bind(res);
  res.json = body => {
    if (res.statusCode === 200 && body && body.success) {
      if (reportCache.size > 60) reportCache.clear();
      reportCache.set(key, { at: Date.now(), body: JSON.stringify(body) });
    }
    return json(body);
  };
  next();
});
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/settings',  require('./routes/settings'));
app.use('/api/analytics', require('./routes/analytics'));

// /api/promo — то же, что /api/ads: блокировщики рекламы режут запросы с «/ads/» в адресе.
const adsRouter = require('./routes/ads');
app.use('/api/ads', adsRouter);
app.use('/api/promo', adsRouter);
app.use('/api/sales', require('./routes/sales'));
app.use('/api/discounts', require('./routes/discounts'));
app.use('/api/tracked-articles', require('./routes/trackedArticles'));
// Какие настройки заданы на ЭТОМ сервере (только да/нет, без значений) —
// чтобы сравнить два сервиса Render между собой.
app.get('/api/env-check', (req, res) => {
  const has = k => !!(process.env[k] && String(process.env[k]).trim());
  res.json({ success: true, data: {
    service: process.env.RENDER_SERVICE_NAME || null,
    ADS_SHEET_ID: has('ADS_SHEET_ID'), TELEGRAM_BOT_TOKEN: has('TELEGRAM_BOT_TOKEN'), TELEGRAM_CHAT_ID: has('TELEGRAM_CHAT_ID'),
    DATABASE_URL: has('DATABASE_URL'), WB_TOKEN: has('WB_TOKEN'),
    OZON_CLIENT_ID: has('OZON_CLIENT_ID'), DEFLY_OZON_CLIENT_ID: has('DEFLY_OZON_CLIENT_ID'),
    OZON_SELLER_COOKIE: has('OZON_SELLER_COOKIE'),
  } });
});
app.use('/api/netcheck', require('./routes/netcheck')); // ВРЕМЕННО: диагностика таймаутов Ozon 28.09, убрать после

const distPath = path.join(__dirname, '../../dashboard/dist');
app.use(express.static(distPath));
app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));

async function start() {
  let retries = 15;
  while (retries--) {
    const ok = await testConnection();
    if (ok) break;
    console.log(`Жду БД... (${retries})`);
    await new Promise(r => setTimeout(r, 4000));
  }
  await initSchema();
  app.listen(PORT, () => {
    console.log(`🚀 Сервер: http://localhost:${PORT}`);
    startScheduler();
    startKeepAlive();
    query(`INSERT INTO collection_log (platform,collector_type,status,records_collected,error_message,finished_at)
           VALUES ('system','process_start','success',0,$1,NOW())`,
          [`mem ${Math.round(process.memoryUsage().rss / 1048576)}MB`]).catch(() => {});
  });
}

// Render (бесплатный тариф) усыпляет сервис через ~15 минут без входящих
// запросов — вместе с ним засыпает и планировщик сбора. GitHub Actions
// (keepalive.yml) стучится нерегулярно: расписание там часто сдвигается на
// десятки минут. Поэтому сервис сам раз в 10 минут обращается к своему же
// публичному адресу — запрос проходит через внешний балансировщик Render и
// считается входящим трафиком.
function startKeepAlive() {
  const base = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
  if (!base) return;
  const ping = () => require('axios').get(`${base.replace(/\/$/, '')}/health`, { timeout: 20000 }).catch(() => {});
  setInterval(ping, 10 * 60 * 1000);
  console.log(`💓 Keep-alive: ${base}/health каждые 10 мин`);
}

// Необработанная ошибка в любом фоновом сборщике не должна ронять весь
// процесс (в Node это по умолчанию завершает процесс, а Render его потом
// перезапускает — и все текущие сборы обрываются).
process.on('unhandledRejection', e => console.error('unhandledRejection:', e?.message || e));
process.on('uncaughtException', e => console.error('uncaughtException:', e?.message || e));

start().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
