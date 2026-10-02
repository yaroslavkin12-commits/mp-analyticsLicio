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
