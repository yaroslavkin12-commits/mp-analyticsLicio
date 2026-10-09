const express = require('express');
const router = express.Router();
const {
  listTracked, addTracked, removeTracked, getFeed,
  listGroups, addGroup, removeGroup, setArticleGroup,
} = require('../collectors/trackedArticles');

// GET /api/tracked-articles?cabinet=licio — список отслеживаемых артикулов.
router.get('/', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'licio';
    res.json({ success: true, data: await listTracked(cabinet) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/tracked-articles/health?cabinet=defly — всё ли настроено для
// уведомлений: Telegram (токен и чат заданы), откуда берутся заказы
// (вкладка Orders Google-таблицы) и когда их последний раз проверяли.
router.get('/health', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'licio';
    const { query } = require('../db');
    const { fetchSheetRows } = require('../collectors/ads/sheetSync');
    let sheetRows = null, sheetError = null, newest = null;
    try {
      const rows = await fetchSheetRows('Orders');
      if (rows) {
        const mine = rows.filter(r => r.cabinet === cabinet);
        sheetRows = mine.length;
        newest = mine.map(r => r.created_at).filter(Boolean).sort().pop() || null;
      }
    } catch (e) { sheetError = e.message; }
    const st = await query(`SELECT last_success_at, last_error_at, last_error, last_rows FROM ad_job_status WHERE cabinet = $1 AND job = 'tracked_orders'`, [cabinet]).catch(() => []);
    res.json({ success: true, data: {
      telegramConfigured: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
      ordersSheet: { rows: sheetRows, newestOrderAt: newest, error: sheetError },
      lastCheck: st[0] || null,
    } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/tracked-articles/test-telegram — отправить пробное сообщение
// (кнопка «Проверить Telegram» на вкладке «Уведомления»).
router.post('/test-telegram', async (req, res) => {
  try {
    const { sendMessage } = require('../telegram');
    const sent = await sendMessage('✅ Проверка связи: уведомления о заказах будут приходить сюда.');
    res.json({ success: true, data: { sent } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.response?.data?.description || e.message });
  }
});

// GET /api/tracked-articles/feed?cabinet=licio — лента отправленных уведомлений.
router.get('/feed', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'licio';
    res.json({ success: true, data: await getFeed(cabinet) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/tracked-articles/groups?cabinet=licio — тестируемые группы
// (с суммарным кол-вом артикулов и заказов по каждой).
router.get('/groups', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'licio';
    res.json({ success: true, data: await listGroups(cabinet) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/tracked-articles/groups — создать тестируемую группу.
// body: { cabinet, name }
router.post('/groups', async (req, res) => {
  try {
    const { cabinet = 'licio', name } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: 'Нужно название группы' });
    }
    res.json({ success: true, data: await addGroup(cabinet, name) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/tracked-articles/groups/:id?cabinet=licio — удалить группу
// (сами артикулы остаются, просто становятся "без группы").
router.delete('/groups/:id', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'licio';
    await removeGroup(cabinet, req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/tracked-articles — добавить артикул на отслеживание.
// body: { cabinet, platform: 'wb'|'ozon', article, label?, groupId? }
router.post('/', async (req, res) => {
  try {
    const { cabinet = 'licio', platform, article, label, groupId } = req.body || {};
    if (!platform || !['wb', 'ozon'].includes(platform)) {
      return res.status(400).json({ success: false, error: 'Нужна площадка wb или ozon' });
    }
    if (!article || !String(article).trim()) {
      return res.status(400).json({ success: false, error: 'Нужен артикул' });
    }
    const row = await addTracked(cabinet, platform, article, label, groupId || null);
    res.json({ success: true, data: row });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/tracked-articles/:id — перенести артикул в другую группу (или
// убрать из группы, передав groupId: null).
// body: { cabinet, groupId }
router.patch('/:id', async (req, res) => {
  try {
    const { cabinet = 'licio', groupId } = req.body || {};
    const row = await setArticleGroup(cabinet, req.params.id, groupId || null);
    res.json({ success: true, data: row });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/tracked-articles/:id?cabinet=licio — убрать артикул.
router.delete('/:id', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'licio';
    await removeTracked(cabinet, req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
