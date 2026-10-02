const express = require('express');
const router = express.Router();
const { listTracked, addTracked, removeTracked, getFeed } = require('../collectors/trackedArticles');

// GET /api/tracked-articles?cabinet=licio — список отслеживаемых артикулов.
router.get('/', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'licio';
    res.json({ success: true, data: await listTracked(cabinet) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
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

// POST /api/tracked-articles — добавить артикул на отслеживание.
// body: { cabinet, platform: 'wb'|'ozon', article, label? }
router.post('/', async (req, res) => {
  try {
    const { cabinet = 'licio', platform, article, label } = req.body || {};
    if (!platform || !['wb', 'ozon'].includes(platform)) {
      return res.status(400).json({ success: false, error: 'Нужна площадка wb или ozon' });
    }
    if (!article || !String(article).trim()) {
      return res.status(400).json({ success: false, error: 'Нужен артикул' });
    }
    const row = await addTracked(cabinet, platform, article, label);
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
