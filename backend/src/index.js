require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { testConnection, initSchema, query } = require('./db');
const { startScheduler } = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/settings',  require('./routes/settings'));
app.use('/api/analytics', require('./routes/analytics'));

app.use('/api/ads', require('./routes/ads'));

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
