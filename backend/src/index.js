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
app.use(express.json({ limit: '10mb', verify: (req, res, buffer) => { if (req.originalUrl.split('?')[0] === '/api/wb/import') req.wbRawBody = buffer; } }));

app.use((req, res, next) => { if ((req.query.cabinet || req.body?.cabinet) === 'defly_wb' && /^\/api\/(finance|sales|ads|promo|discounts|stocks|queries|orders)(\/|$)/.test(req.path)) return res.status(409).json({ success: false, error: 'Этот раздел Ozon не используется для WB. Финансы Defly WB пока не подключены.' }); next(); });

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
// Короткий кэш тяжёлых отчётов (вкладки «Реклама» и «Аналитика продаж»):
// повторное открытие раздела отдаётся сразу. Любое изменение (POST/PUT/
// DELETE) в этих разделах кэш сбрасывает; данные с маркетплейса и так
// обновляются раз в несколько минут.
// Кэш живёт, пока не изменились данные (lib/dataVersion: сбор реально что-то
// записал или пользователь что-то сохранил), но не дольше 2 часов — так
// повторные открытия разделов не гоняют из базы одно и то же.
const reportCache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000;
const dataVersion = require('./lib/dataVersion');
const cacheFresh = h => h && h.ver === dataVersion.get() && Date.now() - h.at < CACHE_TTL;
const CACHED = ['/api/wb/views/sales/data', '/api/wb/views/promo/stats', '/api/wb/views/stocks/data','/api/ads/stats', '/api/promo/stats', '/api/sales/data', '/api/sales/costs', '/api/sales/geo', '/api/finance/coefs', '/api/finance/pnl', '/api/finance/buyout', '/api/finance/calc-base', '/api/stocks/data', '/api/queries/data', '/api/queries/season'];
app.use((req, res, next) => {
  if (req.path === '/api/wb/import') return next(); // кэши обновляются после приёма целого набора
  // Шаблоны конструктора и «отшивается» отчёты не меняют — кэш не трогаем.
  if (req.method !== 'GET' && (req.path === '/api/sales/builder-templates' || req.path === '/api/sales/sewing' || req.path.startsWith('/api/production') || req.path.startsWith('/api/pricelog'))) return next();
  if (req.method !== 'GET') {
    // Любое сохранение может поменять отчёты (себестоимость, категории, группы…).
    // Расширение СПП присылает цены часто — от него сбрасываем только калькулятор.
    if (/^\/api\/(ads|promo)\/transit/.test(req.path)) return next(); // ручной «В пути» — отчёты не пересчитываем
    if (req.path.startsWith('/api/discounts')) { for (const k of reportCache.keys()) if (k.startsWith('/api/finance/calc-base')) reportCache.delete(k); }
    else dataVersion.bump();
    if (req.path.startsWith('/api/tracked-articles')) require('./collectors/trackedOrdersPoll').dropTrackedCache();
    if (req.path.startsWith('/api/ads') || req.path.startsWith('/api/promo') || req.path.startsWith('/api/sales') || req.path.startsWith('/api/settings')) reportCache.clear();
    return next();
  }
  if (!CACHED.includes(req.path) || req.query.fresh) return next();
  const key = req.originalUrl;
  const hit = reportCache.get(key);
  if (cacheFresh(hit)) { res.set('X-Cache', 'hit'); return res.type('json').send(hit.body); }
  // Тяжёлые отчёты считаются не больше двух одновременно (остальные ждут
  // очереди): при открытии сервиса все разделы просят данные разом, и
  // параллельный расчёт не помещался в память сервера (512 МБ).
  // Одинаковые запросы, пришедшие пока первый считается, ждут его результат.
  if (inflight.has(key)) {
    return inflight.get(key).then(() => {
      const h = reportCache.get(key);
      if (h) { res.set('X-Cache', 'shared'); return res.type('json').send(h.body); }
      return runHeavy(req, res, next, key);
    });
  }
  return runHeavy(req, res, next, key);
});
const inflight = new Map();
function runHeavy(req, res, next, key) {
  let settle;
  inflight.set(key, new Promise(r => { settle = r; }));
  const finishFlight = () => { if (inflight.has(key)) { inflight.delete(key); settle(); } };
  let gone = false;
  res.on('close', () => { gone = true; });
  heavyAcquire(() => gone).then(release => {
    let done = false;
    const free = () => { if (!done) { done = true; release(); finishFlight(); } };
    // Клиент ушёл, пока ждали очереди, — место сразу освобождаем (раньше оно
    // терялось навсегда, и через пару таймаутов очередь вставала целиком).
    if (gone || res.writableEnded || res.destroyed) { free(); return; }
    res.on('finish', free); res.on('close', free);
    // Страховка: место в очереди не держим дольше 2 минут.
    setTimeout(free, 120000).unref?.();
    const again = reportCache.get(key);
    if (cacheFresh(again)) { res.set('X-Cache', 'hit'); return res.type('json').send(again.body); }
    const ver = dataVersion.get(); // версия на момент начала расчёта
    const json = res.json.bind(res);
    res.json = body => {
      if (res.statusCode === 200 && body && body.success) {
        const str = JSON.stringify(body);
        reportCache.set(key, { at: Date.now(), ver, body: str, size: str.length });
        // Кэш не больше ~60 МБ: выкидываем самые старые записи.
        let total = 0; for (const v of reportCache.values()) total += v.size || 0;
        for (const [k, v] of reportCache) { if (total <= 60e6) break; total -= v.size || 0; reportCache.delete(k); }
        return res.type('json').send(str);
      }
      return json(body);
    };
    next();
  });
}
let heavyActive = 0;
const heavyQueue = [];
// isGone() — клиент уже отключился: такую заявку из очереди пропускаем.
function heavyAcquire(isGone = () => false) {
  return new Promise(resolve => {
    const release = () => {
      heavyActive = Math.max(0, heavyActive - 1);
      while (heavyQueue.length) {
        const n = heavyQueue.shift();
        if (n.isGone()) { n.resolveNoop(); continue; }
        n.go(); break;
      }
    };
    const go = () => { heavyActive++; resolve(release); };
    if (heavyActive < 2) go();
    else heavyQueue.push({ go, isGone, resolveNoop: () => resolve(() => {}) });
  });
}
app.use('/api/wb', require('./routes/wb'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/settings',  require('./routes/settings'));
app.use('/api/analytics', require('./routes/analytics'));

// /api/promo — то же, что /api/ads: блокировщики рекламы режут запросы с «/ads/» в адресе.
const adsRouter = require('./routes/ads');
app.use('/api/ads', adsRouter);
app.use('/api/promo', adsRouter);
app.use('/api/sales', require('./routes/sales'));
app.use('/api/production', require('./routes/production'));
app.use('/api/pricelog', require('./routes/pricelog'));
app.use('/api/clusters', require('./routes/clusters'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/discounts', require('./routes/discounts'));
app.use('/api/finance', require('./routes/finance'));
app.use('/api/stocks', require('./routes/stocks'));
app.use('/api/digest', require('./routes/digest'));
app.use('/api/plan', require('./routes/plan'));
app.use('/api/queries', require('./routes/queries'));
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
// Файлы сборки с хешем в имени (assets/*) не меняются — браузер хранит их год
// и при повторном открытии не качает заново; index.html — всегда свежий.
app.use(express.static(distPath, {
  setHeaders: (res, file) => {
    if (/[\\/]assets[\\/]/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.get('*', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(distPath, 'index.html')); });

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
