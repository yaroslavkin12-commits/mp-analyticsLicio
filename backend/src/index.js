require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { testConnection, initSchema } = require('./db');
const { startScheduler } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// API routes
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/settings', require('./routes/settings'));

// Отдаём React-дашборд (папка dashboard/dist собирается при деплое)
const distPath = path.join(__dirname, '../../dashboard/dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

async function start() {
  let retries = 15;
  while (retries--) {
    const ok = await testConnection();
    if (ok) break;
    console.log(`Жду базу данных... (осталось попыток: ${retries})`);
    await new Promise(r => setTimeout(r, 4000));
  }

  await initSchema();

  app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
    startScheduler();
  });
}

start().catch(e => {
  console.error('Ошибка запуска:', e.message);
  process.exit(1);
});
